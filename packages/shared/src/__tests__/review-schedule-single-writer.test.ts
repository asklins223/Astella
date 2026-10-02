/**
 * `review_schedules` 的写入只有一个入口，而"让一行变成待处理"也只许出现在那一个入口
 * （39d W7-2 那条唯一调度边界的前置判据）。
 *
 * 为什么这条要常驻：D2 §3 把"建立/关联那一条待处理安排"收成唯一函数
 * `ensurePendingReviewScheduleV2`，并且与迁移 0287 那把**部分唯一索引同一批**落地。
 * 顺序或纪律反了都会更糟：只要还剩一处裸 `insert` 在写 `status = 'pending'`，
 * 症状就从"同一目标多一条安排"变成"那一次保存整发 23505"。2026-09-27 现读：
 * 运行时只有边界文件自己那一处写入，五个调用方（结算 tick 四条 ＋ 激活那一发）全部走函数。
 *
 * **D2 §2.1 那句"没有任何调用方能直接写这张表"只做到了一半**：insert 全收进边界了，
 * `update` 没收——运行时还有四处直接改这张表（结算消费掉那一条、继任那一发、卡归档时关掉、
 * 「这一条先延后」只改时间列）。那四处都不做排期，也不把行写回待处理，所以真正需要一直
 * 成立的那句话是收窄后的版本：**只有边界能让一行变成 `pending`**（那把索引只管新建，
 * 从别处把一行拉回待处理就绕开它了）。于是这里两边都判：insert 的入口唯一，
 * 而每一处 update 把 status 改成什么逐条登记在案——多一处、少一处、改成别的值、
 * 或者写成取不出字面量的动态值，都会红。
 *
 * 顺带守住配对的那两样，缺任一这条边界就不成立：schema 与迁移里那把索引的名字还在，
 * 以及边界自己仍是"不带 target 的 `onConflictDoNothing()` ＋ 回读，回读不到就抛"。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/** 只扫**运行时**：测试与集测里造夹具行是允许的（它们正是在验那把索引）。 */
const RUNTIME_ROOTS = [
  "apps/api/src",
  "apps/desktop-client/src",
  "workers/ai-worker/src",
  "packages/shared/src",
];
const BOUNDARY_FILE = "apps/api/src/modules/review/review-schedule-boundary.ts";
const INDEX_NAME = "review_schedules_pending_subject_dim_unique";
const MIGRATION_FILE = "apps/api/src/db/migrations/0287_review_schedule_dimension_unique.sql";

const WRITE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // drizzle：`.insert(reviewSchedules)` / `.upsert(reviewSchedules)`，允许换行与缩进。
  { label: "drizzle 写入", re: /\b(?:insert|upsert)\(\s*reviewSchedules\b/g },
  // 原生 SQL：夹具与迁移里最常见的写法，大小写都算。
  { label: "原生 INSERT", re: /\b(?:insert|upsert)\s+into\s+review_schedules\b/gi },
];

/** 这份源码里有几处"往 review_schedules 写行"的形状。 */
function writeSites(source: string): string[] {
  const hits: string[] = [];
  for (const { label, re } of WRITE_PATTERNS) {
    // 连 flags 一起复制：只补一个 "g" 会把 `i` 丢掉，于是大小写都写的原生 SQL
    // 只认小写那一种——判据会安静地漏掉一半写法（这条灵敏性用例第一次跑就抓到它）。
    const matches = source.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
    for (const match of matches ?? []) hits.push(`${label}: ${match.trim()}`);
  }
  return hits;
}

function runtimeSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // 测试与集测自己造行是正当的（那把索引的行为就靠它们验）。
      if (/\.(test|integration)\.[t]sx?$/.test(entry)) continue;
      out.push({ rel: full.slice(REPO_ROOT.length + 1), text: readFileSync(full, "utf8") });
    }
  };
  for (const root of RUNTIME_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

test("分母自证：真的扫到了运行时源码，而且判据读得到边界那一处", () => {
  const files = runtimeSources();
  assert.ok(
    files.length > 150,
    `只扫到 ${files.length} 份运行时源码：walk 或 REPO_ROOT 坏了，这条判据就空转了`,
  );
  const boundary = files.find((f) => f.rel === BOUNDARY_FILE);
  assert.ok(boundary, `扫描里没有 ${BOUNDARY_FILE}，后面的判据无从判起`);
  assert.ok(
    writeSites(boundary.text).length >= 1,
    "边界文件自己都没被读成一处写入 ⇒ 判据读不到真实形状，红绿都不可信",
  );
});

test("判据本身是灵敏的：两种写法都读得到，非写入形状不误报", () => {
  assert.equal(writeSites("await tx.insert(reviewSchedules).values({ status: 'pending' })").length, 1);
  assert.equal(writeSites("await tx\n  .insert(\n  reviewSchedules,\n)").length, 1);
  assert.equal(writeSites("await tx`INSERT INTO review_schedules (id) VALUES (1)`").length, 1);
  assert.equal(writeSites("await tx`insert into review_schedules (id) values (1)`").length, 1);
  // 反向：读、类型引用、以及另一张表的同名前缀都不算写入。
  assert.deepEqual(writeSites("await tx.select().from(reviewSchedules).where(...)"), []);
  assert.deepEqual(writeSites("const reviewSchedulesByDay = group(rows)"), []);
  assert.deepEqual(writeSites("INSERT INTO review_schedules_archive (id) VALUES (1)"), []);
});

test("运行时只有一个写入入口：除边界文件之外任何一处都红", () => {
  const violations = runtimeSources().flatMap(({ rel, text }) =>
    rel === BOUNDARY_FILE ? [] : writeSites(text).map((site) => `${rel} → ${site}`),
  );
  assert.deepEqual(
    violations,
    [],
    `review_schedules 出现了第二个写入口：${violations.join("；")}。`
      + "请改调 ensurePendingReviewScheduleV2——0287 之后裸 insert 不会再多一条安排，"
      + "只会把那一发变成 23505（或撞 UNIQUE 后整发回滚）。",
  );
});

/** 边界成立所依赖的三样东西，抽成**纯判据**：灵敏性就能用内存里的变异来验，不必去改生产文件。 */
function declaresIndex(source: string): boolean {
  return source.includes(INDEX_NAME);
}
function usesBlindDoNothing(source: string): boolean {
  return source.includes(".onConflictDoNothing()");
}
function throwsWhenReadBackMisses(source: string): boolean {
  return /if \(!existing\) \{[\s\S]{0,200}throw new Error/.test(source);
}

test("配对判据自己也要灵敏：改名、换成覆盖写、去掉那一档，三条分别该判不成立", () => {
  const schema = readFileSync(join(REPO_ROOT, "packages/shared/src/db-schema/evidence.ts"), "utf8");
  const boundary = readFileSync(join(REPO_ROOT, BOUNDARY_FILE), "utf8");
  // 正向：三条在当前树上都成立（不成立就是读错了文件，下面的负向也就无从判起）。
  assert.ok(declaresIndex(schema), "schema 那份读不到索引名");
  assert.ok(usesBlindDoNothing(boundary), "边界文件读不到 DO NOTHING 那一支");
  assert.ok(throwsWhenReadBackMisses(boundary), "边界文件读不到「回读不到就抛」那一档");
  // 反向：每一条都在**同一份文本**上做一次内存变异，判据必须跟着翻。
  assert.ok(!declaresIndex(schema.replace(new RegExp(INDEX_NAME, "g"), "renamed_away_idx")),
    "索引改名后仍判成立 ⇒ 这条判据恒真");
  assert.ok(!usesBlindDoNothing(boundary.replace(".onConflictDoNothing()", ".onConflictDoUpdate({})")),
    "换成覆盖写后仍判成立 ⇒ 这条判据恒真");
  assert.ok(!throwsWhenReadBackMisses(boundary.replace("if (!existing) {", "if (never) {")),
    "去掉那一档后仍判成立 ⇒ 这条判据恒真");
});

/**
 * 运行时里每一处 `.update(reviewSchedules)`，以及它把 `status` 改成了什么。
 *
 * 只取紧跟其后的那一个 `.set({…})` 块：drizzle 的更新形状在这里都是单行 set。
 * `status` 的值取不成字面量（写的是变量、三元）时**如实报成"取不出"**——那种形状判成
 * 违规（安全方向），因为"这处会不会把行变回待处理"就再也静态判不出来了。
 */
function statusUpdatesIn(file: string, source: string): Array<{ file: string; via: "update"; value: string | null; dynamic: boolean }> {
  const out: Array<{ file: string; via: "update"; value: string | null; dynamic: boolean }> = [];
  for (const match of source.matchAll(/\.update\(\s*reviewSchedules\s*\)/g)) {
    const at = match.index ?? 0;
    const setBlock = source.slice(at, at + 600).match(/\.set\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!setBlock) {
      out.push({ file, via: "update", value: null, dynamic: true });
      continue;
    }
    const status = setBlock[1].match(/\bstatus:\s*("([^"]*)"|'([^']*)'|[A-Za-z_$][\w$.]*)/);
    if (!status) out.push({ file, via: "update", value: null, dynamic: false });
    else if (status[2] !== undefined) out.push({ file, via: "update", value: status[2], dynamic: false });
    else if (status[3] !== undefined) out.push({ file, via: "update", value: status[3], dynamic: false });
    else out.push({ file, via: "update", value: status[1].trim(), dynamic: true });
  }
  return out;
}

/** 运行时每一处写入（insert 与 update）把 status 落在哪个值上。 */
function pendingCapableSites(): Array<{ file: string; via: "insert" | "update"; value: string | null; dynamic: boolean }> {
  const sites = runtimeSources().flatMap(({ rel, text }) => [
    ...insertStatusesIn(rel, text),
    ...statusUpdatesIn(rel, text),
  ]);
  return sites;
}

/** 读一处 insert 的 `.values({…})` 里 status 的字面量。 */
function insertStatusesIn(file: string, source: string): Array<{ file: string; via: "insert"; value: string | null; dynamic: boolean }> {
  const out: Array<{ file: string; via: "insert"; value: string | null; dynamic: boolean }> = [];
  for (const match of source.matchAll(/\.insert\(\s*reviewSchedules\s*\)/g)) {
    const at = match.index ?? 0;
    const block = source.slice(at, at + 900).match(/\.values\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!block) {
      out.push({ file, via: "insert", value: null, dynamic: true });
      continue;
    }
    const status = block[1].match(/\bstatus:\s*("([^"]*)"|'([^']*)'|([A-Za-z_$][\w$.]*))/);
    if (!status) out.push({ file, via: "insert", value: null, dynamic: false });
    else if (status[2] !== undefined) out.push({ file, via: "insert", value: status[2], dynamic: false });
    else if (status[3] !== undefined) out.push({ file, via: "insert", value: status[3], dynamic: false });
    else out.push({ file, via: "insert", value: status[4], dynamic: true });
  }
  return out;
}

/**
 * 运行时每一处 `.update(reviewSchedules)` 登记在案：它改的是哪一格、把 status 改成什么。
 * D2 §2.1 那条"没有任何调用方能直接写这张表"只做到了一半——**insert 全收进边界了，
 * update 没收**（这四处都不做排期，只让一行离开待处理或改一个延后时间）。所以这里判的是
 * 那句更准的话：**只有边界能让一行变成 `pending`**，而要让这句话一直成立，这四处的
 * status 目标就得逐条看得见（多一处、少一处、或改成别的值，都会红）。
 */
const REGISTERED_STATUS_UPDATES: Record<string, Array<string | null>> = {
  // 一次作答消费掉那一条；两条是同一段里的两个分支（首次消费与继任那一发）。
  "apps/api/src/modules/learning-runs/processing/run-processing-tick.ts": ["completed", "completed"],
  // 卡归档／被替代时关掉待处理那一条（lifecycle 那一发）。
  "apps/api/src/modules/card-generation-v2/card-service.ts": ["cancelled"],
  // 「这一条先延后」：只改 `user_deferred_until`，不碰 status。
  "apps/api/src/modules/review/review-defer-service.ts": [null],
  // 「这个目标暂不安排」：把该目标此刻待处理的那几条撤下（39 §9.1 行 2；迁移 0295）。
  // 撤的是 `dismissed`（本人不要这条了），不是 `cancelled`（系统撤），更不是 pending。
  "apps/api/src/modules/review/objective-review-holds.ts": ["dismissed"],
  // 「这次提醒我处理了」：把**一次性**提醒关成 `completed`（39 §9.1 末段、§16.24；迁移 0297）。
  // 它只改这一条、不建继任、不碰学习观察——与上面那处 `dismissed` 的区别要说得出：
  // 那一处是"以后都别给我排"，这一处是"这一次我处理过了"，两句话在 §9.1 的规则表里
  // 是两行（W5-4 刀一；服务里那一档 `not_one_time` 就是不让它吃掉持续安排的那一条）。
  "apps/api/src/modules/review/one-time-reminder-service.ts": ["completed"],
};

test("分母自证（改）：真的读到那六处 update，且没有第七处", () => {
  const byFile: Record<string, Array<string | null>> = {};
  for (const site of runtimeSources().flatMap((f) => statusUpdatesIn(f.rel, f.text))) {
    (byFile[site.file] ??= []).push(site.dynamic ? null : site.value);
    if (site.dynamic) {
      throw new Error(`${site.file} 有一处 update 的 status 取不出字面量：那句话再也静态判不出来`);
    }
  }
  assert.deepEqual(byFile, REGISTERED_STATUS_UPDATES,
    "review_schedules 的 update 点与台账不一致：新增一处就要写清它把 status 改成什么（**不许改成 pending**），"
      + "改掉一处就把这条删掉");
});

test("让一行变成待处理的写法只许在边界里（insert 与 update 一起判）", () => {
  const pendingWriters = pendingCapableSites().filter((s) => s.value === "pending");
  assert.ok(pendingWriters.length >= 1, "阳性对照：边界自己那一处 pending 写入没被读到 ⇒ 这条判据是空的");
  const violators = pendingWriters.filter((s) => s.file !== BOUNDARY_FILE);
  assert.deepEqual(violators, [],
    `出现边界之外把安排改回待处理的写法：${violators.map((v) => `${v.file}(${v.via})`).join("，")}。`
      + "0287 那把部分唯一索引只管「新建」那一侧，从别处把一行拉回 pending 会绕开它，"
      + "同一目标就能安静长出第二条待处理安排。");
  for (const site of pendingWriters) {
    assert.equal(site.dynamic, false, `${site.file} 的 pending 写入是动态值，判据看不见那一格写的什么`);
  }
});

test("判据对 update 也灵敏：改回待处理要抓到，改成完成与不碰 status 都不许误报", () => {
  const backToPending = `await tx.update(reviewSchedules).set({ status: "pending", updatedAt: at }).where(eq(reviewSchedules.id, id))`;
  const completes = `await tx.update(reviewSchedules).set({ status: "completed", lastReviewAt: at }).where(eq(reviewSchedules.id, id))`;
  const touchesNoStatus = `await tx.update(reviewSchedules).set({ userDeferredUntil: input.deferredUntil }).where(eq(reviewSchedules.id, id))`;
  const dynamic = `await tx.update(reviewSchedules).set({ status: nextStatus }).where(eq(reviewSchedules.id, id))`;
  assert.deepEqual(statusUpdatesIn("f.ts", backToPending).map((s) => s.value), ["pending"],
    "把行改回待处理却没抓到 ⇒ 判据读不到那一格");
  assert.deepEqual(statusUpdatesIn("f.ts", completes).map((s) => s.value), ["completed"]);
  assert.deepEqual(statusUpdatesIn("f.ts", touchesNoStatus).map((s) => s.value), [null],
    "不碰 status 也被算成写待处理");
  assert.deepEqual(statusUpdatesIn("f.ts", dynamic).map((s) => s.dynamic), [true],
    "动态值被判成「没有 status」⇒ 那条安全方向失守：这种形状必须一直看得见");
});

test("边界依赖的那两样还在：部分唯一索引（schema＋迁移）与「冲突后回读、读不到就抛」", () => {
  const schema = readFileSync(join(REPO_ROOT, "packages/shared/src/db-schema/evidence.ts"), "utf8");
  assert.ok(declaresIndex(schema), `schema 里那把部分唯一索引不见了（${INDEX_NAME}）`);
  assert.ok(existsSync(join(REPO_ROOT, MIGRATION_FILE)), `迁移 ${MIGRATION_FILE} 不在了`);
  assert.ok(
    declaresIndex(readFileSync(join(REPO_ROOT, MIGRATION_FILE), "utf8")),
    "迁移里那把索引的名字读不到了",
  );
  const boundary = readFileSync(join(REPO_ROOT, BOUNDARY_FILE), "utf8");
  assert.ok(usesBlindDoNothing(boundary),
    "边界不再是 DO NOTHING 那一支：要么它改成了覆盖别人的到期时间，要么这条判据该同步改口径");
  assert.ok(throwsWhenReadBackMisses(boundary),
    "边界丢了「冲突后回读不到就抛」那一档：那时它会安静交回一个猜出来的 id");
});

/**
 * 下面这半数是另一件事：**唯一键带着 `review_dimension`，而读侧几乎都不认识这一维。**
 *
 * 0287 那把部分唯一索引的键是（空间、人、主体、维度），所以同一目标可以有多条待处理安排。
 * 当前已有五处调用方传非空维度；下面的调用方名单守卫防止这批读侧盘点之外再悄悄增加写入方。
 * 读侧有 28 处，25 处未直接筛维度；这些读点仍需按聚合、队列或单行处理的真实语义分别判断，
 * 台账只记录覆盖范围，不代表它们已获语义豁免。按目标汇总时重复计数、按单行挑选时选错维度，
 * 都是仍需避免的实际风险。
 *
 * 所以这里把所有未直接筛维度的读点逐文件登记成台账（新增读点、或某处改好了不清单，
 * 两个方向都会红）。最初的"第一次有人传非空维度"触发器已过期；当前用精确调用方名单守住
 * 已知写入范围，同时保留读侧台账供逐处审查。
 */

/**
 * 读这张表的一处：它带没带维度判据。
 *
 * 两种形状都要收：查询构造器 `.from(reviewSchedules)`，以及关系.query 的
 * `query.reviewSchedules.findMany(…)`。第一版只认前者，于是复习队列那一读（`review/service.ts:220`
 * 分页取行、`:447` 按目标回查安排）**整段不在台账里**——台账写着 20 处、真实是 22 处，
 * 而"分母自证"那条照样绿（它只数它自己认得的那种形状）。这就是分类边界上必须单造样本的原因。
 *
 * 窗口只到**这一条语句结束**（第一个 `;`，或下一处同类匹配点）为止，不是固定往后取若干字符：
 * 第一版取 700 字符，于是同一文件里紧邻的两处读点会互相污染——前一处不筛维度的读，
 * 因为窗口里捞到了后一处的 `reviewSchedules.reviewDimension` 被判成"认得维度"，
 * 台账就这么少记一处（真造探针时才发现，见下面那条"邻近的第二处不许污染前一处"的用例）。
 */
const READ_SHAPES = [
  /\.from\(\s*reviewSchedules\s*\)/,
  /\.query\.reviewSchedules\.findMany\b/,
];

function readSitesIn(file: string, source: string): Array<{ file: string; dimensionAware: boolean }> {
  const starts: number[] = [];
  for (const shape of READ_SHAPES) {
    for (const match of source.matchAll(new RegExp(shape.source, "g"))) starts.push(match.index ?? 0);
  }
  return starts.sort((a, b) => a - b).map((at) => {
    const tail = source.slice(at);
    const nextShape = Math.min(
      ...READ_SHAPES.map((shape) => {
        const rest = tail.slice(1).search(new RegExp(shape.source, ""));
        return rest === -1 ? Number.MAX_SAFE_INTEGER : rest + 1;
      }),
    );
    const endsAt = Math.min(
      (tail.indexOf(";") === -1 ? Number.MAX_SAFE_INTEGER : tail.indexOf(";") + 1),
      nextShape,
      900,
    );
    return { file, dimensionAware: /reviewDimension/.test(tail.slice(0, endsAt)) };
  });
}

/**
 * 还不认识这一维的读点，按文件数。逐处修好就把对应那条删掉。
 *
 * 值的第二种形状是 `{ count, reason }`：**读点照旧登记在案**，同时写明为什么它这一处
 * 不用改成按维度筛。台账不许因为"这一处没关系"就少登一条——那正是它当初漏登的那一类；
 * 写明理由，理由本身也在这份文件里对着代码，过期了会有人看见。
 *
 * ── 2026-10-01：维度写入方已经启用 ──────────────────────────────────────
 * 当前有五处非空维度调用，精确路径由下方用例登记。两条会挑错行的读点已支持维度并从台账删掉：
 *   - `run-service.ts` 的 `findPending`（原来按 subject 取一条、generation 倒序 limit 1；
 *     两行 generation 都是 1 ⇒ 这一次答的是提取却可能消费掉"应用"那条）。
 *   - `run-processing-tick.ts` 的 `clampToManualDateV2`（原来按 subject limit 1 且无排序 ⇒
 *     另一格的手动日期会来压住这一格的日期）。
 *
 * 剩余未筛维度的读点仍逐文件登记。只有 `{ count, reason }` 明确列出理由的条目才算审查过；
 * 数字条目仍待结合各自业务语义处理，不能据此断言它们无需修改。
 */
type BlindReaderEntry = number | { readonly count: number; readonly reason: string };
const READERS_BLIND_TO_DIMENSION: Record<string, BlindReaderEntry> = {
  "apps/api/src/modules/card-generation-v2/card-service.ts": 2,
  "apps/api/src/modules/export/service.ts": 2,
  // 2026-09-30：维度改成**数据驱动**之后（`readHeldScheduleDimensionV2`
  // 从 `reviewSchedules.review_dimension` 读），读侧这一族新增了四处。
  // 台账跟的是**实际读点**，不是当初那几个文件——数字取自这条用例自己的报错。
  "apps/api/src/modules/learning-dashboard/home-suggestion-service.ts": 1,
  "apps/api/src/modules/learning-dashboard/learning-batch-service.ts": 1,
  "apps/api/src/modules/note-deepening/note-deepening-service.ts": 1,
  "apps/api/src/modules/review/objective-review-holds.ts": 1,
  "apps/api/src/modules/learning-dashboard/service.ts": 1,
  "apps/api/src/modules/learning-objectives/surface-service.ts": 2,
  "apps/api/src/modules/learning-runs/processing/run-processing-tick.ts": 2,
  "apps/api/src/modules/learning-runs/run-service.ts": 2,
  "apps/api/src/modules/review/review-defer-service.ts": 1,
  "apps/api/src/modules/review/service.ts": 3,
  // W5-4 刀一（0297）：这一处**按主键**读一行——用户处理的是界面上那颗具体提醒，
  // 它的身份就是这一行的 id（`eq(reviewSchedules.id, ...)` 加空间与人）。
  // "同一目标两条不同维度的安排会被重复计数"这个风险在这里不存在：一次读取返回至多一行，
  // 而那一行正是她点的那个。补一个维度条件只会要求客户端同时交出维度（队列今天不下发它），
  // 或者把一条合法的处理判成冲突。
  "apps/api/src/modules/review/one-time-reminder-service.ts": {
    count: 1,
    reason: "按主键读单行；acknowledge 处理的是这一个 schedule 实例，不是「同一目标的那一格」",
  },
  "apps/api/src/modules/stats/service.ts": 2,
  "apps/api/src/modules/note-deepening/topology-repository.ts": 1,
  "apps/api/src/modules/understanding/projection-read-service.ts": 1,
  "apps/api/src/modules/understanding/route-plan-service.ts": 1,
};

/** 台账的两种形状归一成"这一文件有几处"，让比对只有一个分母。 */
function expectedBlindCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [file, entry] of Object.entries(READERS_BLIND_TO_DIMENSION)) {
    out[file] = typeof entry === "number" ? entry : entry.count;
  }
  return out;
}

function blindReaderCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const site of runtimeSources().flatMap((f) => readSitesIn(f.rel, f.text))) {
    if (!site.dimensionAware) out[site.file] = (out[site.file] ?? 0) + 1;
  }
  return out;
}

/**
 * 找出**调用方**给边界传了非空维度的源码位置。
 *
 * 判据锚的是"这一发调用里带了 `reviewDimension` 那一格"，不是全文出现这个标识符——
 * schema 里那一列的声明（`reviewDimension: text("review_dimension")`）与边界的入参类型
 * 都含同名文本，按全文匹配会把它们误判成有人开始写维度（第一版就是这么红的）。
 */
function dimensionNamingCallersIn(file: string, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/ensurePendingReviewScheduleV2\s*\(/g)) {
    const at = match.index ?? 0;
    if (/reviewDimension\s*:/.test(text.slice(at, at + 900))) out.push(`${file}:这一发调用带了维度`);
  }
  return out;
}

function dimensionNamingCallers(): string[] {
  // 边界文件自己排除：它体内那一处 `reviewDimension: dimension` 就是"往那一格写"的机制本身，
  // 不是调用方。名单守卫检查调用方增减是否经过读侧审查。
  return runtimeSources()
    .filter((f) => f.rel !== BOUNDARY_FILE)
    .flatMap((f) => dimensionNamingCallersIn(f.rel, f.text));
}

