/**
 * 可选追问链路的**源码守卫**：这条链的每一环都可以静默断掉。
 *
 * 追问是终态之后由后台任务补写的展示元数据。少注册一个 handler、少加一个 job 白名单、
 * 少给一个 UPDATE 权限、多写一次正文哈希，都不会让回复变红——只会让用户永远等不到按钮，
 * 或者让已经生成的摘要和反思证据被一次无关的元数据写入作废。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JobType } from "@astella/shared";

// 从 src/__tests__/ 往上四级是仓库根：__tests__ → src → ai-worker → workers → 仓库根
const REPO = new URL("../../../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(new URL(relative, REPO), "utf8");
}

const migration = read("apps/api/src/db/migrations/0420_companion_followup_suggestions_async.sql");
const journal = read("apps/api/src/db/migrations/meta/_journal.json");
const indexSource = read("workers/ai-worker/src/index.ts");
const timeoutConfig = read("workers/ai-worker/src/lib/handler-timeout-config.ts");
const dialogueSource = read("workers/ai-worker/src/handlers/companion-dialogue.ts");
const storeSource = read("workers/ai-worker/src/handlers/companion-dialogue-store.ts");
const jobSource = read("workers/ai-worker/src/handlers/companion-followup-suggestions-job.ts");
const contractsSource = read("packages/shared/src/contracts/companion-conversation-contracts.ts");
const messageSchemaSource = read("packages/shared/src/db-schema/companion-conversations.ts");
const apiMessagesSource = read("apps/api/src/modules/companion-conversation/turn/companion-conversations-service.ts");
const replaySource = read("apps/api/src/modules/companion-conversation/run-turn-replay.ts");
const bundleSource = read("apps/api/src/modules/companion-conversation/run-issue-bundle.ts");
const diagnosticsSource = read("packages/shared/src/contracts/companion-run-diagnostics.ts");
const roleGrants = read("infra/postgres/roles.sql");

test("① 任务真的会被执行：声明、注册、限时三处都在", () => {
  assert.equal(JobType.COMPANION_FOLLOWUP_SUGGESTIONS, "companion_followup_suggestions");
  assert.match(indexSource, /companion_followup_suggestions:\s*runCompanionFollowupSuggestions/,
    "新 job 类型没进派发表——队列里有任务，但永远没人领");
  assert.match(timeoutConfig, /companion_followup_suggestions:\s*\d+_?\d*,/,
    "追问任务没有超时上限，卡住的外呼会一直占着 worker");
});

test("② 0420 进了日志，并且补上了 worker 写回元数据的权限", () => {
  assert.match(journal, /"tag": "0420_companion_followup_suggestions_async"/,
    "迁移文件不在 _journal.json 里：本地跑得到，别人和 CI 的环境永远没有这一列");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS follow_up_prompts jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON public\.companion_messages TO astella_worker/,
    "worker 只有读权限时，追问生成成功也写不回去——只在生产环境才炸");
  assert.match(migration, /'companion_agent', 'companion_followup_suggestions',/,
    "jobs 的插入守卫按类型白名单放行，漏加就在排队那一步直接失败");
  assert.match(migration, /'assistant\.followups\.ready', 'agent\.skill',/,
    "流事件类型 CHECK 没放行新事件，落库那步会整笔回滚");
});

test("②b 授权主源 roles.sql 也给了 UPDATE —— 只写迁移会在下一次 bootstrap 被抹掉", () => {
  // 2026-10-13 真窗口实测：dev 库里追问任务连撞两次 dead（permission denied for
  // companion_messages）。迁移那句 GRANT 是生效过的，但 roles.sql 在迁移后再跑一遍，
  // 开头 REVOKE ALL 把迁移刚给的权限抹了，于是下一次 make up 又回到没授权的状态。
  assert.match(roleGrants, /GRANT INSERT, UPDATE ON TABLE public\.companion_messages TO astella_worker/,
    "roles.sql 没给 worker UPDATE：下一次角色 bootstrap 之后追问写不回去");
  assert.match(roleGrants, /\('companion_messages', true, true, true, false\)/,
    "权限矩阵还写着 companion_messages 不能 UPDATE：bootstrap 会直接报 mismatch");
});

test("③ 追问是展示元数据：不进正文哈希，也不作废摘要与反思证据", () => {
  assert.match(migration, /AFTER DELETE OR UPDATE OF blocks, content_sha256/,
    "触发器又回到整行 UPDATE 都算改正文：一次追问写入就会作废会话摘要");
  assert.match(jobSource, /SET follow_up_prompts =/, "任务不再写元数据列，读到的就是旧形状");
  assert.doesNotMatch(jobSource, /UPDATE companion_messages\s+SET blocks/,
    "把追问塞回正文会改写 content_sha256 依赖的内容");
  assert.doesNotMatch(dialogueSource, /follow_up_suggestions/,
    "回复正文里又出现追问块：建议混进了正文哈希");
  assert.match(contractsSource, /followUpPrompts: z\.array\(z\.string\(\)\.min\(4\)\.max\(120\)\)\.max\(3\)\.optional\(\)/,
    "消息合同里的追问元数据被拿掉了");
});

test("④ 排队与回复终态同一笔事务，迟到时窗只在客户端一侧", () => {
  assert.match(dialogueSource, /await enqueueCompanionFollowupSuggestions\(tx, \{/,
    "追问任务不在终态事务里排队：回复落库成功、任务丢失，没人会知道");
  assert.match(storeSource, /'companion_followup_suggestions', \$\{args\.workspaceId\}, \$\{args\.userId\},/);
  assert.match(storeSource, /companion-followups:\$\{args\.assistantMessageId\}/,
    "幂等键不再是 assistant 消息本身，重试就会重复生成、重复下发");
});

test("⑤ API 侧认识的事件类型只有一份声明", () => {
  // 诊断投影以前各自抄了一份列表：漏加新事件不报错，只是 eventTailComplete 静默变 false。
  assert.match(diagnosticsSource, /export const COMPANION_DIAGNOSTIC_EVENT_TYPES_V1 = \[/);
  assert.match(diagnosticsSource, /"assistant\.followups\.ready",/);
  for (const [name, source] of [["run-turn-replay.ts", replaySource], ["run-issue-bundle.ts", bundleSource]] as const) {
    assert.match(source, /new Set<[^>]*>\(COMPANION_DIAGNOSTIC_EVENT_TYPES_V1\)/,
      `${name} 又抄了一份事件类型列表，第二主人会漏加新事件`);
  }
});

test("⑥ 读取侧把元数据列带出来，两端才看得到迟到的追问", () => {
  assert.match(messageSchemaSource, /followUpPrompts: jsonb\("follow_up_prompts"\)/);
  assert.match(apiMessagesSource, /followUpPrompts: Array\.isArray\(row\.followUpPrompts\) \? row\.followUpPrompts : \[\]/,
    "消息列表没带出追问，历史里的建议就只剩当年写进正文的旧块");
});
