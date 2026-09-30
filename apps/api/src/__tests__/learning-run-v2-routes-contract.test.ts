/**
 * GS-01B / RUN-V2-WIRE-01 的 route roster contract。
 *
 * 该测试只锁定跨层边界：API 必须注册 V2 endpoint、解析 strict V2 schema，
 * desktop gateway 必须消费对应路径。真实 workspace、schedule、DB、worker
 * 闭环仍由 integration / packaged evidence 负责，不能由本测试替代。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const apiRoutesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/learning-runs/run-routes.ts"),
  "utf8",
);
const reviewRoutesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/review/routes.ts"),
  "utf8",
);
/**
 * 2026-09-30：网关已按命名空间拆成 `desktop-gateway-ns-*.ts`，
 * 学习运行那一条通道搬进了 `desktop-gateway-ns-learning.ts`。
 *
 * 判据的对象是「网关把 POST /learning-runs 当作 V2 起始命令发出去」，
 * 不是「它在 desktop-gateway.ts 里」——所以读整个 `src/main` 下的
 * gateway 家族（主文件 + 各命名空间文件）。
 */
const gatewaySource = readdirSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/main"),
)
  .filter((n) => /^desktop-gateway.*\.ts$/.test(n) && !n.endsWith(".test.ts"))
  .map((n) => readFileSync(
    resolve(import.meta.dirname, "../../../desktop-client/src/main", n), "utf8",
  ))
  .join("\n");
/**
 * desktop-ipc 家族（主文件 + 各命名空间文件）——与上面的 `gatewaySource` 同一个形状。
 *
 * 2026-09-30：桌面端把通道按命名空间各自分文件之后，只读 `desktop-ipc.ts`
 * 就会在**它已经不在那儿**的时候报「missing main handler learningRunGet」。
 * 判据的对象是「这十条通道在 V2 上都注册了、都走严格 schema」，
 * 不是它写在哪个文件里——所以读整个家族，不改回代码（AGENTS.md 同一条纪律）。
 */
const desktopIpcSource = readdirSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/main"),
)
  .filter((n) => /^desktop-ipc.*\.ts$/.test(n) && !n.endsWith(".test.ts"))
  .map((n) => readFileSync(
    resolve(import.meta.dirname, "../../../desktop-client/src/main", n), "utf8",
  ))
  .join("\n");
const preloadSource = readFileSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/preload/index.ts"),
  "utf8",
);

