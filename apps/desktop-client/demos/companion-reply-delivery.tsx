/** Local synthetic messages, production attachment/record/process components.
 * No account, API requests, AI generation or writes to the user's notes. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sparkles, X } from "lucide-react";
import type { CompanionChatSession } from "../src/renderer/src/app/companion-chat-session";
import type { CompanionContentBlockV1, CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { CompanionReplyAttachments } from "../src/renderer/src/components/companion/CompanionReplyAttachments";
import { appendCompanionAgentNode, type CompanionAgentNodes } from "../src/renderer/src/app/companion-agent-nodes";
import { CompanionAgentRail } from "../src/renderer/src/components/companion/companion-agent-rail";
import { CompanionChatRecordArticle } from "../src/renderer/src/components/companion/CompanionChatRecord";
import { useCompanionFloatingPlacement } from "../src/renderer/src/components/companion/use-companion-floating-placement";
import { primeSourceImageBlobUrl } from "../src/renderer/src/components/surfaces/source/source-image";
import "../src/renderer/src/styles";
import "./companion-reply-delivery.css";

const excerpts: CompanionContentBlockV1[] = [
  { type: "quote", label: "《中国朝代历程总揽》· 7 小时前", text: "# 中国朝代历程总揽\n\n从夏到清，中国历史上的主要王朝与并立政权，按时间先后排列。年份前的‘约’表示推算值，学界仍有不同意见。\n\n## 一、先秦\n\n| 朝代 | 年代 | 备注 |\n| --- | --- | --- |\n| 夏 | 约前2070—约前1600 | 传统王朝次序，年代有争议 |\n| 商 | 约前1600—前1046 | 甲骨文与青铜器 |\n| 西周 | 前1046—前771 | 分封制、宗法制 |\n| 东周 | 前770—前256 | 春秋、战国 |\n\n## 二、秦汉\n\n秦朝完成统一，汉朝建立并巩固新的政治秩序。后面按魏晋南北朝、隋唐、宋元明清分段整理。" },
  { type: "quote", label: "《中国近代史总揽（1840—1949）》· 7 小时前", text: "# 中国近代史总揽（1840—1949）\n\n从鸦片战争到新中国成立，中国近代史的主线是：外敌入侵下主权逐步丧失，同时各阶层不断尝试救亡与变革，最终走到民族独立与国家重建。\n\n## 分期\n\n主流教材把 **1840—1949** 整段划为近代史。也有按革命性质切成两段的分法：1840—1919 为旧民主主义革命时期，1919—1949 为新民主主义革命时期。" },
];
const makeMessage = (second: boolean): CompanionMessageV1 => ({ id: second ? "second" : "first", role: "assistant", kind: "text", createdAt: new Date().toISOString(),
  blocks: [{ type: "text", text: second ? "近代史那篇也整理好了。" : "新笔记建好了。" }, ...(second ? [excerpts[1]] : excerpts),
    { type: "nav", label: second ? "打开《中国近代史总揽（1840—1949）》" : "打开《中国古代史总揽（远古—1840）》", route: { kind: "note", noteId: "synthetic-note" } }] } as CompanionMessageV1);

const demoImageKey = "11111111-1111-4111-8111-111111111111/companion/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const richMessage = (long = false): CompanionMessageV1 => ({ id: `rich-${Date.now()}`, role: "assistant", kind: "text", createdAt: new Date().toISOString(), blocks: [
  { type: "text", text: "这张图配着三步看会更直观，旁边也放了一张题面和一段小代码。" },
  { type: "image", url: `/api/uploads/${demoImageKey}`, label: "注意力机制 · Query、Key 与 Value", alt: "Query 按相关程度汇总 Value 的示意图" },
  { type: "diagram", title: "注意力怎样找到有关的内容", steps: long ? Array.from({ length: 8 }, (_, index) => ({ label: `第 ${index + 1} 步：核对当前问题与线索`, detail: "逐项比较 Query 与 Key，保留原文里的细节，再核对权重与 Value 的关系。内容较长时在这张纸里继续阅读。" })) : [{ label: "带着问题找线索", detail: "**Query** 表达当前想找什么，和各个 Key 比较相关程度。" }, { label: "把相关程度变成权重", detail: "权重越大，对本次结果的贡献越大。" }, { label: "按权重汇总内容", detail: "将对应的 Value 加权汇总，得到当前问题需要的表示。" }] },
  { type: "card", cardId: "55555555-5555-4555-8555-555555555555", knowledgeForm: null, front: "为什么注意力机制要分别使用 **Query、Key 和 Value**？" + (long ? "\n\n请从当前问题、匹配线索和实际内容三个角度解释，并逐一说明它们在计算过程里如何配合。".repeat(8) : ""), summary: "试着用「想找什么 / 怎么匹配 / 取出什么」三个问题解释。这里只预览题面。" },
  { type: "code", language: "python", code: "scores = query @ keys.T\nweights = softmax(scores / sqrt(dim))\noutput = weights @ values\n\n# 先匹配，再按权重汇总。" + (long ? "\n" + Array.from({ length: 80 }, (_, index) => `print('第 ${index + 1} 次核对', output, '检查相关程度与汇总后的表示，不改变原始输入，保留同一次计算的完整上下文与结果')`).join("\n") : "") },
  { type: "quote", label: "查阅的片段 · 注意力机制", text: "Query、Key 和 Value 让匹配与取内容分开，权重表示每份内容对当前结果的贡献。" },
] } as CompanionMessageV1);

const toolFrame = (id: string, name: string, status: string, safeSummary?: string) => ({ eventType: "agent.tool", payload: { tool: { toolCallId: id, name, status, safeLabel: "实际工具事件", safeSummary } } });
const completedNodes = () => [toolFrame("read", "companion_read_note", "succeeded", "查阅了《中国古代史总揽》，找到朝代顺序与关键年代。"), toolFrame("create", "companion_create_note", "succeeded", "《中国古代史总揽（远古—1840）》已保存到当前空间。")].reduce(appendCompanionAgentNode, [] as CompanionAgentNodes);

function Demo() {
  const [message, setMessage] = useState(() => makeMessage(false));
  const [visible, setVisible] = useState(true);
  const [spokenText, setSpokenText] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [destination, setDestination] = useState(false);
  const [fail, setFail] = useState(false);
  const [motion, setMotion] = useState("full");
  const [processOpen, setProcessOpen] = useState(false);
  const [nodes, setNodes] = useState(completedNodes);
  const [turn, setTurn] = useState<"running" | "done" | "stopped" | "failed">("done");
  const [playback, setPlayback] = useState(0);
  useEffect(() => {
    if (!playback) return;
    const frame = (id: string, name: string, status: string, summary?: string) => setNodes(current => appendCompanionAgentNode(current, toolFrame(id, name, status, summary)));
    const timers = [
      setTimeout(() => frame("read", "companion_read_note", "requested"), 600),
      setTimeout(() => frame("read", "companion_read_note", "executing"), 1200),
      setTimeout(() => { frame("read", "companion_read_note", "succeeded", "查阅了《中国古代史总揽》，找到朝代顺序与关键年代。"); frame("create", "companion_create_note", "executing", "正在保存整理后的朝代时间线。"); setSpokenText("找到朝代顺序了，我会把关键年代一起补进新笔记。"); }, 4500),
      setTimeout(() => frame("create", "companion_create_note", "succeeded", "新笔记已保存到当前空间。"), 8000),
      setTimeout(() => { setSpokenText(null); setTurn("done"); setVisible(true); }, 10000),
    ];
    return () => timers.forEach(clearTimeout);
  }, [playback]);
  const hudRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const hasVisualDelivery = message.blocks.some(block => block.type === "image" || block.type === "diagram" || block.type === "card" || block.type === "code");
  const { side } = useCompanionFloatingPlacement(hudRef, floatingRef, headRef, !history && (visible || nodes.length > 0), hasVisualDelivery ? 420 : 370);
  const chat = { companionName: "爱吃白饭的大肥鱼", richReply: visible && turn === "done" ? { messageId: message.id, blocks: message.blocks } : null,
    autoNavigatedRoutes: new Set(), proposalStates: {}, runTraces: [],
    dismissRichReply: () => setVisible(false),
    goToRoute: async () => { if (fail) throw new Error("暂时打不开这篇笔记，请重试。"); setDestination(true); },
  } as unknown as CompanionChatSession;
  const dismiss = () => setVisible(false);
  return <div className="desktop-app delivery-demo" data-motion-mode={motion}>
    <div className="delivery-demo__tools"><span>交付验收 · 本机示例</span>
      <button onClick={() => { setPlayback(0); setNodes(completedNodes()); setSpokenText(null); setTurn("done"); setVisible(true); setDestination(false); }}>重开这轮</button>
      <button onClick={() => { setNodes([]); setSpokenText("我先读一下相关笔记，再把朝代顺序整理好。"); setVisible(true); setTurn("running"); setPlayback(value => value + 1); }}>播放实时过程</button>
      <button onClick={() => { setPlayback(0); setNodes([]); setSpokenText("好，今天就先聊到这里。"); setTurn("done"); setVisible(true); }}>无工具回复</button>
      <button onClick={() => { setPlayback(0); setNodes(current => current.map(node => ({ ...node, state: "cancelled" }))); setSpokenText("好，我停在这里。"); setTurn("stopped"); setVisible(true); }}>停止</button>
      <button onClick={() => { setPlayback(0); setNodes(current => current.length ? current.map((node, i) => i === current.length - 1 ? { ...node, state: "outcome_unknown", summary: "暂时没有收到确定回执，请先核对结果。" } : node) : appendCompanionAgentNode([], toolFrame("create", "companion_create_note", "outcome_unknown", "暂时没有收到确定回执，请先核对结果。"))); setSpokenText("暂时没收到确定回执，我先保留这份内容。"); setTurn("done"); setVisible(true); }}>结果待核对</button>
      <button onClick={() => { setMessage(makeMessage(message.id !== "second")); setVisible(true); setDestination(false); }}>下一轮</button>
      <button onClick={() => { setPlayback(0); setMessage(richMessage()); setSpokenText(null); setTurn("done"); setNodes(completedNodes()); setVisible(true); setDestination(false); }}>图片与其他内容</button>
      <button onClick={() => { setPlayback(0); setMessage(richMessage(true)); setSpokenText(null); setTurn("done"); setNodes(completedNodes()); setVisible(true); setDestination(false); }}>长内容</button>
      <button aria-pressed={fail} onClick={() => setFail(value => !value)}>打开失败：{fail ? "开" : "关"}</button>
      <button onClick={() => setMotion(value => value === "full" ? "lite" : value === "lite" ? "off" : "full")}>动效：{motion === "full" ? "完整" : motion === "lite" ? "轻量" : "关闭"}</button>
      <button onClick={() => setHistory(value => !value)}>手记</button>
    </div>
    {destination ? <section className="delivery-demo__note"><button onClick={() => setDestination(false)}>返回书房</button><h1>笔记阅读页（示例）</h1><p>新笔记已经打开，交付纸随之收起。正式产品使用现有笔记路由；这里不写业务数据。</p></section> : null}
    <div className="companion-presence"><img className="window-live2d delivery-demo__character" src="./companion-cutout.png" alt="伴星坐在书房里" /><div ref={hudRef} /></div>
    <div ref={floatingRef} className="companion-hud--floating hud-surface" data-motion={motion} data-side={side} data-blocked={history || undefined}>
      <div ref={headRef} className="companion-hud__head">
      {!history ? <CompanionAgentRail companionName={chat.companionName} key={`process:${message.id}:${playback}`} turnState={turn} progress={null} nodes={nodes} onReadingChange={setProcessOpen} onDismiss={() => setNodes([])} onStop={() => { setPlayback(0); setNodes(current => current.map(node => ({ ...node, state: node.state === "running" ? "cancelled" : node.state }))); setTurn("stopped"); }} /> : null}
      {!history && visible ?
        <div className="companion-hud__output" data-stage="visible" data-tone="reply" data-delivery="true">
          <header className="companion-hud__reply-heading"><strong><Sparkles size={15} />{chat.companionName}</strong><button onClick={dismiss} aria-label="收起伴星回复"><X size={16} /></button></header>
          <p className="companion-hud__output-body">{spokenText ?? (message.blocks[0].type === "text" ? message.blocks[0].text : "")}</p>
          {chat.richReply && !spokenText ? <CompanionReplyAttachments key={`attachments:${message.id}`} chat={chat} paused={processOpen} onDismiss={dismiss} /> : null}
          <footer className="companion-hud__reply-foot"><span>{turn === "running" ? "正在回复…" : "已留在手记"}</span><button className="text-action" onClick={() => setHistory(true)}>手记 ›</button></footer>
        </div> : null}
      </div>
    </div>
    {history ? <div className="companion-history delivery-demo__history" data-motion={motion}><h1>我们的对话手记</h1><button onClick={() => setHistory(false)}>回到书房</button><CompanionChatRecordArticle message={message} chat={chat} /></div> : null}
  </div>;
}
void fetch("./companion-interaction-image.svg").then(response => response.blob()).then(blob => {
  primeSourceImageBlobUrl(demoImageKey, blob);
  createRoot(document.getElementById("root")!).render(<Demo />);
});
