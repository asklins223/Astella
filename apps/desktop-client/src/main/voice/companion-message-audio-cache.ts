import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  COMPANION_MESSAGE_AUDIO_LIMIT, COMPANION_VOICE_MAX_AUDIO_BYTES,
  companionVoiceSpeakResultV1Schema,
  type CompanionCachedVoiceListResultV1, type CompanionVoiceSpeakResultV1,
  type CompanionVoiceSpeakSegmentRequestV2,
} from "@astella/shared/companion-voice-contracts";
import type { VoiceAudioScope } from "./companion-voice-audio-cache";

export type MessageAudioScope = VoiceAudioScope & { workspaceId: string };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const clipSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  voice: z.string().min(1).max(64),
  byteLength: z.number().int().positive().max(COMPANION_VOICE_MAX_AUDIO_BYTES),
  audioHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const recordSchema = z.strictObject({
  version: z.literal(1),
  workspaceHash: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.number().finite().nonnegative(),
  segments: z.array(clipSchema).min(1).max(200),
});
type Recording = z.infer<typeof recordSchema>;

/** 原始 MP3 留在 userData。账号、空间与回复身份都哈希，正文和凭据不落盘。 */
export class CompanionMessageAudioCache {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly captures = new Map<string, { at: number; revision: number }>();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly directory: string) {}

  private account(scope: VoiceAudioScope) {
    return join(this.directory, hash(JSON.stringify([scope.deployment, scope.userId])));
  }
  private message(scope: MessageAudioScope, runId: string) {
    return join(this.account(scope), hash(JSON.stringify([scope.workspaceId, runId])));
  }
  private scopeKey(scope: MessageAudioScope) { return join(this.account(scope), hash(scope.workspaceId)); }
  beginCapture(scope: MessageAudioScope, runId: string) {
    const key = this.message(scope, runId);
    const revision = this.revisions.get(this.scopeKey(scope)) ?? 0;
    const previous = this.captures.get(key);
    if (previous?.revision === revision) return previous;
    const capture = { at: Date.now(), revision };
    this.captures.set(key, capture);
    if (this.captures.size > 256) this.captures.delete(this.captures.keys().next().value!);
    return capture;
  }
  private async serial<T>(scope: VoiceAudioScope, action: () => Promise<T>): Promise<T> {
    const key = this.account(scope);
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, pending);
    try { return await pending; }
    finally { if (this.queues.get(key) === pending) this.queues.delete(key); }
  }
  private async metadata(folder: string): Promise<Recording | null> {
    try {
      if ((await stat(join(folder, "record.json"))).size > 100_000) return null;
      return recordSchema.parse(JSON.parse(await readFile(join(folder, "record.json"), "utf8")));
    } catch { return null; }
  }

  async save(scope: MessageAudioScope, ref: CompanionVoiceSpeakSegmentRequestV2,
    result: CompanionVoiceSpeakResultV1, capture: { at: number; revision: number }, stillCurrent: () => boolean): Promise<void> {
    const parsed = companionVoiceSpeakResultV1Schema.parse(result);
    const audio = Buffer.from(parsed.audioBase64, "base64");
    if (audio.length !== parsed.byteLength || audio.toString("base64") !== parsed.audioBase64) return;
    await this.serial(scope, async () => {
      const current = () => stillCurrent() && capture.revision === (this.revisions.get(this.scopeKey(scope)) ?? 0);
      if (!current()) return;
      const folder = this.message(scope, ref.runId);
      const previous = await this.metadata(folder);
      if (previous?.segments.some(clip => clip.ordinal === ref.ordinal && clip.segmentId === ref.segmentId)) return;
      // 已被额度淘汰的旧轮次迟到，不能挤掉较新的消息。
      const records = await this.records(scope);
      if (!previous && records.length >= COMPANION_MESSAGE_AUDIO_LIMIT
        && capture.at < Math.min(...records.map(record => record.at))) return;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = join(folder, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, audio, { mode: 0o600 });
        if (!current()) return;
        await rename(temporary, join(folder, `${ref.ordinal}.mp3`));
        const metadata: Recording = { version: 1, workspaceHash: hash(scope.workspaceId), capturedAt: previous?.capturedAt ?? capture.at,
          segments: [...(previous?.segments ?? []).filter(clip => clip.ordinal !== ref.ordinal), {
            ordinal: ref.ordinal, segmentId: ref.segmentId, voice: parsed.voice,
            byteLength: audio.length, audioHash: hash(audio),
          }].sort((left, right) => left.ordinal - right.ordinal) };
        await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
        if (!current()) return;
        // 索引最后提交：未写完整的分段不会成为历史回放入口。
        await rename(temporary, join(folder, "record.json"));
        const expired = (await this.records(scope)).sort((a, b) => b.at - a.at || b.folder.localeCompare(a.folder))
          .slice(COMPANION_MESSAGE_AUDIO_LIMIT);
        await Promise.all(expired.map(record => rm(record.folder, { recursive: true, force: true })));
      } finally {
        await rm(temporary, { force: true });
        // 退出、磁盘中断或索引未提交留下的孤立字节也不能无限积累。
        if (!await this.metadata(folder)) await rm(folder, { recursive: true, force: true });
      }
    });
  }

  private async records(scope: VoiceAudioScope) {
    const account = this.account(scope);
    const names = await readdir(account).catch(() => [] as string[]);
    const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const folder = join(account, name), metadata = await this.metadata(folder);
      if (!metadata) await rm(folder, { recursive: true, force: true });
      return metadata ? { folder, at: metadata.capturedAt, workspaceHash: metadata.workspaceHash } : null;
    }));
    return records.filter((record): record is NonNullable<typeof record> => record !== null);
  }

  async list(scope: MessageAudioScope, runIds: string[]): Promise<CompanionCachedVoiceListResultV1> {
    return this.serial(scope, async () => {
      const items = await Promise.all([...new Set(runIds)].map(async runId => {
        const metadata = await this.metadata(this.message(scope, runId));
        return metadata ? { runId, ordinals: metadata.segments.map(clip => clip.ordinal) } : null;
      }));
      return { version: 1, items: items.filter((item): item is NonNullable<typeof item> => item !== null) };
    });
  }

  async read(scope: MessageAudioScope, runId: string, ordinal: number): Promise<CompanionVoiceSpeakResultV1 | null> {
    return this.serial(scope, async () => {
      const folder = this.message(scope, runId), metadata = await this.metadata(folder);
      const clip = metadata?.segments.find(segment => segment.ordinal === ordinal);
      if (!clip) {
        if (!metadata) await rm(folder, { recursive: true, force: true });
        return null;
      }
      try {
        const file = join(folder, `${ordinal}.mp3`);
        if ((await stat(file)).size !== clip.byteLength) throw new Error("invalid audio length");
        const audio = await readFile(file);
        if (hash(audio) !== clip.audioHash) throw new Error("invalid audio digest");
        return companionVoiceSpeakResultV1Schema.parse({ version: 1, mimeType: "audio/mpeg",
          voice: clip.voice, byteLength: audio.length, audioBase64: audio.toString("base64") });
      } catch {
        await rm(folder, { recursive: true, force: true });
        return null;
      }
    });
  }

  async clear(scope: MessageAudioScope): Promise<void> {
    // 清除对话与服务端一样仅作用于当前空间。文件名仍不暴露空间身份。
    const key = this.scopeKey(scope);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    await this.serial(scope, async () => {
      const records = await this.records(scope);
      await Promise.all(records.filter(record => record.workspaceHash === hash(scope.workspaceId))
        .map(record => rm(record.folder, { recursive: true, force: true })));
    });
  }
}
