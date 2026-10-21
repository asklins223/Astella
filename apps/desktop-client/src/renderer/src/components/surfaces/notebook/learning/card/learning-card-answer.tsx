import { ArrowDown, ArrowUp, Check, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { NoteLearningCardQuestionV1 } from "@astella/shared/note-learning-card-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../../../app/client/desktop-client";
import { ArtifactFrameHost } from "../../../source/artifact-frame-host";
import { answerDraft, record, strings } from "./card-model";

export function OperationAnswer({ question, value, onChange, readOnly = false }: { question: NoteLearningCardQuestionV1; value: unknown; onChange?: (value: unknown) => void; readOnly?: boolean }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    setState("loading");
    if (!question.operationArtifactId) { setState("failed"); setMessage("这道操作题缺少可用的操作区域。"); return; }
    void (async () => {
      try {
        unwrapGatewayResult(await window.astella.artifact.ensure({ meta: createRequestMeta(), artifactId: question.operationArtifactId!, origin: "note_learning_card" }));
        if (!stopped) setState("ready");
      } catch (error) { if (!stopped) { setState("failed"); setMessage(gatewayErrorMessage(error)); } }
    })();
    return () => { stopped = true; };
  }, [question.operationArtifactId, retry]);
  if (state === "loading") return <p className="lc-operation-status" role="status"><LoaderCircle size={18} className="lc-spin" />正在打开操作区域…</p>;
  if (state === "failed") return <div className="lc-operation-status" role="alert"><p>{message}</p><button type="button" className="lc-btn lc-btn--soft" onClick={() => setRetry((current) => current + 1)}><RotateCcw size={15} />重新打开</button><small>也可以先跳过，之后再回来。</small></div>;
  return <div className="lc-operation"><ArtifactFrameHost artifactId={question.operationArtifactId!} contentOnly initialAnswer={answerDraft(value)} onAnswer={onChange} readOnly={readOnly} /></div>;
}
export function LearningCardAnswer({ question, value, onChange }: { question: NoteLearningCardQuestionV1; value: unknown; onChange: (value: unknown) => void }) {
  const draft = answerDraft(value), answer = record(draft);
  const options = question.options ?? [];
  if (["single_choice", "multi_choice", "true_false"].includes(question.type)) {
    const choices = question.type === "true_false" ? ["正确", "错误"] : options;
    const selected = question.type === "multi_choice" ? strings(answer.optionIds) : question.type === "true_false" ? typeof draft === "boolean" ? [draft ? "0" : "1"] : [] : typeof answer.optionId === "string" ? [answer.optionId] : [];
    return <div className="lc-answer-options" role="group" aria-label="选择答案">{choices.map((text, index) => {
      const id = String(index), checked = selected.includes(id);
      return <button type="button" key={id} className="lc-answer-option" aria-pressed={checked} onClick={() => onChange(question.type === "true_false" ? index === 0 : question.type === "multi_choice" ? { optionIds: checked ? selected.filter((item) => item !== id) : [...selected, id].sort((a, b) => Number(a) - Number(b)) } : { optionId: id })}><span className="lc-answer-letter">{question.type === "multi_choice" && checked ? <Check size={17} /> : String.fromCharCode(65 + index)}</span><span>{text}</span>{checked && <Check className="lc-option-check" size={17} />}</button>;
    })}</div>;
  }
  if (question.type === "fill_blank") {
    const values = strings(answer.values);
    return <div className="lc-blank-fields">{Array.from({ length: question.blankCount ?? 1 }, (_, index) => <label key={index}><span>第 {index + 1} 空</span><input type="text" maxLength={1000} value={values[index] ?? ""} placeholder="写下这一空的答案" onChange={(event) => onChange({ values: Array.from({ length: question.blankCount ?? 1 }, (_, slot) => slot === index ? event.currentTarget.value : values[slot] ?? "") })} /></label>)}</div>;
  }
  if (question.type === "short_answer") return <label className="lc-short-answer"><span>你的回答</span><textarea value={String(answer.text ?? "")} maxLength={4000} placeholder="按你的理解写下来，不用急着组织成标准答案。" onChange={(event) => onChange({ text: event.currentTarget.value })} /><small>{String(answer.text ?? "").length} / 4000</small></label>;
  if (question.type === "ordering") {
    const order = strings(answer.order);
    const move = (index: number, direction: number) => { const next = [...order], target = index + direction; [next[index], next[target]] = [next[target]!, next[index]!]; onChange({ order: next }); };
    return <div className="lc-ordering"><p>依次点选下方项目，排好后可用箭头调整。</p><ol aria-label="已排列的顺序">{order.map((id, index) => <li key={id}><span>{index + 1}</span><b>{options[Number(id)]}</b><button type="button" aria-label={`上移第 ${index + 1} 项`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" aria-label={`下移第 ${index + 1} 项`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button></li>)}</ol><div className="lc-order-pool">{options.map((text, index) => <button type="button" key={index} disabled={order.includes(String(index))} onClick={() => onChange({ order: [...order, String(index)] })}>{text}</button>)}</div><button type="button" className="lc-text-btn" onClick={() => onChange({ order: [] })}><RotateCcw size={14} />重新排列</button></div>;
  }
  if (question.type === "matching") {
    const pairs = record(answer.pairs);
    return <div className="lc-matching">{options.map((text, index) => <label key={index}><span><b>{String.fromCharCode(65 + index)}</b>{text}</span><span aria-hidden="true">→</span><select aria-label={`为“${text}”选择配对`} value={String(pairs[String(index)] ?? "")} onChange={(event) => onChange({ pairs: { ...pairs, [String(index)]: event.currentTarget.value } })}><option value="">选择对应项</option>{question.rightOptions?.map((right) => <option key={right} value={right}>{right}</option>)}</select></label>)}</div>;
  }
  return <OperationAnswer question={question} value={value} onChange={onChange} />;
}
