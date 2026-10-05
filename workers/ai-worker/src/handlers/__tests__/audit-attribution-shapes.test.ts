/**
 * 审计归属的两个易错点，钉在**它们真正的承载文件**上。
 *
 * ## 制卡：真实引用不写进 `job_id`
 *
 * `ai_audit_log.job_id` 的契约是"jobs 表里的那一行"。制卡走 V2 outbox，
 * 压根没有 jobs 行——把 `card_generation_runs_v2.id` 或 outbox 项 id 填进去，
 * 会让"按 job 聚合成本"指向一个永远 join 不上的东西。它比留空更坏：
 * 留空时一眼看得出"这笔没有归属"，填错时看起来有归属却查不到。
 * 于是制卡**不传 jobId**，真实引用走 `correlation`。
 *
 * ## 看图：这一次外发的就是图片字节
 *
 * 审计上下文存在、审计行也在写，但 `data_categories` 是空的——
 * 设置页「带出去的内容」对这一次最该被看见的外发永远是空的。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WORKER_SRC = join(import.meta.dirname, "..", "..");

/** 剥注释，避免治理说明里引用旧写法时被当成真实代码。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("制卡审计不把 outbox / generation run 的 id 写进 job_id", () => {
  const code = withoutComments(readFileSync(join(WORKER_SRC, "card-generation-v2", "governed-provider.ts"), "utf8"));
  const wrapped = code.slice(code.indexOf("createGovernedProvider("));

  assert.doesNotMatch(wrapped, /\bjobId\s*:/,
    "制卡把 id 写进了 job_id：那一列只认 jobs 行，制卡走 outbox，没有 jobs 行可填");
  assert.match(code, /\bcorrelation\?/, "制卡没有承载真实引用（correlation）的入口");
  assert.match(wrapped, /correlation/,
    "声明了 correlation 却没有透传下去：真实引用仍然无处可查");
  // 归属的另一半仍在：owner 与内容类别不能因为没有 jobId 一起丢掉。
  assert.match(wrapped, /userId: input\.userId/);
  assert.match(wrapped, /dataCategories: \["note_content"\]/);
});

test("看图的审计行声明 image_content", () => {
  const code = withoutComments(readFileSync(join(WORKER_SRC, "handlers", "companion-tool-execution.ts"), "utf8"));
  const at = code.indexOf('operation: "companion_read_image"');
  assert.ok(at > 0, "没找到看图那次的 operation");
  // 审计上下文的对象字面量在 operation **之前**开括号，所以往回找最近的 `{`，
  // 再从那里向前配平。往回找 `at` 之后的 `{` 会一路跑到文件后面的别的对象上。
  const open = code.lastIndexOf("{", at);
  assert.ok(open > 0, "没找到看图那次的审计上下文对象");
  let depth = 0;
  let end = open;
  for (; end < code.length; end += 1) {
    if (code[end] === "{") depth += 1;
    else if (code[end] === "}") { depth -= 1; if (depth === 0) { end += 1; break; } }
  }
  const audit = code.slice(open, end);

  assert.match(audit, /dataCategories: \["image_content"\]/,
    "看图这一次外发的是图片字节，不声明类别时审计行的类别列是空的，"
    + "设置页「带出去的内容」对这一次最该被看见的外发永远是空的");
  assert.match(audit, /jobId: event\.ctx\.id/, "看图的审计上下文丢了 jobs 行");
});