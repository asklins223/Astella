import { COMPANION_IMAGE_ASSET_LABEL } from "../../lib/image-asset-reference.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { packCompanionImages, parseCompanionImageBatch, prepareCompanionImageBatches, hedgeCompanionBatch } from "../agent/companion-image-batches.ts";

const image = (id: string, bytes = 1) => ({ assetId: id, bytes,
  part: { type: "image_url" as const, image_url: { url: "data:image/png;base64," + Buffer.alloc(bytes, 1).toString("base64"), detail: "high" as const } } });
test("12张按原顺序拆批，张数和字节两个限制都不遗漏附件", () => {
  const images = Array.from({ length: 12 }, (_, i) => image(String(i), 4 * 1024 * 1024));
  const batches = packCompanionImages(images);
  assert.deepEqual(batches.map(batch => batch.length), [3,3,3,3]);
  assert.deepEqual(batches.flat().map(i => i.assetId), images.map(i => i.assetId));
  assert.deepEqual(packCompanionImages(Array.from({length:12},(_,i)=>image(String(i)))).map(b=>b.length),[4,4,4]);
});
test("批次必须覆盖真实身份，未知、重复或缺图的结果不能冒充完成", () => {
  for (const ids of [["a"], ["a","a"], ["a","c"]]) assert.throws(() => parseCompanionImageBatch(JSON.stringify({images:ids.map(assetId=>({assetId,description:"x"}))}),["a","b"]));
});
test("同一个配置模型读取每批原图，跨步骤复用真实结果且不重复调用", async () => {
  const images = Array.from({length:12},(_,i)=>image(String(i)));
  const messages = [{role:"user" as const,content:images.flatMap(i=>[{type:"text" as const,text:COMPANION_IMAGE_ASSET_LABEL+JSON.stringify({assetId:i.assetId})},i.part])}];
  let calls=0;const cache=new Map();
  const runBatch=async ({messages}:Parameters<Parameters<typeof prepareCompanionImageBatches>[0]["runBatch"]>[0])=>{
    calls++; const parts=messages[1]!.content;assert.ok(Array.isArray(parts));
    assert.equal(parts.filter(p=>p.type==="image_url").length,4);
    const ids=parts.filter(p=>p.type==="text"&&p.text.startsWith('{"assetId"')).map(p=>JSON.parse((p as {text:string}).text).assetId);
    return JSON.stringify({images:ids.map(assetId=>({assetId,description:"实际画面",uncertainties:[]}))});
  };
  const input={messages,userText:"比较所有图片",signal:new AbortController().signal,cache,runBatch};
  const first=await prepareCompanionImageBatches(input),second=await prepareCompanionImageBatches(input);
  assert.equal(calls,3);assert.deepEqual(first,second);
  assert.ok(!JSON.stringify(first).includes('"type":"image_url"'));
  assert.equal(first.filter(m=>m.hostObservation).length,4);
});

test("慢批次在等待窗口后并行第二路，先成功的胜出并取消另一路", async () => {
  let calls = 0;
  const aborted: number[] = [];
  const started = Date.now();
  const value = await hedgeCompanionBatch(async signal => {
    calls += 1;
    const attempt = calls;
    signal.addEventListener("abort", () => { aborted.push(attempt); }, { once: true });
    if (attempt === 1) { await new Promise(resolve => setTimeout(resolve, 300)); return "slow"; }
    await new Promise(resolve => setTimeout(resolve, 20));
    return "fast";
  }, { signal: new AbortController().signal, delayMs: 30 });
  assert.equal(value, "fast");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 250, "第二路应在慢批次返回前胜出");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(aborted.includes(1), "输掉的那一路被取消");
});

test("正常批次不额外发请求", async () => {
  let calls = 0;
  const value = await hedgeCompanionBatch(async () => { calls += 1; return "ok"; },
    { signal: new AbortController().signal, delayMs: 50 });
  assert.equal(value, "ok");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 1);
});

