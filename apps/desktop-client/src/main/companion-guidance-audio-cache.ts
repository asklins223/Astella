import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  companionVoiceSpeakResultV1Schema,
  type CompanionGuidanceVoiceProfileV1,
  type CompanionVoiceSpeakResultV1,
} from "@ailearn/shared/companion-voice-contracts";

export type GuidanceAudioScope = { deployment: string; userId: string };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const metadataSchema = z.strictObject({
  version: z.literal(1), voice: z.string().min(1).max(64),
  byteLength: z.number().int().positive().max(COMPANION_VOICE_MAX_AUDIO_BYTES),
  audioHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const CLIP_LIMIT = 64;

/** Main owns actual MP3 files; neither account names nor narration text appear in filenames. */
export class CompanionGuidanceAudioCache {
  private readonly pending = new Map<string, Promise<CompanionVoiceSpeakResultV1>>();
  constructor(private readonly directory: string) {}

  async resolve(scope: GuidanceAudioScope, text: string, profile: CompanionGuidanceVoiceProfileV1,
    synthesize: () => Promise<CompanionVoiceSpeakResultV1>): Promise<CompanionVoiceSpeakResultV1> {
    const folder = join(this.directory, hash(JSON.stringify([scope.deployment, scope.userId])));
    const key = hash(JSON.stringify([1, profile.profileId, text.trim()]));
    const file = join(folder, key);
    const existing = this.pending.get(file);
    if (existing) return existing;
    const operation = (async () => {
      const cached = await this.read(file, profile.voice);
      if (cached) return cached;
      const result = await synthesize();
      // An Edge fallback can play now, but must not permanently replace the default Qwen recording.
      if (result.voice === profile.voice) await this.write(folder, key, result).catch(() => undefined);
      return result;
    })();
    this.pending.set(file, operation);
    try { return await operation; }
    finally { if (this.pending.get(file) === operation) this.pending.delete(file); }
  }

  private async read(file: string, voice: string): Promise<CompanionVoiceSpeakResultV1 | null> {
    try {
      const [audioStat, metadataStat] = await Promise.all([stat(`${file}.mp3`), stat(`${file}.json`)]);
      if (audioStat.size < 1 || audioStat.size > COMPANION_VOICE_MAX_AUDIO_BYTES || metadataStat.size > 1024) return null;
      const metadata = metadataSchema.parse(JSON.parse(await readFile(`${file}.json`, "utf8")));
      const audio = await readFile(`${file}.mp3`);
      if (metadata.voice !== voice || audio.length !== metadata.byteLength || hash(audio) !== metadata.audioHash) return null;
      return companionVoiceSpeakResultV1Schema.parse({ version: 1, mimeType: "audio/mpeg", voice,
        byteLength: audio.length, audioBase64: audio.toString("base64") });
    } catch { return null; }
  }

  private async write(folder: string, key: string, result: CompanionVoiceSpeakResultV1): Promise<void> {
    const parsed = companionVoiceSpeakResultV1Schema.parse(result);
    const audio = Buffer.from(parsed.audioBase64, "base64");
    if (audio.length !== parsed.byteLength || audio.toString("base64") !== parsed.audioBase64) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, key), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, audio, { mode: 0o600 });
      await rename(temporary, `${file}.mp3`);
      await writeFile(temporary, JSON.stringify({ version: 1, voice: parsed.voice,
        byteLength: audio.length, audioHash: hash(audio) }), { mode: 0o600 });
      // Metadata commits last, so interruption never exposes half a recording as a hit.
      await rename(temporary, `${file}.json`);
      const clips = await Promise.all((await readdir(folder)).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name))
        .map(async name => ({ name, at: (await stat(join(folder, name))).mtimeMs })));
      const expired = clips.filter(clip => clip.name !== `${key}.mp3`).sort((a, b) => b.at - a.at).slice(CLIP_LIMIT - 1);
      await Promise.all(expired.flatMap(clip => [rm(join(folder, clip.name), { force: true }),
        rm(join(folder, clip.name.replace(/\.mp3$/, ".json")), { force: true })]));
    } finally { await rm(temporary, { force: true }); }
  }
}
