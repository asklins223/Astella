import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoundedRequestShape } from "../request-shape-limit.ts";

test("accepts large strings but rejects oversized or deeply nested collections", () => {
  assert.equal(isBoundedRequestShape({ text: "x".repeat(1_000_000), items: [1, 2] }), true);
  assert.equal(isBoundedRequestShape({ items: Array(50_000).fill(null) }), false);
  let nested: unknown = null;
  for (let i = 0; i < 66; i++) nested = [nested];
  assert.equal(isBoundedRequestShape(nested), false);
});
