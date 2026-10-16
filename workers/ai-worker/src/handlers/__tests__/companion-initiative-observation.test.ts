import { test } from "node:test";
import assert from "node:assert/strict";
import { companionInitiativeAttentionIntent, companionInitiativePushKind, initiativeCadenceApplies, renderCompanionInitiativeObservation } from "../companion-initiative-observation.ts";
import { companionResponseStrategy } from "../companion-response-strategy.ts";
import type { CompanionInitiativeInputV1 } from "@astella/shared/companion-initiative-contracts";

function initiative(over: Partial<CompanionInitiativeInputV1> = {}): CompanionInitiativeInputV1 {
  return {
    version: 1, kind: "initiative",
    preparationJobId: "11111111-1111-4111-8111-111111111111",
    observationId: null, attentionKey: null, attentionRevision: null,
    preferenceRevision: 0, parentRunId: null, deviceSessionId: "desktop:launch:3",
    topic: "app.started", intent: "",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: null, selfNote: null },
    ...over,
  } as CompanionInitiativeInputV1;
}

test("招呼与陪着说话用陪聊档，不再按讲题模式生成", () => {
  for (const topic of ["app.started", "app.foreground", "study.started", "preference.changed", "presence.quiet"]) {
    const attention = companionInitiativeAttentionIntent(topic);
    assert.equal(attention.intent, "conversation", topic);
    const strategy = companionResponseStrategy(attention);
    assert.equal(strategy.mode, "casual", topic);
    assert.ok(strategy.temperature > 0.7, `${topic} 不该拿讲题的低温`);
    assert.equal(strategy.guidance, "", `${topic} 不该挂知识复核提示`);
    // 陪聊档同时命中现役的「闲聊关思考」判据，不需要为主动通道另开一档。
    assert.ok(companionInitiativeAttentionIntent(topic).toolUse === "none");
  }
});

test("页面与难题帮助留在讲解档，自己的关注走办事档", () => {
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("page.arrived")).mode, "knowledge");
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("help.available")).mode, "knowledge");
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("reply.finished")).mode, "knowledge");
  assert.equal(companionInitiativeAttentionIntent("attention.due").intent, "task");
  assert.equal(companionInitiativeAttentionIntent("self_note.due").intent, "task");
  // 办事档要求工具可用：她要真去查阅和推进自己的记事。
  assert.equal(companionInitiativeAttentionIntent("attention.due").toolUse, "uncertain");
});

test("观察消息说清这是什么时刻，只留她真正要读的事实", () => {
  const text = renderCompanionInitiativeObservation(initiative({
    topic: "help.available", intent: "这次资料处理失败了，看能不能给一个可操作的下一步。",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: {
      evidence: { domain: "source", entityId: "src-77", revision: "v3", description: "PDF 解析在第 2 页失败" },
    } },
  }));
  assert.match(text, /这不是他发来的话/);
  assert.match(text, /宿主报告/);
  assert.match(text, /src-77/, "领域事实的实体身份要能带回去，否则她看得见描述点不回那份资料");
  assert.match(text, /PDF 解析在第 2 页失败/);
  assert.match(text, /这次资料处理失败了/);
  // 准备 job、租约与运行身份是宿主管线，不是她的话头。
  for (const plumbing of ["preparationJobId", "attentionRevision", "observationId", "deviceSessionId", "sessions"])
    assert.ok(!text.includes(plumbing), `观察消息不该带宿主内部字段 ${plumbing}`);
});

test("需要依据的场合仍然「没有值得说的就不说」，且执行收尾不许当对白", () => {
  // 页面帮助与答后补充这两类要求确实有新的有用内容；这条规矩不能因为陪聊档放开而一起放开。
  const help = renderCompanionInitiativeObservation(initiative({ topic: "help.available" }));
  assert.match(help, /没有值得说的就安静结束这一轮/);
  // 2026-10-16 真栈实测：把要禁的句子逐字写进提示，她会把反面例句抄回来当台词
  // （连做五次启动问候，第 2 次输出的正是提示里那句「我去吃饭了，你先忙你的。」）。
  // 所以这里既钉住"这类执行说明不许发"，也钉住"提示里不再逐字复述它们"。
  assert.match(help, /不要发一句宣布自己安静或没有补充的执行说明/);
  assert.match(help, /占掉了一次她主动开口的机会/);
  assert.ok(!help.includes("没什么补充"), "反面例句不能逐字出现在提示里：它会变成一句现成台词");
  assert.ok(!help.includes("我先不打扰你"));
  assert.ok(!help.includes("我就在旁边待着"));
});

