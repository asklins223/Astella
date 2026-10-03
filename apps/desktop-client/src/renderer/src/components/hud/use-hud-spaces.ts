import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionContextV1, WorkspaceSummaryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { markSpaceUsed, readSpaceRecents } from "../../app/space-recents";
import { readAuthenticatedSession } from "../../app/surface-session";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import { requestSpaceSwitchReceipt, SPACE_MENU_REFRESH_EVENT } from "./space-menu-events";

type SpaceState = {
  session: SessionContextV1 | null;
  workspaces: readonly WorkspaceSummaryV1[];
  failure: string | null;
  loading: boolean;
  ready: boolean;
};
type SpaceMessage = { text: string; tone: "success" | "error" };
export type SpaceConfirmation = { kind: "switch"; workspace: WorkspaceSummaryV1 } | { kind: "create"; name: string };

/** The bubble reads facts and commits through the existing gateway and gate boundary. */
export function useHudSpaces(onSwitched?: (name: string) => void) {
  const epochRef = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const lock = useRef<string | null>(null);
  const refreshPending = useRef(false);
  const [state, setState] = useState<SpaceState>({ session: null, workspaces: [], failure: null, loading: true, ready: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<SpaceMessage | null>(null);
  const [confirmation, setConfirmation] = useState<SpaceConfirmation | null>(null);
  const [recents, setRecents] = useState(() => readSpaceRecents());
  const [joinedId, setJoinedId] = useState<string | null>(null);
  const activeRunId = useRoomStore(store => store.activeRunId);

  const load = useCallback(async () => {
    if (lock.current) { refreshPending.current = true; return; }
    const revision = ++generation.current;
    setState(current => ({ ...current, loading: true, failure: null }));
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.workspace.list({ meta: createRequestMeta(session.workspaceEpoch) });
      const list = unwrapGatewayResult(response);
      if (!mounted.current || revision !== generation.current) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setState({ session, workspaces: list.workspaces, failure: null, loading: false, ready: true });
    } catch (error) {
      if (!mounted.current || revision !== generation.current) return;
      // Keep the verified current space and readable rows through a failed background refresh.
      setState(current => ({ ...current, failure: gatewayErrorMessage(error), loading: false }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { void load(); };
    window.addEventListener(SPACE_MENU_REFRESH_EVENT, refresh);
    return () => { mounted.current = false; generation.current++; window.removeEventListener(SPACE_MENU_REFRESH_EVENT, refresh); };
  }, [load]);

  const start = (key: string) => {
    if (lock.current || !state.ready) return false;
    lock.current = key; generation.current++;
    setBusy(key); setMessage(null); setConfirmation(null);
    setState(current => ({ ...current, loading: false }));
    return true;
  };
  const finish = () => {
    lock.current = null;
    if (!mounted.current) return;
    setBusy(null);
    if (refreshPending.current) { refreshPending.current = false; void load(); }
  };
  const completeSwitch = (name: string, id: string) => {
    const nextRecents = markSpaceUsed(id);
    if (mounted.current) setRecents(nextRecents);
    if (onSwitched) onSwitched(name);
    else { requestSpaceSwitchReceipt(name); publishGateInvalidation("stale_workspace"); }
  };

  const enter = async (workspace: WorkspaceSummaryV1, confirmed = false) => {
    if (lock.current || workspace.workspaceId === state.session?.workspace?.workspaceId) return;
    if (activeRunId && !confirmed) { setConfirmation({ kind: "switch", workspace }); return; }
    if (!start(workspace.workspaceId)) return;
    try {
      const response = await window.ailearn.workspace.switch({ meta: createRequestMeta(epochRef.current), workspaceId: workspace.workspaceId });
      unwrapGatewayResult(response);
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      completeSwitch(workspace.name, workspace.workspaceId);
    } catch (error) {
      if (mounted.current) setMessage({ text: gatewayErrorMessage(error), tone: "error" });
    } finally { finish(); }
  };

  const create = async (rawName: string, confirmed = false) => {
    const name = rawName.trim();
    if (!name || lock.current) return;
    if (activeRunId && !confirmed) { setConfirmation({ kind: "create", name }); return; }
    if (!start("create")) return;
    try {
      const response = await window.ailearn.workspace.create({ meta: createRequestMeta(epochRef.current), name });
      const created = unwrapGatewayResult(response);
      const nextRecents = markSpaceUsed(created.workspaceId);
      if (mounted.current) setRecents(nextRecents);
      // Main creates AND enters: the existing gate invalidation remains mandatory.
      requestSpaceSwitchReceipt(name);
      publishGateInvalidation("stale_workspace");
    } catch (error) {
      if (mounted.current) setMessage({ text: gatewayErrorMessage(error), tone: "error" });
    } finally { finish(); }
  };

  const join = async (rawCode: string): Promise<boolean> => {
    const inviteToken = rawCode.trim();
    if (!inviteToken || !start("join")) return false;
    const knownIds = new Set(state.workspaces.map(workspace => workspace.workspaceId));
    let committed = false;
    try {
      const response = await window.ailearn.auth.joinWorkspace({ meta: createRequestMeta(epochRef.current), inviteToken });
      unwrapGatewayResult(response); committed = true;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const listed = await window.ailearn.workspace.list({ meta: createRequestMeta(epochRef.current) });
      const list = unwrapGatewayResult(listed);
      if (listed.workspaceEpoch) epochRef.current = listed.workspaceEpoch;
      if (!mounted.current) return true;
      const joined = list.workspaces.find(workspace => !knownIds.has(workspace.workspaceId));
      setState(current => ({ ...current, workspaces: list.workspaces, failure: null, loading: false, ready: true }));
      setJoinedId(joined?.workspaceId ?? null);
      setMessage({ text: joined ? `已加入「${joined.name}」，点击它即可进入。` : "已加入学习空间，可以在列表中选择它。", tone: "success" });
    } catch (error) {
      if (mounted.current) {
        if (committed) {
          setMessage({ text: "已加入学习空间，列表暂时没有更新。刷新后即可选择它。", tone: "success" });
          setState(current => ({ ...current, failure: gatewayErrorMessage(error), loading: false }));
        } else setMessage({ text: gatewayErrorMessage(error), tone: "error" });
      }
    } finally { finish(); }
    return committed;
  };

  return { state, busy, message, recents, joinedId, confirmation, load, enter, create, join,
    clearMessage: () => setMessage(null), cancelConfirmation: () => setConfirmation(null),
    confirm: () => {
      if (confirmation?.kind === "switch") void enter(confirmation.workspace, true);
      if (confirmation?.kind === "create") void create(confirmation.name, true);
    },
  };
}
