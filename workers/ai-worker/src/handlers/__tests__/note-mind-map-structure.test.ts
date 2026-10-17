/**
 * 脑图结构整理的确定性部分：跨段重复概念折叠 + 同层按原文顺序排。
 *
 * 为什么值得钉住：长笔记是分段生成再合并的，而合并那一步被要求"保留每一个 concept、
 * 只许改 parentId"（少一个就整发失败）。那条纪律保住了"不编造、不丢依据"，但留下两件事
 * 没人管——同一件事在两个段里各立一个节点（读者看到重复而不是更全），以及同层次序基本随机
 * （而读者是从上往下看的）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { foldDuplicateConcepts, orderMindMapBySource } from "../note/note-mind-map-structure.ts";

function concept(id: string, parentId: string, label: string, ordinal: number, explanation: string | null = null) {
  return { id, parentId, kind: "concept" as const, label, explanation, references: [{ blockOrdinal: ordinal, quote: `第${ordinal}段的原话` }] };
}
function group(id: string, parentId: string, label: string) {
  return { id, parentId, kind: "group" as const, label, explanation: null, references: [] };
}
const root = { id: "root", parentId: null, kind: "root" as const, label: "功率", explanation: null, references: [] };

test("同一件事在两段里各立一个节点：折成一条，两份依据都留着，子节点重挂过来", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root,
    group("g1", "root", "基础"),
    concept("c0", "g1", "固定电压", 1, "保持电压不变才能用这个比较。"),
    group("g2", "root", "补充"),
    concept("c1", "g2", "固定 电压", 4),
    concept("c3", "c1", "电压表接法", 5),
    concept("c2", "g2", "电流", 6, "电流随电阻变。"),
  ] };
  const folded = foldDuplicateConcepts(map);
  const byId = new Map(folded.nodes.map((node) => [node.id, node]));
  assert.equal(folded.nodes.filter((node) => node.kind === "concept").length, 3, "四条里同名的那两条合成一条");
  assert.equal(byId.has("c1"), false, "被折掉的那条不再出现在图里");
  assert.deepEqual(byId.get("c0")!.references.map((ref) => ref.blockOrdinal), [1, 4], "两份依据都要留着，读者才回得到原文");
  assert.equal(byId.get("c3")!.parentId, "c0", "被折掉那条的子节点要挂到留下的那一条上");
  assert.equal(byId.get("c2")!.parentId, "g2", "别的分支不动");
});

test("留下的那条原先没有解释、折进来的有：把解释接上，而不是丢掉", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root, concept("c0", "root", "固定电压", 1), concept("c1", "root", "固定电压", 4, "保持电压不变才能用这个比较。"),
  ] };
  const folded = foldDuplicateConcepts(map);
  assert.equal(folded.nodes.find((node) => node.id === "c0")!.explanation, "保持电压不变才能用这个比较。");
});

test("折掉之后空掉的分组剪掉，不留空枝条（合同不许空分组）", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root,
    group("g1", "root", "基础"),
    concept("c0", "g1", "固定电压", 1),
    group("g2", "root", "只剩一条重复的分组"),
    concept("c1", "g2", "固定电压", 4),
  ] };
  const folded = foldDuplicateConcepts(map);
  assert.deepEqual(folded.nodes.map((node) => node.id), ["root", "g1", "c0"], "空掉的分组要剪掉");
});

test("不是同一件事就不折：名字不同、或者名字短到看不出是什么", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root, concept("c0", "root", "固定电压", 1), concept("c1", "root", "可变电压", 4), concept("c2", "root", "a", 5), concept("c3", "root", "A", 6),
  ] };
  assert.equal(foldDuplicateConcepts(map), map, "没有可折的就原样返回，不白跑一趟");
  assert.equal(map.nodes.length, 5);
});

test("同层按原文顺序排：分组的次序由它归拢的知识点决定", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root,
    group("late", "root", "后一半"),
    group("early", "root", "前一半"),
    concept("l1", "late", "乙", 9),
    concept("e1", "early", "甲", 2),
  ] };
  assert.deepEqual(
    orderMindMapBySource(map).nodes.map((node) => node.id),
    ["root", "early", "e1", "late", "l1"],
    "读者从上往下看，图就该跟笔记同序",
  );
});

test("既没有依据也没有子节点的节点排在同层最后，不会顶到前面去", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root,
    group("nowhere", "root", "无处安放"),
    concept("c0", "root", "有依据的", 3),
  ] };
  assert.deepEqual(orderMindMapBySource(map).nodes.map((node) => node.id), ["root", "c0", "nowhere"]);
});

test("排序不丢节点：数组顺序变了，集合不变", () => {
  const map: MindMapContentV1 = { schemaVersion: 1, rootId: "root", nodes: [
    root, group("g", "root", "一组"), concept("c0", "g", "甲", 5), concept("c1", "g", "乙", 1),
  ] };
  const ordered = orderMindMapBySource(map);
  assert.equal(ordered.nodes.length, map.nodes.length);
  assert.deepEqual(new Set(ordered.nodes.map((node) => node.id)), new Set(map.nodes.map((node) => node.id)));
  assert.equal(ordered.rootId, "root");
});
