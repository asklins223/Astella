/**
 * 0373 的结构性守卫：语法收支、执行体三列互斥、结果列迁移、锁顺序与授权三处一致。
 *
 * 最要紧的两处都是**顺序**而不是形状——锁顺序错了不报语法错、只在并发取消里变成死锁；
 * 授权只写一处，bootstrap 要到下一次起容器才炸，而缺授权的实际表现是 worker 静默
 * 跳过父围栏继续烧预算。括号收支那条是被真实探测打出来的：多一个右括号会让整份迁移
 * 在语法阶段就停住，而纯文本正则看不出来。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0373_agent_card_execution.sql", import.meta.url),
  "utf8",
);
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

/** 括号收支：探测在 `OR cr.status='no_cards_recommended')` 处报过多一个右括号。 */
test("每个 statement 与每个函数体的圆括号都收支平衡", () => {
  const strip = (text: string) => text
    .replace(/--[^\n]*/g, "")            // 行注释
    .replace(/'(?:[^']|'')*'/g, "''");  // 字符串字面量
  const segments = migration.split("--> statement-breakpoint");
  assert.ok(segments.length > 5, `只切出 ${segments.length} 段，迁移正文可能被截断`);
  segments.forEach((segment, index) => {
    const stripped = strip(segment);
    assert.equal(
      (stripped.match(/\(/g) ?? []).length, (stripped.match(/\)/g) ?? []).length,
      `第 ${index} 段圆括号不收支`,
    );
  });
  const bodies = [...migration.matchAll(/AS \$\$([\s\S]*?)\$\$/g)];
  assert.ok(bodies.length >= 6, `只找到 ${bodies.length} 个函数体，改名触发器可能被漏掉`);
  bodies.forEach((body, index) => {
    const stripped = strip(body[1]!);
    assert.equal(
      (stripped.match(/\(/g) ?? []).length, (stripped.match(/\)/g) ?? []).length,
      `第 ${index} 个函数体圆括号不收支`,
    );
  });
  assert.equal(migration.includes("\uFFFD"), false, "迁移里出现替换字符（乱码）");
});

test("0373 已登记", () => {
  assert.ok(journal.entries.some((entry) =>
    entry.idx === 369 && entry.tag === "0373_agent_card_execution"),
  "迁移不在 journal 里就永远不会被应用");
  const tags = journal.entries.map((entry) => entry.tag);
  assert.equal(new Set(tags).size, tags.length, "journal 里有重复 tag");
});

test("执行体三列互斥：job 非空两卡为空，或 job 空两卡都非空", () => {
  assert.match(migration, /ALTER TABLE public\.agent_operations ADD COLUMN card_generation_run_id uuid/);
  assert.match(migration, /ALTER TABLE public\.agent_operations ADD COLUMN card_generation_outbox_id uuid/);
  assert.match(migration, /ALTER TABLE public\.agent_operations ALTER COLUMN job_id DROP NOT NULL/);
  assert.match(
    migration,
    /ADD CONSTRAINT agent_operations_execution_xor_chk CHECK \(\s*\(job_id IS NOT NULL AND card_generation_run_id IS NULL AND card_generation_outbox_id IS NULL\)\s*OR \(job_id IS NULL AND card_generation_run_id IS NOT NULL AND card_generation_outbox_id IS NOT NULL\)\s*\)/,
  );
});

test("所有权与一次执行唯一由 scoped 复合外键与 partial unique 兜住", () => {
  assert.match(
    migration,
    /FOREIGN KEY \(card_generation_run_id,workspace_id,user_id\)\s*REFERENCES public\.card_generation_runs_v2\(id,workspace_id,user_id\)/,
  );
  // outbox 外键把「这一发」同时绑到 run 上：只有初始那一发会通过（b.run_id = 这一列）。
  assert.match(
    migration,
    /FOREIGN KEY \(card_generation_outbox_id,card_generation_run_id,workspace_id\)\s*REFERENCES public\.card_generation_run_outbox_v2\(id,run_id,workspace_id\)/,
  );
  assert.match(migration, /CREATE UNIQUE INDEX agent_operations_card_run_unique\s*ON public\.agent_operations\(card_generation_run_id\) WHERE card_generation_run_id IS NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX agent_operations_card_outbox_unique\s*ON public\.agent_operations\(card_generation_outbox_id\) WHERE card_generation_outbox_id IS NOT NULL/);
  // 被引用的两张表原先没有能当外键目标的唯一键，必须先补。
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_id_ws_user_unique\s*ON public\.card_generation_runs_v2\(id,workspace_id,user_id\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS cgro_v2_id_run_ws_unique\s*ON public\.card_generation_run_outbox_v2\(id,run_id,workspace_id\)/);
});

