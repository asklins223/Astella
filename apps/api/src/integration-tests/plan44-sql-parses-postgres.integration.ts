/**
 * 方案 44 的 SQL 在**真实 PostgreSQL 解析器**上过一遍（只解析，不执行）。
 *
 * ## 为什么需要这条
 *
 * 这一轮在真库上抓到的几个缺陷里，两个的单测是**源码文本断言**：
 *   - `readConversationSummaryChain` 的递归 CTE：锚点项带 `ORDER BY … LIMIT 1`
 *     却没加括号，且迭代项里被**追加**了一段重复的 `JOIN chain … WHERE …`；
 *   - `readPastConversationMessages` 取了 `companion_messages.page_context`——那一列
 *     只存在于 `companion_turn_runs`。
 *
 * 前者是 `syntax error at or near "UNION"`，后者是 `column … does not exist`。
 * **文本断言看不见这两种错**：文件里那段文字确实在，测试因此全绿；而查询根本无法解析。
 *
 * 所以这里不再断言文本，而是把代码里的 SQL 交给真实的 parser。`EXPLAIN` 只解析不执行，
 * 不需要夹具、不会写数据、也不会碰到任何真实数据。
 *
 * ## 为什么改成自动发现
 *
 * 第一版只用手写正则抠了两条 SQL——覆盖面就是那两条，其余 SQL 写错了没人管，
 * 新加一条查询还得记得回来改这个测试。现在改成**扫源码里所有 `sql\`…\`` 模板**，
 * 抠出来逐条送 `EXPLAIN`：新增查询不用改这里，测试自己会跟上。
 *
 * 自动发现的代价是模板里有 `${…}` 插值。三条原则：
 *   1. **占位必须类型正确**——否则报错变成「类型不匹配」而不是真正的语法/列错误，
 *      把注意力引到别处（第一版全填 `1`，于是每个 uuid 比较都报
 *      `operator does not exist: uuid = integer`）。
 *   2. **能拿到真实文本的就不猜**：`cond ? sql\`AND …\` : sql\`\`` 和模块级
 *      `const fragment = sql\`…\`` 直接内联源码原文——那正是运行时会拼出来的字符串，
 *      用它不会引入生产里不存在的错。
 *   3. **实在判断不了的宁可跳过**，并在报告里逐条列出。瞎猜一个占位符只会报
 *      「类型不匹配」，既不是真缺陷，又会把真缺陷藏起来。
 *
 * 外加一层**逐槽重试**：类型实在猜不准时，同一条 SQL 会逐个换掉某一个占位符再解析一次。
 * 任何一组过得了就算过；几组全挂时才看报错属于哪一类——`syntax error` 与
 * `does not exist` 判为守卫失败，其余（`operator does not exist` 之类）归入
 * 「占位符判断不了」单独列出，**不**让守卫误伤。
 *
 * ## 返回 SQL 片段的函数：把函数体**内联**进调用点
 *
 * 上面那套自动发现有一类东西它够不着：`companionHistoryCondition()`、
 * `tzSubquery()`、`visibleCompanionCardSourceCondition()`、
 * `visibleCompanionDueReviewCondition()` 这类函数**返回一段 SQL 条件**，
 * 运行时才和调用点的模板拼成完整语句。占位符顶不掉它们——顶掉的话，
 * 被验证的就不是运行时会跑的那段文字了（第一版只能整条跳过）。
 *
 * 所以这里做的是**源码层面的内联**：按名字找到函数声明，抠出它的形参表与函数体，
 * 把函数体里那条 `return` 的 `sql` 模板按**调用点的实参**绑好后原样展开。
 * 展开出来的就是运行时会拼出的那一段，所以
 *   - 真正被验证的仍然是生产里那段 SQL；
 *   - 验证到的外层语句也跟着补齐了（之前 `${…}` 顶不掉，整条语句整条跳过）。
 *
 * 绑实参时的纪律仍然是「**不猜**」：
 *   - 实参是**双引号字符串**（`"source_note"` 这类表别名/标识符）→ 去掉引号当 SQL 文本原样内联。
 *     这里必须原样：顶成占位符会得到 `'x'.share_scope`，而带引号会得到 `FROM notes 'source_note'`，
 *     两者都不是生产里会出现的写法。
 *   - 实参是**单引号字符串**（`'00000000-…'` 这类值）→ 引号留着，它在 SQL 里就是一个值。
 *   - 实参是 `sql` 模板 / 模板字面量 → 照常按分段展开，于是模板里对**外层形参**的
 *     引用（`` `'${userId}'::uuid` ``）能顺着作用域链解析到外层；这种「引号包一个插值」
 *     的形状会把源码自己写的那对引号去掉，只留插值与后面的 `::uuid`——否则会叠成
 *     `''00000000-…'::uuid`，那是本守卫自己造出来的写法。
 *   - 实参是**对象字面量** → 逐属性绑定，于是 `ref.subjectId` 这类成员引用能取到实参值。
 *   - 其余（标识符、成员表达式、调用）→ 按**形参名**分类。刻意不看签名上的
 *     `: string`：`conversationId: string` 装的是 uuid，看注解会把 uuid 猜成文本。
 *   - 定不下来 → 跳过，并把原因写进报告，绝不拿一个猜的占位符去制造假缺陷。
 *
 * 什么算「返回 SQL 片段」也不靠名单，靠**函数体本身**的形状：
 *   - 唯一的顶层 `return` 是一条 `sql` 标签 → SQL 片段，内联；
 *   - 唯一的顶层 `return` 是普通模板字面量，且**每个插值都是形参本身**（`${alias}`、
 *     `${viewerExpr}`）→ 它是个字符串拼装器（`sql.raw` 的典型来源），同样内联成原文；
 *   - 唯一的顶层 `return` 是一次调用，而它调的也是一个 SQL 片段生产者 → 转手内联
 *     （`visibleCompanionDueReviewCondition()` 就是 `return reviewScheduleTargetsConsumableCardPredicate({…})`）；
 *   - 声明了 `string` / `number` / `boolean` / `bigint` 返回类型且 return 是标量表达式
 *     → 它就是个**值**（`summarizerJobKey()`），按类型占位，不内联。
 * 这几条把「拼 SQL 的」和「算值的」分开，不靠人维护名单，也不改任何被测源码。
 *
 * ## 跳过的三种，不该混成一种
 *
 * 自动发现会把**片段本身**也列成一条模板（`const stats = sql\`LEFT JOIN …\``），
 * 它单独 EXPLAIN 不了，但它的原文**已经**被内联进某条完整语句里、送去解析过了。
 * 把它算成「跳过」会让人以为这里没验证过。所以报告分成：
 *   - **跳过**：真的验证不到（原因逐条列出）；
 *   - **已内联覆盖**：片段原文已被某条完整语句带着过了一遍真实 parser；
 *   - **空片段**：`sql\`\`` 这类运行时不产生任何 SQL 文本的写法，没有可验证的内容。
 *
 * 运行：DATABASE_URL_API=... npm run test:plan44-sql:postgres
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// 夹具要写 users/workspaces，而 users 的 RLS 只放行「id = app.user_id」的自插入——
// 受限的 api 角色插不进第二个用户（真库报 42501）。所以按仓库约定：
// **夹具写入用 migrator，被测代码的读写用受限角色**（见 integration-test-db-env）。
// 这条守卫只解析不写，因此优先用 api 角色；没有时才退回仓库约定的顺序。
const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!CONN) throw new Error("DATABASE_URL_API 未配置——44 的 SQL 解析守卫要求真实 Postgres");

const client = postgres(CONN, { max: 1, prepare: false });
after(async () => { await client.end({ timeout: 5 }).catch(() => {}); });

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");

/**
 * 扫描范围＝方案 44 的 SQL 实际承载的文件。
 * 改这个列表时连带确认：新加的文件里确实有 `sql` 模板，别放进来当摆设。
 */
const SOURCE_FILES = [
  "workers/ai-worker/src/handlers/companion-dialogue-store.ts",
  "workers/ai-worker/src/handlers/companion-summary-retrieval.ts",
  "workers/ai-worker/src/handlers/companion-summarizer.ts",
  "workers/ai-worker/src/handlers/companion-tool-execution.ts",
  "packages/agent-host/src/methods.ts",
  "packages/agent-host/src/compaction-state.ts",
] as const;

/**
 * **只查函数定义、不参与自动扫描**的文件。
 *
 * 返回 SQL 片段的函数大多不住在被扫描的文件里：`tzSubquery()` 与两个
 * `visibleCompanion*Condition()` 在 companion-here-and-now.ts，判据本身在
 * `@astella/shared`。不给它们单独一份定义语料，函数体内联就没法展开——
 * 而内联出来的正是它们最终进入的那些语句的原文。
 *
 * 这里只放**确实被上面那批模板调用**的文件；放多了不会让守卫误判（不会产生新语句），
 * 但会让「新增文件」变成一件需要判断的事，所以从紧。
 */
