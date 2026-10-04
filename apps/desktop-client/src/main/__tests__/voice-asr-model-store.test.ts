/**
 * 本地语音识别模型的仓库（2026-10）。
 *
 * 这一层最贵的错法是「看起来装好了」：下载写到一半、或者上游给了一份错误页，
 * 而代码只判断"文件存在"——于是界面说「已装在这台设备上」，真正开口说话时才崩。
 * 所以这里钉的是**正式文件存在即完整**：字节数对不上就当没装，半截文件不留。
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceAsrModelStore, voiceAsrModelDirectory, voiceAsrModelSources } from "../voice-asr-model-store";

/** 名字照合同那两份，只把字节数换成用例写得动的量级。 */
const FILES = [
  { name: "model.int8.onnx", expectedBytes: 8 },
  { name: "tokens.txt", expectedBytes: 4 },
] as const;

const SOURCE = "https://example.invalid/models";

function body(bytes: number, chunk = 4): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const size = Math.min(chunk, bytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

function response(bytes: number): Response {
  return new Response(body(bytes));
}

async function listing(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch {
    return [];
  }
}

describe("voice asr model store", () => {
  let directory = "";
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "voice-asr-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("downloads every file into place and then reads as installed", async () => {
    const requested: string[] = [];
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        requested.push(url);
        return response(url.endsWith("model.int8.onnx") ? 8 : 4);
      }),
    });

    expect((await store.state()).status).toBe("absent");
    await store.startDownload();
    await store.whenSettled();

    expect(requested).toEqual([
      `${SOURCE}/model.int8.onnx`,
      `${SOURCE}/tokens.txt`,
    ]);
    expect(await listing(directory)).toEqual(["model.int8.onnx", "tokens.txt"]);
    const ready = await store.state();
    expect(ready.status).toBe("ready");
    expect(ready.receivedBytes).toBe(12);
    expect(ready.installedAt).toEqual(expect.any(String));
    expect(await store.resolveReadablePath("tokens.txt")).toBe(resolve(directory, "tokens.txt"));
  });

  it("refuses to serve anything outside the two known file names", async () => {
    const store = new VoiceAsrModelStore(directory, { files: FILES, sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }], fetchImpl: vi.fn() });
    await writeFile(resolve(directory, "notes.txt"), "私人的东西");
    expect(await store.resolveReadablePath("notes.txt")).toBeNull();
    expect(await store.resolveReadablePath("../../etc/passwd")).toBeNull();
  });

  it("a truncated download leaves nothing behind and reports size_mismatch", async () => {
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      // 上游给了一份错误页：200，但字节数不是模型该有的那么多。
      fetchImpl: vi.fn(async (input: string | URL | Request) => response(String(input).endsWith("model.int8.onnx") ? 3 : 4)),
    });

    await store.startDownload();
    await store.whenSettled();

    const state = await store.state();
    expect(state.status).toBe("error");
    expect(state.failure).toBe("size_mismatch");
    // 半截文件连 `.part` 都不留：它只会占磁盘，不会让人误以为在续传。
    expect(await listing(directory)).toEqual([]);
  });

  it("an unreachable source reports network, and a retry after it works", async () => {
    let offline = true;
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (offline) throw new TypeError("fetch failed");
        return response(url.endsWith("model.int8.onnx") ? 8 : 4);
      }),
    });

    await store.startDownload();
    await store.whenSettled();
    expect((await store.state()).failure).toBe("network");

    offline = false;
    await store.startDownload();
    await store.whenSettled();
    expect((await store.state()).status).toBe("ready");
  });

  it("cancelling mid-download stops it and keeps the formal files absent", async () => {
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      // 只到一半就停住的响应：测试要的是"中止真的能把这一轮打断"。
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(2)); },
      }))),
    });

    await store.startDownload();
    await vi.waitFor(async () => expect((await store.state()).status).toBe("downloading"));
    await store.cancel();

    const state = await store.state();
    expect(state.status).toBe("absent");
    expect(state.failure).toBe("cancelled");
    expect(await listing(directory)).toEqual([]);
  });

  it("starting twice does not restart the download", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => response(String(input).endsWith("model.int8.onnx") ? 8 : 4));
    const store = new VoiceAsrModelStore(directory, { files: FILES, sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }], fetchImpl });

    await Promise.all([store.startDownload(), store.startDownload()]);
    await store.whenSettled();

    expect(fetchImpl).toHaveBeenCalledTimes(2); // 两个文件各一次，没有翻倍重来
  });

  it("removing deletes both files and leaves the machine able to download again", async () => {
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      fetchImpl: vi.fn(async (input: string | URL | Request) => response(String(input).endsWith("model.int8.onnx") ? 8 : 4)),
    });
    await store.startDownload();
    await store.whenSettled();
    expect((await store.state()).status).toBe("ready");

    await store.remove();
    expect(await listing(directory)).toEqual([]);
    const after = await store.state();
    expect(after.status).toBe("absent");
    expect(after.installedBytes).toBe(0);
    expect(after.receivedBytes).toBe(0);
  });

  it("does not count an installed model twice while tokens are still downloading", async () => {
    let tokens: ReadableStreamDefaultController<Uint8Array> | undefined;
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      fetchImpl: vi.fn(async (input: string | URL | Request) => String(input).endsWith("model.int8.onnx")
        ? response(8)
        : new Response(new ReadableStream<Uint8Array>({ start(controller) { tokens = controller; controller.enqueue(new Uint8Array(2)); } }))),
    });
    await store.startDownload();
    await vi.waitFor(async () => {
      const state = await store.state();
      expect(state.installedBytes).toBe(8);
      expect(state.receivedBytes).toBe(10);
      expect(state.activeSource).toBe("测试源");
    });
    tokens!.enqueue(new Uint8Array(2)); tokens!.close();
    await store.whenSettled();
    expect((await store.state()).receivedBytes).toBe(12);
  });

  it("a stalled connection times out and switches sources without being marked cancelled", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith("https://stalled.invalid")) {
        return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      }
      return response(String(input).endsWith("model.int8.onnx") ? 8 : 4);
    });
    const store = new VoiceAsrModelStore(directory, {
      files: FILES, fetchImpl, connectTimeoutMs: 25,
      sources: [{ id: "stalled", name: "卡住的源", baseUrl: "https://stalled.invalid" }, { id: "good", name: "备用源", baseUrl: SOURCE }],
    });
    await store.startDownload(); await store.whenSettled();
    expect((await store.state()).status).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("same-sized corrupted bytes never become a formal model file", async () => {
    const payload = Buffer.alloc(8, 7);
    const store = new VoiceAsrModelStore(directory, {
      files: [{ ...FILES[0], sha256: createHash("sha256").update(payload).digest("hex") }, FILES[1]],
      sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }],
      fetchImpl: vi.fn(async () => response(8)),
    });
    await store.startDownload(); await store.whenSettled();
    expect((await store.state()).failure).toBe("size_mismatch");
    expect(await listing(directory)).toEqual([]);
  });

  it("a write failure reports storage and does not retry the same write from another source", async () => {
    await mkdir(resolve(directory, "model.int8.onnx.part"));
    const fetchImpl = vi.fn(async () => response(8));
    const store = new VoiceAsrModelStore(directory, {
      files: FILES, fetchImpl,
      sources: [{ id: "a", name: "源 A", baseUrl: SOURCE }, { id: "b", name: "源 B", baseUrl: "https://b.invalid" }],
    });
    await store.startDownload(); await store.whenSettled();
    expect((await store.state()).failure).toBe("storage");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("an unusable model directory does not block app startup and remains a storage failure", async () => {
    const blocked = resolve(directory, "blocked");
    await writeFile(blocked, "not a directory");
    const store = new VoiceAsrModelStore(resolve(blocked, "models"), { files: FILES });
    await expect(store.sweepPartialFiles()).resolves.toBeUndefined();
    expect((await store.state()).failure).toBe("storage");
    await store.startDownload(); await store.whenSettled();
    expect((await store.state()).failure).toBe("storage");
  });

  it("startup clears half-written files left by a previous run", async () => {
    await writeFile(resolve(directory, "model.int8.onnx.part"), new Uint8Array(8));
    await writeFile(resolve(directory, "tokens.txt.part"), new Uint8Array(4));

    const store = new VoiceAsrModelStore(directory, { files: FILES, sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }], fetchImpl: vi.fn() });
    await store.sweepPartialFiles();

    expect(await listing(directory)).toEqual([]);
  });

  /**
   * 源列表（2026-10，国内网络是首要约束）。
   *
   * 单一地址把"某个源现在连不上"变成"语音功能坏了"；按序回退把它变成"慢了一点"。
   * 这里钉三件事：**第一个失败会换第二个**、**字节数不对同样算换源**（代理截断会给一个
   * 200 的错误页，只判状态码的话用户会拿到一个装不上的模型）、以及**换源时进度不冲过头**。
   */
  it("falls through to the next source when the first one is unreachable", async () => {
    const tried: string[] = [];
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [
        { id: "a", name: "源 A", baseUrl: "https://a.invalid" },
        { id: "b", name: "源 B", baseUrl: "https://b.invalid" },
      ],
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        tried.push(url);
        if (url.startsWith("https://a.invalid")) throw new TypeError("fetch failed");
        return response(url.endsWith("model.int8.onnx") ? 8 : 4);
      }),
    });

    await store.startDownload();
    await store.whenSettled();

    expect(tried).toEqual([
      "https://a.invalid/model.int8.onnx",
      "https://b.invalid/model.int8.onnx",
      "https://a.invalid/tokens.txt",
      "https://b.invalid/tokens.txt",
    ]);
    expect((await store.state()).status).toBe("ready");
    // 设置页靠这一格告诉用户"会自动换源"。
    expect((await store.state()).sources).toEqual(["源 A", "源 B"]);
  });

  it("a source that answers with the wrong bytes is a failed source, not a finished download", async () => {
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [
        { id: "a", name: "源 A", baseUrl: "https://a.invalid" },
        { id: "b", name: "源 B", baseUrl: "https://b.invalid" },
      ],
      // 源 A 一律回一个 200 的短页面（代理截断的典型形状）。
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return url.startsWith("https://a.invalid") ? response(3) : response(url.endsWith("model.int8.onnx") ? 8 : 4);
      }),
    });

    await store.startDownload();
    await store.whenSettled();

    expect((await store.state()).status).toBe("ready");
    expect(await listing(directory)).toEqual(["model.int8.onnx", "tokens.txt"]);
  });

  it("progress never runs past 100% while switching sources mid-file", async () => {
    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [
        { id: "a", name: "源 A", baseUrl: "https://a.invalid" },
        { id: "b", name: "源 B", baseUrl: "https://b.invalid" },
      ],
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        // 源 A 收了 8 字节再断（那是模型该有的全部字节数）。
        if (url.startsWith("https://a.invalid")) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.error(new TypeError("connection reset"));
            },
          }));
        }
        return response(url.endsWith("model.int8.onnx") ? 8 : 4);
      }),
    });

    await store.startDownload();
    await store.whenSettled();

    // 12 是总量（8 + 4）。源 A 那 8 字节换源时退回去了，于是最终正好 12，不越界。
    const state = await store.state();
    expect(state.status).toBe("ready");
    expect(state.receivedBytes).toBe(12);
    expect(state.expectedBytes).toBe(12);
  });

  it("env sources are an ordered list, and a blank value falls back to the shipped defaults", () => {
    expect(voiceAsrModelSources({}).map((source) => source.id)).toEqual(["modelscope", "hf-mirror", "huggingface"]);
    expect(voiceAsrModelSources({ AILEARN_VOICE_ASR_SOURCE: "  " }).map((source) => source.id)).toEqual(["modelscope", "hf-mirror", "huggingface"]);
    const custom = voiceAsrModelSources({ AILEARN_VOICE_ASR_SOURCE: "https://内网/models , https://备用/models" });
    expect(custom.map((source) => source.baseUrl)).toEqual(["https://内网/models", "https://备用/models"]);
  });

  it("an externally supplied model directory is honoured, otherwise it sits under userData", () => {
    expect(voiceAsrModelDirectory({ env: {}, userDataDir: "/tmp/profile" })).toBe(resolve("/tmp/profile", "voice-models"));
    expect(voiceAsrModelDirectory({ env: { AILEARN_VOICE_ASR_DIR: " /shared/models " }, userDataDir: "/tmp/profile" }))
      .toBe(resolve("/shared/models"));
  });

  it("never reports a file whose size drifted as installed", async () => {
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(4));
    const store = new VoiceAsrModelStore(directory, { files: FILES, sources: [{ id: "test", name: "测试源", baseUrl: SOURCE }], fetchImpl: vi.fn() });
    // 一个被别的程序截短过的 tokens.txt：字节数对不上就当没有，重新下一次。
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(2));
    const state = await store.state();
    expect(state.status).toBe("absent");
    expect(state.files.find((file) => file.name === "tokens.txt")?.bytes).toBe(0);
    expect((await stat(resolve(directory, "tokens.txt"))).size).toBe(2);
  });
});
/**
 * 对着**真的 HTTP 服务器**走一遍下载（2026-10）。
 *
 * 上面那些用例把 `fetch` 换成了替身，于是流式、chunked、`Content-Length` 都没被真的走过。
 * 这里起两个本地服务器：源 A 一律回一个 200 的错误页（代理截断的典型形状），
 * 源 B 回真字节——于是「换源」这件事是被真实的 socket 行为驱动的，不是被断言摆出来的。
 */
