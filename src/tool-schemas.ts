import { z } from "zod";
import type { ParamDef } from "./tool-meta.js";

/** Convert shared parameter metadata into a Zod object schema. */
export function toZodSchema(
	params: Record<string, ParamDef>,
): z.ZodObject<z.ZodRawShape> {
	const shape = {} as Record<string, z.ZodTypeAny>;
	for (const [name, definition] of Object.entries(params)) {
		shape[name] = toZodField(definition);
	}
	return z.object(shape);
}

function toZodField(definition: ParamDef): z.ZodTypeAny {
	let schema: z.ZodTypeAny;
	switch (definition.type) {
		case "string":
			schema =
				definition.enum && definition.enum.length > 0
					? z.enum(definition.enum as [string, ...string[]])
					: z.string();
			break;
		case "number":
			schema = z.number();
			break;
		case "boolean":
			schema = z.boolean();
			break;
		case "array":
			schema = z.array(
				definition.items ? toZodField(definition.items) : z.unknown(),
			);
			break;
		case "object":
			schema = toZodSchema(definition.properties ?? {});
			break;
	}
	if (definition.description) schema = schema.describe(definition.description);
	return definition.required === false ? schema.optional() : schema;
}
