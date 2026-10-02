/**
 * **长度**不触发重跑，只有语法断裂才触发（40 §4.4.2、§4.8.1 第 1 条、验收 A25）。
 *
 * ## 它以前坏在哪
 *
 * `looksTruncatedReply` 原来是 `length < minChars → true` 排在最前面，按用户活跃度
 * 取 2 / 4 / 6 字。任何短句都被判成截断，推进退化修复阶梯：换思考档重跑一次，
 * 还不行再换一个模型。代价是三重的：一次白烧的调用、用户自己的活跃度设定被更啰嗦的
 * 档位盖过去、以及换回来的往往还是同一句——用户抱怨的「说的太短了」针对的是
 * **没答完**，不是**答完了**。
 *
 * 中间有一版用 `NATURAL_ENDING_TOKENS` 收尾词表豁免。它是在补丁上打补丁：
 * 40 §4.4.2 批评的「固定回应词清单」从提示词里删掉了，却在检查层换了个名字回来。
 * 现在字数线、词表、以及伪装成结构判据的「没有句末标点」一起删掉，**不留兼容层**。
 *
 * ## 剩下的判据是语法断裂，不是自然度
 *
 * 裸数字结尾、开了成对符号没关——这两条没有任何写法能让它们成为完整句。
 *
 * ## 这个文件同时是一份「放弃了什么」的记录
 *
 * 实机量到过三种退化形态，其中 `有` 现在**放行**了。这是合同的直接后果：
 * §4.4.2 明写「短句…不单独触发重跑」，而 `有` 与完全合法的 `嗯`、`行`、
 * `在的。` 在结构上无法区分。下面的 `放行了「有」——这是合同的结果，不是疏漏`
 * 一条把这个取舍钉死，避免以后有人把它当成回归又装回字数线。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { looksTruncatedReply } from "../companion-dialogue-content.ts";

test("短**不**再是被拦的理由——用户说「ok，今天先这样」，她答「好」是正确收尾", () => {
  // 40 §4.8.1 第 1 条：「"好""嗯"等在确认/结束语境可以成立」；
  // 「只有用户问题没被回应才判不足」——这些都回应了。
  for (const reply of [
    "好。", "嗯。", "行。", "好的。", "嗯嗯。", "知道了。", "谢谢。", "这样。", "行吧。",
    // 以下是**不在任何收尾词表里**的形状。词表已经删了，所以它们靠结构判，
    // 而不是靠「长得像收尾词」放行——这正是要证明的那一点。
    "在的。", "有。", "好嘞。", "收到。",
    // 完全没有句末标点的短应答。
    "好", "嗯", "行", "对", "在的",
  ]) {
    assert.equal(looksTruncatedReply(reply), false, `「${reply}」没有语法断裂，不该判截断`);
  }
});

test("长句同样不被拦——长度与这道闸彻底无关", () => {
  const long = "嗯嗯嗯".repeat(200);
  assert.equal(looksTruncatedReply(long), false);
  // 但把结构弄断，同一条长句立刻被拦：判据是断裂，不是长短。
  assert.equal(looksTruncatedReply(`${long}1`), true);
  assert.equal(looksTruncatedReply(`${long}《消防`), true);
});

test("语法断裂**仍然拦得住**——这道闸不是被放行了", () => {
  // 两条都是实机量到的退化形态。
  assert.equal(looksTruncatedReply("今天已经学了1"), true, "结尾是半个数字：本来要接「8分钟」");
  assert.equal(looksTruncatedReply("最近三篇是《消防"), true, "《 开了没关");
  assert.equal(looksTruncatedReply("她说这本是（第四章"), true, "（ 开了没关");
  // 空回复仍然算断（空输出另由 companionOutputRejectionReason 接）。
  assert.equal(looksTruncatedReply("   "), true);
});

test("放行了「有」——这是合同的结果，不是疏漏", () => {
  // 40 §4.4.2：「短句、无问句、未提记忆不单独触发重跑」。
  // 「有」与「嗯」「行」「在的。」在结构上完全一样：单字、无标点、无未闭合符号。
  // 过去能区分它们，靠的是**被这条合同删掉的**字数线。
  assert.equal(looksTruncatedReply("有"), false);
  // 把这条钉死：任何人想装回字数线，这里会先红。
  assert.equal(looksTruncatedReply("有"), looksTruncatedReply("嗯"));
});

test("【变异自证】判据对「结构证据被放行」是灵敏的", () => {
  // ① 正控制：两条断裂形态必须命中。
  const stillGuarded = ["今天已经学了1", "最近三篇是《消防"];
  for (const reply of stillGuarded) {
    assert.equal(looksTruncatedReply(reply), true, `「${reply}」被放行了：判据恒真，这道闸什么都没拦`);
  }
  // ② 反控制：完整句必须与断裂句判出不同结果——否则上面那条是白写的。
  assert.notDeepEqual(
    ["好。", "嗯。", "在的。"].map(looksTruncatedReply),
    stillGuarded.map(looksTruncatedReply),
    "完整组与断裂组判成了同一个结果：这条判据区分不出东西",
  );
  // ③ 同一条正文，只改结尾那个字，结论必须翻面——证明判据真的在看断裂。
  assert.equal(looksTruncatedReply("最近三篇是《消防》"), false);
  assert.equal(looksTruncatedReply("最近三篇是《消防"), true);
});