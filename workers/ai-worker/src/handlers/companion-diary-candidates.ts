import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiaryMaterial, DiaryPiece } from "./companion-diary-content.ts";

export const companionDiarySelectionSchema = z.object({
  selected_id: z.string().min(1).max(80).nullable(),
  reason_summary: z.string().trim().min(1).max(240),
  source_ids: z.array(z.string().uuid()).max(16),
}).strict();

export type CompanionDiarySelection = z.infer<typeof companionDiarySelectionSchema>;

export interface DiaryCandidate {
  id: string;
  sourceIds: string[];
  sourceVersions: Array<{ sourceId: string; version: string }>;
  at: string;
  noteId: string | null;
  material: DiaryMaterial;
}

const MESSAGE_SOURCE = "companion_message";
const MAX_DIARY_CANDIDATES = 4;
const MAX_CANDIDATE_PIECES = 16;
const MAX_CANDIDATE_TEXT_CHARS = 12_000;

function minuteOfDay(at: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(at)) return null;
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function sourceId(piece: DiaryPiece): string | null {
  return typeof piece.sourceId === "string" && piece.sourceId.length > 0 ? piece.sourceId : null;
}

function uniquePieces(pieces: DiaryPiece[]): DiaryPiece[] {
  const seen = new Set<string>();
  return pieces.filter((piece) => {
    const id = sourceId(piece);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function candidateSubject(pieces: DiaryPiece[]): DiaryPiece | null {
  const events = pieces.filter((piece) => piece.weight > 0);
  return [...events].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (a.at || "99:99").localeCompare(b.at || "99:99");
  })[0] ?? null;
}

function momentId(pieces: DiaryPiece[]): string {
  const ids = uniquePieces(pieces).map((piece) => sourceId(piece)!).sort();
  return `moment-${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 20)}`;
}

function buildCandidate(
  piecesInput: DiaryPiece[],
  material: DiaryMaterial,
): DiaryCandidate | null {
  const originals = uniquePieces(piecesInput).sort((a, b) => (a.at || "99:99").localeCompare(b.at || "99:99"));
  const pieces = originals.slice(-MAX_CANDIDATE_PIECES);
  const textChars = pieces.reduce((total, piece) => total + piece.text.length, 0);
  if (pieces.length === 0 || textChars < 6) return null;
  // Keep a contiguous ending, including later corrections and outcomes. Never
  // skip a long reply and then present the next turn without its context.
  // A single oversized source stays whole for the full-request governor.
  let used = 0;
  const boundedPieces: DiaryPiece[] = [];
  for (const piece of [...pieces].reverse()) {
    if (!piece.text.trim()) continue;
    if (boundedPieces.length > 0 && used + piece.text.length > MAX_CANDIDATE_TEXT_CHARS) break;
    boundedPieces.unshift({ ...piece });
    used += piece.text.length;
  }
  if (boundedPieces.length === 0) return null;
  const sourceIds = [...new Set(boundedPieces.map((piece) => sourceId(piece)!))].sort();
  const noteIds = [...new Set(boundedPieces.map((piece) => piece.noteId).filter((id): id is string => Boolean(id)))];
  const noteId = noteIds.length === 1 ? noteIds[0] : null;
  const versionMap = new Map<string, string>();
  for (const piece of boundedPieces) {
    const id = sourceId(piece);
    if (id && piece.sourceVersion) versionMap.set(id, piece.sourceVersion);
  }
  const sourceVersions = [...versionMap].map(([id, version]) => ({ sourceId: id, version }));
  const focusedMaterial: DiaryMaterial = {
    ...material,
    pieces: boundedPieces,
    subject: candidateSubject(boundedPieces),
    embeds: material.embeds.filter((embed) => noteIds.includes(embed.noteId)),
    focused: false,
  };
  return {
    id: momentId(boundedPieces),
    sourceIds,
    sourceVersions,
    at: boundedPieces.map((piece) => piece.at).filter(Boolean).sort()[0] ?? "",
    noteId,
    material: focusedMaterial,
  };
}

/**
 * Group a conversation exchange or a note-tied exchange as one selectable moment.
 * Coarse selection is deliberately neutral to speaker: it values connected sources
 * and sufficient context, then caps the model menu at four distinct clips.
 */
export function buildDiaryCandidates(material: DiaryMaterial): DiaryCandidate[] {
  const grounded = material.pieces.filter((piece) =>
    piece.weight > 0 && typeof piece.sourceId === "string" && piece.sourceId.length > 0
      && piece.group !== "backdrop",
  );
  const messages = grounded
    .filter((piece) => piece.sourceType === MESSAGE_SOURCE)
    .sort((a, b) => (a.at || "99:99").localeCompare(b.at || "99:99"));
  const nonMessages = grounded.filter((piece) => piece.sourceType !== MESSAGE_SOURCE);
  const grouped: DiaryPiece[][] = [];
  const noteEvents = nonMessages.filter((piece) => piece.sourceType === "note" && piece.noteId);
  const attachedNotes = new Set<string>();

  // Group the whole short exchange before attaching note events. Distinct
  // conversations must not turn into one scene just because their times overlap.
  let exchange: DiaryPiece[] = [];
  let previousMinute: number | null = null;
  const flushExchange = () => {
    if (exchange.some((piece) => piece.group === "her")) {
      // Attach note edits to a whole exchange. Taking only the turns that mention
      // its title would detach later answers and corrections from that scene.
      const nearbyNotes = noteEvents.filter((note) => {
        const noteMinute = minuteOfDay(note.at);
        return noteMinute !== null && exchange.some((message) => {
          const minute = minuteOfDay(message.at);
          return message.noteId === note.noteId && minute !== null && Math.abs(noteMinute - minute) <= 15;
        });
      });
      nearbyNotes.forEach((note) => attachedNotes.add(sourceId(note)!));
      grouped.push([...exchange, ...nearbyNotes]);
    }
    exchange = [];
    previousMinute = null;
  };
  const conversations = new Map<string | undefined, DiaryPiece[]>();
  for (const message of messages) {
    const conversation = conversations.get(message.conversationId) ?? [];
    conversation.push(message);
    conversations.set(message.conversationId, conversation);
  }
  for (const conversation of conversations.values()) {
    for (const message of conversation) {
      const minute = minuteOfDay(message.at);
      if (exchange.length > 0 && minute !== null && previousMinute !== null && minute - previousMinute > 15) {
        flushExchange();
      }
      exchange.push(message);
      if (minute !== null) previousMinute = minute;
    }
    flushExchange();
  }

  // Events without a nearby exchange remain independent source-bound anchors.
  const remainingNotes = new Map<string, DiaryPiece[]>();
  for (const piece of nonMessages) {
    if (attachedNotes.has(sourceId(piece)!)) continue;
    if (piece.sourceType === "note" && piece.noteId) {
      const group = remainingNotes.get(piece.noteId) ?? [];
      group.push(piece);
      remainingNotes.set(piece.noteId, group);
    } else grouped.push([piece]);
  }
  grouped.push(...remainingNotes.values());

  const candidates = grouped
    .map((pieces) => buildCandidate(pieces, material))
    .filter((candidate): candidate is DiaryCandidate => candidate !== null);
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  const ranked = unique.map((candidate) => ({
    candidate,
    // A shared clip and concrete source diversity add value. Speaker identity does not.
    score: candidate.sourceIds.length * 2
      + Math.min(4, Math.floor(candidate.material.pieces.reduce((n, piece) => n + piece.text.length, 0) / 120))
      + Number(candidate.material.pieces.length > 1),
  })).sort((a, b) => b.score - a.score || a.candidate.at.localeCompare(b.candidate.at));

  const kept: DiaryCandidate[] = [];
  const keptNotes = new Set<string>();
  for (const { candidate } of ranked) {
    if (candidate.noteId && keptNotes.has(candidate.noteId)) continue;
    kept.push(candidate);
    if (candidate.noteId) keptNotes.add(candidate.noteId);
    if (kept.length >= MAX_DIARY_CANDIDATES) break;
  }
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}

export function validateDiarySelection(
  selection: CompanionDiarySelection,
  candidates: DiaryCandidate[],
): boolean {
  if (selection.selected_id === null) return selection.source_ids.length === 0;
  const selected = candidates.find((candidate) => candidate.id === selection.selected_id);
  if (!selected) return false;
  const expected = [...selected.sourceIds].sort();
  const actual = [...selection.source_ids].sort();
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}

export function buildDiarySelectionMessages(
  date: string,
  candidates: DiaryCandidate[],
  retryReason: string | null = null,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "你先从已核实的共同片段里，选择一幕作为伴星今天日记的唯一线头。",
        "可以选择 null；没有适合写成日记的共同片段时就留白，不要为了完成任务硬选。",
        "只比较片段本身是否具体、真实、值得记；不偏爱任何一方说的话，也不把数量当价值。",
        "reason_summary 是一句简短、可展示的选材理由，只说明为何选或不选，不推断新事实，不写隐藏推理。",
        "selected_id 必须是给出的候选 id 或 null。source_ids 必须原样列出所选候选的全部 source_ids；选 null 时给空数组。",
        ...(retryReason ? [`上次输出没有通过服务端结构或来源核对：${retryReason}`] : []),
        '只输出其中一种 JSON：{"selected_id":"<候选 id>","reason_summary":"简短理由","source_ids":["<所选来源 uuid>"]}',
        '或 {"selected_id":null,"reason_summary":"简短理由","source_ids":[]}。',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({ date, candidates: candidates.map((candidate) => ({
        id: candidate.id,
        at: candidate.at,
        source_ids: candidate.sourceIds,
        source_versions: candidate.sourceVersions,
        moment: candidate.material.pieces.map((piece) => ({
          actor: piece.group === "her" ? "伴星" : "用户",
          time: piece.at,
          text: piece.text,
        })),
      })) }),
    },
  ];
}