test("a failed primary does not cancel an in-flight hedge that can still succeed", async () => {
  let calls = 0;
  let failPrimary!: (reason: Error) => void;
  let completeHedge!: (value: string) => void;
  let hedgeSignal!: AbortSignal;
  let markHedgeStarted!: () => void;
  const hedgeStarted = new Promise<void>(resolve => { markHedgeStarted = resolve; });
  const pending = hedgeCompanionBatch(signal => {
    if (++calls === 1) return new Promise<string>((_, reject) => { failPrimary = reject; });
    hedgeSignal = signal;
    markHedgeStarted();
    return new Promise<string>(resolve => { completeHedge = resolve; });
  }, { signal: new AbortController().signal, delayMs: 1 });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  // Keep the test process alive while the production hedge timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await hedgeStarted;
    failPrimary(new Error("primary failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hedgeSignal.aborted, false, "primary failure must not cancel the live hedge");
    completeHedge("valid hedge");
    assert.deepEqual(await outcome, { value: "valid hedge" });
    assert.equal(hedgeSignal.aborted, true, "completed attempt scopes are cleaned up");
    assert.equal(calls, 2);
  } finally { clearTimeout(keepAlive); }
});

test("a failed hedge leaves the primary alive, and two failures report both causes", async () => {
  let calls = 0;
  let completePrimary!: (value: string) => void;
  let primarySignal!: AbortSignal;
  let markHedgeStarted!: () => void;
  const hedgeStarted = new Promise<void>(resolve => { markHedgeStarted = resolve; });
  const pending = hedgeCompanionBatch(signal => {
    if (++calls === 1) {
      primarySignal = signal;
      return new Promise<string>(resolve => { completePrimary = resolve; });
    }
    markHedgeStarted();
    return Promise.reject(new Error("hedge failed"));
  }, { signal: new AbortController().signal, delayMs: 1 });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await hedgeStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(primarySignal.aborted, false, "hedge failure must not cancel the live primary");
    completePrimary("valid primary");
    assert.deepEqual(await outcome, { value: "valid primary" });
  } finally { clearTimeout(keepAlive); }

  const failures = [new Error("primary unavailable"), new Error("hedge unavailable")];
  calls = 0;
  await assert.rejects(hedgeCompanionBatch(async () => { throw failures[calls++]; },
    { signal: new AbortController().signal, delayMs: 60_000 }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    assert.equal(calls, 2);
    return true;
  });
});

test("an invalid image result cannot beat a validated result from the other attempt", async () => {
  let calls = 0;
  const images = await hedgeCompanionBatch(async () => {
    const ids = ++calls === 1 ? ["a", "a"] : ["b", "a"];
    return parseCompanionImageBatch(JSON.stringify({ images: ids.map(assetId => ({ assetId, description: assetId })) }), ["a", "b"]);
  }, { signal: new AbortController().signal, delayMs: 60_000 });
  assert.deepEqual(images.images.map(image => image.assetId), ["a", "b"]);
  assert.equal(calls, 2);
});

test("parent cancellation settles even when the transport ignores abort", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = hedgeCompanionBatch(() => { calls++; return new Promise<string>(() => {}); },
    { signal: controller.signal, delayMs: 60_000 });
  const cancelled = new Error("user cancelled");
  controller.abort(cancelled);
  const timer = setTimeout(() => {}, 1_000);
  try {
    const result = await Promise.race([
      pending.then(() => "resolved", error => error),
      new Promise(resolve => setTimeout(() => resolve("still pending"), 50)),
    ]);
    assert.equal(result, cancelled);
    assert.ok(calls <= 1, "cancellation must never start a second attempt");
  } finally { clearTimeout(timer); }
});

test("batch identity validation restores source order and rejects duplicate expected identities", () => {
  const raw = JSON.stringify({ images: [{ assetId: "b", description: "second" }, { assetId: "a", description: "first" }] });
  assert.deepEqual(parseCompanionImageBatch(raw, ["a", "b"]).images.map(image => image.assetId), ["a", "b"]);
  assert.throws(() => parseCompanionImageBatch(raw, ["a", "a"]), /identities/);
});

test("取消本轮会中止批次请求", async () => {
  const controller = new AbortController();
  const pending = hedgeCompanionBatch(signal => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { signal: controller.signal, delayMs: 1000 });
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending);
});

test("12 张的三批同时读取，完成顺序不影响交付顺序", async () => {
  const images = Array.from({length:12},(_,i)=>image(String(i)));
  const messages = [{role:"user" as const,content:images.flatMap(i=>[
    {type:"text" as const,text:COMPANION_IMAGE_ASSET_LABEL+JSON.stringify({assetId:i.assetId})},i.part])}];
  const pending: Array<{resolve: (raw:string)=>void; ids:string[]}> = [];
  let active=0, peak=0;
  const result=prepareCompanionImageBatches({messages,userText:"比较",signal:new AbortController().signal,cache:new Map(),
    runBatch: ({messages}) => new Promise(resolve=>{
      active++; peak=Math.max(peak,active);
      const parts=messages[1]!.content;assert.ok(Array.isArray(parts));
      const ids=parts.flatMap(p=>p.type==="text"&&p.text.startsWith('{"assetId"')?[JSON.parse(p.text).assetId]:[]);
      pending.push({ids,resolve: raw=>{active--;resolve(raw);}});
    })});
  const complete=(index:number)=>pending[index]!.resolve(JSON.stringify({images:pending[index]!.ids.map(assetId=>({assetId,description:assetId}))}));
  // 12 images cap at three batches; the whole set is in flight together.
  assert.equal(pending.length,3);
  complete(2); complete(0); await Promise.resolve(); complete(1);
  const output=await result;
  const batches=output.filter(m=>m.hostObservation).slice(0,3).map(m=>JSON.parse((m.content as string).split("：")[1]!));
  assert.deepEqual(batches.map(b=>b.batch),[1,2,3]);
  assert.deepEqual(batches.flatMap(b=>b.images.map((i:{assetId:string})=>i.assetId)),images.map(i=>i.assetId));
  assert.equal(peak,3);assert.equal(active,0);
});
