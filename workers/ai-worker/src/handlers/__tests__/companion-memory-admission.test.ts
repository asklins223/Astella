/**
 * 记忆抽取的**自动准入**（40 §4.5.6）与**独立事实限额**（§4.5.6 第 3 条）。
 *
 * ## 为什么这两条要单独测
 *
 * 旧形状是「抽取出一律写成候选 → 用户在气泡上点确认 → 才是活的」。
 * 合同 §4.5.6 明令「移除日常『确认写入/暂不采用』的候选流程」，
 * 同时 §4.5.2 明令「来源不足、**敏感推断**、超出材料权限或用户已抑制的内容拒写」。
 *
 * 也就是说：**去掉确认队列不等于什么都自动收**。真正守边界的是这两个纯函数，
 * 它们一旦判错就是用户可见的两种错——要么她记下了不该记的（显得在监视他），
 * 要么她该记的没记（合同 §1.1 第一条问题直接复发）。而且这两种错**都不会报错**，
 * 所以必须有判据钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_EXTRACT_MAX_FACTS,
  limitMemoryExtractionsToIndependentFacts,
  memoryAdmissionDecision,
} from "../companion-memory-extractor.ts";

const fact = (kind: string, sourceQuote: string, content = "内容") => ({ kind, sourceQuote, content });

test("模型的全部五种 kind 都准入——种类不再是「拒写与否」的唯一分界", () => {
  // §4.5.1：旧文档「只要不在该集合内就拒写」会连真实共同事件一起丢掉。
  for (const kind of ["preference", "goal", "learning_context", "interaction_note", "episodic"]) {
    assert.equal(
      memoryAdmissionDecision({ kind, sourceBasis: "direct_statement" }).ok, true,
      `${kind} 是用户自己说的，不该被拒`,
    );
  }
});

test("用户自述的当下状态可以存；模型替用户断言的不行", () => {
  // §4.5.3：「今天很累。」是有期限的用户自述，不推导焦虑、依赖或人格特征。
  assert.equal(memoryAdmissionDecision({ kind: "interaction_note", sourceBasis: "direct_statement" }).ok, true);

  // §4.5.2：敏感推断拒写。这一条就是旧候选队列当初要拦的东西，
  // 现在换成确定性判据 + 可审计的理由。
  const inferred = memoryAdmissionDecision({ kind: "interaction_note", sourceBasis: "inferred_from_statement" });
  assert.equal(inferred.ok, false);
  assert.equal(inferred.ok === false && inferred.reason, "sensitive_inference",
    "拒写必须带理由（§4.5.7：拒写工具回执给模型原因）");
});

test("共同事件（episodic）不因「是推断」被拒——那是真实发生过的片段", () => {
  assert.equal(memoryAdmissionDecision({ kind: "episodic", sourceBasis: "inferred_from_statement" }).ok, true,
    "§4.5.2：真实 episodic 可以保存；把它们一起拒掉就是旧文档那个错");
});

test("默认只收一条独立事实", () => {
  const many = [
    fact("preference", "以后讲机制先举例"),
    fact("goal", "下周完成索引复习"),
    fact("learning_context", "我在准备 N3"),
    fact("episodic", "今天第一次听懂反例"),
  ];
  const kept = limitMemoryExtractionsToIndependentFacts(many);
  assert.equal(kept.length, 1, "默认上限就是一条，不该因为模型给了四条就收四条");
  assert.equal(kept[0]?.sourceQuote, "以后讲机制先举例", "保留的应当是第一条");
});

test("「确有互不重复的事实」要**显式**增加，且受任务预算硬上限约束", () => {
  const distinct = [
    fact("goal", "下周完成索引复习"),
    fact("preference", "以后讲机制先举例"),
    fact("episodic", "今天第一次听懂反例"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(distinct).length, 1,
    "不显式增加时默认仍然只有一条");
  assert.equal(limitMemoryExtractionsToIndependentFacts(distinct, { maxFacts: 3 }).length, 3,
    "§4.5.6：确有互不重复的事实可以在任务预算内增加");

  const overflow = [
    ...distinct,
    fact("learning_context", "我在准备 N3"),
    fact("interaction_note", "今天很累"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(overflow, { maxFacts: 99 }).length,
    MEMORY_EXTRACT_MAX_FACTS,
    "传再大的额度也要被任务预算的硬上限挡住");
});

test("没有最低配额：一条都不该记时就一条都不记", () => {
  assert.deepEqual(limitMemoryExtractionsToIndependentFacts([]), []);
  assert.equal(limitMemoryExtractionsToIndependentFacts([], { maxFacts: 3 }).length, 0,
    "§4.5.6：不上『每次必须记一条』的最低配额");
});

test("同一条事实被重复输出不占额度——否则模型重复三次就能填满", () => {
  const repeated = [
    fact("preference", "以后讲机制先举例", "版本一"),
    fact("preference", "以后讲机制先举例", "版本二"),
    fact("preference", "以后讲机制先举例", "版本三"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(repeated, { maxFacts: 3 }).length, 1);
});

test("【自证】判据认得出「按旧 kind 集合拒写」这个真实退化", () => {
  // 旧形状：只有 preference/goal/learning_context 写活，其余进候选队列。
  const oldSet = new Set(["preference", "goal", "learning_context"]);
  const oldBehaviour = (kind: string) => oldSet.has(kind);
  assert.equal(oldBehaviour("episodic"), false, "自证样本没造好：旧形状确实会拒 episodic");
  assert.equal(oldBehaviour("interaction_note"), false, "自证样本没造好");

  // 新判据下这两条都放行——所以上面两条「五种 kind 都准入」不是恒真。
  assert.equal(memoryAdmissionDecision({ kind: "episodic", sourceBasis: "direct_statement" }).ok, true);
  assert.equal(memoryAdmissionDecision({ kind: "interaction_note", sourceBasis: "direct_statement" }).ok, true);
});

test("【自证】限额判据对「照单全收」会红", () => {
  const three = [fact("a", "1"), fact("b", "2"), fact("c", "3")];
  assert.equal(three.length, 3, "自证样本：三条");
  assert.equal(limitMemoryExtractionsToIndependentFacts(three).length, 1, "判据必须把三条压成一条");
  assert.equal(limitMemoryExtractionsToIndependentFacts(three, { maxFacts: 3 }).length, 3,
    "自证样本没造好：显式增加时它必须能收满");
});