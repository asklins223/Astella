import { randomUUID } from "node:crypto";
import { createAgentStore, type AgentStorePorts } from "@ailearn/agent-host";
import { withWorkerWorkspaceTransaction } from "../db.ts";

export const agentStorePorts: AgentStorePorts = {
  transaction: (scope, action) => withWorkerWorkspaceTransaction(scope, action), id: randomUUID,
};
export const agentStore = createAgentStore(agentStorePorts);
