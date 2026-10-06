/**
 * 记忆工具族（`companion-memory-tools.ts`）与执行器之间的**转交契约**。
 *
 * ## 钉的是什么
 *
 * 2026-10-01 这六个工具的执行体从 `companion-tool-execution.ts` 搬进了本模块，
 * 而派活规则一个字没改：`definition.riskClass === "read"` 决定去
 * `executeReadTool` 还是 `executeDirectTool`。搬的时候**两把执行器里的 `case` 标签原样保留**，
 * 只是函数体变成一行转交。
 *
 * 这件事有三个只靠"文件能编译"抓不到的失败形状：
 *
 * 1. **两边同时留了分支。** 记忆族的每个工具在**两把**执行器里各有一个 `case`，
 *    派活规则送过去的那一个才是活的，另一个是第二份实现。
 * 2. **转交漏了一个。** 新增一个记忆工具却只在本模块里写了分支、忘了在执行器里留标签，
 *    运行时撞 `default` 的 throw——正是 39d W2-4「先决缺陷 #16」那次事故的形状。
 * 3. **转交给了错误的执行器。** 标签留在了 riskClass 不会送去的那一把里。
 *
 * `companion-tool-executor-ledger.test.ts` 那张台账管的是「谁有分支」，
 * 管不到「分支活不活」；那一条由它自己单独判。这里管的是**两边对得上**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";

import { executeCompanionMemoryTool } from "../companion-memory-tools.ts";
import { CompanionToolError } from "../companion-tool-result.ts";

const HANDLERS = resolve(import.meta.dirname, "..");
const EXECUTION_SOURCE = readFileSync(join(HANDLERS, "companion-tool-execution.ts"), "utf8");

/** 这六个工具构成"记忆族"。改动这一族的成员时，两处都要跟着改。 */
const MEMORY_TOOLS = [
  "companion_read_memory",
  "companion_recall_memory",
  "companion_save_memory",
  "companion_revise_memory",
  "companion_move_memory",
  "companion_forget_memory",
  // 判断记录（40 §4.5.5）同属这一族：它也写 assistant_memory_items，
  // 也需要同样的准入/版本/抑制/容量纪律。把它留在外面的话，
  // 它就会成为第二个没有台账盯着的写入口。
  "companion_remember_judgment",
  // 手册展开（40 §4.6.10）也归这一族：它写/读的是陪伴记录，同样需要
  // 准入、版本与抑制纪律；留在外面就会成为第二个没人盯的入口。
  "companion_read_playbook",
  // 日记读回（40 §6）也走这一族：它读的是陪伴记录，同样受 workspace 隔离与
  // 版本核对约束。留在外面就成了第二个不受台账盯着的读取通道。
  "companion_read_diary",
] as const;

