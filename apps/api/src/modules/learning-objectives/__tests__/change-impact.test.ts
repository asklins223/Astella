import { test } from "node:test";
import assert from "node:assert/strict";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { detectObjectiveNoteChangeImpactV1, type NoteEvidenceChangeInputV1 } from "../change-impact.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const quote = "甲句子不变。";

function evidence(overrides: Partial<NoteEvidenceChangeInputV1> = {}): NoteEvidenceChangeInputV1 {
  const block = `${quote}旧段落`;
  const quoteHash = hashCanonicalV2("evidence-quote", { quote });
  return {
    previousOrdinal: 2,
    previousBlockContentHash: hashCanonicalV2("block", { content: block }),
    startOffset: 0,
    endOffset: quote.length,
    quoteHash,
    quoteCopyText: quote,
    quoteCopyHash: quoteHash,
    currentBlockContent: block,
    ...overrides,
  };
}

test("D3 layer 1 explicit target relation wins before evidence comparison", () => {
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: true,
    evidence: [evidence({ currentBlockContent: "完全不同" })],
  });
  assert.equal(result.status, "affected");
  assert.equal(result.layer, 1);
  assert.equal(result.reasonCode, "explicit_change_relation");
});

test("D3 layer 2: the same ordinal and block hash preserve the objective without a quote copy", () => {
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ quoteCopyText: null, quoteCopyHash: null })],
  });
  assert.equal(result.status, "unaffected");
  assert.equal(result.layer, 2);
  assert.equal(result.reasonCode, "stable_anchor_unchanged");
});

test("D3 layer 3: unrelated block additions do not affect an unchanged frozen quote", () => {
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ currentBlockContent: `${quote}新补充的例子` })],
  });
  assert.equal(result.status, "unaffected");
  assert.equal(result.layer, 3);
  assert.equal(result.reasonCode, "quoted_text_unchanged");
});

test("D3 layer 3: changed cited text is affected even when the old quote moved elsewhere", () => {
  const current = `甲句子改了。${quote}`;
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ currentBlockContent: current })],
  });
  assert.equal(result.status, "affected");
  assert.equal(result.layer, 3);
  assert.equal(result.changedEvidenceCount, 1);
  assert.equal(result.evidenceDetails[0]?.previousQuote, quote);
  assert.equal(result.evidenceDetails[0]?.currentQuote, "甲句子改了。");
});

test("D3 layer 4: missing quote copy or an orphaned anchor stays uncertain", () => {
  const missingCopy = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ currentBlockContent: "甲句子改了。", quoteCopyText: null, quoteCopyHash: null })],
  });
  assert.equal(missingCopy.status, "uncertain");
  assert.equal(missingCopy.layer, 4);
  assert.equal(missingCopy.evidenceDetails[0]?.previousQuote, null);
  assert.equal(missingCopy.evidenceDetails[0]?.currentQuote, "甲句子改了。");

  const orphanedAnchor = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ previousOrdinal: null })],
  });
  assert.equal(orphanedAnchor.status, "uncertain");
  assert.equal(orphanedAnchor.reasonCode, "insufficient_evidence");

  const invalidOffsets = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [evidence({ currentBlockContent: "甲句子改了。", endOffset: 99 })],
  });
  assert.equal(invalidOffsets.status, "uncertain", "越界锚点不能被误判成引用文本已改变");
  assert.equal(invalidOffsets.evidenceDetails[0]?.currentQuote, null);
});

test("D3 does not call an empty evidence set unchanged", () => {
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [],
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.layer, 4);
  assert.equal(result.evidenceCount, 0);
});

test("a changed anchor remains visible in a mixed set instead of being cancelled by an unchanged quote", () => {
  const result = detectObjectiveNoteChangeImpactV1({
    noteId: NOTE_ID,
    explicitChangeRelation: false,
    evidence: [
      evidence(),
      evidence({ currentBlockContent: "甲句子改了。" }),
      evidence({ previousOrdinal: null }),
    ],
  });
  assert.equal(result.status, "affected");
  assert.equal(result.layer, 3);
  assert.equal(result.unchangedEvidenceCount, 1);
  assert.equal(result.changedEvidenceCount, 1);
  assert.equal(result.uncertainEvidenceCount, 1);
  assert.equal(result.reasonCode, "mixed_evidence");
});
