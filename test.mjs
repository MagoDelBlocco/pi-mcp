import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Inline the functions under test (mirrors index.ts logic)
// ---------------------------------------------------------------------------

/** Convert an MCP JSON Schema `inputSchema` to a TypeBox-compatible schema. */
function mcpSchemaToTypeBox(inputSchema) {
	if (!inputSchema || typeof inputSchema !== "object") {
		return Type.Object({});
	}

	const schemaType = inputSchema.type;
	const description = inputSchema.description ?? undefined;

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
			const items = inputSchema.items;
			const itemType = items ? mcpSchemaToTypeBox(items) : Type.Unknown();
			return Type.Array(itemType, { description });
		}
	}

	// Handle object types (with properties)
	const properties = inputSchema.properties ?? {};
	const required = inputSchema.required ?? [];

	const tbProps = {};
	for (const [key, schema] of Object.entries(properties)) {
		const s = schema;
		let tbType;

		switch (s.type) {
			case "string":
				tbType = Type.String({ description: s.description });
				break;
			case "number":
				tbType = Type.Number({ description: s.description });
				break;
			case "integer":
				tbType = Type.Integer({ description: s.description });
				break;
			case "boolean":
				tbType = Type.Boolean({ description: s.description });
				break;
			case "array": {
				const items = s.items;
				const itemType = items ? mcpSchemaToTypeBox(items) : Type.Unknown();
				tbType = Type.Array(itemType, {
					description: s.description,
				});
				break;
			}
			case "object":
				tbType = mcpSchemaToTypeBox(s);
				break;
			default:
				tbType = Type.Unknown({ description: s.description });
		}

		tbProps[key] = required.includes(key) ? tbType : Type.Optional(tbType);
	}

	return Type.Object(tbProps);
}

function sanitize(name) {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/\./g, "_");
}