const FRAGMENT_DEFINITION_FILES = [
  "workers/ai-worker/src/handlers/companion-here-and-now.ts",
  "packages/shared/src/note-visibility.ts",
  "packages/shared/src/review-consumable-target.ts",
] as const;

/** 函数定义与 `const` 片段都要跨文件找，所以统一成一张语料表。 */
const CORPUS = new Map<string, string>(
  [...SOURCE_FILES, ...FRAGMENT_DEFINITION_FILES].map((rel) => [rel as string, repoFile(rel)]),
);

// ---------------------------------------------------------------------------
// 1. 模板字面量扫描
// ---------------------------------------------------------------------------

type Part = { kind: "text" | "sub"; start: number; end: number };
type Template = { tick: number; end: number; parts: Part[] };

/**
 * 从**起始反引号**开始解析一个模板字面量，返回内部的分段（文本 / `${…}` 插值）。
 *
 * 必须真的逐字符走而不是上正则：SQL 模板里有 `'…'` 字符串、`--` 注释，以及
 * `${…}` 里嵌着的模板与花括号（`JSON.stringify({…})`）。正则分不清
 * `` ` `` 是模板结尾还是字符串里的字符——那正是本仓库踩过的坑（sql 标签里写反引号
 * 会把模板提前截断，见 companion-summary-retrieval 的注释）。
 */
function parseTemplateLiteral(src: string, tick: number): { parts: Part[]; end: number } {
  const parts: Part[] = [];
  let i = tick + 1;
  let textStart = i;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") { parts.push({ kind: "text", start: textStart, end: i }); return { parts, end: i + 1 }; }
    if (ch === "$" && src[i + 1] === "{") {
      parts.push({ kind: "text", start: textStart, end: i });
      const exprStart = i + 2;
      let j = exprStart;
      let depth = 0;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === '"' || c === "'") {
          const quote = c;
          j += 1;
          while (j < src.length) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === quote) break; j += 1; }
          j += 1;
          continue;
        }
        if (c === "`") { j = parseTemplateLiteral(src, j).end; continue; }
        if (c === "$" && src[j + 1] === "{") { depth += 1; j += 2; continue; }
        if (c === "{") { depth += 1; j += 1; continue; }
        if (c === "}") { if (depth === 0) break; depth -= 1; j += 1; continue; }
        j += 1;
      }
      parts.push({ kind: "sub", start: exprStart, end: j });
      i = j + 1;
      textStart = i;
      continue;
    }
    i += 1;
  }
  parts.push({ kind: "text", start: textStart, end: src.length });
  return { parts, end: src.length };
}

/** 文件里所有 `sql\`` 模板（含嵌在 `${…}` 里的片段），按出现顺序。 */
function scanSqlTemplates(src: string): Template[] {
  const found: Template[] = [];
  let i = 0;
  while (i < src.length) {
    const idx = src.indexOf("sql`", i);
    if (idx === -1) break;
    const before = idx > 0 ? src[idx - 1]! : "";
    // `` 不算（`` 不是标签）；`x.sql`` 也不该被当成标签。
    if (before && /[A-Za-z0-9_$.]/.test(before)) { i = idx + 4; continue; }
    const parsed = parseTemplateLiteral(src, idx + 3);
    found.push({ tick: idx + 3, end: parsed.end, parts: parsed.parts });
    i = parsed.end;
  }
  return found;
}

const lineAt = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/** 只取顶层模板：嵌在别的模板 `${…}` 里的片段单独摘出来没有意义。 */
function topLevelTemplates(src: string): Template[] {
  const out: Template[] = [];
  let cursor = -1;
  for (const tpl of scanSqlTemplates(src)) {
    if (tpl.tick < cursor) continue;
    cursor = tpl.end;
    out.push(tpl);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. `${…}` 的处理：能用真实文本就内联，能定类型就占位，其余跳过
// ---------------------------------------------------------------------------

type SlotKind = "int" | "bigint" | "uuid" | "text" | "json" | "timestamptz" | "generic" | "textArray" | "uuidArray";

/** 标识符常量（不是字符串字面量）在文本里的替身：编译期就定下来的数，直接写死。 */
const IDENTIFIERS: Record<string, string> = {
  MAX_SUMMARY_CHAIN_DEPTH: "8",
  MAX_PAST_CONVERSATION_MESSAGES: "20",
};

const UUID0 = "'00000000-0000-4000-8000-000000000000'";

/**
 * 每个类型在**几个变体**下各用什么字面量。
 *
 * 第 0 个是按名字推断的主猜测，后面的变体在主猜测报「类型不对」时兜底重试。
 * `'0'` / `'x'` 这类**带引号**的字面量对 PG 来说是 unknown 类型，会被上下文收敛成
 * 目标类型——所以同一个占位符能同时顶 int、bigint 和 text。
 */
const LITERALS: Record<SlotKind, readonly string[]> = {
  int: ["1", "'0'", "0", UUID0, "now()", "'x'"],
  bigint: ["0", "'0'", "0", UUID0, "now()", "'x'"],
  uuid: [UUID0, UUID0, "'0'", "0", "now()", "'x'"],
  // 末尾两个是**数组字面量**：`'x'::text[]` 会被 PG 当成数组字面量而报
  // `malformed array literal`，得写成 `'{x}'::text[]`。这两种写法同时也是合法的
  // 普通文本字面量，加进池子不会把原本就对的地方弄坏。
  text: ["'x'", UUID0, "'0'", "now()", "'{x}'", "'{00000000-0000-4000-8000-000000000000}'"],
  // 数组类型不能拿标量字面量去顶：`'x'::text[]` 会被 PG 当成数组字面量解析而报
  // `malformed array literal`。这两个池子只在**后面跟着 `::…[]` 强转**时才用得上。
  textArray: ["'{x}'", "'{00000000-0000-4000-8000-000000000000}'", "'x'", "0"],
  uuidArray: ["'{00000000-0000-4000-8000-000000000000}'", "'{x}'", "'x'", "0"],
  json: ["'{}'", "'x'", "'0'", "0"],
  timestamptz: ["now()", "'x'", "'0'", UUID0, "0"],
  generic: ["'x'", "'0'", UUID0, "now()", "'{x}'", "0"],
};

/**
 * 紧跟在占位后面的**显式强转**是最硬的类型证据：`${fromSeq.toString()}::bigint`
 * 就是要 bigint，`${patterns}::text[]` 就是要一个数组。这不是猜——是源码自己写的。
 *
 * 匹配整段类型名（`^…$`）：`uuid[]` 要排在 `uuid` 前面，且不能靠词边界——
 * `]` 后面接的是 `)`，`\b` 在那里不成立，第一版就这么漏掉了 `${idsLiteral}::uuid[]`。
 */
const CAST_KINDS: Array<[RegExp, SlotKind]> = [
  [/^(timestamptz|timestamp)$/i, "timestamptz"],
  [/^uuid\[\]$/i, "uuidArray"],
  [/^(varchar|text)\[\]$/i, "textArray"],
  [/^jsonb?$/i, "json"],
  [/^uuid$/i, "uuid"],
  [/^(bigint|int8|smallint|int2|int4|integer|numeric)$/i, "bigint"],
];

/**
 * 按**表达式名字**分类，不去猜上下文——猜上下文的那版在两种 SQL 上各错一次
 * （uuid 当成 bigint、bigint 当成 uuid），比不猜还慢。名字是确定的：
 * 带 Id / Id 结尾的是 uuid，带 Seq 的是 bigint，limit 是整数，其余是文本。
 *
 * 顺序有讲究：Seq / revision 必须排在 Id 前面——`memoryRevision` 不是 uuid。
 */
const NAME_KINDS: Array<[RegExp, SlotKind]> = [
  [/seq/i, "bigint"],
  // `attempts$` 用复数：`attemptedAt` 是时间戳，被 `/attempt/` 误收成整数就会变成
  // `1::timestamptz`（PG 报 cannot cast type integer to timestamp）。
  [/revision|depth|limit|offset|count|generation|epoch|batch|attempts$|priority|ttl/i, "int"],
  // 时长倍数：`interval '1 day'` 里那个 1 必须是数字，带引号的 `'1'` 乘不出 interval。
  [/^(days|hours|minutes|seconds|weeks|months|years)$/i, "int"],
  [/At$|_at$|timestamp$/i, "timestamptz"],
  [/(^|_)id$|Id$|Ids$/i, "uuid"],
  [/(^|_)policy_version$|_VERSION$/i, "int"],
];

/** 这些函数**返回 SQL 片段**而不是标量值（读过定义确认），占位符顶不掉。 */
const KNOWN_SQL_FRAGMENT_FUNCTIONS = new Set([
  "companionHistoryCondition",
  "tzSubquery",
  "visibleCompanionDueReviewCondition",
  "visibleCompanionCardSourceCondition",
  "noteVisibleSqlText",
  "reviewScheduleTargetsConsumableCardPredicate",
]);

/** 声明成这些标量返回类型的函数返回的是**值**，占位即可，不必内联。 */
const SCALAR_RETURN_KINDS: Record<string, SlotKind> = {
  string: "text",
  number: "int",
  boolean: "generic",
  bigint: "bigint",
};

type Segment = string | { kind: SlotKind; expression: string };
type Resolved = { ok: true; segments: Segment[] } | { ok: false; reason: string };

const MAX_INLINE_DEPTH = 4;

/**
 * 解析过程中的作用域：一个片段被内联进调用点后，函数体的形参要能取到调用点的实参，
 * 而模板里对**外层**形参的引用（`noteVisibleSqlText("source_note", "'${userId}'::uuid")`
 * 里的 `${userId}`）也得能顺着链子解析回外层。所以形参绑定按栈存放，内层在前。
 */
type Binding = { segments: Segment[] } | { props: Map<string, Binding> };
type Ctx = {
  /** 当前正在解析的源码文件：`const` 片段与函数体都按**作用域**在它里面找。 */
  file: string;
  /** 当前正在解析的那份源码文本（自证用例塞进来的假源码也在里面）。 */
  text: string;
  scopes: Array<Map<string, Binding>>;
  /** 已经**原样**内联进某条语句的片段文本（空白归一后），用来认定「已内联覆盖」。 */
  inlined: string[];
  depth: number;
};

const isProps = (binding: Binding): binding is { props: Map<string, Binding> } => "props" in binding;

const makeCtx = (file: string, text: string): Ctx => ({ file, text, scopes: [], inlined: [], depth: 0 });

/** 取表达式里最后一个标识符段：`args.userId` → `userId`，`run.id` → `id`。 */
function lastNameSegment(expression: string): string {
  const cleaned = expression.trim().replace(/[()\s]/g, "");
  const parts = cleaned.split(/[.?\[\]:'"]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cleaned;
}

function classifyExpression(expression: string): SlotKind | null {
  const name = lastNameSegment(expression);
  if (!name) return null;
  for (const [pattern, kind] of NAME_KINDS) if (pattern.test(name)) return kind;
  return "text";
}

/** 从 `open` 处的括号开始，跳过配对的那一个，返回它的下标。跳过注释：文件里的注释有括号。 */
function skipBalanced(expr: string, open: number): number {
  const opens = "([{";
  let depth = 0;
  let i = open;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "/" && expr[i + 1] === "/") {
      const nl = expr.indexOf("\n", i);
      i = nl === -1 ? expr.length : nl + 1;
      continue;
    }
    if (c === "/" && expr[i + 1] === "*") {
      const close = expr.indexOf("*/", i + 2);
      i = close === -1 ? expr.length : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < expr.length) { if (expr[i] === "\\") { i += 2; continue; } if (expr[i] === quote) break; i += 1; }
      i += 1;
      continue;
    }
    if (c === "`") { i = parseTemplateLiteral(expr, i).end; continue; }
    if (opens.includes(c)) { depth += 1; i += 1; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return expr.length - 1;
}

/** 在最外层（不在字符串/模板/括号/注释里）找分隔符。 */
function topLevelIndex(expr: string, needle: string, from = 0): number {
  let i = from;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "/" && expr[i + 1] === "/") {
      const nl = expr.indexOf("\n", i);
      i = nl === -1 ? expr.length : nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < expr.length) { if (expr[i] === "\\") { i += 2; continue; } if (expr[i] === quote) break; i += 1; }
      i += 1;
      continue;
    }
    if (c === "`") { i = parseTemplateLiteral(expr, i).end; continue; }
    // 针脚**先**判再跳：找的正是 `{` 时，跳过成对括号会把要找的那个字符吃掉
    // （函数体起点就是这么找的，先跳过就永远找不到）。
    if (expr.startsWith(needle, i)) return i;
    if ("([{".includes(c)) { i = skipBalanced(expr, i) + 1; continue; }
    i += 1;
  }
  return -1;
}

