import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { ySyncPluginKey } from "y-prosemirror";
import type { RefObject } from "react";
import type { NoteAiRange } from "../../companion/note-companion-editing";
import { resolveNoteAiRanges } from "../../companion/note-companion-editing";
import { pmNodesToNoteBlocks } from "@astella/shared/note-doc-schema";

export const noteAiLockKey = new PluginKey<readonly Lock[]>("NOTE_AI_LOCKS");
type Lock = { from: number; to: number; label: string };

export function changesTouchLockedRange(from: number, to: number, lockFrom: number, lockTo: number): boolean {
  return from === to ? from > lockFrom && from < lockTo : from < lockTo && to > lockFrom;
}

/** Transaction filtering covers typing, toolbar transforms, paste, drag, deletion and undo. */
export function noteAiLockPlugin(ranges: RefObject<readonly NoteAiRange[]>) {
  return $prose(() => new Plugin<readonly Lock[]>({
    key: noteAiLockKey,
    state: {
      init: (_config, state) => locksFor(state.doc, ranges.current),
      apply: (tr, value) => tr.getMeta(noteAiLockKey) ? locksFor(tr.doc, ranges.current) : value.map(lock => ({ ...lock,
        from: tr.mapping.map(lock.from, 1), to: tr.mapping.map(lock.to, -1) })).filter(lock => lock.to > lock.from),
    },
    filterTransaction: (tr, state) => {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin) return true;
      let locks = noteAiLockKey.getState(state) ?? [];
      for (const step of tr.steps) {
        const map = step.getMap(); let blocked = false;
        map.forEach((from, to) => { if (locks.some(lock => changesTouchLockedRange(from, to, lock.from, lock.to))) blocked = true; });
        // Attribute/mark changes can have an empty StepMap.
        const structural = step as unknown as { from?: number; to?: number; pos?: number };
        if (typeof structural.from === "number" && locks.some(lock => changesTouchLockedRange(structural.from!, structural.to ?? structural.from!, lock.from, lock.to))) blocked = true;
        if (typeof structural.pos === "number" && locks.some(lock => structural.pos! >= lock.from && structural.pos! < lock.to)) blocked = true;
        if (blocked) return false;
        locks = locks.map(lock => ({ ...lock, from: map.map(lock.from, 1), to: map.map(lock.to, -1) }));
      }
      return true;
    },
    props: { decorations: state => DecorationSet.create(state.doc, (noteAiLockKey.getState(state) ?? []).map(lock =>
      Decoration.node(lock.from, lock.to, { class: "note-ai-working", "data-ai-label": lock.label,
        "aria-busy": "true", "aria-label": `${lock.label}，暂时锁定`, contenteditable: "false" }))) },
  }));
}

function locksFor(doc: Transaction["doc"], ranges: readonly NoteAiRange[]): Lock[] {
  const locks: Lock[] = [];
  const resolved = resolveNoteAiRanges(ranges, pmNodesToNoteBlocks(doc.toJSON().content ?? []));
  doc.forEach((node, from, ordinal) => {
    const range = resolved.find(item => ordinal >= item.startBlock && ordinal <= item.endBlock);
    if (range) locks.push({ from, to: from + node.nodeSize, label: range.label });
  });
  return locks;
}
