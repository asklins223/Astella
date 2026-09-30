import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-8：读路径的**收敛性**。
 *
 * ## 审计说的是"引入共享缓存层或投影表，否则冷读无法收敛"
 *
 * 2026-09-29 实读之后要分清两件事：
 *
 * · **「无法收敛」这个前提，在能读到的读路径上不成立。**
 *   `learning-dashboard/home-suggestion-*` 已经是 4 个模块、每处 0~1 次查询、
 *   汇总处用 `Promise.all` 并行——也就是有界的扇出。
 *   `learning-sessions/ttl-maintenance.ts` 里那两个查询循环是**维护任务**，
 *   各自有 `MAX_BATCH_ROUNDS` 硬上限，注释也写明是为了避免长事务。
 *
 * · **缓存层本身不是从代码里推得出来的东西。** 加它要先答两个问题：
 *   哪些面真的要（那要看真实冷读数据，不在源码里），以及失效怎么配
 *   （配错的缓存比没有缓存更糟：它会给出**看起来正常但已过期**的读）。
 *
 * 所以本条**不引入缓存层**，而是守住"收敛"真正依赖的那三件事——
 * 它们一旦被改掉，冷读才真的会退化成 N+1，而那不会让任何现有测试变红。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const DASHBOARD = join(API_ROOT, "modules", "learning-dashboard");
const HOME = join(DASHBOARD, "home-suggestion-service.ts");
const TTL = join(API_ROOT, "modules", "learning-sessions", "ttl-maintenance.ts");

test("首页建议的扇出仍然是并行的（收敛靠它，不靠缓存）", () => {
  const source = readFileSync(HOME, "utf8");
  // 锁状态与今日批次是两次独立读，必须一起发出去；串行发就是白等一倍 RTT
  assert.ok(
    /Promise\.all\(\s*\[\s*isBatchPausedV2/.test(source),
    "首页那两发（是否暂停 / 今日批次）不再并行——"
    + "串行发等于把冷读延迟翻倍，而这正是当初加 Promise.all 的理由。",
  );
});

test("维护型批处理循环有硬轮次上限（否则会变成一个跑不完的事务）", () => {
  const source = readFileSync(TTL, "utf8");
  // 两个批处理循环各自要有一个上限常量，且循环里用它收口
  const caps = [...source.matchAll(/const (\w*MAX_BATCH_ROUNDS)\s*=/g)].map((m) => m[1]!);
  assert.ok(caps.length >= 2,
    `只找到 ${caps.length} 个轮次上限常量——两个批处理循环各自都该有一个`);
  for (const cap of caps) {
    assert.ok(
      new RegExp(`for\\s*\\([^)]*round[^)]*;[^)]*round\\s*<\\s*${cap}`).test(source),
      `${cap} 声明了却没被任何批处理循环用上——`
      + "没有上限的批处理循环会一直跑到清空为止，那是一个长事务",
    );
  }
});

test("批处理循环里没有 N+1（每次迭代一次函数调用，不是逐行查）", () => {
  const source = readFileSync(TTL, "utf8");
  // 循环体内只准有一个 db.execute / tx.execute；多一个就是 N+1
  for (const m of source.matchAll(/for\s*\([^)]*round[^{]*\{([\s\S]*?)\n\s*\}/g)) {
    const body = m[1]!;
    const queries = [...body.matchAll(/\b(?:db|tx|executor)\.(?:execute|select|insert|update|delete)\b/g)];
    assert.ok(
      queries.length <= 1,
      `一个批处理循环里有 ${queries.length} 次查询——应当是每轮一次批量函数调用。`
      + "逐行查就是 N+1，而批处理循环往往还会跑很多轮。",
    );
  }
});

test("【自证】判据会红：把并行改回串行必须被抓", () => {
  const real = readFileSync(HOME, "utf8");
  const serialised = real.replace(
    /const \[\{ paused \}, batch\] = await Promise\.all\(\[\s*isBatchPausedV2\(tx, lockInput\),\s*todayLimitedBatchV2\(tx, \{ \.\.\.lockInput, userAskedForMore: ctx\.userAskedForMore \}\),\s*\]\);/,
    "const { paused: p } = { paused: await isBatchPausedV2(tx, lockInput) };\n"
    + "  const batch = await todayLimitedBatchV2(tx, { ...lockInput, userAskedForMore: ctx.userAskedForMore });",
  );
  assert.ok(
    !/Promise\.all\(\s*\[\s*isBatchPausedV2/.test(serialised),
    "自证样本没造好：改成串行之后不该再匹配到 Promise.all",
  );
  assert.ok(
    /Promise\.all\(\s*\[\s*isBatchPausedV2/.test(real),
    "自证：磁盘上那处并行还在",
  );
});
