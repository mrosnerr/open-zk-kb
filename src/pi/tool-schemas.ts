import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ParamDef } from "../tool-meta.js";

/** Convert shared parameter metadata into a TypeBox object schema for Pi. */
export function toTypeBoxSchema(
	params: Record<string, ParamDef>,
): ReturnType<typeof Type.Object> {
	const shape: Record<string, TSchema> = {};
	for (const [name, definition] of Object.entries(params)) {
		shape[name] = toTypeBoxField(definition);
	}
	return Type.Object(shape);
}

function toTypeBoxField(definition: ParamDef): TSchema {
	let schema: TSchema;
	const options = definition.description
		? { description: definition.description }
		: undefined;
	switch (definition.type) {
		case "string":
			schema =
				definition.enum && definition.enum.length > 0
					? StringEnum(definition.enum as [string, ...string[]], options)
					: Type.String(options);
			break;
		case "number":
			schema = Type.Number(options);
			break;
		case "boolean":
			schema = Type.Boolean(options);
			break;
		case "array":
			schema = Type.Array(
				definition.items ? toTypeBoxField(definition.items) : Type.Unknown(),
				options,
			);
			break;
		case "object":
			schema = Type.Object(
				Object.fromEntries(
					Object.entries(definition.properties ?? {}).map(([name, child]) => [
						name,
						toTypeBoxField(child),
					]),
				),
				options,
			);
			break;
	}
	return definition.required === false ? Type.Optional(schema) : schema;
}