describe("voice asr model store against a real server", () => {
  let directory = "";
  const servers: Server[] = [];

  const serve = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "voice-asr-http-")); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(directory, { recursive: true, force: true });
  });

  it("skips a source that answers with an error page and finishes from the next one", async () => {
    const hits: string[] = [];
    const broken = await serve((_request, response) => {
      hits.push("broken");
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>proxy error</html>");
    });
    const good = await serve((request, response) => {
      hits.push(`good:${request.url}`);
      const payload = request.url?.endsWith("tokens.txt") ? Buffer.from("abcd") : Buffer.alloc(8, 7);
      response.writeHead(200, { "content-length": String(payload.length) });
      response.end(payload);
    });

    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [
        { id: "broken", name: "坏源", baseUrl: broken },
        { id: "good", name: "好源", baseUrl: good },
      ],
    });
    await store.startDownload();
    await store.whenSettled();

    expect(hits[0]).toBe("broken");
    expect(hits).toContain("good:/model.int8.onnx");
    expect(hits).toContain("good:/tokens.txt");
    const state = await store.state();
    expect(state.status).toBe("ready");
    expect(state.failure).toBeNull();
    expect(await listing(directory)).toEqual(["model.int8.onnx", "tokens.txt"]);
  });

  /**
   * 全试过才报失败，而且是**在第一个文件上就停**：两个文件都要试一遍源，
   * 等于把「每个源都坏」这件事重复四遍、还多拖两次超时。这里锁的是「尽快说不行」。
   */
  it("reports failure only after every source has been tried", async () => {
    const seen: string[] = [];
    const first = await serve((_request, response) => { seen.push("first"); response.writeHead(503).end(); });
    const second = await serve((_request, response) => { seen.push("second"); response.writeHead(404).end(); });

    const store = new VoiceAsrModelStore(directory, {
      files: FILES,
      sources: [
        { id: "first", name: "源一", baseUrl: first },
        { id: "second", name: "源二", baseUrl: second },
      ],
    });
    await store.startDownload();
    await store.whenSettled();

    expect(seen).toEqual(["first", "second"]);
    expect((await store.state()).failure).toBe("network");
    expect(await listing(directory)).toEqual([]);
  });

  it("switches away from a response whose body stops arriving", async () => {
    const stalled = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(2));
    });
    const good = await serve((request, response) => response.end(Buffer.alloc(request.url?.endsWith("tokens.txt") ? 4 : 8)));
    const store = new VoiceAsrModelStore(directory, {
      files: FILES, idleTimeoutMs: 40,
      sources: [{ id: "stalled", name: "卡住的源", baseUrl: stalled }, { id: "good", name: "备用源", baseUrl: good }],
    });
    await store.startDownload(); await store.whenSettled();
    expect((await store.state()).status).toBe("ready");
  });
});
