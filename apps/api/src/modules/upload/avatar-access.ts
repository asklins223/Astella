import { sql } from "drizzle-orm";
import { withWorkspaceTransaction, type WorkspaceTransactionContext } from "../../db/client.ts";

/** A shared room exposes only a current member's currently published avatar. */
export async function canReadAvatarObject(scope: WorkspaceTransactionContext, path: string): Promise<boolean> {
  const match = /^avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/i.exec(path);
  if (!match || path.includes("..") || path.includes("\\")) return false;
  if (match[1] === scope.userId) return true;
  return withWorkspaceTransaction(scope, async tx => {
    const result = await tx.execute(sql`
      SELECT 1 FROM workspace_members target
      JOIN workspaces room ON room.id = target.workspace_id
      JOIN users person ON person.id = target.user_id
      JOIN workspace_members viewer ON viewer.workspace_id = room.id AND viewer.user_id = ${scope.userId}::uuid
      WHERE room.id = ${scope.workspaceId}::uuid AND room.workspace_type = 'collaborative'
        AND target.user_id = ${match[1]}::uuid AND target.left_at IS NULL AND viewer.left_at IS NULL
        AND person.avatar_url = ${"/api/uploads/" + path}
      LIMIT 1`);
    return result.length > 0;
  });
}
