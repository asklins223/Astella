/**
 * SSE 写安全工具。
 *
 * 解决 SSE 端点偶发 500：
 * - 客户端断开后 `raw.write()` 可能抛 `ERR_STREAM_WRITE_AFTER_END` / `EPIPE`；
 * - 统一在这里检查 `writableEnded/destroyed` 并 try/catch，任何一次写失败都
 *   只返回 false，由调用方安静关闭，绝不向上冒泡为 HTTP 500。`write()` 返回
 *   false 时也必须向上传播背压信号；否则调用方会继续推进 cursor，客户端重连
 *   时可能看不到尚未真正排空的事件。
 */

export function safeSseWrite(
  raw: {
    writableEnded: boolean;
    destroyed: boolean;
    write(chunk: string): boolean;
  },
  chunk: string,
): boolean {
  if (raw.writableEnded || raw.destroyed) return false;
  try {
    return raw.write(chunk);
  } catch {
    return false;
  }
}

type EventedWritable = {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: string): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  removeListener(event: "drain" | "close" | "error", listener: () => void): unknown;
};

/**
 * 写入一块数据并在 high-water mark 命中时等待 drain。
 *
 * SSE 事件可以在背压时关闭并靠 cursor 重连恢复；NDJSON 导出没有 cursor，
 * 因此必须等待 drain，否则会得到一个没有 footer 的半截导出。
 */
export async function safeWriteWithBackpressure(
  raw: EventedWritable,
  chunk: string,
): Promise<boolean> {
  if (raw.writableEnded || raw.destroyed) return false;
  let accepted: boolean;
  try {
    accepted = raw.write(chunk);
  } catch {
    return false;
  }
  if (accepted) return true;
  if (raw.writableEnded || raw.destroyed) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      raw.removeListener("drain", onDrain);
      raw.removeListener("close", onClose);
      raw.removeListener("error", onError);
      resolve(ok);
    };
    const onDrain = () => finish(!raw.writableEnded && !raw.destroyed);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    raw.once("drain", onDrain);
    raw.once("close", onClose);
    raw.once("error", onError);
    if (raw.writableEnded || raw.destroyed) finish(false);
  });
}

/**
 * SSE 响应的开头：hijack → 存活检查 → 写响应头。
 *
 * ## 为什么要把这一段收在一处
 *
 * 伴星的两个 SSE 端点（`companion-conversation` 的对话流、`companion-shell` 的账号流）
 * 各自抄了一份，抄的时候**各自漂了一点**（见下）。收在一处之后，
 * 响应头这个"客户端看得见、但没人会盯"的地方就只有一个改法。
 *
 * ## 收在一处的部分，和刻意留在外面的部分
 *
 * 收在这里：hijack、writableEnded/destroyed 的早退、响应头本身。
 * 留在调用方：**错误处理**。两边的 catch 语义本来就不一样——
 * conversation 侧记一条 warn 并安静收流，shell 侧把 raw socket 销毁掉。
 * 那是两个端点各自的处置，不该被统一。
 *
 * ## `retry` 属于 SSE 事件流，不属于 HTTP 头
 *
 * 抄写时 shell 侧把 `retry: "1500"` 放进了 `writeHead` 的响应头里，而
 * conversation 侧明确写了注释说它**不能**放这儿（§5.3：规范要求 retry 是
 * 事件流里的一个 field，浏览器不会读 HTTP 头里这个同名头）。
 *
 * 所以收敛之后：**HTTP 头里不再有 retry**，由调用方在 start 之前用
 * `safeSseWrite(raw, "retry: 1500\n\n")` 发一条真正的 SSE 指令。
 * 这是本次唯一一处**行为变化**——shell 侧此前那个头是无效的，
 * 去掉它不改变任何客户端可见的行为，只是不再发一个没人读的头。
 */
export const SSE_RECONNECT_INSTRUCTION = "retry: 1500\n\n";

/** 写 SSE 响应头。`retry` 不在这里——理由见文件头。 */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform：中间的代理不得缓冲或改写，否则事件流会被攒住
  "Cache-Control": "no-store, no-transform",
  // 关掉 nginx 的响应缓冲，否则 SSE 会被攒到代理缓冲区里，实时性全丢
  "X-Accel-Buffering": "no",
  "Connection": "keep-alive",
});

/** hijack 之后、写响应头之前，连接是不是已经死了。 */
export function sseConnectionDead(raw: { writableEnded: boolean; destroyed: boolean }): boolean {
  return raw.writableEnded || raw.destroyed;
}

/**
 * 抢占 reply 并写好 SSE 响应头。
 *
 * 返回 `false` 表示**连接已经不可用**（调用方应当安静收流并直接 return）；
 * 写头本身抛错时返回 `false` 同样成立——那时响应已经不可控，
 * 继续往里写只会把异常冒泡成一次 500。
 */
export function beginSseResponse(reply: {
  hijack(): unknown;
  raw: { writableEnded: boolean; destroyed: boolean; writeHead(status: number, headers: Record<string, string>): void };
}): boolean {
  reply.hijack();
  if (sseConnectionDead(reply.raw)) return false;
  try {
    reply.raw.writeHead(200, { ...SSE_RESPONSE_HEADERS });
  } catch {
    return false;
  }
  return true;
}
