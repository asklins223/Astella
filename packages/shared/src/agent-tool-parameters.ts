import { z } from "zod";

/** Deliberately supports the contract shapes used by agent manifests; unsupported shapes fail at registration. */
export function agentToolParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  const parameters = parameterShape(schema);
  return schema.description ? { ...parameters, description: schema.description } : parameters;
}

function parameterShape(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return agentToolParameters(schema._def.innerType);
  if (schema instanceof z.ZodEffects) {
    if (schema._def.effect.type !== "refinement") throw new Error("Unsupported agent parameter transform");
    // Cross-field checks remain enforced by the same server schema.
    return agentToolParameters(schema._def.schema);
  }
  if (schema instanceof z.ZodNullable) return { anyOf: [agentToolParameters(schema.unwrap()), { type: "null" }] };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodTypeAny[];
    if (options.every(option => option instanceof z.ZodLiteral)
      && options.every(option => typeof (option as z.ZodLiteral<unknown>).value === typeof (options[0] as z.ZodLiteral<unknown>).value)) {
      const values = options.map(option => (option as z.ZodLiteral<unknown>).value);
      return { type: typeof values[0] === "number" && values.every(Number.isInteger) ? "integer" : typeof values[0], enum: values };
    }
    return { anyOf: options.map(agentToolParameters) };
  }
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {}, required: string[] = [];
    for (const [name, field] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
      properties[name] = agentToolParameters(field);
      if (!field.isOptional()) required.push(name);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    for (const check of schema._def.checks) {
      if (check.kind === "min") result.minLength = check.value;
      else if (check.kind === "max") result.maxLength = check.value;
      else if (check.kind === "uuid") result.format = "uuid";
      else if (check.kind === "datetime") result.format = "date-time";
      else if (check.kind === "regex") {
        if (check.regex.flags) throw new Error("Unsupported agent string regex flags");
        result.pattern = check.regex.source;
      }
      else if (check.kind === "url") result.format = "uri";
      else if (check.kind !== "trim") throw new Error(`Unsupported agent string constraint: ${check.kind}`);
    }
    return result;
  }
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: schema.isInt ? "integer" : "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "min") result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      else if (check.kind === "max") result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      else if (check.kind !== "int" && check.kind !== "finite") throw new Error(`Unsupported agent number constraint: ${check.kind}`);
    }
    return result;
  }
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { type: typeof schema.value, const: schema.value };
  if (schema instanceof z.ZodArray) return { type: "array", items: agentToolParameters(schema.element),
    ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}), ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}) };
  throw new Error(`Unsupported agent parameter contract: ${schema._def.typeName}`);
}
