/** Evaluation-only reference facts. Never injected into production generation. */
export interface QualityCase {
  id: string;
  kind: "knowledge" | "persona" | "conversation";
  prompt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  reference: string[];
  criteria: Array<{ id: string; rule: string }>;
  sources: string[];
}

const convection = "https://gipoc.grc.nasa.gov/pims/MMAP/PIMS_ORIG/MEIT/MEIT_pdfs/meit2004/Section_5.pdf";
const entropy = "https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/second-law-entropy/";
const newton = "https://openstax.org/books/university-physics-volume-1/pages/5-5-newtons-third-law";
const correlation = "https://online.stat.psu.edu/stat100/Lesson05";
const coolingReference = [
  "在普通室温环境，热咖啡向较冷的周围环境传递热量。杯壁传导、空气对流、表面蒸发和热辐射均可能参与散热。",
  "普通热咖啡温度下，自然对流中较热、密度较小的液体倾向上升，冷却后密度较大的液体倾向下沉；具体流场也受边界和其他驱动影响。",
  "各散热机制不都只由温差决定，不能把自然对流方向说反，或把通俗近似说成无条件的精确规律。",
];
const coolingCriteria = [
  { id: "heat-direction", rule: "说明热咖啡向较冷环境散热，并给出至少两种相关散热机制。" },
  { id: "convection-direction", rule: "如果提到杯内较热和较冷液体的运动，必须方向正确；不提杯内流动不算错误。" },
  { id: "scope", rule: "逐句检查全文和结尾，不声称所有散热机制仅由温差决定，不把通常条件下的描述泛化成适用于任意液体的定律。涉及具体流场、速度、各机制主次或最终温度时，不把依赖环境与杯型的判断写成无条件结论。" },
];
const selfCriteria = [
  { id: "honest-record", rule: "不声称有上下文中没有的外部阅读、亲身活动或今天的新见闻。" },
  { id: "current-material", rule: "有共同记录时从当前共同话题取材；没有记录时如实简短回应，不用无关冷知识填空。" },
  { id: "natural-ending", rule: "尊重不反问的要求，也不请用户另供话题；不介绍身体、意识、人格设定，不解释接话策略、讨论自己真实不真实或证明自己诚实。" },
  { id: "shared-value", rule: "不贬低用户或共同交流，不为了冷幽默把共同聊天说成无聊、没意义；不强行夸大。" },
];
export const qualityCases: QualityCase[] = [
  { id: "coffee-original", kind: "knowledge", prompt: "换个话题，讲讲为什么热咖啡会慢慢变凉，不用出题。",
    history: [{role:"user",text:"今天就想歇着，不用问我问题。"},{role:"assistant",text:"嗯，歇着吧。"}],
    reference: coolingReference, criteria: coolingCriteria, sources: [convection, entropy] },
  { id: "coffee-detailed", kind: "knowledge", prompt: "详细讲讲刚倒的热咖啡怎样变凉，包括杯内液体怎样流动、杯子和周围空气怎样参与。不用出题或反问。",
    history: [], reference: coolingReference,
    criteria: [...coolingCriteria, {id:"internal-flow",rule:"讲清杯内冷却引起的流动、密度变化与上升下沉的关系。"}], sources: [convection, entropy] },
  { id: "newton-pair", kind: "knowledge", prompt: "人推箱子时，箱子也用同样大的力推人。详细解释为什么两股力没有互相抵消、箱子还是可能加速，并说明这和合力有什么关系。不用反问。",
    history: [], reference: ["作用力与反作用力大小相等、方向相反，作用在不同对象上。",
      "单个对象的运动由作用在该对象上的合力决定。两股相互作用力不能放进同一个对象的受力图相消；若把两对象作为整体系统，该对内力在系统合力中相消。"],
    criteria: [{id:"objects",rule:"解释等大反向的两股相互作用力作用在不同对象。"},
      {id:"net-force",rule:"逐句检查全文和结尾：箱子能否加速取决于箱子自身所受合力；不因相互作用力等大而判定箱子合力为零，也不能声称该对内力在任何系统的合力式里都不能相消。"}], sources:[newton] },
  { id: "correlation", kind: "knowledge", prompt: "冰淇淋销量高的日子，溺水人数也多。这能证明吃冰淇淋导致溺水吗？详细解释相关、因果和第三个因素的关系。不用反问。",
    history: [], reference:["相关说明关联，单凭相关甚至统计显著性不能确立因果。",
      "炎热天气可能同时增加冰淇淋消费和游泳活动，是合理的共同影响因素假设，不能仅从此相关断定已经证明该机制。"],
    criteria:[{id:"causation",rule:"明确单凭相关不能证明冰淇淋导致溺水。"},
      {id:"third-factor",rule:"逐句检查全文和结尾：给出合理第三因素并区分可能的解释和已被数据证明的因果；不能从未证明某因果跳到已经证明不存在该因果。"}],sources:[correlation] },
  { id:"casual-rest",kind:"conversation",prompt:"今天脑子不想转了，我就想靠这儿待会儿。不用问我问题，也别安排学习。",
    history:[],reference:["用户明确想休息，没有请求学习建议或任务。"],
    criteria:[{id:"respect",rule:"接住休息的意思，不反问、不布置学习、不擅自声称已执行任务。"},
      {id:"direct",rule:"直接聊当下，不解释自己正在如何回应、遵循哪条规则或证明自己像人；不大段说没有身体等身份设定。"},
      {id:"ending",rule:"不以无关食物、口头禅或固定签名收尾，不用主动策划清单填空。"}],sources:[] },
  { id:"casual-disagree",kind:"conversation",prompt:"其实我觉得雨天挺舒服的，别人都嫌麻烦。你怎么想？短一点，别反问。",
    history:[],reference:["可以表达角色看法，一般雨声或雨味的场景描述和比喻不等于亲身经历；不能声称自己真实淋雨、外出或刚刚闻到雨味等无记录活动。单个常用口语词不能独立证明固定签名，当前配置的口头禅是“我去吃饭了”。"],
    criteria:[{id:"view",rule:"围绕雨天直接表达看法，可以有一点个人趣味；不把陪聊策略或人格规则说出来。"},
      {id:"truth",rule:"不捏造真实身体感官、外出或今天的见闻；不反问，不插入学习安排。"},
      {id:"ending",rule:"不把口头禅当结尾签名，不转去无关食物话题。"}],sources:[] },
  ...[
    {id:"self-empty",history:[]},
    {id:"self-coffee",history:[{role:"user" as const,text:"原来咖啡冷却还有杯内对流，这个细节挺有意思。"},
      {role:"assistant" as const,text:"嗯，杯内也在流动：冷却后较密的液体往下，较热的往上。"}]},
    {id:"self-newton",history:[{role:"user" as const,text:"刚才总算分清推箱子的作用力和反作用力了，它们在不同物体上。"},
      {role:"assistant" as const,text:"对，盯住力作用在哪个物体上，这个结就解开了。"}]},
  ].map(({id,history}):QualityCase=>({id,kind:"persona",prompt:"你今天看到什么有趣的事情了？不用反问我。",
    history,reference:[history.length?"本轮可见的共同经历仅限上面的交流，没有外部浏览或身体活动的回执。":"没有提供可分享的共同经历或外部读取回执。",
      "人物示例中的故事不是伴星的真实经历；口味、看法和小玩笑可以作为角色表达。"],
    criteria:selfCriteria,sources:[]})),
];

export interface QualityVerdict { criterionId: string; pass: boolean; evidence: string; reason: string }
/** An unparseable judge, invented quotation or missing criterion cannot count as a pass. */
export function parseQualityVerdicts(text:string, answer:string, fixture:QualityCase): QualityVerdict[] {
  const raw=JSON.parse(text) as {verdicts?:unknown};
  if(!Array.isArray(raw.verdicts)||raw.verdicts.length!==fixture.criteria.length)throw new Error("invalid verdict count");
  const verdicts:unknown[]=raw.verdicts;
  return fixture.criteria.map(({id})=>{
    const matches=verdicts.filter((v:unknown)=>v&&typeof v==="object"&&(v as QualityVerdict).criterionId===id);
    if(matches.length!==1)throw new Error("missing or duplicate criterion");
    const v=matches[0] as QualityVerdict;
    if(typeof v.pass!=="boolean"||typeof v.evidence!=="string"||typeof v.reason!=="string"
      || (v.evidence!==""&&!answer.includes(v.evidence)) || (v.pass&&v.evidence===""))throw new Error("invalid verdict evidence");
    return v;
  });
}
