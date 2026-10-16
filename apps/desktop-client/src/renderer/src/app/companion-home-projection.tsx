import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CompanionHomeProjectionV1,
  CompanionRoomProfilePatchV1,
} from "@astella/shared/companion-home-contracts";
import {
  RendererGatewayError,
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "./desktop-client";
import { useRoomStore } from "./room-store";
import { useHomeProjectionInvalidation } from "./home-projection";
import { subscribeCompanionLaunchRegistration } from "./companion-launch-gate";
import {
  beginProjectionRefresh,
  failProjectionRefresh,
  projectionResponseIsCurrent,
  sameProjectionScope,
  type ProjectionWorkspaceScope,
} from "./workspace-projection";

type CompanionRoomProfileChange = Omit<CompanionRoomProfilePatchV1, "version" | "revision">;
type CompanionRoomProfileChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

type CompanionHomeProjectionState = {
  readonly projection: CompanionHomeProjectionV1 | null;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly profileSaving: boolean;
  readonly profileFailure: string | null;
  /**
   * 这份投影**到手**的时刻（毫秒）。主动气泡的展示闸门要用它：
   * 只有这次启动登记（`app.started` 回执）**之后**读回来的投影才允许显示主动气泡——
   * 登记之前那次读取的负载里可能还带着上一次启动的问候（见 companion-launch-gate.ts）。
   */
  readonly projectionFetchedAt: number | null;
  readonly reload: () => void;
  readonly patchRoomProfile: (change: CompanionRoomProfileChange) => Promise<CompanionRoomProfileChangeResult>;
};

const CompanionHomeProjectionContext = createContext<CompanionHomeProjectionState>({
  projection: null,
  loading: true,
  failure: null,
  profileSaving: false,
  profileFailure: null,
  projectionFetchedAt: null,
  reload: () => {},
  patchRoomProfile: async () => ({ ok: false, message: "伴星小屋尚未完成同步。" }),
});

/** Keeps learning facts and companion memory/profile facts on separate typed reads. */
export function CompanionHomeProjectionProvider({ children }: { readonly children: ReactNode }) {
  const surface = useRoomStore((state) => state.surface);
  const invalidation = useHomeProjectionInvalidation();
  const requestGenerationRef = useRef(0);
  const profileWriteGenerationRef = useRef(0);
  const profileSavingRef = useRef(false);
  const scopeRef = useRef<ProjectionWorkspaceScope | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<CompanionHomeProjectionState, "reload" | "patchRoomProfile">>({
    projection: null,
    loading: true,
    failure: null,
    profileSaving: false,
    profileFailure: null,
    projectionFetchedAt: null,
  });
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  /**
   * 这次启动一旦登记（`app.started` 回执），立刻重读一次投影：服务端在那一刻已经
   * 收掉了上一次没被看见的启动问候，重读回来才是干净的队列。展示闸门同时要求
   * `projectionFetchedAt` 晚于登记时刻，所以在这次重读回来之前，手上的旧负载不会被显示。
   */
  useEffect(() => subscribeCompanionLaunchRegistration(() => reload()), [reload]);

  const patchRoomProfile = useCallback(async (
    change: CompanionRoomProfileChange,
  ): Promise<CompanionRoomProfileChangeResult> => {
    const currentProfile = state.projection?.roomProfile;
    const requestScope = scopeRef.current;
    if (!currentProfile || !requestScope || !window.astella) {
      return { ok: false, message: "伴星小屋尚未完成同步。" };
    }
    if (profileSavingRef.current) {
      return { ok: false, message: "伴星小屋正在保存上一项摆放。" };
    }
    profileSavingRef.current = true;
    const writeGeneration = ++profileWriteGenerationRef.current;
    setState((current) => ({ ...current, profileSaving: true, profileFailure: null }));
    try {
      const sessionResponse = await window.astella.auth.getState({ meta: createRequestMeta() });
      const session = unwrapGatewayResult(sessionResponse);
      if (session.status !== "authenticated" || !session.workspace) throw new Error("session");
      const sessionScope = {
        workspaceId: session.workspace.workspaceId,
        workspaceEpoch: session.workspaceEpoch,
      } satisfies ProjectionWorkspaceScope;
      if (!sameProjectionScope(requestScope, sessionScope)) throw new Error("workspace changed");
      const response = await window.astella.companion.room.patchProfile({
        meta: createRequestMeta(session.workspaceEpoch),
        request: {
          version: 1,
          revision: currentProfile.revision,
          ...change,
        },
      });
      const profile = unwrapGatewayResult(response);
      if (
        writeGeneration !== profileWriteGenerationRef.current
        || !sameProjectionScope(requestScope, scopeRef.current)
        || (response.workspaceEpoch !== undefined && response.workspaceEpoch !== requestScope.workspaceEpoch)
      ) {
        return { ok: false, message: "工作区已经变化，已忽略旧的保存结果。" };
      }
      setState((current) => ({
        ...current,
        projection: current.projection ? { ...current.projection, roomProfile: profile } : current.projection,
        profileSaving: false,
        profileFailure: null,
      }));
      return { ok: true };
    } catch (error) {
      const message = gatewayErrorMessage(error);
      if (
        writeGeneration === profileWriteGenerationRef.current
        && sameProjectionScope(requestScope, scopeRef.current)
      ) {
        setState((current) => ({ ...current, profileSaving: false, profileFailure: message }));
        if (error instanceof RendererGatewayError && error.code === "conflict") reload();
      }
      return { ok: false, message };
    } finally {
      if (writeGeneration === profileWriteGenerationRef.current) profileSavingRef.current = false;
    }
  }, [reload, state.projection]);

  useEffect(() => {
    // Participation deliveries belong to the current page as well as the room.

    const knownScope = scopeRef.current;
    if (
      knownScope
      && invalidation.workspaceEpoch !== null
      && invalidation.workspaceEpoch !== knownScope.workspaceEpoch
    ) {
      scopeRef.current = null;
      profileWriteGenerationRef.current += 1;
      profileSavingRef.current = false;
      setState({
        projection: null,
        loading: true,
        failure: null,
        profileSaving: false,
        profileFailure: null,
        projectionFetchedAt: null,
      });
    } else {
      setState((current) => ({
        ...beginProjectionRefresh(current, knownScope),
        profileSaving: current.profileSaving,
        profileFailure: current.profileFailure,
        projectionFetchedAt: current.projectionFetchedAt,
      }));
    }

    const generation = ++requestGenerationRef.current;
    const load = async () => {
      if (!window.astella) throw new Error("unavailable");
      const knownScope = scopeRef.current;
      // 同代刷新不重读会话（同 home-projection）：伴星投递只说明这份投影旧了，
      // 账号与空间都没变，/auth/me 不该随事件条数增长。
      let requestScope: ProjectionWorkspaceScope;
      if (knownScope && invalidation.workspaceEpoch === knownScope.workspaceEpoch) {
        requestScope = knownScope;
      } else {
        const sessionResponse = await window.astella.auth.getState({ meta: createRequestMeta() });
        const session = unwrapGatewayResult(sessionResponse);
        if (session.status !== "authenticated" || !session.workspace) {
          if (generation === requestGenerationRef.current) {
            scopeRef.current = null;
            profileWriteGenerationRef.current += 1;
            profileSavingRef.current = false;
            setState({
              projection: null,
              loading: false,
              failure: "请先登录后再读取伴星小屋。",
              profileSaving: false,
              profileFailure: null,
              projectionFetchedAt: null,
            });
          }
          return;
        }
        requestScope = {
          workspaceId: session.workspace.workspaceId,
          workspaceEpoch: session.workspaceEpoch,
        } satisfies ProjectionWorkspaceScope;
      }
      if (generation !== requestGenerationRef.current) return;
      const previousScope = scopeRef.current;
      if (!sameProjectionScope(previousScope, requestScope)) {
        scopeRef.current = requestScope;
        profileWriteGenerationRef.current += 1;
        profileSavingRef.current = false;
        setState((current) => ({
          ...beginProjectionRefresh(current, previousScope, requestScope),
          profileSaving: false,
          profileFailure: null,
          projectionFetchedAt: current.projectionFetchedAt,
        }));
      } else {
        scopeRef.current = requestScope;
      }

      const response = await window.astella.companion.home.getProjection({
        meta: createRequestMeta(requestScope.workspaceEpoch),
      });
      const projection = unwrapGatewayResult(response);
      if (
        generation !== requestGenerationRef.current
        || !sameProjectionScope(requestScope, scopeRef.current)
      ) return;
      if (response.workspaceEpoch !== undefined && response.workspaceEpoch !== requestScope.workspaceEpoch) {
        throw new Error("workspace changed");
      }
      if (!projectionResponseIsCurrent(
        generation,
        requestGenerationRef.current,
        requestScope,
        scopeRef.current,
        response.workspaceEpoch,
      )) return;
      setState((current) => ({
        ...current,
        projection: current.projection
          && current.projection.roomProfile.revision > projection.roomProfile.revision
          ? { ...projection, roomProfile: current.projection.roomProfile }
          : projection,
        // 到手时刻：主动气泡展示闸门按它判"这份负载是不是这次启动登记之后读回来的"。
        projectionFetchedAt: Date.now(),
        loading: false,
        failure: null,
        profileSaving: profileSavingRef.current,
        profileFailure: profileSavingRef.current ? current.profileFailure : null,
      }));
    };
    void load().catch((error) => {
      if (generation === requestGenerationRef.current) setState((current) => ({
        ...current,
        ...failProjectionRefresh(current, gatewayErrorMessage(error)),
        profileSaving: profileSavingRef.current,
      }));
    });
    return () => {
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [invalidation.revision, invalidation.workspaceEpoch, revision, surface]);

  const boundaryMismatch = Boolean(scopeRef.current
    && invalidation.workspaceEpoch !== null
    && invalidation.workspaceEpoch !== scopeRef.current.workspaceEpoch);
  const value = useMemo(() => ({
    ...state,
    ...(boundaryMismatch ? {
      projection: null,
      loading: true,
      failure: null,
      profileSaving: false,
      profileFailure: null,
    } : {}),
    reload,
    patchRoomProfile,
  }), [boundaryMismatch, patchRoomProfile, reload, state]);
  return (
    <CompanionHomeProjectionContext.Provider value={value}>
      {children}
    </CompanionHomeProjectionContext.Provider>
  );
}

export const useCompanionHomeProjection = () => useContext(CompanionHomeProjectionContext);
