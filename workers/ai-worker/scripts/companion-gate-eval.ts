/**
 * 反事实重放台的**判据执行桥**（39b §10 / 39d W1-1）。
 *
 * 为什么需要它：重放台要「不信任日志，重算」11 道输出闸，而这些判据**只能有一份实现**。
 * 把它们逐条翻译成 Python 正则是这条链上最贵的错法——`scripts/companion-quality-report.py`
 * 已经在注释里吃过一次同类亏（同一条判据在 TS 与 POSIX 正则里各写一份，元字符集不同，
 * 漏改的后果是**样本静默变少**而不是报错）。所以这里不翻译：直接 import 真函数。
 *
 * 分工：
 *   - 本桥（TS）：判据执行 + `contextText` 组装 + 环境块渲染 + 实体先行解析（P1），
 *     全部走真实现；
 *   - `scripts/companion-gate-counterfactual.py`（Python）：取数、P2 反事实模拟、
 *     触发分类与退出码。它不重写任何正则。
 *
 * P1 自 39d W2-3 起**不再由 Python 模拟**：环境块模式下本桥在同一事务里多跑一次
 * `loadThisTurnFacts`，把 `definite`（服务端是否给出了确定口径）与耗时一起回传，
 * Python 的 G3 分类直接读它。
 *
 * 输入（stdin，JSON）：
 *   {
 *     "activeness": "quiet" | "moderate" | "active",   // G5 字数线
 *     "turns": [{
 *       "runId": "...",
 *       "replyText": "...",            // 她的可见终答（companion_messages assistant 正文）
 *       "systemTexts": ["..."],        // system 消息原文；本桥按 keepRecomputedBlocks 收窄
 *       "ambient": {...} | null,       // HereAndNowSnapshot → 真 renderHereAndNow 渲染
 *       "userTexts": ["..."],          // 环境块模式下同一条 userText 也喂给 P1 解析器
 *       "toolResultTexts": ["..."]      // 本轮工具回执（G6 的出处比数字宽）
 *     }]
 *   }
 *
 * 输出（stdout，JSON）：同序的 `{ "turns": [{ "runId", "contextText", "quoteSources", "gates" }] }`。
 * 判据形状统一为 `{ "fired": boolean, "detail": ... }`；`detail` 只在能给出具体命中时有值。
 *
 * 只读：本桥不连库、不发模型请求。db.ts 的池在 import 时只是被构造（postgres.js 懒连接），
 * 全程没有一条查询发出。
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  claimsLookupThatNeverRan,
  claimsNothingDueAgainstFacts,
  containsCompanionInternalToken,
  keepRecomputedBlocks,
  looksLikeJsonEnvelope,
  looksLikeJsonFragment,
  looksLikeUnfulfilledActionNarration,
  looksTruncatedReply,
  unverifiedNumericClaims,
  unverifiedQuoteClaims,
  validateCompanionOutput,
} from "../src/handlers/companion-dialogue-content.ts";
import {
  introducesUnverifiedNumbers,
  readsOutStatistics,
  validateThoughtExpression,
} from "../src/handlers/companion-thought.ts";
import { FACT_SPAN_KEYS } from "../src/handlers/companion-fact-spans.ts";
import {
  loadHereAndNow,
  readLearningStats,
  renderHereAndNow,
  type HereAndNowSnapshot,
} from "../src/handlers/companion-here-and-now.ts";
import { loadThisTurnFacts } from "../src/handlers/companion-this-turn-facts.ts";
import { withWorkerWorkspaceTransaction } from "../src/db.ts";
import { COMPANION_LEAK_GATES_V1, companionLeakGateVersionV1 } from "@astella/shared/companion-leak-gates";

interface ReplayTurn {
  runId: string;
  replyText: string;
  systemTexts?: string[];
  ambient?: (Omit<HereAndNowSnapshot, "dueReviews"> & { dueReviews?: number }) | null;
  userTexts?: string[];
  toolResultTexts?: string[];
  /** 用户自己说的话（G10 的 allowedSource 里"用户说的话"那一半）。 */
  allowedNumberSource?: string;
  /** 念头气泡：G10／G11 的覆盖判定改读**产出侧守卫**（见 `thoughtGuardCovers`）。 */
  isThought?: boolean;
  /**
   * 本轮**之前**同一会话里的用户原话（生产的 `recentMessages` 那一半，见文件头 §4）。
   *
   * 为什么需要它：生产的 `contextText`（`runtime.ts:3044`）是把 `baseMessages` 里
   * **所有非 assistant 消息**拼起来的——也就是说**整段会话历史里的用户原话**都算
   * "数字/引文的合法出处"。重放台原来只喂了本轮那一句，等于用**真出处的真子集**去判
   * "她报的数有没有出处"，方向恒为**过报**。它不改判据、只补输入：这里把缺的那部分交回来，
   * 由本桥用**同一个**判据再判一次，差集就是"被漏掉的出处盖住的那几条"。
   */
  historyTexts?: string[];
  /**
   * 这一轮用户的活跃度档（生产的账号人格档案 `profile.activeness`，`companion-dialogue.ts`）。
   *
   * 不传就沿用顶层 `activeness`（那是生产的兜底值 `?? "active"`，`runtime.ts:3099`），
   * 两者都不是猜的：兜底值与生产逐字相同。给 per-turn 是为了让"安静档的字数线更松"
   * 这件事按**该用户那一档**判，而不是整批按最严的档判（G5 197 与真实值能差一整档）。
   */
  activeness?: string;
}