/** 按顶层逗号切分实参/形参列表。 */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  if (expr.trim() === "") return out;
  let rest = expr;
  while (true) {
    const comma = topLevelIndex(rest, ",");
    if (comma === -1) { out.push(rest.trim()); break; }
    out.push(rest.slice(0, comma).trim());
    rest = rest.slice(comma + 1);
  }
  // 尾逗号（`ref: {…} = {…},`）不算一项——留着会让形参表多出一个空名字，
  // 而「解析出了空形参名」会被当成「这个定义看不懂」，于是整条查询被静默跳过。
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * 去掉 TS 表达式里的注释（字符串与模板内部的原样保留）。
 *
 * 实参文本是**源码切片**，里面带着调用点原本的注释——`visibleCompanionDueReviewCondition()`
 * 传给判据构造器的那个对象字面量中间就夹着三行 `// 争议按个人读…`。不剥掉的话，
 * 「对象的键」会连注释一起被当成键名而拒绝内联。只剥 `//` 与 `/* *\/`，不碰 SQL 自己的
 * `--`；字符串/模板里的 `//`（URL）原样保留。
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < text.length) { if (text[j] === "\\") { j += 2; continue; } if (text[j] === quote) break; j += 1; }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const end = parseTemplateLiteral(text, i).end;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function ternaryBranches(expr: string): { whenTrue: string; whenFalse: string } | null {
  const q = topLevelIndex(expr, "?");
  if (q === -1) return null;
  const rest = expr.slice(q + 1);
  const colon = topLevelIndex(rest, ":");
  if (colon === -1) return null;
  return { whenTrue: rest.slice(0, colon), whenFalse: rest.slice(colon + 1) };
}

/** 在一份（或全部）源码里读 `const NAME = …` 的初始化表达式，要求只有一份写法。 */
function uniqueConstInitializer(name: string, only: string | null): string | null {
  const hits: string[] = [];
  const re = new RegExp(`(?:^|[\\n;])\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*`, "g");
  for (const source of only === null ? [...CORPUS.values()] : [only]) {
    for (const m of source.matchAll(re)) {
      const start = m.index + m[0].length;
      let i = start;
      let depth = 0;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") { i += 2; continue; }
        if (c === '"' || c === "'") {
          const quote = c;
          i += 1;
          while (i < source.length) { if (source[i] === "\\") { i += 2; continue; } if (source[i] === quote) break; i += 1; }
          i += 1;
          continue;
        }
        if (c === "`") { i = parseTemplateLiteral(source, i).end; continue; }
        if ("([{".includes(c)) { depth += 1; i += 1; continue; }
        if (")]}".includes(c)) { depth -= 1; i += 1; continue; }
        if (c === ";" && depth <= 0) break;
        i += 1;
      }
      hits.push(source.slice(start, i).trim());
    }
  }
  // 同一个名字有多份不同定义 → 运行时用哪份取决于作用域，不猜。
  const unique = [...new Set(hits.filter(Boolean))];
  return unique.length === 1 ? unique[0]! : null;
}

/**
 * 读 `const NAME = …` 的初始化表达式。
 *
 * **先按作用域找**：同名常量在别的文件里完全可以是另一个东西——`stats` 在
 * methods.ts 是那段 `LEFT JOIN LATERAL`，在 companion-tool-execution.ts 是一个统计
 * 对象。只按名字全局找会把这两份凑成「多份不同定义」而整条丢掉（这版第一遍就这么
 * 把 `methods.ts` 的两条查询改坏成了 `FROM companion_procedural_playbooks p 'x'`）。
 *
 * 当前文件里找不到才跨文件找：函数体在别的文件里时，它引用的模块级常量
 * （`FALLBACK_TIMEZONE`）不在被扫描的那份源码里。
 */
function constInitializer(name: string, ctx: Ctx): string | null {
  return uniqueConstInitializer(name, ctx.text) ?? uniqueConstInitializer(name, null);
}

/**
 * 编译期原始字面量 → 它在 SQL 里的样子；不是字面量就返回 null。
 *
 * **字符串要加引号**：drizzle 把 `${FALLBACK_TIMEZONE}` 变成一个绑定参数，也就是 SQL 里的
 * `'Asia/Shanghai'`。直接去掉引号塞进去得到的是 `coalesce(…, Asia/Shanghai)`——那是个
 * **列引用**，于是同名的三处 `coalesce` 一起报 `column Asia/Shanghai does not exist`。
 * （本守卫第一版就这么把三条原本正确的查询改坏了，报表上看着像真缺陷，其实是它自己造的。）
 */
function sqlValueLiteral(init: string): string | null {
  const trimmed = init.trim();
  const quoted = trimmed.match(/^(?:"([^"\\]*)"|'([^'\\]*)')$/);
  if (quoted) return `'${(quoted[1] ?? quoted[2] ?? "").replace(/'/g, "''")}'`;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^(?:true|false)$/.test(trimmed)) return trimmed;
  return null;
}

/** 这个初始化表达式是不是「拼出来的一段 SQL」？是的话才值得内联。 */
function resolvesToSqlText(init: string): boolean {
  const trimmed = init.trim();
  if (/^sql\s*(<[^>]*>)?`/.test(trimmed)) return true;
  const branches = ternaryBranches(trimmed);
  if (!branches) return false;
  return [branches.whenTrue, branches.whenFalse].some((branch) => /^sql\s*(<[^>]*>)?`/.test(branch.trim()));
}

