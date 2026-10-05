import type { AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import type { AgentRunRow, AgentSqlExecutor } from "./store.ts";

/** A capability binds to the current host transaction/fence, never a worker. */
export interface AgentOperationStore<Tx extends AgentSqlExecutor = AgentSqlExecutor> {
  scope: AgentScopeV1;
  invoke<T>(action: (tx: Tx, run: AgentRunRow) => Promise<T>): Promise<T>;
}
