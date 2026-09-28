import { useState } from "react";
import { ArrowRight, Check, LockKeyhole, Play, RotateCcw, UnlockKeyhole } from "lucide-react";

/** Three independently authored static teaching artifacts.
 * The real product would store the AI-authored, validated HTML/SVG snapshot for each source span.
 * These are intentionally different compositions, not one layout with substituted text. */

export function ToolTicketArtifact({ onViewed }: { readonly onViewed: () => void }) {
  const [step, setStep] = useState(0);
  const labels = ["Agent 写下请求", "程序调用 Tool", "结果送回 Agent"];
  const detail = [
    "“查今天的天气”是请求，还没有真的查。",
    "程序检查后调用天气工具。这个动作发生在模型外面。",
    "工具带回“晴，18℃”，Agent 现在才有新信息。",
  ];
  const advance = () => {
    const next = (step + 1) % 3;
    setStep(next);
    if (next === 2) onViewed();
  };
  return (
    <div className="note-learning-demo__artifact-ticket" aria-label="Tool 调用的请求票演示">
      <div className="note-learning-demo__ticket-scene">
        <div className="note-learning-demo__ticket-stations" aria-hidden="true">
          {labels.map((label, index) => <div key={label} className={step === index ? "is-current" : ""}><span>{index + 1}</span><strong>{label}</strong></div>)}
        </div>
        <svg viewBox="0 0 450 83" role="img" aria-label={"第 " + (step + 1) + " 幕：" + labels[step]}>
          <path d="M65 46 C155 8 285 82 385 46" />
          <g className={"ticket-envelope ticket-envelope--" + step}>
            <rect x="0" y="0" width="54" height="38" rx="7" />
            <path d="M4 5 L27 22 L50 5" />
          </g>
        </svg>
        <div className="note-learning-demo__ticket-detail" aria-live="polite"><strong>{labels[step]}</strong><span>{detail[step]}</span></div>
      </div>
      <button type="button" className="note-learning-demo__artifact-action" onClick={advance}>{step === 2 ? <RotateCcw size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{step === 2 ? "再看一遍" : "下一幕"}</button>
      <small>请求票 · 示例讲解稿 v1</small>
    </div>
  );
}

export function AgentForkArtifact({ onViewed }: { readonly onViewed: () => void }) {
  const [choice, setChoice] = useState<"known" | "need" | null>(null);
  const choose = (next: "known" | "need") => { setChoice(next); onViewed(); };
  return (
    <div className="note-learning-demo__artifact-fork" aria-label="Agent 决定下一步的分岔演示">
      <div className="note-learning-demo__fork-question">要回答“今天会下雨吗？”</div>
      <div className="note-learning-demo__fork-branches">
        <button type="button" className={choice === "known" ? "is-picked" : ""} onClick={() => choose("known")}><span>只看手里的旧资料</span><ArrowRight size={17} aria-hidden="true" /></button>
        <button type="button" className={choice === "need" ? "is-picked" : ""} onClick={() => choose("need")}><span>请求新的天气信息</span><ArrowRight size={17} aria-hidden="true" /></button>
      </div>
      <div className="note-learning-demo__fork-outcome" aria-live="polite">
        {choice === null ? "选一条路，看看 Agent 为什么需要外部能力。" : choice === "known" ? "旧资料里没有今天的天气。Agent 可以继续推测，却不能当作实时查询。" : "Agent 可以请求天气 Tool；程序取得新信息后，才有依据回答今天的天气。"}
      </div>
      <small>分岔树 · 示例讲解稿 v1</small>
    </div>
  );
}

export function PermissionDoorArtifact({ onViewed }: { readonly onViewed: () => void }) {
  const [request, setRequest] = useState<"public" | "private" | null>(null);
  const choose = (next: "public" | "private") => { setRequest(next); onViewed(); };
  return (
    <div className="note-learning-demo__artifact-door" aria-label="工具请求经过权限门的演示">
      <strong className="note-learning-demo__door-premise">本例只授权查公开天气</strong>
      <div className="note-learning-demo__door-requests">
        <button type="button" className={request === "public" ? "is-picked" : ""} onClick={() => choose("public")}>查公开天气</button>
        <button type="button" className={request === "private" ? "is-picked" : ""} onClick={() => choose("private")}>读私人文件</button>
      </div>
      <div className="note-learning-demo__door-scene">
        <div className="note-learning-demo__door-agent">Agent 的请求</div>
        <div className={"note-learning-demo__door-gate" + (request === "public" ? " is-open" : "")}>{request === "public" ? <UnlockKeyhole size={30} aria-hidden="true" /> : <LockKeyhole size={30} aria-hidden="true" />}<span>程序的权限门</span></div>
        <div className="note-learning-demo__door-result" aria-live="polite">{request === null ? "请选择一个请求" : request === "public" ? <><Check size={18} aria-hidden="true" /> 允许 · 可执行</> : "未授权 · 不执行"}</div>
      </div>
      <p>Tool 的说明让 Agent 知道怎样申请；能不能做，由程序决定。</p>
      <small>权限门 · 示例讲解稿 v1</small>
    </div>
  );
}
