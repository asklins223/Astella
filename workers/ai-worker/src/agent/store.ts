import { randomUUID } from "node:crypto";
import { createAgentStore, type AgentAdvanceStore, type AgentStorePorts } from "@ailearn/agent-host";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";

// ports 明确用 db.ts 导出的真实事务类型：invoke 回调里的 tx 就是
// withWorkerWorkspaceTransaction 当前那一段事务，没有新建包装、没有断言。
export const agentStorePorts: AgentStorePorts<WorkerTransaction> = {
  transaction: (scope, action) => withWorkerWorkspaceTransaction(scope, action), id: randomUUID,
};
export const agentStore = createAgentStore(agentStorePorts);

/** 能力适配器用的推进 store 形状：回调里的 tx 是真实 `WorkerTransaction`。 */
export type AgentWorkerAdvanceStore = AgentAdvanceStore<WorkerTransaction>;
