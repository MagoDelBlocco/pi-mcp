import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface McpServerConfig {
	// HTTP / SSE transport
	url?: string;
	headers?: Record<string, string>;
	// Stdio transport
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	// Options
	timeout?: number;
	connect_timeout?: number;
	// Tool control
	directTools?: boolean;
	excludeTools?: string[];
	// Transport hint (auto | streamable-http | sse)
	transport?: "auto" | "streamable-http" | "sse";
}

interface McpConfig {
	mcpServers?: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfigPath(): string {
	return resolve(homedir(), ".pi/agent/mcp.json");
}

function loadConfig(): McpConfig {
	try {
		return JSON.parse(readFileSync(getConfigPath(), "utf-8")) as McpConfig;
	} catch {
		return {};
	}
}

/** Convert an MCP JSON Schema `inputSchema` to a TypeBox-compatible schema. */
function mcpSchemaToTypeBox(
	inputSchema: Record<string, unknown>,
): Record<string, unknown> {
	if (!inputSchema || typeof inputSchema !== "object") {
		return Type.Object({});
	}

	const schemaType = inputSchema.type as string | undefined;
	const description = (inputSchema.description as string) ?? undefined;

	// Handle primitive types directly (e.g., when called for array `items`)
	switch (schemaType) {
		case "string":
			return Type.String({ description });
		case "number":
			return Type.Number({ description });
		case "integer":
			return Type.Integer({ description });
		case "boolean":
			return Type.Boolean({ description });
		case "array": {
			const items = inputSchema.items as Record<string, unknown> | undefined;
			const itemType = items ? mcpSchemaToTypeBox(items) : Type.Unknown();
			return Type.Array(itemType as any, { description });
		}
	}

	// Handle object types (with properties)
	const properties = (inputSchema.properties as Record<string, object>) ?? {};
	const required = (inputSchema.required as string[]) ?? [];

	const tbProps: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(properties)) {
		const s = schema as Record<string, unknown>;
		let tbType: unknown;

		switch (s.type) {
			case "string":
				tbType = Type.String({ description: s.description as string });
				break;
			case "number":
				tbType = Type.Number({ description: s.description as string });
				break;
			case "integer":
				tbType = Type.Integer({ description: s.description as string });
				break;
			case "boolean":
				tbType = Type.Boolean({ description: s.description as string });
				break;
			case "array": {
				const items = s.items as Record<string, unknown> | undefined;
				const itemType = items ? mcpSchemaToTypeBox(items) : Type.Unknown();
				tbType = Type.Array(itemType as any, {
					description: s.description as string,
				});
				break;
			}
			case "object": {
				tbType = mcpSchemaToTypeBox(s);
				break;
			}
			default:
				tbType = Type.Unknown({ description: s.description as string });
		}

		tbProps[key] = required.includes(key) ? tbType : Type.Optional(tbType);
	}

	return Type.Object(tbProps);
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/\./g, "_");
}

