import { useCallback, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight, Check, CircleAlert, FileText, Link2, X } from "lucide-react";
import { extractCandidateLinks } from "@astella/shared/desktop-ipc-contracts";
import { useRoomStore } from "../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../app/desktop-client";
import { resolveSceneMotionMode } from "../scene/scene-motion";
import { formatRelative } from "./surfaces/notebook/surface-data.tsx";
import { useSourceMotion } from "./surfaces/source/use-source-motion";
import {
  dispatchSourceCaptured,
  hasOpenModal,
  isOwnedDropTarget,
  markLinkSeen,
  readSeenLinks,
} from "../app/source-intake";
import {
  MAX_BATCH_CAPTURE_FILES,
  canCaptureSource,
  captureSourceTasks,
  readCaptureFiles,
  type BatchCaptureOutcome,
  type CaptureTask,
} from "../app/source-batch-capture";

gsap.registerPlugin(useGSAP);

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** 剪贴板弹窗挂载在已登录的房间里：盖子（DesktopAccessGate）外面不问。 */
export function SourceIntakeHost() {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const workspaceScopeRevision = useRoomStore(state => state.workspaceScopeRevision);

  useEffect(() => { setPendingUrl(null); }, [workspaceScopeRevision]);

  useClipboardLinkWatcher(setPendingUrl);

  return (
    <>
      {pendingUrl ? (
        <ClipboardLinkPrompt
          key={`${workspaceScopeRevision}:${pendingUrl}`}
          url={pendingUrl}
          onClose={(seen) => {
            if (seen) markLinkSeen(pendingUrl);
            setPendingUrl(null);
          }}
        />
      ) : null}
      <GlobalDropOverlay />
    </>
  );
}

/**
 * 外部复制 → 回到书房 → 问一次。只在窗口重新得焦时查，
 * 应用内复制、高频切换都不会被打扰；问过（收或略）的链接记下来不再问。
 */
function useClipboardLinkWatcher(onFreshUrl: (url: string) => void) {
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const onboardingRef = useRef(onboardingOpen);
  onboardingRef.current = onboardingOpen;

  const check = useCallback(async () => {
    if (busyRef.current || pendingRef.current) return;
    if (document.hidden || onboardingRef.current || hasOpenModal()) return;
    if (!window.astella?.clipboard) return;
    const scope = useRoomStore.getState().workspaceScopeRevision;
    busyRef.current = true;
    try {
      const response = await window.astella.clipboard.readLinks({ meta: createRequestMeta() });
      // 后台轮询不进网关错误广播：不通就等下一次回到书房，不打扰。
      if (!response.ok || useRoomStore.getState().workspaceScopeRevision !== scope) return;
      const fresh = response.data.urls.find((url) => !readSeenLinks().has(url));
      if (!fresh) return;
      // IPC 回来这一下里可能弹出了别的窗，让新窗先说。
      if (document.hidden || onboardingRef.current || hasOpenModal()) return;
      pendingRef.current = true;
      onFreshUrl(fresh);
    } catch {
      // 剪贴板不可读（极少）同样等下一轮，不弹错误。
    } finally {
      busyRef.current = false;
    }
  }, [onFreshUrl]);

  // 弹窗关掉才允许问下一条，避免叠窗。
  useEffect(() => {
    pendingRef.current = false;
  });

  useEffect(() => {
    if (document.hasFocus() && !document.hidden) void check();
    const onFocus = () => void check();
    const onVisibility = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check]);
}

type PromptPhase =
  | { kind: "checking" }
  | { kind: "ready"; capture: "allowed" | "denied" }
  | { kind: "importing" }
  | { kind: "done"; sourceId: string; title: string; duplicate: boolean }
  | { kind: "failed"; message: string };

