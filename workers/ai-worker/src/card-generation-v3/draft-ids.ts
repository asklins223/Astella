/**
 * 草稿里**服务端所有**的那些格子由服务端补，模型只交内容（39d W7-1 附刀六·第二修）。
 *
 * 为什么必须在这一层做：五发真模型每发都被 `output_shape` 挡下，报错一层比一层深
 * （词表 → 该层必填键 → 再往里一层的枚举 → 输出被 max_tokens 截断 → `rubric.units[0].rubricUnitId`
 * 缺失）。前面那些确实是提示词没说清，最后这一格不是：**V3 自己的设计就是"身份与哈希一律
 * 服务端算"**（`rubricHash`／`planHash`／`candidateRevisionHash` 都丢弃重算），而
 * `learningObjectiveDraftV2Schema` 把 answer unit 的 `unitId`、`rubric.units[].rubricUnitId`
 * 与整棵 `relations`（含 64 位 `relationHash`）当成模型必填项——模型既不知道该发明什么串，
 * 也不算不出哈希。继续在提示词里加说明只会撞到下一格服务端 id。
 *
 * 三条一起做的理由（缺一条比现状更坏）：
 *  - 只补 id 不重指引用 ⇒ 过了 schema 却留**悬空引用**：`answerUnitIds` 用的是模型自己起的
 *    名字，替换 id 之后那些名字就指不到任何东西；schema 抓不到，整批判据也抓不到，只有落库
 *    之后的投影才会炸（`[[feedback-uniqueness-key-must-cover-future-writers]]` 同族）。
 *  - 只补 id 不收提示词 ⇒ 一边叫模型发明 id，一边说服务端会替它算，两句话都在提示词里。
 *  - `relations` 不整条拿掉 ⇒ 模型永远交不出合法 `relationHash`，这一发必然红。
 */

const HASH_RE = /^[0-9a-f]{64}$/;

/** 递归给 `*Hash` 补占位（模型交不出真哈希；组装层会重算并覆盖）。 */
function stampHashPlaceholdersV3(node: unknown, depth = 0): number {
  if (depth > 6 || node === null || typeof node !== "object") return 0;
  let filled = 0;
  if (Array.isArray(node)) {
    for (const item of node) filled += stampHashPlaceholdersV3(item, depth + 1);
    return filled;
  }
  const row = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("Hash")) {
      if (typeof value !== "string" || !HASH_RE.test(value)) {
        row[key] = "0".repeat(64);
        filled += 1;
      }
      continue;
    }
    filled += stampHashPlaceholdersV3(value, depth + 1);
  }
  return filled;
}

/** 模型草稿里的一处答案单元（`canonicalAnswer` 各分支的承载体）。 */
interface AnswerUnitLike {
  unitId?: string;
  text?: string;
}

export interface ServerStampedIdsV3 {
  /** 被补上的 answer unit id 数。 */
  answerUnits: number;
  /** 被补上的 rubric unit id 数。 */
  rubricUnits: number;
  /** 被重指的引用条数（模型自己起的名字 → 服务端 id）。 */
  repointedRefs: number;
  /** 被服务端拿掉的 `relations` 条数（模型算不出 64 位 relationHash）。 */
  droppedRelations: number;
  /** 被服务端补占位的 `*Hash` 格子数（组装层会丢弃重算，占位只为过 schema）。 */
  stampedHashes: number;
}

function answerUnitSlots(canonical: Record<string, unknown> | undefined): AnswerUnitLike[] {
  if (!canonical || typeof canonical !== "object") return [];
  const slots: AnswerUnitLike[] = [];
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") slots.push(item as AnswerUnitLike);
    }
  };
  if (canonical.unit && typeof canonical.unit === "object") slots.push(canonical.unit as AnswerUnitLike);
  for (const key of ["items", "steps", "pairs", "rows"]) pushArray(canonical[key]);
  // `formula` / `code` 两支把 unitId 放在 canonicalAnswer 自己身上。
  if (typeof canonical.unitId === "string" || typeof canonical.latex === "string"
    || typeof canonical.code === "string") {
    slots.push(canonical as AnswerUnitLike);
  }
  return slots;
}

