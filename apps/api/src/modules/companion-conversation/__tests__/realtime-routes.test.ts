import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { companionRealtimeRoutes } from "../realtime-routes.ts";

test("companion realtime upgrades and rejects commands before first-frame auth", async () => {
  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  await app.register(companionRealtimeRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/companion/realtime`);
  try {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket auth response timed out")), 2_000);
      socket.on("open", () => socket.send(JSON.stringify({
        version: 1,
        type: "subscribe",
        conversationId: "00000000-0000-4000-8000-000000000001",
        after: 0,
      })));
      socket.on("message", (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      socket.on("error", reject);
    });
    assert.equal(response.type, "error");
    assert.deepEqual(response.error, {
      code: "AUTH_REQUIRED",
      message: "请先登录后再连接。",
      recoverable: false,
    });
  } finally {
    socket.terminate();
    await app.close();
  }
});
