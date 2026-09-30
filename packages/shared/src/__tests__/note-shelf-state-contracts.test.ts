import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOTE_SHELF_STAGE_LABEL_V1,
  NOTE_SHELF_STAGE_RANK_V1,
  noteShelfStageDetailV1,
  noteShelfStageV1,
  noteShelfStateV1Schema,
  type NoteShelfLearningFactsV1,
  type NoteShelfStageV1,
} from "../contracts/note-shelf-state-contracts.ts";

const NO_FACTS: NoteShelfLearningFactsV1 = {
  overviewCount: 0,
  overviewVersionNumber: null,
  recallCount: 0,
  lastRecallSelfReport: null,
  annotationCount: 0,
  artifactCount: 0,
  expansionCount: 0,
  latestVersionNumber: null,
  latestAt: null,
};

const facts = (patch: Partial<NoteShelfLearningFactsV1>): NoteShelfLearningFactsV1 => ({
  ...NO_FACTS,
  ...patch,
});

describe("noteShelfStageV1", () => {
  it("没有正文的笔记是空稿，哪怕它已经有学习痕迹", () => {
    // 一篇被清空正文的笔记仍然留着旧痕迹。把它说成"批注过"是在报告一件
    // 用户已经看不到的事——所以"有没有正文"先于一切痕迹判断。
    assert.equal(noteShelfStageV1({
      hasBody: false,
      facts: facts({ annotationCount: 3, recallCount: 2 }),
    }), "draft");
  });

  it("有正文但一条记录都没有时是 untouched", () => {
    assert.equal(noteShelfStageV1({ hasBody: true, facts: NO_FACTS }), "untouched");
  });

  it("互动讲解不算一条整篇速看记录", () => {
    assert.equal(noteShelfStageV1({ hasBody: true, facts: facts({ artifactCount: 1 }) }), "untouched");
  });

  it("按最深的那一条取档位：拓展 > 批注 > 回想 > 速看", () => {
    assert.equal(noteShelfStageV1({ hasBody: true, facts: facts({ overviewCount: 1 }) }), "skimmed");
    assert.equal(noteShelfStageV1({ hasBody: true, facts: facts({ overviewCount: 1, recallCount: 1 }) }), "recalled");
    assert.equal(noteShelfStageV1({ hasBody: true, facts: facts({ recallCount: 1, annotationCount: 1 }) }), "annotated");
    assert.equal(noteShelfStageV1({ hasBody: true, facts: facts({ annotationCount: 1, expansionCount: 1 }) }), "grew");
  });

  it("自述「没想起来」仍然保留回想记录", () => {
    assert.equal(noteShelfStageV1({
      hasBody: true,
      facts: facts({ recallCount: 1, lastRecallSelfReport: "not_yet" }),
    }), "recalled");
  });
});

describe("noteShelfStageDetailV1", () => {
  it("没有痕迹时不产出一句废话", () => {
    assert.deepEqual(noteShelfStageDetailV1(NO_FACTS), []);
  });

  it("只数真正落过库的东西，且带上可数的数量", () => {
    assert.deepEqual(noteShelfStageDetailV1(facts({
      overviewCount: 2,
      recallCount: 1,
      annotationCount: 3,
      artifactCount: 1,
      expansionCount: 2,
    })), ["2 张速看", "1 条回想", "3 处批注", "1 份互动讲解", "关联 2 篇"]);
  });

  it("互动讲解可以出现在副签里，但它不改变主档位", () => {
    const only = facts({ artifactCount: 4 });
    assert.deepEqual(noteShelfStageDetailV1(only), ["4 份互动讲解"]);
    assert.equal(noteShelfStageV1({ hasBody: true, facts: only }), "untouched");
  });
});

describe("noteShelfStage 文案与档位表", () => {
  it("每个档位都有唯一的纸签文字", () => {
    const words = Object.values(NOTE_SHELF_STAGE_LABEL_V1);
    assert.equal(new Set(words).size, words.length);
    assert.equal(words.every((word) => word.length > 0), true);
  });

  it("排序档位是每一档一个递增的整数，没有并列", () => {
    const ranks = Object.values(NOTE_SHELF_STAGE_RANK_V1);
    assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right));
    assert.equal(new Set(ranks).size, ranks.length);
  });

  it("空稿排在最前，长出笔记排在最后", () => {
    const order = (Object.keys(NOTE_SHELF_STAGE_RANK_V1) as NoteShelfStageV1[])
      .sort((left, right) => NOTE_SHELF_STAGE_RANK_V1[left] - NOTE_SHELF_STAGE_RANK_V1[right]);
    assert.equal(order[0], "draft");
    assert.equal(order.at(-1), "grew");
  });
});

describe("noteShelfStateV1Schema", () => {
  it("改过版的笔记要能说出痕迹停在旧版上", () => {
    const parsed = noteShelfStateV1Schema.parse({
      facts: facts({ overviewCount: 1, overviewVersionNumber: 2, latestVersionNumber: 2, latestAt: "2026-09-28T10:00:00.000Z" }),
      stage: "skimmed",
      editedAfterLearning: true,
    });
    assert.equal(parsed.editedAfterLearning, true);
  });

  it("拒收没有依据的负数计数", () => {
    assert.equal(noteShelfStateV1Schema.safeParse({
      facts: facts({ annotationCount: -1 }),
      stage: "annotated",
      editedAfterLearning: false,
    }).success, false);
  });

  it("拒收编出来的档位", () => {
    assert.equal(noteShelfStateV1Schema.safeParse({
      facts: NO_FACTS,
      stage: "mastered",
      editedAfterLearning: false,
    }).success, false);
  });
});
