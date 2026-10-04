import { z } from "zod";

/** Deliberately supports the contract shapes used by agent manifests; unsupported shapes fail at registration. */
export function agentToolParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return agentToolParameters(schema._def.innerType);
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
