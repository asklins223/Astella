import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

/**
 * 她声称已经对应用里的东西做了写入，而本轮没有任何写回执。
 *
 * 2026-10-25 实机：分类器没给出候选操作，工具面里没有 `companion_edit_note`，
 * 她凭历史里上一次成功改了《周一安排》的记忆，回了一句“改好了……保存回执
 * succeeded”。那句话被当成成功回复落库，下一轮她又拿它当依据。
 *
 * 判据只认**完成形态**（已/已经/帮你 + 写动词，或写动词 + 好/成功/完成，
 * 或明确的保存回执），不认“记住了”这类口语承诺——那种归
 * `looksLikeUnfulfilledActionNarration`。引文块、代码块和引用块里的文字不是
 * 她的声明，先剥掉，避免读过一篇含“已保存”的笔记就误伤正常回答。
 */
const ACTION_COMPLETION_CLAIM = new RegExp([
  "(?:已|已经|刚刚|刚|刚给你|帮你|给你|替你)(?:保存|改好|改|改为|改成|换成|替换|修改|更新|删除|删掉|创建|新建|设置|安排|添加|加到|写入|写进|分享|整理)(?:了|好|成功|完成|好了|成功了|完成了|为|成)?",
  // "已记下：… / 已记住：…" claims the storage happened even without 了.
  "(?:已|已经|刚刚|刚)(?:记下|记住|记好|存下|写下)(?:了)?[：:]?",
  // Forgetting a stored item is a write. Keep the object inside the pattern so
  // ordinary "I forgot about yesterday's worry" stays conversation, not a claim.
  "(?:记忆|偏好|提醒|安排|记录|那条|这条)[^。！？\\n]{0,10}(?:已经)?(?:忘掉|忘记|删掉|删除|清掉)(?:了|好)?",
  "(?:已|已经|刚刚|刚)(?:忘掉|清掉)(?:了)?[：:]?",
  "(?:忘掉|清掉)(?:了)?[：:]",
  "(?:保存|修改|编辑|更新|删除|创建|新建|设置|安排|添加|写入|分享|整理|改|写|画|存|记)(?:好|成)(?:了|啦|咯)",
  "已经(?:画|存|记)(?:好|成|下来|进去)(?:了|啦|咯)?",
  "(?:保存|修改|编辑|更新|删除|创建|新建|设置|安排|添加|写入|分享|整理|改|写)(?:已经|已)?(?:完成|成功)",
  "(?:已|已经)[^。！？\\n]{0,8}(?:保存|替换|修改|更新|删除|创建|新建|设置|安排|写入|分享|整理|改)(?:为|成|好|成功|完成)",
  "(?:保存|执行)回执[^。！？\\n]{0,10}(?:succeeded|成功|已确认|已收到)",
  // "记下了：… / 记住了：…" is the everyday Chinese form of "I have saved it".
  // Without a receipt this is the same false claim as "已保存".
  "^(?:好的?[，,])?(?:我)?(?:记下|记住|记好|存下|写下|收下)了",
  // "第二点改成「…」了 / 已经改成…" claims the edit happened.
  "(?:改|换|替换|更新|调整|删除|加|存|记)(?:成|为|掉|下|好|上)[^，,。！？\\n]{0,24}了",
  // Observed verb forms: "删掉了 / 忘掉了 / 清掉了" without 删除/忘记.
  "(?:删|清|忘|丢)(?:掉|除|弃)(?:了|啦|咯)",
  "(?:那条|这条|它)(?:记忆|记录)?[^。！？\\n]{0,8}(?:已经)?(?:删|忘|清)(?:掉|除)(?:了|啦|咯)?",
  // Observed shorthand completions: "已经排上了 / 已经记进去了 / 已经设好了".
  "(?:已经|已|刚刚|刚)[^。！？\\n]{0,10}(?:排上|设好|记进|记到|存好|删掉|弄好|搞定|加上|写上)(?:了|啦|咯)?",
  "(?:排上|设好|记进|记到|存好|删掉|弄好|搞定)(?:了|啦|咯)",
  "^(?:好了|好)[，,][^。！？\\n]{0,14}(?:排上|设好|记进|记到|存好|删掉|弄好|搞定)(?:了|啦|咯)?",
  // Navigation is an application action too. "已打开笔记库 / 我这就打开" with no
  // page change leaves the user on the same screen believing they moved.
  // Requiring a page-like object keeps ordinary "打开窗户""打开话匣子" out.
  "(?:已|已经|刚刚|刚|这就|于是|顺手)(?:帮你|给你|替你|为你)?(?:打开|跳到|切到|进入|带你(?:去|到))"
    + "[^。！？\\n]{0,12}(?:笔记|手记|卡片|复习|首页|设置|页面|界面|库|面板|列表|详情)",
  // Producing an artifact is delivered work too. "流程图已生成" with no diagram
  // receipt shows the user a picture that does not exist (2026-10-27 soak).
  // The object must be an artifact noun, so "已经生成了想法" stays conversation.
  "(?:图|流程图|图表|脑图|演示|速看|草稿|文档)[^。！？\\n]{0,6}(?:已|已经)?(?:生成|绘制|画好|做好|产出)(?:了|好|完成)?",
  "(?:已|已经|刚刚|刚)[^。！？\\n]{0,8}(?:生成|绘制|画出|做好|产出)(?:了|好)?[^。！？\\n]{0,6}(?:图|流程图|图表|脑图|演示)",
  // A created artifact named by its own noun: "笔记《X》已经建好了". The pattern
  // above needs 已/了 adjacent to the verb, which word order defeats here
  // (2026-10-27 soak: this shipped with zero tool calls twice).
  "(?:笔记|手记|文档|卡片|目标|速看|脑图)[^。！？\\n]{0,16}(?:已经|已)?(?:建好|写好|存好|整理好|保存好|生成好)(?:了|啦)?",
  "(?:我)?(?:这就|马上|立刻)(?:去|来)?[^。！？\\n]{0,6}(?:新建|创建|保存|写入|记下|安排|写成|整理成)[^。！？\\n]{0,12}",
  // An acknowledgement that schedules or opens something the app owns. These
  // carry no 已/了, so the patterns above miss them (2026-10-27 soak: "好，明早
  // 十点提醒你复习" and "笔记库打开了" both shipped with zero tool calls).
  "^(?:好的?|嗯|行|可以|没问题)?[，,]?\\s*(?:明早|明天|后天|今晚|每天|每周|等会|稍后)[^。！？\\n]{0,12}(?:提醒你|叫你|通知你|提醒一下)",
  "(?:笔记|手记|卡片|首页|设置|页面|界面|库|面板|列表|详情)[^。！？\\n]{0,4}(?:已经|已)?(?:打开|切到|跳到|进入)(?:了|啦)?",
  "(?:图|流程图|图表|脑图|演示)[^。！？\\n]{0,4}(?:已经|已)?(?:画|生成|做)(?:出来|好)?(?:了|啦)?",
].join("|"), "giu");
const ACTION_CLAIM_PREFIX_NEGATIVE = /(?:如果|要是|若|是否|会不会|能不能|可不可以|有没有|要不要|没有|还没|尚未|并未|不是|不会|不能|没法|无法|未能|别|不要|不用)[^。！？\n]{0,6}$/u;
const ACTION_CLAIM_TAIL_NEGATIVE = /^(?:[吗么嘛？?]|的|后|之后|的话|条件|前提|方法|时候|再|就|会|要|可以)/u;

