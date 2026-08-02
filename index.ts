import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import {
	buildToolName,
	type JsonSchema,
	mcpSchemaToTypeBox,
} from "./schema.ts";

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
	connectTimeout?: number;
	/** @deprecated Use `connectTimeout`. Kept for backward compatibility. */
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
	const path = getConfigPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		// Missing config file is a normal "no servers configured" state.
		return {};
	}
	try {
		return JSON.parse(raw) as McpConfig;
	} catch (err: any) {
		// A malformed file is a real error the user should hear about — otherwise
		// it looks identical to having no servers configured.
		console.error(`[mcp-client] Failed to parse ${path}: ${err.message}`);
		return {};
	}
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

interface ServerConnection {
	client: Client;
	transport: Transport;
	config: McpServerConfig;
	/** Set before a deliberate close so the onclose handler doesn't reconnect. */
	intentionalClose: boolean;
}

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

class McpConnectionManager {
	private pi!: ExtensionAPI;
	private servers = new Map<string, ServerConnection>();
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private reconnectAttempts = new Map<string, number>();
	/** Maps a registered tool name to the server that owns it (collision detection). */
	private toolOwners = new Map<string, string>();
	/** UI context captured from a session/command, so retry status can refresh in place. */
	private ui?: ExtensionUIContext;
	/** Whether an updating UI (TUI/RPC) is available; false in print/JSON modes. */
	private hasUI = false;
	/** Most recent failure message per server, shown in the single retry status. */
	private lastErrors = new Map<string, string>();

	/** Connect to all configured servers and register their tools. */
	async connectAll(pi: ExtensionAPI): Promise<void> {
		this.pi = pi;
		const config = loadConfig();
		const servers = config.mcpServers ?? {};

		for (const [name, serverConfig] of Object.entries(servers)) {
			await this.establish(name, serverConfig);
		}
	}

	/** Capture the UI context so retry status can update in place. */
	setUI(ui: ExtensionUIContext, hasUI: boolean): void {
		this.ui = ui;
		this.hasUI = hasUI;
	}

	/** Open a connection, register tools, and wire up reconnect-on-drop. */
	private async establish(name: string, config: McpServerConfig): Promise<void> {
		let connection: ServerConnection | undefined;
		try {
			connection = await this.createConnection(name, config);
			const toolCount = await this.registerTools(name, connection);

			this.servers.set(name, connection);
			this.reconnectAttempts.delete(name);
			this.clearRetryStatus(name);
			this.attachCloseHandler(name, config, connection);

			console.log(`[mcp-client] ✓ "${name}" connected (${toolCount} tools)`);
		} catch (err: any) {
			if (connection) {
				try {
					await connection.transport.close();
				} catch {
					// ignore
				}
			}
			this.lastErrors.set(name, err?.message ?? String(err));
			this.scheduleReconnect(name);
		}
	}

	/** Reconnect when a previously healthy connection drops unexpectedly. */
	private attachCloseHandler(
		name: string,
		config: McpServerConfig,
		connection: ServerConnection,
	): void {
		connection.client.onclose = () => {
			if (connection.intentionalClose) return;
			// Ignore stale handlers from connections we've already replaced.
			if (this.servers.get(name) !== connection) return;
			this.servers.delete(name);
			this.scheduleReconnect(name);
		};
	}

