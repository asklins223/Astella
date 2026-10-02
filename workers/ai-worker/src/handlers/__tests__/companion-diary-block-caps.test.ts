/**
 * 每篇最多一图一段引文的**显式闸**（PRD 40 §5.4 / §13 A42）。
 *
 * 这条合同以前只靠候选池"碰巧"成立：`focusDiaryMaterial` 收窄到线头那一幕、
 * `pickImagesPerNote` 每篇一张、`pickQuoteCandidates` 每篇一条。哪天有人把池子放宽，
 * 合同会静默破掉——所以这些用例把"闸本身"钉住：给它两图两引，它必须只吐一图一引。
 *
 * 纯函数测试：不碰数据库、不碰模型，只有 `resolveDiaryBlocks` 一个被测对象。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIARY_MAX_IMAGE_BLOCKS,
  DIARY_MAX_QUOTE_BLOCKS,
  resolveDiaryBlocks,
  type DiaryBlock,
  type DiaryEmbed,
} from "../companion-diary-content.ts";

function image(ref: string, noteId = `note-${ref}`): Extract<DiaryEmbed, { kind: "image" }> {
  return {
    ref, kind: "image", url: `/api/uploads/notes/2026/09/${ref}.png`,
    noteTitle: `笔记${ref}`, noteId, nth: 1,
    nearby: "电压和电流成正比，电阻是那个比值。", shape: "横向的",
    objectKey: `notes/2026/09/${ref}.png`, mimeType: "image/png", byteSize: 120_000,
    description: null,
  };
}

function quote(ref: string, noteId = `note-${ref}`): DiaryEmbed {
  return { ref, kind: "quote", label: `《${noteId}》里写着`, text: "电流与电压成正比。", noteId };
}

const para = (text: string) => ({ type: "text" as const, text });

function kindsOf(blocks: DiaryBlock[]): DiaryBlock["type"][] {
  return blocks.map((block) => block.type);
}

test("每篇最多一图一引：两图两引进去，只剩一图一引出来", () => {
  const embeds = [image("图1"), image("图2"), quote("引1"), quote("引2")];
  const { blocks, droppedRefs } = resolveDiaryBlocks({
    blocks: [
      para("今天先记下这一段。"),
      { type: "image", ref: "图1" },
      para("第二段接着说。"),
      { type: "image", ref: "图2" },     // 第二张图：超出额度
      { type: "quote", ref: "引1" },
      { type: "quote", ref: "引2" },     // 第二段引文：超出额度
    ],
  }, embeds);

  assert.equal(kindsOf(blocks).filter((type) => type === "image").length, DIARY_MAX_IMAGE_BLOCKS);
  assert.equal(kindsOf(blocks).filter((type) => type === "quote").length, DIARY_MAX_QUOTE_BLOCKS);
  assert.deepEqual(kindsOf(blocks), ["text", "image", "text", "quote"]);
  // 留下的是**先到的**那一张图与那一条引文（她写在前面那段附近的那块）。
  const keptImage = blocks.find((block): block is Extract<DiaryBlock, { type: "image" }> => block.type === "image");
  const keptQuote = blocks.find((block): block is Extract<DiaryBlock, { type: "quote" }> => block.type === "quote");
  assert.equal(keptImage?.url, "/api/uploads/notes/2026/09/图1.png");
  assert.equal(keptQuote?.text, "电流与电压成正比。");
  // 被丢掉的编号要报出来：静默丢会让人以为池子里根本没有那张图。
  assert.deepEqual(droppedRefs, ["图2", "引2"]);
});

test("只有图没有引文：图留下（合同不要求两者同时出现）", () => {
  const { blocks, droppedRefs } = resolveDiaryBlocks({
    blocks: [para("今天先记下这一段。"), { type: "image", ref: "图1", caption: "盯了半天也没看出名堂" }],
  }, [image("图1")]);

  assert.deepEqual(kindsOf(blocks), ["text", "image"]);
  assert.deepEqual(droppedRefs, []);
  const kept = blocks.find((block): block is Extract<DiaryBlock, { type: "image" }> => block.type === "image");
  assert.equal(kept?.label, "盯了半天也没看出名堂（《笔记图1》）");
});

test("只有引文没有图：引文留下（合同不要求两者同时出现）", () => {
  const { blocks, droppedRefs } = resolveDiaryBlocks({
    blocks: [para("今天先记下这一段。"), { type: "quote", ref: "引1" }],
  }, [quote("引1")]);

  assert.deepEqual(kindsOf(blocks), ["text", "quote"]);
  assert.deepEqual(droppedRefs, []);
});

test("既没有图也没有引文：正文照留，不因为没有嵌入物判失败", () => {
  const { blocks, droppedRefs, strippedRefs } = resolveDiaryBlocks({
    blocks: [para("今天把那个比例又算了一遍。"), para("还是有点犹豫。")],
  }, []);

  assert.deepEqual(kindsOf(blocks), ["text", "text"]);
  assert.deepEqual(droppedRefs, []);
  assert.deepEqual(strippedRefs, []);
});

test("一图一引同时出现是合法的，两种用法都不被这条闸拦", () => {
  const both = resolveDiaryBlocks({
    blocks: [para("这一段挨着那篇笔记。"), { type: "image", ref: "图1" }, { type: "quote", ref: "引1" }],
  }, [image("图1"), quote("引1")]);
  assert.deepEqual(kindsOf(both.blocks), ["text", "image", "quote"]);
  assert.deepEqual(both.droppedRefs, []);

  const neither = resolveDiaryBlocks({
    blocks: [para("这一段挨着那篇笔记。"), { type: "quote", ref: "引1" }],
  }, [image("图1"), quote("引1")]);
  assert.deepEqual(kindsOf(neither.blocks), ["text", "quote"], "图与引文互相独立，用了引文不代表必须用图");
});

test("额度先于去重生效：重复的同一张图不会白占一张图的额度", () => {
  // 同一条编号重复两次时，去重已经把它挡掉了；额度不该再被它吃掉，
  // 否则第二张图会被误判成"超额"而丢掉，而它本来是合法的那一张。
  const { blocks, droppedRefs } = resolveDiaryBlocks({
    blocks: [
      { type: "image", ref: "图1" },
      { type: "image", ref: "图1" },
      { type: "image", ref: "图2" },
    ],
  }, [image("图1"), image("图2")]);

  assert.deepEqual(kindsOf(blocks), ["image"]);
  assert.equal(blocks[0].type === "image" ? blocks[0].url : "", "/api/uploads/notes/2026/09/图1.png");
  assert.deepEqual(droppedRefs, ["图1", "图2"]);
});