/** 在作用域栈里查一个（可能带成员访问的）表达式绑定。 */
function lookupBinding(expression: string, ctx: Ctx): Binding | null {
  const path = expression.trim().split(/[.?\[\]:'"`]+/).filter(Boolean);
  if (path.length === 0) return null;
  let current: Binding | undefined;
  for (const scope of ctx.scopes) {
    const head = scope.get(path[0]!);
    if (head) { current = head; break; }
  }
  if (!current) return null;
  for (const key of path.slice(1)) {
    if (!isProps(current)) return null;
    const next = current.props.get(key);
    if (!next) return null;
    current = next;
  }
  return current;
}

function resolveSubstitution(expression: string, ctx: Ctx): Resolved {
  const expr = expression.trim();
  if (ctx.depth > MAX_INLINE_DEPTH) return { ok: false, reason: "片段嵌套过深，放弃内联" };
  if (!expr) return { ok: true, segments: [{ kind: "generic", expression: expr }] };

  // (0) 引用**作用域里已绑定的形参**：`${conversationId}`、`${ref.subjectId}`。
  //     必须排在按名字分类之前——`ref.subjectType` 是裸列名，按名字会把它当文本。
  const bound = lookupBinding(expr, ctx);
  if (bound) {
    if (isProps(bound)) return { ok: false, reason: `\`${expr}\` 绑定的是一整个对象，不能当 SQL 值用` };
    return { ok: true, segments: bound.segments };
  }

  // (1) 本来就是一段 `sql` 标签——源码原文，直接内联。
  if (/^sql\s*(<[^>]*>)?`/.test(expr)) return inlineSqlTemplate(expr, ctx);

  // (2) `cond ? sql`…` : sql`…`` —— 用运行时会拼出来的那段原文。
  const ternary = ternaryBranches(expr);
  if (ternary) {
    const branches = [ternary.whenTrue.trim(), ternary.whenFalse.trim()];
    const declared = branches.filter((branch) => branch !== "");
    const usable = declared.filter((branch) => /^sql\s*(<[^>]*>)?`/.test(branch));
    if (usable.length > 0 && usable.length === declared.length) {
      const nonEmpty = usable.find((branch) => branch.length > "sql``".length) ?? usable[0]!;
      return inlineSqlTemplate(nonEmpty, ctx);
    }
  }

  // (3) 模块级 `const fragment = sql`…``（或由三元拼出来的）——同样是真实文本。
  //     只在初始化**确实是 SQL** 时才递归：`const snapshotId = typeof … ? … : null`
  //     这种普通变量递归进去只会把类型推断带偏（第一版就栽在这，uuid 一路掉成 'x'）。
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const init = constInitializer(expr, ctx);
    if (init && resolvesToSqlText(init)) return resolveSubstitution(init, ctx);
    // 编译期就定下来的**原始字面量**直接写成原文：`${FALLBACK_TIMEZONE}` 顶成 `'x'`
    // 也能过，但内联出来的就不是 `tzSubquery()` 运行时真正会拼出的那段了。
    const literal = init === null ? null : sqlValueLiteral(init);
    if (literal !== null) return { ok: true, segments: [literal] };
  }

  // (4) 明确是标量的调用：可以占位。
  const call = expr.match(/^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/);
  if (call) {
    const callee = call[1]!.replace(/\s+/g, "");
    if (callee === "JSON.stringify") return { ok: true, segments: [{ kind: "json", expression: expr }] };
    if (callee.endsWith(".join")) return resolveJoin(expr, ctx);
    if (callee.endsWith(".toString")) return { ok: true, segments: [{ kind: "text", expression: expr }] };
    // `sql.raw(片段)`：drizzle 原样插入，里面是什么就是什么——按文本展开即可。
    if (callee === "sql.raw") {
      const inner = firstCallArgument(expr);
      if (!inner) return { ok: false, reason: "sql.raw() 没有实参" };
      return resolveSubstitution(inner, ctx);
    }
    const fragment = inlineFragmentFunction(expr, callee, ctx);
    if (fragment) return fragment;
    return {
      ok: false,
      reason: KNOWN_SQL_FRAGMENT_FUNCTIONS.has(callee)
        ? `${callee}() 返回 SQL 片段，但函数体解析不出来，不猜`
        : `${callee}() 的返回值类型无法判断`,
    };
  }

  // (5) 其余按名字分类；分类不出来就不猜。
  const kind = classifyExpression(expr);
  if (!kind) return { ok: false, reason: `表达式 \`${expr}\` 无法归类` };
  return { ok: true, segments: [{ kind, expression: expr }] };
}

/** `sql.join(元素列表, 分隔符)`：只把列表缩到 1 个（内联其中一个元素），形状仍然合法。 */
function resolveJoin(expr: string, ctx: Ctx): Resolved {
  const args = splitTopLevel(callArgumentBody(expr));
  const listExpr = args[0] ?? "";
  const holder = /^[A-Za-z_$][\w$]*$/.test(listExpr) ? constInitializer(listExpr, ctx) ?? listExpr : listExpr;
  const tick = holder.indexOf("`", holder.indexOf("sql`"));
  // 分隔符本身也是一段 SQL 文本，记进「已内联」——否则 ` AND ` 这种连接词会被算成跳过。
  const separator = args[1];
  if (separator) {
    const resolved = resolveSubstitution(separator, ctx);
    if (resolved.ok) ctx.inlined.push(normalizeSql(renderSegments(resolved.segments)));
  }
  if (tick === -1) return { ok: true, segments: [{ kind: "generic", expression: expr }] };
  return templateSegments(parseTemplateLiteral(holder, tick), holder, ctx);
}

/** `callee( … )` 括号里的实参文本。 */
function callArgumentBody(expr: string): string {
  const open = expr.indexOf("(", expr.search(/[A-Za-z_$]/));
  if (open === -1) return "";
  const close = skipBalanced(expr, open);
  return expr.slice(open + 1, close);
}

/** 取 `callee( … )` 的**第一个**实参（按深度配平，跳过嵌套调用与字符串）。 */
function firstCallArgument(expr: string): string {
  return splitTopLevel(callArgumentBody(expr))[0] ?? "";
}

/** 把一个 `sql` 标签模板本身展开成 segments（内联真实片段走这条路）。 */
function templateSegments(
  tpl: { parts: Part[] },
  container: string,
  ctx: Ctx,
): Resolved {
  const segments: Segment[] = [];
  for (const [index, part] of tpl.parts.entries()) {
    if (part.kind === "text") { segments.push(container.slice(part.start, part.end)); continue; }
    const resolved = resolveSubstitution(container.slice(part.start, part.end), ctx);
    if (!resolved.ok) return resolved;
    segments.push(...refineByFollowingCast(resolved.segments, tpl.parts[index + 1], container));
  }
  return { ok: true, segments };
}

/** 占位后面紧跟着 `::类型` 时，用那个类型覆盖按名字猜出来的结果。 */
function refineByFollowingCast(
  segments: Segment[],
  next: Part | undefined,
  container: string,
): Segment[] {
  if (segments.length !== 1 || typeof segments[0] === "string" || next?.kind !== "text") return segments;
  const following = container.slice(next.start, next.end);
  const cast = following.match(/^\s*::\s*([A-Za-z_][\w]*(?:\[\])?)/);
  if (!cast) return segments;
  for (const [pattern, kind] of CAST_KINDS) {
    if (pattern.test(cast[1]!)) return [{ ...segments[0], kind }];
  }
  return segments;
}

function inlineSqlTemplate(text: string, ctx: Ctx): Resolved {
  const tick = text.indexOf("`");
  if (tick === -1) return { ok: false, reason: "片段里找不到模板内容" };
  const resolved = templateSegments(parseTemplateLiteral(text, tick), text, ctx);
  // 记下**原样内联**过的片段：它们随后会被送进真实 parser，报告里据此认定「已覆盖」。
  if (resolved.ok) ctx.inlined.push(normalizeSql(renderSegments(resolved.segments)));
  return resolved;
}

const normalizeSql = (text: string): string => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// 3. 返回 SQL 片段的函数：把函数体**内联**进调用点
// ---------------------------------------------------------------------------

type FunctionDef = { file: string; text: string; params: string[]; returnType: string; body: string };

/** 函数体里**顶层**（不在嵌套块/字符串/模板里）的 `return` 表达式列表。 */
function topLevelReturns(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close === -1 ? body.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < body.length) { if (body[i] === "\\") { i += 2; continue; } if (body[i] === quote) break; i += 1; }
      i += 1;
      continue;
    }
    if (ch === "`") { i = parseTemplateLiteral(body, i).end; continue; }
    // 嵌套块（if / 内层函数 / 对象字面量）里的 return 不是这个函数的返回值。
    if (ch === "{") { i = skipBalanced(body, i) + 1; continue; }
    if (body.startsWith("return", i) && !/[A-Za-z0-9_$]/.test(body[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(body[i + 6] ?? "")) {
      const end = statementEnd(body, i + 6);
      out.push(body.slice(i + 6, end).trim());
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 从 `from` 开始找到一条语句的结尾（顶层 `;`、`}` 或换行）。 */
function statementEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < text.length) { if (text[i] === "\\") { i += 2; continue; } if (text[i] === quote) break; i += 1; }
      i += 1;
      continue;
    }
    if (c === "`") { i = parseTemplateLiteral(text, i).end; continue; }
    if ("([{".includes(c)) { i = skipBalanced(text, i) + 1; continue; }
    if (c === ";" || c === "}" || c === "\n") return i;
    i += 1;
  }
  return text.length;
}

