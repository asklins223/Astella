import assert from "node:assert/strict";
import test from "node:test";
import { contentValidation } from "../content-validators.ts";
test("version equality returns no content and never masks forbidden responses", () => {
  const input = { method: "GET", url: "/v2/notes/n/cache-version", status: 200 };
  const first = contentValidation(input, '{"tokens":{"note":"v1"}}')!;
  assert.equal(first.notModified, false);
  assert.equal(contentValidation({ ...input, ifNoneMatch: first.etag }, '{"tokens":{"note":"v1"}}')?.notModified, true);
  assert.equal(contentValidation({ ...input, ifNoneMatch: first.etag }, '{"tokens":{"note":"v2"}}')?.notModified, false);
  assert.equal(contentValidation({ ...input, status: 403, ifNoneMatch: first.etag }, '{"tokens":{"note":"v1"}}'), null);
  assert.equal(contentValidation({ ...input, method: "PATCH", ifNoneMatch: first.etag }, '{}'), null);
});
