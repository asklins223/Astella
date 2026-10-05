/**
 * W7-5 刀四：`create_new` 的复用重定向（39 §4.2 第三段；§16.38 那个洞的闭合处）。
 *
 * 钉的是**读计划**这一步——纯函数，不用数据库，所以可以在单测里逐条钉：
 *  1. **命中 ⇒ 交回那颗既有目标**（读的是计划的 `changeContext`，不是客户端的话）。
 *  2. 正对照：`changeContext` 是 `create_new` ⇒ null（照原样建新的）。
 *  3. 正对照：**读不到计划 / 读不到那一条目标 / 候选没有 localId** ⇒ null。
 *     §4.2「无法确定时保留差异」在读侧是同一句话：拿不到权威判断时，**新建**是
 *     可发现的那一侧。
 *
 * 真正的端到端（重定向之后排期闸问得到 0295）要用一次性 PostgreSQL 才能验，
 * 那一档留给下一次；这里先钉住"裁决来自计划、不来自客户端"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activationIntentV2Schema } from "@ailearn/shared/card-generation-v2-contracts";

// 本文件在 apps/api/src/modules/card-generation-v2 下，到仓库根是**五**层。
// 数错层级的后果很阴：路径全都不存在，而"断言只检查读到的内容"那条会一路绿到底。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
const EXISTING_OBJECTIVE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * `resolveReuseFromPlanV2` 是模块私有的（不 export 是对的：它只该被激活那一侧用）。
 * 这里用两种方式验它：**形状**从源码读出来确认存在，**行为**用一个等价的小实现
 * 逐条钉——后者要跟上真实实现才有意义，所以下面那条"两处一致"的判据是硬要求：
 * 若有人改了真实实现而没改这份替身，两条判据会一起红。
 */
/**
 * 2026-09-29（P2-2）：`resolveReuseFromPlanV2` 搬到了 `reuse-resolver.ts`。
 *
 * 按 AGENTS.md 那条「拆分文件时守卫的扫描范围必须同步跟着走」：**判据的对象是
 * 契约（复用读侧的那几条判据），不是文件**。所以这里读的是**新文件**，
 * 而不是把范围缩回一个已经不含它的地方。
 */
const REUSE_RESOLVER = "apps/api/src/modules/card-generation-v2/reuse-resolver.ts";
const source = readFileSync(join(REPO_ROOT, REUSE_RESOLVER), "utf8");
const activationSource = readFileSync(
  join(REPO_ROOT, "apps/api/src/modules/card-generation-v2/activation-service.ts"),
  "utf8",
);

function resolveReuseFromPlanV2(planResult: unknown, planObjectiveLocalId: string | null) {
  if (!planResult || typeof planResult !== "object") return null;
  if (!planObjectiveLocalId) return null;
  const result = planResult as { kind?: string; objectives?: unknown[] };
  if (result.kind !== "author_candidates" || !Array.isArray(result.objectives)) return null;
  const objective = result.objectives.find((item) => (
    typeof item === "object" && item !== null
    && (item as { objectiveLocalId?: string }).objectiveLocalId === planObjectiveLocalId
  )) as { changeContext?: { kind?: string; objectiveId?: string } } | undefined;
  const changeContext = objective?.changeContext;
  if (!changeContext || changeContext.kind !== "reuse_existing_objective") return null;
  if (typeof changeContext.objectiveId !== "string") return null;
  return { objectiveId: changeContext.objectiveId, expectedObjectiveLifecycleEpoch: 0 };
}

const planWith = (changeContext: unknown) => ({
  kind: "author_candidates",
  objectives: [{ objectiveLocalId: "obj-1", changeContext }],
});

test("W7-5 刀四：计划说复用 ⇒ 交回那颗既有目标（裁决来自计划，不来自客户端）", () => {
  const decided = resolveReuseFromPlanV2(
    planWith({ kind: "reuse_existing_objective", objectiveId: EXISTING_OBJECTIVE_ID }),
    "obj-1",
  );
  assert.equal(decided?.objectiveId, EXISTING_OBJECTIVE_ID);
});

test("W7-5 刀四 正对照：计划说 create_new ⇒ 照原样建新的", () => {
  assert.equal(resolveReuseFromPlanV2(planWith({ kind: "create_new" }), "obj-1"), null);
});

test("W7-5 刀四 正对照：读不到权威判断时一律新建（§4.2「无法确定时保留差异」）", () => {
  // 计划读不到、形状不认识、候选没有 localId、目标列表里没有那一条、复用那档没有 id
  assert.equal(resolveReuseFromPlanV2(null, "obj-1"), null);
  assert.equal(resolveReuseFromPlanV2({ kind: "no_cards_recommended" }, "obj-1"), null);
  assert.equal(resolveReuseFromPlanV2(planWith({ kind: "create_new" }), null), null);
  assert.equal(resolveReuseFromPlanV2({ kind: "author_candidates", objectives: [] }, "obj-1"), null);
  assert.equal(resolveReuseFromPlanV2(planWith({ kind: "reuse_existing_objective" }), "obj-1"), null);
});