/** 形参表 → 形参名（去掉类型注解与默认值；解构参数也只取它的类型前面的名字）。 */
function parseParamNames(signature: string): string[] {
  return splitTopLevel(signature).map((part) => {
    const eq = topLevelIndex(part, "=");
    const head = (eq === -1 ? part : part.slice(0, eq)).trim();
    const annotated = head.match(/^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*[?:]/);
    if (annotated) return annotated[1]!;
    const bare = head.match(/^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*$/);
    return bare ? bare[1]! : "";
  });
}

/**
 * 在语料里按名字找函数声明。
 *
 * 多于一份定义就返回 null：重载与条件定义意味着运行时用哪份取决于调用点，
 * 那不是能在源码层面确定的事，不猜。
 */
function findFunction(name: string, ctx: Ctx): FunctionDef | null {
  const found: FunctionDef[] = [];
  const re = new RegExp(`(?:^|[\\n;])\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*(?:<[^>{}]*>)?\\s*\\(`, "g");
  // 当前这份源码排在最前：片段函数常常就住在被扫描的文件里，自证用例更是只存在于假源码中。
  const sources: Array<[string, string]> = [[ctx.file, ctx.text], ...[...CORPUS].filter(([, t]) => t !== ctx.text)];
  for (const [file, text] of sources) {
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = skipBalanced(text, open);
      if (close >= text.length) continue;
      const tail = text.slice(close + 1);
      const braceAt = topLevelIndex(tail, "{");
      if (braceAt === -1) continue; // 箭头函数体/表达式体：形状不同，不处理（会记成跳过）
      const bodyOpen = close + 1 + braceAt;
      const bodyClose = skipBalanced(text, bodyOpen);
      if (bodyClose >= text.length) continue;
      const params = parseParamNames(text.slice(open + 1, close));
      if (params.some((p) => !p)) continue;
      const signatureTail = tail.slice(0, braceAt).trim().replace(/^\)\s*/, "").trim();
      found.push({
        file,
        text,
        params,
        returnType: signatureTail.startsWith(":") ? signatureTail.slice(1).trim() : "",
        body: text.slice(bodyOpen + 1, bodyClose),
      });
    }
  }
  const unique = new Map(found.map((d) => [JSON.stringify([d.params, d.returnType, d.body]), d]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

type BindResult = { ok: true; value: Binding } | { ok: false; reason: string };

/**
 * 把调用点的**实参**绑成形参的值。
 *
 * 「不猜」的三条纪律：
 *   - 字符串字面量原样当 SQL 文本（表别名顶占位符会得到 `'x'.share_scope` 这种生产里
 *     根本不存在的写法，等于自己造一个假缺陷）；
 *   - `sql` 模板 / 模板字面量按分段展开，于是里面对**外层形参**的引用能顺着作用域链拿到；
 *   - 其余按**形参名**分类，不看签名上的 `: string`（`conversationId: string` 装的是 uuid）。
 */
function bindArgument(param: string, arg: string | undefined, ctx: Ctx): BindResult {
  if (arg === undefined) return { ok: false, reason: `实参不足，形参 \`${param}\` 没有对应实参` };
  const trimmed = stripComments(arg).trim();
  if (!trimmed) return { ok: false, reason: `形参 \`${param}\` 的实参为空` };

  // 对象字面量实参 → 逐属性绑定，函数体里的 `ref.subjectId` 才取得到实参。
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const props = new Map<string, Binding>();
    const entries = splitTopLevel(trimmed.slice(1, -1));
    if (entries.length === 0 || (entries.length === 1 && entries[0] === "")) {
      return { ok: false, reason: `形参 \`${param}\` 的实参是空对象` };
    }
    for (const entry of entries) {
      const colon = topLevelIndex(entry, ":");
      if (colon === -1) return { ok: false, reason: `形参 \`${param}\` 的对象实参里有一项不是 \`KEY: VALUE\`` };
      const key = entry.slice(0, colon).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) return { ok: false, reason: `形参 \`${param}\` 的对象实参键 \`${key}\` 不是标识符` };
      const resolved = resolveSubstitution(entry.slice(colon + 1), ctx);
      if (!resolved.ok) return { ok: false, reason: `${param}.${key} 无法确定：${resolved.reason}` };
      props.set(key, { segments: resolved.segments });
    }
    return { ok: true, value: { props } };
  }

  // 字符串字面量实参：**引号风格**决定它是标识符还是值。
  //   - 单引号 `'00000000-…'` 写的是 SQL 里的**值**，引号得留着——去掉就成了一个裸的
  //     uuid 常量，恰好还能过，但和形参在函数体里按名字渲染出来的样子不一致；
  //   - 双引号 `"source_note"` 写的是**标识符/别名**，必须去掉引号，否则会得到
  //     `FROM notes 'source_note' JOIN … WHERE 'source_note'.share_scope` 这种生产里
  //     根本不存在的写法（顶成占位符同样错：那正是为什么这里不能用猜的占位符）。
  if (/^'[^']*'$/.test(trimmed)) return { ok: true, value: { segments: [trimmed] } };
  if (/^"[^"]*"$/.test(trimmed)) return { ok: true, value: { segments: [trimmed.slice(1, -1)] } };

  // 模板字面量实参：内部还能引用外层形参，照常按分段展开。
  if (trimmed.startsWith("`")) {
    // 形如 `` `'${userId}'::uuid` ``：**引号是源码自己写的**，占位符顶上去之后会变成
    // `''00000000-…'::uuid`（多一层引号）——那不是生产里的写法，而是本守卫造出来的。
    // 所以「引号包一个插值」这种形状只把那对引号去掉，插值与后面的 `::uuid` 原样保留。
    const quoted = trimmed.match(/^`\s*'\s*\$\{([^{}]*)\}\s*'([\s\S]*)`$/);
    if (quoted) {
      const resolved = resolveSubstitution(quoted[1]!, ctx);
      if (!resolved.ok) return resolved;
      const tail = quoted[2]!;
      return { ok: true, value: { segments: tail ? [...resolved.segments, tail] : resolved.segments } };
    }
    const tick = trimmed.indexOf("`");
    const resolved = inlineSqlTemplate(trimmed.slice(tick), ctx);
    if (!resolved.ok) return resolved;
    return { ok: true, value: { segments: resolved.segments } };
  }

  const kind = classifyExpression(param);
  if (!kind) return { ok: false, reason: `形参 \`${param}\` 的类型判断不了` };
  return { ok: true, value: { segments: [{ kind, expression: param }] } };
}

/**
 * 这条 `return` 是不是「把形参拼成一段 SQL 文本」？
 *
 * `noteVisibleSqlText(alias, viewerExpr)` 返的是普通模板字面量（不是 `sql` 标签），
 * 但每个插值都是形参本身——那正是 `sql.raw()` 的来源，形状和拼 SQL 一模一样。
 * 反过来 `summarizerJobKey()` 的插值是 `input.conversationId` / `Math.floor(…)`，
 * 不是裸形参，于是不会被误认成 SQL 片段。
 */
function isSqlStringBuilder(expression: string, params: readonly string[]): boolean {
  if (!expression.startsWith("`")) return false;
  const parsed = parseTemplateLiteral(expression, 0);
  const subs = parsed.parts.filter((p) => p.kind === "sub");
  return subs.length > 0 && subs.every((p) => params.includes(expression.slice(p.start, p.end).trim()));
}

/**
 * 这条 `return` 的形状——决定它是「一段 SQL」还是「一个值」。
 *
 * `sql` 标签      → 直接就是片段。
 * `builder`       → 普通模板字面量，但每个插值都是形参本身：那是把形参拼成 SQL 文本的
 *                   拼装器（`sql.raw()` 的典型来源）。
 * `call`          → 转手交给另一个函数：`visibleCompanionDueReviewCondition()` 就是
 *                   `return reviewScheduleTargetsConsumableCardPredicate({…})`。
 * `scalar`        → 算出来的值（`summarizerJobKey()` 拼的那串幂等键）。
 */
type ReturnShape = { kind: "sql" } | { kind: "builder" } | { kind: "call"; callee: string } | { kind: "scalar" };

