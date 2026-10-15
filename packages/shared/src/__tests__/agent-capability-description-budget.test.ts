import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCapabilityCatalog } from "../agent-capability-catalog.ts";

/**
 * 工具面说明预算（方案 52 §5）。判据全部取自**声明**（`agentCapabilityCatalog`），
 * 不抄第二份工具名单——与 `companion-tool-executor-ledger.test.ts` 同一做法。
 *
 * 为什么是这几条：聊天面 57 个工具里，description 是唯一每轮都进请求的用法说明，
 * 而它可以被无限加句子。没有守卫，三个月后必然长回去（本轮改写前实测 16 条超 150 字，
 * 合计 6,229 字）。
 */
const conversation = agentCapabilityCatalog.filter(entry => entry.surfaces.includes("conversation"));
const PER_TOOL_LIMIT = 150;
const TOTAL_LIMIT = 4000;
/**
 * 「一句话只有一个家」（§4.1）——这一条代替原来的 parameters 体积上限。
 *
 * 体积上限形状不对：parameters 随**新能力**合法增长（本轮之后新增的写进度字段就 +81），
 * 一个 19 字符余量的棘轮会在别人的正常改动上报警。真正的回归是**同一句话写两处**：
 * §4 把两张词表从工具级说明搬到字段 describe，靠的就是每个字段只在 describe 里出现一次。
 * 判据是来源，不是体积。
 */
function fieldClauses(parameters: Record<string, unknown>): string[] {
  const properties = (parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
  return Object.values(properties).flatMap(spec => (spec?.description ?? "")
    .split(/[；;]/)
    .map(clause => clause.trim())
    .filter(clause => clause.length >= 12));
}

test("工具级说明不重复字段 describe 里的句子", () => {
  const duplicated = conversation.flatMap(entry => {
    const description = entry.definition.description;
    const hits = fieldClauses(entry.definition.parameters).filter(clause => description.includes(clause));
    return hits.length ? [`${entry.definition.name}：${hits.join(" / ")}`] : [];
  });
  assert.deepEqual(duplicated, [], "这些句子写了两处，应当只留在字段说明上：\n" + duplicated.join("\n"));
});

test(`单条工具说明不超过 ${PER_TOOL_LIMIT} 字符`, () => {
  const over = conversation
    .filter(entry => entry.definition.description.length > PER_TOOL_LIMIT)
    .map(entry => `${entry.definition.name}(${entry.definition.description.length})`);
  assert.deepEqual(over, [], `这些工具说明超限：\n${over.join("\n")}`);
});

test(`聊天面说明总量不超过 ${TOTAL_LIMIT} 字符`, () => {
  const total = conversation.reduce((sum, entry) => sum + entry.definition.description.length, 0);
  assert.ok(total <= TOTAL_LIMIT, `description 合计 ${total} 字符，超过预算 ${TOTAL_LIMIT}`);
});

test("场景指引里点到的工具名，必须在同一个下发面上", () => {
  const names = new Set(conversation.map(entry => entry.definition.name));
  const orphan = conversation.flatMap(entry => {
    const guidance = entry.sceneGuidance;
    if (!guidance) return [];
    const lines = [...(guidance.shared ?? []), ...(guidance.guided ?? []), ...(guidance.full ?? [])];
    return lines.flatMap(line => [...line.matchAll(/companion_[a-z_]+|agent_[a-z_]+/g)]
      .map(match => match[0])
      .filter(name => !names.has(name))
      .map(name => `${entry.definition.name} 指引提到面外的 ${name}`));
  });
  assert.deepEqual([...new Set(orphan)], [], "指引指向了一个这一面没有的能力");
});

/**
 * 方案 52 §9.4：读正文的格子不能再挂着一个与自己字段契约矛盾的默认 4,000。
 * 判据是**来源**——这一格的输出上界必须等于它自己那份契约派生出来的常量，
 * 而不是「够大就行」（够大的数照样是编的）。
 */
test("读到超默认上界的格子按自己的契约声明", () => {
  const derived: Record<string, number | null> = {
    companion_read_history: null,
    companion_recall_past_conversation: null,
    companion_read_playbook: null,
    companion_read_diary: null,
  };
  const drifted = conversation
    .filter(entry => entry.definition.name in derived
      && entry.definition.maxOutputChars !== derived[entry.definition.name])
    .map(entry => `${entry.definition.name}：声明 ${entry.definition.maxOutputChars}，契约派生 ${derived[entry.definition.name]}`);
  assert.deepEqual(drifted, [], "这些格子的输出上界与它自己的字段契约不一致：\n" + drifted.join("\n"));
});
