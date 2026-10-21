import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useRoomStore } from "../../../../../app/home/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../../../../app/client/desktop-client";
import { useHudPage } from "../../../../hud/use-hud-page";
import { usePageReadableView } from "../../../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../../../hud/hud-pages";
import { SurfaceDataState, useSurfaceProjection } from "../../shell/surface-data";
import { LearningCardPage } from "./learning-card-page";
import { useLearningCardPresentation } from "./learning-card-presentation";

/** A room destination of its own; it never mounts NotebookDesk or its tools. */
export function LearningCardSurface() {
  useHudPage("note-card");
  const target = useRoomStore(state => state.activeNoteRef);
  const scene = useLearningCardPresentation(state => state.scene);
  const { data: note, loading, failure, reload } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    if (!window.astella) throw new Error("桌面端 API 不可用，无法读取这篇笔记。");
    if (!target?.noteId) throw new Error("请先从笔记打开它的学习卡。");
    return unwrapGatewayResult(await window.astella.note.get({ meta: createRequestMeta(workspaceEpoch), noteId: target.noteId }));
  }, [target?.noteId]);
  usePageReadableView({ pageId: "note-card", title: `学习卡 · ${note?.title ?? "正在读取"}`.slice(0, 120),
    statusLine: loading ? "正在读取学习卡" : failure ? "学习卡暂时无法读取" : scene === "practice" ? "正在独立作答，交卷后才显示答案和依据" : scene === "grading" ? "正在批改这次练习" : scene === "results" ? "回看这次练习的结果" : scene === "celebrate" ? "完成了一次练习" : "这篇笔记的配套练习",
    notice: "学习卡归属当前笔记；星级只表示这版学习卡的练习结果。" });
  const close = () => {
    const room = useRoomStore.getState();
    if (room.returnTarget) room.returnTarget.run();
    else room.invoke(target ? "open-notebook" : "open-notes");
  };
  useEffect(() => {
    const room = useRoomStore.getState();
    if (room.returnTarget) return;
    const returnTo = { label: target ? "返回笔记" : "返回笔记库", run: () => useRoomStore.getState().invoke(target ? "open-notebook" : "open-notes") };
    room.setReturnTarget(returnTo);
    return () => { if (useRoomStore.getState().returnTarget === returnTo) useRoomStore.getState().setReturnTarget(null); };
  }, [target?.noteId]);
  return <>
    <header className="task-title"><h1>{HUD_PAGES["note-card"].title}</h1><p>{HUD_PAGES["note-card"].subtitle}</p></header>
    <section className="content learning-card-surface" aria-label="学习卡独立页面">
      <div className="lc-surface-scroll">
        {loading || failure || !note ? <div className="learning-card-page"><header className="lc-page-header"><button type="button" className="lc-text-btn" onClick={close}><ArrowLeft size={15} />返回笔记</button></header><SurfaceDataState kind={loading ? "loading" : failure ? "error" : "empty"} message={loading ? "正在打开学习卡" : "暂时没能打开这篇的学习卡"} detail={failure ?? "正在读取笔记及其保存版本。"} onRetry={() => void reload()} /></div>
          : <LearningCardPage key={note.noteId} noteId={note.noteId} noteVersionId={note.currentVersionId} title={note.title} onClose={close} />}
      </div>
    </section>
  </>;
}
