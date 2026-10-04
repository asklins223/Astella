/**
 * `device/asr/<file>` 那条路由（2026-10）。
 *
 * 它是「本机磁盘」与「页面可读」之间唯一的一道闸，所以对着三件事测：
 * **只认那两个文件名**、**Range/HEAD 与普通静态资源同一套语义**、
 * **CORS 只认应用自己的页面**。第三条最容易在一年后被顺手改成 `*`。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceAsrModelResponder, voiceAsrModelMountUrl } from "../voice-asr-model-route";
import { VoiceAsrModelStore } from "../voice-asr-model-store";

const FILES = [
  { name: "model.int8.onnx", expectedBytes: 6 },
  { name: "tokens.txt", expectedBytes: 3 },
] as const;

const APP_ORIGIN = "ailearn-app://bundle";

function store(directory: string) {
  return new VoiceAsrModelStore(directory, { files: FILES, sources: [{ id: "test", name: "测试源", baseUrl: "https://example.invalid" }], fetchImpl: vi.fn() });
}

function responder(model: VoiceAsrModelStore) {
  return createVoiceAsrModelResponder(model);
}

function request(path: string, init: RequestInit = {}, base = APP_ORIGIN) {
  return new Request(new URL(`device/asr/${path}`, `${base}/`), init);
}

describe("device/asr route", () => {
  let directory = "";
  let model: VoiceAsrModelStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "voice-route-"));
    model = store(directory);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("serves an installed model file and 404s everything else", async () => {
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(3));
    await writeFile(resolve(directory, "notes.txt"), "私人的东西");
    const respond = responder(model);

    const ok = await respond("tokens.txt", request("tokens.txt"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toHaveLength(3);
    expect(ok.headers.get("Content-Type")).toContain("text/plain");

    expect((await respond("notes.txt", request("notes.txt"))).status).toBe(404);
    // 前缀还在、后面换成别的东西：清一清这个 case，因为它是最像漏洞的那一种。
    expect((await respond("notes.txt", request("notes.txt?x=1"))).status).toBe(404);
    expect((await respond("", request(""))).status).toBe(404);
  });

  it("404s while the model is only half downloaded", async () => {
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(2));
    expect((await responder(model)("tokens.txt", request("tokens.txt"))).status).toBe(404);
  });

  it("HEAD reports the size without opening a body; GET honours Range", async () => {
    await writeFile(resolve(directory, "model.int8.onnx"), new Uint8Array(6));
    const respond = responder(model);

    const head = await respond("model.int8.onnx", request("model.int8.onnx", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("6");
    expect(head.body).toBeNull();

    const ranged = await respond("model.int8.onnx", request("model.int8.onnx", { headers: { range: "bytes=0-2" } }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 0-2/6");
    expect(new Uint8Array(await ranged.arrayBuffer())).toHaveLength(3);
  });

  it("never hands out a CORS grant: same-origin is the only way this route is ever used", async () => {
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(3));
    const response = await responder(model)(
      "tokens.txt",
      request("tokens.txt", { headers: { origin: "https://example.com" } }, "http://localhost:5173"),
    );
    // 内容照发（同源那条路），但**没有** ACAO：别的 origin 的页面拿不到可读的响应。
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  /**
   * 挂载点：两种形态都必须**同源**，且打包那条有个只在打包时才犯的错。
   *
   * `ailearn-app` 是 Electron 注册出来的标准 scheme，可 Node 的 URL 实现不知道，
   * `new URL('ailearn-app://bundle/index.html').origin` 是 `"null"`。用 origin 当基底
   * 时开发形态没事（`http://localhost:5173` 的 origin 是对的），打包形态直接抛
   * `Invalid URL`——而打包形态恰恰是本地 `npm run dev` **测不到**的那一种。
   */
  it("挂载点：开发形态指向开发服务器，打包形态指向页面自己的 bundle host", () => {
    expect(voiceAsrModelMountUrl("http://localhost:5173/", "http://localhost:5173")).toBe("http://localhost:5173/device/asr/");
    expect(voiceAsrModelMountUrl("ailearn-app://bundle/index.html")).toBe("ailearn-app://bundle/device/asr/");
    // 自证：这正是那条不能用的写法。
    expect(new URL("ailearn-app://bundle/index.html").origin).toBe("null");
  });

  it("rejects anything but GET/HEAD", async () => {
    await writeFile(resolve(directory, "tokens.txt"), new Uint8Array(3));
    const response = await responder(model)("tokens.txt", request("tokens.txt", { method: "DELETE" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
});