export function ClipboardLinkPrompt({ url, onClose }: { readonly url: string; readonly onClose: (seen: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closedRef = useRef(false);
  const importingRef = useRef(false);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveSourceId = useRoomStore(state => state.setActiveSourceId);
  const setReturnTarget = useRoomStore(state => state.setReturnTarget);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const [phase, setPhase] = useState<PromptPhase>({ kind: "checking" });
  useSourceMotion(dialogRef, "clipboard");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    closedRef.current = false;
    if (!dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => { closedRef.current = true; };
  }, []);

  useEffect(() => {
    let active = true;
    void canCaptureSource().then((capture) => {
      if (!active || closedRef.current) return;
      // 服务端问不到就收声等下一轮：不断言、也不把链接记成问过。
      if (capture === "unknown") onClose(false);
      else setPhase({ kind: "ready", capture });
    });
    return () => { active = false; };
  }, []);

  // Full lets the paper settle with a small overshoot; Lite changes opacity only.
  useGSAP(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (motionMode === "off") {
      gsap.set(dialog, { clearProps: "opacity,transform,filter" });
      return;
    }
    if (motionMode === "lite") {
      gsap.fromTo(
        dialog,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.16, ease: "power3.out", clearProps: "opacity,visibility" },
      );
      return;
    }
    const timeline = gsap.timeline();
    timeline.fromTo(
      dialog,
      { autoAlpha: 0, y: 16, scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.5)", clearProps: "transform,opacity,visibility" },
      0,
    );
  }, { scope: dialogRef, dependencies: [motionMode], revertOnUpdate: true });

  const dismiss = useCallback((seen: boolean, restoreFocus = true) => {
    if (closedRef.current) return;
    closedRef.current = true;
    dialogRef.current?.close();
    const target = returnFocusRef.current;
    onClose(seen);
    window.requestAnimationFrame(() => {
      if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [onClose]);

  const doImport = useCallback(async () => {
    if (closedRef.current || importingRef.current) return;
    if (phase.kind !== "failed" && !(phase.kind === "ready" && phase.capture === "allowed")) return;
    importingRef.current = true;
    const scope = useRoomStore.getState().workspaceScopeRevision;
    const isCurrent = () => !closedRef.current && useRoomStore.getState().workspaceScopeRevision === scope;
    setPhase({ kind: "importing" });
    try {
      const response = await window.astella.source.create({
        meta: createRequestMeta(),
        request: { url },
      });
      if (!isCurrent()) return;
      const created = unwrapGatewayResult(response);
      dispatchSourceCaptured(created.source.id, created.source.title);
      setPhase({ kind: "done", sourceId: created.source.id, title: created.source.title, duplicate: Boolean(created.duplicateOf) });
    } catch (error) {
      if (isCurrent()) setPhase({ kind: "failed", message: gatewayErrorMessage(error) });
    } finally {
      importingRef.current = false;
    }
  }, [url, phase]);

  const denied = phase.kind === "ready" && phase.capture === "denied";
  const busy = phase.kind === "checking" || phase.kind === "importing";

  return (
    <dialog
      ref={dialogRef}
      className="source-intake-dialog source-experience"
      aria-labelledby="source-intake-title"
      onCancel={(event) => { event.preventDefault(); dismiss(true); }}
      onClick={(event) => {
        if (event.target === dialogRef.current && phase.kind !== "importing") dismiss(true);
      }}
      onClose={() => dismiss(true)}
    >
      <div className="source-intake-dialog__body">
        <button
          type="button"
          className="source-intake-dialog__close"
          aria-label="忽略这条链接"
          disabled={busy}
          onClick={() => dismiss(true)}
        >
          <X size={17} aria-hidden="true" />
        </button>
        <span className="source-intake-dialog__item" aria-hidden="true"><Link2 size={27} /></span>
        <h2 id="source-intake-title">{phase.kind === "done" ? (phase.duplicate ? "这份已经有啦" : "已经收下啦") : "收下这条链接？"}</h2>
        <p className="source-intake-dialog__url" aria-label={`链接地址：${url}`}>
          <strong>{hostOf(url)}</strong>
          <small>{url}</small>
        </p>
        {phase.kind === "done" ? (
          <p className="source-intake-dialog__hint" role="status">
            {phase.duplicate
              ? `这份材料之前已经采过（《${phase.title}》），没有再建一份；打开的是原来那一篇。`
              : `《${phase.title}》正在解析，解析完会出现在来源库里。`}
          </p>
        ) : (
          <p className="source-intake-dialog__hint">{phase.kind === "importing" ? "正在收下这份材料…" : "正文解析好以后，就能接着读了。"}</p>
        )}
        {denied ? <p className="source-intake-dialog__locked">只有工作区所有者可以采集来源，这条链接先不收。</p> : null}
        {phase.kind === "failed" ? <p className="source-intake-dialog__error" role="alert">{phase.message}</p> : null}
        <div className="source-intake-dialog__actions">
          {phase.kind === "done" ? (
            <>
              <button
                ref={primaryRef}
                type="button"
                className="button primary"
                onClick={() => {
                  setActiveSourceId(phase.sourceId);
                  dismiss(true, false);
                  invoke("open-source");
                  setReturnTarget({ label: "返回来源库", run: () => invoke("open-sources") });
                }}
              >
                打开这份材料<ArrowRight size={15} aria-hidden="true" />
              </button>
              <button type="button" className="button" onClick={() => dismiss(true)}>好</button>
            </>
          ) : phase.kind === "failed" ? (
            <>
              <button ref={primaryRef} type="button" className="button primary" onClick={() => void doImport()}>
                重试
              </button>
              <button type="button" className="button" onClick={() => dismiss(true)}>忽略</button>
            </>
          ) : (
            <>
              <button
                ref={primaryRef}
                type="button"
                className="button primary"
                disabled={busy || denied}
                onClick={() => void doImport()}
              >
                {phase.kind === "importing" ? "正在收进…" : "开始解析"}
              </button>
              <button type="button" className="button" disabled={busy} onClick={() => dismiss(true)}>忽略</button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

type DropPhase =
  | { kind: "armed" }
  | { kind: "working"; done: number; total: number }
  | { kind: "report"; outcomes: readonly BatchCaptureOutcome[]; overflow: boolean; created: { readonly sourceId: string; readonly title: string } | null };

export function GlobalDropOverlay() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<DropPhase | null>(null);
  const dragDepthRef = useRef(0);
  const phaseRef = useRef<DropPhase | null>(null);
  phaseRef.current = phase;
  const invoke = useRoomStore((state) => state.invoke);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const onboardingRef = useRef(onboardingOpen);
  onboardingRef.current = onboardingOpen;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const reportPrimaryRef = useRef<HTMLButtonElement>(null);
  const batchRef = useRef(0);
  const workspaceScopeRevision = useRoomStore(state => state.workspaceScopeRevision);
  useSourceMotion(overlayRef, phase?.kind ?? "closed");
  const motionPreference = useRoomStore(state => state.motionMode);
  const reducedMotion = useRoomStore(state => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);

  const reset = useCallback(() => {
    batchRef.current++;
    dragDepthRef.current = 0;
    phaseRef.current = null;
    setPhase(null);
  }, []);
  useEffect(() => { reset(); return () => { batchRef.current++; }; }, [workspaceScopeRevision, reset]);

  const dismissReport = useCallback(() => {
    reset();
    const target = returnFocusRef.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [reset]);

  const processDrop = useCallback(async (transfer: DataTransfer) => {
    const batch = ++batchRef.current;
    const scope = useRoomStore.getState().workspaceScopeRevision;
    const isCurrent = () => batch === batchRef.current && scope === useRoomStore.getState().workspaceScopeRevision;
    const files = [...transfer.files];

    const tasks: CaptureTask[] = [];
    const outcomes: BatchCaptureOutcome[] = [];
    let overflow = false;

    // 进度条先亮起来：读 50 份文件不是零耗时，没有这一帧的话界面像是没接住这次拖放。
    phaseRef.current = { kind: "working", done: 0, total: Math.max(1, files.length) };
    setPhase(phaseRef.current);

    if (files.length === 0) {
      // 浏览器里拖出来的链接：没有文件，只有地址文本。
      const text = `${transfer.getData("text/uri-list")}\n${transfer.getData("text/plain")}`;
      const urls = extractCandidateLinks(text);
      if (urls.length === 0) { reset(); return; }
      for (const url of urls) tasks.push({ name: hostOf(url), request: { url } });
    } else {
      const read = await readCaptureFiles(files);
      overflow = read.overflow;
      tasks.push(...read.tasks);
      outcomes.push(...read.outcomes);
      if (!isCurrent()) return;
    }

    const total = tasks.length + outcomes.length;
    // 一份都没成：收掉这一屏。原来这里是直接 return，于是「正在收进第 1/1 份…」会一直挂着。
    if (total === 0) { reset(); return; }
    setPhase({ kind: "working", done: 0, total });

    if (tasks.length > 0) {
      const capture = await canCaptureSource();
      if (!isCurrent()) return;
      if (capture !== "allowed") {
        outcomes.push({
          name: tasks.length === 1 ? tasks[0].name : `这 ${tasks.length} 份材料`,
          ok: false,
          message: capture === "denied" ? "只有工作区所有者可以采集来源。" : "来源库暂时不可用，稍后再拖一次。",
        });
      } else {
        // 读文件时已经报过一部分进度（那是"准备"），这里从"开始建来源"重新数一遍，
        // 所以界面上那一条进度条从头到尾走的是同一件事：收下第几份。
        const result = await captureSourceTasks(tasks, {
          isCurrent,
          onProgress: (done) => { if (isCurrent()) setPhase({ kind: "working", done: outcomes.length + done, total }); },
        });
        if (!result) return;
        if (result.created) dispatchSourceCaptured(result.created.sourceId, result.created.title);
        setPhase({ kind: "report", outcomes: [...outcomes, ...result.outcomes], overflow, created: result.created });
        return;
      }
    }
    setPhase({ kind: "report", outcomes, overflow, created: null });
  }, [reset]);

  useEffect(() => {
    const hasFiles = (transfer: DataTransfer | null) =>
      Boolean(transfer && (transfer.types.includes("Files") || transfer.types.includes("text/uri-list")));

    const onDragEnter = (event: DragEvent) => {
      if (onboardingRef.current || isOwnedDropTarget(event.target, event.dataTransfer) || hasOpenModal()) {
        dragDepthRef.current = 0;
        if (phaseRef.current?.kind === "armed") setPhase(null);
        return;
      }
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      if (!phaseRef.current) {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPhase({ kind: "armed" });
      }
    };
    const onDragOver = (event: DragEvent) => {
      // 放行这次拖放：preventDefault 之后 drop 事件才会进来。
      if (phaseRef.current && !isOwnedDropTarget(event.target, event.dataTransfer)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (!phaseRef.current) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 && phaseRef.current.kind === "armed") setPhase(null);
    };
    const onDrop = (event: DragEvent) => {
      // 采集栏、编辑器、笔记纸面各有自己的投放格：这层不跟它们抢。
      const owned = event.defaultPrevented || isOwnedDropTarget(event.target, event.dataTransfer);
      if (onboardingRef.current || owned) {
        dragDepthRef.current = 0;
        // 松手这一下归别人了，"松开，收进来源库"那句就该收回去——浮层本身不吃
        // 事件（pointer-events:none），不主动收就会一直挂在屏幕上说一件没发生的事。
        if (phaseRef.current?.kind === "armed") setPhase(null);
        return;
      }
      if (phaseRef.current?.kind !== "armed" || !event.dataTransfer || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      void processDrop(event.dataTransfer);
    };
    const onDragEnd = () => {
      if (phaseRef.current?.kind === "armed") reset();
      else dragDepthRef.current = 0;
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [processDrop, reset]);

  useEffect(() => {
    if (phase?.kind === "report") {
      window.requestAnimationFrame(() => reportPrimaryRef.current?.focus({ preventScroll: true }));
    }
  }, [phase]);

  useEffect(() => {
    if (!phase) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && phaseRef.current?.kind === "report") {
        const buttons = [...(overlayRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || !overlayRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key !== "Escape" || phaseRef.current?.kind === "working") return;
      event.preventDefault();
      reset();
      const target = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, reset]);

  if (!phase) return null;

  const working = phase.kind === "working" ? phase : null;
  const report = phase.kind === "report" ? phase : null;
  const succeeded = report?.outcomes.some((outcome) => outcome.ok) ?? false;

  return (
    <div ref={overlayRef} className="source-intake-drop source-experience" data-source-motion={motionMode} data-phase={phase.kind} aria-hidden={report ? undefined : true}>
      <div
        className="source-intake-drop__card"
        role={report ? "alertdialog" : undefined}
        aria-modal={report ? true : undefined}
        aria-labelledby="source-intake-drop-title"
      >
        <span className="source-intake-drop__icon" aria-hidden="true">
          {report ? <FileText size={24} /> : <Link2 size={24} />}
        </span>
        <h2 id="source-intake-drop-title">
          {working ? `正在收进第 ${Math.min(working.done + 1, working.total)}/${working.total} 份…`
            : report ? (succeeded ? "收好了" : "这次没收进来")
            : "松开，收进来源库"}
        </h2>
        {working ? (
          <>
            <p>直接解析到来源库，完成后索引会自动更新。</p>
            <div className="source-intake-drop__progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${working.total === 0 ? 0 : working.done / working.total})` }} />
            </div>
          </>
        ) : report ? (
          <>
            {report.overflow ? <p>一次最多收 {MAX_BATCH_CAPTURE_FILES} 份，多出的那几份请分批拖入。</p> : null}
            <ul className="source-intake-drop__report">
              {report.outcomes.map((outcome) => (
                <li key={outcome.name} data-ok={outcome.ok}>
                  {outcome.ok
                    ? <Check size={16} aria-hidden="true" />
                    : <CircleAlert size={16} aria-hidden="true" />}
                  <span>
                    <strong>{outcome.name}</strong>
                    <small>{outcome.message}</small>
                  </span>
                </li>
              ))}
            </ul>
            <div className="source-intake-drop__actions">
              {succeeded ? (
                <button
                  ref={reportPrimaryRef}
                  type="button"
                  className="button primary"
                  onClick={() => { invoke("open-sources"); reset(); }}
                >
                  去来源库看看 <ArrowRight size={15} aria-hidden="true" />
                </button>
              ) : null}
              <button
                ref={succeeded ? undefined : reportPrimaryRef}
                type="button"
                className={succeeded ? "button" : "button primary"}
                onClick={dismissReport}
              >
                知道了
              </button>
            </div>
          </>
        ) : (
          <p>文本、Markdown、代码文件，或一条网页链接。</p>
        )}
      </div>
    </div>
  );
}