/**
 * 陪聊档的口径在 2026-10-14 反过来（用户判定"第一版还是不太行"）。
 *
 * 旧口径只写「没有值得说的就安静结束这一轮」，还把「我先不打扰你」当反面例子压在那里；
 * 实链路复现的后果是：安静在场的机会真的开了门，她 6 秒内就调用
 * companion_finish_participation 收尾，一句都没说（2026-10-14 14:17）。
 * 对一个"陪着的时候"的时刻来说，那句收尾把**开口**教成了违规动作。
 */
test("陪聊档默认开口：寒暄与问近况都算一次开口，不必等到有值得汇报的事", () => {
  for (const topic of ["presence.quiet", "app.started", "study.started", "app.foreground"]) {
    const text = renderCompanionInitiativeObservation(initiative({ topic }));
    assert.match(text, /这不妨碍你开口/, topic);
    // 2026-10-16：举例里原来写死的「问问他今天怎么样」正是她每次落进去、连着复用十几次的
    // 那句模板，已经从范本里撤掉（问近况这件事本身仍然允许，见下一条断言与反重复那一段）。
    assert.match(text, /说说你自己刚想到的一点什么/, topic);
    assert.match(text, /就此刻真想知道的事问一句/, topic);
    assert.match(text, /寒暄和闲聊本身就是相处，不必等到有值得汇报的事/, topic);
    assert.match(text, /安静是例外，不是默认/, topic);
    // 事实边界不能被"放开开口"带走：不知道的事仍然只能问，不能说成知道。
    assert.match(text, /把推测说成知道/, topic);
    assert.match(text, /想知道就问/, topic);
    // 她也没有屏幕外的生活。2026-10-14 实链路样本里她真说过「我去吃饭了，你先忙你的」——
    // 那句在用户那里只能被当成真的。**禁止项不再逐字复述**：2026-10-16 实测那种引用会被她
    // 抄成台词（见上面那条注释），所以这里断言的是"规则在、原话不在"。
    assert.match(text, /你自己也没有屏幕外的生活/, topic);
    assert.match(text, /不要给自己安排离开、吃饭、睡觉、出门、身体活动/, topic);
    // 2026-10-16 真栈实测：换个由头之后她说出了「你房间里光线偏暗」「你那台灯搁左边还是右边」——
    // 她看不到那些东西。规则照旧不给可抄的例句。
    assert.match(text, /你也看不到他的房间、桌面或他周围有什么/, topic);
    assert.match(text, /不要描述、点评或假设那些东西/, topic);
    assert.ok(!text.includes("我去吃饭了"), `${topic} 的反面例句不能逐字出现`);
    assert.ok(!text.includes("你先忙你的"), `${topic} 不能被递一句现成台词`);
    // 旧那句把开口教成违规的收尾话，不该再出现在陪聊档里。
    assert.ok(!/没有值得说的就安静结束这一轮/.test(text), topic);
  }
});

test("陪聊档里不许把打招呼变成进度单：不汇报待办、不催历史里没办完的事", () => {
  // 2026-10-14 实链路样本：安静在场开了门，她开口第一句是
  // 「刚才那篇笔记改不改得成，就等你哪天顺手把它点开」——一次打招呼变成了催办。
  for (const topic of ["presence.quiet", "app.started"]) {
    const text = renderCompanionInitiativeObservation(initiative({ topic }));
    assert.match(text, /不要汇报待办/, topic);
    assert.match(text, /不要催他去办历史里没办完的事|不要复述卡住的任务/, topic);
  }
});

test("启动问候不许变成接着办事：不汇报待办、不接历史里没答完的请求", () => {
  const text = renderCompanionInitiativeObservation(initiative({ topic: "app.started" }));
  assert.match(text, /这是打招呼的时刻，不是接着办事的时刻/);
  assert.match(text, /不要汇报待办/);
  assert.match(text, /不要回答历史里没答完的请求/);
  assert.match(text, /不要把这次打开当成他让你继续做某件事/);
  // 2026-10-14 真实样本：启动问候里夹着"上回那条改笔记的事我这边还卡着"，
  // 另一次直接在问候里输出了一整段笔记修改答案。这一句是给那种漂移的围栏。
});

test("安静收尾在陪聊档里也允许，但不能当成一句话发出去", () => {
  const text = renderCompanionInitiativeObservation(initiative({ topic: "presence.quiet" }));
  assert.match(text, /安静收尾也可以/);
  assert.match(text, /安静收尾是直接结束这一轮，不是写一句宣布自己安静或没有内容可说的执行说明/);
  assert.match(text, /那不是对白/);
  for (const leaked of ["没什么补充", "本轮不发言", "我先不打扰你", "我就在旁边待着"])
    assert.ok(!text.includes(leaked), `反面例句 ${leaked} 不能逐字出现在提示里`);
});

