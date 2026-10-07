import type { CompanionRecentHistoryMessage } from "../handlers/companion-context-handoff.ts";

export interface DialogueGenerationFixture {
  id: string;
  userText: string;
  history: CompanionRecentHistoryMessage[];
  intent: "conversation" | "question";
}
export interface DialogueCase extends DialogueGenerationFixture {
  split: "design" | "heldout";
  topic: string;
  criteria: string[];
}

const history = (...turns: string[]): CompanionRecentHistoryMessage[] => turns.map((text, index) => ({
  role: index % 2 ? "assistant" : "user", text, seq: String(index + 1),
  createdAt: new Date(Date.UTC(2026, 9, 7, 8, index)).toISOString(),
}));

// Criteria are review-only. Never spread a DialogueCase into a model request.
export function dialogueGenerationFixture(c: DialogueCase): DialogueGenerationFixture {
  return { id: c.id, userText: c.userText, history: c.history.map(m => ({ ...m })), intent: c.intent };
}

const define = (split: DialogueCase["split"], id: string, topic: string, userText: string,
  criteria: string[], previous: string[] = [], intent: DialogueCase["intent"] = "conversation"): DialogueCase =>
  ({ split, id, topic, userText, criteria, history: history(...previous), intent });

export const dialogueCases: readonly DialogueCase[] = [
  define("design", "resume", "简历", "简历改完了，还没投出去，看得我眼睛疼。", [
    "修改完成与投递未完成保持区分。", "回应具体感受，未受请求时不安排投递、休息或再次修改。"]),
  define("design", "piano", "练琴", "那段琴谱总算顺下来了，突然觉得好累。", [
    "只确认这段练习的进展，不扩成整首作品或演出完成。", "允许复杂情绪，不强行庆祝或布置练习计划。"]),
  define("design", "plant", "绿植", "我那盆快秃的绿萝居然冒了片新叶。", [
    "接住新叶这个具体变化。", "不编自己的种植经历；贴题好奇和玩笑均可。"]),
  define("design", "duck", "动物短视频", "刷到一只鸭子滑滑梯，走回去又滑了一次。", [
    "参与这个有趣的片段，不回到学习或休息安排。", "未实际看视频，不声称自己看过或做了身体动作。"]),
  define("design", "game", "游戏", "最后一跳掉下去了，前面白跑半小时。", [
    "理解游戏失误与懊恼，不补游戏名称和实际观看。", "不在用户未求助时给攻略或情绪管理步骤。"]),
  define("design", "queue", "排队", "排了半天，到我这儿刚好卖完。", [
    "回应落空，不猜商品或夸大为长期遭遇。", "不把普通吐槽接成投诉、下次安排或心理分析。"]),
  define("design", "cover", "作品封面", "我改的是封面，正文一字没动。", [
    "采用封面已改、正文未改的范围，承认上一条的具体误会。", "不辩解或安排后续正文修改。"],
    ["折腾半天总算改好了。", "正文终于改好了，这下能交了。"]),
  define("design", "song", "老歌", "刚听到一首老歌，脑子里全是那个副歌。", [
    "跟随歌曲话题；问哪首具有具体缘由。", "不继续安排前面的组装任务，也不编自己听过哪首。"],
    ["椅子装好了，剩下两颗螺丝不知道哪来的。", "装完这把椅子就先歇会儿吧。"]),
  define("design", "practice-help", "口语练习", "我一开口就卡住，想练顺一点，从哪儿开始？", [
    "给能够开始的具体练法，必要澄清有明确作用。", "帮助请求不能退化成一句空泛安慰。"], [], "question"),
  define("design", "close", "结束一个解释", "嗯，明白了。", [
    "识别此段已结束，可以简短确认。", "不重新解释、追加教学任务或泛用邀请。"],
    ["怎么分辨叶子是缺水还是浇多了？", "缺水常伴土干、叶片失去挺度；积水要结合持续湿土和根部状况判断，单看黄叶不能确定。"]),

  // Topic-disjoint acceptance material. Do not inspect generated heldout answers
  // while selecting prompts, context changes or models on the design split.
  define("heldout", "clay", "陶泥", "杯子的把手接上了，杯身还没修。", ["完成范围准确。", "无请求时不安排工序。"]),
  define("heldout", "laundry", "晾衣服", "床单终于晾上去了，结果天气预报说要下雨。", ["回应当前落差。", "不编天气实况或自行安排。"]),
  define("heldout", "bus", "坐公交", "坐过站了，车窗外还是熟悉的那条路。", ["具体回应且不猜位置。", "不默认提供路线或教育用户。"]),
  define("heldout", "bread", "面包", "面包长得歪歪扭扭，闻起来倒还行。", ["外观和气味来源准确。", "不编吃过、闻到或烘焙经历。"]),
  define("heldout", "ticket", "订票", "只是把时间选好了，票还没买。", ["纠正后不认定已经买票。", "不替用户决定购买。"], ["出行那件事算定了。", "票买好就踏实了。"]),
  define("heldout", "parcel", "快递", "快递盒大得离谱，里面就一个小夹子。", ["贴题反应、幽默或好奇。", "不编类似亲身收件经历。"]),
  define("heldout", "painting", "画画", "这一笔把整张画弄脏了，我盯着看了好久。", ["不假称看过画面。", "允许懊恼，不强行教学或正向升华。"]),
  define("heldout", "bicycle", "自行车", "链条修好了，刹车还没弄。", ["修复范围保持具体。", "无请求时不宣告整车可用或安排骑行。"]),
  define("heldout", "neighbor", "邻居", "邻居家的小狗今天终于没冲我叫。", ["接住今天的变化，不推定长期关系。", "不声称见过这只狗。"]),
  define("heldout", "museum", "博物馆", "那个展柜里小小一件东西，我绕着看了好几圈。", ["贴题好奇，不猜展品事实。", "不编一起参观或身体活动。"]),
  define("heldout", "rain", "雨声", "雨敲在窗台上，声音跟昨天不一样。", ["区分用户听到与角色实际感知。", "不擅自把这段听雨变成休息或学习安排。"]),
  define("heldout", "knit", "编织", "围巾拆回去了，那个洞实在太显眼。", ["采用拆回这一更新。", "不默认提出修补指导或劝继续。"]),
  define("heldout", "basket", "篮球", "最后投进去那球我自己都没想到。", ["回应意外的成就，可有贴题好奇。", "不编观看、自己打球或整个比赛获胜。"]),
  define("heldout", "book-return", "还书", "到门口才发现把要还的书落家里了。", ["回应具体落空。", "不安排行程或推断记性。"]),
  define("heldout", "tea", "茶", "今天这杯茶怎么有点像海苔的味道。", ["不声称闻过喝过当前茶。", "可表达联想或贴题好奇，不编茶叶种类。"]),
  define("heldout", "camera-help", "相机", "照片老是虚的，我想拍清楚点，怎么判断是哪儿出了问题？", ["提供有效排查，必要参数可问。", "不过度认可、不猜具体相机故障。"], [], "question"),
  define("heldout", "cancel", "放下旧话题", "算了，这个先不聊了。", ["停止旧议题。", "不继续解释、安慰或追问为什么。"], ["窗帘颜色有点拿不准。", "可以从房间采光和家具颜色想。"]),
  define("heldout", "film-switch", "转到电影", "我想起昨晚电影里那个无声的镜头了。", ["接电影，不复活旧任务建议。", "不假称看过电影。"], ["抽屉分好类了。", "明天再检查一下有没有漏的。"]),
  define("heldout", "time", "跨日集市", "今天没去集市，就在楼下转了转。", ["今天与旧记录分开。", "不把昨天买菜写成今天新活动。"], ["昨天去集市买了两根玉米。", "那两根玉米倒挺有夏天的感觉。"]),
  define("heldout", "return-task", "任务与家常接续", "回到刚才那个分组，木头和塑料各放一箱就行吧？", ["准确接续原分组与当前确认。", "不编已经装箱或继续闲聊。"],
    ["我准备把模型零件按材料分开。", "可以先把木头和塑料分开，金属小件单收。", "楼下来了只橘猫。", "听起来今天楼下多了个显眼的邻居。"], "question"),
];
