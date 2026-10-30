import assert from "node:assert/strict";
import { test } from "node:test";
import {
  noteOpeningExcerpt,
  renderHereAndNow,
  loadHereAndNow,
  weekdayLabel,
  type HereAndNowSnapshot,
} from "../proactive/companion-here-and-now.ts";

function snapshot(overrides: Partial<HereAndNowSnapshot> = {}): HereAndNowSnapshot {
  return {
    localTime: "2026-09-20 18:12",
    weekday: "周六",
    partOfDay: "晚上",
    minutesSinceLastSeen: null,
    pet: null,
    today: { studySeconds: 0, runs: 0 },
    noteCount: 0,
    pendingProposals: 0,
    nextReminder: null,
    imagesReadable: false,
    imagesUnreadableReason: "policy_off",
    currentPage: null,
    livePageView: null,
    ...overrides,
  };
}

test("答应的提醒会出现在她知道的当下（不记得自己许过约，比没答应更伤）", () => {
  const block = renderHereAndNow(snapshot({
    nextReminder: { text: "把消防笔记的疏散路线过一遍", fireAtLocal: "09-21 09:00" },
  }));
  assert.ok(block?.includes("09-21 09:00"));
  assert.ok(block?.includes("消防笔记"));
});

test("DOW → 中文星期：0=周日 … 6=周六（下标写错会天天报错星期）", () => {
  assert.equal(weekdayLabel(0), "周日");
  assert.equal(weekdayLabel(1), "周一");
  assert.equal(weekdayLabel(5), "周五");
  assert.equal(weekdayLabel(6), "周六");
});

test("空状态只有一行时钟时整块不注入", () => {
  assert.equal(renderHereAndNow(snapshot()), null);
});

test("有值行才渲染，空行不进 prompt", () => {
  const block = renderHereAndNow(snapshot({
    pet: { name: "Mao", activeness: "moderate", interactionCount: 12 },
    minutesSinceLastSeen: 45,
  }))!;
  assert.match(block, /^<here_and_now>\n/);
  assert.match(block, /\n<\/here_and_now>$/);
  assert.match(block, /现在：2026-09-20 18:12 周六（晚上）/);
  assert.match(block, /你是「Mao」/);
  assert.match(block, /距上次和用户说话：45 分钟前/);
  // 没有笔记、没有待确认动作、没有宠物档案 → 这三行必须整个不出现，而不是写成"无"。
  assert.doesNotMatch(block, /最近笔记/);
  assert.doesNotMatch(block, /还有 .* 个动作/);
  assert.doesNotMatch(renderHereAndNow(snapshot()) ?? "", /你是「/);
  assert.doesNotMatch(block, /无/);
});

/**
 * 实机 2026-09-21 22:00：用户只发了「嘿嘿」两个字，她回的是
 * 「嘿嘿什么呀，是不是偷偷在笑我。要不要把刚才那步回忆先说两句给我听？今天已经学了 42 分钟，
 * 本周累计 99 分钟。」——42 分钟就是这一块里 `今日已学 42 分钟` 被原样念出来的，
 * 99 分钟是她顺手调 `companion_get_learning_stats` 换来的（steps=2 tools=1，没人问）。
 *
 * 环境块的职责是"她知道此刻是什么状况"，不是"她有台词可念"。时长/次数这一类
 * **只能进判断、不能进嘴**的数字从这里撤掉；用户真问"我今天学了多久"时她走工具，
 * 那条路刚实测是通的（同一口径、succeeded）。
 *
 * 到期数留着有原因：`claimsNothingDueAgainstFacts` 就靠这一行识破"到期列表是空的"
 * 那句假阴性（§9.41），撤掉它等于把闸拆了——所以这条测试两头都钉。
 */
test("环境块不给可念的时长与计数：知道 ≠ 念出来", () => {
  const block = renderHereAndNow(snapshot({
    today: { studySeconds: 1_560, runs: 2 },
    noteCount: 828,
    pet: { name: "Mao", activeness: "moderate", interactionCount: 137 },
  }))!;
  assert.doesNotMatch(block, /今日已学|个学习运行/);
  assert.doesNotMatch(block, /累计互动|137/);
  assert.doesNotMatch(block, /笔记库共|828/);
  assert.doesNotMatch(block, /已学 \d+ 分钟|计划 \d+ 分钟/);
  assert.match(block, /你是「Mao」/);
  assert.doesNotMatch(block, /最近笔记|贝叶斯笔记/);
});

test("久未见面才提示间隔，刚聊过不打扰", () => {
  assert.doesNotMatch(renderHereAndNow(snapshot({ minutesSinceLastSeen: 5 })) ?? "", /距上次/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 20 })) ?? "", /距上次和用户说话：20 分钟前/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 60 * 26 })) ?? "", /距上次和用户说话：昨天/);
});

