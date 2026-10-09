import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NoteImageStore } from "../note-image-store";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "note-image-cache-test-")); directories.push(path); return path; }
const image = { bytes: Buffer.from("original-image"), mime: "image/png" };

it("parallel readers and a restarted application reuse the same disk bytes", async () => {
  const path = await directory(), store = new NoteImageStore(path), load = vi.fn(async () => image);
  await Promise.all(Array.from({ length: 12 }, () => store.get("deployment:user", "image.png", load)));
  expect(load).toHaveBeenCalledOnce();
  expect(await new NoteImageStore(path).get("deployment:user", "image.png", load)).toEqual(image);
  expect(load).toHaveBeenCalledOnce();
});
it("accounts and deployments cannot hit each other's image files", async () => {
  const store = new NoteImageStore(await directory()), load = vi.fn(async () => image);
  await store.get("deploy-a:user-a", "image.png", load);
  await store.get("deploy-a:user-b", "image.png", load);
  await store.get("deploy-b:user-a", "image.png", load);
  expect(load).toHaveBeenCalledTimes(3);
  expect(store.fileFor("deploy-a:user-a", "image.png")).not.toContain("user-a");
});
it("failed fetches can retry, and unavailable disk still returns a downloaded image", async () => {
  const path = await directory(), store = new NoteImageStore(path), load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(image);
  await expect(store.get("scope", "image.png", load)).rejects.toThrow("offline");
  expect(await store.get("scope", "image.png", load)).toEqual(image);
  const blocked = join(path, "blocked"); await writeFile(blocked, "a file");
  expect(await new NoteImageStore(blocked).get("scope", "image.png", async () => image)).toEqual(image);
});
it("quota evicts the least recently read image without double-counting overwrites", async () => {
  const path = await directory(), store = new NoteImageStore(path, 6), small = { bytes: Buffer.from("123"), mime: "image/png" };
  await store.prime("scope", "old.png", small);
  await utimes(store.fileFor("scope", "old.png"), new Date(0), new Date(0));
  await store.prime("scope", "keep.png", small);
  await store.prime("scope", "keep.png", small);
  expect(await readdir(path)).toHaveLength(2);
  await store.prime("scope", "new.png", small);
  expect(await readdir(path)).toHaveLength(2);
  await expect(readFile(store.fileFor("scope", "old.png"))).rejects.toThrow();
  expect(await readFile(store.fileFor("scope", "new.png"))).toEqual(small.bytes);
});

it("a cached file cannot be returned after its read permission is revoked", async () => {
  const store = new NoteImageStore(await directory());
  await store.prime("scope", "image.png", image);
  const load = vi.fn(async () => image), authorize = vi.fn().mockRejectedValue(new Error("not found"));
  await expect(store.get("scope", "image.png", load, authorize)).rejects.toThrow("not found");
  expect(load).not.toHaveBeenCalled();
  expect(authorize).toHaveBeenCalledOnce();
});