test("读侧台账的分母自证：28 处读点，认得维度的都只**转发**调用方给的那一档", () => {
  const sources = runtimeSources();
  const all = sources.flatMap((f) => readSitesIn(f.rel, f.text));
  assert.equal(all.length, 28,
    `读点合计与现读数不同（得到 ${all.length}）：walk 坏了或有人新增/删了读点`);
  assert.equal(all.filter((s) => s.dimensionAware).length, 3,
    "认得维度的读点数量变了——边界那一条，加上一条**接收**了调用方维度并转发下去的那几条");

  /**
   * 2026-09-30：分母从 23 涨到 28、认维度的从 1 涨到 3。
   *
   * 逐处核过：新认得维度的那两处（`run-processing-tick.ts` 的 `input.reviewDimension`
   * 与 `run-service.ts` 的 `reviewDimension`）都是**函数入参**，不是自己定的维度。
   * 原判据写的是「只有边界认得维度」，那是在只有一个读者的时候写的；
   * 边界把维度解析出来、交给调用方，读点照着转发，是同一条链的下半段。
   *
   * 所以把「认不认维度」换成**更有意义的那条**：认维度的读点，
   * 一律不许**写死**一档。写死才是真的绕过边界——它会让某一份安排在一个看不见的维度上。
   * 这条比原来的计数严：原来只数个数，现在要检查它怎么用。
   */
  const hardcoded: string[] = [];
  for (const f of sources) {
    if (!readSitesIn(f.rel, f.text).some((site) => site.dimensionAware)) continue;
    // `eq(reviewSchedules.reviewDimension, "card")` / `, 3)` 这种形状 = 写死
    if (/reviewSchedules\.reviewDimension\s*,\s*(["'`]|\d)/.test(f.text)) {
      hardcoded.push(f.rel);
    }
  }
  assert.deepEqual(hardcoded, [],
    "这些读点把 reviewDimension **写死**成了一档字面量——那才是绕过边界："
    + "边界解析出来的维度会被这一处悄悄忽略。认维度可以，写死不行：\n  " + hardcoded.join("\n  "));
});

test("读侧判据本身灵敏：带维度判据要认得出，不带的一处都不许算成认得", () => {
  const aware = `const rows = await tx.select().from(reviewSchedules).where(and(
    eq(reviewSchedules.workspaceId, workspaceId),
    eq(reviewSchedules.reviewDimension, dimension),
  ))`;
  const blind = `const rows = await tx.select().from(reviewSchedules).where(and(
    eq(reviewSchedules.workspaceId, workspaceId),
    eq(reviewSchedules.subjectId, objectiveId),
  ))`;
  assert.deepEqual(readSitesIn("f.ts", aware).map((s) => s.dimensionAware), [true]);
  assert.deepEqual(readSitesIn("f.ts", blind).map((s) => s.dimensionAware), [false]);
  // 同一文件里紧邻的两处：不筛维度的那一处**不许**因为后面有人筛了就被判成认得。
  const neighbor = `${blind};\n${aware};`;
  assert.deepEqual(readSitesIn("f.ts", neighbor).map((s) => s.dimensionAware), [false, true],
    "前一处被后一处的判据污染 ⇒ 台账会少记不认维度的读点");
  // 关系.query 那一形（复习队列就是用它取行的）也必须进台账：只认 `.from(` 的判据会把整个
  // `review/service.ts` 少记两处，而分母自证照样绿——这就是这一条要单独造样本的原因。
  const relational = `const fetched = await queryDb.query.reviewSchedules.findMany({\n  where,\n  orderBy: (r) => [asc(r.nextReviewAt)],\n});`;
  assert.deepEqual(readSitesIn("queue.ts", relational).map((s) => s.dimensionAware), [false],
    "关系.query 的取行没被算成读点");
  const relationalAware = `await queryDb.query.reviewSchedules.findMany({ where: eq(reviewSchedules.reviewDimension, d) });`;
  assert.deepEqual(readSitesIn("queue.ts", relationalAware).map((s) => s.dimensionAware), [true]);
});

test("不认维度的读点逐文件登记在案：新增一处红，改好一处就把那条删掉", () => {
  assert.deepEqual(blindReaderCounts(), expectedBlindCounts(),
    "读侧维度台账与代码不一致。新增读点：同一目标哪天有第二条维度安排时它会读错；"
      + "改好了某处：把对应那条从清单里删掉（这份清单只能变短）。");
});

test("写明「不用改」的那几条，理由不许是空话：每一处都要说清它为什么不会被维度重复计数", () => {
  const explained = Object.entries(READERS_BLIND_TO_DIMENSION)
    .filter(([, entry]) => typeof entry !== "number")
    .map(([file, entry]) => ({ file, reason: (entry as { reason: string }).reason }));
  for (const { file, reason } of explained) {
    assert.ok(reason.length >= 20, `${file} 登记了"不用改"，理由却只有 ${reason.length} 个字`);
    // 理由里必须指认这一处**实际**按什么读——只说"没关系"的那些，早晚会碰上真有关系的那个。
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const keyedByRow = source.includes("eq(reviewSchedules.id,");
    assert.ok(
      keyedByRow || /计数|聚合|单行|至多一行/.test(reason),
      `${file} 的理由没有指认这一处按什么读，也没有说明它为什么不会被重复计数`,
    );
  }
});

test("维度写入调用方保持登记，新增调用必须先复核读侧台账", () => {
  const expected = [
    "apps/api/src/modules/card-generation-v2/activation-service.ts:这一发调用带了维度",
    "apps/api/src/modules/review/note-subscription-schedule.ts:这一发调用带了维度",
    "apps/api/src/modules/review/objective-review-holds.ts:这一发调用带了维度",
    "apps/api/src/modules/review/one-time-reminder-service.ts:这一发调用带了维度",
    "apps/api/src/modules/review/shared-card-review-service.ts:这一发调用带了维度",
  ];
  assert.deepEqual(dimensionNamingCallers().sort(), expected,
    "维度写入方新增或迁移时，先审查对应读侧并同步这份清单");
  // 判据自身也要灵敏：schema 列声明含同名字段不能误报，真实调用必须被识别。
  assert.deepEqual(dimensionNamingCallersIn("schema.ts",
    'reviewDimension: text("review_dimension").notNull().default(""),'), [],
    "列声明被判成调用方传了维度");
  assert.equal(dimensionNamingCallersIn("caller.ts",
    `await ensurePendingReviewScheduleV2(tx, {\n  subjectId,\n  reviewDimension: "apply",\n})`).length, 1,
    "真的传了维度却没被判出来 ⇒ 这枚触发器是空的");
});
