/**
 * 40b §1.4 第 1 条：**登记每条要求**（目的 / 适用任务 / 来源版本 / 保障位置 / 可检验证据）。
 *
 * ## 为什么要有这张表
 *
 * 约束原先散在各文件的注释里：写提示词的人知道"这段防的是什么"，读到的人
 * 只看到一段中文，机器则一条也核不了。于是三件事同时成立且都不报警——
 * 提示词改了没有同步版本身份、守卫删了没有清单说它本来该在、跨任务冲突
 * （`HOST_PROTOCOL` 与 `GROUNDED_TUTOR` 抢同一件事的格式权）要靠人读两段文本才发现。
 *
 * 40b §1.4 第 1 条把"行号仅作定位、不能成为稳定合同身份"说得很死：文本一改行号就漂，
 * 而这里的 `id` 必须能跨重构引用。所以身份取**语义**（`HOST_PROTOCOL_FIXED`），
 * 版本取**发布身份**（`COMPANION_HOST_PROTOCOL_V6`），证据取**文件 + 导出名**——
 * 三者都不随排版漂移。
 *
 * ## 这张表能被机器核到什么程度（以及核不到什么）
 *
 * `assertModelRequirementsResolvable()` 做的是**存在性核对**：清单里写的那个导出
 * 是不是真的还在。这抓得到"注释说已实现、代码里已经删了"这类最常见的漂移，抓不到
 * "那个函数还在、但它已经不检查那件事了"——那属于 40b §1.5 的语义评估，不是本表的职责。
 *
 * 两种核对方式，按证据所在位置选：
 *   - `resolve: "module"` —— 真 `import()` 那个模块，读它的导出命名空间。
 *     适用于 shared 内部的纯模块。人删了导出、改了名字，这里立刻红。
 *   - `resolve: "source"` —— 读源码文本，扫顶层 `export` 声明。适用于
 *     `apps/api` 与 `workers/ai-worker`：那些模块一 import 就会把 Fastify、drizzle
 *     连接池和模型 provider 拖进来，**为了让一个名字做一次静态核对而去连数据库**，
 *     代价与风险都远超收益；而且那次 import 成功与否取决于环境，不是取决于合同。
 *     局限要写清楚：它只认顶层 `export` 声明，`export *` 转手的情形核不到
 *     （本表现有的 source 证据文件都没有 `export *`）。
 *
 * ## 浏览器安全
 *
 * 本文件从 `index.ts` 导出，而 index 会被 Electron 渲染进程等浏览器安全入口消费
 * （`workspace-transaction.ts` 的注释为此专门写过一句"不要从 index 重导出"）。所以
 * 这里**没有任何顶层 `node:` 静态导入**，文件系统与路径解析都在
 * `assertModelRequirementsResolvable()` 内部惰性 import。
 */

/** 适用任务。取值必须是**这条要求挂在哪条链上**，不是"哪些任务顺便也适用"。 */
export const MODEL_REQUIREMENT_TASKS = [
  "companion_dialogue",
  "companion_tutor",
  "companion_diary",
  "companion_thought",
  "companion_memory",
  "companion_proactive",
  "ai_egress",
] as const;
export type ModelRequirementTask = (typeof MODEL_REQUIREMENT_TASKS)[number];

/**
 * 保障位置（40b §1.3 的那张表）。同一句要求可能 prompt 与 service 各一半，
 * 这里登记的是**当前主责**那一层，不假装它只有一层。
 */
export const MODEL_REQUIREMENT_ENFORCEMENTS = [
  "prompt",
  "schema",
  "db_constraint",
  "service",
  "manual",
] as const;
export type ModelRequirementEnforcement = (typeof MODEL_REQUIREMENT_ENFORCEMENTS)[number];

/**
 * 来源版本的词表。**闭集合**：写一条新要求时若用了一个表里没有的来源版本，
 * 校验会失败，逼着人先说清"这段文本的发布身份是什么"。
 * 词表里每一项都对应代码里真实存在的标识符（见各条的 `evidence`）。
 */
