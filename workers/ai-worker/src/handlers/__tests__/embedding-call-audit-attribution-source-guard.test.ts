/**
 * 治理出口的调用点判据：**每一个**向量出口都要带上完整归属。
 *
 * ## 为什么按"扫全部调用点"写，而不是钉死某几个文件
 *
 * 向量调用的归属（owner / operation / job / 带出去的类别）是在**调用点**声明的，
 * 治理层只能算结构事实、算不出"这次送的是用户原话还是笔记正文"。于是：
 * 新增一个向量调用点时忘了传归属，那一笔既不进成本、也不出现在设置页
 * "带出去的内容"里，而没有任何一条测试会红。
 *
 * 按模块名逐个钉会漏——文件改名、拆分、或者干脆新加一个出口，那条守卫都不会响。
 * 这里扫的是**整个 handlers 目录里所有 `createGovernedEmbeddingProvider(` 的调用点**，
 * 逐个检查它有没有把归属一起交出去。判据跟着契约的真实承载面走，不跟着文件名走。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const HANDLERS_DIR = join(import.meta.dirname, "..");

/** 剥掉注释，否则治理说明里引用旧写法会被当成真实调用点。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** 取一个调用点括号里的参数文本（花括号配平）。 */
function argumentsOf(source: string, callIndex: number): string {
  const open = source.indexOf("(", callIndex);
  assert.ok(open > 0, "createGovernedEmbeddingProvider( 的括号没找到");
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("createGovernedEmbeddingProvider( 的括号没配平");
}

interface CallSite { file: string; args: string }

function embeddingCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of readdirSync(HANDLERS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const code = withoutComments(readFileSync(join(HANDLERS_DIR, file), "utf8"));
    for (const hit of code.matchAll(/createGovernedEmbeddingProvider\(/g)) {
      sites.push({ file, args: argumentsOf(code, hit.index) });
    }
  }
  return sites;
}

test("每个向量出口都声明了 owner / operation / job / 类别", () => {
  const sites = embeddingCallSites();
  assert.ok(sites.length > 0, "一个向量出口都没扫到——扫描范围多半坏了");
  for (const site of sites) {
    for (const field of ["userId", "operation", "dataCategories"]) {
      // 写法上 shorthand（`userId,`）与显式（`userId: event.read.userId,`）都算数，
      // 判据只问"交没交出去"，不绑死写法。
      assert.match(site.args, new RegExp(`\\b${field}\\b\\s*[:,]`),
        `${site.file} 的向量出口没传 ${field}：这一笔既不进成本归因，`
        + "也不出现在设置页「带出去的内容」里");
    }
  }
});

test("向量出口的归属带真实 jobs 行，不拿 run/outbox id 冒充 job_id", () => {
  for (const site of embeddingCallSites()) {
    const jobId = /\bjobId:\s*([^,}\n]+)/.exec(site.args)?.[1]?.trim();
    if (jobId === undefined) continue;
    assert.ok(
      jobId === "null" || /job\.id|ctx\.id/.test(jobId),
      `${site.file} 的向量出口把 "${jobId}" 写进了 job_id：`
      + "那一列的契约是 jobs 表里的行，run id / outbox id 填进去只会造出指向空处的假归属",
    );
  }
});

test("【自证】判据认得出「忘传归属」与「拿非 jobs id 冒充」这两种形状", () => {
  const missing = "raw, govCtx, workspaceId";
  for (const field of ["userId", "operation", "dataCategories"]) {
    assert.equal(new RegExp(`\\b${field}\\b\\s*[:,]`).test(missing), false,
      `自证样本没造好：${field} 不该被判成已传`);
  }
  const shorthand = "{ userId, operation: 'x', dataCategories: [] }";
  assert.equal(/\buserId\b\s*[:,]/.test(shorthand), true, "自证样本没造好：shorthand 写法应当算已传");
  const wrongJob = "{ userId, operation: 'x', jobId: run.runId, dataCategories: [] }";
  const jobId = /\bjobId:\s*([^,}\n]+)/.exec(wrongJob)?.[1]?.trim();
  assert.ok(jobId !== undefined && !/job\.id|ctx\.id/.test(jobId),
    "自证样本没造好：非 jobs id 应当被这条判据抓到");
});