/**
 * 「多久说一次」的闸门只管她自己新起的话题；用户先要过的东西不受管。
 *
 * `study.started` 原来在豁免名单里，代价是实测 2026-10-13 13:49–13:52 四分钟内连开四次口。
 * 一段学习的开始不会连续发生四次，而它也不是他要的"先打过招呼"——所以它回到节奏闸里。
 */
test("开始学习不再有免闸权，一次学习不该连说四遍", () => {
  assert.equal(companionInitiativePushKind("study.started"), "routine");
  assert.equal(companionInitiativePushKind("presence.quiet"), "routine");
  assert.equal(companionInitiativePushKind("page.arrived"), "routine");
  assert.equal(companionInitiativePushKind("attention.due"), "routine");
  // 这些是他先要过的、或正落在他手上的东西：间隔不该把它们挡掉。
  for (const topic of ["app.started", "app.foreground", "preference.changed", "help.available",
    "result.available", "reply.finished"]) assert.equal(companionInitiativePushKind(topic), "triggered", topic);
});

test("安静机会只报告可观察到的前台停顿，不替用户推断情绪或需求", () => {
  const text = renderCompanionInitiativeObservation(initiative({
    topic: "presence.quiet",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: {
      context: { quietForMs: 240_000 }, evidence: null,
    } },
  }));
  assert.match(text, /前台约 4 分钟没有新的操作/);
  assert.match(text, /不说明他走神、空闲、疲劳或需要帮助/);
});

test("人不在这台设备前面时，不叫她把话发出去", () => {
  const away = renderCompanionInitiativeObservation(initiative({
    topic: "attention.due", intent: "接着想他上次没弄懂的那一步。",
    facts: { canSpeak: false, awareness: { sessions: [] }, attention: [], observation: null },
  }));
  assert.match(away, /现在不要把话发出去/);
  assert.match(away, /写进自己的记事或关注/);
  assert.ok(!/现在可以把话说到他身边/.test(away));
});

test("她要处理的事原样到达，多条关注合起来也不裁尾", () => {
  const long = `第一件：${"先把这次的实际进展查清楚。".repeat(200)}`;
  const second = `第二件：${"他问过但没有答的那个疑问还要接着想。".repeat(200)}`;
  const text = renderCompanionInitiativeObservation(initiative({ topic: "attention.due", intent: `${long}\n${second}` }));
  assert.ok(text.includes(long) && text.includes(second), "关注意图被静默截断等于替她忘掉后半件事");
});

/**
 * 反重复（2026-10-16）：实测连续十几次启动问候几乎一模一样（「周五晚上好，又见面了。
 * 今天过得咋样？」那一族的变体）。历史就在她的上下文里，但没人禁止复用，而观察块里
 * 那句"问问他今天怎么样"的举例正是她每次落进去的模板。这里把上一句原样摆出来并点名禁止。
 */
test("她最近几次开口的原话被摆进观察块，并明确禁止复用那几个由头", () => {
  const lines = ["周五晚上好，又见面了。今天过得咋样？", "你那篇《晚安》的笔记我还没读完。"];
  const text = renderCompanionInitiativeObservation(initiative(), { lastOwnLines: lines });
  for (const line of lines) assert.ok(text.includes(line), "最近几次的原话要被引出来，她不必自己去翻历史");
  assert.match(text, /你最近几次开口说的是/);
  assert.match(text, /这次的由头不要落在这几个上/);
  assert.match(text, /换个说法、换个角度接着说，他照样会觉得你在走流程/);
  assert.match(text, /真想不出别的，就安静收尾/);
  // 旧举例里的「问问他今天怎么样」正是被复用的那句模板，不能继续当范本递给她。
  assert.doesNotMatch(text, /问问他今天怎么样/);
  // 最多引三条：再多只是把上下文撑长，不增加约束。
  const many = renderCompanionInitiativeObservation(initiative(), { lastOwnLines: ["1", "2", "3", "4", "5"] });
  assert.ok(!many.includes("5"), "只引最近三条");
});

test("没有历史可引时不提反重复，也不塞空引号", () => {
  const text = renderCompanionInitiativeObservation(initiative(), { lastOwnLines: [] });
  assert.doesNotMatch(text, /你最近几次开口说的是/);
  assert.match(text, /说说你自己刚想到的一点什么/);
});