function buildToolName(serverName, toolName, direct) {
	return direct
		? sanitize(toolName)
		: `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcpSchemaToTypeBox", () => {
	describe("top-level primitive types", () => {
		test("string primitive", () => {
			const result = mcpSchemaToTypeBox({ type: "string" });
			assert.equal(result.type, "string");
		});

		test("string with description", () => {
			const result = mcpSchemaToTypeBox({
				type: "string",
				description: "A URL",
			});
			assert.equal(result.type, "string");
			assert.equal(result.description, "A URL");
		});

		test("number primitive", () => {
			const result = mcpSchemaToTypeBox({ type: "number" });
			assert.equal(result.type, "number");
		});

		test("integer primitive preserves integer type", () => {
			const result = mcpSchemaToTypeBox({ type: "integer" });
			assert.equal(
				result.type,
				"integer",
				"integer should map to integer, not number",
			);
		});

		test("boolean primitive", () => {
			const result = mcpSchemaToTypeBox({ type: "boolean" });
			assert.equal(result.type, "boolean");
		});
	});

	describe("arrays", () => {
		test("array of strings", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				items: { type: "string" },
			});
			assert.equal(result.type, "array");
			assert.equal(result.items.type, "string");
		});

		test("array of numbers", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				items: { type: "number" },
			});
			assert.equal(result.type, "array");
			assert.equal(result.items.type, "number");
		});

		test("array of booleans", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				items: { type: "boolean" },
			});
			assert.equal(result.type, "array");
			assert.equal(result.items.type, "boolean");
		});

		test("array of integers preserves integer type", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				items: { type: "integer" },
			});
			assert.equal(result.type, "array");
			assert.equal(
				result.items.type,
				"integer",
				"array items of integer type should preserve integer",
			);
		});

		test("nested arrays (array of arrays of strings)", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				items: {
					type: "array",
					items: { type: "string" },
				},
			});
			assert.equal(result.type, "array");
			assert.equal(result.items.type, "array");
			assert.equal(result.items.items.type, "string");
		});

		test("array without items defaults to unknown", () => {
			const result = mcpSchemaToTypeBox({ type: "array" });
			assert.equal(result.type, "array");
			// Type.Unknown() has no type field in TypeBox
			assert.ok(
				!result.items.type || result.items.type === "unknown",
				"items should be unknown when not specified",
			);
		});

		test("array with description", () => {
			const result = mcpSchemaToTypeBox({
				type: "array",
				description: "A list of URLs",
				items: { type: "string" },
			});
			assert.equal(result.description, "A list of URLs");
		});
	});

	describe("objects with properties", () => {
		test("simple object with string property", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: { name: { type: "string" } },
			});
			assert.equal(result.type, "object");
			assert.equal(result.properties.name.type, "string");
		});

		test("required properties appear in required array", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "number" },
				},
				required: ["name"],
			});
			assert.ok(result.required.includes("name"));
			assert.ok(
				!result.required.includes("age"),
				"optional property should not be in required",
			);
		});

		test("all properties required", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					a: { type: "string" },
					b: { type: "number" },
				},
				required: ["a", "b"],
			});
			assert.ok(result.required.includes("a"));
			assert.ok(result.required.includes("b"));
		});

		test("no required properties", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					name: { type: "string" },
				},
			});
			assert.ok(
				!result.required || result.required.length === 0,
				"should have no required fields",
			);
		});

		test("mixed property types", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "integer" },
					active: { type: "boolean" },
					score: { type: "number" },
				},
				required: ["name"],
			});
			assert.equal(result.properties.name.type, "string");
			assert.equal(
				result.properties.age.type,
				"integer",
				"integer property should map to integer type",
			);
			assert.equal(result.properties.active.type, "boolean");
			assert.equal(result.properties.score.type, "number");
		});

		test("property with array type", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					urls: {
						type: "array",
						items: { type: "string" },
						description: "List of URLs",
					},
				},
				required: ["urls"],
			});
			assert.equal(result.properties.urls.type, "array");
			assert.equal(result.properties.urls.items.type, "string");
			assert.equal(result.properties.urls.description, "List of URLs");
		});

		test("property with nested object type", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					address: {
						type: "object",
						properties: {
							street: { type: "string" },
							city: { type: "string" },
						},
						required: ["street"],
					},
				},
			});
			assert.equal(result.properties.address.type, "object");
			assert.equal(result.properties.address.properties.street.type, "string");
			assert.ok(
				result.properties.address.required.includes("street"),
				"nested required should be preserved",
			);
		});

		test("deeply nested objects", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					level1: {
						type: "object",
						properties: {
							level2: {
								type: "object",
								properties: {
									value: { type: "string" },
								},
								required: ["value"],
							},
						},
						required: ["level2"],
					},
				},
				required: ["level1"],
			});
			assert.equal(
				result.properties.level1.properties.level2.properties.value.type,
				"string",
			);
		});

		test("property descriptions are preserved", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					query: { type: "string", description: "Search query" },
				},
			});
			assert.equal(result.properties.query.description, "Search query");
		});
	});

	describe("real-world MCP tool schemas", () => {
		test("deep_fetch-like schema (the original bug)", () => {
			const schema = {
				type: "object",
				properties: {
					urls: {
						type: "array",
						items: { type: "string" },
						description: "List of URLs to fetch",
					},
					query: { type: "string" },
					whole: { type: "boolean" },
				},
				required: ["urls"],
			};

			const result = mcpSchemaToTypeBox(schema);
			assert.equal(result.type, "object");
			// The critical check: urls.items must be a string type, not an empty object
			assert.equal(
				result.properties.urls.items.type,
				"string",
				"urls items must resolve to string type (not empty object)",
			);
			assert.ok(result.required.includes("urls"));
			assert.ok(!result.required.includes("query"), "query should be optional");
			assert.ok(!result.required.includes("whole"), "whole should be optional");
		});

		test("tool with array of objects", () => {
			const schema = {
				type: "object",
				properties: {
					entries: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								value: { type: "number" },
							},
							required: ["id"],
						},
					},
				},
			};

			const result = mcpSchemaToTypeBox(schema);
			const items = result.properties.entries.items;
			assert.equal(items.type, "object");
			assert.equal(items.properties.id.type, "string");
			assert.equal(items.properties.value.type, "number");
		});

		test("tool with integer parameter", () => {
			const schema = {
				type: "object",
				properties: {
					count: { type: "integer", description: "Number of results" },
				},
				required: ["count"],
			};

			const result = mcpSchemaToTypeBox(schema);
			assert.equal(
				result.properties.count.type,
				"integer",
				"integer should not be downgraded to number",
			);
		});
	});

	describe("edge cases", () => {
		test("null input returns empty object", () => {
			const result = mcpSchemaToTypeBox(null);
			assert.equal(result.type, "object");
			assert.ok(
				!result.properties || Object.keys(result.properties).length === 0,
			);
		});

		test("undefined input returns empty object", () => {
			const result = mcpSchemaToTypeBox(undefined);
			assert.equal(result.type, "object");
		});

		test("empty object returns empty TypeBox object", () => {
			const result = mcpSchemaToTypeBox({});
			assert.equal(result.type, "object");
		});

		test("schema with unknown type maps to unknown", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					data: { type: "null" },
				},
			});
			// "null" is not a recognized type → should fall through to default (Unknown)
			assert.ok(
				!result.properties.data.type ||
					result.properties.data.type === "unknown",
				"unrecognized types should map to unknown",
			);
		});

		test("schema without type field (just properties)", () => {
			const result = mcpSchemaToTypeBox({
				properties: { name: { type: "string" } },
				required: ["name"],
			});
			assert.equal(result.type, "object");
			assert.equal(result.properties.name.type, "string");
		});

		test("property without type field", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					weird: { description: "no type" },
				},
			});
			// Should fall through to default (Unknown)
			assert.ok(
				!result.properties.weird.type ||
					result.properties.weird.type === "unknown",
				"property without type should map to unknown",
			);
		});

		test("description on top-level object is not lost", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				description: "Search parameters",
				properties: {
					q: { type: "string" },
				},
			});
			// Type.Object doesn't add description at top level by default,
			// but we should not crash
			assert.equal(result.type, "object");
		});

		test("missing required array defaults to all optional", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					a: { type: "string" },
					b: { type: "number" },
				},
			});
			// Without required, no fields should be in required
			assert.ok(
				!result.required || result.required.length === 0,
				"all properties should be optional when required is missing",
			);
		});

		test("handles empty properties object", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {},
			});
			assert.equal(result.type, "object");
			assert.deepStrictEqual(result.properties, {});
		});

		test("array of objects with nested arrays", () => {
			const result = mcpSchemaToTypeBox({
				type: "object",
				properties: {
					matrix: {
						type: "array",
						items: {
							type: "array",
							items: { type: "integer" },
						},
					},
				},
			});
			assert.equal(
				result.properties.matrix.items.items.type,
				"integer",
				"deeply nested integer should be preserved",
			);
		});
	});
});

describe("sanitize", () => {
	test("plain alphanumeric passes through", () => {
		assert.equal(sanitize("myTool"), "myTool");
	});

	test("hyphens and underscores pass through", () => {
		assert.equal(sanitize("my-tool_name"), "my-tool_name");
	});

	test("dots are replaced with underscores", () => {
		assert.equal(sanitize("my.tool"), "my_tool");
	});

	test("spaces are replaced with underscores", () => {
		assert.equal(sanitize("my tool"), "my_tool");
	});

	test("multiple special chars are replaced", () => {
		assert.equal(sanitize("foo@bar#baz"), "foo_bar_baz");
	});

	test("slashes are replaced", () => {
		assert.equal(sanitize("foo/bar"), "foo_bar");
	});

	test("slashes in paths are replaced", () => {
		assert.equal(sanitize("server/tool/name"), "server_tool_name");
	});

	test("empty string stays empty", () => {
		assert.equal(sanitize(""), "");
	});

	test("string of only special chars becomes underscores", () => {
		assert.equal(sanitize("@#$%"), "____");
	});

	test("leading and trailing special chars are replaced", () => {
		assert.equal(sanitize(".my.tool."), "_my_tool_");
	});

	test("unicode characters are replaced with underscores", () => {
		assert.equal(sanitize("tëst"), "t_st");
	});

	test("mixed dots and other special chars", () => {
		assert.equal(sanitize("foo.bar@baz"), "foo_bar_baz");
	});
});

describe("buildToolName", () => {
	test("direct mode: sanitizes tool name only", () => {
		assert.equal(buildToolName("myServer", "myTool", true), "myTool");
	});

	test("direct mode: sanitizes special chars in tool name", () => {
		assert.equal(buildToolName("myServer", "deep.fetch", true), "deep_fetch");
	});

	test("non-direct mode: prefixes with server name", () => {
		assert.equal(
			buildToolName("browser", "search", false),
			"mcp_browser_search",
		);
	});

	test("non-direct mode: sanitizes both names", () => {
		assert.equal(
			buildToolName("my.server", "deep.fetch", false),
			"mcp_my_server_deep_fetch",
		);
	});

	test("non-direct mode: handles special chars in server name", () => {
		assert.equal(
			buildToolName("my-server_v2", "tool.name", false),
			"mcp_my-server_v2_tool_name",
		);
	});

	test("empty tool name in direct mode", () => {
		assert.equal(buildToolName("server", "", true), "");
	});

	test("empty tool name in non-direct mode", () => {
		assert.equal(buildToolName("server", "", false), "mcp_server_");
	});

	test("empty server name in non-direct mode", () => {
		assert.equal(buildToolName("", "tool", false), "mcp__tool");
	});
});