test("artifact 列迁成 result，存量按 artifact 结果包一层", () => {
  assert.match(migration, /ALTER TABLE public\.agent_operations RENAME COLUMN artifact TO result/);
  assert.match(
    migration,
    /UPDATE public\.agent_operations SET result = jsonb_build_object\('kind','artifact','artifact',result\)\s*WHERE result IS NOT NULL/,
  );
  assert.match(migration, /result->>'kind' IN \('artifact','no_cards_recommended'\)/);
  assert.match(migration, /ALTER TABLE public\.agent_run_events RENAME COLUMN job_status TO execution_status/);
});

test("改名后必须重建 0368 的 note 触发器：字面函数体不会跟着改写列名", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.astella_agent_job_event\(\) RETURNS trigger/);
  // 只换列名，绑定与唤醒语义逐字保留。
  assert.match(
    migration,
    /INSERT INTO public\.agent_run_events\(run_id,workspace_id,user_id,revision,operation_id,execution_status\)\s*VALUES\(op\.run_id,op\.workspace_id,op\.user_id,op\.revision,op\.id,NEW\.status::text\)/,
  );
  assert.match(migration, /WHERE o\.job_id=NEW\.id AND o\.workspace_id=NEW\.workspace_id AND o\.user_id=NEW\.requested_by/);
  assert.match(migration, /AND NEW\.status::text IN \('succeeded','dead','failed'\)/);
  // 重建后函数体里不能再出现旧列名，否则三个现役 note 能力的终态事务全部失败。
  assert.equal(
    /CREATE OR REPLACE FUNCTION public\.astella_agent_job_event\(\)[\s\S]*?END \$\$;[\s\S]*?job_status/.test(
      migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.astella_agent_job_event")),
    ),
    false,
    "重建后的 note 触发器里仍有 job_status",
  );
});

test("领域状态触发器只为绑定的那一发初始 outbox 写回执并持久入队", () => {
  assert.match(migration, /CREATE FUNCTION public\.astella_agent_card_run_event\(\) RETURNS trigger/);
  assert.match(
    migration,
    /CREATE TRIGGER agent_card_run_event AFTER UPDATE OF status ON public\.card_generation_runs_v2\s*FOR EACH ROW EXECUTE FUNCTION public\.astella_agent_card_run_event\(\)/,
  );
  // 归属：必须是绑定的初始那一发（job_type 固定），审核台后续几发不受影响。
  assert.match(migration, /b\.id = op\.card_generation_outbox_id AND b\.run_id = NEW\.id[\s\S]*?b\.job_type = 'card_generation_simplified_v1'/);
  assert.match(migration, /WHEN NEW\.status IN \('review_ready','needs_attention','no_cards_recommended'\) THEN 'succeeded'/);
  // 入队是持久的：LISTEN 只是加速，重启后靠这一行 + 恢复扫描。
  assert.match(migration, /INSERT INTO public\.jobs\(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key\)/);
});

test("恢复扫描涵盖制卡，且核对预算越界后只因真实交付事实再唤醒", () => {
  const recovery = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.astella_enqueue_agent_recovery()"));
  assert.match(recovery, /LEFT JOIN public\.card_generation_runs_v2 cr ON cr\.id=o\.card_generation_run_id/);
  assert.match(recovery, /o\.receipt_checks < 4/);
  // 交付事实：审核开放 ∧ 至少一张最新 revision 的可审候选；零推荐也是一条已落定的交付。
  assert.match(
    recovery,
    /c\.quality_state='passed' AND c\.review_decision='undecided'\s*AND c\.publish_state='unpublished' AND c\.evidence_binding_plan_hash IS NOT NULL\s*AND cr\.status IN \('review_ready','needs_attention'\)/,
  );
  assert.match(recovery, /newer\.candidate_id=c\.candidate_id AND newer\.revision>c\.revision/);
  assert.match(recovery, /OR cr\.status='no_cards_recommended'/);
});

