import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCompanionMemoryContent } from "../companion/companion-memory-content.ts";

test("exact memory deduplication normalizes spacing and preserves meaning-bearing text", () => {
  assert.equal(normalizeCompanionMemoryContent("  Read\n\t daily.  "), "Read daily.");
  for (const text of ["用户晚上九点以后不想被打扰。", "晚上九点以后不想被打扰，除非我先开口", "Nine O'Clock, Please.", "Don't remind me."])
    assert.equal(normalizeCompanionMemoryContent(text), text);
});
