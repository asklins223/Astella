import assert from "node:assert/strict";
import test from "node:test";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "@astella/shared";
import { decodeMimoUnionArguments } from "../mimo-tool-arguments.ts";

test("MiMo encoded nullable fields decode under the same authoritative attention schema", () => {
  const definition = getCompanionAgentTool("companion_attention_write")!;
  const wire = { action: "arrange", key: "quiet", expectedRevision: 0, intent: "前台安静后问近况", topics: ["presence.quiet"],
    nextReviewAt: "null", expiresAt: "null", preferenceRevision: "1", selfNote: "null", state: "active" };
  const decoded = decodeMimoUnionArguments(wire, definition.parameters);
  assert.deepEqual(decoded, { ...wire, nextReviewAt: null, expiresAt: null, preferenceRevision: 1, selfNote: null });
  assert.equal(validateCompanionAgentToolArguments(definition.name, decoded).success, true);
  assert.equal(wire.nextReviewAt, "null", "the wire observation remains unchanged");
});

test("the codec preserves legitimate text, invalid values, authority fields and extra keys", () => {
  const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
  for (const value of ["null", "1", '{"key":"x"}'])
    assert.equal(decodeMimoUnionArguments(value, nullable({ type: "string" })), value);
  for (const value of ["01", "undefined", "1e999", "not-a-number"])
    assert.equal(decodeMimoUnionArguments(value, nullable({ type: "integer" })), value);
  assert.equal(decodeMimoUnionArguments("1", { type: "integer" }), "1", "ordinary CAS fields are not coerced");
  assert.deepEqual(decodeMimoUnionArguments({ unknown: "null" }, { type: "object", properties: {} }), { unknown: "null" });
  const definition = getCompanionAgentTool("companion_attention_write")!;
  const invalid = { action: "arrange", key: "quiet", expectedRevision: "0", intent: "x", topics: ["invented.topic"],
    nextReviewAt: "bad-date", expiresAt: "null", preferenceRevision: "-1", selfNote: "{}", state: "active", extra: true };
  assert.equal(validateCompanionAgentToolArguments(definition.name,
    decodeMimoUnionArguments(invalid, definition.parameters)).success, false);
});
