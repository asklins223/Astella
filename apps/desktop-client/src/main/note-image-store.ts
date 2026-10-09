import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SOURCE_IMAGE_MAX_BYTES, SOURCE_IMAGE_MIME_TYPES } from "@astella/shared/source-image-contracts";

export const NOTE_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export type NoteImageBytes = { readonly bytes: Buffer; readonly mime: string };

/** 原图不可变；部署和账号一起参与文件名。缓存只经已通过会话/空间门控的网关读取。 */
export class NoteImageStore {
  private readonly pending = new Map<string, Promise<NoteImageBytes>>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, private readonly maxBytes = NOTE_IMAGE_CACHE_MAX_BYTES) {}

  fileFor(scope: string, objectKey: string): string {
    return join(this.directory, `${createHash("sha256").update(JSON.stringify([scope, objectKey])).digest("hex")}${extname(objectKey).toLowerCase()}`);
  }

  async get(scope: string, objectKey: string, load: () => Promise<NoteImageBytes>, authorize?: () => Promise<void>): Promise<NoteImageBytes> {
    const path = this.fileFor(scope, objectKey);
    const existing = this.pending.get(path);
    if (existing) return existing;
    const attempt = (async () => {
      const mime = mimeFor(path);
      const bytes = await readFile(path).catch(() => null);
      if (bytes && bytes.length > 0 && bytes.length <= SOURCE_IMAGE_MAX_BYTES && mime) {
        await authorize?.();
        void utimes(path, new Date(), new Date()).catch(() => undefined);
        return { bytes, mime };
      }
      const loaded = await load();
      await this.prime(scope, objectKey, loaded);
      return loaded;
    })();
    this.pending.set(path, attempt);
    try { return await attempt; }
    finally { if (this.pending.get(path) === attempt) this.pending.delete(path); }
  }

  async prime(scope: string, objectKey: string, image: NoteImageBytes): Promise<void> {
    if (!image.bytes.length || image.bytes.length > SOURCE_IMAGE_MAX_BYTES || image.bytes.length > this.maxBytes
      || !(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(image.mime) || mimeFor(objectKey) !== image.mime) return;
    const path = this.fileFor(scope, objectKey);
    // 串行写入和淘汰，避免并发扫描重复计数或把刚写出的文件删掉。
    const write = this.writes.then(async () => {
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, image.bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
        const entries = await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/.test(name)).map(async name => {
          const entryPath = join(this.directory, name), info = await stat(entryPath).catch(() => null);
          return info?.isFile() ? { path: entryPath, size: info.size, atimeMs: info.atimeMs } : null;
        }));
        const files = entries.filter(entry => entry !== null);
        let total = files.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of files.sort((a, b) => a.atimeMs - b.atimeMs)) {
          if (total <= this.maxBytes) break;
          if (entry.path === path) continue;
          await rm(entry.path, { force: true });
          total -= entry.size;
        }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    this.writes = write.catch(() => undefined);
    // 磁盘写不进去仍返回刚取回的字节；缓存失败不会把本次阅读变成失败。
    await this.writes;
  }
}

function mimeFor(path: string): string | null {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()] ?? null;
}

let store: NoteImageStore | null = null;
export function createNoteImageStore(directory: string): NoteImageStore { return store = new NoteImageStore(directory); }
export function getNoteImageStore(): NoteImageStore | null { return store; }