/** 取出一个顶层函数体的文本（花括号配平）。与台账那条判据同一种取法。 */
function functionBody(name: string): string {
  const start = EXECUTION_SOURCE.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `执行器里找不到 ${name}——改名了就要同步这张表`);
  let depth = 0;
  for (let i = EXECUTION_SOURCE.indexOf("{", start); i < EXECUTION_SOURCE.length; i += 1) {
    if (EXECUTION_SOURCE[i] === "{") depth += 1;
    else if (EXECUTION_SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return EXECUTION_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的花括号没配平`);
}

const caseLabels = (body: string): string[] =>
  [...body.matchAll(/case "(companion_[a-z_]+)"/g)].map((m) => m[1]);

test("记忆族的每个工具在两把执行器里各只有一个标签，且转交给本模块", () => {
  const read = caseLabels(functionBody("executeReadTool"));
  const direct = caseLabels(functionBody("executeDirectTool"));

  for (const name of MEMORY_TOOLS) {
    const inRead = read.filter((t) => t === name).length;
    const inDirect = direct.filter((t) => t === name).length;
    assert.equal(inRead + inDirect, 1,
      `${name} 在两把执行器里一共出现 ${inRead + inDirect} 次——`
      + "要么两边都有（第二份实现），要么两边都没有（运行时撞 default 的 throw）");
  }
});

test("记忆族的标签长在 riskClass 真会送过去的那一把执行器里", () => {
  const read = new Set(caseLabels(functionBody("executeReadTool")));
  const direct = new Set(caseLabels(functionBody("executeDirectTool")));
  const wrongSide = MEMORY_TOOLS.filter((name) => {
    const def = COMPANION_AGENT_TOOL_DEFINITIONS.find((d) => d.name === name);
    assert.ok(def, `registry 里没有 ${name}——记忆族与注册表不同步`);
    return def!.riskClass === "read" ? !read.has(name) : !direct.has(name);
  });
  assert.deepEqual(wrongSide, [],
    "这些记忆工具的 case 长在派活规则不会送到的执行器里，运行时等于没有分支");
});

test("转交的那一行真的指向本模块（标签留着但忘了转交＝死分支）", () => {
  // 逐个标签扫是不行的：`case A:` 后面紧跟 `case B:` 是**贯穿**（fall-through），
  // 按"下一个 case 就结束"取窗口，A 的窗口里根本没有那行 return。
  // 正确做法是从**每一处 return 往前回溯**到连续的 case 标签组。
  const delegated = new Set<string>();
  for (const hit of EXECUTION_SOURCE.matchAll(/return executeCompanionMemoryTool\(/g)) {
    const before = EXECUTION_SOURCE.slice(0, hit.index);
    // 往前收连续的 `case "x":` 标签行。
    // 必须跳过三种行：空行、`//` 注释、以及 `return` 那一行本身——
    // 少了 `return` 这一跳，第一步就 break，判据会报「一个标签都没转交」。
    const labels: string[] = [];
    for (const line of before.split("\n").reverse()) {
      const label = /^\s*case "(companion_[a-z_]+)":\s*$/.exec(line);
      if (label) { labels.push(label[1]); continue; }
      if (line.trim() === "" || /^\s*(\/\/|return\b)/.test(line)) continue;
      break;
    }
    for (const name of labels) delegated.add(name);
  }
  assert.deepEqual([...delegated].sort(), [...MEMORY_TOOLS].sort(),
    "执行器里转交出去的标签与记忆族对不上——"
    + "要么某个记忆工具没被转交（死分支），要么转交了不该属于这一族的工具");
});

test("本模块只接记忆族：别的一个都不接，来了就报错而不是静默返回空", () => {
  // 真跑一次：不是记忆工具就该当场拒绝，而不是默默给一个空结果。
  const foreign = {
    name: "companion_search_notes",
    riskClass: "read",
    requiresConfirmation: false,
  };
  assert.rejects(
    () => executeCompanionMemoryTool({} as never, foreign as never, {}),
    (error: unknown) => error instanceof CompanionToolError
      && /不是记忆工具/.test((error as Error).message),
    "非记忆工具进了记忆族却没被拒——那说明 default 分支不见了");
});

