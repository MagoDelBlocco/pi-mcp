import { Type, type TSchema } from "typebox";

// ---------------------------------------------------------------------------
// MCP JSON Schema -> TypeBox conversion and tool-name helpers.
//
// Kept free of SDK imports so it can be unit-tested in isolation (see test.mjs)
// and reused by index.ts without pulling in transport dependencies.
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

/** Collect TypeBox schema options (description, default) shared across all types. */
function schemaOptions(schema: JsonSchema): Record<string, unknown> {
	const opts: Record<string, unknown> = {};
	if (typeof schema.description === "string") opts.description = schema.description;
	if ("default" in schema) opts.default = schema.default;
	return opts;
}

/** Convert an MCP JSON Schema `inputSchema` to a TypeBox-compatible schema. */
export function mcpSchemaToTypeBox(
	inputSchema: JsonSchema | null | undefined,
): TSchema {
	if (!inputSchema || typeof inputSchema !== "object") {
		return Type.Object({});
	}

	const opts = schemaOptions(inputSchema);

	// const / enum — preserve the constraint instead of widening to a bare type.
	if ("const" in inputSchema) {
		return Type.Literal(inputSchema.const as any, opts);
	}
	if (Array.isArray(inputSchema.enum)) {
		const values = inputSchema.enum as Array<string | number | boolean>;
		if (values.length === 0) return Type.Unknown(opts);
		if (values.length === 1) return Type.Literal(values[0], opts);
		return Type.Union(
			values.map((v) => Type.Literal(v)),
			opts,
		);
	}

	// Combinators.
	const union = (inputSchema.anyOf ?? inputSchema.oneOf) as JsonSchema[] | undefined;
	if (Array.isArray(union) && union.length > 0) {
		return Type.Union(
			union.map((s) => mcpSchemaToTypeBox(s)),
			opts,
		);
	}
	if (Array.isArray(inputSchema.allOf) && inputSchema.allOf.length > 0) {
		const parts = (inputSchema.allOf as JsonSchema[]).map((s) => mcpSchemaToTypeBox(s));
		return parts.length === 1 ? parts[0] : Type.Intersect(parts, opts);
	}

	// `type` may be an array, e.g. ["string", "null"] for nullable values.
	const rawType = inputSchema.type;
	if (Array.isArray(rawType)) {
		const types = rawType as string[];
		const variants = types
			.filter((t) => t !== "null")
			.map((t) => mcpSchemaToTypeBox({ ...inputSchema, type: t }));
		const all = types.includes("null") ? [...variants, Type.Null()] : variants;
		if (all.length === 0) return Type.Unknown(opts);
		return all.length === 1 ? all[0] : Type.Union(all, opts);
	}

	return primitiveToTypeBox(rawType as string | undefined, inputSchema, opts);
}

function primitiveToTypeBox(
	type: string | undefined,
	schema: JsonSchema,
	opts: Record<string, unknown>,
): TSchema {
	switch (type) {
		case "string": {
			const o = { ...opts };
			if (typeof schema.minLength === "number") o.minLength = schema.minLength;
			if (typeof schema.maxLength === "number") o.maxLength = schema.maxLength;
			if (typeof schema.pattern === "string") o.pattern = schema.pattern;
			if (typeof schema.format === "string") o.format = schema.format;
			return Type.String(o);
		}
		case "number":
		case "integer": {
			const o = { ...opts };
			if (typeof schema.minimum === "number") o.minimum = schema.minimum;
			if (typeof schema.maximum === "number") o.maximum = schema.maximum;
			return type === "integer" ? Type.Integer(o) : Type.Number(o);
		}
		case "boolean":
			return Type.Boolean(opts);
		case "null":
			return Type.Null(opts);
		case "array": {
			const items = schema.items as JsonSchema | undefined;
			const itemType = items ? mcpSchemaToTypeBox(items) : Type.Unknown();
			return Type.Array(itemType, opts);
		}
		case "object":
			return objectToTypeBox(schema, opts);
		default:
			// No explicit type. Treat as an object only if it looks like one;
			// otherwise it is genuinely unconstrained.
			if (
				"properties" in schema ||
				"required" in schema ||
				"additionalProperties" in schema
			) {
				return objectToTypeBox(schema, opts);
			}
			return Type.Unknown(opts);
	}
}

function objectToTypeBox(schema: JsonSchema, opts: Record<string, unknown>): TSchema {
	const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
	const required = new Set((schema.required as string[]) ?? []);

	const tbProps: Record<string, TSchema> = {};
	for (const [key, sub] of Object.entries(properties)) {
		const tbType = mcpSchemaToTypeBox(sub);
		tbProps[key] = required.has(key) ? tbType : Type.Optional(tbType);
	}

	const o = { ...opts };
	const ap = schema.additionalProperties;
	if (ap === false) o.additionalProperties = false;
	else if (ap && typeof ap === "object") {
		o.additionalProperties = mcpSchemaToTypeBox(ap as JsonSchema);
	}

	return Type.Object(tbProps, o);
}

export function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/\./g, "_");
}

export function buildToolName(
	serverName: string,
	toolName: string,
	direct: boolean,
): string {
	return direct
		? sanitize(toolName)
		: `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}