export const MODEL_REQUIREMENT_SOURCE_VERSIONS = [
  "COMPANION_HOST_PROTOCOL_V6",
  "COMPANION_IDENTITY_BOUNDARY_V3",
  "COMPANION_CHARACTER_BASE_V8",
  "COMPANION_VOICE_STYLE_LINES_V2",
  "COMPANION_PERSONA_V8_PROMPT_ID",
  "COMPANION_LEAK_GATES_V1",
  "COMPANION_AGENT_CONTRACT_VERSION",
  "COMPANION_HARD_MAX_CHARS",
  "GROUNDED_TUTOR_PROMPT_ID",
  "COMPANION_DIARY_DRAFT_PROMPT_VERSION",
  "AI_TASK_RETRYABLE_FAILURE_CLASSES",
  "AI_CONSENT_REQUIRED_CODE",
  "PROACTIVE_POLICY_LIMITS",
  "COMPANION_MEMORY_JOB_PAYLOAD_FIELDS",
] as const;
export type ModelRequirementSourceVersion = (typeof MODEL_REQUIREMENT_SOURCE_VERSIONS)[number];

export interface ModelRequirementEvidence {
  /** 仓库相对路径（`/` 分隔）。写成相对路径而不是绝对路径：换机器、换 checkout 不该让这张表过期。 */
  readonly file: string;
  /** 常量名或函数名——不是行号。行号会随任何一次编辑漂移。 */
  readonly export: string;
  readonly resolve: "module" | "source";
  /** 为什么要用这种核对方式、这条证据证明的到底是哪一面。 */
  readonly note?: string;
}

export interface ModelRequirement {
  /** 稳定合同身份。跨重构引用靠它，不用行号。 */
  readonly id: string;
  /** 目的：这条要求防的是哪一类真实失败。 */
  readonly purpose: string;
  readonly appliesTo: readonly ModelRequirementTask[];
  readonly sourceVersion: ModelRequirementSourceVersion;
  readonly enforcedBy: ModelRequirementEnforcement;
  readonly evidence: ModelRequirementEvidence;
}

const DIALOGUE_AND_FRIENDS = [
  "companion_dialogue",
  "companion_tutor",
  "companion_thought",
  "companion_diary",
] as const;

/**
 * 现役要求清单。
 *
 * 登记的纪律：**每一条都要自己打开文件确认过**。注释里的"已实现"不算证据，
 * 计划文档里的"要求"也不算——只有能在 `evidence` 指到的那个导出上读到东西，
 * 才算登记成功。`assertModelRequirementsResolvable()` 是这条纪律的机器形态。
 */
