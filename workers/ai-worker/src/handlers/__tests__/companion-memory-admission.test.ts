/**
 * 记忆抽取的**自动准入**（40 §4.5.6）与**独立事实**判据。
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
  limitMemoryExtractionsToIndependentFacts,
  memoryAdmissionDecision,
} from "../memory/companion-memory-extractor.ts";

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

test("互不重复的独立事实有几条收几条——本轮裁决取消条数硬上限", () => {
  const many = [
    fact("preference", "以后讲机制先举例"),
    fact("goal", "下周完成索引复习"),
    fact("learning_context", "我在准备 N3"),
    fact("episodic", "今天第一次听懂反例"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(many).length, 4,
    "四条都是互不重复的独立事实：以前 slice(0, 3) 会静默丢掉一条，现在不剪");
});

test("没有最低配额：一条都不该记时就一条都不记", () => {
  assert.deepEqual(limitMemoryExtractionsToIndependentFacts([]), []);
});

test("同一条事实被重复输出只收一次——按 (kind, sourceQuote) 判独立性", () => {
  const repeated = [
    fact("preference", "以后讲机制先举例", "版本一"),
    fact("preference", "以后讲机制先举例", "版本二"),
    fact("preference", "以后讲机制先举例", "版本三"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(repeated).length, 1,
    "同 kind 同引文就是同一条事实，模型说三遍也只入库一次");
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

test("【自证】独立性判据对「照单全收」会红", () => {
  // 三条里两条是同一句的两个说法：判据要能识别并折叠成两条。
  const mixed = [
    fact("preference", "以后讲机制先举例", "版本一"),
    fact("preference", "以后讲机制先举例", "版本二"),
    fact("goal", "下周完成索引复习"),
  ];
  assert.equal(limitMemoryExtractionsToIndependentFacts(mixed).length, 2,
    "自证样本没造好：同 kind 同引文必须折叠，否则这里也会给出 3");
});