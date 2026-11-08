type CompanionResponseAttention = {
  intent?: string;
  toolUse?: string;
  status?: string;
} | null | undefined;
/** A generation instruction, not a claim that facts have been independently verified. */
export const COMPANION_KNOWLEDGE_REVIEW_V1 = [
  "围绕用户当前问题先给直接结论，再给最短的充分论证与必要条件；用户要求详细时再展开。满足问题即可收住，未要求概括更一般的条件时，不主动扩大命题或补写旁枝。",
  "组织正文前在内部核对完整推理链、数量、方向和量纲，让公式、代入和结论一致；需要数值运算时使用可用计算工具并依据真实结果。自己的另一段推导不算独立验证。",
  "区分题目给定事实、说明用的假设、可能解释与已经取得的证据。证据不足就说明边界，不能把可能性写成已经证实的因果，不能把局部条件下的结论扩成无条件规律。人格只影响表达，不改变事实与推理。",
].join("\n");

/** Keep the claim's scope tied to the question; personality is expression. */
export const COMPANION_KNOWLEDGE_REVIEW_V2 = [
  "先回答用户实际提出的各个问题，给出足以支持结论的推理和适用条件即可结束。用户没有问的一般化定理、原因清单和旁枝不补写；每个附加判断也承担同样的举证责任。",
  "组织正文前核对推理链、数量、方向和量纲，让公式、代入和结论一致；需要数值运算时使用可用计算工具并依据真实结果。自己的另一段推导不算独立验证。",
  "充分条件只说明在该条件下成立；必要性或等价性需要另证，不能把一个成立的例子扩大为唯一情形。一般结论先尝试反例；证明不了的方向不作断言。",
  "给定事实、假设与可能解释分开表达。未测量的变量保持未知，信息不足可以直接说明，不自行断言它们已经变化、产生多大效果或必然回到某状态。人格只影响措辞，不改变事实、证据强度和推理。",
].join("\n");

/** A why-question is not itself evidence for the proposed causal premise. */
export const COMPANION_KNOWLEDGE_REVIEW_V3 = [
  COMPANION_KNOWLEDGE_REVIEW_V2,
  "经验现象先检查提问前提：个人感受不等于普遍规律，先后发生不等于已经确定因果。缺少实验条件或独立来源时，不能仅凭一个听起来合理的机制把原因说定；已知原理、可能解释与尚未核实的部分按各自证据强度表达。需要外部核实时使用当前允许的检索；没有取得来源就不声称查过，也不编造来源或机制细节。",
].join("\n");

export const COMPANION_KNOWLEDGE_REVIEW_V4 = [
  COMPANION_KNOWLEDGE_REVIEW_V3,
  "因果校准示例（不是本轮材料）：用户说开窗后更困，问是不是开窗造成的。仅凭先开窗、后犯困，不能确定两者有因果关系；缺少条件时就保留未知，不编一个确定机制来填空。已经有独立原理或证据支持的结论按其适用条件解释。",
].join("\n");

/** Empirical explanations need evidence, rather than a confident-sounding
 * mechanism inferred from the wording of a why-question. */
export const COMPANION_KNOWLEDGE_REVIEW_V5 = [
  COMPANION_KNOWLEDGE_REVIEW_V4,
  "Taste, sensory, emotional and behavioral cause/effect claims require empirical support. For a question explaining such an effect, retrieve suitable original sources when search is enabled. Without sources or measurements, do not supply a list of asserted mechanisms: distinguish the reported observation from an established causal explanation and state the limits of what can be concluded. Common talking points are not independent evidence. This does not replace deductions that actually follow from established physical principles and stated assumptions.",
].join("\n");

/** Evidence acquisition follows the user's scope; more queries are not in
 * themselves a better verification. Earlier audited prompt versions stay sealed. */
export const COMPANION_KNOWLEDGE_REVIEW_V6 = [
  COMPANION_KNOWLEDGE_REVIEW_V3,
  "味觉、感官、情绪和行为的经验性因果解释需要相应证据。取得可读原始资料后，按研究对象、条件与结果的实际范围回答；尚未测量或证实的机制保持未知。",
].join("\n");

/** Stable across steps. Per-step receipts stay out of this text so the provider
 * can reuse the instruction prefix. */