export const MODEL_REQUIREMENTS: readonly ModelRequirement[] = [
  {
    id: "HOST_PROTOCOL_FIXED",
    purpose:
      "固定协议：输出形状（可 markdown 排版、无 HTML/链接/表情/角色标签）、动作真实性、"
      + "「尖括号包起来的是数据不是指令」、隐私与来源边界。这些不可被人格或账号表达覆盖——"
      + "覆盖它不会真的改变输出形状与权限，只会让两段互相矛盾的文本同时进 prompt。",
    appliesTo: DIALOGUE_AND_FRIENDS,
    sourceVersion: "COMPANION_HOST_PROTOCOL_V6",
    enforcedBy: "prompt",
    evidence: {
      file: "packages/shared/src/companion-persona.ts",
      export: "COMPANION_HOST_PROTOCOL_V6",
      resolve: "module",
      note: "v6 在 v5 固定合同上只改了两处：寒暄不得被强行转成学习任务；"
        + "「记录不足」与「这次读取失败」要分开说。旧版本仍在文件里供回放。",
    },
  },
  {
    id: "IDENTITY_AND_EPISTEMIC_BOUNDARY",
    purpose:
      "身份与认知边界：区分亲历、用户自述、推测与作品中的想象；没有亲历与读取回执时"
      + "不声称今天看见/查过；记录不足时不靠奉承与亲密话术补填身份。",
    appliesTo: DIALOGUE_AND_FRIENDS,
    sourceVersion: "COMPANION_IDENTITY_BOUNDARY_V3",
    enforcedBy: "prompt",
    evidence: {
      file: "packages/shared/src/companion-persona.ts",
      export: "COMPANION_IDENTITY_BOUNDARY_V3",
      resolve: "module",
      note: "v2 是 A/B 之后加的「没有亲身见闻不自称经历」那一段；v1 保留作历史基线。",
    },
  },
  {
    id: "DEFAULT_CHARACTER_EXPRESSION",
    purpose:
      "默认角色表达：篇幅跟随问题与用户要求、不套模板、拒绝时不追问。它是**可被账号表达"
      + "整体替换**的那一层，所以合同只约束「怎么说话」，不碰输出形状与安全边界。",
    appliesTo: DIALOGUE_AND_FRIENDS,
    sourceVersion: "COMPANION_CHARACTER_BASE_V8",
    enforcedBy: "prompt",
    evidence: {
      file: "packages/shared/src/companion-persona.ts",
      export: "COMPANION_CHARACTER_BASE_V8",
      resolve: "module",
      note: "v7 在 v6 上加的是「讲透就停」的收尾形状，替代 v6 那句无约束的「内容讲清」。",
    },
  },
  {
    id: "DIARY_VOICE_TWO_LINES",
    purpose:
      "日记音色：桌宠日记**不引用整段角色底座**，只引用「怎么说话」那两句。整段里其余内容"
      + "（把球抛回去、不假称有身体、每段示范都问句收尾）一进日记就会被写成题材。",
    appliesTo: ["companion_diary"],
    sourceVersion: "COMPANION_VOICE_STYLE_LINES_V2",
    enforcedBy: "prompt",
    evidence: {
      file: "packages/shared/src/companion-persona.ts",
      export: "COMPANION_VOICE_STYLE_LINES_V2",
      resolve: "module",
      note: "日记装配点：`workers/ai-worker/src/handlers/companion-diary-content.ts`。"
        + "本条登记的是「音色那两句的出处」，出处真伪由 companion-persona.test.ts 逐句钉住。",
    },
  },
  {
    id: "PERSONA_ASSEMBLY_VERSION_PIN",
    purpose:
      "装配版本身份：一次调用要能说出自己用的是哪一版固定协议/默认表达/账号 revision，"
      + "否则 40b §5.3「已发生调用可按合法保留的版本复现装配」无从谈起。",
    appliesTo: DIALOGUE_AND_FRIENDS,
    sourceVersion: "COMPANION_PERSONA_V8_PROMPT_ID",
    enforcedBy: "db_constraint",
    evidence: {
      file: "packages/shared/src/db-schema/companion-conversations.ts",
      export: "companionTurnRuns",
      resolve: "source",
      note: "pin 落在 `companion_turn_runs` 的 persona_profile_revision / "
        + "persona_examples_revision 两列（迁移 0341/0355/0356）。这里登记表结构，"
        + "prompt id 身份登记在 HOST_PROTOCOL_FIXED / DEFAULT_CHARACTER_EXPRESSION 两条。",
    },
  },
  {
    id: "LEAK_GATE_IDENTITY_TABLE",
    purpose:
      "泄露闸 G1–G11 的身份表：每道闸的判据函数名、所在模块、处置与理由，"
      + "版本由表内容派生。台子（重放/对照）与代码读同一份号，否则改了判据台子不知道。",
    appliesTo: ["companion_dialogue", "companion_thought"],
    sourceVersion: "COMPANION_LEAK_GATES_V1",
    enforcedBy: "service",
    evidence: {
      file: "packages/shared/src/companion-leak-gates.ts",
      export: "COMPANION_LEAK_GATES_V1",
      resolve: "module",
      note: "同文件的 `companionLeakGateVersionV1()` 由表内容算出版本，不手写 v3——"
        + "没人 bump 的版本号比没有版本更坏。",
    },
  },
  {
    id: "INTERNAL_TOKEN_NOT_VISIBLE",
    purpose:
      "内部 token、上下文回显与裸 uuid 不得出现在可见正文。uuid 出现在她的话里永远是内部 id，"
      + "落点与原文由服务端另交给富块。",
    appliesTo: ["companion_dialogue", "companion_thought"],
    sourceVersion: "COMPANION_LEAK_GATES_V1",
    enforcedBy: "service",
    evidence: {
      file: "workers/ai-worker/src/handlers/companion-dialogue-content.ts",
      export: "containsCompanionInternalToken",
      resolve: "source",
      note: "G7 在表里的 judge 名。判据本体（COMPANION_LEAK_PATTERN）是该模块私有的，"
        + "只有判据函数对外；核对名存在即可证明这道闸还在被接线。",
    },
  },
  {
    id: "TOOL_SURFACE_SCOPE",
    purpose:
      "工具面范围：每轮提供**扁平**工具面，只按权限档（read_only/guided/full）与外发约束"
      + "过滤。工具行为与权限契约不随人格改变；模型可建议，不可自行授权。",
    appliesTo: ["companion_dialogue", "companion_tutor"],
    sourceVersion: "COMPANION_AGENT_CONTRACT_VERSION",
    enforcedBy: "service",
    evidence: {
      file: "packages/shared/src/companion-agent-registry.ts",
      export: "resolveAllCompanionAgentTools",
      resolve: "module",
      note: "每个工具的模型可见 JSON schema 与服务端 zod 校验出自同一个 `tool()` 声明"
        + "（该 helper 是模块私有的，不导出），少传一个参数即类型错误。",
    },
  },
  {
    id: "TOOL_ARGUMENT_VALIDATION",
    purpose:
      "工具参数契约：参数不合法时**不执行**，且回给模型与用户看的是同一句中文。"
      + "两份清单靠人同步过一次，上一批提醒工具因此上线即坏。",
    appliesTo: ["companion_dialogue", "companion_tutor"],
    sourceVersion: "COMPANION_AGENT_CONTRACT_VERSION",
    enforcedBy: "schema",
    evidence: {
      file: "packages/shared/src/companion-agent-registry.ts",
      export: "validateCompanionAgentToolArguments",
      resolve: "module",
    },
  },
  {
    id: "OUTBOUND_AI_CONSENT",
    purpose:
      "AI 外发同意：没签同意就不许把内容发出去，**不回退成静默用默认**。语音两条路"
      + "（TTS/ASR）此前只有认证没有这道闸，一个人没签同意也能被语音路径绕过。",
    appliesTo: ["ai_egress", "companion_dialogue"],
    sourceVersion: "AI_CONSENT_REQUIRED_CODE",
    enforcedBy: "service",
    evidence: {
      file: "apps/api/src/modules/identity/ai-consent-gate.ts",
      export: "requireAiConsent",
      resolve: "source",
      note: "判据只写一份，与 `identity/invite-service.ts` 的 `ai_consent` 同形状"
        + "（consentAt && consentVersion）。错误码身份登记在 packages/shared/src/safe-error.ts。",
    },
  },
  {
    id: "OUTPUT_REJECTION_SHAPE",
    purpose:
      "输出拒绝原因的结构与泄露校验：流式每个 flush 都过同一份判据，"
      + "只做「必须先于任何对外写入」那部分——空、超长、内部 token 泄露三选一，"
      + "命中即终止 run，不让任何字符先落到用户面前。",
    appliesTo: ["companion_dialogue", "companion_tutor", "companion_thought"],
    sourceVersion: "COMPANION_HARD_MAX_CHARS",
    enforcedBy: "service",
    evidence: {
      file: "workers/ai-worker/src/handlers/companion-dialogue-content.ts",
      export: "companionOutputRejectionReason",
      resolve: "source",
      note: "长度上限是同文件的 COMPANION_HARD_MAX_CHARS；全文兜底是 "
        + "validateCompanionOutput（同一判据 + 信封识别）。",
    },
  },
  {
    id: "COLLAPSE_IS_STRUCTURAL",
    purpose:
      "坍缩闸只判**语法上没闭合**（以裸数字结尾、开了成对符号没关、整体读不出说完），"
      + "不再判字数。收尾词表连同豁免已按 40 §4.4.2 整体删除——"
      + "短不是缺陷，把「安静」档用户的三个字判成截断只换来一次白烧的重跑。",
    appliesTo: ["companion_dialogue", "companion_tutor"],
    sourceVersion: "COMPANION_LEAK_GATES_V1",
    enforcedBy: "service",
    evidence: {
      file: "workers/ai-worker/src/handlers/companion-dialogue-content.ts",
      export: "looksTruncatedReply",
      resolve: "source",
      note: "G5 在身份表里的 judge 名，也是修复阶梯唯一的结构入口。",
    },
  },
  {
    id: "TUTOR_CHANNEL_FORMAT",
    purpose:
      "作答页与陪伴页的**格式权**分工：`GROUNDED_TUTOR` 走任务专属规则，但固定协议与"
      + "身份边界不被整段换掉——答题那一屏她身上只剩任务规则的形状，正是格式冲突的现场。",
    appliesTo: ["companion_tutor"],
    sourceVersion: "GROUNDED_TUTOR_PROMPT_ID",
    enforcedBy: "prompt",
    evidence: {
      file: "workers/ai-worker/src/handlers/companion-dialogue-content.ts",
      export: "GROUNDED_TUTOR_COMPANION_PROMPT",
      resolve: "source",
      note: "提示词 id 身份在 `companion-dialogue-store.ts` 的 GROUNDED_TUTOR_PROMPT_ID。",
    },
  },
  {
    id: "DIARY_PROMPT_VERSION",
    purpose:
      "日记草稿的提示版本身份：日记、抽取、摘要各自按职责登记，不混成一份人格；"
      + "本轮实际装配版本要能被复现。",
    appliesTo: ["companion_diary"],
    sourceVersion: "COMPANION_DIARY_DRAFT_PROMPT_VERSION",
    enforcedBy: "prompt",
    evidence: {
      file: "workers/ai-worker/src/handlers/companion-diary-content.ts",
      export: "COMPANION_DIARY_DRAFT_PROMPT_VERSION",
      resolve: "source",
    },
  },
  {
    id: "PROACTIVE_TYPE_AND_QUOTA",
    purpose:
      "主动触发：静默时段、额度、反馈抑制在**派发前**判定。`surface` 结论与普通念头"
      + "不因生成或到期就唤醒对话；授权提醒仍按自己的调度送达，不误归搭便车而漏送。",
    appliesTo: ["companion_proactive"],
    sourceVersion: "PROACTIVE_POLICY_LIMITS",
    enforcedBy: "service",
    evidence: {
      file: "packages/shared/src/companion-proactive-policy.ts",
      export: "POLICY_LIMITS",
      resolve: "module",
      note: "额度与抑制的另一半在 `companion-proactive-quota.ts`（按使用会话，不按切页）。",
    },
  },
  {
    id: "MEMORY_PAYLOAD_FIELDS",
    purpose:
      "记忆类 job 的 payload 字段唯一来源：写入侧 API 与 worker handler 共用同一份字段名，"
      + "读取侧对不认识的形状 fail-closed 而不是猜。",
    appliesTo: ["companion_memory"],
    sourceVersion: "COMPANION_MEMORY_JOB_PAYLOAD_FIELDS",
    enforcedBy: "schema",
    evidence: {
      file: "packages/shared/src/companion-memory-job-payload.ts",
      export: "COMPANION_MEMORY_JOB_PAYLOAD_FIELDS",
      resolve: "module",
    },
  },
  {
    id: "MODEL_RETRY_BUDGET_SCOPE",
    purpose:
      "模型预算与业务提交是两条轴：只有 transport/timeout/output_shape 值得再花一次钱；"
      + "权限、内容版本、无效输入、实质质量问题不自动重试，提交失败也绝不回头重跑模型。",
    appliesTo: ["companion_dialogue", "companion_tutor", "companion_diary", "companion_thought"],
    sourceVersion: "AI_TASK_RETRYABLE_FAILURE_CLASSES",
    enforcedBy: "service",
    evidence: {
      file: "packages/shared/src/ai-task-kernel.ts",
      export: "AI_TASK_RETRYABLE_FAILURE_CLASSES",
      resolve: "module",
      note: "公共任务内核。它只吃端口，不认识人格与业务——层边界由 "
        + "apps/api/src/__tests__/companion-layer-boundaries-source-guard.test.ts 守着。",
    },
  },
];

