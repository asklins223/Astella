import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

type AnnotationDraft = { anchor: NoteAnnotationAnchorV1; text: string };
const draftKey = (anchor: NoteAnnotationAnchorV1) => `${anchor.noteVersionId}:${anchor.startBlockOrdinal}:${anchor.startOffset}:${anchor.endBlockOrdinal}:${anchor.endOffset}`;

export function useNotebookAnnotationDraft(input: {
  noteId: string | null; epochRef: { current: number | undefined }; onSaved: (annotation: NoteAnnotationV1) => void;
}) {
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const latest = useRef(input); latest.current = input;
  const pending = useRef(false), generation = useRef(0);
  const buffers = useRef(new Map<string, AnnotationDraft>());
  useEffect(() => { ++generation.current; pending.current = false; buffers.current.clear(); setDraft(null); setSaving(false); setError(null); }, [input.noteId]);
  const start = useCallback((anchor: NoteAnnotationAnchorV1) => {
    const key = draftKey(anchor), next = buffers.current.get(key) ?? { anchor, text: "" };
    buffers.current.set(key, next); setDraft(next);
    setError(null);
  }, []);
  const setText = useCallback((text: string) => {
    if (!draft) return;
    const next = { ...draft, text }; buffers.current.set(draftKey(draft.anchor), next); setDraft(next);
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
      buffers.current.delete(savedKey);
      setDraft(current => current && draftKey(current.anchor) === savedKey ? null : current);
      latest.current.onSaved(result);
    } catch (failure) { if (expected === generation.current) setError(`批注已保留，保存没成功：${gatewayErrorMessage(failure)}`); }
    finally { if (expected === generation.current) { pending.current = false; setSaving(false); } }
  }, [draft]);
  return { draft, start, saving, error, save, setText };
}