test("取消／修订也停掉制卡这一发，并按 parent → card → outbox 的顺序", () => {
  const cancel = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.astella_cancel_agent_operations"));
  const cancelBody = cancel.slice(0, cancel.indexOf("END $$;"));
  const parentLock = cancelBody.indexOf("FROM public.agent_runs WHERE id=p_run AND revision=p_revision");
  const cardUpdate = cancelBody.indexOf("UPDATE public.card_generation_runs_v2 cr SET status='cancelled'");
  const outboxUpdate = cancelBody.indexOf("UPDATE public.card_generation_run_outbox_v2 b SET status='failed'");
  assert.ok(parentLock >= 0 && cardUpdate > parentLock && outboxUpdate > cardUpdate,
    `取消必须按 parent(${parentLock}) → card(${cardUpdate}) → outbox(${outboxUpdate}) 取锁`);
  // 已成功的成果保留：只有还在生成的 run 档位会被收走，outbox 只碰 pending/processing。
  assert.match(cancelBody, /cr\.status IN \('queued','source_sealing','planning','authoring','checking'\)/);
  assert.match(cancelBody, /b\.status IN \('pending','processing'\)/);
});

test("父围栏函数签名固定，且 p_lock 时先锁父目标再锁制卡行", () => {
  assert.match(
    migration,
    /CREATE FUNCTION public\.astella_agent_card_job_current\(p_outbox uuid,p_workspace uuid,p_lock boolean DEFAULT false\) RETURNS boolean/,
  );
  const fence = migration.slice(migration.indexOf("CREATE FUNCTION public.astella_agent_card_job_current"));
  const fenceBody = fence.slice(0, fence.indexOf("END $$;"));
  const agentLock = fenceBody.indexOf("FROM public.agent_runs r WHERE r.id=parent_run FOR SHARE");
  const cardLock = fenceBody.indexOf("FROM public.card_generation_runs_v2 cr WHERE cr.id=card_run FOR SHARE");
  const outboxLock = fenceBody.indexOf("FROM public.card_generation_run_outbox_v2 b WHERE b.id=p_outbox FOR SHARE");
  assert.ok(agentLock >= 0 && cardLock > agentLock && outboxLock > cardLock,
    `p_lock 必须按 parent(${agentLock}) → card(${cardLock}) → outbox(${outboxLock})，反过来会与取消死锁`);
  // 未绑定的 outbox（用户自己点的制卡、审核台后续几发）恒为真：原域行为一个字节都不改。
  assert.match(fenceBody, /IF parent_run IS NULL THEN RETURN true; END IF;/);
  // 判据与 astella_agent_job_current 对齐，另加一条冻结材料绑定。
  assert.match(fenceBody, /r\.status IN \('queued','running','waiting','paused'\)/);
  assert.match(fenceBody, /a\.epoch=r\.account_epoch/);
  assert.match(fenceBody, /o\.status IN \('accepted','running','outcome_unknown'\)/);
  assert.match(fenceBody, /\(i->>'noteId'\)::uuid=cr\.note_id AND \(i->>'noteVersionId'\)::uuid=cr\.note_version_id/);
});

test("授权三处一致：新函数只给 worker，api 不得出现", () => {
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.astella_agent_card_job_current\(uuid,uuid,boolean\) FROM PUBLIC/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_job_current\(uuid,uuid,boolean\) TO astella_worker;/,
  );
  assert.equal(
    /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_job_current\(uuid,uuid,boolean\) TO [^;]*astella_api/.test(migration),
    false,
    "父围栏不归 API：给了 api 就多一个能窥探目标围栏的入口",
  );
  // roles.sql：属主收敛、worker 白名单、反向必需清单，三处一起改。
  for (const signature of [
    "astella_agent_card_job_current(uuid,uuid,boolean)",
    "astella_agent_card_execution_binding(uuid,uuid)",
    "astella_agent_card_run_event()",
  ]) {
    assert.ok(roleGrants.includes(`'${signature}'`), `属主收敛列表遗漏 ${signature}`);
  }
  assert.match(
    roleGrants,
    /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_job_current\(uuid,uuid,boolean\) TO astella_worker;/,
  );
  const workerAllowlist = roleGrants
    .split("has_function_privilege('astella_worker'")[1]
    ?.split("RAISE EXCEPTION 'Worker has unexpected function EXECUTE privileges:")[0] ?? "";
  assert.match(workerAllowlist, /astella_agent_card_job_current\(uuid,uuid,boolean\)/,
    "worker 白名单漏了这条，bootstrap 会在下一次起容器时直接失败");
  // 反向清单（"该有的授权不能缺"）是一份 FROM (VALUES …) 列表：条数少、形状唯一，
  // 整份文件里这一对元组只可能出现在那里，不必切片段。
  assert.match(
    roleGrants, /\('astella_worker', 'astella_agent_card_job_current\(uuid,uuid,boolean\)'\)/,
    "反向清单漏了这条，缺授权时 bootstrap 不会报——而 worker 会静默跳过父围栏");
  const apiAllowlist = roleGrants
    .split("AND has_function_privilege('astella_api'")[1]
    ?.split("RAISE EXCEPTION 'API has unexpected function EXECUTE privileges:")[0] ?? "";
  assert.equal(
    /astella_agent_card_job_current/.test(apiAllowlist), false,
    "API 白名单里不该有这条（没授就不该出现；出现了只会掩盖一次误授）",
  );
});