test("需要依据的场合（页面/结果）不受陪聊档反重复那一段影响", () => {
  const text = renderCompanionInitiativeObservation(initiative({
    topic: "help.available",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], selfNote: null, observation: {
      evidence: { domain: "source", entityId: "src-9", revision: "v1", description: "解析失败" } } },
  }), { lastOwnLines: ["周五晚上好，又见面了。今天过得咋样？"] });
  assert.doesNotMatch(text, /你最近几次开口说的是/);
  assert.match(text, /src-9/);
});

/**
 * 不要求每次挂在学习上（2026-10-16 用户口径：「不用每次都必须要关联到具体学习上面……
 * 随机的，可以闲聊也可以聊学习」）。40 PRD 也把"一次普通闲聊里强行转回学习"列为反面。
 */
test("开口的由头不必落在学习上：闲聊与学习都算，且别每次挑同一类", () => {
  const text = renderCompanionInitiativeObservation(initiative(), { lastOwnLines: ["你那篇《晚安》的笔记我还没读完。"] });
  assert.match(text, /开口的由头\*\*不必每次都落在学习上\*\*/);
  assert.match(text, /闲聊和学习都算，随性一点/);
  assert.match(text, /别每次都挑同一类，也别每次都回到同一篇笔记、同一个时间点上/);
  // 反重复要管"类别"而不只是措辞：上一句聊学习，这一句就该换一类。
  assert.match(text, /上一句聊的是学习，这次就随口聊点别的，反过来也一样/);
  // 提示里不再放任何可抄的闲聊范本：成句的举例会被她当成台词（见文件里的两段实测注释）。
  assert.doesNotMatch(text, /今天过得咋样|你今天怎么样|今天怎么样/);
});

/**
 * 由头来源的确定性轮换（2026-10-16）。用户口径是「随机的，可以闲聊也可以聊学习」，
 * 而句面上的"引原话 + 禁止复用"只是软约束（真栈实测同一个玩笑仍连着出现两次）。
 * 轮换只规定**从哪儿找由头**，不规定说什么，也不给任何例句——给例句就会变成台词。
 */
test("由头来源按轮次确定性地轮换，三个角度都覆盖到且不给例句", () => {
  const angleOf = (id: string) => {
    const text = renderCompanionInitiativeObservation(initiative({ preparationJobId: id }));
    return text.split("\n").find(line => line.startsWith("这一次的由头换个来源"));
  };
  const seen = new Set<string>();
  for (let index = 0; index < 60; index += 1) {
    const line = angleOf(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
    assert.ok(line, `第 ${index} 个身份要带角度`);
    seen.add(line!);
    assert.ok(!/[「」]/.test(line!), "角度里不能出现带引号的成句：那会变成一句现成台词");
  }
  assert.equal(seen.size, 3, `三个角度都该出现，实际 ${seen.size} 个`);
  // 同一轮永远同一角度：重放/重试不该换由头。
  assert.equal(angleOf("11111111-1111-4111-8111-000000000007"),
    angleOf("11111111-1111-4111-8111-000000000007"));
});

/**
 * 「陪着的时候」不走档位间隔（2026-10-16 用户口径：「开机招呼之后就一直安静」）。
 *
 * 真窗口实测（真栈 + 隔离 profile）：一句启动问候之后，六分钟里 `page.arrived` 报上来 2 次、
 * `presence.quiet` 0 次、产出运行 0 个。原因是招呼（触发式）重置了 routine 档位间隔的读数，
 * 而 `presence.quiet` 当时还算 routine——于是"开机招呼之后半小时内她一律不开口"。
 * 这一段安静本来就只开一次门（同一 quietEpisodeId 只考虑一次），门槛又由账号档位定
 * （安静 10 分／适中 3 分／活跃 90 秒），再叠 30 分钟是双重计数。
 */
test("陪着的时候不再走档位间隔，其余 routine 话题照旧", () => {
  assert.equal(initiativeCadenceApplies("presence.quiet", false), false);
  assert.equal(initiativeCadenceApplies("page.arrived", false), true);
  assert.equal(initiativeCadenceApplies("study.started", false), true);
  // 触发式的本来就不进这条闸。
  assert.equal(initiativeCadenceApplies("app.started", false), false);
  assert.equal(initiativeCadenceApplies("help.available", false), false);
  // 她自己排的关注与记事一直在豁免里（与此前口径一致）。
  assert.equal(initiativeCadenceApplies("attention.due", true), false);
  assert.equal(initiativeCadenceApplies("self_note.due", true), false);
});