function classifyReturn(def: FunctionDef, returned: string): ReturnShape {
  if (/^sql\s*(<[^>]*>)?`/.test(returned)) return { kind: "sql" };
  if (isSqlStringBuilder(returned, def.params)) return { kind: "builder" };
  const call = returned.match(/^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/);
  if (call) return { kind: "call", callee: call[1]!.replace(/\s+/g, "") };
  return { kind: "scalar" };
}

/** 被转手的那个函数自己是不是也在产 SQL 片段？只认直接证据，不追下一层。 */
function producesSqlFragment(callee: string, ctx: Ctx): boolean {
  const def = findFunction(callee, ctx);
  if (!def) return false;
  const returns = topLevelReturns(def.body);
  if (returns.length !== 1) return false;
  const shape = classifyReturn(def, returns[0]!.replace(/;+\s*$/, "").trim());
  return shape.kind === "sql" || shape.kind === "builder";
}

/**
 * `${fn(…)}` 里 `fn` 返回 SQL 片段时的内联；确定不了就返回 null，由调用方记成跳过。
 */
function inlineFragmentFunction(expr: string, callee: string, ctx: Ctx): Resolved | null {
  const def = findFunction(callee, ctx);
  if (!def) return null;
  const returns = topLevelReturns(def.body);
  if (returns.length !== 1) {
    return { ok: false, reason: `${callee}() 的函数体里有 ${returns.length} 条顶层 return，运行时拼出哪一段判断不了` };
  }
  const returned = returns[0]!.replace(/;+\s*$/, "").trim();
  const shape = classifyReturn(def, returned);
  const fragment = shape.kind === "sql" || shape.kind === "builder"
    || (shape.kind === "call" && producesSqlFragment(shape.callee, ctx));

  if (!fragment) {
    // 声明成标量返回类型、且 return 就是个标量表达式 → 它是个**值**，不是片段。
    // （`summarizerJobKey(): string`——键本身就是要写进 idempotency_key 的字符串。）
    const scalarKind = SCALAR_RETURN_KINDS[def.returnType];
    if (scalarKind) return { ok: true, segments: [{ kind: scalarKind, expression: expr }] };
    return { ok: false, reason: `${callee}() 的 return 不是一条 SQL 片段（${def.file}，形态 ${shape.kind}）：${previewOf(returned)}` };
  }

  const args = splitTopLevel(callArgumentBody(expr));
  const scope = new Map<string, Binding>();
  for (const [index, param] of def.params.entries()) {
    const binding = bindArgument(param, args[index], ctx);
    if (!binding.ok) return { ok: false, reason: `${callee}() 的实参判断不了：${binding.reason}` };
    scope.set(param, binding.value);
  }

  const outerFile = ctx.file;
  const outerText = ctx.text;
  ctx.file = def.file;
  ctx.text = def.text;
  ctx.scopes.unshift(scope);
  ctx.depth += 1;
  try {
    const resolved = resolveReturnExpression(returned, callee, ctx);
    if (resolved.ok) ctx.inlined.push(normalizeSql(renderSegments(resolved.segments)));
    return resolved;
  } finally {
    ctx.depth -= 1;
    ctx.scopes.shift();
    ctx.file = outerFile;
    ctx.text = outerText;
  }
}

/** 函数体里那条 `return` 的值怎么变成 SQL 片段：本身是片段就展开，还是调用就继续内联。 */
function resolveReturnExpression(returned: string, callee: string, ctx: Ctx): Resolved {
  const bound = lookupBinding(returned, ctx);
  if (bound) return resolveSubstitution(returned, ctx);
  const call = returned.match(/^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/);
  if (call) {
    const inner = call[1]!.replace(/\s+/g, "");
    if (inner === "JSON.stringify") return resolveSubstitution(returned, ctx);
    const fragment = inlineFragmentFunction(returned, inner, ctx);
    if (fragment) return fragment;
    return { ok: false, reason: `${callee}() return 的是 \`${inner}(…)\`，而它不是可内联的 SQL 片段` };
  }
  // 普通模板字面量（不是 `sql` 标签）也要当**文本**展开：交给按名字分类那条会落进
  // 「最后一个标识符段 = viewerExpr}`」而变成一个 `'x'` 占位符——`sql.raw(noteVisibleSqlText(…))`
  // 那条可见性判据于是整段没被验证过，却仍然「解析通过」。
  if (returned.startsWith("`")) return inlineSqlTemplate(returned, ctx);
  return resolveSubstitution(returned, ctx);
}

// ---------------------------------------------------------------------------
// 4. 抠出完整语句
// ---------------------------------------------------------------------------

const STATEMENT_HEADS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "VALUES", "TABLE", "MERGE"]);

type Candidate = { file: string; line: number; endLine: number; segments: Segment[]; text: string };
type Skipped = { file: string; line: number; reason: string; preview: string; text: string };

/** 去掉前导空白与注释，看这条模板真正以什么关键字开头。 */
function firstKeyword(sqlText: string): string {
  let i = 0;
  while (i < sqlText.length) {
    const c = sqlText[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { i += 1; continue; }
    if (c === "-" && sqlText[i + 1] === "-") {
      const nl = sqlText.indexOf("\n", i);
      i = nl === -1 ? sqlText.length : nl + 1;
      continue;
    }
    if (c === "/" && sqlText[i + 1] === "*") {
      const close = sqlText.indexOf("*/", i + 2);
      i = close === -1 ? sqlText.length : close + 2;
      continue;
    }
    break;
  }
  return (sqlText.slice(i).match(/^[A-Za-z_]+/)?.[0] ?? "").toUpperCase();
}

/** 除末尾分号外还出现分号 → 多语句拼接，一次 EXPLAIN 送不进去。 */
function hasExtraSemicolon(sqlText: string): boolean {
  const body = sqlText.trim().replace(/;\s*$/, "");
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "'") {
      i += 1;
      while (i < body.length) {
        if (body[i] === "'") { if (body[i + 1] === "'") { i += 2; continue; } break; }
        i += 1;
      }
      continue;
    }
    if (c === '"') { i += 1; while (i < body.length && body[i] !== '"') i += 1; continue; }
    if (c === "-" && body[i + 1] === "-") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    if (c === ";") return true;
  }
  return false;
}

function previewOf(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  return first.length > 88 ? `${first.slice(0, 88)}…` : first;
}

/**
 * 把一份源码里所有 `sql` 模板过一遍，产出**可送解析的完整语句**与**未成语句的片段**。
 *
 * 刻意**不做**任何语法「修补」：文本原样送去解析，语法错、列不存在都会当场暴露。
 */
function collectFromSource(
  source: string,
  fileLabel: string,
  ctx: Ctx,
): { candidates: Candidate[]; fragments: Skipped[]; templates: number } {
  const templates = scanSqlTemplates(source);
  const candidates: Candidate[] = [];
  const fragments: Skipped[] = [];

  for (const tpl of topLevelTemplates(source)) {
    const line = lineAt(source, tpl.tick);
    const endLine = lineAt(source, tpl.end - 1);
    const resolved = templateSegments(tpl, source, ctx);
    const text = resolved.ok ? renderSegments(resolved.segments) : "";

    if (!resolved.ok) { fragments.push({ file: fileLabel, line, reason: resolved.reason, preview: previewOf(text), text }); continue; }
    if (text.trim() === "") { fragments.push({ file: fileLabel, line, reason: "空片段", preview: "", text }); continue; }
    const head = firstKeyword(text);
    if (!head) {
      fragments.push({ file: fileLabel, line, reason: "片段（不以语句关键字开头，单独 EXPLAIN 不了）", preview: previewOf(text), text });
      continue;
    }
    if (!STATEMENT_HEADS.has(head)) {
      fragments.push({ file: fileLabel, line, reason: `片段（以 ${head} 开头，单独 EXPLAIN 不了）`, preview: previewOf(text), text });
      continue;
    }
    if (hasExtraSemicolon(text)) {
      fragments.push({ file: fileLabel, line, reason: "多语句拼接，一次 EXPLAIN 送不进去", preview: previewOf(text), text });
      continue;
    }
    candidates.push({ file: fileLabel, line, endLine, segments: resolved.segments, text });
  }
  return { candidates, fragments, templates: templates.length };
}

/** 第一版 `extract()` 的继任者：按条件从源码里取出一条已经抠好的语句。 */
function extractFromSource(rel: string, matches: (text: string) => boolean): string {
  const found = collectFromSource(repoFile(rel), rel, makeCtx(rel, repoFile(rel))).candidates.find((c) => matches(c.text));
  assert.ok(found, `没能从 ${rel} 里抠出目标 SQL——源码形状变了，自证用例需要同步`);
  return found.text;
}

// ---------------------------------------------------------------------------
// 5. 送真实解析器
// ---------------------------------------------------------------------------

type FailureKind = "syntax" | "missing-object" | "undecidable-placeholder";

const KIND_LABEL: Record<FailureKind, string> = {
  "syntax": "语法错误",
  "missing-object": "列/表不存在",
  "undecidable-placeholder": "占位符类型判断不了（不算守卫失败）",
};

const PERMISSION_DENIED = /permission denied/i;