/** 校验失败时抛的错。`problems` 一条一条给，不合并成"有问题"。 */
export class ModelRequirementResolutionError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `模型要求清单有 ${problems.length} 条对不上代码：\n  - ` + problems.join("\n  - "),
    );
    this.name = "ModelRequirementResolutionError";
    this.problems = problems;
  }
}

export interface ModelRequirementResolutionReport {
  readonly checked: number;
  readonly resolved: readonly string[];
}

/**
 * 定位仓库根：从本文件向上找同时具备三个标记的目录。
 *
 * 写死层数的话，文件每被搬一次就要改一次，而忘了改的症状是**静默核错位置**——
 * 找着一个「看起来对」的根，读到的却是另一份 checkout 的代码。
 */
async function findRepoRoot(): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 12; hop += 1) {
    if (
      existsSync(join(dir, "packages/shared/src/ai-task-kernel.ts"))
      && existsSync(join(dir, "apps/api/src/modules"))
      && existsSync(join(dir, "workers/ai-worker/src/handlers"))
    ) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到就**抛**，不返回 null 让调用方「跳过检查」——那正是判据假绿的形状。
  throw new Error(
    "定位仓库根失败：向上 12 层都没同时看到 packages/shared/src/ai-task-kernel.ts、"
    + "apps/api/src/modules 与 workers/ai-worker/src/handlers。"
    + "清单的 evidence 全部按仓库相对路径解析，根定位错了整张表都核不了。",
  );
}