function withoutQuotedEvidence(text: string): string {
  let fence: string | null = null;
  // A voice tag (`[neutral]`) can sit at the very start of a sentence, before a
  // claim that anchors on `^`. Strip tags before anchoring, otherwise "好，明天
  // 上午九点提醒你…" never matches and the unbacked promise ships.
  return stripVoiceExpressionTags(text).split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return "";
    }
    if (marker) { fence = marker[1]; return ""; }
    if (/^\s*>/.test(line)) return "";
    return line.replace(/`[^`\n]*`/g, "").replace(/[「“][^」”\n]*[」”]/g, "");
  }).join("\n");
}

/**
 * A quoted payload is evidence of what she says the new content is, not proof of
 * a write. The edit-claim pattern therefore needs the raw line: stripping the
 * quoted span first would erase exactly the sentence that states it.
 */
const QUOTED_EDIT_CLAIM = /(?:改|换|替换|更新|调整|删除)(?:成|为|掉|好)[「“][^」”\n]{1,80}[」”]/gu;

/**
 * A promise that the app will act later is still an application action. Without
 * a scheduled receipt it is only words: "到点我会叫你" on a turn that never
 * created a reminder leaves the user waiting for nothing.
 */
const FUTURE_ACTION_COMMITMENT = new RegExp([
  "(?:到点|到时候)[^。！？\\n]{0,8}(?:会|来)?(?:叫你|提醒你|通知你)",
  "(?:我|之后|以后)[^。！？\\n]{0,6}(?:会|来)(?:提醒你|叫你|通知你)",
  // "明天上午九点提醒你…" can be a description of an existing reminder.
  // Only a first-person future commitment ("明天我会提醒你") or an explicit
  // acknowledgement ("好，明天…提醒你") is a new promise.
  "(?:明天|后天|每天|每周)[^。！？\\n]{0,10}我(?:会|来)(?:提醒|叫|通知)你",
  "^(?:好|好的|嗯|行|可以|没问题)[，,]?\\s*(?:明天|后天|每天|每周)[^。！？\\n]{0,12}(?:提醒|叫|通知)你",
  // "我记下来：…" states a storage action that has not happened yet. Require an
  // explicit object and colon so ordinary conversational "记住了" is untouched.
  "(?:好的?[，,])?(?:我)?(?:记下|写下)(?:来|了)[：:][^\\n]{1,80}",
  // "我安排在…" states that scheduling has been decided; with no receipt it is
  // the same unbacked promise as "已经排上了".
  "(?:我)?(?:已经|已|这就)?(?:安排|设|定|排|记)在[^。！？\\n]{0,20}(?:提醒|叫|通知)",
].join("|"), "gu");

export function claimsFutureApplicationAction(replyText: string): string[] {
  return [...withoutQuotedEvidence(replyText).matchAll(FUTURE_ACTION_COMMITMENT)].map(match => match[0]);
}

function hasApplicationEditContext(prefix: string, tail: string): boolean {
  const clause = prefix.slice(Math.max(...["。", "！", "？", "\n"].map(char => prefix.lastIndexOf(char))) + 1)
    + tail.split(/[。！？\n]/u, 1)[0];
  return /笔记|手记|文档|卡片|标题|正文|段落|提醒|记忆|偏好|设置|安排|记录|第[一二三四五六七八九十\d]+[点条段]/u.test(clause)
    || /(?:帮你|给你|替你|为你)[^。！？\n]{0,24}$/u.test(prefix);
}

export function claimsApplicationActionCompletion(replyText: string,
  options?: { conversationOnly?: boolean; actionRequested?: boolean }): string[] {
  const text = withoutQuotedEvidence(replyText);
  const claims = new Set<string>();
  for (const match of text.matchAll(ACTION_COMPLETION_CLAIM)) {
    const prefix = text.slice(0, match.index);
    const tail = text.slice(match.index + match[0].length);
    if (ACTION_CLAIM_PREFIX_NEGATIVE.test(prefix) || ACTION_CLAIM_TAIL_NEGATIVE.test(tail)) continue;
    // "你终于搞定了" and a casual acknowledgement of the user's progress
    // are not claims that the assistant changed application state.
    if (options?.conversationOnly && /弄好|搞定/u.test(match[0])
      && !/(?:我|帮你|给你|替你|为你)[^。！？\n]{0,16}$/u.test(prefix)) continue;
    // Replacing a premise, symbol, or argument in an explanation is not an
    // application edit. A bare transformation verb needs an app object, an
    // explicit assistance, or an independently identified action request.
    if (!options?.actionRequested && /(?:改|换|替换|调整)(?:成|为)/u.test(match[0])
      && !hasApplicationEditContext(prefix + match[0], tail)) continue;
    claims.add(match[0]);
  }
  for (const line of replyText.split("\n")) {
    if (/^\s*(?:>|```)/.test(line)) continue;
    for (const match of line.matchAll(QUOTED_EDIT_CLAIM)) {
      const prefix = line.slice(0, match.index);
      const tail = line.slice(match.index + match[0].length);
      if (ACTION_CLAIM_PREFIX_NEGATIVE.test(prefix)) continue;
      if (!options?.actionRequested && /(?:改|换|替换|调整)(?:成|为)/u.test(match[0])
        && !hasApplicationEditContext(prefix + match[0], tail)) continue;
      // A suggestion or question ("改成「走路」会更快吧？") did not happen.
      if (/^[^，,。！？\n]{0,24}(?:吧|吗|呢|？|\?)/u.test(tail)
        || /^(?:试试|看看|如何|会不会|行不行|怎么样|更好|更快)/u.test(tail)) continue;
      claims.add(match[0]);
    }
  }
  return [...claims];
}


