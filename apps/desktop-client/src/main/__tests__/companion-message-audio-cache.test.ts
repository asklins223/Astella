import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionMessageAudioCache, type MessageAudioScope } from "../companion-message-audio-cache";
import { DesktopGateway } from "../desktop-gateway";
import { clearCompanionHistory, listCachedCompanionVoice, readCachedCompanionVoice, speakCompanionVoiceSegment } from "../desktop-gateway-ns-companion";
import type { CompanionVoiceSpeakResultV1, CompanionVoiceSpeakSegmentRequestV2 } from "@astella/shared/companion-voice-contracts";

let directory: string;
const scope: MessageAudioScope = { deployment: "http://127.0.0.1:4000", userId: randomUUID(), workspaceId: randomUUID() };
const audio: CompanionVoiceSpeakResultV1 = { version: 1, mimeType: "audio/mpeg", voice: "longhua_v3.1", audioBase64: "SUQzBA==", byteLength: 4 };
const reference = (runId = randomUUID(), ordinal = 1): CompanionVoiceSpeakSegmentRequestV2 => ({
  version: 2, conversationId: randomUUID(), runId, generation: 1, ordinal, segmentId: ordinal.toString(16).padStart(64, "0"),
});
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "message-audio-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function folders() {
  const accounts = await readdir(directory);
  return (await Promise.all(accounts.map(async name => (await readdir(join(directory, name))).map(message => join(directory, name, message))))).flat();
}

it("persists original MP3 bytes and ordered segments across restarts, without retaining plain identities or text", async () => {
  const cache = new CompanionMessageAudioCache(directory), ref = reference();
  const capture = cache.beginCapture(scope, ref.runId);
  await cache.save(scope, { ...ref, ordinal: 2, segmentId: "b".repeat(64) }, { ...audio, voice: "original-other-voice" }, capture, () => true);
  await cache.save(scope, ref, audio, capture, () => true);
  const reopened = new CompanionMessageAudioCache(directory);
  expect(await reopened.list(scope, [ref.runId])).toEqual({ version: 1, items: [{ runId: ref.runId, ordinals: [1, 2] }] });
  expect(await reopened.read(scope, ref.runId, 1)).toEqual(audio);
  expect((await reopened.read(scope, ref.runId, 2))?.voice).toBe("original-other-voice");
  const [folder] = await folders();
  expect(await readFile(join(folder, "1.mp3"))).toEqual(Buffer.from(audio.audioBase64, "base64"));
  if (process.platform !== "win32") expect((await stat(join(folder, "1.mp3"))).mode & 0o777).toBe(0o600);
  expect(folder).not.toContain(scope.userId);
  expect(folder).not.toContain(ref.runId);
  expect(await readFile(join(folder, "record.json"), "utf8")).not.toContain(scope.workspaceId);
});

it("caps concurrent recordings at 100 messages; segments and replay do not increase or promote the count", async () => {
  const cache = new CompanionMessageAudioCache(directory);
  const refs = Array.from({ length: 101 }, () => reference());
  const otherSpace = { ...scope, workspaceId: randomUUID() };
  await Promise.all(refs.slice(0, 100).map((ref, index) => cache.save(index % 2 ? otherSpace : scope, ref, audio, { at: index + 1, revision: 0 }, () => true)));
  await cache.read(scope, refs[0].runId, 1);
  await cache.save(scope, { ...refs[0], ordinal: 2, segmentId: "b".repeat(64) }, audio, { at: 1, revision: 0 }, () => true);
  await cache.save(scope, refs[100], audio, { at: 101, revision: 0 }, () => true);
  expect(await folders()).toHaveLength(100);
  expect(await cache.read(scope, refs[0].runId, 1)).toBeNull();
  expect(await cache.read(scope, refs[100].runId, 1)).toEqual(audio);
  // A late segment of the evicted reply must not evict a recent reply.
  await cache.save(scope, { ...refs[0], ordinal: 3 }, audio, { at: 1, revision: 0 }, () => true);
  expect(await folders()).toHaveLength(100);
  expect((await cache.list(scope, [refs[0].runId])).items).toEqual([]);
});