interface AmbientTurn {
  runId: string;
  workspaceId: string;
  userId: string;
  userText?: string;
  pageContext?: unknown;
  /** 规则④（上一轮工具结果里的显式 id）要按会话收窄，与运行时同一把尺。 */
  conversationId?: string | null;
}

interface ReplayInput {
  mode?: "gates" | "ambient" | "stats" | "spans" | "thresholds";
  activeness?: string;
  turns: (ReplayTurn & Partial<AmbientTurn>)[];
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

/**
 * 结果出口。
 *
 * 为什么不直接写 stdout：worker 的 logger 是 pino（开发走 pino-pretty，默认 fd 1），
 * 环境块模式一旦连库，依赖链里任何一条 info 日志都会混进 stdout，把整份 JSON 截断在
 * 中间——调用方拿到的是一段"看起来像 JSON 但解析不了"的东西。所以给一个显式的
 * `--out <path>` 出口，stdout 留给日志。
 */
function emit(payload: string): void {
  const index = process.argv.indexOf("--out");
  const target = index >= 0 ? process.argv[index + 1] : undefined;
  if (target) writeFileSync(target, payload, "utf8");
  else process.stdout.write(payload);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 环境块重建模式（`--ambient`）：用**真** `loadHereAndNow` 取快照、真 `renderHereAndNow`
 * 渲染，不改写任何取数 SQL。
 *
 * 边界（必须和调用方一起读）：`loadHereAndNow` 用的是 Postgres 的 `now()`，
 * 所以重建出来的是**重放时刻**的那一屏，不是历史那一刻的那一屏——历史环境块没有落库。
 * 同一账号的多轮因此共用同一份读数；这是数据条件，不是可以在这层修掉的缺陷。
 */
async function runAmbient(turns: AmbientTurn[]): Promise<void> {
  const out: Array<{
    runId: string;
    systemText: string;
    learningStats: unknown;
    ambient: unknown;
    p1Definite: boolean;
    p1Rule: string | null;
    factsMs: number;
    factsDropped: boolean;
  }> = [];
  for (const turn of turns) {
    const { snapshot, facts } = await withWorkerWorkspaceTransaction(
      { workspaceId: turn.workspaceId, userId: turn.userId },
      async (tx) => {
        const snapshot = await loadHereAndNow(tx, {
          workspaceId: turn.workspaceId,
          userId: turn.userId,
          conversationId: turn.conversationId ?? null,
          userText: turn.userText,
          pageContext: turn.pageContext,
        });
        // 与运行时同一次事务、同一个入口：重放台读到的就是线上会走的那份结果。
        const facts = await loadThisTurnFacts(tx, {
          workspaceId: turn.workspaceId,
          userId: turn.userId,
          conversationId: turn.conversationId ?? null,
          userText: turn.userText,
          liveView: snapshot.livePageView,
        });
        return { snapshot, facts };
      },
    );
    out.push({
      runId: turn.runId,
      // 与运行时一致：system 段里只有重算块算数字出处（companion-agent-runtime 的 contextText），
      // 而事实块也在那份块里（`keepRecomputedBlocks` 白名单），所以这里要一起拼上。
      systemText: [renderHereAndNow(snapshot), facts?.block ?? null].filter(Boolean).join("\n"),
      learningStats: snapshot.learningStats,
      ambient: snapshot,
      // P1 的真实结果：重放台的 G3 覆盖判定读它，不再自己用正则模拟。
      // 规则① 落在 `noteReference`（有它=服务端已经替她查过这个名字），②–⑤ 落在事实块。
      p1Definite: Boolean(facts?.definite) || snapshot.noteReference != null,
      p1Rule: facts?.rule ?? (snapshot.noteReference ? "bracket" : null),
      factsMs: facts?.ms ?? 0,
      factsDropped: facts?.dropped ?? false,
    });
  }
  emit(JSON.stringify({ turns: out }));
}

/**
 * 学习统计读数模式（`--stats`）：把**worker 侧真取数**（`readLearningStats`）暴露给
 * 跨包的对账测试。
 *
 * 为什么要走子进程而不是在 API 的测试里 import：两个包各有自己的 node_modules 与
 * 依赖图，跨包相对 import 会把对方的整条依赖链拖进来（AP psql/drizzle 都在，但那是
 * 巧合）。对账要的是"各自包里的真实现"，所以各跑各的进程——读的角色也随之各自成立
 * （这里是 `DATABASE_URL_WORKER`，受限角色）。
 */
async function runStats(turns: AmbientTurn[]): Promise<void> {
  const out: Array<{ runId: string; stats: unknown }> = [];
  for (const turn of turns) {
    const stats = await withWorkerWorkspaceTransaction(
      { workspaceId: turn.workspaceId, userId: turn.userId },
      (tx) => readLearningStats(tx, { workspaceId: turn.workspaceId, userId: turn.userId }),
    );
    out.push({ runId: turn.runId, stats });
  }
  emit(JSON.stringify({ turns: out }));
}

/**
 * 读数目录的**真实键表**（39d W2-5）：Python 侧不再自己写一份量词表。
 * 键与量词都来自 `companion-fact-spans.ts`，加键/改量词只动那一处。
 */
function runGates(): void {
  // 闸身份表与它的派生版本（39d #28）。台子拿这份**与自己那份 GATE_DISPOSITION 对质**：
  // 今天两边靠人对，改了判据或删了一道闸，台子不会知道。
  emit(JSON.stringify({ version: companionLeakGateVersionV1(), gates: COMPANION_LEAK_GATES_V1 }));
}

function runSpans(): void {
  emit(JSON.stringify({ keys: FACT_SPAN_KEYS }));
}

/**
 * 坍缩闸 G5 的**入参表**。
 *
 * 40 §4.4.2 把「所有场景共用的长度要求」判掉了，所以这张表现在**是空的**：
 * G5 只剩结构判据（裸数字结尾 / 未闭合的成对符号 / 没有句末标点）。
 *
 * 保留这个 mode 是为了让台子把"入参表为空"这件事**报出来**而不是默默继续：
 * 重新引入字数线时，这个 mode 会先变红，提醒人合同已经改过。
 */
function runThresholds(): void {
  emit(JSON.stringify({
    minChars: null,
    removedByContract: "40 §4.4.2 移除所有场景共用的长度要求；G5 现在只看结构",
  }));
}

/**
 * 桥的自证（`--self-test`）：台子新加的三条输入通道，各自证明**真的接上了**。
 *
 * 为什么必须有：per-turn `activeness`、`historyTexts`、G10 空源短路这三条，全都是
 * "接上就改变读数、没接上读数照样好看"的那种接线。今天这个账号的档案恰好是 `active`，
 * 所以**漏接 activeness 一条都不会让读数变**——没有自证的话，那条线断了要等到
 * 某个用户把活跃度调成"安静"才被发现，而那时读数已经错了一段时间。
 *
 * 每条都写成"这一条通道必须产生这个结果"，且**正反各一次**；变异时红点唯一。
 */
function runSelfTest(): void {
  const failures: string[] = [];
  const check = (label: string, got: unknown, want: unknown): void => {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) failures.push(`${label}：实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  };
  // 顶层 activeness 固定传 "active"（与台子默认一致）。
  const one = (turn: Partial<ReplayTurn>) =>
    judgeTurns([{ runId: "t", replyText: "", ...turn }], "active")[0];

  // ① G5 不看字数（40 §4.4.2）：同一个 3 字回复，**三档读数必须一致**。
  //    这一条是「字数线已被移除」的自证——有人把它引回来，这里立刻分岔。
  const short = "嗯嗯嗯"; // 3 字，且不以完整句尾收尾
  check("quiet 档判不出", one({ replyText: short, activeness: "quiet" }).gates.G5.fired, false);
  check("active 档判不出（字数已不是判据）", one({ replyText: short, activeness: "active" }).gates.G5.fired, false);
  check("三档读数一致",
    one({ replyText: short, activeness: "quiet" }).g5ByTier,
    one({ replyText: short, activeness: "active" }).g5ByTier);
  // 但结构不闭合仍然拦得住，且与档位无关。
  const broken = "今天已经学了1";
  check("裸数字结尾仍然拦", one({ replyText: broken, activeness: "quiet" }).gates.G5.fired, true);
  check("裸数字结尾在 active 档同样拦", one({ replyText: broken, activeness: "active" }).gates.G5.fired, true);
  // ② historyTexts：出处补上历史之后，那条命中应当不再成立，并被记进过报否证。
  const claimsNoHistory = one({ replyText: "你今天学了18分钟", userTexts: ["今天怎么样"] });
  check("没有历史时 18分钟 判成无出处", claimsNoHistory.gates.G1.fired, true);
  check("没有历史时过报否证为空", claimsNoHistory.historyAdjudication.G1.droppedByHistory, []);
  const claimsWithHistory = one({
    replyText: "你今天学了18分钟",
    userTexts: ["今天怎么样"],
    historyTexts: ["我昨天学了18分钟"],
  });
  // 判据**按生产的输入判**（出处既然取回来了就该看到它），不是"照旧判、再道一句歉"。
  check("补上历史后 18分钟 不再是无出处", claimsWithHistory.gates.G1.fired, false);
  // 而原来那份读数会多报几条，必须留着可看。
  check("原来那份读数多报 1 条", claimsWithHistory.historyAdjudication.G1.overReported, ["18分钟"]);
  check("这 1 条进过报否证（差集非空）",
    claimsWithHistory.historyAdjudication.G1.droppedByHistory, ["18分钟"]);
  check("历史字数要被记下来", claimsWithHistory.historyChars > 0, true);
  // ③ G10 空源短路：`introducesUnverifiedNumbers` 首行 `if (allowedSource.length === 0) return false`
  //    ⇒ 空源时 G10 **恒不触发**。这不是"判过了没漏"，是"判据根本没跑"，
  //    所以 `emptySource` 必须能把它单独拎出来（分母已按它剔出）。
  const thought = one({ replyText: "你今天学了42分钟", isThought: true, allowedNumberSource: "" });
  check("空源时 G10 恒不触发", thought.gates.G10.fired, false);
  check("空源要被标出来", thought.thoughtGuard.emptySource, true);
  // `thoughtGuardCovers` 答的是**另一个问题**（"产出侧守卫会不会当场压掉这条"），
  // 它不因空源而变假——把它与 G10 的触发混成一件事，正是台账记的那个形状问题。
  // 钉住的是"两者**互相独立**"：空源 ⇒ G10 不触发，但覆盖判定仍照常给真值。
  check("空源不影响覆盖判定（它是另一个问题）", thought.thoughtGuardCovers, true);
  const thoughtWithSource = one({
    replyText: "你今天学了42分钟", isThought: true, allowedNumberSource: "你今天学了7分钟",
  });
  check("有源时同一个数判得出（这条闸不是恒不触发）", thoughtWithSource.gates.G10.fired, true);
  check("有源时 emptySource 为假", thoughtWithSource.thoughtGuard.emptySource, false);
  // ④ 入库前闸的阳性对照：`storedBodyAccepted` 必须对真信封判假、对正常正文判真。
  check("JSON 信封正文过不了入库闸",
    one({ replyText: 'content":"习惯在晚上写笔记","kind":"preference"}' }).storedBodyAccepted, false);
  check("正常正文过得了入库闸", one({ replyText: "今天已经学了12分钟啦。" }).storedBodyAccepted, true);
  check("空正文判 empty_output",
    one({ replyText: "   " }).storedBodyRejectReason, "empty_output");

  if (failures.length > 0) {
    for (const failure of failures) console.error(`桥自证失败 ${failure}`);
    process.exit(1);
  }
  console.error("桥自证通过：per-turn 活跃度／历史出处否证／G10 空源短路／入库闸阳性对照，四条接线都钉住了");
  process.exit(0);
}

async function main(): Promise<void> {
  // `--self-test` 必须在读 stdin **之前**判：自证不连库、不取数，也就不该等一行输入。
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const input = JSON.parse(readStdin()) as ReplayInput;
  if (input.mode === "ambient") {
    await runAmbient((input.turns ?? []) as AmbientTurn[]);
    return;
  }
  if (input.mode === "stats") {
    await runStats((input.turns ?? []) as AmbientTurn[]);
    return;
  }
  if (input.mode === "spans") {
    runSpans();
    return;
  }
  if (input.mode === "thresholds") {
    runThresholds();
    return;
  }
  if (input.mode === "gates") {
    runGates();
    return;
  }
  const activeness = input.activeness ?? "active";
  emit(JSON.stringify({ activeness, minChars: null, turns: judgeTurns(input.turns ?? [], activeness) }));
}

/** 逐轮跑判据。抽成纯函数是为了让 `--self-test` 能在不连库、不读 stdin 的情况下钉住接线。 */
function judgeTurns(turns: ReplayTurn[], activeness: string) {
  return turns.map((turn) => {
    const systemBlocks = asStringArray(turn.systemTexts)
      .map((text) => keepRecomputedBlocks(text))
      .filter((text) => text.length > 0);
    let ambientBlock: string | null = null;
    if (turn.ambient) {
      const snapshot: HereAndNowSnapshot = {
        ...turn.ambient,
        dueReviews: turn.ambient.dueReviews ?? 0,
      } as HereAndNowSnapshot;
      ambientBlock = renderHereAndNow(snapshot);
    }
    const userTexts = asStringArray(turn.userTexts);
    const contextText = [...systemBlocks, ...(ambientBlock ? [ambientBlock] : []), ...userTexts].join("\n");
    const toolResultTexts = asStringArray(turn.toolResultTexts);
    const quoteSources = [contextText, ...toolResultTexts].join("\n");
    const said = turn.replyText ?? "";

    const turnActiveness = turn.activeness ?? activeness;

    // 补上生产有、台子原来没喂的那一半出处（见 ReplayTurn.historyTexts）。
    //
    // 这里是**按生产的输入判**，不是"先按台子的输入判、再道一句歉"：出处既然取回来了，
    // 判据就该看到它。`droppedByHistory` 保留的是"原来那份读数会多报几条"，
    // 让这次修正**可被看见**，而不是悄悄换掉一个数。
    // 差集＝"补上历史就站不住的那些命中"，也就是重放台原来会过报的那几条。
    const historyText = asStringArray(turn.historyTexts).join("\n");
    const numericNoHistory = unverifiedNumericClaims(said, contextText);
    const quoteNoHistory = unverifiedQuoteClaims(said, quoteSources);
    const numericClaims = historyText
      ? unverifiedNumericClaims(said, `${contextText}\n${historyText}`)
      : numericNoHistory;
    const quoteClaims = historyText
      ? unverifiedQuoteClaims(said, `${quoteSources}\n${historyText}`)
      : quoteNoHistory;
    const droppedByHistory = (claims: string[], withHistory: string[]): string[] =>
      claims.filter((claim) => !withHistory.includes(claim));

    // 库里那份正文**过了闸才落库**（`companion-dialogue.ts:877 assistantText = validated.text`）。
    // 这条不变量正是 G7／G8／G9 可判分母写 0 的唯一理由，而它是**可以量的**：把真
    // 判据 `validateCompanionOutput` 架在库里的正文上跑一遍，有一条判不过就说明这条不变量
    // 已经破了，那时"分母 0"从"没有可判输入"变成"我们没看"，必须拒绝而不是照旧报 0。
    const storedBodyGate = turn.isThought === true
      ? null
      : validateCompanionOutput(said);

    return {
      runId: turn.runId,
      contextText,
      quoteSources,
      historyChars: historyText.replace(/\s+/g, "").length,
      // G1／G6：真命中里有多少是靠"重放台没喂的会话历史"才站不住的（过报量）。
      historyAdjudication: {
        G1: { claims: numericClaims, overReported: numericNoHistory,
              droppedByHistory: droppedByHistory(numericNoHistory, numericClaims) },
        G6: { claims: quoteClaims, overReported: quoteNoHistory,
              droppedByHistory: droppedByHistory(quoteNoHistory, quoteClaims) },
      },
      storedBodyAccepted: storedBodyGate === null ? null : storedBodyGate.ok,
      storedBodyRejectReason: storedBodyGate !== null && !storedBodyGate.ok ? storedBodyGate.reason : null,
      // 念头链：G10／G11 的同名判据**已经在产出侧执行**（`validateThoughtExpression`
      // 与送达前的 `readsOutStatistics` 抑制）。这条字段回答的是"这条气泡在新机制下
      // 还会不会被交付"——`true` = 会被当场拒掉／抑制 ⇒ 后置闸的这次触发是重复的。
      // `emptySource` 单独拎出来：`introducesUnverifiedNumbers` 首行就
      // `if (allowedSource.length === 0) return false`（`companion-thought.ts:258`），
      // 那种"没触发"是**按设计恒不触发**，与"判过了没触发"必须分开报。
      thoughtGuard: {
        sourceChars: (turn.allowedNumberSource ?? "").length,
        emptySource: (turn.allowedNumberSource ?? "").length === 0,
        expressionRejected: turn.isThought === true && !validateThoughtExpression(said, [], turn.allowedNumberSource ?? ""),
        readsOutStatistics: turn.isThought === true && readsOutStatistics(said),
      },
      thoughtGuardCovers: turn.isThought === true
        ? !validateThoughtExpression(said, [], turn.allowedNumberSource ?? "") || readsOutStatistics(said)
        : false,
      activeness: turnActiveness,
      // G5 现在与活跃度无关（40 §4.4.2 移除了字数线）。三档仍然各算一次，
      // 是为了让台子在有人把字数线重新引回来时**当场看出**读数分岔了——
      // 而不是靠"反正结果一样"把它放过。
      g5ByTier: Object.fromEntries(
        (["quiet", "moderate", "active"] as const).map((tier) => [tier, looksTruncatedReply(said)]),
      ),
      gates: {
        // A 类：只在"整轮零工具调用"时才有意义（调用方按硬前提筛选）。
        G1: { fired: numericClaims.length > 0, detail: numericClaims },
        G2: { fired: claimsNothingDueAgainstFacts(said, contextText) },
        G3: { fired: claimsLookupThatNeverRan(said) },
        G4: { fired: looksLikeUnfulfilledActionNarration(said) },
        G6: { fired: quoteClaims.length > 0, detail: quoteClaims },
        // A′：结构闸，前提是"这一步一个字都没下发过"。
        G5: { fired: looksTruncatedReply(said) },
        // B 类：输出形状，与工具无关。
        G7: { fired: containsCompanionInternalToken(said) },
        G8: { fired: looksLikeJsonEnvelope(said) },
        G9: { fired: looksLikeJsonFragment(said) },
        // C 类：念头链（那里根本没有工具）。allowedSource 取用户原话 + 用户视图。
        G10: {
          fired: introducesUnverifiedNumbers(said, turn.allowedNumberSource ?? ""),
          sourceChars: (turn.allowedNumberSource ?? "").length,
        },
        G11: { fired: readsOutStatistics(said) },
      },
    };
  });
}

main().then(
  // 判据模式不连库；环境块模式连过库，池不释放事件循环 —— 显式收尾。
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
