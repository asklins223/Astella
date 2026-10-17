import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../../app/client/desktop-client";

type AnnotationDraft = { anchor: NoteAnnotationAnchorV1; text: string };
const draftKey = (anchor: NoteAnnotationAnchorV1) => `${anchor.noteVersionId}:${anchor.startBlockOrdinal}:${anchor.startOffset}:${anchor.endBlockOrdinal}:${anchor.endOffset}`;

/**
 * 审计 F10：草稿按**篇**存活，而不是随换篇静默清空。
 *
 * 批注页上写着"合起附页会保留这次输入"，可写到一半从笔记列表点走另一篇时，
 * 文字无声消失、回来连「继续写批注」都没了——承诺只在同一篇里成立。现在草稿
 * 挂在模块层（noteId → 锚点 → 草稿），换篇、离开这一屏再回来都还在；
 * 保存成功或显式丢弃才删。只活在这一个应用会话里，不落盘。
 */
const draftBuffers = new Map<string, Map<string, AnnotationDraft>>();
/** 每篇最近在写的那一条，换篇回来时接着它。 */
const activeKeys = new Map<string, string>();

export function useNotebookAnnotationDraft(input: {
  noteId: string | null; epochRef: { current: number | undefined }; onSaved: (annotation: NoteAnnotationV1) => void;
}) {
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const latest = useRef(input); latest.current = input;
  const pending = useRef(false), generation = useRef(0);
  useEffect(() => {
    ++generation.current; pending.current = false; setSaving(false); setError(null);
    const noteId = input.noteId;
    const key = noteId ? activeKeys.get(noteId) : undefined;
    const restored = noteId && key ? draftBuffers.get(noteId)?.get(key) ?? null : null;
    setDraft(restored);
  }, [input.noteId]);
  const start = useCallback((anchor: NoteAnnotationAnchorV1) => {
    const noteId = latest.current.noteId;
    if (!noteId) return;
    const noteDrafts = draftBuffers.get(noteId) ?? new Map<string, AnnotationDraft>();
    draftBuffers.set(noteId, noteDrafts);
    const key = draftKey(anchor);
    const next = noteDrafts.get(key) ?? { anchor, text: "" };
    noteDrafts.set(key, next);
    activeKeys.set(noteId, key);
    setDraft(next);
    setError(null);
  }, []);
  const setText = useCallback((text: string) => {
    if (!draft) return;
    const next = { ...draft, text };
    const noteId = latest.current.noteId;
    if (noteId) draftBuffers.get(noteId)?.set(draftKey(draft.anchor), next);
    setDraft(next);
  }, [draft]);
  const save = useCallback(async () => {
    const { noteId, epochRef } = latest.current, api = window.astella?.noteAnnotation;
    if (!draft || !noteId || pending.current || !draft.text.trim()) return;
    if (!api) { setError("批注还在这页，暂时没能保存；请重试。"); return; }
    const expected = generation.current;
    pending.current = true; setSaving(true); setError(null);
    try {
      const result = unwrapGatewayResult(await api.write({ meta: createRequestMeta(epochRef.current), noteId,
        command: { kind: "create", anchor: draft.anchor, explanation: draft.text.trim() } }));
      if (expected !== generation.current) return;
      if (!("annotationId" in result) || result.noteId !== noteId || result.anchor.noteVersionId !== draft.anchor.noteVersionId) throw new Error("批注回执没有对应这句原文，请重试读取。");
      const savedKey = draftKey(draft.anchor);
      draftBuffers.get(noteId)?.delete(savedKey);
      if (activeKeys.get(noteId) === savedKey) activeKeys.delete(noteId);
      setDraft(current => current && draftKey(current.anchor) === savedKey ? null : current);
      latest.current.onSaved(result);
    } catch (failure) { if (expected === generation.current) setError(`批注已保留，保存没成功：${gatewayErrorMessage(failure)}`); }
    finally { if (expected === generation.current) { pending.current = false; setSaving(false); } }
  }, [draft]);
  return { draft, start, saving, error, save, setText };
}
