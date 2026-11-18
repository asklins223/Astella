import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { countModelTextTokens } from "../model-tokenizers.ts";
import { OpenCodeGoProvider } from "../providers/opencode-go.ts";
import { governContextPressure, AIContextOverflowError } from "../context-governor.ts";
import { measureChatRequest } from "@astella/agent-core";

test("官方tokenizer数据的版本与摘要固定，不加载远程代码", async () => {
  const data=await readFile(new URL("../model-tokenizers/deepseek-v4.1-flash/tokenizer.json",import.meta.url));
  assert.equal(createHash("sha256").update(data).digest("hex"),"c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b");
});

test("CommonJS production bundle resolves the copied tokenizer data", async () => {
  const root = await mkdtemp(join(tmpdir(), "astella-tokenizer-bundle-"));
  try {
    const dist = join(root, "dist");
    await mkdir(dist);
    await symlink(fileURLToPath(new URL("../../", import.meta.url)), join(root, "src"), "dir");
    const bundle = join(dist, "tokenizer.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../model-tokenizers.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      'require(process.argv[1]).countModelTextTokens("deepseek-v4.1-flash", " q q").then(n => console.log(n)).catch(e => { console.error(e); process.exitCode = 1; })',
      bundle,
    ], { cwd: tmpdir() });
    assert.equal(Number(stdout.trim()), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("真实API已校准的ASCII分隔词计数正确，超过模型窗口也不会裁剪计数", async () => {
  assert.equal(await countModelTextTokens("deepseek-v4.1-flash"," q".repeat(20000)),20000);
  assert.equal(await countModelTextTokens("deepseek-v4.1-flash"," q".repeat(1060000)),1060000);
  assert.equal(await countModelTextTokens("unknown-model"," q"),null);
});

test("真实治理入口使用模型tokenizer，920k输入在常规输出预留下发出前被拦", async () => {
  const provider=new OpenCodeGoProvider({apiKey:"test",baseUrl:"https://opencode.ai/zen/go/v1",model:"deepseek-v4.1-flash",
    modelProfile:{contextWindowTokens:1000000,maxOutputTokens:131072}});
  const messages=[{role:"user" as const,content:" q".repeat(920000)}];
  await assert.rejects(governContextPressure({provider,operation:"test",requestedOutputTokens:131072,
    measure:ports=>measureChatRequest(messages,{maxTokens:131072},ports)}),
    (error:unknown)=>error instanceof AIContextOverflowError && error.receipt.measurement.method==="tokenizer"
      && error.receipt.measurement.inputTokens>=920000);
});
