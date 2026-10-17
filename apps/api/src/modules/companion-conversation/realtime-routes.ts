import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket as WsSocket } from "ws";
import {
  companionRealtimeClientMessageV1Schema,
  companionRealtimeErrorV1Schema,
  companionRealtimeServerMessageV1Schema,
  type CompanionRealtimeServerMessageV1,
} from "@astella/shared/companion-realtime-contracts";
import {
  companionStreamEventV1Schema,
  createCompanionTurnResponseV1Schema,
} from "@astella/shared/companion-conversation-contracts";
// Realtime sessions use the identity domain's canonical token decoder.
import { decodeToken } from "../identity/session-service.ts";
import { scopeOfSession } from "../../db/client.ts";
import { CompanionConversationError, createCompanionTurn } from "./turn/turn-service.ts";
import { openCompanionEventStream, type CompanionEventStreamHandle } from "./turn/companion-events.ts";
import { isCompanionDialogueEnabled } from "../../config/learning-companion-flags.ts";
import { COMPANION_RATE_LIMITS, companionRateLimit } from "../../lib/companion-rate-limit.ts";
import { buildCompanionErrorBody } from "../../lib/error-envelope.ts";

const MAX_FRAME_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

function send(socket: WsSocket, message: CompanionRealtimeServerMessageV1): boolean {
  if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_FRAME_BYTES) return false;
  const parsed = companionRealtimeServerMessageV1Schema.safeParse(message);
  if (!parsed.success) return false;
  try {
    socket.send(JSON.stringify(parsed.data));
    return true;
  } catch {
    return false;
  }
}

function sendError(socket: WsSocket, code: string, message: string, recoverable: boolean, requestId?: string): void {
  const error = companionRealtimeErrorV1Schema.safeParse({ code, message: message.slice(0, 300), recoverable });
  if (!error.success) return;
  send(socket, { version: 1, type: "error", error: error.data, ...(requestId ? { requestId } : {}) });
}

function parseSseEvent(chunk: string): unknown | null {
  const data = chunk.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  try { return JSON.parse(data) as unknown; }
  catch { return null; }
}