describe("GS-01B V2 route roster", () => {
  it("keeps the standard start command on strict V2 dispatch", () => {
    assert.match(apiRoutesSource, /app\.post\("\/learning-runs"/);
    assert.match(apiRoutesSource, /createLearningRunV2RequestSchema/);
    assert.match(apiRoutesSource, /parseBody\(app, createLearningRunV2RequestSchema, req\.body\)/);
    assert.match(apiRoutesSource, /learningRunPublicSnapshotV2Schema/);
    // 2026-09-30：接收者多了一层。并发 WIP 把 `this.request(...)` 换成了
    // `this.transport.request(...)`（网关抽出了 transport 抽象）。
    // 判据的对象是「网关把 POST /learning-runs 当作 V2 起始命令发出去」，
    // 不是「它调在 this 上还是 this.transport 上」——所以两种都认。
    // 接收者换过两次（this / this.transport / 命名空间后的别的东西），
    // 契约是「这一条通道存在且是 POST」，不是「调在谁身上」——
    // 所以只认路径 + 方法，不再钉死接收者。
    assert.match(
      gatewaySource,
      /request\(\s*\{?[\s\S]{0,40}?"\/learning-runs"[^)]*\}?[\s\S]{0,120}?method: "POST"/,
    );
    assert.match(gatewaySource, /learningRunPublicSnapshotV2Schema\.safeParse/);
  });

  it("registers the V2 public snapshot, result and return contract endpoints", () => {
    for (const path of [
      "/v2/learning-runs/:runId",
      "/v2/learning-runs/:runId/result",
      "/v2/learning-runs/:runId/return-contract",
    ]) {
      assert.ok(apiRoutesSource.includes(path), `missing API route ${path}`);
    }
    assert.match(apiRoutesSource, /getResultPayloadV2/);
    assert.match(apiRoutesSource, /getReturnContractV2/);
    assert.match(apiRoutesSource, /Cache-Control.*no-store/);
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/result/);
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/return-contract/);
  });

  it("keeps V2 draft and submission receipts on V2 paths and schemas", () => {
    for (const path of [
      "/v2/learning-runs/:runId/tasks/:taskId/draft",
      "/v2/learning-runs/:runId/tasks/:taskId/submissions",
    ]) {
      assert.ok(apiRoutesSource.includes(path), `missing API route ${path}`);
    }
    for (const schema of [
      "putLearningTaskDraftRequestV2Schema",
      "learningTaskDraftWriteReceiptV2Schema",
      "submitTaskArtifactV2Schema",
      "submitTaskArtifactReceiptV2Schema",
    ]) {
      assert.ok(apiRoutesSource.includes(schema), `missing strict schema ${schema}`);
    }
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/tasks\/\$\{safeTaskId\}\/draft/);
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/tasks\/\$\{safeTaskId\}\/submissions/);
  });

  it("keeps V2 action and activity lease endpoints isolated from V1", () => {
    assert.ok(apiRoutesSource.includes("/v2/learning-runs/:runId/actions"));
    assert.ok(apiRoutesSource.includes("/v2/learning-runs/:runId/activity-lease"));
    assert.match(apiRoutesSource, /learningRunActionRequestV2Schema/);
    assert.match(apiRoutesSource, /recordLearningRunActivityLeaseRequestV2Schema/);
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/actions/);
    assert.match(gatewaySource, /\/v2\/learning-runs\/\$\{safeRunId\}\/activity-lease/);
  });

  it("keeps the complete M2 snapshot/events/command roster on strict V2 schemas", () => {
    const roster = [
      ["learningRunGet", "get", "learningRunPublicSnapshotV2Schema"],
      ["learningRunStart", "start", "learningRunPublicSnapshotV2Schema"],
      ["learningRunGetDraft", "getDraft", "learningTaskDraftV2Schema"],
      ["learningRunSaveDraft", "saveDraft", "learningTaskDraftWriteReceiptV2Schema"],
      ["learningRunSubmit", "submit", "submitTaskArtifactReceiptV2Schema"],
      ["learningRunAction", "action", "learningRunActionResponseV2Schema"],
      ["learningRunGetResult", "getResult", "getLearningRunResultResponseV2Schema"],
      ["learningRunGetReturnContract", "getReturnContract", "learningRunReturnContractV2Schema"],
      ["learningRunRecordActivityLease", "recordActivityLease", "recordLearningRunActivityLeaseOutputV2Schema"],
      ["learningRunAbandon", "abandon", "learningRunActionResponseV2Schema"],
    ] as const;

    for (const [channel, method, schema] of roster) {
      assert.match(desktopIpcSource, new RegExp(`installHandler\\(DESKTOP_IPC_CHANNELS\\.${channel}\\b`), `missing main handler ${channel}`);
      assert.match(desktopIpcSource, new RegExp(`\\b${schema}\\b`), `missing output schema ${schema}`);
      assert.match(preloadSource, new RegExp(`\\b${method}: \\(input\\) => invoke\\(DESKTOP_IPC_CHANNELS\\.${channel}\\b`), `missing preload method ${method}`);
    }

    assert.match(desktopIpcSource, /watchLearningRunEvents/);
    assert.match(desktopIpcSource, /kind === "learningRun"/);
    assert.match(gatewaySource, /eventsUrl\.searchParams\.set\("snapshotId"/);
  });

  it("exposes the dedicated sanitized ReviewQueueV2 endpoint", () => {
    assert.ok(reviewRoutesSource.includes("/v2/reviews/queue"));
    assert.match(reviewRoutesSource, /projectReviewQueueV2/);
    assert.match(gatewaySource, /\/v2\/reviews\/queue/);
  });

  it("binds the main-owned SSE stream to the strict V2 snapshot", () => {
    assert.match(apiRoutesSource, /snapshotId.*非法/);
    assert.match(apiRoutesSource, /getLearningRunPublicSnapshotV2\(tx, \{ \.\.\.scope, runId: params\.data\.runId \}\)/);
    assert.match(apiRoutesSource, /last-event-id/);
    assert.match(gatewaySource, /eventsUrl\.searchParams\.set\("snapshotId", streamSnapshot\.snapshotId\)/);
    // 2026-09-30：网关按命名空间拆分后，取快照变成
    // `ns_learning.getLearningRun(this.gatewayTransport, safeRunId)`。
    // 契约是「流式订阅用的 snapshotId 来自**网关自己取的那份快照**」，
    // 而不是「调在 this 上还是 ns_learning 上」——所以只认 getLearningRun + safeRunId。
    assert.match(gatewaySource, /getLearningRun\([^)]*safeRunId\)/);
  });
});