function classifyError(error: unknown): { kind: FailureKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/syntax error/i.test(message)) return { kind: "syntax", message };
  // PG 的报错有时带引号（`column "page_context" does not exist`），有时不带
  // （`column m.page_context does not exist`）。第一版只认带引号的那一种，
  // 于是真实缺陷会被降级成「占位符判断不了」——自证用例当场抓到了这一点。
  if (/\b(column|relation|table|view|type|function|operator|schema)\s+"?[A-Za-z_][\w$.]*"?\s+does not exist/i.test(message)) {
    return { kind: "missing-object", message };
  }
  return { kind: "undecidable-placeholder", message };
}

/** 每个占位槽（按出现顺序，不含文本段）在各个变体下的字面量池。 */
const slotPlan = (segments: Segment[]): Array<readonly string[]> =>
  segments.flatMap((segment) => (typeof segment === "string" ? [] : [LITERALS[segment.kind]]));

/** 按「每个槽各挑第几个变体」渲染出一条 SQL。`picks` 按槽的序号索引。 */
function renderWith(segments: Segment[], plan: Array<readonly string[]>, picks: number[]): string {
  let slot = -1;
  return segments
    .map((segment) => {
      if (typeof segment === "string") return segment;
      slot += 1;
      const pool = plan[slot]!;
      if (picks[slot] === 0) return IDENTIFIERS[segment.expression.trim()] ?? pool[0]!;
      return pool[Math.min(picks[slot]!, pool.length - 1)]!;
    })
    .join("");
}

/** 主占位渲染：报告与自证用的都是它。 */
function renderSegments(segments: Segment[]): string {
  return renderWith(segments, slotPlan(segments), segments.map(() => 0));
}

type ParseVerdict =
  | { ok: true; note?: string }
  | { ok: false; kind: FailureKind; message: string };

/**
 * 一条语句的完整解析过程。
 *
 * 先按名字推断的那组占位试一次；过不去就**每次只换一个槽**再试——同一个语句里
 * 不同占位要的类型不同（uuid 与 bigint 同时出现），全局变体号会让它们互相拖累，
 * 逐槽修才不会把「有一个槽猜错了」变成「整条都判不出来」。
 */
async function parseInRealParser(segments: Segment[]): Promise<ParseVerdict> {
  const plan = slotPlan(segments);
  const slots = segments.map((s, i) => (typeof s === "string" ? -1 : i)).filter((i) => i >= 0);
  const widest = Math.max(...Object.values(LITERALS).map((pool) => pool.length));

  const attempts: number[][] = [slots.map(() => 0)];
  for (const slot of slots) {
    for (let variant = 1; variant < widest; variant += 1) attempts.push(slots.map((s) => (s === slot ? variant : 0)));
  }

  const kinds: FailureKind[] = [];
  const messages: string[] = [];
  let permissionNote: string | undefined;
  for (const picks of attempts) {
    const text = renderWith(segments, plan, picks).trim();
    try {
      await client.unsafe(`EXPLAIN ${text}`);
      return permissionNote ? { ok: true, note: permissionNote } : { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 权限检查发生在**解析和列解析之后**：报出它就说明语法与列名都已经过了。
      // 所以它算「解析通过」，只是没能走到计划阶段——如实标注，不当成缺陷。
      if (PERMISSION_DENIED.test(message)) {
        permissionNote ??= `${message.split("\n")[0]}（解析与列解析已通过，EXPLAIN 停在权限检查）`;
        continue;
      }
      const classified = classifyError(error);
      kinds.push(classified.kind);
      messages.push(classified.message);
    }
  }

  const syntaxAt = kinds.indexOf("syntax");
  if (syntaxAt !== -1) return { ok: false, kind: "syntax", message: messages[syntaxAt]! };
  const missingAt = kinds.indexOf("missing-object");
  if (missingAt !== -1) return { ok: false, kind: "missing-object", message: messages[missingAt]! };
  if (permissionNote) return { ok: true, note: permissionNote };
  return { ok: false, kind: "undecidable-placeholder", message: messages[0]! };
}

// ---------------------------------------------------------------------------
// 6. 主守卫：扫描 → 解析 → 一次性汇总断言
// ---------------------------------------------------------------------------

type ScanResult = {
  templateCount: number;
  discovered: number;
  unique: Candidate[];
  parsed: number;
  failures: Array<{ candidate: Candidate; kind: FailureKind; message: string }>;
  undecidable: Array<{ candidate: Candidate; message: string }>;
  limited: Array<{ candidate: Candidate; message: string }>;
  skipped: Skipped[];
  empty: Skipped[];
  covered: Skipped[];
};

const describeFailure = (failure: { candidate: Candidate; kind: FailureKind; message: string }): string =>
  `[${KIND_LABEL[failure.kind]}] ${failure.candidate.file}:${failure.candidate.line}-${failure.candidate.endLine}`
  + `\n      ${failure.message.split("\n")[0]}`;

/** 片段原文是否已经被原样内联进某条语句（那就跟着那条语句过过 parser 了）。 */
function coveredBy(text: string, inlined: readonly string[], candidates: readonly Candidate[]): boolean {
  const needle = normalizeSql(text);
  if (!needle) return false;
  for (const done of inlined) if (done.includes(needle)) return true;
  for (const candidate of candidates) if (normalizeSql(candidate.text).includes(needle)) return true;
  return false;
}

/**
 * 整条流水线：扫源码 → 抠语句 → 送真实解析器 → 汇总。
 *
 * 自证用例走的是**同一个函数**，所以「守卫能报出缺陷」这句话是被真的验过的，
 * 而不是「EXPLAIN 单独会报错」那种绕开了扫描与分类的弱自证。
 */
async function runScan(sources: Array<{ file: string; text: string }>): Promise<ScanResult> {
  const ctx = makeCtx("", "");
  const everyCandidate: Candidate[] = [];
  const fragments: Skipped[] = [];
  let templateCount = 0;

  for (const { file, text } of sources) {
    ctx.file = file;
    ctx.text = text;
    const found = collectFromSource(text, file, ctx);
    templateCount += found.templates;
    everyCandidate.push(...found.candidates);
    fragments.push(...found.fragments);
  }

  // 同一条 SQL 在文件里出现多次只解析一次。
  const byText = new Map<string, Candidate>();
  for (const candidate of everyCandidate) {
    const key = normalizeSql(candidate.text);
    const existing = byText.get(key);
    if (existing) { existing.endLine = Math.max(existing.endLine, candidate.endLine); continue; }
    byText.set(key, { ...candidate });
  }
  const unique = [...byText.values()];

  // 「已内联覆盖」与「跳过」必须分开：片段本身 EXPLAIN 不了，但它**已经**作为
  // 完整语句的一部分被送去解析过了——算成跳过会让人以为这里没验证。
  const skipped: Skipped[] = [];
  const empty: Skipped[] = [];
  const covered: Skipped[] = [];
  for (const fragment of fragments) {
    if (fragment.reason === "空片段") { empty.push(fragment); continue; }
    if (!fragment.text.trim()) { skipped.push({ ...fragment, reason: fragment.reason }); continue; }
    if (coveredBy(fragment.text, ctx.inlined, unique)) { covered.push(fragment); continue; }
    skipped.push(fragment);
  }

  const failures: ScanResult["failures"] = [];
  const undecidable: ScanResult["undecidable"] = [];
  const limited: ScanResult["limited"] = [];
  let parsed = 0;

  for (const candidate of unique) {
    const verdict = await parseInRealParser(candidate.segments);
    if (verdict.ok) {
      parsed += 1;
      if (verdict.note) limited.push({ candidate, message: verdict.note });
      continue;
    }
    if (verdict.kind === "undecidable-placeholder") undecidable.push({ candidate, message: verdict.message });
    else failures.push({ candidate, kind: verdict.kind, message: verdict.message });
  }
  return {
    templateCount, discovered: everyCandidate.length, unique, parsed,
    failures, undecidable, limited, skipped, empty, covered,
  };
}

test("SQL 解析：方案 44 的全部 SQL 自动发现后在真实 PostgreSQL 上过一遍", async () => {
  const { templateCount, discovered, unique, parsed, failures, undecidable, limited, skipped, empty, covered } =
    await runScan(SOURCE_FILES.map((rel) => ({ file: rel, text: repoFile(rel) })));

  // 报告里那个「占位符判断不了」多半是占位符选错了类型；这条开关把它抠出来的 SQL 打出来。
  if (process.env.PLAN44_SQL_DEBUG) {
    for (const item of [...failures, ...undecidable]) {
      console.log(`----- ${item.candidate.file}:${item.candidate.line} -----`);
      console.log(item.candidate.text);
      console.log("");
    }
  }
  // 想核对「内联出来的到底是不是运行时那原文」时用它：把每条送进解析器的语句全打出来。
  if (process.env.PLAN44_SQL_DUMP) {
    for (const candidate of unique) {
      console.log(`----- ${candidate.file}:${candidate.line}-${candidate.endLine} -----`);
      console.log(candidate.text);
      console.log("");
    }
  }

  // ---- 报告：条数、成功/失败分布、每一处跳过的原因 ----
  console.log("\n方案 44 SQL 解析扫描报告");
  console.log(`  扫描文件          ${SOURCE_FILES.length} 个（另加 ${FRAGMENT_DEFINITION_FILES.length} 个只查函数定义）`);
  console.log(`  sql 模板总数      ${templateCount}（含嵌在 \${…} 里的片段）`);
  console.log(`  自动发现          ${discovered} 条（去重后 ${unique.length} 条）`);
  console.log(`  成功解析          ${parsed} 条（其中 ${limited.length} 条只解析到权限检查）`);
  console.log(`  守卫失败          ${failures.length} 条`);
  console.log(`  占位符判断不了    ${undecidable.length} 条（不计为失败）`);
  console.log(`  跳过              ${skipped.length} 条`);
  console.log(`  已内联覆盖        ${covered.length} 条（片段原文已随完整语句过过 parser）`);
  console.log(`  空片段            ${empty.length} 条（运行时不产生 SQL 文本）\n`);

  if (skipped.length > 0) {
    console.log("跳过的片段（真的没验证到）：");
    for (const item of skipped) {
      console.log(`  ${item.file}:${item.line} — ${item.reason}${item.preview ? `　「${item.preview}」` : ""}`);
    }
    console.log("");
  }
  if (covered.length > 0) {
    console.log("已内联覆盖（下面这些片段单独 EXPLAIN 不了，但原文已被内联进上面某条完整语句）：");
    for (const item of covered) {
      console.log(`  ${item.file}:${item.line} — ${item.reason}　「${item.preview}」`);
    }
    console.log("");
  }
  if (empty.length > 0) {
    console.log("空片段（`sql\\`\\`` 这类三元/短路的空分支，没有可验证的内容）：");
    for (const item of empty) console.log(`  ${item.file}:${item.line}`);
    console.log("");
  }
  if (limited.length > 0) {
    console.log("解析通过，但 EXPLAIN 停在权限检查（当前角色缺该表的授权；语法与列名已验证）：");
    for (const item of limited) console.log(`  ${item.candidate.file}:${item.candidate.line} — ${item.message}`);
    console.log("");
  }
  if (undecidable.length > 0) {
    console.log("占位符类型判断不了（不判为缺陷，但值得看一眼）：");
    for (const item of undecidable) console.log(`  ${item.candidate.file}:${item.candidate.line} — ${item.message.split("\n")[0]}`);
    console.log("");
  }
  if (failures.length > 0) {
    console.log("失败明细：");
    for (const failure of failures) console.log(`  ${describeFailure(failure)}`);
    console.log("");
  }

  // 一次把全部失败报出来，而不是遇到第一个就停。
  assert.deepEqual(
    failures.map(describeFailure),
    [],
    `方案 44 的 SQL 在真实 PostgreSQL 解析器上过不去（${failures.length} 条）。`
    + "文本形状的断言看不见语法错误与不存在的列——本轮在真库上抓到过两处"
    + "（CTE 未加括号、companion_messages.page_context）。全部失败如下：\n"
    + failures.map((f) => `  · ${describeFailure(f)}`).join("\n"),
  );
});

// ---------------------------------------------------------------------------
// 7. 自证：修复过的缺陷形态必须被这条守卫抓出来
// ---------------------------------------------------------------------------

/**
 * 自证走的是**同一个 `runScan`**：把真实 SQL 改回缺陷形态，塞进一份假的源码，
 * 让扫描器自己发现它、再由同一个分类器定级——证明的不只是「EXPLAIN 会报错」，
 * 还有「这条守卫真的会把它挑出来并归到正确的类」。
 */

/** 把一份假源码（含若干条 SQL）送进整条流水线。 */
const scanSynthetic = async (statements: string[], label: string): Promise<ScanResult> => {
  const text = statements.map((statement, index) => `const probe${index} = sql\`${statement}\`;`).join("\n");
  return runScan([{ file: label, text: `${text}\n` }]);
};

test("自证：递归 CTE 的锚点项一旦漏了括号，守卫必须报 syntax error", async () => {
  const fixed = extractFromSource(
    "workers/ai-worker/src/handlers/companion-dialogue-store.ts",
    (text) => /WITH RECURSIVE chain AS/.test(text),
  );
  // 缺陷形态＝把两个迭代项外面那对括号去掉：`ORDER BY … LIMIT 1` 直接顶到 `UNION ALL` 前面。
  const withoutParens = fixed
    .replace(/\(\s*\n\s*SELECT s\.id/, "\n      SELECT s.id")
    .replace(/LIMIT 1\s*\n\s*\)\s*\n\s*UNION ALL\s*\n\s*\(\s*\n\s*SELECT p\.id/, "LIMIT 1\n      UNION ALL\n      SELECT p.id")
    .replace(/conv\.context_revision\s*\n\s*\)\s*\n\s*\)/, "conv.context_revision\n    )");
  assert.notEqual(withoutParens, fixed, "没能构造出「未加括号」的形态——递归 CTE 的源码形状变了，自证用例需要同步");

  // 一条好的 + 一条坏的：守卫必须只把坏的那条挑出来，且归到「语法错误」。
  const result = await scanSynthetic([fixed, withoutParens], "self-proof: 漏括号的递归 CTE");
  assert.equal(result.unique.length, 2, "自证：扫描器应当自己发现这两条语句");
  assert.equal(result.parsed, 1, "自证：修好的那一条必须解析通过");
  assert.equal(result.failures.length, 1, "自证：坏的那一条必须被报出来");
  assert.equal(result.failures[0]!.kind, "syntax", "错误分类应当落在「语法错误」");
  assert.match(result.failures[0]!.message, /syntax error/i, `实际报错：${result.failures[0]!.message}`);
});