it("isolates accounts, deployments and spaces and removes damaged recordings", async () => {
  const cache = new CompanionMessageAudioCache(directory), ref = reference();
  await cache.save(scope, ref, audio, cache.beginCapture(scope, ref.runId), () => true);
  for (const other of [{ ...scope, userId: randomUUID() }, { ...scope, deployment: "https://other.example" }, { ...scope, workspaceId: randomUUID() }]) {
    expect(await cache.read(other, ref.runId, 1)).toBeNull();
    expect((await cache.list(other, [ref.runId])).items).toEqual([]);
  }
  const [folder] = await folders();
  await writeFile(join(folder, "1.mp3"), "oops");
  expect(await cache.read(scope, ref.runId, 1)).toBeNull();
  expect((await cache.list(scope, [ref.runId])).items).toEqual([]);
});

it("clears just the current space and fences late bytes from before the clear", async () => {
  const cache = new CompanionMessageAudioCache(directory), ref = reference();
  const other = { ...scope, workspaceId: randomUUID() };
  const capture = cache.beginCapture(scope, ref.runId);
  await cache.save(scope, ref, audio, capture, () => true);
  await cache.save(other, ref, audio, cache.beginCapture(other, ref.runId), () => true);
  await cache.clear(scope);
  await cache.save(scope, { ...ref, ordinal: 2 }, audio, capture, () => true);
  expect(await cache.read(scope, ref.runId, 1)).toBeNull();
  expect(await cache.read(scope, ref.runId, 2)).toBeNull();
  expect(await cache.read(other, ref.runId, 1)).toEqual(audio);
});

it("removes uncommitted bytes when the session ends during a write", async () => {
  const cache = new CompanionMessageAudioCache(directory), ref = reference();
  const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  await cache.save(scope, ref, audio, cache.beginCapture(scope, ref.runId), current);
  expect(await folders()).toEqual([]);
  expect((await cache.list(scope, [ref.runId])).items).toEqual([]);
});

function transport() {
  const gateway = new DesktopGateway({ DESKTOP_API_ORIGIN: scope.deployment,
    ASTELLA_DESKTOP_PAIRING_KEY_ID: "desktop-key-1", ASTELLA_DESKTOP_PAIRING_SECRET: Buffer.alloc(32, 9).toString("base64url"),
    ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test" }, { messageAudioCache: new CompanionMessageAudioCache(directory) });
  const t = gateway.gatewayTransport;
  t.connection = { version: 1, kind: "ready", schemaRevision: "domain-v2-test" };
  t.credentialRestored = true; t.token = "test-voice-token";
  t.currentSession = { version: 1, status: "authenticated", user: { userId: scope.userId, email: "voice@example.test" },
    workspace: { version: 1, workspaceId: scope.workspaceId, name: "书房", role: "owner", workspaceType: "personal", isPersonal: true, workspaceEpoch: 1 },
    membership: null, capabilities: null, workspaceEpoch: 1, credentialPersistence: "memory" };
  return t;
}
const response = () => new Response(Buffer.from(audio.audioBase64, "base64"), { headers: { "Content-Type": "audio/mpeg", "X-Astella-Tts-Voice": audio.voice } });

it("the real segment gateway saves the actual voice and reads it locally after restart, even with API offline", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
  const ref = reference();
  expect(await speakCompanionVoiceSegment(transport(), ref)).toEqual(audio);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockRejectedValue(new Error("offline"));
  const reopened = transport();
  expect((await listCachedCompanionVoice(reopened, [ref.runId])).items[0].ordinals).toEqual([1]);
  expect(await readCachedCompanionVoice(reopened, ref)).toEqual(audio);
  expect(fetch).toHaveBeenCalledOnce();
});

it("drops a synthesis that finishes after account or space changes before saving or returning bytes", async () => {
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const t = transport(), pending = speakCompanionVoiceSegment(t, reference());
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await vi.waitFor(() => expect(release).toBeDefined());
  t.currentSession = { ...t.currentSession!, workspaceEpoch: 2 };
  release(response());
  await rejected;
  expect(await readdir(directory)).toEqual([]);
});

it("keeps live speech working with an unwritable cache and clears files when history is deleted", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => init?.method === "DELETE"
    ? new Response(JSON.stringify({ version: 1, deletedMessages: 1, deletedConversations: 1, inboxCreated: true })) : response());
  const t = transport(), ref = reference();
  await speakCompanionVoiceSegment(t, ref);
  await clearCompanionHistory(t);
  expect((await listCachedCompanionVoice(t, [ref.runId])).items).toEqual([]);
  const blocked = join(directory, "file"); await writeFile(blocked, "blocked");
  const cache = new CompanionMessageAudioCache(blocked);
  await expect(cache.save(scope, ref, audio, cache.beginCapture(scope, ref.runId), () => true)).rejects.toThrow();
});