/** 顶层 `export` 声明 + `export { … }` 名单。只认声明式导出，`export *` 转手的情形核不到。 */
function exportedNamesInSource(source: string): Set<string> {
  const names = new Set<string>();
  const declarations = source.matchAll(
    /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm,
  );
  for (const match of declarations) names.add(match[1]!);
  const lists = source.matchAll(/\bexport[ \t]*\{([^}]*)\}/g);
  for (const list of lists) {
    for (const part of list[1]!.split(",")) {
      const alias = part.includes(" as ") ? part.split(" as ")[1] : part;
      const cleaned = alias.replace(/^type[ \t]+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) names.add(cleaned);
    }
  }
  return names;
}

/**
 * 核对清单：id 唯一、字段合法、证据指向的导出**确实还在**。
 *
 * 抛错时 `problems` 里每一条都带 requirement 的 `id`——40b §1.4 要的是"能说清是哪一条"，
 * 报一个笼统的"清单无效"等于把定位成本原样退回来。
 */
export async function assertModelRequirementsResolvable(
  requirements: readonly ModelRequirement[] = MODEL_REQUIREMENTS,
): Promise<ModelRequirementResolutionReport> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { isAbsolute, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const problems: string[] = [];
  const seenIds = new Set<string>();
  const taskSet = new Set<string>(MODEL_REQUIREMENT_TASKS);
  const enforcementSet = new Set<string>(MODEL_REQUIREMENT_ENFORCEMENTS);
  const sourceVersionSet = new Set<string>(MODEL_REQUIREMENT_SOURCE_VERSIONS);

  // 只有真的要看文件时才定位根；清单为空时不该因为定位失败而报错。
  const root = requirements.length > 0 ? await findRepoRoot() : "";

  for (const requirement of requirements) {
    const where = requirement.id || "(缺 id)";
    if (seenIds.has(requirement.id)) {
      problems.push(`${where}：id 重复。id 是稳定合同身份，重复就没有身份可言。`);
    }
    seenIds.add(requirement.id);

    if (!requirement.id || !/^[A-Z0-9_]+$/.test(requirement.id)) {
      problems.push(`${where}：id 必须是全大写蛇形；行号、路径、句子都不许当身份。`);
    }
    if (!requirement.purpose || requirement.purpose.length < 8) {
      problems.push(`${where}：purpose 要说清防的是哪一类真实失败，写不出就说明这条要求没想清楚。`);
    }
    if (!Array.isArray(requirement.appliesTo) || requirement.appliesTo.length === 0) {
      problems.push(`${where}：appliesTo 不能为空。`);
    } else {
      for (const task of requirement.appliesTo) {
        if (!taskSet.has(task)) {
          problems.push(`${where}：appliesTo 里的 "${task}" 不在 MODEL_REQUIREMENT_TASKS 词表内。`);
        }
      }
    }
    if (!sourceVersionSet.has(requirement.sourceVersion)) {
      problems.push(`${where}：sourceVersion "${requirement.sourceVersion}" 不在来源版本词表内。`);
    }
    if (!enforcementSet.has(requirement.enforcedBy)) {
      problems.push(`${where}：enforcedBy "${requirement.enforcedBy}" 不在保障位置词表内。`);
    }

    const evidence = requirement.evidence;
    if (!evidence || typeof evidence.export !== "string" || evidence.export.length === 0) {
      problems.push(`${where}：evidence.export 不能为空——没有可检验的证据就不是一条要求。`);
      continue;
    }
    if (evidence.resolve !== "module" && evidence.resolve !== "source") {
      problems.push(`${where}：evidence.resolve 只能是 "module" 或 "source"，收到 "${evidence.resolve}"。`);
      continue;
    }
    if (isAbsolute(evidence.file)) {
      problems.push(`${where}：evidence.file 必须是仓库相对路径，收到绝对路径 "${evidence.file}"。`);
      continue;
    }

    const absolute = resolve(root, evidence.file);
    if (!existsSync(absolute)) {
      problems.push(`${where}：证据文件不存在：${evidence.file}`);
      continue;
    }

    if (evidence.resolve === "module") {
      let namespace: Record<string, unknown>;
      try {
        namespace = await import(pathToFileURL(absolute).href) as Record<string, unknown>;
      } catch (err) {
        problems.push(`${where}：证据模块 import 失败：${evidence.file}（${(err as Error).message}）`);
        continue;
      }
      if (!(evidence.export in namespace)) {
        problems.push(
          `${where}：${evidence.file} 已经不再导出 ${evidence.export}——`
          + "注释与清单还在说它管着这件事，代码里已经没有了。",
        );
      }
      continue;
    }

    const source = readFileSync(absolute, "utf8");
    const names = exportedNamesInSource(source);
    if (!names.has(evidence.export)) {
      problems.push(
        `${where}：${evidence.file} 的顶层 export 里找不到 ${evidence.export}。`
        + `（该文件当前导出的名字：${[...names].sort().join("、") || "（一个都没有）"}）`,
      );
    }
  }

  if (problems.length > 0) throw new ModelRequirementResolutionError(problems);
  return {
    checked: requirements.length,
    resolved: requirements.map((requirement) => requirement.id),
  };
}