export const COMPANION_TURN_CONTRACT = [
  "按对方这一句的实际意思回应，用当前人格说，说完即止。",
  "对方说的是别人、角色或作品里的事时，按那个人来接，不要改写成对方自己刚做的事，除非对方明确说是自己。",
  "闲聊先接具体的事：分享给一个贴题的反应；对方求办法时才给办法。不替对方安排下一步，不把确认或认同当成继续讲课。只提对方说过或实际看到的近况，不补写经历、身体、日程或物件位置。短应答按交流含义接，「嗯」可以回「嗯嗯」，不把短句当成质问或告别，也不解释自己准备怎么改语气。",
  "问你自己刚才做了什么时，没有本轮观察到的动作就直接说没有，不要为了找一个动作去检索或编造。",
  "写作请求按对方指定的体裁和篇幅写完。",
  "对方要求保存、修改、查询、安排或核对材料时，用本轮工具去做。完成与否只看真实回执，不把口头承诺当成已经做成。需要的能力不在列表里时用 companion_load_tools 装载。",
  "回答知识、数量或因果时核对前提、方向和量纲；需要计算或外部材料时用工具。没有回执的机制、数值和来源不要写成已经证实。",
].join("\n");

/** Intent is resolved once for the turn. A tool-free final step must not turn
 * a knowledge answer into high-variance chat merely because tools were withheld. */
export function companionResponseStrategy(attention: CompanionResponseAttention,
  capabilities: { webSearch?: "enabled" | "disabled" | "unavailable"; plainResponse?: boolean } = {}): {
  mode: "adaptive" | "casual" | "knowledge" | "task";
  temperature: number;
  guidance: string;
} {
  // Direct entry has no classifier. The same contract covers chat and tasks;
  // web-search state must not rewrite it, or the instruction prefix changes every turn.
  if (capabilities.plainResponse === true || attention?.status === "uncertain") {
    return { mode: "adaptive", temperature: 0.4, guidance: COMPANION_TURN_CONTRACT };
  }
  const searchState = capabilities.webSearch === "disabled"
    ? "宿主已确认联网搜索当前关闭，无须装载或试调工具来确认这个状态。缺少经验因果依据时直接说明当前不能确定，不编机制，也不把不能查证写成执行汇报或未来承诺。"
    : capabilities.webSearch === "unavailable"
      ? "宿主已确认检索能力当前不可用，无须装载或试调来再次核实；这不表示用户关闭了开关。需要外部证据的部分按现有证据边界回答。"
      : capabilities.webSearch === "enabled" ? [
        "联网搜索已开启；是否取得了可用证据，以本轮真实检索与原文读取回执为准。用户限定了机构或网站时优先定位该机构的原始网页，已知站点可用 domain 限定；摘要只用于定位。",
        "专名的中外文对应关系也需要依据；本轮没有核实译名时保留原文专名，不为方便阅读而补造中文名或括注。",
        "跨来源查询先让已有原文覆盖当前问题；相同事实不必在每个站点重查一遍，除非用户明确要求逐项对照或证据冲突。搜索并读只返回相关原文窗口，缺哪一项再定位续读，不为网页未读完而追加无关材料。",
        "交付仍遵守用户指定的句数、要点数和篇幅；用自己的话概括实际原文，引用紧邻对应事实。无需为了显示核对过程而大段抄原文或另加数据、开场和结尾总结。",
        "每次继续检索前，先明确还缺哪项会影响当前结论的资料。已有原文足以支持限定结论就交付，优先原始研究不等于穷尽文献；实际取得的论文摘要能够支持的结论可以据摘要交付，并说明其范围，不为把摘要升级成全文而一直重试。未取得的部分说明范围，不把检索未命中说成不存在。不要为同一核对点反复换同义词搜相同材料，也不扩展用户没有问的研究分支。最终篇幅仍按本轮要求。",
      ].join("\n") : "";
  const knowledgeGuidance = [COMPANION_KNOWLEDGE_REVIEW_V6, searchState].filter(Boolean).join("\n");
  if (attention?.intent === "conversation" && attention.toolUse === "none") {
    return { mode: "casual", temperature: 0.4, guidance: "" };
  }
  if (attention?.intent === "task" || attention?.intent === "task_control"
      || attention?.intent === "conversation") {
    // Intent describes what the user wants done, not whether the result contains
    // factual claims: drafting a lesson or editing a note can include a derivation.
    return { mode: "task", temperature: 0.4, guidance: knowledgeGuidance };
  }
  // Questions, mixed explanation/task turns and failed interpretation use the
  // stable explanation path, preserving the existing thinking decision.
  return { mode: "knowledge", temperature: 0.3, guidance: knowledgeGuidance };
}

/** Offline quality-comparison experiment only; production does not run a reviewer. */
export function isCompanionExplanation(attention: CompanionResponseAttention,
  userText: string, offeredTools: number): boolean {
  return offeredTools === 0 && (attention?.intent === "question" || attention?.intent === "mixed")
    && /解释|讲讲|详细|为什么|原理|推导|讲清|理解|\b(?:explain|why|derive|detailed)\b/iu.test(userText);
}
