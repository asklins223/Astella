import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { edgeTtsSynthesize, edgeTtsSynthesizeStream } from "../edge-tts.ts";

const originalEnv = {
  EDGE_TTS_BASE_URL: process.env.EDGE_TTS_BASE_URL,
  EDGE_TTS_PORT: process.env.EDGE_TTS_PORT,
  EDGE_TTS_AUTH_TOKEN: process.env.EDGE_TTS_AUTH_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("宿主 API 的非流式与流式兜底均访问回环映射，携带 token 与语音参数", async () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    assert.equal(request.headers["x-edge-tts-token"], "host-test-token");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      model: "edge-tts", input: "你好", voice: "zh-CN-XiaoxiaoNeural", rate: "+10%",
    });
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end(audio);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    delete process.env.EDGE_TTS_BASE_URL;
    process.env.EDGE_TTS_PORT = String(address.port);
    process.env.EDGE_TTS_AUTH_TOKEN = "host-test-token";

    const bytes = await edgeTtsSynthesize("你好", "zh-CN-XiaoxiaoNeural", { rate: "+10%" });
    assert.deepEqual(bytes.audio, audio);
    const streamed = await edgeTtsSynthesizeStream("你好", "zh-CN-XiaoxiaoNeural", { rate: "+10%" });
    assert.deepEqual(new Uint8Array(await new Response(streamed.stream).arrayBuffer()), audio);
    assert.deepEqual(paths, ["/v1/audio/speech", "/v1/audio/speech/stream"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("显式地址与 Compose 地址优先，空环境值仍使用本机默认端口", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/mpeg" } });
  };
  process.env.EDGE_TTS_BASE_URL = "http://edge-tts:8080/";
  await edgeTtsSynthesize("你好", "v", { fetchImpl });
  const stream = await edgeTtsSynthesizeStream("你好", "v", { baseUrl: "http://custom:9090/", fetchImpl });
  await stream.stream.cancel();
  process.env.EDGE_TTS_BASE_URL = "";
  delete process.env.EDGE_TTS_PORT;
  await edgeTtsSynthesize("你好", "v", { fetchImpl });
  assert.deepEqual(urls, [
    "http://edge-tts:8080/v1/audio/speech",
    "http://custom:9090/v1/audio/speech/stream",
    "http://127.0.0.1:8088/v1/audio/speech",
  ]);
});
