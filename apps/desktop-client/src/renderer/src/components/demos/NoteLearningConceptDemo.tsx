import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, Clock3, CornerDownRight, Link2, MessageSquareText, Paperclip, Play, RotateCcw, X } from "lucide-react";
import { useRoomStore } from "../../app/room-store";
import { useHudPageClasses } from "../hud/use-hud-page";
import type { HudPageId } from "../hud/hud-pages";
import { AgentForkArtifact, PermissionDoorArtifact, ToolTicketArtifact } from "./NoteLearningArtifacts";
import "./note-learning-concept-demo.css";

type Mode = "overview" | "recall" | "annotation" | "expand" | "trail";
type ParagraphId = "agent" | "tool" | "permission";
type TrailKind = "overview" | "recall" | "annotation" | "animation" | "expand";

interface Annotation {
  readonly id: string;
  readonly paragraphId: ParagraphId;
  readonly quote: string;
}
interface TrailEntry {
  readonly id: string;
  readonly kind: TrailKind;
  readonly title: string;
  readonly detail: string;
  readonly at: string;
  readonly paragraphId?: ParagraphId;
  readonly annotationId?: string;
  readonly artifactId?: ParagraphId;
  readonly draftId?: string;
}
interface DemoData {
  readonly annotations: readonly Annotation[];
  readonly trail: readonly TrailEntry[];
  readonly createdDraftIds: readonly string[];
}

