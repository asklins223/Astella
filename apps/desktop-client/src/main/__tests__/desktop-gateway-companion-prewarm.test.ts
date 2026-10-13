import { describe, expect, it, vi } from "vitest";
import { sendCompanionTurn } from "../desktop-gateway-ns-companion";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const TURN_RESULT = {
  version: 1,
  conversationId: CONVERSATION_ID,
  clientMessageId: "33333333-3333-4333-8333-333333333333",
  userMessageId: "44444444-4444-4444-8444-444444444444",
  runId: "55555555-5555-4555-8555-555555555555",
  generation: 1,
  status: "accepted",
  eventCursor: 1,
};

function gateway(calls: Array<{ path: string; init: RequestInit }>) {
  return {
    ensureConnected: vi.fn(async () => undefined),
    request: vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      return { status: 200, body: path === "/voice/prewarm" ? { version: 1, prewarmed: true } : TURN_RESULT };
    }),
  };
}

function turnRequest(voiceOutput: boolean) {
  return {
    version: 1,
    conversationId: CONVERSATION_ID,
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
    ...(voiceOutput ? { voiceOutput: true } : {}),
    turn: { version: 1 },
  } as never;
}

describe("companion Qwen connection prewarm", () => {
  it("starts the handshake alongside an opted-in turn without forwarding the hint in its body", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    await sendCompanionTurn(gateway(calls) as never, turnRequest(true));

    expect(calls.map(({ path }) => path)).toEqual([
      "/voice/prewarm",
      `/companion/conversations/${CONVERSATION_ID}/turns`,
    ]);
    expect(calls[0]?.init.body).toBe("{}");
    expect(JSON.parse(calls[1]!.init.body as string)).not.toHaveProperty("voiceOutput");
  });

  it("does not open a speculative connection for a silent turn", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    await sendCompanionTurn(gateway(calls) as never, turnRequest(false));
    expect(calls.map(({ path }) => path)).toEqual([`/companion/conversations/${CONVERSATION_ID}/turns`]);
  });
});
