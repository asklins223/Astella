/**
 * API 侧六个现役文本外发点的治理出口判据。
 *
 * 每一处都有**两个**出口：显式注入的 `requester`（可信宿主端口，测试用）与
 * 生产默认。生产默认必须是**绑定真实 workspace/user 的治理出口**——
 * 同意、数据外发政策、PII 净化、审计行都在那一层。
 *
 * 真正会出事的那种形状不是"忘了接"，而是**默认接了一个裸 transport**：
 * `postJsonToPublicEndpoint` 只带 SSRF 守卫，不带同意、不带政策、不写审计行，
 * 而且它长得完全合理——能跑通、能过测试、只是"治理那一层不见了"。
 *
 * 按这六个文件判而不是扫全目录：本次交付范围就是这六处，提前宣判别的包
 * 的账不在这条判据的职责里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const API_SRC = join(import.meta.dirname, "..");

/** 剥注释：治理说明里会引用旧写法，不剥会命中自己文件里的说明文字。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const SITES = [
  ["modules/note-learning-rounds/teaching/teaching-llm.ts", "note_teaching_explain"],
  ["modules/note-learning-rounds/target-grounding.ts", "note_round_target_grounding"],
  ["modules/learning-runs/planning/run-critic.ts", "assessment_critic"],
  ["modules/learning-runs/disputes/dispute-recheck.ts", "dispute_recheck"],
  ["modules/companion-conversation/delivery/proactive-generator.ts", "companion_memory_candidate"],
  ["modules/companion-conversation/delivery/proactive-hook.ts", "companion_personalized_proactive_text"],
] as const;

function read(relative: string): string {
  return withoutComments(readFileSync(join(API_SRC, relative), "utf8"));
}

/** 取调用点第一个实参的文本（括号配平）。 */
function firstArgument(code: string, callIndex: number): string {
  const open = code.indexOf("(", callIndex);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "(" || code[i] === "{" || code[i] === "[") depth += 1;
    else if (code[i] === ")" || code[i] === "}" || code[i] === "]") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error("实参括号没配平");
}

test("六个外发点的生产默认出口都是治理出口，不是裸 transport", () => {
  for (const [file] of SITES) {
    const code = read(file);
    assert.match(code, /createGovernedApiRequester\(/,
      `${file} 的生产默认出口没有接治理：裸 transport 只带 SSRF 守卫，`
      + "不带同意、不带数据外发政策、不过 PII、不写审计行");
    assert.doesNotMatch(code, /postJsonToPublicEndpoint\(/,
      `${file} 还在直接调裸 transport`);
  }
});

test("每个外发点都声明了稳定的 operation 任务名", () => {
  for (const [file, operation] of SITES) {
    assert.ok(read(file).includes(`"${operation}"`),
      `${file} 没有声明 operation "${operation}"：成本与合规归因就没有分桶依据`);
  }
});

test("治理出口的身份来自调用上下文，不是请求参数", () => {
  // 身份只能取自宿主已经核对过的 scope（数据库读出的那一份）。
  // 从请求参数拿，等于"客户端说它是谁就按谁外发"——那正是治理出口要挡的形状，
  // 而且从源码形状上就能认出来，不需要跑起来。
  for (const [file] of SITES) {
    const code = read(file);
    const calls = [...code.matchAll(/createGovernedApiRequester\(/g)];
    assert.ok(calls.length > 0, `${file} 没有建治理出口`);
    for (const call of calls) {
      const scopeArg = firstArgument(code, call.index);
      assert.doesNotMatch(scopeArg, /\b(req|request|params|query|body|payload)\b/,
        `${file} 的治理出口从请求参数里取身份：客户端自称是谁就按谁外发`);
      assert.match(scopeArg, /\S/, `${file} 的治理出口没给出 scope`);
    }
  }
});

test("【自证】判据认得出「裸 transport」「换了 operation 名」「身份取自请求参数」这三种形状", () => {
  const bare = 'import { postJsonToPublicEndpoint } from "x";\nawait postJsonToPublicEndpoint(url, {}, {});';
  assert.equal(/createGovernedApiRequester\(/.test(bare), false, "自证样本没造好");
  assert.equal(/postJsonToPublicEndpoint\(/.test(bare), true, "自证样本没造好");

  const wrongOperation = 'createGovernedApiRequester({ workspaceId: "w", userId: "u" }, "some_other_name", ["note_content"]);';
  assert.equal(wrongOperation.includes('"note_teaching_explain"'), false, "自证样本没造好：换名就该被抓到");

  const fromRequest = 'createGovernedApiRequester({ workspaceId: request.body.ws, userId: request.body.uid }, "note_teaching_explain", ["note_content"]);';
  assert.equal(/\b(req|request|params|query|body|payload)\b/.test(fromRequest), true,
    "自证样本没造好：身份取自请求参数就该被抓到");
});