function normalizeReferenceList(
  refs: unknown,
  knownIds: string[],
  alias: Map<string, string>,
): { value: string[]; repointed: number } {
  const list = Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : [];
  const known = new Set(knownIds);
  let repointed = 0;
  const out: string[] = [];
  for (const ref of list) {
    if (known.has(ref)) { out.push(ref); continue; }
    let mapped = alias.get(ref);
    if (!mapped && knownIds.length > 0) {
      // 按位置配对：模型自起的第 k 个名字 ⇒ 服务端第 k 个 id。名字多于 id 时取模，
      // 宁可两个判分点指向同一答案单元（可复核），也不要交空数组（schema min(1)）。
      mapped = knownIds[alias.size % knownIds.length];
      alias.set(ref, mapped);
    }
    if (mapped) { out.push(mapped); repointed += 1; }
  }
  return { value: out.length > 0 ? out : knownIds.slice(0, 1), repointed };
}

/**
 * 给一份**尚未过合同解析**的生成输出补上服务端 id。就地改（调用方交的是 JSON.parse 的产物），
 * 返回补了多少，便于用例与事件里读出"这一批里有多少格子不是模型给的"。
 */
export function stampServerOwnedDraftIdsV3(parsed: unknown): ServerStampedIdsV3 {
  const report: ServerStampedIdsV3 = {
    answerUnits: 0, rubricUnits: 0, repointedRefs: 0, droppedRelations: 0, stampedHashes: 0,
  };
  const candidates = (parsed as { candidates?: unknown } | undefined)?.candidates;
  if (!Array.isArray(candidates)) return report;
  for (const [index, entry] of candidates.entries()) {
    const draft = (entry as { objectiveDraft?: Record<string, unknown> } | undefined)?.objectiveDraft;
    if (!draft || typeof draft !== "object") continue;
    const stamp = `c${index + 1}`;
    // 1) answer unit 的 id（模型没给就按遍历顺序补）。
    const slots = answerUnitSlots(draft.canonicalAnswer as Record<string, unknown> | undefined);
    for (const [unitIndex, slot] of slots.entries()) {
      if (typeof slot.unitId !== "string" || slot.unitId.length === 0) {
        slot.unitId = `au-${stamp}-${unitIndex + 1}`;
        report.answerUnits += 1;
      }
    }
    const knownIds = slots
      .map((slot) => slot.unitId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // 2) rubric unit 的 id ＋ 把引用重指到上面那份 id 集合。
    const alias = new Map<string, string>();
    const rubric = draft.rubric as { units?: unknown } | undefined;
    if (Array.isArray(rubric?.units)) {
      for (const [unitIndex, unit] of rubric.units.entries()) {
        const row = unit as Record<string, unknown> | undefined;
        if (!row || typeof row !== "object") continue;
        if (typeof row.rubricUnitId !== "string" || row.rubricUnitId.length === 0) {
          row.rubricUnitId = `ru-${stamp}-${unitIndex + 1}`;
          report.rubricUnits += 1;
        }
        const normalized = normalizeReferenceList(row.answerUnitIds, knownIds, alias);
        row.answerUnitIds = normalized.value;
        report.repointedRefs += normalized.repointed;
      }
    }
    // 3) relations 整条由服务端拿掉：`relationHash` 是 64 位十六进制，模型算不出来，
    //    留着这一格就是"必然红的一格"。图边以后要由程序推导（W7-5 那一族），不由模型发明。
    if (Array.isArray(draft.relations) && draft.relations.length > 0) {
      report.droppedRelations += draft.relations.length;
      draft.relations = [];
    } else if (draft.relations === undefined) {
      draft.relations = [];
    }
    // 4) 一切 `*Hash`：schema 要 64 位十六进制，而组装层本来就会**丢弃模型给的那份再重算**
    //    （`plan-assembly.ts` 的 rubricHash 那条纪律）。所以这里只补一个合法占位让它过 schema，
    //    占位不会进任何哈希闭包——真正的内容哈希在组装层算。
    report.stampedHashes += stampHashPlaceholdersV3(draft);
    // 5) 目标自己的 id 不在这里（`planObjectiveLocalId` 由组装层按提案对上去）。
  }
  return report;
}