export async function companionRealtimeRoutes(app: FastifyInstance): Promise<void> {
  // Auth is the first protocol frame because browser WebSocket cannot set a Bearer header.
  app.get("/companion/realtime", { websocket: true }, (socket: WsSocket, request) => {
    let session: Awaited<ReturnType<typeof decodeToken>> = null;
    let authenticated = false;
    let closed = false;
    let selectedConversationId: string | null = null;
    let eventStream: CompanionEventStreamHandle | null = null;
    const abortCallbacks = new Set<() => void>();
    let queue = Promise.resolve();

    const authTimer = setTimeout(() => {
      sendError(socket, "AUTH_TIMEOUT", "请重新连接伴星。", true);
      socket.close(4401, "authentication timeout");
    }, AUTH_TIMEOUT_MS);
    const pingTimer = setInterval(() => {
      if (!authenticated || socket.readyState !== socket.OPEN) return;
      try { socket.ping(); } catch { socket.terminate(); }
    }, PING_INTERVAL_MS);
    pingTimer.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      clearInterval(pingTimer);
      eventStream?.close();
      eventStream = null;
      for (const abort of [...abortCallbacks]) abort();
      abortCallbacks.clear();
    };

    const handleMessage = async (data: RawData) => {
      if (closed) return;
      const text = rawText(data);
      if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
        sendError(socket, "FRAME_TOO_LARGE", "消息太大，请缩短后重试。", false);
        socket.close(1009, "frame too large");
        return;
      }
      let raw: unknown;
      try { raw = JSON.parse(text) as unknown; }
      catch {
        sendError(socket, "INVALID_MESSAGE", "消息格式无效。", false);
        return;
      }
      const parsed = companionRealtimeClientMessageV1Schema.safeParse(raw);
      if (!parsed.success) {
        sendError(socket, "INVALID_MESSAGE", "消息格式无效。", false);
        return;
      }
      const message = parsed.data;

      if (!authenticated) {
        if (message.type !== "auth") {
          sendError(socket, "AUTH_REQUIRED", "请先登录后再连接。", false);
          socket.close(4401, "authentication required");
          return;
        }
        const decoded = await decodeToken(message.token);
        if (!decoded) {
          sendError(socket, "UNAUTHORIZED", "登录已失效，请重新登录。", false);
          socket.close(4401, "unauthorized");
          return;
        }
        if (!isCompanionDialogueEnabled()) {
          sendError(socket, "NOT_FOUND", "伴星对话暂不可用。", false);
          socket.close(1008, "companion dialogue disabled");
          return;
        }
        session = decoded;
        authenticated = true;
        clearTimeout(authTimer);
        send(socket, { version: 1, type: "auth.ok" });
        return;
      }

      if (message.type === "auth") {
        sendError(socket, "ALREADY_AUTHENTICATED", "连接已完成登录。", false);
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "subscribe") {
        if (!session) return;
        eventStream?.close();
        eventStream = null;
        selectedConversationId = message.conversationId;
        let abortStream: (() => void) | null = null;
        let newStream: CompanionEventStreamHandle | null = null;
        const opened = await openCompanionEventStream({
          ...scopeOfSession(session),
          userId: session.userId,
          conversationId: message.conversationId,
          afterRaw: String(message.after),
          lastEventId: null,
          writer: {
            write: (chunk) => {
              if (closed || socket.readyState !== socket.OPEN) return false;
              if (socket.bufferedAmount > MAX_FRAME_BYTES) {
                socket.close(1013, "backpressure");
                return false;
              }
              const rawEvent = parseSseEvent(chunk);
              if (rawEvent === null) return true; // SSE heartbeat comment
              const event = companionStreamEventV1Schema.safeParse(rawEvent);
              if (!event.success) return true;
              const sent = send(socket, { version: 1, type: "event", event: event.data });
              if (!sent) socket.close(1013, "event delivery failed");
              return sent;
            },
            onAbort: (callback) => {
              abortStream = callback;
              abortCallbacks.add(callback);
            },
            close: () => {
              if (abortStream) abortCallbacks.delete(abortStream);
              if (eventStream === newStream) eventStream = null;
            },
          },
        });
        if (opened.statusCode !== 200) {
          selectedConversationId = null;
          sendError(socket, opened.error.code, opened.error.message, opened.statusCode >= 409);
          return;
        }
        newStream = opened.stream;
        eventStream = newStream;
        send(socket, { version: 1, type: "subscribed", conversationId: message.conversationId, cursor: message.after });
        newStream.start();
        return;
      }

      if (message.type === "turn.submit") {
        if (!session || !selectedConversationId || message.conversationId !== selectedConversationId) {
          send(socket, {
            version: 1,
            type: "turn.result",
            requestId: message.requestId,
            ok: false,
            error: { code: "NOT_SUBSCRIBED", message: "请重新连接对话后再发送。", recoverable: true, statusCode: 409 },
          });
          return;
        }
        if (message.requestId !== message.body.clientMessageId) {
          // The request id doubles as the turn's idempotency key, so a mismatch
          // is a broken client, not a user-level failure. It used to answer
          // `turn.result` and nothing else: a client that only listens for
          // `event` frames saw a successful submit and then silence, which
          // looks exactly like a dead realtime channel (2026-10-17 diagnosis).
          send(socket, {
            version: 1,
            type: "turn.result",
            requestId: message.requestId,
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: "消息编号必须与本次请求编号一致。",
              recoverable: false,
              statusCode: 400,
            },
          });
          return;
        }
        const minute = await companionRateLimit({
          key: `${session.workspaceId}:${session.userId}:write:turn`,
          ...COMPANION_RATE_LIMITS.createTurnPerMinute,
        });
        const hour = minute.allowed ? await companionRateLimit({
          key: `${session.workspaceId}:${session.userId}:write:turn:hour`,
          ...COMPANION_RATE_LIMITS.createTurnPerHour,
        }) : minute;
        if (!minute.allowed || !hour.allowed) {
          const retryAfterSeconds = !minute.allowed ? minute.retryAfterSeconds : hour.retryAfterSeconds;
          send(socket, {
            version: 1,
            type: "turn.result",
            requestId: message.requestId,
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: `操作太频繁，请在 ${retryAfterSeconds} 秒后重试。`,
              recoverable: true,
              statusCode: 429,
            },
          });
          return;
        }
        try {
          const accepted = await createCompanionTurn({
            ...scopeOfSession(session),
            userId: session.userId,
            conversationId: message.conversationId,
            idempotencyKey: message.body.clientMessageId,
            body: message.body,
          });
          const result = createCompanionTurnResponseV1Schema.parse(accepted.body);
          send(socket, { version: 1, type: "turn.result", requestId: message.requestId, ok: true, result });
        } catch (error) {
          if (error instanceof CompanionConversationError) {
            const envelope = buildCompanionErrorBody(error, {
              recoverable: error.statusCode >= 500 || error.statusCode === 409,
              requestId: request.id,
            });
            send(socket, {
              version: 1,
              type: "turn.result",
              requestId: message.requestId,
              ok: false,
              error: {
                code: String(envelope.error ?? "REQUEST_FAILED"),
                message: String(envelope.message ?? "这一轮没有发送成功。"),
                recoverable: Boolean(envelope.recoverable),
                statusCode: error.statusCode,
              },
            });
            return;
          }
          request.log.error({ err: error }, "companion websocket turn submit failed");
          send(socket, {
            version: 1,
            type: "turn.result",
            requestId: message.requestId,
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "发送没有完成，请稍后重试。", recoverable: true, statusCode: 500 },
          });
        }
      }
    };

    // Attach synchronously before authentication/database work so no client frame is lost.
    socket.on("message", (data: RawData) => {
      queue = queue.then(() => handleMessage(data)).catch((error: unknown) => {
        request.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "companion websocket message failed");
        sendError(socket, "INTERNAL_ERROR", "连接暂时不可用，请重试。", true);
      });
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
