/**
 * 分类器"要不要做事"判定的留出集读数（2026-10-16）。
 *
 * 问题不是猜的：交付闸 `action_not_executed` 按"本轮有没有落库的写"决定要不要作废整轮，
 * 而它认的"要求过的动作"来自分类器的 `candidateOperations`。这个名字表里**读工具和写工具
 * 混在一起**（`companion_read_note`、`companion_search_notes` 也算"要求的动作"），
 * 于是一句"看看那篇笔记写了什么"如果没调读取工具，也会被判成"说要做事没做"而吃掉整轮。
 *
 * 这个脚本从真实流量导出的一份 JSONL 上，把两个口径同时算出来：
 *   · 现役判定（`requestedActionTools` = 点名工具 ∩ 全工具面）
 *   · 收紧后（点名工具 ∩ **写类**工具面，与 `risk_class<>'read'` 那份权威事实同源）
 * 并打印被这两条判成"误标"的原文样本——读数必须能被原文自证，不然只是关键词计数。
 *
 *   导出（本地 dev 栈）：
 *     docker exec astella-dev-postgres-1 psql -U astella -d astella -Atc "<下面的 SQL>" > /tmp/holdout_rows.jsonl
 *   跑：
 *     node --import tsx scripts/companion-action-holdout.ts /tmp/holdout_rows.jsonl
 *
 * 第一次跑出来的读数（2026-10-16，dev 真实流量 300 轮，其中 `toolUse=act` 47 轮）：
 *   · 点名了写操作 46 轮，其中 28 轮有真落库回执；
 *   · **"说要做事却一个工具都没调"＝0 轮**，"落了写但没点名"＝0 轮；
 *   · 剩下 18 轮全都调了工具（1–6 次），拿到的是诚实回执：`companion_edit_note`
 *     `not_executed`（"发起这轮时你没有打开这篇笔记"／"这轮没有笔记光标"）、
 *     `companion_save_memory` `not_executed`（原话逐字引用/适用条件没对上）、
 *     以及 `ACTION_EXPIRED` 6 轮、`INTERNAL_ERROR` 3 轮、`cancelled` 2 轮。
 *   · 判定口径按"只认写类点名"重算一遍是 0.391 → 0.378，而**这条口径现役代码里已经在了**
 *     （`companion-turn-preamble.ts:131` 就带着 `riskClass !== "read"`）。
 * 结论：这一轮的读数不支持改分类器提示或改判定口径——分类器在"要不要做事"上没错，
 * 错的是把没落库的写当成一句谎。要补的是"诚实的拒绝也要说得出名字"（见
 * `companion-dialogue-failure-retention.ts` 那份点名）。这个脚本留着，是为了下次有人
 * 想动这条判据时能拿同一批样本重算，而不是靠印象。
 */
import { readFileSync } from "node:fs";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import { companionWriteToolNames } from "../src/handlers/companion-step-plan.ts";

type Row = {
  readonly run: string; readonly at: string; readonly status: string; readonly err: string;
  readonly intent: string; readonly toolUse: string; readonly ops: string[];
  readonly landed: number; readonly anyCalls: number; readonly text: string;
};

const file = process.argv[2] ?? "/tmp/holdout_rows.jsonl";
const rows: Row[] = readFileSync(file, "utf8").trim().split("\n")
  .map(line => { const v = JSON.parse(line) as Record<string, unknown>; return {
    run: String(v.run), at: String(v.at), status: String(v.status), err: String(v.err ?? ""),
    intent: String(v.intent ?? ""), toolUse: String(v.toolUse ?? ""),
    ops: Array.isArray(v.ops) ? (v.ops as string[]) : [], landed: Number(v.landed),
    anyCalls: Number(v.anyCalls), text: String(v.text ?? "") }; });

// 与运行时同一份权威事实：工具面的 riskClass 决定点名是不是"要落库的动作"。
const surface = resolveAllCompanionAgentTools("full");
const writeNames = new Set(companionWriteToolNames(surface));
const named = (row: Row, onlyWrites: boolean) => row.ops.filter(name =>
  onlyWrites ? writeNames.has(name) : surface.some(tool => tool.name === name));

const act = rows.filter(row => row.toolUse === "act");
const verdict = (onlyWrites: boolean) => {
  const due = act.filter(row => named(row, onlyWrites).length > 0);
  const missed = due.filter(row => row.landed === 0);
  return { due: due.length, missed: missed.length,
    rate: due.length === 0 ? "n/a" : (missed.length / due.length).toFixed(3), missed };
};
const current = verdict(false);
const tightened = verdict(true);

console.log(`留出集：${rows.length} 轮真实对话（toolUse=act ${act.length} 轮），写类工具 ${writeNames.size} 个`);
console.log(`改前（点名即算动作）：要求动作 ${current.due} 轮，没有落库回执 ${current.missed.length} 轮 → 误标率 ${current.rate}`);
console.log(`改后（只认写类点名）：要求动作 ${tightened.due} 轮，没有落库回执 ${tightened.missed.length} 轮 → 误标率 ${tightened.rate}`);

// 收紧后从"要作废"变成"不该作废"的那一类：只点了读工具，却被当成没做事。
const readOnly = current.missed.filter(row => named(row, true).length === 0);
console.log(`其中"只点了读工具"的轮次：${readOnly.length} 轮（这些是判定口径错了，不是她没做）`);
const stillMissed = tightened.missed;
console.log(`收紧后仍该追问的写类空转：${stillMissed.length} 轮`);
const byOutcome = (list: Row[]) => list.reduce<Record<string, number>>((acc, row) => {
  const key = `${row.status}:${row.err || "-"}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
console.log("改前这些轮的结局", byOutcome(current.missed));
console.log("收紧后这些轮的结局", byOutcome(stillMissed));

const show = (title: string, list: Row[]) => {
  console.log(`\n── ${title}（前 12 条原文）`);
  for (const row of list.slice(0, 12)) {
    console.log(`  [${row.at}] ${row.status}/${row.err || "-"} ops=${row.ops.join(",") || "-"} landed=${row.landed}`);
    console.log(`      ${row.text.replace(/\s+/g, " ").slice(0, 110)}`);
  }
};
show("只点了读工具却被判没做事", readOnly);
show("收紧后仍没落库的写类点名", stillMissed);
