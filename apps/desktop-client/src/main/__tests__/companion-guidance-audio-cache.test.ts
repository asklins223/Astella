import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionGuidanceAudioCache, type GuidanceAudioScope } from "../companion-guidance-audio-cache";
import { DesktopGateway } from "../desktop-gateway";
import { speakCompanionVoice } from "../desktop-gateway-ns-companion";
import type { CompanionGuidanceVoiceProfileV1, CompanionVoiceSpeakResultV1 } from "@ailearn/shared/companion-voice-contracts";

let directory: string;
const scope: GuidanceAudioScope = { deployment: "http://127.0.0.1:4000", userId: "00000000-0000-4000-8000-000000000001" };
const profile: CompanionGuidanceVoiceProfileV1 = { version: 1, profileId: "a".repeat(64), voice: "longhua_v3.1" };
const audio: CompanionVoiceSpeakResultV1 = { version: 1, mimeType: "audio/mpeg", voice: profile.voice, audioBase64: "SUQzBA==", byteLength: 4 };
const text = "我陪你从书房开始，接着找到笔记。";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "guidance-audio-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function clipFiles() {
  const folder = join(directory, (await readdir(directory))[0]);
  return (await readdir(folder)).filter(name => name.endsWith(".mp3")).map(name => join(folder, name));
}

it("stores real MP3 bytes and reuses them across process instances", async () => {
  const synthesize = vi.fn(async () => audio);
  await new CompanionGuidanceAudioCache(directory).resolve(scope, text, profile, synthesize);
  const [file] = await clipFiles();
  expect(await readFile(file)).toEqual(Buffer.from(audio.audioBase64, "base64"));
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  const reopened = new CompanionGuidanceAudioCache(directory);
  expect(await reopened.resolve(scope, text, profile, synthesize)).toEqual(audio);
  expect(synthesize).toHaveBeenCalledOnce();
});

it("separates accounts and deployments and regenerates changed narration or Qwen configuration", async () => {
  const cache = new CompanionGuidanceAudioCache(directory), synthesize = vi.fn(async () => audio);
  await cache.resolve(scope, text, profile, synthesize);
  await cache.resolve(scope, text + "再看一句。", profile, synthesize);
  await cache.resolve(scope, text, { ...profile, profileId: "b".repeat(64) }, synthesize);
  await cache.resolve({ ...scope, userId: "00000000-0000-4000-8000-000000000002" }, text, profile, synthesize);
  await cache.resolve({ ...scope, deployment: "https://other.example" }, text, profile, synthesize);
  await cache.resolve(scope, text, profile, synthesize);
  expect(synthesize).toHaveBeenCalledTimes(5);
});

it("repairs a damaged recording instead of repeatedly playing corrupt local bytes", async () => {
  const cache = new CompanionGuidanceAudioCache(directory), synthesize = vi.fn(async () => audio);
  await cache.resolve(scope, text, profile, synthesize);
  const [file] = await clipFiles();
  await writeFile(file, Buffer.from("oops"));
  expect(await cache.resolve(scope, text, profile, synthesize)).toEqual(audio);
  await writeFile(file.replace(/\.mp3$/, ".json"), "{");
  await cache.resolve(scope, text, profile, synthesize);
  expect(synthesize).toHaveBeenCalledTimes(3);
  expect(await cache.resolve(scope, text, profile, synthesize)).toEqual(audio);
  expect(synthesize).toHaveBeenCalledTimes(3);
});

it("coalesces simultaneous requests and keeps speech working if the directory is unwritable", async () => {
  const cache = new CompanionGuidanceAudioCache(directory), synthesize = vi.fn(async () => audio);
  expect(await Promise.all([cache.resolve(scope, text, profile, synthesize), cache.resolve(scope, text, profile, synthesize)])).toEqual([audio, audio]);
  expect(synthesize).toHaveBeenCalledOnce();
  const blocked = join(directory, "a-file"); await writeFile(blocked, "file");
  expect(await new CompanionGuidanceAudioCache(blocked).resolve(scope, text, profile, synthesize)).toEqual(audio);
});

