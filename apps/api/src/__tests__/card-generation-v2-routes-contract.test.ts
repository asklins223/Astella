/**
 * 方案 20 — Card Generation V2 routes 契约单测。
 *
 * 源码文本断言模式（与项目现有 contract 测试一致）：
 * - 端点注册完整性（路径、方法、权限）
 * - NO_STORE header 设置
 * - requireSession / requireOwner 守卫
 * - error → sendServiceError 映射
 * - 路由命名一致性
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const routesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/card-generation-v2/routes.ts"),
  "utf8",
);

const helpersSource = readFileSync(
  resolve(import.meta.dirname, "../modules/card-generation-v2/helpers.ts"),
  "utf8",
);

/**
 * 2026-10-04：run 事件的写入、错误类与 `RunContext` 已下沉到制卡领域包
 * `packages/card-generation`。
 *
 * 为什么这一条要改扫描目标而**不是**放宽断言：原来那几条守的是"`helpers.ts` 里
 * 有一个 `insertEvent`，且 `serializeCandidatePublic` 的函数体到它之前为止不泄
 * 私有字段"。实现搬走之后，按旧路径扫会一路绿到底——判据扫一个已经没有那段代码的
 * 文件，等于没有判据。所以改成扫**新的实际承载文件**，断言一个字都不松。
 *
 * ⚠️ 层数：本文件在 `apps/api/src/__tests__/`，到仓库根是**四**层
 * （`__tests__` → `src` → `api` → `apps` → 根）。数少一层的症状是 ENOENT，
 * 而"只读文件内容"的判据在读不到时会一路绿到底——所以下面直接让 `readFileSync`
 * 在模块加载期抛，而不是给个空串糊过去。
 */
const CARD_GENERATION_PKG = resolve(
  import.meta.dirname, "../../../../packages/card-generation/src",
);
const packageErrorsSource = readFileSync(resolve(CARD_GENERATION_PKG, "errors.ts"), "utf8");
const packageTypesSource = readFileSync(resolve(CARD_GENERATION_PKG, "types.ts"), "utf8");
const packageEventsSource = readFileSync(resolve(CARD_GENERATION_PKG, "events.ts"), "utf8");

const serverSource = readFileSync(
  resolve(import.meta.dirname, "../server.ts"),
  "utf8",
);

