/**
 * 伴星记忆的**跨空间作用范围判据**（2026-09-22 Owner 裁决 + 当日收紧；42 阶段 1 E 落到共享层）。
 *
 * 这一份是**唯一**判据，worker 抽取侧与 API/worker 写入端都直接 import：
 * 判据原先只长在抽取器里，于是"抽取时拦得住、手动保存与工具直执行时拦不住"，
 * 0371 的受控铺开还会把本地材料真的复制到别的空间。正则一旦有两份，漂移的方向
 * 通常就是写入端那份更松，所以这里宁可把判据讲清楚，也不允许第二份实现。
 *
 * 纯函数、无 node: 依赖、无副作用。
 */

/**
 * 跨空间同步的判据（2026-09-22 Owner 裁决 + 当日收紧）。
 *
 * 裁决是"跟空间关联性不强的记忆需要带过去"，同时要求**收紧**。分界线从 dev 库那批
 * 真种子记忆里读出来，不是猜的：
 *
 *   可携带：习惯在晚上九点之后写笔记 / 看新概念时更想先看反例 / 偏好短节奏学习
 *   该留下：用户正在备考日语N3 / 用户正在学习数据库索引优化 / 这个班的作业每周三交
 *
 * 于是只有 `preference` 可能跨空间；`preference` 里还要再分一次——关于**怎么学**
 * 的（时段、节奏、顺序、环境、称呼）跟人走，提到具体科目/考试/材料/任务的留在原空间。
 */
const CROSS_SPACE_KINDS = new Set<string>(["preference"]);

/**
 * 内容里"空间专属"信号的确定性判据，三类：
 *   - **明确的本地指代**：这个班 / 我们组 / 这门课 / 本学期 / 这篇笔记 / 当前材料 …；
 *   - **具体科目、考试、项目**：日语、物理、贝叶斯、N3、考试、期中、答辩 …；
 *   - **英文同款指代**：this note / current task / this workspace …
 *
 * 两个列表的分工：第二个只用于 `preference`（所以"喜欢在安静时段学习"这种不带科目的
 * 偏好不会被误判成本地），第一个对所有种类都成立——它说的是"这个书房里的东西"。
 *
 * 它是**关键词**判据：能挡住实测里出现过的本地指代，不声称覆盖全部语义表达。
 * 改了它等于改"什么记忆会跨空间"，所以有专门的用例。
 */
const LOCAL_REFERENCE_PATTERN =
  /(这个|这份|这篇|这项|本份|本篇|本项|该|我们|咱们|此|当前)(空间|房间|书房|工作区|协作|班级|班|课|课程|小组|团队|项目|学期|门课|笔记|任务|材料|资料|内容|卡片)|(这|本)(学期|门课|门|节课|次考试)|(期中|期末|月考|模拟考|统考|答辩|deadline|截止日期)|\b(this|these)\s+(note|notes|material|materials|task|tasks|workspace|space|project|card|cards|lesson)\b|\bcurrent\s+(note|task|material|workspace|space|project|lesson)\b/i;

const SUBJECT_OR_EXAM_PATTERN =
  /(日语|英语|数学|物理|化学|生物|语文|历史|地理|政治|编程|数据库|索引|算法|贝叶斯|统计|概率|线性代数|微积分|N[1-5]|雅思|托福|考研|高考|中考|四级|六级|考试|备考|证书|认证)/i;

/** `preference` 的内容看起来是否绑定了这个空间。 */
export function memoryLooksWorkspaceBound(content: string): boolean {
  return LOCAL_REFERENCE_PATTERN.test(content) || SUBJECT_OR_EXAM_PATTERN.test(content);
}

/**
 * 一条记忆该落在哪个 scope 上。
 *
 * 两道判据任一判本地就本地：模型在对话现场给的 `binding`，加上上面那条服务端确定性
 * 规则；规则**可以否决模型**（模型说 portable，但内容写着"这门课"时按本地）。
 *
 * 缺省 fail-closed：这里是 `binding !== "portable"` 而不是 `=== "local"`，所以没给
 * binding 就落本地。实测抓到过写反的后果：`binding` 为 undefined 时会返回 global，
 * 等于开了一个"漏传就跨空间"的口子。函数不能依赖调用方先过 schema。
 */