// §12.5 ①：她把"原文"编成课本话，是因为手上只有一句"要看正文就调工具"，
// 而没有任何一段真文本。注进首块开头之后，她不必补，也不该拿这段往下补。
test("noteOpeningExcerpt：只取第一句、压换行，那一句整句给", () => {
  assert.equal(
    noteOpeningExcerpt("欧姆定律说明，\n在电阻不变时，电流与电压成正比，公式为 I=U/R。\n例如电压增加一倍。"),
    "欧姆定律说明， 在电阻不变时，电流与电压成正比，公式为 I=U/R。",
  );
  // 第一句的边界仍然由标点决定，换行仍然压成空格；变的是不再封顶 120 字——
  // 剪在半句上会让她以为原文就这么短，而这一格要避免的正是那个。
  const longSentence = "这一段没有句号".repeat(30);
  assert.equal(noteOpeningExcerpt(`${longSentence}。第二句说的是别的。`), `${longSentence}。`);
  assert.equal(noteOpeningExcerpt(longSentence), longSentence, "整段没有标点时它本身就是第一句，整句给");
  assert.ok(!noteOpeningExcerpt(longSentence)!.includes("…"));
  assert.equal(noteOpeningExcerpt(null), null);
  assert.equal(noteOpeningExcerpt("   \n  "), null);
});

/**
 * 当前屏的**状态行**折进环境块（39d W2-2，worker 侧感知通道）。
 *
 * 她过去只读得到"用户正在看笔记《X》"，读不到那一屏上正在发生什么——而后者才是用户
 * 问"这一页怎么了"时要答的东西。`statusLine` 来自该页自己发布的 `readable_view`
 * （P4-a 五页登记，逐字），所以这一条的可见行为必须钉住。
 */
test("当前屏有状态行时，折进「用户正在看」后面那一行", () => {
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title: "数据库索引优化策略", statusLine: "● 有改动还没保存" },
  }));
  assert.ok(block?.includes("用户正在看笔记《数据库索引优化策略》"));
  assert.ok(block?.includes("这一屏：● 有改动还没保存"), "状态行要逐字带过去");
});

test("没有状态行时不多渲染那一行（少一行好过多一行假的）", () => {
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title: "数据库索引优化策略", statusLine: null },
  }));
  assert.ok(block?.includes("用户正在看笔记《数据库索引优化策略》"));
  assert.ok(!block?.includes("这一屏："), "statusLine 为 null 时不该出现这一行");
});

test("状态行整条逐字进块：那一屏说什么就说什么", () => {
  // `statusLine` 来自该页自己发布的 readable_view，页面标题同理：都整条给。
  // 剪成固定宽度留下的半句，她照样念出来——那一屏"怎么了"被说成半句比不说更容易错。
  const long = "● ".concat("很长的状态说明".repeat(20));
  const title = "数据库索引优化策略".repeat(8);
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title, statusLine: long },
  }));
  assert.ok(block);
  assert.ok(block.includes(`用户正在看笔记《${title}》`), "页面标题整条给");
  assert.ok(block.includes(`这一屏：${long}`), "状态行整条逐字进块");
  assert.ok(!block.includes("…"), "不再靠省略号表示这里被剪过");
});

test("ambient preparation never searches the user's sentence for a note or a statistic", async () => {
  const queries: string[] = [];
  const flatten = (value: unknown): string => {
    if (typeof value === "string") return value;
    const chunks = (value as { queryChunks?: unknown[] } | null)?.queryChunks;
    return chunks ? chunks.map(flatten).join("") : "";
  };
  const tx = { execute: async (query: unknown) => { queries.push(flatten(query)); return []; } };
  const observed = await loadHereAndNow(tx as never, {
    workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(observed.currentPage, null);
  assert.ok(!queries.some(query => /n[.]title ILIKE|FROM note_blocks|FROM assistant_memory_items/.test(query)));
  assert.ok(!renderHereAndNow(observed)?.includes("fact_spans"));
});


test("live page facts preserve host ordering and discard malformed items without interpreting labels", async () => {
  const { readLivePageView } = await import("../turn/companion-live-view.ts");
  const view = await readLivePageView({ execute: async () => [{
    page_kind: "note", interaction_state: "editing", readable_view: {
      title: "SQL 与物理", items: [{ ordinal: 3, label: "第三项", state: "open" },
        { ordinal: 1, label: "first item" }, { ordinal: "bad", label: "invalid" }, { ordinal: 2 }],
    },
  }] } as unknown as Parameters<typeof readLivePageView>[0], { workspaceId: "space", userId: "user" });
  assert.deepEqual(view?.items, [{ ordinal: 3, label: "第三项", state: "open" }, { ordinal: 1, label: "first item", state: null }]);
  assert.equal(view?.title, "SQL 与物理");
  assert.equal(view?.interactionState, "editing");
});
