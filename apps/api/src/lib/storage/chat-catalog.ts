import { sql } from "drizzle-orm";
import { db, withWorkspaceTransaction, type WorkspaceTransactionContext } from "../../db/client.ts";
import { isChatObjectKey, isPersistentObjectKey } from "./policy.ts";

export async function registerChatUpload(scope: WorkspaceTransactionContext, key: string): Promise<void> {
  if (!isChatObjectKey(key)) return;
  await withWorkspaceTransaction(scope, tx => tx.execute(sql`INSERT INTO chat_upload_objects(object_key,workspace_id,user_id)
    VALUES(${key},${scope.workspaceId}::uuid,${scope.userId}::uuid) ON CONFLICT DO NOTHING`));
}
export async function chatUploadExpired(scope: WorkspaceTransactionContext, key: string): Promise<boolean> {
  if (!isChatObjectKey(key)) return false;
  const rows = await withWorkspaceTransaction(scope, tx => tx.execute<{ expired: boolean }>(sql`
    SELECT retained_at IS NULL AND (expires_at<=now() OR purge_started_at IS NOT NULL OR purged_at IS NOT NULL) AS expired
    FROM chat_upload_objects WHERE object_key=${key}`));
  return rows[0]?.expired ?? false;
}
export async function shouldBackUpObject(key: string): Promise<boolean> {
  if (isPersistentObjectKey(key)) return true;
  if (!isChatObjectKey(key)) return false;
  const rows = await db.execute<{ retained: boolean }>(sql`SELECT astella_chat_upload_retained(${key}) AS retained`);
  return rows[0]?.retained === true;
}
export async function registerLegacyChatFile(key: string, createdAt: Date): Promise<void> {
  if (key.split('/')[1] !== 'companion-files') return;
  await db.execute(sql`SELECT astella_register_legacy_chat_upload(${key},${createdAt.toISOString()}::timestamptz)`);
}