/**
 * "系统里没有可用的定时提醒能力" — a capability denial, not a completion claim.
 *
 * 2026-10-31 live matrix: the reminder turn was offered
 * `companion_attention_write` (whose own description names `schedule_reminder`
 * and `fireAtLocal`) and answered "没有可用的定时提醒能力，所以这次没成功".
 * The user is told the product cannot do something it can. Only a phrase whose
 * object this deployment really offers is flagged; saying a feature is not
 * connected elsewhere stays an honest limitation.
 */
const CAPABILITY_DENIAL = /(?:没有|不支持|无法|不能|不具备|暂不支持|尚未接入)[^。！？\n]{0,20}(?:提醒|定时|闹钟|记忆|笔记|新建|创建|搜索|检索|读图|看图|流程图|速看|演示|脑图)/gu;
const CAPABILITY_OBJECTS: Array<{ pattern: RegExp; tools: readonly string[] }> = [
  { pattern: /提醒|定时|闹钟/u, tools: ["companion_attention_write", "companion_attention_read"] },
  { pattern: /记忆/u, tools: ["companion_memory_write", "companion_memory_read"] },
  { pattern: /笔记|新建|创建/u, tools: ["companion_notes_write"] },
  { pattern: /搜索|检索/u, tools: ["companion_web_search"] },
  { pattern: /读图|看图/u, tools: ["companion_visual"] },
  { pattern: /流程图|速看|演示|脑图/u, tools: ["companion_visual", "companion_goals_write"] },
];