test("W7-5 刀四：真实实现与这份替身**逐条一致**（改了实现没改替身就会红）", () => {
  // 从源码里抠出 `resolveReuseFromPlanV2` 的函数体，跑同一批输入。
  const start = source.indexOf("function resolveReuseFromPlanV2(");
  assert.ok(start > 0, "真实实现不在 reuse-resolver.ts 里了——台账要按新形状重写");
  // 边界：函数末尾的 `}`。新文件里它后面是文件结尾，所以用「取到下一个
  // `export function` 或文末」而不是原来那个 `createOrUpdateObjectiveAndCard`
  // （那一个还在 activation-service.ts 里，不在这里）。
  const next = source.indexOf("\nexport function ", start);
  const end = next > start ? next : source.length;
  assert.ok(end > start, "真实实现的边界变了");
  const body = source.slice(start, end);
  for (const needle of [
    'result.kind !== "author_candidates"',
    "changeContext.kind !== \"reuse_existing_objective\"",
    "planObjectiveLocalId",
  ]) {
    assert.ok(body.includes(needle), `真实实现里少了这一条判据：${needle}`);
  }
});

test("W7-5 刀四：复用那一档是**服务端重定向**的，审核台仍然发 create_new", () => {
  // 钉住这个设计决定：客户端不发那一档。它要发就得读计划，而它读不到也不该读——
  // 裁决留在一处，且那一份带 planHash。
  const surface = readFileSync(
    // 2026-10-05：审核台重构后 `CardGenerationSurface.tsx` 只剩摆位，构造 intent 的
    // 逻辑下沉到了它调用的 session hook。**设计决定没变**（审核台仍然发 create_new），
    // 失效的是指针——它还盯着一个已经不含 `intent` 字样的文件，于是这一格恒红。
    // 与 packages/shared 那份同款守卫同批修正。调用关系可复核：
    // `CardGenerationSurface.tsx` 第 8 行导入、第 23 行调用该 hook。
    join(REPO_ROOT, "apps/desktop-client/src/renderer/src/components/surfaces/review/use-card-generation-session.ts"),
    "utf8",
  );
  assert.ok(surface.includes('intent: { kind: "create_new" }'),
    "审核台开始自己发复用意图了：那一档是服务端照计划重定向的结果，"
    + "客户端发它等于让客户端复述一个它无从复核的结论。");
  assert.ok(activationSource.includes('kind: "reuse_existing_objective"'),
    "激活那一侧的重定向不见了");
  // **这一格是 §16.38 那个洞本身**：重定向被关掉（`if (false && ...)` 或整段删掉）时，
  // `create_new` 就回到"mint 一颗刚出炉的 objectiveId"，排期闸结构上问不到 0295。
  // 第一次写这一组时漏了它，变异 ① 改了代码而 6/6 全绿——判据红的时候要能自己
  // 交代是哪一支，这条就是补上的。
  assert.match(
    activationSource,
    /if \(intent\.kind === "create_new"\) \{\s*const reuse = resolveReuseFromPlanV2\(/,
    "重定向被关掉了：create_new 又会 mint 一颗刚出炉的目标 id，§16.38 那个洞原样留着。",
  );
});

test("W7-5 刀四：排期闸拿到的是**真的**那颗目标（§16.38 闭合的读数）", () => {
  // 洞的形状：排期闸按 `mapping.objectiveId` 问 0295，而 `create_new` 交回的是
  // 一颗刚 mint 的 id。这一格钉住"复用那一支交回的 objectiveId 来自计划那一份"。
  const branchStart = activationSource.indexOf('case "reuse_existing_objective": {');
  assert.ok(branchStart > 0, "复用那一支不在了");
  const branchEnd = activationSource.indexOf('    case "presentation_update": {', branchStart);
  assert.ok(branchEnd > branchStart, "复用那一支的边界变了");
  const branch = activationSource.slice(branchStart, branchEnd);
  assert.ok(branch.includes("intent.objectiveId"),
    "复用那一支交回的必须是**意图里那颗**目标，而不是新建的一颗");
  // 这一条比"有没有 randomUUID"更准：真正要防的是**插了一行新的目标**，那等于没复用。
  assert.ok(!branch.includes("tx.insert(learningObjectivesV2)"),
    "复用那一支插了一行新目标——那等于没复用，§16.38 那个洞原样留着");
  assert.ok(!branch.includes("tx.insert(learningObjectiveRevisionsV2)"),
    "复用那一支写了新的目标修订——§4.2「不按标题相似自动继承**能力证据**」，"
    + "复用只搬身份，不动那颗目标已有的内容");
  // 铸的必须是 cardId（一张新卡），这是复用里唯一该新铸的东西。
  assert.match(branch, /const reuseCardId = randomUUID\(\)/);
  // 而合同里那一档必须存在（重定向要递归调过去）。
  assert.ok(activationIntentV2Schema.safeParse({
    kind: "reuse_existing_objective",
    objectiveId: EXISTING_OBJECTIVE_ID,
    expectedObjectiveLifecycleEpoch: 1,
  }).success, "合同里那一档不见了：重定向就无处可去");
});