	private async createConnection(
		name: string,
		config: McpServerConfig,
	): Promise<ServerConnection> {
		const connectTimeout =
			(config.connectTimeout ?? config.connect_timeout ?? 60) * 1000;

		if (config.url) {
			const url = new URL(config.url);
			const httpOpts = config.headers
				? { requestInit: { headers: config.headers } }
				: undefined;

			// "auto" tries Streamable HTTP first, then falls back to SSE.
			const modes: Array<"streamable-http" | "sse"> =
				config.transport === "sse"
					? ["sse"]
					: config.transport === "streamable-http"
						? ["streamable-http"]
						: ["streamable-http", "sse"];

			let lastErr: unknown;
			for (const mode of modes) {
				const client = this.newClient();
				const transport: Transport =
					mode === "sse"
						? new SSEClientTransport(url, httpOpts)
						: new StreamableHTTPClientTransport(url, httpOpts);
				try {
					await client.connect(transport, { timeout: connectTimeout });
					return { client, transport, config, intentionalClose: false };
				} catch (err: any) {
					lastErr = err;
					try {
						await transport.close();
					} catch {
						// ignore
					}
					if (modes.length > 1) {
						console.error(
							`[mcp-client] "${name}" ${mode} transport failed: ${err.message}; trying next`,
						);
					}
				}
			}
			throw lastErr instanceof Error
				? lastErr
				: new Error(`Unable to connect to "${name}"`);
		}

		if (config.command) {
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

			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args ?? [],
				env,
				stderr: "pipe",
			});
			// Surface the child server's stderr under a clear prefix instead of
			// letting it write straight to the terminal and corrupt the TUI.
			transport.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString().trimEnd();
				if (text) console.error(`[mcp-client:${name}] ${text}`);
			});

			const client = this.newClient();
			await client.connect(transport, { timeout: connectTimeout });
			return { client, transport, config, intentionalClose: false };
		}

		throw new Error(`Server "${name}" has no url or command configured`);
	}

	private newClient(): Client {
		return new Client(
			{ name: "pi-mcp-client", version: "1.0.0" },
			{ capabilities: {} },
		);
	}

	/** Discover and register the server's tools. Returns the registered count. */
	private async registerTools(
		name: string,
		connection: ServerConnection,
	): Promise<number> {
		const { client, config } = connection;
		const directTools = config.directTools ?? false;
		const excludeTools = new Set(config.excludeTools ?? []);
		const timeoutMs = (config.timeout ?? 120) * 1000;

		// A listTools failure means the connection isn't usable — let it propagate
		// to establish() so the server is retried rather than left half-registered.
		const toolsResult = await client.listTools();
		const tools = toolsResult.tools ?? [];

		let count = 0;
		for (const tool of tools) {
			if (excludeTools.has(tool.name)) continue;

			const toolName = buildToolName(name, tool.name, directTools);

			const owner = this.toolOwners.get(toolName);
			if (owner && owner !== name) {
				console.error(
					`[mcp-client] ⚠ tool "${toolName}" from "${name}" collides with "${owner}"; overriding`,
				);
			}
			this.toolOwners.set(toolName, name);

			const description = [
				`MCP tool from server "${name}".`,
				tool.description ? ` ${tool.description}` : "",
			].join("");

			// Tool parameters must be object-shaped; an empty or missing input
			// schema becomes an empty object rather than an unconstrained value.
			const rawSchema = tool.inputSchema as JsonSchema | undefined;
			const parameters = mcpSchemaToTypeBox(
				rawSchema && Object.keys(rawSchema).length > 0
					? rawSchema
					: { type: "object", properties: {} },
			);

			this.pi.registerTool({
				name: toolName,
				label: `${name}/${tool.name}`,
				description,
				parameters,
				async execute(_toolCallId, params, signal) {
					const args = (params ?? {}) as Record<string, unknown>;
					try {
						const result = await client.callTool(
							{ name: tool.name, arguments: args },
							undefined,
							// The SDK enforces the timeout and honors the abort signal,
							// so a hung call is actually cancelled (not just ignored).
							{ timeout: timeoutMs, signal },
						);

						const contentParts: ToolContent[] = [];
						for (const item of (result.content ?? []) as any[]) {
							if (item.type === "text" && typeof item.text === "string") {
								contentParts.push({ type: "text", text: item.text });
							} else if (
								item.type === "image" &&
								"data" in item &&
								"mimeType" in item
							) {
								contentParts.push({
									type: "image",
									data: item.data,
									mimeType: item.mimeType,
								});
							} else if (item.type === "resource" && item.resource) {
								const res = item.resource;
								if (typeof res.text === "string") {
									contentParts.push({ type: "text", text: res.text });
								} else if (typeof res.uri === "string") {
									contentParts.push({ type: "text", text: `Resource: ${res.uri}` });
								} else {
									contentParts.push({ type: "text", text: JSON.stringify(item) });
								}
							} else {
								contentParts.push({ type: "text", text: JSON.stringify(item) });
							}
						}

						if (result.isError) {
							return {
								content: contentParts.length
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
			count++;
		}

		return count;
	}

	private static retryKey(name: string): string {
		return `mcp-retry:${name}`;
	}

	/**
	 * Show/refresh a single per-server status while reconnecting, instead of
	 * emitting a new terminal line per attempt. When no updating UI exists
	 * (print/JSON modes), log once on the first attempt to avoid spam.
	 */
	private updateRetryStatus(name: string, attempt: number, delayMs: number): void {
		const seconds = Math.max(1, Math.round(delayMs / 1000));
		const err = this.lastErrors.get(name);
		const text =
			`⚠ MCP "${name}" down — retrying in ${seconds}s (attempt ${attempt})` +
			(err ? ` — ${err}` : "");
		if (this.ui && this.hasUI) {
			this.ui.setStatus(McpConnectionManager.retryKey(name), text);
		} else if (attempt === 1 && process.env.MCP_DEBUG) {
			// No updating UI (print/JSON modes). Log once, gated behind a debug flag,
			// so retries never spam the terminal in normal production runs.
			console.warn(`[mcp-client] ${text}`);
		}
	}

	/** Clear a server's retry status (e.g. once it reconnects). */
	private clearRetryStatus(name: string): void {
		this.lastErrors.delete(name);
		if (this.ui && this.hasUI) {
			this.ui.setStatus(McpConnectionManager.retryKey(name), undefined);
		}
	}

	private scheduleReconnect(name: string): void {
		if (this.reconnectTimers.has(name)) return;

		const attempt = (this.reconnectAttempts.get(name) ?? 0) + 1;
		this.reconnectAttempts.set(name, attempt);
		// Exponent capped at 6 so the backoff actually reaches the 60s ceiling.
		const delay = Math.min(1000 * 2 ** Math.min(6, attempt), 60_000);

		// Show one status per server, refreshed in place on each attempt, instead
		// of emitting a new terminal line per retry.
		this.updateRetryStatus(name, attempt, delay);

		const timer = setTimeout(() => {
			this.reconnectTimers.delete(name);
			// Reload config in case it changed (or the server was removed).
			const serverConfig = loadConfig().mcpServers?.[name];
			if (serverConfig) {
				void this.establish(name, serverConfig);
			}
		}, delay);

		this.reconnectTimers.set(name, timer);
	}

	/** Clean up all connections. */
	async disconnectAll(): Promise<void> {
		const retrying = [...this.reconnectTimers.keys()];
		for (const timer of this.reconnectTimers.values()) {
			clearTimeout(timer);
		}
		this.reconnectTimers.clear();
		this.reconnectAttempts.clear();
		this.toolOwners.clear();
		this.lastErrors.clear();
		for (const name of retrying) this.clearRetryStatus(name);

		for (const [, conn] of this.servers) {
			conn.intentionalClose = true;
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
	// Connect to MCP servers (async factory is awaited before startup continues)
	await manager.connectAll(pi);

	// Notify user on session start
	pi.on("session_start", async (_event, ctx) => {
		manager.setUI(ctx.ui, ctx.hasUI);
		const config = loadConfig();
		const names = Object.keys(config.mcpServers ?? {});

		if (names.length === 0) {
			console.log("[mcp-client] No MCP servers configured");
			return;
		}

		const summary = manager.getServerSummary();
		const bgMap = {
			success: "toolSuccessBg",
			warning: "toolPendingBg",
			error: "toolErrorBg",
		} as const;
		ctx.ui.setStatus(
			"mcp-client",
			ctx.ui.theme.bg(
				bgMap[summary.color],
				ctx.ui.theme.fg(summary.color, summary.text),
			),
		);
	});

	// Command: show connected servers
	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			manager.setUI(ctx.ui, ctx.hasUI);
			const config = loadConfig();
			const servers = config.mcpServers ?? {};
			const lines: string[] = [];

			for (const name of Object.keys(servers)) {
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
			manager.setUI(ctx.ui, ctx.hasUI);
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
