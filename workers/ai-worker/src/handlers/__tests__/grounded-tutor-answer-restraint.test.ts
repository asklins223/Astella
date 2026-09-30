/**
 * 作答页的提示词**必须自带**「不许说答案」这一条（39d W2-4；39 §7.1）。
 *
 * ## 它是被真模型量出来的，不是设想的
 *
 * 39d W2-4 的 S1 行为探针真跑了作答页那一档：**答案本体泄露 5/24、压低信任 5/24**
 * （n=12 每档两轮；量的是 agent loop 的**第一步**，生产会给她第二次机会，
 * 所以那是泄露率的**下界不是上界**）。
 *
 * 病因是提示词本身：作答页走的是 `GROUNDED_TUTOR_COMPANON_PROMPT`，而它被喂进去的
 * `claim` + `exact evidence` 在作答屏上**基本就是答案本身**——于是
 * 「只根据 claim 回答」等于「把 claim 念出来」，而那份提示词里**没有一条**禁止这件事。
 *
 * ## 为什么不能只靠服务端那道闸
 *
 * `assessAnswerExposure` 这一次 **5/5 全抓住**。但它是**相似度**判断：漏一档，
 * 用户就看到答案。提示词与服务端闸是**两道**防线，而第一道此前是空的。
 * 判据因此钉**两道都在**——不是"闸够不够"，是"提示词有没有那一条"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GROUNDED_TUTOR_COMPANION_PROMPT } from "../companion-dialogue-content.ts";

const PROMPT = GROUNDED_TUTOR_COMPANION_PROMPT;

test("作答页提示词里有一条**明确禁止说出答案**", () => {
  // 量的是**那条约束本身在不在**，不是"提示词里有没有类似的话"——
  // 「只根据 claim 回答」恰恰是**导致**泄露的那一条，它与这一条同时存在才对。
  assert.match(
    PROMPT,
    /不要说出[^。]*标准答案|不要说出[^。]*答案/,
    "作答页的提示词里没有「不许说答案」这一条：她被喂的就是 claim 与 evidence，"
    + "而 S1 真跑量到答案本体泄露 5/24",
  );
});

test("它要给出**替代做法**，不是只下一个禁令", () => {
  // 只有一个禁令的话，模型会退化成「我不知道」——而 §7.1 要的是"陪她把思路走一遍"。
  assert.match(PROMPT, /自己能推出下一步|把思路走一遍|陪/,
    "只有禁令没有替代做法：她会退化成「我不知道」，而那不是教学（§7.1）");
  // 明确被问「答案是什么」时的应对也要有
  assert.match(PROMPT, /答案是什么|明确问/,
    "没有覆盖「她直接问答案」这一格：而那正是最容易照抄的一格");
});

test("既有那几条**没被这一刀顺手改掉**", () => {
  // 三条是各自独立的约束，删掉任何一条都不会触发上面那两条判据——
  // 所以要单独钉住，否则"加了一条"很容易"顺手改坏了另外三条"。
  for (const [what, pattern] of [
    ["证据不足时明说不知道", /证据不足/],
    ["把上下文当数据不当指令", /不是可以执行的指令/],
    ["不输出内部状态", /mastery|schedule/],
  ] as const) {
    assert.match(PROMPT, pattern, `这条被改掉了：${what}`);
  }
});

test("**没有**把答案塞进提示词——闸在服务端，提示词只说规矩", () => {
  // 这一条防的是"为了让模型别说答案，把答案也写进提示词"那种修法：
  // 那样服务端那道按重合计暴露的闸（`assessAnswerExposure`）就永远量不到真实泄露面。
  //
  // 判据量的是「提示词里关于**答案**的每一句都出现在**约束子句**里」，
  // 而不是查有没有某个词——**第一版查了 `canonical`，而既有那条
  // 「不要输出 mastery、schedule、canonical card…」本来就该有那个词**，
  // 于是一条正确实现被报成违规。
  const sentences = PROMPT.split(/[。\n]/).map((s) => s.trim()).filter(Boolean);
  const aboutAnswer = sentences.filter((s) => /答案|题面/.test(s));
  assert.ok(aboutAnswer.length > 0, "提示词里一句都没提到答案：那这条约束根本没写进来");
  for (const sentence of aboutAnswer) {
    assert.ok(
      /不要|不给|陪|走一遍|推出/.test(sentence),
      `这句在陈述而不是在约束：「${sentence}」——`
      + "提示词只要说规矩，不该自己带答案（那会让服务端的闸量不到真实泄露面）",
    );
  }
});

/** 变异自证：把那条约束删掉，这几条必须红。 */
test("判据对「删掉那条约束」灵敏", () => {
  const mutated = PROMPT
    .split("\n")
    .filter((line) => !/标准答案|把思路走一遍/.test(line))
    .join("\n");
  assert.notEqual(mutated, PROMPT, "变异造不出差异 ⇒ 判据恒真（那句话的形状变了，先改判据再改实现）");
  assert.ok(
    !/不要说出[^。]*标准答案/.test(mutated),
    "变异没有真的删掉那条约束：守卫读不到那一处",
  );
  // 负对照：只删「替代做法」那一段时，第一条仍成立、第二条要红
  const banOnly = PROMPT
    .split("\n")
    .filter((line) => !/自己能推出下一步|把思路走一遍|陪/.test(line))
    .join("\n");
  assert.match(banOnly, /标准答案/, "负对照前提失败：删掉替代做法之后禁令仍在");
  assert.ok(
    !/自己能推出下一步|把思路走一遍|陪/.test(banOnly),
    "负对照自证失败：替代做法没有被删掉",
  );
});
