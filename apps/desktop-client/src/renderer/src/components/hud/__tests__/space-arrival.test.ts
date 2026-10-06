// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionContextV1, WorkspaceArrivalV1 } from "@astella/shared/desktop-ipc-contracts";
import { acceptVerifiedSpaceArrival, clearSpaceArrival, useSpaceArrival } from "../space-arrival";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
function arrival(id: string, workspaceId = B, epoch = 2): WorkspaceArrivalV1 {
  return { id, requestId: id, userId: USER, deploymentRef: "test-deployment", fromWorkspaceId: workspaceId === B ? A : B, workspaceId, workspaceEpoch: epoch, reason: "switch", acceptedAt: new Date().toISOString() };
}
function session(receipt: WorkspaceArrivalV1): SessionContextV1 {
  return { version: 1, status: "authenticated", user: { userId: USER, email: "test@example.test" }, deploymentRef: "test-deployment", workspace: { version: 1, workspaceId: receipt.workspaceId, name: "同名空间", role: "owner", isPersonal: false, workspaceType: "collaborative", workspaceEpoch: receipt.workspaceEpoch }, workspaceEpoch: receipt.workspaceEpoch, membership: { role: "owner" }, capabilities: null, credentialPersistence: "memory", workspaceArrival: receipt };
}
const identity = { name: "同名空间", role: "owner" as const, isPersonal: false };
beforeEach(() => clearSpaceArrival());
describe("verified space arrival", () => {
  it("waits for matching identity, user, deployment and epoch", () => {
    const receipt = arrival(crypto.randomUUID()), verified = session(receipt);
    if (verified.status !== "authenticated") throw new Error("fixture");
    acceptVerifiedSpaceArrival({ ...verified, workspaceEpoch: 3 }, identity);
    expect(useSpaceArrival.getState().current).toBeNull();
    acceptVerifiedSpaceArrival({ ...verified, deploymentRef: "another" }, identity);
    expect(useSpaceArrival.getState().current).toBeNull();
    acceptVerifiedSpaceArrival(verified, identity);
    expect(useSpaceArrival.getState().current?.workspaceId).toBe(B);
  });
  it("deduplicates reverify and distinguishes equally named spaces during rapid B to A", () => {
    const first = arrival(crypto.randomUUID());
    acceptVerifiedSpaceArrival(session(first), identity);
    const generation = useSpaceArrival.getState().generation;
    acceptVerifiedSpaceArrival(session(first), identity);
    expect(useSpaceArrival.getState().generation).toBe(generation);
    const latest = arrival(crypto.randomUUID(), A, 3);
    acceptVerifiedSpaceArrival(session(latest), identity);
    clearSpaceArrival(generation); // old animation/timeout cannot remove the latest sign.
    expect(useSpaceArrival.getState().current?.workspaceId).toBe(A);
    expect(useSpaceArrival.getState().current?.name).toBe("同名空间");
  });
  it("does not replay an expired receipt or a repeated choice of the same space", () => {
    const expired = { ...arrival(crypto.randomUUID()), acceptedAt: new Date(Date.now() - 31_000).toISOString() };
    acceptVerifiedSpaceArrival(session(expired), identity);
    expect(useSpaceArrival.getState().current).toBeNull();
    const same = { ...arrival(crypto.randomUUID()), fromWorkspaceId: B };
    acceptVerifiedSpaceArrival(session(same), identity);
    expect(useSpaceArrival.getState().current).toBeNull();
  });
});
