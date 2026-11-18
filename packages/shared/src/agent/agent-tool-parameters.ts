import { z } from "zod";

export function agentToolParameters(schema: z.ZodType): Record<string, unknown> {
  return parameterShape(schema);
}

function parameterShape(schema: z.ZodType): Record<string, unknown> {
  const def = schema._zod.def as any;
  const type = def.type;
  if (type === "optional" || type === "default") { const inner = agentToolParameters(def.innerType); return schema.description ? { ...inner, description: schema.description } : inner; }
  if (type === "pipe" || type === "transform") throw new Error("Unsupported agent parameter transform");
  let result: Record<string, unknown>;
  if (type === "nullable") result = { anyOf: [agentToolParameters(def.innerType), { type: "null" }] };
  else if (type === "boolean") result = { type: "boolean" };
  else if (type === "union") {
    const options = def.options as z.ZodType[];
    const literals = options.map(option => (option._zod.def as any).type === "literal" ? (option._zod.def as any).values[0] : undefined);
    if (literals.every(x => x !== undefined && typeof x === typeof literals[0])) result = { type: typeof literals[0] === "number" && literals.every(Number.isInteger) ? "integer" : typeof literals[0], enum: literals };
    else result = { anyOf: options.map(agentToolParameters) };
  } else if (type === "object") {
    const properties: Record<string, unknown> = {}, required: string[] = [];
    for (const [name, field] of Object.entries(def.shape) as [string, z.ZodType][]) {
      properties[name] = agentToolParameters(field);
      if (!field.isOptional()) required.push(name);
    }
    result = { type: "object", properties, required, additionalProperties: false };
  } else if (type === "string" || type === "number" || type === "array") {
    result = type === "array" ? { type, items: agentToolParameters(def.element) } : { type };
    for (const item of (def.checks ?? [])) {
      const check = item._zod.def;
      if (check.check === "min_length") result[type === "array" ? "minItems" : "minLength"] = check.minimum;
      else if (check.check === "max_length") result[type === "array" ? "maxItems" : "maxLength"] = check.maximum;
      else if (check.check === "number_format" && check.format === "safeint") result.type = "integer";
      else if (check.check === "greater_than") result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      else if (check.check === "less_than") result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      else if (check.check === "overwrite" || check.check === "custom") continue;
      else if (check.check === "string_format") {
        if (check.format === "regex") { if (check.pattern.flags) throw new Error("Unsupported agent string regex flags"); result.pattern = check.pattern.source; }
        else if (["uuid", "guid", "datetime", "url"].includes(check.format)) result.format = check.format === "datetime" ? "date-time" : check.format === "url" ? "uri" : check.format === "guid" ? "uuid" : check.format;
        else throw new Error(`Unsupported agent string constraint: ${check.format}`);
      } else throw new Error(`Unsupported agent constraint: ${check.check}`);
    }
  } else if (type === "enum") result = { type: "string", enum: Object.values(def.entries) };
  else if (type === "literal") { const value = def.values[0]; result = { type: typeof value, const: value }; }
  else throw new Error(`Unsupported agent parameter contract: ${type}`);
  return schema.description ? { ...result, description: schema.description } : result;
}