test("full 档修订也走共享的账号级范围判据（42 阶段 1 E 复审补齐）", () => {
  // `full` 档是裸 SQL，不经 API 的 `correctMemory`；它自己那一份判据必须是**共享的**。
  // 两处各写一份正则时，漂移的方向通常是直执行那份更松——而 `full` 档恰恰是用户
  // 不需要确认的那一条路，守卫松在它上面等于没有守卫。
  const source = readFileSync(join(HANDLERS, "companion-memory-tools.ts"), "utf8");
  assert.match(source, /accountPreferenceWriteDecision\(/,
    "直执行修订没有过账号级范围判据");
  assert.ok(!/LOCAL_REFERENCE_PATTERN|SUBJECT_OR_EXAM_PATTERN|CROSS_SPACE_KINDS/.test(source),
    "记忆工具里又出现了一份范围正则：判据不再唯一");
  // 判据必须落在 UPDATE 之前，否则源行与跨空间副本已经被改过了。
  const guard = source.indexOf("accountPreferenceWriteDecision(");
  const update = source.indexOf("UPDATE assistant_memory_items", guard);
  assert.ok(guard >= 0 && update > guard,
    "范围守卫不在修订的 UPDATE 之前：拒绝来了也已经改过行");
  // 从锁住的当前行读真实 kind/scope：靠入参猜 scope 就是"输入省略就绕过去"。
  assert.match(source, /SELECT id, revision, kind, scope, content, applies_when/);
});

test("记忆召回的查询向量要走治理出口，不能裸建 provider", () => {
  // `companion_recall_memory` 送出去的是 `args.query`——用户自己打的那句话。
  // 它与记忆向量重建那条路是同一次外发、同一条治理边界，但上游这里是裸的
  // embedding provider 构造：不查 `user_ai_settings` 的同意、不查数据外发政策、
  // 不过 PII 净化。于是治理口径按调用族分裂成两半，且这半边在 `ai_audit_log`
  // 里一行都留不下（向量重建那条路一直有审计行）。
  const source = withoutComments(readFileSync(join(HANDLERS, "companion-memory-tools.ts"), "utf8"));

  assert.ok(!/createEmbeddingProvider\(\s*\)/.test(source),
    "还有一处不带治理上下文的 createEmbeddingProvider()：召回查询向量绕过同意与外发政策");
  assert.match(source, /resolveAIGovernanceContext\(event\.ctx\.workspaceId, event\.read\.userId\)/,
    "召回向量出口没有解析治理上下文");
  assert.match(source, /createGovernedEmbeddingProvider\(/,
    "召回向量没有过治理包装（PII 净化与出网政策都在这一层）");

  // 同意闸必须落在建 provider 之前：没同意外发就是不能建，
  // 不是"建了再降级"——降级本身已经把原话送出去了。
  const consentGate = source.indexOf("govCtx.consentOk");
  const build = source.indexOf("createEmbeddingProvider(govCtx)");
  assert.ok(consentGate > 0, "召回向量出口没有同意闸");
  assert.ok(build > consentGate, "建向量 provider 的动作不在同意闸之后");

  // 与重建那条路同口径：治理拿不到就整段跳过，关键词检索本来就是既定降级
  // （`retrieveCompanionMemories` 的 `!opts.provider` 分支），不是把召回整条判失败。
  assert.match(source, /if \(provider\) \{/,
    "拿不到向量 provider 时不该整条跳过——关键词降级才是既定路径");

  // 归属也要跟着交出去：owner 是谁、这笔外发属于哪个 job、送出去的是哪类内容。
  assert.match(source, /operation: "companion_memory_recall_embedding"/,
    "召回向量没有声明 operation：成本与合规归因都按它分桶");
  assert.match(source, /dataCategories: \["user_answer"\]/,
    "召回向量送出去的是用户原话，不声明类别时设置页「带出去的内容」对这条是空的");
  assert.match(source, /jobId: event\.ctx\.id/,
    "召回向量没带 jobs 行：这一笔挂不到任何 job 上");
});

/**
 * 去掉注释再判源码形状。
 *
 * 治理出口的说明注释本身就得写出旧写法；不剥掉的话这条判据会在自己的注释上
 * 报一条它抓不到的缺口。
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

test("【自证】正控制：判据认得出「两边都有分支」与「标签长错边」这两种形状", () => {
  // 这条判据的全部力气在两把执行器的差集上；这里用合成输入证明它不是恒真。
  const readSet = new Set(["companion_read_memory"]);
  const directSet = new Set(["companion_save_memory", "companion_read_memory"]);
  const duplicated = MEMORY_TOOLS.filter((n) => readSet.has(n) && directSet.has(n));
  assert.deepEqual(duplicated, ["companion_read_memory"], "自证样本没造好");

  const misplaced = MEMORY_TOOLS.filter((n) =>
    COMPANION_AGENT_TOOL_DEFINITIONS.find((d) => d.name === n)?.riskClass === "read"
      ? !readSet.has(n) : !directSet.has(n));
  // readSet 里只有 read_memory、directSet 里只有 save_memory 与 read_memory，
  // 于是两个 read 档里缺 recall_memory、四个写档里缺 revise/move/forget。
  assert.deepEqual(misplaced,
    [
      "companion_recall_memory",
      "companion_revise_memory",
      "companion_move_memory",
      "companion_forget_memory",
      "companion_remember_judgment",
      "companion_read_playbook",
      "companion_read_diary",
    ],
    "自证样本没造好");
});