function buildToolName(
	serverName: string,
	toolName: string,
	direct: boolean,
): string {
	return direct
		? sanitize(toolName)
		: `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

interface ServerConnection {
	client: Client;
	transport: any;
	config: McpServerConfig;
}

class McpConnectionManager {
	private servers = new Map<string, ServerConnection>();
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private reconnectAttempts = new Map<string, number>();

	/** Connect to all configured servers and register their tools. */
	async connectAll(pi: ExtensionAPI): Promise<void> {
		const config = loadConfig();
		const servers = config.mcpServers ?? {};

		for (const [name, serverConfig] of Object.entries(servers)) {
			await this.connectServer(name, serverConfig, pi);
		}
	}

	private async connectServer(
		name: string,
		config: McpServerConfig,
		pi: ExtensionAPI,
	): Promise<void> {
		try {
			const connection = await this.createConnection(name, config);
			this.servers.set(name, connection);
			this.reconnectAttempts.delete(name);

			// Discover and register tools
			await this.registerTools(name, connection, pi);

			const toolCount = await this.countEligibleTools(name, config);
			console.log(`[mcp-client] ✓ "${name}" connected (${toolCount} tools)`);
		} catch (err: any) {
			console.error(`[mcp-client] ✗ "${name}" failed: ${err.message}`);
			this.scheduleReconnect(name, config);
		}
	}

	private async createConnection(
		name: string,
		config: McpServerConfig,
	): Promise<ServerConnection> {
		const client = new Client(
			{ name: "pi-mcp-client", version: "1.0.0" },
			{ capabilities: {} },
		);

		let transport: any;

		if (config.url) {
			const url = new URL(config.url);
			const httpOpts = config.headers
				? { requestInit: { headers: config.headers } }
				: undefined;

			if (config.transport === "sse") {
				transport = new SSEClientTransport(url, httpOpts);
			} else {
				transport = new StreamableHTTPClientTransport(url, httpOpts);
			}
		} else if (config.command) {
			const env: Record<string, string> = {};
			for (const key of [
				"PATH",
				"HOME",
				"USER",
				"LANG",
				"LC_ALL",
				"TERM",
				"SHELL",
				"TMPDIR",
			]) {
				if (process.env[key]) env[key] = process.env[key]!;
			}
			if (config.env) {
				Object.assign(env, config.env);
			}

			transport = new StdioClientTransport({
				command: config.command,
				args: config.args ?? [],
				env,
				stderr: "inherit",
			});
		} else {
			throw new Error(`Server "${name}" has no url or command configured`);
		}

		const connectTimeout = (config.connect_timeout ?? 60) * 1000;
		const timeoutId = setTimeout(() => {
			throw new Error(
				`Connection to "${name}" timed out after ${config.connect_timeout ?? 60}s`,
			);
		}, connectTimeout);

		try {
			await client.connect(transport);
		} finally {
			clearTimeout(timeoutId);
		}

		return { client, transport, config };
	}

	private async registerTools(
		name: string,
		connection: ServerConnection,
		pi: ExtensionAPI,
	): Promise<void> {
		const { client, config } = connection;
		const directTools = config.directTools ?? false;
		const excludeTools = new Set(config.excludeTools ?? []);
		const timeout = config.timeout ?? 120;

		try {
			const toolsResult = await client.listTools();
			const tools = toolsResult.tools ?? [];

			for (const tool of tools) {
				if (excludeTools.has(tool.name)) continue;

				const toolName = buildToolName(name, tool.name, directTools);
				const description = [
					`MCP tool from server "${name}".`,
					tool.description ? ` ${tool.description}` : "",
				].join("");

				const parameters = mcpSchemaToTypeBox(
					(tool.inputSchema as Record<string, unknown>) ?? {
						type: "object",
						properties: {},
					},
				);

				pi.registerTool({
					name: toolName,
					label: `${name}/${tool.name}`,
					description,
					parameters: parameters as any,
					async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
						const args: Record<string, unknown> = {};
						for (const [key, value] of Object.entries(params ?? {})) {
							args[key] = value;
						}

						const callTimeout = timeout * 1000;
						const timeoutId = setTimeout(() => {
							throw new Error(
								`Tool "${tool.name}" timed out after ${timeout}s`,
							);
						}, callTimeout);

						try {
							const result = await client.callTool({
								name: tool.name,
								arguments: args,
							});
							clearTimeout(timeoutId);

							const contentParts: Array<{ type: string; text?: string }> = [];
							for (const item of result.content ?? []) {
								if (item.type === "text" && "text" in item) {
									contentParts.push({ type: "text", text: item.text });
								} else if (
									item.type === "image" &&
									"data" in item &&
									"mimeType" in item
								) {
									contentParts.push({
										type: "text",
										text: `[Image: ${item.mimeType}, ${item.data.length} bytes]`,
									});
								} else if (item.type === "resource") {
									const res = item.resource;
									if (res && "text" in res) {
										contentParts.push({ type: "text", text: res.text });
									} else if (res && "uri" in res) {
										contentParts.push({
											type: "text",
											text: `Resource: ${res.uri}`,
										});
									}
								} else {
									contentParts.push({
										type: "text",
										text: JSON.stringify(item),
									});
								}
							}

							if (result.isError) {
								return {
									content:
										(contentParts.length ?? 0)
											? contentParts
											: [{ type: "text", text: "Tool returned an error." }],
									details: { isError: true, server: name, tool: tool.name },
								};
							}

							return {
								content: contentParts.length
									? contentParts
									: [{ type: "text", text: "(no content)" }],
								details: { server: name, tool: tool.name },
							};
						} catch (err: any) {
							clearTimeout(timeoutId);
							return {
								content: [
									{
										type: "text",
										text: `Error calling ${tool.name}: ${err.message}`,
									},
								],
								details: { error: err.message, server: name, tool: tool.name },
							};
						}
					},
				});
			}
		} catch (err: any) {
			console.error(
				`[mcp-client] Failed to list tools for "${name}": ${err.message}`,
			);
		}
	}

	private async countEligibleTools(
		name: string,
		config: McpServerConfig,
	): Promise<number> {
		const excludeTools = new Set(config.excludeTools ?? []);
		const connection = this.servers.get(name);
		if (!connection) return 0;

		try {
			const result = await connection.client.listTools();
			return (result.tools ?? []).filter((t) => !excludeTools.has(t.name))
				.length;
		} catch {
			return 0;
		}
	}

	private scheduleReconnect(name: string, config: McpServerConfig): void {
		if (this.reconnectTimers.has(name)) return;

		const attempt = (this.reconnectAttempts.get(name) ?? 0) + 1;
		this.reconnectAttempts.set(name, attempt);
		const delay = Math.min(1000 * 2 ** Math.min(5, attempt), 60_000);

		console.log(
			`[mcp-client] Retrying "${name}" in ${delay}ms (attempt ${attempt})`,
		);

		const timer = setTimeout(async () => {
			this.reconnectTimers.delete(name);
			// Reload config in case it changed
			const freshConfig = loadConfig();
			const serverConfig = freshConfig.mcpServers?.[name];
			if (serverConfig) {
				// We need pi here — use a lazy approach
				await this.connectServerWithPi(name, serverConfig);
			}
		}, delay);

		this.reconnectTimers.set(name, timer);
	}

	private async connectServerWithPi(
		name: string,
		config: McpServerConfig,
	): Promise<void> {
		// This is called from reconnect timers — we need to re-access pi.
		// Use the global pi reference set during init.
		if (!globalThis.__pi_mcp_api) {
			console.error("[mcp-client] Cannot reconnect: pi API not available");
			return;
		}
		const pi = globalThis.__pi_mcp_api as ExtensionAPI;
		try {
			const connection = await this.createConnection(name, config);
			this.servers.set(name, connection);
			this.reconnectAttempts.delete(name);
			await this.registerTools(name, connection, pi);
			const toolCount = await this.countEligibleTools(name, config);
			console.log(`[mcp-client] ✓ "${name}" reconnected (${toolCount} tools)`);
		} catch (err: any) {
			console.error(
				`[mcp-client] ✗ "${name}" reconnect failed: ${err.message}`,
			);
			this.scheduleReconnect(name, config);
		}
	}

	/** Clean up all connections. */
	async disconnectAll(): Promise<void> {
		for (const timer of this.reconnectTimers.values()) {
			clearTimeout(timer);
		}
		this.reconnectTimers.clear();

		for (const [, conn] of this.servers) {
			try {
				await conn.transport.close();
			} catch {
				// ignore
			}
		}
		this.servers.clear();
	}

	/** Check if a server is connected. */
	isConnected(name: string): boolean {
		return this.servers.has(name);
	}

	/** Return a summary string of connected/disconnected servers. */
	getServerSummary(): { text: string; color: "success" | "warning" | "error" } {
		const config = loadConfig();
		const servers = config.mcpServers ?? {};
		const names = Object.keys(servers);
		if (names.length === 0) return { text: "", color: "success" };

		const connected = names.filter((n) => this.servers.has(n)).length;
		const total = names.length;
		const label = `MCP: ${connected}/${total} connected`;

		if (connected === 0) return { text: label, color: "error" };
		if (connected < total) return { text: label, color: "warning" };
		return { text: label, color: "success" };
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const manager = new McpConnectionManager();

export default async function (pi: ExtensionAPI) {
	// Store pi reference for reconnect callbacks
	(globalThis as any).__pi_mcp_api = pi;

	// Connect to MCP servers (async factory is awaited before startup continues)
	await manager.connectAll(pi);

	// Notify user on session start
	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig();
		const servers = config.mcpServers ?? {};
		const names = Object.keys(servers);

		if (names.length === 0) {
			console.log("[mcp-client] No MCP servers configured");
			return;
		}

		const summary = manager.getServerSummary();
		const bgMap: Record<string, string> = {
			success: "toolSuccessBg",
			warning: "toolPendingBg",
			error: "toolErrorBg",
		};
		ctx.ui.setStatus(
			"mcp-client",
			`│ ${ctx.ui.theme.bg(bgMap[summary.color], ctx.ui.theme.fg(summary.color, summary.text))}`,
		);
	});

	// Command: show connected servers
	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			const servers = config.mcpServers ?? {};
			const lines: string[] = [];

			for (const [name] of Object.entries(servers)) {
				const connected = manager.isConnected(name);
				lines.push(`  ${connected ? "✓" : "✗"} ${name}`);
			}

			if (lines.length === 0) {
				ctx.ui.notify("No MCP servers configured", "info");
			} else {
				ctx.ui.notify(`MCP servers:\n${lines.join("\n")}`, "info");
			}
		},
	});

	// Command: reload MCP connections
	pi.registerCommand("mcp-reload", {
		description: "Reload MCP server connections",
		handler: async (_args, ctx) => {
			await manager.disconnectAll();
			await manager.connectAll(pi);
			ctx.ui.notify("MCP connections reloaded", "info");
		},
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		await manager.disconnectAll();
	});
}
