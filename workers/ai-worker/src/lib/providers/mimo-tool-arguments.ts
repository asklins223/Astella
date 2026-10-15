type Schema = Record<string, unknown>;
const object = (value: unknown): Schema | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Schema : null;

/** Observed MiMo Responses calls can JSON-encode union values into strings
 * (including nullable numbers, objects and dates). Decode that extra
 * encoding only where the declaration makes it unambiguous. This is not JSON
 * repair or validation: the host still validates the complete original schema.
 * Plain strings, unknown keys and malformed JSON remain unchanged. */
export function decodeMimoUnionArguments(value: unknown, declaration: unknown): unknown {
  const schema = object(declaration);
  if (!schema) return value;
  const unions = Array.isArray(schema.anyOf) ? schema.anyOf
    : Array.isArray(schema.oneOf) ? schema.oneOf
      : Array.isArray(schema.type) ? schema.type.map(type => ({ ...schema, type })) : null;
  let decoded = value;
  let shape = schema;
  if (unions) {
    const branches = unions.flatMap(branch => object(branch) ? [object(branch)!] : []);
    const strings = branches.filter(branch => branch.type === "string");
    // "null" is a legitimate free-text string. A declared date-time cannot be
    // that literal, so the nullable date case has no competing string meaning.
    const canDecode = strings.length === 0 || (value === "null"
      && strings.every(branch => branch.format === "date-time"));
    if (typeof value === "string" && canDecode) {
      try {
        const candidate: unknown = JSON.parse(value);
        const type = candidate === null ? "null" : Array.isArray(candidate) ? "array" : typeof candidate;
        if (type !== "string" && branches.some(branch => branch.type === type
          || (branch.type === "integer" && typeof candidate === "number" && Number.isInteger(candidate)))
          && (typeof candidate !== "number" || Number.isFinite(candidate))) decoded = candidate;
      } catch { /* Invalid JSON is never repaired. */ }
    }
    const type = decoded === null ? "null" : Array.isArray(decoded) ? "array" : typeof decoded;
    shape = branches.find(branch => branch.type === type
      || (branch.type === "integer" && typeof decoded === "number" && Number.isInteger(decoded))) ?? schema;
  }
  if (Array.isArray(decoded)) return decoded.map(item => decodeMimoUnionArguments(item, shape.items));
  const fields = object(decoded), properties = object(shape.properties);
  if (!fields || !properties) return decoded;
  return Object.fromEntries(Object.entries(fields).map(([key, item]) =>
    [key, decodeMimoUnionArguments(item, properties[key])]));
}
