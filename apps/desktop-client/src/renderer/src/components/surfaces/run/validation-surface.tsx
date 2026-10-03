import { useCallback, useEffect, useRef } from "react";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { RoomIntent } from "../../../app/room-machine";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { LearningRunSurface } from "./learning-run-surface";
import { routeForReturnTarget } from "./learning-run-copy";

type ExitRequest = { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string };
type PendingExit = { intent?: RoomIntent; scopeRevision: number };

async function navigateThroughMainResolver(route: DesktopRouteV1, learningRunId?: string): Promise<DesktopRouteV1> {
  if (!window.ailearn) throw new Error("desktop API is unavailable");
  const resolved = unwrapGatewayResult(await window.ailearn.navigation.resolve({
    meta: createRequestMeta(), route, ...(learningRunId ? { learningRunId } : {}),
  }));
  if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
  const navigated = unwrapGatewayResult(await window.ailearn.navigation.go({
    meta: createRequestMeta(resolved.current.workspaceEpoch), route: resolved.current.route,
    entryKind: "user", ...(learningRunId ? { learningRunId } : {}),
  }));
  if (navigated.current.scope !== "workspace") throw new Error("navigation did not commit to the current workspace");
  return navigated.current.route;
}

/** Release the Player through main, then land on the user's latest destination. */
export function ValidationSurface() {
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const setNavigationGuard = useRoomStore((state) => state.setNavigationGuard);
  const pendingExit = useRef<PendingExit | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingExit.current = null; setNavigationGuard(null); };
  }, [setNavigationGuard]);

  const handleRunExit = useCallback(async (runId: string, request?: ExitRequest, intent?: RoomIntent) => {
    if (pendingExit.current) {
      if (intent) pendingExit.current.intent = intent;
      return;
    }
    const store = useRoomStore.getState();
    const exit: PendingExit = { intent, scopeRevision: store.workspaceScopeRevision };
    pendingExit.current = exit;
    // Main only releases formal assessment after the sensitive Player has
    // unmounted. Keep the guard during that handshake so repeated clicks can
    // update the destination without starting a second release.
    store.setActiveRunId(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let resolvedRoute: DesktopRouteV1;
    let released = false;
    try {
      let requestedRoute = request?.route;
      if (!requestedRoute && window.ailearn) {
        const contract = unwrapGatewayResult(await window.ailearn.learningRun.getReturnContract({ meta: createRequestMeta(), runId }));
        const target = contract.status === "unavailable" ? contract.fallbackTargetV2 : contract.returnTargetV2;
        requestedRoute = target ? routeForReturnTarget(target) : { kind: "room.home" };
      }
      resolvedRoute = await navigateThroughMainResolver(requestedRoute ?? { kind: "room.home" }, runId);
      released = true;
    } catch {
      // An unavailable target still goes through main's room fallback; a
      // renderer destination must not substitute for formal guard release.
      try { resolvedRoute = await navigateThroughMainResolver({ kind: "room.home" }); released = true; }
      catch { resolvedRoute = { kind: "room.home" }; }
    }
    const current = useRoomStore.getState();
    if (!mounted.current || pendingExit.current !== exit) return;
    pendingExit.current = null;
    if (current.workspaceScopeRevision !== exit.scopeRevision) return;
    setNavigationGuard(null);
    if (!released) { current.invoke("home"); return; }
    if (exit.intent) { current.invoke(exit.intent); return; }
    if (request?.objectiveId) {
      // No intermediate home frame: the same card is the next visible face.
      current.setActiveObjectiveId(request.objectiveId);
      current.invoke("open-objective");
    } else if (resolvedRoute.kind === "note.detail") {
      current.setActiveNoteRef({ noteId: resolvedRoute.noteId, noteVersionId: null, mode: "preview",
        learningRoundId: request?.route.kind === "note.detail" && request.route.noteId === resolvedRoute.noteId ? request.reflectionRoundId : undefined });
      current.invoke("open-notebook");
    } else current.invoke(resolvedRoute.kind === "review.queue" ? "review" : "home");
  }, [setNavigationGuard]);

  useEffect(() => {
    if (!activeRunId) {
      if (!pendingExit.current) setNavigationGuard(null);
      return;
    }
    const runId = activeRunId;
    setNavigationGuard((intent) => { void handleRunExit(runId, undefined, intent); });
    return () => { if (!pendingExit.current) setNavigationGuard(null); };
  }, [activeRunId, handleRunExit, setNavigationGuard]);

  return <LearningRunSurface onExit={activeRunId ? (request) => { void handleRunExit(activeRunId, request); } : undefined} />;
}
