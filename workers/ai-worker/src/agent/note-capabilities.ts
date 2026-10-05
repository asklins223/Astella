import {
  queryRows, requireVisibleInput, AgentStoreError, startAgentNoteOperation,
} from "@ailearn/agent-host";
import { noteAgentCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import { agentInputRefV1Schema } from "@ailearn/shared/agent-contracts";
import { loadNoteReadPage } from "../handlers/companion-read-tools.ts";
import { readExpansionDrafts } from "./expansion-reading.ts";
import type { AgentWorkerAdvanceStore } from "./store.ts";

export async function invokeNoteCapability(store: AgentWorkerAdvanceStore, call: { id: string; name: string; arguments: Record<string, unknown> }) {
  const manifest = noteAgentCapabilityManifest.find(m => m.definition.name === call.name);
  if (!manifest) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  const input = manifest.argumentSchema.parse(call.arguments) as {
    noteId: string; noteVersionId: string; startOrdinal?: number;
    taskId?: string; startCandidateOrdinal?: number; startBlockOrdinal?: number; startBlockOffset?: number;
    draftsUpdatedAt?: string;
  };
  const ref = agentInputRefV1Schema.parse({ kind: "note_version", noteId: input.noteId, noteVersionId: input.noteVersionId });
  // 可见材料与冻结输入的检查对所有能力一视同仁：读取自己保存的草稿也不例外。
  // 两个读能力的**实际读取**都在这同一次 invoke 的事务里完成 —— 另起一条没有围栏的
  // 事务去读，取消或修订就可能夹在「核对通过」与「真的读到」之间，那一段窗口里
  // 读到的就是越权内容。
  const read = await store.invoke(async (tx, run) => {
    await requireVisibleInput(tx, store.scope, ref);
    if (!run.inputs.some(i => i.noteId === ref.noteId && i.noteVersionId === ref.noteVersionId))
      throw new AgentStoreError(403, "input_outside_goal", "这份材料不在当前目标范围内，请先把它交给伴星。");
    if (call.name === "note_read") {
      // loadNoteReadPage 只要一个能 execute 的端口。store 的事务给的是 AgentSqlExecutor
      // （execute 返回 unknown），用 queryRows 适配过去即可：既不复制那份唯一的生产 SQL，
      // 也不假装自己是一整条 WorkerTransaction。
      const page = await loadNoteReadPage({ execute: query => queryRows(tx, query) }, {
        ...store.scope, noteId: ref.noteId, noteVersionId: ref.noteVersionId,
        startOrdinal: input.startOrdinal ?? 1, maxChars: 3000,
      });
      if (!page) throw new AgentStoreError(404, "note_not_found", "这版笔记现在读不到。");
      return { kind: "note" as const, value: {
        status: "succeeded", title: page.title, noteId: ref.noteId, noteVersionId: page.versionId,
        totalBlocks: page.totalBlocks, truncated: page.truncated, nextStartOrdinal: page.nextStartOrdinal,
        imageCount: page.imageTotal, body: page.page.body,
      } };
    }
    if (call.name === "note_expansion_read") {
      // 上限取自能力定义本身：改了 manifest 的 maxOutputChars，这里跟着走，不会各写一个数。
      return { kind: "expansion" as const, value: await readExpansionDrafts(tx, {
        ...store.scope, runId: run.id, taskId: input.taskId!, noteId: ref.noteId, noteVersionId: ref.noteVersionId,
        startCandidateOrdinal: input.startCandidateOrdinal ?? 1,
        startBlockOrdinal: input.startBlockOrdinal ?? 1,
        startBlockOffset: input.startBlockOffset ?? 0,
        draftsUpdatedAt: input.draftsUpdatedAt,
        maxOutputChars: manifest.definition.maxOutputChars,
      }) };
    }
    return null;
  });
  if (read?.kind === "note") return read.value;
  if (read?.kind === "expansion") {
    // 读不到只有一种对外说法：不报「读到了空」，也不透露这批草稿属于谁。
    if (!read.value) throw new AgentStoreError(404, "expansion_task_not_found", "这批拓展草稿现在读不到，或不属于当前目标。");
    return read.value;
  }
  return store.invoke((tx, run) => startAgentNoteOperation(tx, store.scope, run, call, ref));
}