it("retries Qwen after an Edge fallback and never retains failed synthesis", async () => {
  const cache = new CompanionGuidanceAudioCache(directory);
  const synthesize = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...audio, voice: "zh-CN-XiaoxiaoNeural" }).mockResolvedValue(audio);
  await expect(cache.resolve(scope, text, profile, synthesize)).rejects.toThrow("offline");
  await cache.resolve(scope, text, profile, synthesize);
  await cache.resolve(scope, text, profile, synthesize);
  await cache.resolve(scope, text, profile, synthesize);
  expect(synthesize).toHaveBeenCalledTimes(3);
});

it("bounds local recordings while retaining the newly generated chapter", async () => {
  const cache = new CompanionGuidanceAudioCache(directory), synthesize = vi.fn(async () => audio);
  for (let i = 0; i < 65; i++) await cache.resolve(scope, `${text}${i}`, profile, synthesize);
  expect(await clipFiles()).toHaveLength(64);
  await cache.resolve(scope, `${text}64`, profile, synthesize);
  expect(synthesize).toHaveBeenCalledTimes(65);
});

function transport() {
  const gateway = new DesktopGateway({ DESKTOP_API_ORIGIN: scope.deployment,
    AILEARN_DESKTOP_PAIRING_KEY_ID: "desktop-key-1", AILEARN_DESKTOP_PAIRING_SECRET: Buffer.alloc(32, 9).toString("base64url"),
    AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" }, { guidanceAudioCache: new CompanionGuidanceAudioCache(directory) });
  const t = gateway.gatewayTransport;
  t.connection = { version: 1, kind: "ready", schemaRevision: "domain-v2-test" };
  t.credentialRestored = true; t.token = "test-voice-token";
  t.currentSession = { version: 1, status: "authenticated", user: { userId: scope.userId, email: "guide@example.com" },
    workspace: null, membership: null, capabilities: null, workspaceEpoch: 1, credentialPersistence: "memory" };
  return t;
}

it("the real gateway reuses guidance files after restart while ordinary notifications keep their own voice path", async () => {
  let selected = profile;
  const tts = vi.fn(() => new Response(Buffer.from(audio.audioBase64, "base64"), {
    headers: { "Content-Type": "audio/mpeg", "X-Ailearn-Tts-Voice": selected.voice } }));
  const lookup = vi.fn(() => new Response(JSON.stringify(selected)));
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/voice/guidance-profile") return lookup();
    if (path === "/voice/tts") return tts();
    throw new Error(`unexpected ${path}`);
  });
  const request = { version: 1 as const, purpose: "guidance" as const, text };
  await speakCompanionVoice(transport(), request);
  const reopened = transport();
  await speakCompanionVoice(reopened, request);
  await speakCompanionVoice(reopened, request);
  expect(tts).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalledTimes(2);
  await speakCompanionVoice(reopened, { ...request, purpose: "notification" });
  await speakCompanionVoice(reopened, { ...request, purpose: "notification" });
  expect(tts).toHaveBeenCalledTimes(3);
  selected = { ...profile, profileId: "b".repeat(64), voice: "longanlingxi_v3.1" };
  reopened.guidanceVoiceProfile!.at -= 60_001;
  expect((await speakCompanionVoice(reopened, request)).voice).toBe(selected.voice);
  expect(tts).toHaveBeenCalledTimes(4);
});

it("an account change drops a late synthesis before it can be cached or played", async () => {
  let release: ((value: Response) => void) | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (new URL(String(input)).pathname === "/voice/guidance-profile") return new Response(JSON.stringify(profile));
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const t = transport();
  const pending = speakCompanionVoice(t, { version: 1, purpose: "guidance", text });
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await vi.waitFor(() => expect(release).toBeDefined());
  t.currentSession = null; t.token = null;
  release!(new Response(Buffer.from(audio.audioBase64, "base64"), { headers: { "Content-Type": "audio/mpeg", "X-Ailearn-Tts-Voice": profile.voice } }));
  await rejected;
  expect(await readdir(directory)).toEqual([]);
});