export function memoryScopeForKind(
  kind: string,
  modelScope?: string,
  binding?: string,
  content?: string,
): "global" | "workspace" | "task" {
  if (CROSS_SPACE_KINDS.has(kind)) {
    if (binding !== "portable") return "workspace";
    if (content !== undefined && memoryLooksWorkspaceBound(content)) return "workspace";
    return "global";
  }
  // 非跨空间种类尊重模型给的 task（"只在这一轮有用"的细分），其余一律 workspace。
  if (modelScope === "task") return "task";
  return "workspace";
}

/**
 * 账号级（跨空间）**写入**判据的拒绝理由。稳定字符串：写入端把它原样放进 4xx 回执。
 */
export type AccountPreferenceWriteRejection =
  /** 只有 `preference` 可能跨空间；其余种类写进去就是别处根本不存在的对象。 */
  | "kind_not_preference"
  /** 正文提到了具体科目、考试，或当前书房的材料/任务/指代。 */
  | "content_workspace_bound"
  /** 适用条件本身只在这个书房成立。 */
  | "applies_when_workspace_bound";

/**
 * 写入端的**放行判据**：这一行的最终形状能不能以 `scope='global'` 存在。
 *
 * 与抽取侧 `memoryScopeForKind` 的分工：模型那道 `binding` 只有对话现场才有，手动保存
 * 与工具直执行都没有，所以写入端只剩确定性那一道——而它本来就是可以单独否决 portable
 * 的那道。适用条件要一起判：条件跟着记忆一起铺到别的空间去，条件绑本地一样是错的。
 *
 * `scope !== 'global'` 一律放行：workspace / task 记忆本来就留在原空间，若这条守卫
 * 顺手拦下它们，记忆中心会整个不能用。
 */
export function accountPreferenceWriteDecision(input: {
  scope?: string | null;
  kind: string;
  content: string;
  appliesWhen?: string | null;
}): { ok: true } | { ok: false; reason: AccountPreferenceWriteRejection } {
  if (input.scope !== "global") return { ok: true };
  if (!CROSS_SPACE_KINDS.has(input.kind)) return { ok: false, reason: "kind_not_preference" };
  if (memoryLooksWorkspaceBound(input.content)) return { ok: false, reason: "content_workspace_bound" };
  if (input.appliesWhen != null && memoryLooksWorkspaceBound(input.appliesWhen)) {
    return { ok: false, reason: "applies_when_workspace_bound" };
  }
  return { ok: true };
}

/**
 * 拒绝理由 → 一句用户能照着做的话。
 *
 * 三条文案住在这里，是因为同一句拒绝现在出现在三处入口（记忆中心保存、记忆中心修订、
 * 伴星工具修订、提案确认）。各写一份长文案，迟早有一份漏掉"接下来怎么办"。
 *
 * 拒绝而不是降级：悄悄把 global 改成 workspace，用户会以为这条规则跟着账号走，实际
 * 并没有。所以三句都指向同一条出路——在当前书房单独保存；已有旧账号规则时，用户可以
 * 先在记忆中心停用它，再把想改的那条按空间内保存。
 */
const ACCOUNT_PREFERENCE_REJECTION_MESSAGE: Record<AccountPreferenceWriteRejection, string> = {
  kind_not_preference: "只有「关于你一贯怎么学、怎么相处」的偏好可以设为账号级（跨空间），这条请留在当前书房单独保存。",
  content_workspace_bound: "这条内容提到了当前书房的科目、任务、材料或班级，别的书房里并不存在；请在当前书房单独保存。",
  applies_when_workspace_bound: "这条适用条件只在这个书房成立；请在当前书房单独保存，或把条件改成通用的那条。",
};

export function accountPreferenceRejectionMessage(reason: AccountPreferenceWriteRejection): string {
  return ACCOUNT_PREFERENCE_REJECTION_MESSAGE[reason];
}