test("初始归属读取是 worker-only 受控函数，签名与授权四处一致", () => {
  assert.match(
    migration,
    /CREATE FUNCTION public\.astella_agent_card_execution_binding\(p_outbox uuid,p_workspace uuid\)\s*RETURNS TABLE\(operation_id uuid,agent_run_id uuid,revision integer,user_id uuid\)/,
  );
  // workspace 必须等于本次事务作用域。
  assert.match(
    migration,
    /IF p_workspace IS DISTINCT FROM NULLIF\(current_setting\('app\.workspace_id',true\),''\)::uuid THEN\s*RAISE EXCEPTION 'agent scope not authorized'/,
  );
  // 按初始 outbox + 真 card run + Agent parent 的 scoped identity 返回，含真实 card run.user_id。
  assert.match(
    migration,
    /JOIN public\.card_generation_run_outbox_v2 b ON b\.id=o\.card_generation_outbox_id\s*JOIN public\.card_generation_runs_v2 cr ON cr\.id=b\.run_id AND cr\.workspace_id=p_workspace/,
  );
  assert.match(migration, /o\.user_id=cr\.user_id AND r\.user_id=cr\.user_id/);
  // 绑定读取不是 current 判定：不按成员资格或终态过滤。
  const binding = migration.slice(migration.indexOf("CREATE FUNCTION public.astella_agent_card_execution_binding"));
  const body = binding.slice(0, binding.indexOf("END $$;"));
  assert.equal(/workspace_members/.test(body), false, "绑定读取不该按成员资格过滤");
  assert.equal(/status\s*(=|IN)/.test(body), false, "绑定读取不该按终态过滤");
  // 授权四处：迁移 REVOKE/GRANT、roles.sql 属主、worker 白名单、反向必需清单。
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_agent_card_execution_binding\(uuid,uuid\) FROM PUBLIC;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_execution_binding\(uuid,uuid\) TO astella_worker;/);
  assert.match(migration, /ALTER FUNCTION public\.astella_agent_card_execution_binding\(uuid,uuid\) OWNER TO astella_migrator;/);
  assert.equal(
    /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_execution_binding\(uuid,uuid\) TO [^;]*astella_api/.test(migration),
    false,
    "初始归属读取不归 API",
  );
  assert.match(roleGrants, /'astella_agent_card_execution_binding\(uuid,uuid\)'/);
  assert.match(roleGrants, /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_execution_binding\(uuid,uuid\) TO astella_worker;/);
  const workerAllowlist = roleGrants
    .split("has_function_privilege('astella_worker'")[1]
    ?.split("RAISE EXCEPTION 'Worker has unexpected function EXECUTE privileges:")[0] ?? "";
  assert.match(workerAllowlist, /astella_agent_card_execution_binding\(uuid,uuid\)/);
  assert.match(roleGrants, /\('astella_worker', 'astella_agent_card_execution_binding\(uuid,uuid\)'\)/);
});

test("触发器函数不给任何角色 EXECUTE（触发执行不查 session 用户权限）", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_agent_card_run_event\(\) FROM PUBLIC;/);
  assert.equal(
    /GRANT EXECUTE ON FUNCTION public\.astella_agent_card_run_event\(\)/.test(migration + roleGrants),
    false,
    "触发器函数给了 EXECUTE 只会扩大可调用面",
  );
});

test("这一版没有扩大业务表授权：worker 的制卡读写沿用 roles.sql 既有矩阵", () => {
  // 只看真正的表授权语句；新加的两个唯一索引不在这套语法里。
  const addedTableGrants = [...migration.matchAll(/GRANT\s+[^;]*?ON\s+TABLE\s+public\.([a-z_]+)/gi)].map(m => m[1]);
  assert.deepEqual(
    [...new Set(addedTableGrants)], [],
    `迁移里不该新增任何表授权，实际出现：${addedTableGrants.join(", ") || "（无）"}`,
  );
});