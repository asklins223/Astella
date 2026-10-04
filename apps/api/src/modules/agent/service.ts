import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAgentStore } from "@ailearn/agent-host";
import { withWorkspaceTransaction } from "../../db/client.ts";

export const agentStore = createAgentStore({
  transaction: (scope, action) => withWorkspaceTransaction(scope, action), id: randomUUID,
  ensureIdentity: async (tx, scope) => { await tx.execute(sql`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`); },
});