describe("Card Generation V2 routes contract", () => {
  describe("endpoint registration", () => {
    it("registers POST /v2/card-generation-runs with requireOwner", () => {
      assert.ok(routesSource.includes(`app.post("/v2/card-generation-runs"`));
      assert.ok(routesSource.includes(`preHandler: [requireOwner]`));
    });

    it("registers GET /v2/card-generation-runs/:runId", () => {
      assert.ok(routesSource.includes(`app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId"`));
    });

    it("registers GET /v2/card-generation-runs/:runId/plan", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/plan"`));
    });

    it("registers GET /v2/card-generation-runs/:runId/candidates", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/candidates"`));
    });

    it("registers exact candidate exposure eligibility projection", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/candidates/:candidateId/exposure"`));
      assert.ok(routesSource.includes("cardGenerationExposureEligibilityV1Schema"));
      assert.ok(routesSource.includes("candidateExposureQuerySchema"));
    });

    it("registers GET /v2/card-generation-runs/:runId/events", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/events"`));
    });

    it("resumes Card Generation SSE from a validated Last-Event-ID", () => {
      assert.ok(routesSource.includes(`req.headers["last-event-id"]`));
      assert.ok(routesSource.includes("invalid_last_event_id"));
      assert.ok(routesSource.includes("let lastSeq = afterSequence"));
    });

    it("registers POST /v2/card-generation-runs/:runId/cancel with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/cancel"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/close with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/close"`));
    });

    // 2026-09-18：唯一候选被 critic 否决的 run 需要用户可见的就地重试入口
    // （此前只能回笔记重开一次全新生成，重付 planner + 全部 critic 的 token）。
    it("registers POST /v2/card-generation-runs/:runId/retry with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/retry"`));
      const postIdx = routesSource.indexOf('app.post', routesSource.indexOf('":runId/retry"'));
      assert.ok(postIdx >= 0);
      const nearby = routesSource.slice(postIdx, postIdx + 260);
      assert.ok(nearby.includes("preHandler: [requireOwner]"), "retry route must require the owner role");
    });

    it("registers POST /v2/card-generation-runs/:runId/candidate-actions with requireOwner", () => {
      // Find the route definition (not the comment) — look for the app.post line
      const postIdx = routesSource.indexOf('app.post', routesSource.indexOf('candidate-actions'));
      assert.ok(postIdx >= 0);
      // Check that requireOwner appears near the candidate-actions route
      const nearby = routesSource.slice(postIdx, postIdx + 200);
      assert.ok(nearby.includes("preHandler: [requireOwner]"));
    });

    it("registers POST /v2/card-generation-runs/:runId/candidates/:candidateId/reveal", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/candidates/:candidateId/reveal"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/activate with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/activate"`));
    });

    it("registers POST /v2/cards/:cardId/reveal (§17.6)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/reveal"`));
    });

    it("registers POST /v2/cards/:cardId/archive with requireOwner (§16.7)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/archive"`));
      assert.ok(routesSource.includes(`preHandler: [requireOwner]`));
    });

    it("registers POST /v2/cards/:cardId/revisions with requireOwner (§15.4)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/revisions"`));
    });

    it("registers POST /v2/cards/:cardId/regeneration-runs with requireOwner (§6.8)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/regeneration-runs"`));
    });

    it("registers GET /v2/cards/:cardId (§15.1)", () => {
      assert.ok(routesSource.includes(`app.get<{ Params: { cardId: string } }>("/v2/cards/:cardId"`));
    });

    it("registers reminder endpoints (§17.3)", () => {
      assert.ok(routesSource.includes(`"/v2/initial-validation-reminders"`));
      assert.ok(routesSource.includes(`"/v2/initial-validation-reminders/:reminderId/cancel"`));
    });
  });

  describe("middleware and security", () => {
    it("enforces Idempotency-Key on all mutations (§9.1)", () => {
      assert.ok(routesSource.includes(`requireIdempotencyKey(req)`));
      assert.ok(!routesSource.includes(`?? \`run-${"$"}{crypto.randomUUID()}\``));
    });

    it("adds requireSession as preHandler hook", () => {
      assert.ok(routesSource.includes(`app.addHook("preHandler", requireSession)`));
    });

    it("uses requireOwner for create, cancel, close, candidate-actions, and activate", () => {
      // Count occurrences of requireOwner in route definitions
      const requireOwnerCount = (routesSource.match(/preHandler: \[requireOwner\]/g) || []).length;
      assert.ok(requireOwnerCount >= 5, `expected >=5 requireOwner routes, got ${requireOwnerCount}`);
    });

    it("sets NO_STORE header on all routes", () => {
      const noStoreCount = (routesSource.match(/reply\.headers\(NO_STORE\)/g) || []).length;
      assert.ok(noStoreCount >= 10, `expected >=10 NO_STORE headers, got ${noStoreCount}`);
    });
  });

  describe("error handling", () => {
    it("uses sendServiceError for all routes", () => {
      const errorCount = (routesSource.match(/sendServiceError\(reply, error\)/g) || []).length;
      assert.ok(errorCount >= 8, `expected >=8 sendServiceError calls, got ${errorCount}`);
    });

    it("returns 404 for not found runs", () => {
      assert.ok(routesSource.includes(`run_not_found`));
    });

    it("returns 400 for invalid UUID format", () => {
      assert.ok(routesSource.includes(`invalid_id`));
    });

    it("validates runId consistency between URL and body", () => {
      assert.ok(routesSource.includes(`run_id_mismatch`));
    });

    it("validates candidateId consistency between URL and body", () => {
      assert.ok(routesSource.includes(`candidate_id_mismatch`));
    });
  });

  describe("schema validation", () => {
    it("uses createCardGenerationRunRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`createCardGenerationRunRequestV2Schema`));
    });

    it("uses candidateActionCommandV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`candidateActionCommandV2Schema`));
    });

    it("uses revealCandidateRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`revealCandidateRequestV2Schema`));
    });

    it("uses activateCardCandidatesRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`activateCardCandidatesRequestV2Schema`));
    });
  });

  describe("server registration", () => {
    it("imports cardGenerationV2Routes", () => {
      assert.ok(serverSource.includes(`import { cardGenerationV2Routes }`));
    });

    it("registers cardGenerationV2Routes", () => {
      assert.ok(serverSource.includes(`app.register(cardGenerationV2Routes)`));
    });
  });

  describe("feature flag", () => {
    it("exports isCardGenerationV2Enabled function", () => {
      const flagsSource = readFileSync(
        resolve(import.meta.dirname, "../config/learning-companion-flags.ts"),
        "utf8",
      );
      assert.ok(flagsSource.includes(`isCardGenerationV2Enabled`));
      assert.ok(flagsSource.includes(`CARD_GENERATION_V2_ENABLED`));
    });
  });
});

