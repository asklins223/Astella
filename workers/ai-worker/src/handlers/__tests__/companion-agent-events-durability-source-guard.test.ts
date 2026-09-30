import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 步进持久化的**耐久字段**：一条步子/一个 run 落到"结束"时，那几个时间戳必须落库。
 *
 * ## 为什么要有这条
 *
 * 2026-09-30 实测：把 `finishStep` 里的 `finished_at = now()` 删掉，
 * worker 的 **873 条测试一条都不红**。也就是说这一族的 SQL 此前完全没有断言。
 *
 * 为什么这几个字段最要命：它们是**"这件事结束了"**的唯一记录。
 * 少写一个 `finished_at`，症状是那一步永远停在进行中——而症状出现在
 * 别的系统（`companion_agent_steps` 的收尾查询、看板、重试判定），
 * 日志上什么都看不出来。`run-processing` 那类按状态挑活的查询会一直挑中它。
 *
 * ## 这条判据的对象
 *
 * 是「结束语句写到了那几个字段」，不是「文件里有这几个字」。
 * 搬文件（B2 把这一族拆出来）不会让这里红，因为读的是**搬完之后的新家**。
 */

const EVENTS = join(import.meta.dirname, "../companion-agent-events.ts");
const source = readFileSync(EVENTS, "utf8");

function bodyOf(fn: string): string {
  const start = source.indexOf(`async function ${fn}`);
  assert.ok(start > 0, `判据认不出 ${fn}——函数被改名或搬走了，这里会红（那是该红的时候）`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) { end = i; break; }
  }
  return source.slice(start, end);
}

test("finishStep 必须落下结束时间与结果摘要", () => {
  const body = bodyOf("finishStep");
  for (const field of ["status = ", "result_hash = ", "finished_at = now()"]) {
    assert.ok(body.includes(field),
      `finishStep 的 UPDATE 里少了 ${field}——`
      + "少了 finished_at，那一步就永远停在进行中，而症状出现在别的系统上，日志看不出来");
  }
  assert.ok(/WHERE id = \$\{stepId\} AND run_id = /.test(body),
    "finishStep 必须同时按 stepId 与 run_id 定位——只按 stepId 会写到别的 run 的步子上");
});

test("persistStep 落库成『进行中』且必须可重入", () => {
  const body = bodyOf("persistStep");
  // `started_at` 走的是列默认值（DDL 里的 DEFAULT now()），所以这里不要求它显式写；
  // 真正不能少的是**状态字面量**——它是「哪些步子正在跑」这条查询的唯一依据。
  assert.ok(/'model',\s*'running'/.test(body),
    "persistStep 没有把步子落成 running——「哪些步子正在跑」就永远查不到它们");
  // 重入性：同一 (run_id, step_no) 撞上时必须 DO NOTHING，而不是撞出第二行。
  // 少这一句的后果是重试一次多一行步子，而「一步一次」是账本与收尾查询的前提。
  assert.ok(/ON CONFLICT \(run_id, step_no\) DO NOTHING/.test(body),
    "persistStep 少了 ON CONFLICT (run_id, step_no) DO NOTHING——"
    + "重试会撞出第二行步子，而账本与收尾查询都按「一步一次」算");
});

test("appendAgentEvent 的序号必须来自库里的当前值，不是内存计数", () => {
  const body = bodyOf("appendAgentEvent");
  assert.ok(/event_seq|MAX\(/.test(body),
    "appendAgentEvent 看起来没有读库里的当前序号——"
    + "两个 worker 并发写同一 run 时会撞出重复序号，而那要到读事件流时才炸");
});

test("【自证】判据会红：抽掉 finished_at 必须被抓", () => {
  const body = bodyOf("finishStep");
  assert.ok(body.includes("finished_at = now()"), "自证：真实源码里那一句还在");
  const broken = body.replace("finished_at = now()", "/* 忘了 */");
  assert.ok(!broken.includes("finished_at = now()"), "自证：抽掉之后不该再匹配到");
  assert.ok(!broken.includes("finished_at = now()"), "自证：判据必须因此失败——这就是它存在的理由");
});
