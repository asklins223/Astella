import { useEffect, useRef, useState } from "react";

export type NoteLearningEntry = "overview" | "recall" | "expansion";

/** Choosing a version is explicit; autosync and body-mode changes never start a task. */
export function useNotebookLearningEntry(input: {
  readonly noteId: string | null;
  readonly hasUnversionedChanges: boolean;
  readonly save: () => Promise<boolean>;
  readonly open: (kind: NoteLearningEntry) => void;
  readonly lookup: (kind: NoteLearningEntry) => Promise<"existing" | "missing" | "error">;
  readonly start: (kind: NoteLearningEntry) => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const [choice, setChoice] = useState<NoteLearningEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState<NoteLearningEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<NoteLearningEntry | null>(null);
  const [existing, setExisting] = useState(false);
  const requestId = useRef(0);
  useEffect(() => { ++requestId.current; setChoice(null); setReady(null); setError(null); setSaving(false); setChecking(null); }, [input.noteId]);
  // Save/reload has committed React's new version pointer before this effect starts the task.
  useEffect(() => {
    if (!ready) return;
    latest.current.start(ready);
    setReady(null);
  }, [ready]);
  const request = async (kind: NoteLearningEntry) => {
    const request = ++requestId.current, noteId = latest.current.noteId;
    setChoice(null); setError(null); setChecking(kind);
    latest.current.open(kind);
    try {
      const result = await latest.current.lookup(kind);
      if (request !== requestId.current || latest.current.noteId !== noteId) return;
      if (result === "error") { setError("已有内容暂时没读到，请重试读取。还没有创建生成任务。"); return; }
      setExisting(result === "existing");
      if (result === "missing" || latest.current.hasUnversionedChanges) setChoice(kind);
    } catch {
      if (request === requestId.current) setError("已有内容暂时没读到，请重试读取。还没有创建生成任务。");
    } finally { if (request === requestId.current) setChecking(null); }
  };
  const startSaved = () => { if (choice) { if (!existing) latest.current.start(choice); setChoice(null); } };
  const saveAndStart = async () => {
    if (!choice || saving) return;
    const noteId = latest.current.noteId;
    const kind = choice;
    setSaving(true); setError(null);
    try {
      if (await latest.current.save() && latest.current.noteId === noteId) { setReady(kind); setChoice(null); }
      else if (latest.current.noteId === noteId) setError("版本还没存好。改动仍在，请先核对保存提示。");
    } finally { if (latest.current.noteId === noteId) setSaving(false); }
  };
  return { choice, checking, existing, saving, error, request, startSaved, saveAndStart,
    prepare: (kind: NoteLearningEntry) => { setExisting(false); setError(null); setChoice(kind); },
    dismiss: () => { ++requestId.current; setChoice(null); setChecking(null); } };
}