/** A denial whose object this turn could actually serve. */
export function unbackedCapabilityDenials(replyText: string, offeredToolNames: readonly string[]): string[] {
  if (offeredToolNames.length === 0) return [];
  const offered = new Set(offeredToolNames);
  const text = withoutQuotedEvidence(replyText);
  const denials = new Set<string>();
  for (const match of text.matchAll(CAPABILITY_DENIAL)) {
    const phrase = match[0];
    const object = CAPABILITY_OBJECTS.find(entry => entry.pattern.test(phrase));
    if (!object) continue;
    // Flag only when every tool that could serve this object is offered;
    // otherwise the denial may describe a genuinely missing capability.
    if (!object.tools.some(tool => offered.has(tool))) continue;
    denials.add(phrase);
  }
  return [...denials];
}

/**
 * "最近七天没有留下学习记录" — a negative fact about stored data, stated
 * without reading it. 2026-10-31 live matrix: the workspace had a note and a
 * reminder, and the reply told the user everything was empty. A knowledge
 * question is not a data query: the host cannot know from the sentence alone,
 * so this only routes the turn back to the observation tool once; the model
 * still decides what the data says.
 */
const EMPTY_DATA_ASSERTION =
  /(?:没有|没有任何|没有留下|没留下|查不到|看不到|一条也没有)[^。！？\n]{0,12}(?:学习)?(?:记录|数据|笔记|时长|统计|掌握度|复习)/gu;

export function claimsEmptyStoredData(replyText: string): string[] {
  const text = withoutQuotedEvidence(replyText);
  const claims = new Set<string>();
  for (const match of text.matchAll(EMPTY_DATA_ASSERTION)) claims.add(match[0]);
  return [...claims];
}
