import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { db } from "../../db/client.ts";
import { deleteObject, isStorageConfigured } from "../../lib/object-storage.ts";
import { backupEnabled, getBackupQueue, replicaBucket, replicaClient } from "../../lib/storage/replicas.ts";
import { registerLegacyChatFile } from "../../lib/storage/chat-catalog.ts";

export interface ChatRetentionTasks {
  promoted(): Promise<Array<{ object_key: string }>>;
  enqueuePromotion(key: string): Promise<void>;
  ackPromotion(key: string): Promise<void>;
  expired(): Promise<Array<{ object_key: string }>>;
  remove(key: string): Promise<void>;
  finish(key: string): Promise<void>;
}
/** Failed removal keeps its durable claim for retry; never mark missing bytes deleted early. */
export async function maintainChatUploads(tasks: ChatRetentionTasks): Promise<void> {
  for (const row of await tasks.promoted()) {
    await tasks.enqueuePromotion(row.object_key);
    await tasks.ackPromotion(row.object_key);
  }
  for (const row of await tasks.expired()) {
    await tasks.remove(row.object_key);
    await tasks.finish(row.object_key);
  }
}

export function startStorageMaintenance(app: FastifyInstance): void {
  if (!isStorageConfigured()) return;
  let busy = false, cursor: string | undefined, nextScan = 0, closing = false;
  let running: Promise<void> | undefined;
  const tick = async () => {
    if (busy || closing) return;
    busy = true;
    try {
      await maintainChatUploads({
        promoted: async () => backupEnabled() ? [...await db.execute<{ object_key: string }>(sql`SELECT * FROM astella_pending_chat_upload_promotions(50)`)] : [],
        enqueuePromotion: key => getBackupQueue().enqueue(key, 'primary'),
        ackPromotion: async key => { await db.execute(sql`SELECT astella_ack_chat_upload_promotion(${key})`); },
        expired: async () => [...await db.execute<{ object_key: string }>(sql`SELECT * FROM astella_claim_expired_chat_uploads(10)`)],
        remove: async key => {
          if (backupEnabled()) await getBackupQueue().enqueue(key, 'primary', 'delete');
          await deleteObject(key, 'primary');
          if (backupEnabled()) await deleteObject(key, 'backup');
        },
        finish: async key => { await db.execute(sql`SELECT astella_finish_chat_upload_purge(${key})`); },
      });
      // Metadata-only legacy inventory, one page per tick and no object downloads.
      if (Date.now() >= nextScan) {
        const page = await replicaClient('primary').send(new ListObjectsV2Command({
          Bucket: replicaBucket('primary'), MaxKeys: 100, ...(cursor ? { ContinuationToken: cursor } : {}),
        }), { abortSignal: AbortSignal.timeout(10000) });
        for (const object of page.Contents ?? []) if (object.Key && object.LastModified) await registerLegacyChatFile(object.Key, object.LastModified);
        cursor = page.NextContinuationToken;
        nextScan = Date.now() + (cursor ? 300000 : 86400000);
      }
    } catch (error) { app.log.warn({ error }, 'chat upload retention will retry'); }
    finally { busy = false; }
  };
  const run = () => { running = tick(); };
  const first = setTimeout(run, 5000), interval = setInterval(run, 300000);
  first.unref(); interval.unref();
  app.addHook('onClose', async () => { closing = true; clearTimeout(first); clearInterval(interval); await running; });
}
