import { create } from "zustand";
import type { CompanionNoteEditingContextV1 } from "@astella/shared/companion-note-authoring-contracts";

export type NoteAiRange = { startBlock: number; endBlock: number; label: string; expectedBlocks?: readonly string[] };
export const useNoteAiWork = create<{ items: Record<string, { noteId: string; ranges: readonly NoteAiRange[] }> }>(() => ({ items: {} }));
type Paper = { noteId: string; prepare: () => Promise<{ noteVersionId: string; editing: CompanionNoteEditingContextV1 }> };
let paper: Paper | null = null;
export function registerCompanionNotePaper(value: Paper): () => void {
  paper = value; return () => { if (paper === value) paper = null; };
}
export async function prepareCompanionNotePaper(noteId: string) { return paper?.noteId === noteId ? paper.prepare() : null; }
export function beginNoteAiWork(id: string, noteId: string, ranges: readonly NoteAiRange[]) {
  useNoteAiWork.setState(state => ({ items: { ...state.items, [id]: { noteId, ranges } } }));
}
export function endNoteAiWork(id: string) {
  useNoteAiWork.setState(state => { const items = { ...state.items }; for (const key of Object.keys(items)) if (key === id || key.startsWith(`${id}:tool:`)) delete items[key]; return { items }; });
}
export function resetNoteAiWork() { useNoteAiWork.setState({ items: {} }); }

export function resolveNoteAiRanges(ranges: readonly NoteAiRange[], blocks: readonly { content: string }[]): NoteAiRange[] {
  return ranges.flatMap(range => {
    const expected = range.expectedBlocks;
    if (!expected) return [range];
    const matches = (at: number) => expected.every((text, i) => blocks[at + i]?.content === text);
    if (matches(range.startBlock)) return [range];
    const candidates = blocks.flatMap((_block, at) => matches(at) ? [at] : []);
    if (candidates.length !== 1) return [];
    return [{ ...range, startBlock: candidates[0]!, endBlock: candidates[0]! + expected.length - 1 }];
  });
}

/** Feedback only; actual authority comes from the current-turn tool/permission fences. */
export function noteEditRequestRanges(text: string, editing: CompanionNoteEditingContextV1): NoteAiRange[] {
  if (!/(插入|追加|补充.*(这里|光标|末尾|最后)|删除|删掉|替换|改写|改成|转[换成为].*(表格|流程图)|insert|append|delete|replace|rewrite|convert)/i.test(text)) return [];
  if (/(末尾|最后|append)/i.test(text) && editing.tail) return [{ startBlock: editing.tail.block, endBlock: editing.tail.block,
    label: "伴星正在末尾补充", expectedBlocks: [editing.tail.expectedBlock] }];
  const selection = editing.selection;
  if (selection) return [{ startBlock: selection.startBlock, endBlock: selection.endBlock, label: "伴星正在调整这段", expectedBlocks: selection.expectedBlocks }];
  const cursor = editing.cursor;
  return cursor ? [{ startBlock: cursor.block, endBlock: cursor.block, label: "伴星正在准备补充", expectedBlocks: [cursor.expectedBlock] }] : [];
}
