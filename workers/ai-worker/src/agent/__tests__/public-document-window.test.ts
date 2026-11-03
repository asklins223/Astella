import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicDocumentQueryWindow } from "../public-document-window.ts";
import { readAgentPublicDocument } from "../public-document.ts";

test("actual query terms locate the relevant original paragraph beyond a long navigation prefix", async () => {
  const body = "NASA navigation home resources ".repeat(300) + "\nThe Moon has a tenuous atmosphere called an exosphere.\n" + "Other material. ".repeat(300);
  const selected = selectPublicDocumentQueryWindow(body, "NASA Moon atmosphere exosphere", 500)!;
  assert.ok(selected.offset > 500);
  assert.match(Array.from(body).slice(selected.offset, selected.offset + 500).join(""), /tenuous atmosphere called an exosphere/);
  const fetch = async () => ({ title: "The Moon", text: body });
  const focused = await readAgentPublicDocument("https://example.com/moon", new AbortController().signal, { fetch },
    { maxChars: 500, searchText: "NASA Moon atmosphere exosphere" });
  const full = await readAgentPublicDocument("https://example.com/moon", new AbortController().signal, { fetch }, { maxChars: body.length });
  assert.equal(focused.text, Array.from(body).slice(focused.offset, focused.offset + 500).join(""));
  assert.equal(focused.contentHash, full.contentHash);
  assert.equal(focused.selection?.kind, "query_window");
  assert.ok(focused.nextOffset! < focused.totalChars);
});

test("unknown terms never invent a window; explicit literal lookup and offset still own continuation", async () => {
  const body = "An original introduction. ".repeat(60) + "EXOSPHERE" + " Later paragraph.".repeat(60);
  assert.equal(selectPublicDocumentQueryWindow(body, "没有匹配的查询", 100), null);
  const fetch = async () => ({ title: "Original page", text: body });
  const result = await readAgentPublicDocument("https://example.com/page", new AbortController().signal, { fetch },
    { searchText: "exosphere", findText: "introduction", offset: 0, maxChars: 100 });
  assert.equal(result.selection, undefined);
  assert.equal(result.find?.matchOffset, body.indexOf("introduction"));
  const continuation = await readAgentPublicDocument("https://example.com/page", new AbortController().signal, { fetch },
    { searchText: "exosphere", offset: 100, maxChars: 100 });
  assert.equal(continuation.offset, 100);
  assert.equal(continuation.text, body.slice(100, 200));
  const absentLiteral = await readAgentPublicDocument("https://example.com/page", new AbortController().signal, { fetch },
    { searchText: "exosphere", findText: "nonexistent literal", maxChars: 100 });
  assert.equal(absentLiteral.find?.matchOffset, null);
  assert.match(absentLiteral.text, /EXOSPHERE/);
  assert.equal(absentLiteral.selection?.kind, "query_window");
});

test("window offsets remain code-point positions after emoji and case-folding characters", async () => {
  const body = "🙂İ前言 ".repeat(500) + "Unique Atmospheric evidence is here." + "尾部 ".repeat(500);
  const result = await readAgentPublicDocument("https://example.com/unicode", new AbortController().signal,
    { fetch: async () => ({ title: "Unicode page", text: body }) }, { searchText: "unique atmospheric", maxChars: 200 });
  assert.match(result.text, /Unique Atmospheric/);
  assert.equal(result.text, Array.from(body).slice(result.offset, result.offset + 200).join(""));
});

test("repeated site words cannot outweigh a rare matching term or cause quadratic scanning", () => {
  const body = "nasa home ".repeat(30_000) + " Important exosphere evidence.";
  const result = selectPublicDocumentQueryWindow(body, "nasa exosphere", 1000)!;
  assert.ok(result.offset > 290_000);
  assert.ok(result.matchedTerms.includes("exosphere"));
});