test("自证：引用一张表上并不存在的列，守卫必须报 column … does not exist", async () => {
  const fixed = extractFromSource(
    "workers/ai-worker/src/handlers/companion-summary-retrieval.ts",
    (text) => /FROM companion_messages m/.test(text),
  );
  // 缺陷形态＝把 page_context 直接从 companion_messages 上取（它只在 companion_turn_runs 上）。
  const broken = fixed.replace(
    /SELECT m\.id, m\.seq::text AS seq, m\.role, m\.blocks,/,
    "SELECT m.id, m.seq::text AS seq, m.role, m.blocks, m.page_context,",
  );
  assert.match(broken, /m\.page_context,/, "没能构造出「引用不存在的列」的形态——源码形状变了，自证用例需要同步");

  const result = await scanSynthetic([fixed, broken], "self-proof: 引用不存在的列");
  assert.equal(result.unique.length, 2, "自证：扫描器应当自己发现这两条语句");
  assert.equal(result.parsed, 1, "自证：修好的那一条必须解析通过");
  assert.equal(result.failures.length, 1, "自证：坏的那一条必须被报出来");
  assert.equal(result.failures[0]!.kind, "missing-object", "错误分类应当落在「列/表不存在」");
  assert.match(result.failures[0]!.message, /column m\.page_context does not exist/i, `实际报错：${result.failures[0]!.message}`);
});

test("自证：内联进语句里的 SQL 片段写坏了，守卫必须报 syntax error（不是把它跳过）", async () => {
  // 函数体故意少一个右括号——真实缺陷长这样：片段单独 EXPLAIN 不了，只有**内联之后**
  // 拼出来的那条完整语句才暴露得出来。所以这条自证要同时证明两件事：
  // 守卫报了错（`failures` 有），且**没有**把它当成「跳过」蒙混过去（`skipped` 为空）。
  const source = [
    "function brokenCondition(userId: string) {",
    "  return sql`AND c.owner = ${userId} AND c.labels IN (`;",
    "}",
    "const probe = sql`SELECT c.id FROM cards c",
    "  WHERE c.workspace_id = ${'00000000-0000-4000-8000-000000000000'}",
    "    AND ${brokenCondition('00000000-0000-4000-8000-000000000000')}`;",
    "",
  ].join("\n");

  const result = await runScan([{ file: "self-proof: 内联的片段写坏了", text: source }]);
  assert.equal(result.skipped.length, 0, `不该有跳过项，实际：${result.skipped.map((s) => s.reason).join(" / ")}`);
  assert.equal(result.unique.length, 1, "自证：应当只发现内联后的那一条完整语句");
  assert.equal(result.parsed, 0, "自证：内联出来的坏片段不该解析通过");
  assert.equal(result.failures.length, 1, "自证：坏的那一条必须被报出来");
  assert.equal(result.failures[0]!.kind, "syntax", "错误分类应当落在「语法错误」");
  assert.match(result.failures[0]!.message, /syntax error/i, `实际报错：${result.failures[0]!.message}`);
});

test("守护本身是有效的：故意写坏的 SQL 必须被这条守卫抓住", async () => {
  // 自证：锚点项的括号去掉，PG 立刻报 syntax error——说明上面那些不是「怎么都过」。
  await assert.rejects(
    () => client.unsafe(`EXPLAIN SELECT 1 ORDER BY 1 LIMIT 1 UNION ALL SELECT 2`),
    /syntax error/,
  );
});
