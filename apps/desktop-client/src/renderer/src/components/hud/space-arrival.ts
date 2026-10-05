import { create } from "zustand";
import type { SessionContextV1, WorkspaceArrivalV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { SpaceIdentity } from "../../app/room-store";

export type VerifiedSpaceArrival = WorkspaceArrivalV1 & { readonly name: string; readonly role: "owner" | "member"; readonly isPersonal: boolean; readonly generation: number };
const delivered = new Set<string>();
export const useSpaceArrival = create<{ current: VerifiedSpaceArrival | null; generation: number }>(() => ({ current: null, generation: 0 }));

/** Only the verified access boundary can turn an accepted switch into an arrival. */
export function acceptVerifiedSpaceArrival(session: SessionContextV1, identity: SpaceIdentity): void {
  if (session.status !== "authenticated" || !session.workspace) { clearSpaceArrival(); return; }
  const receipt = session.workspaceArrival;
  const current = useSpaceArrival.getState().current;
  if (current && (current.userId !== session.user.userId || current.deploymentRef !== session.deploymentRef
    || current.workspaceId !== session.workspace.workspaceId || current.workspaceEpoch !== session.workspaceEpoch)) clearSpaceArrival();
  if (!receipt || delivered.has(receipt.id) || receipt.workspaceId !== session.workspace.workspaceId
    || receipt.userId !== session.user.userId || receipt.deploymentRef !== session.deploymentRef
    || receipt.workspaceEpoch !== session.workspaceEpoch || Date.now() - Date.parse(receipt.acceptedAt) > 30_000
    || receipt.fromWorkspaceId === receipt.workspaceId) return;
  delivered.add(receipt.id);
  if (delivered.size > 64) delivered.delete(delivered.values().next().value!);
  const generation = useSpaceArrival.getState().generation + 1;
  useSpaceArrival.setState({ generation, current: { ...receipt, name: identity.name, role: identity.role, isPersonal: identity.isPersonal, generation } });
}
export function clearSpaceArrival(generation?: number): void {
  const state = useSpaceArrival.getState();
  if (generation !== undefined && generation !== state.generation) return;
  if (state.current) useSpaceArrival.setState({ current: null, generation: state.generation + 1 });
}
