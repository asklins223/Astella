import { hashCanonicalV2 } from "@astella/shared/hash-canonical-v2";
import type {
  ObjectiveNoteChangeEvidenceV1,
  ObjectiveNoteChangeImpactV1,
} from "@astella/shared/learning-objective-surface-contracts";

const MAX_EVIDENCE_DETAILS_V1 = 200;
const MAX_EVIDENCE_EXCERPT_CHARS_V1 = 1200;

export interface NoteEvidenceChangeInputV1 {
  /** Ordinal from the version that produced the immutable evidence snapshot. */
  readonly previousOrdinal: number | null;
  readonly previousBlockContentHash: string | null;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quoteHash: string | null;
  readonly quoteCopyText: string | null;
  readonly quoteCopyHash: string | null;
  /** Current version block at the same ordinal; null means absent or ambiguous. */
  readonly currentBlockContent: string | null;
}

type EvidenceDecision = {
  readonly layer: 2 | 3 | 4;
  readonly status: "unaffected" | "affected" | "uncertain";
  readonly reasonCode:
    | "stable_anchor_unchanged"
    | "quoted_text_unchanged"
    | "quoted_text_changed"
    | "insufficient_evidence";
};

function verifiedQuoteCopyV1(evidence: NoteEvidenceChangeInputV1): string | null {
  if (evidence.quoteHash === null || evidence.quoteCopyText === null || evidence.quoteCopyHash !== evidence.quoteHash) {
    return null;
  }
  return hashCanonicalV2("evidence-quote", { quote: evidence.quoteCopyText }) === evidence.quoteHash
    ? evidence.quoteCopyText
    : null;
}

function excerptV1(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null || value.length <= MAX_EVIDENCE_EXCERPT_CHARS_V1) {
    return { value, truncated: false };
  }
  let excerpt = value.slice(0, MAX_EVIDENCE_EXCERPT_CHARS_V1);
  const lastCodeUnit = excerpt.charCodeAt(excerpt.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) excerpt = excerpt.slice(0, -1);
  return { value: excerpt, truncated: true };
}

function evidenceDetailsV1(evidence: readonly NoteEvidenceChangeInputV1[]): {
  evidenceDetails: ObjectiveNoteChangeEvidenceV1[];
  evidenceDetailsOmittedCount: number;
} {
  const projected = evidence.map((item, index) => {
    const offsetsValid = Number.isInteger(item.startOffset) && Number.isInteger(item.endOffset)
      && item.startOffset >= 0 && item.endOffset >= item.startOffset;
    const previous = excerptV1(verifiedQuoteCopyV1(item));
    const current = excerptV1(item.currentBlockContent !== null && offsetsValid && item.endOffset <= item.currentBlockContent.length
      ? item.currentBlockContent.slice(item.startOffset, item.endOffset)
      : null);
    return {
      evidenceIndex: index + 1,
      previousOrdinal: item.previousOrdinal,
      previousQuote: previous.value,
      currentQuote: current.value,
      previousQuoteTruncated: previous.truncated,
      currentQuoteTruncated: current.truncated,
    };
  });
  return {
    evidenceDetails: projected.slice(0, MAX_EVIDENCE_DETAILS_V1),
    evidenceDetailsOmittedCount: Math.max(0, projected.length - MAX_EVIDENCE_DETAILS_V1),
  };
}

function withEvidenceDetailsV1(
  impact: Omit<ObjectiveNoteChangeImpactV1, "evidenceDetails" | "evidenceDetailsOmittedCount">,
  evidence: readonly NoteEvidenceChangeInputV1[],
): ObjectiveNoteChangeImpactV1 {
  return { ...impact, ...evidenceDetailsV1(evidence) };
}

