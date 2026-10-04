import { describe, expect, it } from "vitest";
import { noteCardGenerationEntry } from "../note-card-generation-entry";

const NOTE = "4a1f0000-0000-4000-8000-000000000001";
const NEXT = "4a1f0000-0000-4000-8000-000000000002";

/**
 * 笔记页那一格（2026-10-04 用户决定，第二次）。
 *
 * 上一版把它并成**一颗**按钮，于是有两个具体的坏处，都是用户指着屏幕说出来的：
 *   - 「我改动了文档，却没有给我出现生成学习卡按钮？还是那一个查看生成进度／候选卡
 *     审查？」——正文改过之后主按钮仍然去看旧的那一批；
 *   - 「笔记那边的按钮你咋全给我删除了」——"再来一批"这个决定在"有事发生"的时候
 *     整个不存在，用户只能先去进度页里找。
 *
 * 所以判据回到两张表：**主按钮去不去看手上那一批**，以及**旁边要不要补一颗
 * 「重新生成学习卡」**。后者在正在生成时一律不出现（先停止，停了才有"重新"）。
 */
describe("笔记页学习卡入口的落点", () => {
  it("从没做过卡：主按钮开方案屏，旁边不挂「重新生成」（没做过就谈不上重新）", () => {
    expect(noteCardGenerationEntry(null, NOTE, false)).toEqual({
      sourceChanged: false, startsNewRun: true, blockedByGeneration: false, offersRegenerate: false,
    });
  });

  it.each(["queued", "source_sealing", "planning", "authoring", "checking", "activating"] as const)(
    "%s：后台还在做，主按钮去看它，「重新生成」不出现（先停止）",
    status => {
    const entry = noteCardGenerationEntry({ status, noteVersionId: NOTE }, NOTE, false);
    expect(entry.startsNewRun).toBe(false);
    expect(entry.offersRegenerate).toBe(false);
  });

  it.each(["review_ready", "needs_attention", "activated"] as const)(
    "%s：主按钮去看这一批，旁边补一颗「重新生成学习卡」",
    status => {
      expect(noteCardGenerationEntry({ status, noteVersionId: NOTE }, NOTE, false)).toEqual({
        sourceChanged: false, startsNewRun: false, blockedByGeneration: false, offersRegenerate: true,
      });
    });

  it.each(["failed", "cancelled", "stale", "closed_without_activation"] as const)(
    "%s：那一批已经结束，主按钮就是「重新生成学习卡」",
    status => {
      expect(noteCardGenerationEntry({ status, noteVersionId: NOTE }, NOTE, false)).toEqual({
        sourceChanged: false, startsNewRun: true, blockedByGeneration: false, offersRegenerate: false,
      });
    });

  it("正文改过（这一版还没有任何一批卡）：主按钮是「生成学习卡」，旁边是「查看旧版生成」", () => {
    expect(noteCardGenerationEntry({ status: "review_ready", noteVersionId: NOTE }, NEXT, false)).toEqual({
      sourceChanged: true, startsNewRun: true, blockedByGeneration: false, offersRegenerate: false,
    });
  });

  it("改过还没存下的改动也算改过：判的是**正在编辑的正文**，不是已保存版本", () => {
    const entry = noteCardGenerationEntry({ status: "activated", noteVersionId: NOTE }, NOTE, true);
    expect(entry.sourceChanged).toBe(true);
    expect(entry.startsNewRun).toBe(true);
  });

  it("正文改过、旧版还在跑：主按钮是「生成学习卡」但被挡住，理由写在它身上", () => {
    expect(noteCardGenerationEntry({ status: "authoring", noteVersionId: NOTE }, NEXT, false)).toEqual({
      sourceChanged: true, startsNewRun: true, blockedByGeneration: true, offersRegenerate: false,
    });
  });
});