describe("Card Generation V2 helpers contract", () => {
  it("exports CardGenerationV2ServiceError with code and statusCode", () => {
    // 类的**定义**现在在制卡领域包里（那里是唯一实现）；helpers.ts 只是转出它。
    assert.ok(packageErrorsSource.includes(`class CardGenerationV2ServiceError`));
    // 2026-08-24（§4.4 第二批）：CardGenerationV2ServiceError 继承 shared 纯逻辑层
    // 的 CardGenerationPipelineErrorV2（后者继承 DomainError）——下沉的 seal/
    // binding-plan 纯函数抛 shared 类，instanceof 边界不受影响。code/statusCode
    // 由基类提供；验证继承链与构造参数传递。
    assert.ok(
      packageErrorsSource.includes(`extends CardGenerationPipelineErrorV2`)
        || packageErrorsSource.includes(`extends DomainError`),
    );
    assert.ok(packageErrorsSource.includes(`code`));
    assert.ok(packageErrorsSource.includes(`statusCode`));
    // API 侧仍然转出同一个类：**所有现役错误边界（sendServiceError、worker 门闩、
    // 测试里的 instanceof）认的必须是这一个 class 对象**，不是 API 自己再声明一个
    // 同名类。少了这一行，转出就断了，而断法是静默的。
    assert.ok(helpersSource.includes(`export { CardGenerationV2ServiceError }`));
  });

  it("exports NO_STORE with private, no-store", () => {
    assert.ok(helpersSource.includes(`private, no-store`));
  });

  it("exports RunContext type", () => {
    assert.ok(packageTypesSource.includes(`type RunContext`));
    assert.ok(helpersSource.includes(`export type { RunContext }`));
  });

  it("exports serializeRunPublic", () => {
    assert.ok(helpersSource.includes(`function serializeRunPublic`));
  });

  it("exports serializeCandidatePublic", () => {
    assert.ok(helpersSource.includes(`function serializeCandidatePublic`));
  });

  it("exports insertEvent", () => {
    assert.ok(packageEventsSource.includes(`async function insertEvent`));
    // helpers.ts 只**转出**，不再自己声明一份——两份实现就是事件序会有两个答案。
    assert.ok(helpersSource.includes(`export { insertEvent, insertEventBatch }`));
  });

  it("exports getCandidateForAction", () => {
    assert.ok(helpersSource.includes(`async function getCandidateForAction`));
  });

  it("exports applyPatch", () => {
    assert.ok(helpersSource.includes(`function applyPatch`));
  });

  it("answer fields do not leak into serializeCandidatePublic", () => {
    // serializeCandidatePublic 的返回对象不得含 canonicalAnswer/explanation 等
    // 私有内容字段（§22.3）。helpers.ts 中 BLOCKED_EVENT_PAYLOAD_KEYS 也会
    // 出现这些词，因此只检查 serializeCandidatePublic 函数体内部。
    // ⚠️ 窗口的右界是"下一个导出"，**不是**"insertEvent 在哪"：2026-10-04 那次
    // 抽取把 insertEvent 搬走了，按旧边界切会得到 -1、退化成 `fnStart + 2000`
    // 的定长窗口，于是函数体后半段（也就是真正写着字段映射的那一半）落在检查之外
    // ——判据看上去还在跑，实际已经不覆盖它要防的东西了。
    const fnStart = helpersSource.indexOf("function serializeCandidatePublic");
    const fnEnd = helpersSource.indexOf("export function summarizePlanPracticeQuotaV2", fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, "serializeCandidatePublic 的函数边界没找到：这一格要按新形状重写");
    const fnBody = helpersSource.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes(`canonicalAnswer`), "serializeCandidatePublic must not expose canonicalAnswer");
    assert.ok(!fnBody.includes(`explanation`), "serializeCandidatePublic must not expose explanation");
    assert.ok(!fnBody.includes(`learningSupport`), "serializeCandidatePublic must not expose learningSupport");
  });
});
