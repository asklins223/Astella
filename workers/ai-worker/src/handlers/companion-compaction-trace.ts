import { logger } from "../lib/logger.ts";
import { recordCompanionContextCompactions } from "./companion-dialogue-store.ts";
import type { CompanionContextHandoffSnapshotV1, CompactionTraceV1 } from "./companion-context-handoff.ts";

/**
 * 方案 44 §3.3／§5.3：把这一轮的折叠轨迹并进交接快照。
 *
 * 交接快照在 agent loop **之前**提交，压缩发生在 loop 里——没有这一步，审计从快照上
 * 看不出这一轮折过什么，那句「exact context handed」在有压缩的那一轮就是假的。
 *
 * 这里单独成模块，是因为它有两件容易做错的事，都与「什么时候写」有关：
 *   - **围栏**：run 已结束或快照已被别人推进时跳过，迟到结果不许覆盖；
 *   - **不阻塞交付**：轨迹没写进去不是失败，回复照常收尾，快照本身仍然可用。
 * 把它留在编排文件里，这两条很容易在赶流程时被漏掉。
 */
export interface CompactionTraceWriter {
  (input: {
    workspaceId: string; userId: string; runId: string;
    snapshot: CompanionContextHandoffSnapshotV1; sha256: string;
    compactions: readonly CompactionTraceV1[];
  }): Promise<boolean>;
}

export async function recordTurnCompactionTrace(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  snapshot: CompanionContextHandoffSnapshotV1;
  sha256: string;
  traces: readonly CompactionTraceV1[];
  /** 默认写库；单测注入一个失败的写口，验证「写不进去不阻塞交付」而不必真连库。 */
  write?: CompactionTraceWriter;
}): Promise<boolean> {
  if (args.traces.length === 0) return false;
  const write = args.write ?? recordCompanionContextCompactions;
  try {
    return await write({
      workspaceId: args.workspaceId, userId: args.userId, runId: args.runId,
      snapshot: args.snapshot, sha256: args.sha256, compactions: args.traces,
    });
  } catch (error) {
    logger.warn({ err: error, runId: args.runId }, "failed to record compaction trace on handoff snapshot");
    return false;
  }
}