function decideEvidenceV1(evidence: NoteEvidenceChangeInputV1): EvidenceDecision {
  if (
    evidence.previousOrdinal === null ||
    !Number.isInteger(evidence.previousOrdinal) ||
    evidence.previousOrdinal < 1 ||
    evidence.currentBlockContent === null
  ) {
    return { layer: 4, status: "uncertain", reasonCode: "insufficient_evidence" };
  }

  const currentBlockHash = hashCanonicalV2("block", { content: evidence.currentBlockContent });
  if (evidence.previousBlockContentHash === currentBlockHash) {
    return { layer: 2, status: "unaffected", reasonCode: "stable_anchor_unchanged" };
  }

  if (
    !Number.isInteger(evidence.startOffset) ||
    !Number.isInteger(evidence.endOffset) ||
    evidence.startOffset < 0 ||
    evidence.endOffset < evidence.startOffset ||
    evidence.endOffset > evidence.currentBlockContent.length ||
    evidence.quoteHash === null ||
    evidence.quoteCopyText === null ||
    evidence.quoteCopyHash === null
  ) {
    return { layer: 4, status: "uncertain", reasonCode: "insufficient_evidence" };
  }

  if (verifiedQuoteCopyV1(evidence) === null) {
    return { layer: 4, status: "uncertain", reasonCode: "insufficient_evidence" };
  }

  const currentQuote = evidence.currentBlockContent.slice(evidence.startOffset, evidence.endOffset);
  const currentQuoteHash = hashCanonicalV2("evidence-quote", { quote: currentQuote });
  return currentQuoteHash === evidence.quoteHash
    ? { layer: 3, status: "unaffected", reasonCode: "quoted_text_unchanged" }
    : { layer: 3, status: "affected", reasonCode: "quoted_text_changed" };
}

/**
 * D3 §3 read-only impact decision. An explicit target relation has priority;
 * otherwise each evidence anchor is checked in stable order: same-ordinal block
 * hash, exact frozen quote, then uncertain. No title or nearby-text matching.
 */
export function detectObjectiveNoteChangeImpactV1(input: {
  readonly noteId: string;
  readonly explicitChangeRelation: boolean;
  readonly evidence: readonly NoteEvidenceChangeInputV1[];
}): ObjectiveNoteChangeImpactV1 {
  if (input.explicitChangeRelation) {
    return withEvidenceDetailsV1({
      noteId: input.noteId,
      status: "affected",
      layer: 1,
      reasonCode: "explicit_change_relation",
      evidenceCount: input.evidence.length,
      unchangedEvidenceCount: 0,
      changedEvidenceCount: 0,
      uncertainEvidenceCount: 0,
    }, input.evidence);
  }

  const decisions = input.evidence.map(decideEvidenceV1);
  if (decisions.length === 0) {
    return withEvidenceDetailsV1({
      noteId: input.noteId,
      status: "uncertain",
      layer: 4,
      reasonCode: "insufficient_evidence",
      evidenceCount: 0,
      unchangedEvidenceCount: 0,
      changedEvidenceCount: 0,
      uncertainEvidenceCount: 0,
    }, input.evidence);
  }

  const unchangedEvidenceCount = decisions.filter((decision) => decision.status === "unaffected").length;
  const changedEvidenceCount = decisions.filter((decision) => decision.status === "affected").length;
  const uncertainEvidenceCount = decisions.filter((decision) => decision.status === "uncertain").length;

  if (changedEvidenceCount > 0) {
    return withEvidenceDetailsV1({
      noteId: input.noteId,
      status: "affected",
      layer: Math.min(...decisions.filter((decision) => decision.status === "affected").map((decision) => decision.layer)),
      reasonCode: uncertainEvidenceCount > 0 ? "mixed_evidence" : "quoted_text_changed",
      evidenceCount: decisions.length,
      unchangedEvidenceCount,
      changedEvidenceCount,
      uncertainEvidenceCount,
    }, input.evidence);
  }

  if (uncertainEvidenceCount > 0) {
    return withEvidenceDetailsV1({
      noteId: input.noteId,
      status: "uncertain",
      layer: 4,
      reasonCode: "insufficient_evidence",
      evidenceCount: decisions.length,
      unchangedEvidenceCount,
      changedEvidenceCount,
      uncertainEvidenceCount,
    }, input.evidence);
  }

  const layer = Math.max(...decisions.map((decision) => decision.layer));
  return withEvidenceDetailsV1({
    noteId: input.noteId,
    status: "unaffected",
    layer,
    reasonCode: layer === 2 ? "stable_anchor_unchanged" : "quoted_text_unchanged",
    evidenceCount: decisions.length,
    unchangedEvidenceCount,
    changedEvidenceCount,
    uncertainEvidenceCount,
  }, input.evidence);
}
