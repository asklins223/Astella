/**
 * 删批注的判据（41 §2.3 原位批注 + 用户裁决：连带删生成的动态讲解，**不删伴星对话**）。
 *
 * ⚠️ 这一份是**结构守卫**，不是数据库行为测试：它读源码与迁移，量的是「删除路径里
 * 有哪些写操作、匹配条件覆盖了哪些字段」。真正的库上验证需要一条
 * `*-postgres.integration.ts`（要起库并跑迁移），不在这一份里——所以这里防的是
 * **改动形状**（有人加了一条对聊天记录的写、有人少匹配一个锚点字段），
 * 不是替代集成测试。
 *
 * 这一族里最容易出的两个错，各钉一条：
 * 1. **只删批注、不删它生成的互动演示** —— 那一页从此没有任何东西引得到它，却还在
 *    学习记录里挂着「打开」。
 * 2. **连带把伴星的对话删掉** —— 产物当初可能是从某条聊天消息发起的，于是「删批注」
 *    顺着那条线走回 `companion_messages`。迁移 0323 已经 drop 了这个外键就是为了
 *    不让它发生；这里量的是**别把它加回来**。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 扫的是**代码**，不是注释。
 *
 * 这一族里有两处断言是「删除路径里**不出现**某个表名」——而那段路径上恰好有一大段
 * 注释在讲**为什么**不碰它（迁移 0323 摘外键那次）。不剥注释的话，守卫会先被自己
 * 的说明文字绊倒，而下一次有人把那段说明写得更详细，守卫就红了。
 * 一个会被文档绊倒的守卫，人只会去改文档绕过它——那它就再也防不住任何东西了。
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const service = code(readFileSync("src/modules/note-annotations/service.ts", "utf8"));
const migration = readFileSync("src/db/migrations/0323_note_dynamic_artifact_background_tasks.sql", "utf8");
const removeBranch = service.slice(service.indexOf("if (input.explanation === undefined)"));
const changeFn = service.slice(service.indexOf("export async function changeNoteAnnotation"));

describe("删批注：连带删什么", () => {
  /**
   * 正控制：删除分支里**既删产物也删批注**。
   *
   * 两者同事务，所以先后不影响结果；但两行都必须在——只删批注那一行是「看起来能跑、
   * 实际上留一地孤儿」的那种实现，而孤儿没有入口会报它。
   */
  it("同一个事务里既删互动演示，也删批注本身", () => {
    assert.match(removeBranch, /tx\.delete\(noteLearningArtifacts\)/, "删除分支没有删互动演示");
    assert.match(removeBranch, /tx\.delete\(noteAnnotations\)/, "删除分支没有删批注本身");
  });

  /**
   * 产物**不是**批注的子行，两边靠锚点对上。
   *
   * 所以匹配条件必须**逐字对齐六个字段**：noteVersionId + 四个定位 + 摘录。少一个
   * 字段就可能删掉**别的那一段**的演示——那比留下孤儿更坏，因为用户不会知道。
   */
  it("按锚点逐字匹配产物，六个字段一个都不能少", () => {
    for (const field of ["noteVersionId", "startBlockOrdinal", "startOffset", "endBlockOrdinal", "endOffset", "excerpt"]) {
      assert.ok(removeBranch.includes(`->>'${field}'`), `少匹配了 ${field}：可能删到别的那一段的演示`);
    }
    // 只认 sourceKind = 'annotation'：速看那类产物与批注无关。
    assert.ok(removeBranch.includes('eq(noteLearningArtifacts.sourceKind, "annotation")'), "没有限定只删批注来源的演示");
    // 产物 DELETE 必须使用产物表的列；复用批注表条件会生成缺失 FROM 的 SQL。
    const artifactDelete = removeBranch.slice(removeBranch.indexOf("tx.delete(noteLearningArtifacts)"),
      removeBranch.indexOf("await tx.delete(noteAnnotations)"));
    for (const [column, value] of [["workspaceId", "scope.workspaceId"], ["userId", "scope.userId"], ["noteId", "noteId"]]) {
      assert.ok(artifactDelete.includes(`eq(noteLearningArtifacts.${column}, ${value})`),
        `演示删除没有按自身的 ${column} 限定作用域`);
    }
    assert.ok(!artifactDelete.includes("owned(scope, noteId)"), "产物删除不能引用批注表的列");
  });

  /**
   * 反面判据：**删除路径不碰伴星对话**。
   *
   * 这条同时钉住两件事：代码里没有对 `companion_messages` / `companion_conversations`
   * 的任何写操作，以及那个把它们摘掉的迁移确实在库里（否则将来有人「顺手补回」
   * 外键，这条会红）。
   */
  it("不碰伴星对话：删除路径里没有对 conversation/messages 的写操作", () => {
    for (const table of ["companionMessages", "companionConversations", "companion_messages", "companion_conversations"]) {
      assert.ok(!removeBranch.includes(table), `删除路径里出现了 ${table}`);
    }
    assert.ok(migration.includes("DROP CONSTRAINT IF EXISTS note_companion_artifacts_source_message_id_fkey"),
      "产物对聊天记录的外键被加回来了——删批注会顺着它删掉对话");
    assert.ok(migration.includes("Chat rows can be cleared without deleting a note's saved learning record"));  });

  /**
   * 修订号是并发闸：别人刚改过这一条时按删除要失败，不能连别人的改动一起抹掉。
   */
  it("带 expectedRevision 校验：后到的删除拿不到前一次的版本", () => {
    assert.ok(changeFn.includes("row.revision !== input.expectedRevision"),
      "删除/改写没有核对 expectedRevision：别人刚改过也会被覆盖或删掉");
    // 删除走的是同一个 `.for("update")` 的锁定行，不是另开一条不带锁的路径。
    assert.ok(changeFn.includes('.for("update")'), "删除没有锁住那一行");
  });
});
