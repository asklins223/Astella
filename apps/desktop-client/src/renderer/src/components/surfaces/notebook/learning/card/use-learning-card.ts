import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteLearningCardAttemptV1, NoteLearningCardV1, NoteLearningCardVersionV1 } from "@astella/shared/note-learning-card-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../../../app/client/desktop-client";
import { hasAnswer, isSkipped, skipAnswer, type CardScene } from "./card-model";

type LoadState = "loading" | "ready" | "generating" | "failed";
export function useLearningCard(noteId: string, noteVersionId: string | null) {
  const [card, setCard] = useState<NoteLearningCardV1 | null>(null);
  const [history, setHistory] = useState<NoteLearningCardAttemptV1[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [scene, setScene] = useState<CardScene>("front");
  const [attempt, setAttempt] = useState<NoteLearningCardAttemptV1 | null>(null);
  const [result, setResult] = useState<NoteLearningCardAttemptV1 | null>(null);
  const [resultQuestionId, setResultQuestionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [index, setIndex] = useState(0), [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [summaryPending, setSummaryPending] = useState(false);
  const [versions, setVersions] = useState<NoteLearningCardVersionV1[]>([]);
  const selectedCard = useRef<string | undefined>(undefined);
  const epoch = useRef(0), mounted = useRef(true), changed = useRef(new Map<string, unknown>());
  const generationExpected = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const context = useRef({ card, attempt, result }); context.current = { card, attempt, result };
  const meta = useCallback(() => createRequestMeta(), []);

  const load = useCallback(async (quiet = false) => {
    const revision = epoch.current;
    try {
      const read = unwrapGatewayResult(await window.astella.noteLearningCard.get({ meta: meta(), noteId, ...(selectedCard.current ? { cardId: selectedCard.current } : {}) }));
      if (!mounted.current || revision !== epoch.current) return;
      const receipts = read.card ? unwrapGatewayResult(await window.astella.noteLearningCard.history({ meta: meta(), cardId: read.card.cardId })).items : [];
      // A resumed attempt can finish after one that was started more recently.
      const items = [...receipts].sort((a, b) => Date.parse(b.completedAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.startedAt));
      if (!mounted.current || revision !== epoch.current) return;
      setCard(read.card); setVersions(read.versions ?? []); setHistory(items); setLoadState(read.generating ? "generating" : "ready");
      const currentResult = items.find((item) => item.attemptId === context.current.result?.attemptId);
      if (currentResult) { setResult(currentResult); setSummaryPending((currentResult.summary as { status?: string } | null)?.status === "pending"); }
      if (!quiet || read.card?.cardId !== context.current.card?.cardId) {
        const unfinished = items.find((item) => ["in_progress", "grading", "grading_failed"].includes(item.status)) ?? null;
        setAttempt(unfinished);
        setDrafts(Object.fromEntries(unfinished?.answers.map((answer) => [answer.questionId, answer.answer]) ?? []));
        const completed = items.find((item) => item.status === "completed") ?? null;
        setResult(completed); setSummaryPending((completed?.summary as { status?: string } | null)?.status === "pending");
        const nextIndex = read.card?.questions.findIndex((question) => !unfinished?.answers.some((answer) => answer.questionId === question.questionId)) ?? 0;
        setIndex(Math.max(0, nextIndex));
        changed.current.clear();
        if (unfinished?.status === "grading") setScene("grading");
        else if (quiet && read.card) setScene("front");
      }
      if (read.card) generationExpected.current = false;
      else if (read.generating) generationExpected.current = true;
      else if (read.generationFailure || generationExpected.current) { generationExpected.current = false; setMessage(read.generationFailure ?? "这次制卡没有完成，原文仍在，可以再试一次。"); }
      return items;
    } catch (error) {
      if (!mounted.current || revision !== epoch.current) return;
      setMessage(gatewayErrorMessage(error)); if (!quiet) setLoadState("failed");
    }
  }, [meta, noteId]);

  useEffect(() => {
    mounted.current = true; epoch.current++; selectedCard.current = undefined; setVersions([]); setLoadState("loading"); setScene("front");
    setAttempt(null); setCard(null); setDrafts({}); changed.current.clear(); setMessage(null); setSummaryPending(false);
    void load();
    return () => { mounted.current = false; epoch.current++; clearTimeout(timer.current); };
  }, [load]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (saving.current) await saving.current;
    const current = context.current;
    if (!current.card || !current.attempt || !changed.current.size) return;
    const revision = epoch.current;
    const work = async () => {
      setSaveState("saving");
      try {
        while (changed.current.size && revision === epoch.current) {
          const [questionId, answer] = changed.current.entries().next().value!;
          unwrapGatewayResult(await window.astella.noteLearningCard.answer({ meta: meta(), cardId: current.card!.cardId, attemptId: current.attempt!.attemptId, questionId, answer }));
          if (changed.current.get(questionId) === answer) changed.current.delete(questionId);
        }
        if (mounted.current && revision === epoch.current) setSaveState("saved");
      } catch (error) {
        if (mounted.current && revision === epoch.current) { setSaveState("failed"); setMessage(gatewayErrorMessage(error)); }
        throw error;
      }
    };
    saving.current = work();
    try { await saving.current; } finally { saving.current = null; }
  }, [meta]);

  const changeAnswer = useCallback((questionId: string, answer: unknown) => {
    setDrafts((current) => ({ ...current, [questionId]: answer })); changed.current.set(questionId, answer);
    setSaveState("saving"); clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, 600);
  }, [flush]);

  useEffect(() => {
    if (loadState !== "generating" && scene !== "grading" && !summaryPending) return;
    if (scene === "grading" && attempt?.status === "grading_failed") return;
    let stopped = false, poll: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const items = await load(true);
      if (stopped) return;
      if (scene === "grading" && context.current.attempt) {
        const finished = items?.find((item) => item.attemptId === context.current.attempt?.attemptId);
        if (finished?.status === "completed") { setResult(finished); setAttempt(null); setScene("celebrate"); return; }
        if (finished?.status === "grading_failed") { setAttempt(finished); setMessage("这次批改没有完成。答案已保存，可以重新提交批改。"); return; }
      }
      poll = setTimeout(() => void tick(), 2500);
    };
    poll = setTimeout(() => void tick(), 1800);
    return () => { stopped = true; clearTimeout(poll); };
  }, [load, loadState, scene, attempt?.status, attempt?.attemptId, summaryPending]);

  async function retrySummary() {
    if (!card || !result || summaryPending) return;
    setBusy(true); setMessage(null);
    try {
      const receipt = unwrapGatewayResult(await window.astella.noteLearningCard.complete({ meta: meta(), cardId: card.cardId, attemptId: result.attemptId, summaryOnly: true }));
      setSummaryPending(Boolean(receipt.jobId));
      await load(true);
    } catch (error) { setMessage(gatewayErrorMessage(error)); } finally { setBusy(false); }
  }

  async function generate(questionCount: 4 | 6 | 8) {
    if (!noteVersionId) { setMessage("请先保存这篇笔记，再生成学习卡。"); return; }
    setBusy(true); setMessage(null);
    try {
      const read = unwrapGatewayResult(await window.astella.noteLearningCard.generate({ meta: meta(), noteId, noteVersionId, options: { questionCount } }));
      selectedCard.current = undefined;
      if (read.queued || read.reason === "generating") { generationExpected.current = true; setLoadState("generating"); }
      else { await load(true); setScene("front"); }
    } catch (error) { setMessage(gatewayErrorMessage(error)); } finally { setBusy(false); }
  }
  async function start() {
    if (!card) return;
    setResultQuestionId(null);
    if (attempt?.status === "in_progress") { setScene("practice"); return; }
    setBusy(true); setMessage(null);
    try {
      const receipt = unwrapGatewayResult(await window.astella.noteLearningCard.startAttempt({ meta: meta(), cardId: card.cardId }));
      setAttempt({ ...receipt, status: "in_progress", score: null, stars: null, summary: null, answers: [], startedAt: new Date().toISOString(), completedAt: null });
      setDrafts({}); changed.current.clear(); setIndex(0); setScene("practice"); setSaveState("saved");
      await load(); // The server may have resumed an attempt created in another window.
      setScene("practice");
    } catch (error) { setMessage(gatewayErrorMessage(error)); } finally { setBusy(false); }
  }
  async function submit() {
    if (!card || !attempt) return;
    setBusy(true); setMessage(null);
    try {
      if (attempt.status === "in_progress") {
        const skippedDrafts: Record<string, unknown> = {};
        for (const question of card.questions) if (!hasAnswer(question, drafts[question.questionId]) && !isSkipped(drafts[question.questionId])) {
          const skipped = skipAnswer(drafts[question.questionId]);
          changed.current.set(question.questionId, skipped); skippedDrafts[question.questionId] = skipped;
        }
        if (Object.keys(skippedDrafts).length) setDrafts((current) => ({ ...current, ...skippedDrafts }));
        await flush();
      }
      const receipt = unwrapGatewayResult(await window.astella.noteLearningCard.complete({ meta: meta(), cardId: card.cardId, attemptId: attempt.attemptId }));
      setAttempt({ ...attempt, status: receipt.grading ? "grading" : "completed" });
      setScene("grading");
    } catch (error) { setMessage(gatewayErrorMessage(error)); } finally { setBusy(false); }
  }
  async function leavePractice() {
    try { await flush(); setScene("front"); return true; } catch { return false; }
  }
  async function selectVersion(cardId: string) {
    epoch.current++; selectedCard.current = cardId; setScene("front"); setLoadState("loading"); setMessage(null);
    setResultQuestionId(null);
    await load();
  }
  function openResult(item: NoteLearningCardAttemptV1, questionId: string | null = null) {
    setResult(item); setResultQuestionId(questionId); setScene("results");
  }
  return { card, history, loadState, scene, setScene, attempt, result, setResult, resultQuestionId, openResult, drafts, index, setIndex, busy, message, setMessage, saveState, load, generate, start, changeAnswer, submit, leavePractice, flush, retrySummary, summaryPending, versions, selectVersion };
}
export type LearningCardController = ReturnType<typeof useLearningCard>;