const STORAGE_KEY = "understanding-room-note-learning-demo-v2";
const NOTE_TITLE = "Agent 为什么需要 Tool？";
const paragraphs: readonly {
  id: ParagraphId;
  text: string;
  plain: string;
  analogy: string;
  remember: string;
}[] = [
  {
    id: "agent",
    text: "Agent 可以看作一个带着目标做事的助手。它会参考当前信息，决定下一步要做什么；光靠模型本身，它只能处理已经拿到的内容。",
    plain: "Agent 会根据目标和眼前的信息决定下一步。若它需要新的外部信息，就要向外部能力发出请求。",
    analogy: "像一位正在写旅行计划的助手：手上只有旧地图，就不能知道今天是否下雨。",
    remember: "Agent 决定下一步；新的外部信息要另找入口。",
  },
  {
    id: "tool",
    text: "Tool 是 Agent 可请求的一项外部能力，例如查天气、读文件或运行代码。模型提出调用请求，程序执行工具，再把结果交还给模型继续处理。",
    plain: "“调用 Tool”不是模型亲手去查。模型说出要用哪个工具和参数，程序去执行，拿到结果后再交给模型。",
    analogy: "像助手递出一张“查天气”的办事单；真正打开天气服务、把结果带回来的是程序。",
    remember: "模型提出请求 → 程序执行 → 结果回来。",
  },
  {
    id: "permission",
    text: "Tool 的说明告诉 Agent 它能做什么、需要哪些参数。真正能访问哪些资源、是否允许执行，仍由程序和权限设置决定。",
    plain: "工具清单是“可以申请做什么”的说明，不是无限通行证。程序仍要决定请求能不能执行。",
    analogy: "会填写“借书单”，不等于能打开图书馆里所有上锁的柜子。",
    remember: "工具说明负责引导调用；实际权限由程序控制。",
  },
];
const drafts = [
  { id: "call-chain", title: "一次 Tool 调用是怎么走完的？", relation: "把这篇的请求、执行、返回展开", body: "Agent 根据任务选择工具并给出参数；运行程序检查并执行请求；结果回来后，Agent 再决定回答用户，还是继续下一步。" },
  { id: "context", title: "模型、上下文和 Tool 怎么配合？", relation: "向上看看 Agent 开发的全貌", body: "模型根据上下文做判断，Tool 带来新的外部信息或动作。工具结果进入后续上下文，模型才能据此调整接下来的处理。" },
  { id: "permission", title: "Agent 为什么不能随便用所有工具？", relation: "沿着原文最后一段继续追问", body: "工具的名字和参数只说明怎样提出请求。能否访问文件、调用服务或执行代码，取决于运行程序的授权和限制。" },
] as const;
function newId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
function firstVisit(): DemoData {
  return {
    annotations: [],
    createdDraftIds: [],
    trail: [{
      id: newId(), kind: "overview", title: "翻看了这篇笔记的速览",
      detail: "浏览记录；不代表已经掌握。", at: new Date().toISOString(),
    }],
  };
}
function readDemoData(): DemoData {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return firstVisit();
    const saved = JSON.parse(raw) as DemoData;
    if (Array.isArray(saved.annotations) && Array.isArray(saved.trail) && Array.isArray(saved.createdDraftIds)) return saved;
  } catch { /* Keep the demo usable if storage is unavailable. */ }
  return firstVisit();
}
function timeLabel(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function explanationForSelection(annotation: Annotation) {
  const quote = annotation.quote;
  if (paragraphs.find((item) => item.id === annotation.paragraphId)?.text === quote) return null;
  if (annotation.paragraphId === "tool") {
    if (quote.includes("模型提出") || quote.includes("调用请求")) return {
      plain: "模型会说出想用哪个工具、传什么参数。这一步只是提出请求，还没有拿到结果。",
      analogy: "像把“请查今天的天气”写在办事单上；纸条写好了，不等于天气已经查完。",
    };
    if (quote.includes("程序执行")) return {
      plain: "接到请求后，应用程序才实际调用工具。能不能执行，也要经过程序的检查。",
      analogy: "助手写了办事单，真正跑去窗口办理的人是程序。",
    };
    if (quote.includes("结果交还")) return {
      plain: "工具返回的内容会交回模型，模型把新信息和原来的问题放在一起，继续处理。",
      analogy: "办事员把天气回执带回来，助手才知道该怎么回答。",
    };
  }
  if (annotation.paragraphId === "permission") {
    if (quote.includes("说明") || quote.includes("参数")) return {
      plain: "工具说明像使用说明书：告诉 Agent 名字、用途，以及调用时必须提供哪些信息。",
      analogy: "借书单上要填书名和借阅人；填法写在单子上。",
    };
    if (quote.includes("访问") || quote.includes("允许执行")) return {
      plain: "即使 Agent 会写调用请求，程序仍可拒绝没有授权的资源或动作。",
      analogy: "会填借书单，也不能打开上锁的私人柜子。",
    };
  }
  if (annotation.paragraphId === "agent") {
    if (quote.includes("目标") || quote.includes("下一步")) return {
      plain: "Agent 会围绕目标看当前信息，再决定回答、继续查找，还是使用某项能力。",
      analogy: "像做旅行计划时先看手里的资料，再决定要不要去查今天的天气。",
    };
    if (quote.includes("已经拿到")) return {
      plain: "它能利用当前已有的信息，但要获得新的外部信息，需要一个被允许使用的入口。",
      analogy: "旧地图能告诉你路线，却不能直接告诉你此刻是否下雨。",
    };
  }
  return null;
}

/** Fixed content and local demo state. No note, learning, companion or AI API is called. */
export function NoteLearningConceptDemo({ onClose }: { readonly onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("overview");
  const [data, setData] = useState<DemoData>(readDemoData);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [recallRevealed, setRecallRevealed] = useState(false);
  const [recallStatus, setRecallStatus] = useState<"clear" | "fuzzy" | null>(null);
  const [selectedDraftIds, setSelectedDraftIds] = useState<readonly string[]>([]);
  const [previewDraftId, setPreviewDraftId] = useState<string>(drafts[0].id);
  const [annotationView, setAnnotationView] = useState<"plain" | "show">("plain");
  const [recallHint, setRecallHint] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<{ paragraphId: ParagraphId; quote: string } | null>(null);
  const companionHidden = useRoomStore((state) => state.companionTemporarilyHidden);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const annotationArtifactRef = useRef<HTMLDivElement>(null);
  const previousHudPage = useRef<HudPageId>(useRoomStore.getState().hudPage);
  const setHudPage = useRoomStore((state) => state.setHudPage);
  useHudPageClasses();

  useEffect(() => {
    setHudPage("note-learning");
    return () => {
      if (useRoomStore.getState().hudPage === "note-learning") setHudPage(previousHudPage.current);
    };
  }, [setHudPage]);
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* In-memory demo still works. */ }
  }, [data]);
  useEffect(() => { headingRef.current?.focus(); }, [mode, activeAnnotationId]);
  useEffect(() => { setPendingSelection(null); }, [mode]);
  useEffect(() => {
    if (mode === "annotation" && annotationView === "show") {
      window.requestAnimationFrame(() => annotationArtifactRef.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }));
    }
  }, [mode, annotationView, activeAnnotationId]);

  const addTrail = (entry: Omit<TrailEntry, "id" | "at">) => {
    setData((current) => ({
      ...current,
      trail: [{ ...entry, id: newId(), at: new Date().toISOString() }, ...current.trail],
    }));
  };
  const openAnnotation = (paragraphId: ParagraphId, quote: string) => {
    const normalizedQuote = quote.trim().replace(/\s+/g, " ").slice(0, 200);
    const existing = data.annotations.find((item) => item.paragraphId === paragraphId && item.quote === normalizedQuote);
    if (existing) {
      setActiveAnnotationId(existing.id);
    } else {
      const id = newId();
      setData((current) => ({
        ...current,
        annotations: [...current.annotations, { id, paragraphId, quote: normalizedQuote }],
        trail: [{
          id: newId(), kind: "annotation", title: "给原文留下一条批注",
          detail: normalizedQuote, paragraphId, annotationId: id, at: new Date().toISOString(),
        }, ...current.trail],
      }));
      setActiveAnnotationId(id);
    }
    setAnnotationView("plain");
    setPendingSelection(null);
    setMode("annotation");
  };
  const onSourceMouseUp = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const selection = window.getSelection();
    const quote = selection?.toString().trim();
    if (!quote || quote.length < 2) return;
    const start = selection?.anchorNode?.parentElement?.closest<HTMLElement>("[data-demo-paragraph]");
    const end = selection?.focusNode?.parentElement?.closest<HTMLElement>("[data-demo-paragraph]");
    if (!start || start !== end || !sourceRef.current?.contains(start)) return;
    setPendingSelection({ paragraphId: start.dataset.demoParagraph as ParagraphId, quote });
  };
  const jumpToParagraph = (paragraphId: ParagraphId) => {
    window.requestAnimationFrame(() => {
      sourceRef.current?.querySelector("[data-demo-paragraph='" + paragraphId + "']")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };
  const openTrailEntry = (entry: TrailEntry) => {
    if (entry.kind === "annotation" && entry.annotationId) {
      setActiveAnnotationId(entry.annotationId);
      setAnnotationView("plain");
      setMode("annotation");
    } else if (entry.kind === "animation") {
      if (entry.annotationId) {
        setActiveAnnotationId(entry.annotationId);
        setAnnotationView("show");
        setMode("annotation");
      } else setMode("overview");
    } else if (entry.kind === "recall") {
      setRecallRevealed(true);
      setMode("recall");
    } else if (entry.kind === "expand") {
      if (entry.draftId) setPreviewDraftId(entry.draftId);
      setMode("expand");
    } else setMode("overview");
    if (entry.paragraphId) jumpToParagraph(entry.paragraphId);
  };
  const revealRecall = () => {
    if (recallRevealed) return;
    setRecallRevealed(true);
    addTrail({ kind: "recall", title: "回忆后看了对照", detail: "看了原文；不算独立答对。", paragraphId: "tool" });
  };
  const markRecall = (status: "clear" | "fuzzy") => {
    if (recallStatus === status) return;
    setRecallStatus(status);
    addTrail({
      kind: "recall", title: status === "clear" ? "自己标记：想起来了" : "自己标记：还想再看",
      detail: "这是自己的回忆感受，不是系统的掌握判断。", paragraphId: "tool",
    });
  };
  const toggleDraft = (draftId: string) => {
    setSelectedDraftIds((current) => current.includes(draftId) ? current.filter((id) => id !== draftId) : [...current, draftId]);
  };
  const confirmDrafts = () => {
    const selected = selectedDraftIds.filter((id) => !data.createdDraftIds.includes(id));
    if (selected.length === 0) return;
    setData((current) => ({
      ...current,
      createdDraftIds: [...current.createdDraftIds, ...selected],
      trail: [...selected.map((id) => ({
        id: newId(), kind: "expand" as const, title: "确认收下拓展笔记（演示）",
        detail: drafts.find((draft) => draft.id === id)?.title ?? "拓展笔记",
        draftId: id, at: new Date().toISOString(),
      })), ...current.trail],
    }));
    setSelectedDraftIds([]);
    setPreviewDraftId(selected[0]);
  };

  const activeAnnotation = data.annotations.find((item) => item.id === activeAnnotationId);
  const activeParagraph = paragraphs.find((item) => item.id === activeAnnotation?.paragraphId);
  const paragraphAnnotations = activeParagraph ? data.annotations.filter((item) => item.paragraphId === activeParagraph.id) : [];
  const annotationIndex = paragraphAnnotations.findIndex((item) => item.id === activeAnnotationId);
  const selectedExplanation = activeAnnotation ? explanationForSelection(activeAnnotation) : null;
  const previewDraft = drafts.find((item) => item.id === previewDraftId) ?? drafts[0];
  const availableSelection = selectedDraftIds.filter((id) => !data.createdDraftIds.includes(id));
  const recordArtifact = (paragraphId: ParagraphId) => {
    if (!data.trail.some((entry) => entry.kind === "animation" && entry.artifactId === paragraphId)) {
      addTrail({
        kind: "animation", title: "操作了这段的动态讲解",
        detail: "示例讲解稿 v1 · 依据对应原文，记录所看版本。",
        paragraphId, artifactId: paragraphId,
        annotationId: mode === "annotation" ? activeAnnotationId ?? undefined : undefined,
      });
    }
  };
  const showArtifact = (paragraphId: ParagraphId) => {
    if (paragraphId === "agent") return <AgentForkArtifact onViewed={() => recordArtifact("agent")} />;
    if (paragraphId === "permission") return <PermissionDoorArtifact onViewed={() => recordArtifact("permission")} />;
    return <ToolTicketArtifact onViewed={() => recordArtifact("tool")} />;
  };
  const companionLine = mode === "overview"
    ? "这篇的关键是：Agent 发出请求，程序真的动手。我把它演成了一张会走的请求票。"
    : mode === "recall"
      ? recallRevealed ? "对照和你刚才的感受都留在足迹里。下次还能从这里接着想。" : recallHint ? "只想两个动作：谁提出请求，谁真的去查？" : "这次我先不说答案。你想不起来时，我可以只给一点线索。"
      : mode === "annotation"
        ? "你刚刚问的是原文里的这一处。我把说法贴回这句话，不会聊完就丢。"
        : mode === "expand"
          ? "刚才只看 Tool 这一小块。往上一层，还有模型、上下文和运行程序。你挑想留下的。"
          : "批注、演示和新笔记都连回原文；上次看到哪里，这里能找回来。";
  const companionActionLabel = mode === "overview" ? "带我看 Tool 那段"
    : mode === "recall" ? recallRevealed ? "看学习足迹" : recallHint ? "翻开原文" : "给一点线索"
      : mode === "annotation" ? annotationView === "plain" ? "演给我看" : "换成白话"
        : mode === "expand" ? activeAnnotationId ? "回到刚才那句" : "看上层概念" : "回到原文";
  const onCompanionAction = () => {
    if (mode === "overview") {
      openAnnotation("tool", paragraphs[1].text);
      setAnnotationView("show");
    } else if (mode === "recall") {
      if (recallRevealed) setMode("trail");
      else if (recallHint) revealRecall();
      else setRecallHint(true);
    } else if (mode === "annotation") {
      setAnnotationView((current) => current === "plain" ? "show" : "plain");
    } else if (mode === "expand") {
      if (activeAnnotationId) setMode("annotation");
      else setPreviewDraftId("context");
    } else setMode("overview");
  };

  return (
    <section className="task-surface task-surface--notebook note-learning-demo-host" role="region" aria-label="伴读示例 Demo">
      {!companionHidden ? <div className="note-learning-demo__companion-cue" role="status" aria-label="伴星的示例回应">
        <span>伴星 · 静态演示</span><p>{companionLine}</p>
        <button type="button" onClick={onCompanionAction}>{companionActionLabel}<ChevronRight size={15} aria-hidden="true" /></button>
      </div> : null}
      <div className="task-title"><h1>一篇笔记，按你的需要来</h1><p>Agent 与 Tool · 静态示例</p></div>
      <div className="content note-learning-demo-content">
        <div className="note-learning-demo__book">
          <article className="note-learning-demo__source" aria-label="示例笔记正文" ref={sourceRef} onMouseUp={onSourceMouseUp}>
            <div className="note-learning-demo__source-top"><span className="note-learning-demo__folio"><BookOpen size={16} aria-hidden="true" /> 示例笔记 · Agent 开发</span><span className="note-learning-demo__page-number">原文</span></div>
            <h2>{NOTE_TITLE}</h2>
            {mode === "recall" && !recallRevealed ? (
              <div className="note-learning-demo__closed-book"><BookOpen size={38} aria-hidden="true" /><strong>原文先合上</strong><span>想一想，再由你决定何时翻开。</span></div>
            ) : (
              <>
                <p className="note-learning-demo__source-intro">Tool、一次调用和权限边界，记在同一页。<a href="https://openai.github.io/openai-agents-python/tools/" target="_blank" rel="noopener noreferrer">参考来源：Agents SDK Tools</a></p>
                <div className="note-learning-demo__source-lines">
                  {paragraphs.map((paragraph) => {
                    const marks = data.annotations.filter((item) => item.paragraphId === paragraph.id);
                    const selected = mode === "annotation" && activeAnnotation?.paragraphId === paragraph.id;
                    return (
                      <div key={paragraph.id} className={"note-learning-demo__paragraph" + (selected ? " is-selected" : "")} data-demo-paragraph={paragraph.id}>
                        <p>{paragraph.text}</p>
                        <div className="note-learning-demo__paragraph-actions">
                          <button type="button" className="note-learning-demo__ask" onClick={() => openAnnotation(paragraph.id, paragraph.text)}><MessageSquareText size={15} aria-hidden="true" /> 问这段</button>
                          {pendingSelection?.paragraphId === paragraph.id ? <button type="button" className="note-learning-demo__selection-action" onClick={() => openAnnotation(paragraph.id, pendingSelection.quote)}><MessageSquareText size={15} aria-hidden="true" /> 解释所选：“{pendingSelection.quote.slice(0, 11)}{pendingSelection.quote.length > 11 ? "…" : ""}”</button> : null}
                          {marks.length > 0 ? <button type="button" className="note-learning-demo__mark" onClick={() => { setActiveAnnotationId(marks[marks.length - 1].id); setAnnotationView("plain"); setMode("annotation"); }}><Paperclip size={14} aria-hidden="true" /> 批注 {marks.length} 条</button> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {data.createdDraftIds.length > 0 ? <div className="note-learning-demo__linked-notes"><strong><Link2 size={15} aria-hidden="true" /> 从这篇长出的笔记</strong>{data.createdDraftIds.map((id) => {
                  const draft = drafts.find((item) => item.id === id);
                  return draft ? <button key={id} type="button" onClick={() => { setPreviewDraftId(id); setMode("expand"); }}>{draft.title}<ChevronRight size={14} aria-hidden="true" /></button> : null;
                })}</div> : null}
              </>
            )}
            <div className="note-learning-demo__source-foot"><button type="button" onClick={() => setMode("trail")}><Clock3 size={15} aria-hidden="true" /> 学习足迹 {data.trail.length} 条</button><span>示例记录在本机；真实笔记不会改变。</span></div>
          </article>

          <section className="note-learning-demo__guide" aria-label="当前伴读内容">
            <span className="note-learning-demo__tape" aria-hidden="true" />
            <div className="note-learning-demo__guide-top"><span className="note-learning-demo__small-tag">静态演示 · 本机记录</span><button type="button" className="note-learning-demo__close" onClick={onClose} aria-label="退出伴读 Demo"><X size={17} aria-hidden="true" /></button></div>
            <nav className="note-learning-demo__tabs" aria-label="看这篇笔记的方式">
              <button type="button" className={mode === "overview" ? "is-active" : ""} onClick={() => setMode("overview")}>速看</button>
              <button type="button" className={mode === "recall" ? "is-active" : ""} onClick={() => { setRecallRevealed(false); setRecallStatus(null); setRecallHint(false); setMode("recall"); }}>回忆</button>
              <button type="button" className={mode === "expand" ? "is-active" : ""} onClick={() => setMode("expand")}>往外学</button>
              <button type="button" className={mode === "trail" ? "is-active" : ""} onClick={() => setMode("trail")}>足迹</button>
            </nav>

            {mode === "overview" ? <div className="note-learning-demo__guide-body">
              <h2 ref={headingRef} tabIndex={-1}>一分钟抓住这篇</h2>
              <p className="note-learning-demo__lead">Tool 让 Agent 能请求外部能力。Agent 提出请求，程序执行，再把结果交回来。</p>
              {showArtifact("tool")}
              <p className="note-learning-demo__takeaway"><Check size={17} aria-hidden="true" /> 记住：Tool 是可请求的能力，实际执行仍在程序手里。</p>
            </div> : null}

            {mode === "recall" ? <div className="note-learning-demo__guide-body">
              <h2 ref={headingRef} tabIndex={-1}>隔久了，先想一想</h2>
              <div className="note-learning-demo__recall-card"><span>只想一个问题</span><p>Agent 想知道今天会不会下雨，Tool 在中间做了什么？</p></div>
              {!recallRevealed ? <button type="button" className="note-learning-demo__primary" onClick={revealRecall}>翻开对照 <BookOpen size={18} aria-hidden="true" /></button> : <div className="note-learning-demo__recall-result">
                <p><strong>对照原文：</strong>模型提出调用请求，程序执行 Tool，再把结果送回来。</p>
                <div className="note-learning-demo__recall-choices"><button type="button" className={recallStatus === "clear" ? "is-picked" : ""} onClick={() => markRecall("clear")}>想起来了</button><button type="button" className={recallStatus === "fuzzy" ? "is-picked" : ""} onClick={() => markRecall("fuzzy")}>还想再看</button></div>
                {recallStatus ? <span className="note-learning-demo__honesty">已记入足迹：这是你的感受，不会写成“已经掌握”。</span> : null}
              </div>}
            </div> : null}

            {mode === "annotation" && activeAnnotation && activeParagraph ? <div className="note-learning-demo__guide-body note-learning-demo__annotation-body">
              <h2 ref={headingRef} tabIndex={-1}>贴在原文旁的批注</h2>
              <blockquote>{activeAnnotation.quote}</blockquote>
              {paragraphAnnotations.length > 1 ? <div className="note-learning-demo__annotation-index" aria-label="本段的其他批注">
                <span>本段批注 {annotationIndex + 1} / {paragraphAnnotations.length}</span>
                <button type="button" disabled={annotationIndex <= 0} onClick={() => { setActiveAnnotationId(paragraphAnnotations[annotationIndex - 1].id); setAnnotationView("plain"); }}>上一条</button>
                <button type="button" disabled={annotationIndex >= paragraphAnnotations.length - 1} onClick={() => { setActiveAnnotationId(paragraphAnnotations[annotationIndex + 1].id); setAnnotationView("plain"); }}>下一条</button>
              </div> : null}
              <div className="note-learning-demo__explain-switch"><button type="button" className={annotationView === "plain" ? "is-picked" : ""} onClick={() => setAnnotationView("plain")}>讲人话</button><button type="button" className={annotationView === "show" ? "is-picked" : ""} onClick={() => setAnnotationView("show")}>演给我看</button></div>
              {annotationView === "plain" ? <div className="note-learning-demo__annotation-note"><strong>换成大白话</strong><p>{selectedExplanation?.plain ?? activeParagraph.plain}</p><strong>伴星换个比方 · 示例说法</strong><p>{selectedExplanation?.analogy ?? activeParagraph.analogy}</p><div className="note-learning-demo__annotation-end"><Paperclip size={16} aria-hidden="true" /> {activeParagraph.remember}</div></div> : <div className="note-learning-demo__artifact-slot" ref={annotationArtifactRef}>{showArtifact(activeParagraph.id)}</div>}
              <button type="button" className="note-learning-demo__source-link" onClick={() => jumpToParagraph(activeParagraph.id)}><CornerDownRight size={17} aria-hidden="true" /> 回到这句原文</button>
            </div> : null}

            {mode === "expand" ? <div className="note-learning-demo__guide-body note-learning-demo__expand-body">
              <h2 ref={headingRef} tabIndex={-1}>从 Tool 往外看</h2>
              <div className="note-learning-demo__concept-line"><span>Agent 开发</span><ChevronRight size={15} aria-hidden="true" /><strong>Tool</strong><ChevronRight size={15} aria-hidden="true" /><span>继续探索</span></div>
              <p className="note-learning-demo__expand-intro">可继续写成笔记的三个方向</p>
              <div className="note-learning-demo__draft-list">{drafts.map((draft) => {
                const created = data.createdDraftIds.includes(draft.id);
                return <div key={draft.id} className={"note-learning-demo__draft" + (previewDraftId === draft.id ? " is-previewed" : "")}>
                  <input type="checkbox" checked={created || selectedDraftIds.includes(draft.id)} disabled={created} onChange={() => toggleDraft(draft.id)} aria-label={(created ? "已收下" : "选择") + draft.title} />
                  <button type="button" onClick={() => setPreviewDraftId(draft.id)}><strong>{draft.title}</strong><span>{created ? "已和原笔记互相引用" : draft.relation}</span></button>
                </div>;
              })}</div>
              <div className="note-learning-demo__draft-preview">
                <span>{data.createdDraftIds.includes(previewDraft.id) ? "已收下的示例笔记" : "草稿预览"}</span>
                <strong>{previewDraft.title}</strong>
                <p>{previewDraft.body}</p>
                <div className="note-learning-demo__draft-links">
                  <button type="button" onClick={() => { setMode("overview"); sourceRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }}><Link2 size={13} aria-hidden="true" /> 原笔记：《{NOTE_TITLE}》</button>
                  {data.createdDraftIds.includes(previewDraft.id) ? data.createdDraftIds.filter((id) => id !== previewDraft.id).map((id) => {
                    const related = drafts.find((item) => item.id === id);
                    return related ? <button key={id} type="button" onClick={() => setPreviewDraftId(id)}><Link2 size={13} aria-hidden="true" /> 关联：{related.title}</button> : null;
                  }) : null}
                </div>
              </div>
              <button type="button" className="note-learning-demo__primary" disabled={availableSelection.length === 0} onClick={confirmDrafts}>确认收下 {availableSelection.length} 篇（演示）<ArrowRight size={17} aria-hidden="true" /></button>
            </div> : null}

            {mode === "trail" ? <div className="note-learning-demo__guide-body note-learning-demo__trail-body">
              <h2 ref={headingRef} tabIndex={-1}>走过的路，都能回去</h2>
              <p className="note-learning-demo__trail-intro">每条都连着当时的原文或讲解。</p>
              <div className="note-learning-demo__trail-list">{data.trail.map((entry) => <button key={entry.id} type="button" onClick={() => openTrailEntry(entry)}>
                <span className="note-learning-demo__trail-icon">{entry.kind === "annotation" ? <MessageSquareText size={17} /> : entry.kind === "expand" ? <Link2 size={17} /> : entry.kind === "recall" ? <RotateCcw size={17} /> : entry.kind === "animation" ? <Play size={17} /> : <BookOpen size={17} />}</span>
                <span><strong>{entry.title}</strong><small>{entry.detail}</small><time dateTime={entry.at}>{timeLabel(entry.at)}</time></span><ChevronRight size={16} aria-hidden="true" />
              </button>)}</div>
            </div> : null}
          </section>
        </div>
      </div>
    </section>
  );
}
