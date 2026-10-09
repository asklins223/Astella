import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES, avatarGetResultV1Schema } from "@astella/shared/desktop-ipc-contracts";
import { createAvatarImageStore, AvatarImageStore } from "../avatar-image-store";
import { getAvatar, uploadAvatar } from "../desktop-gateway-ns-auth";
import type { GatewayTransport } from "../desktop-gateway-transport";

vi.mock("../desktop-object-transfers", () => ({ uploadRemoteObject: vi.fn(async () => null) }));
const userId = "11111111-1111-4111-8111-111111111111";
const objectKey = `avatars/${userId}/22222222-2222-4222-8222-222222222222.png`;
const directories: string[] = [];
const bytes = Buffer.from("avatar-image");
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "avatar-cache-test-"));
  directories.push(directory);
  createAvatarImageStore(directory);
  const requestBinaryBytes = vi.fn(async () => ({ contentType: "image/png", bytes }));
  const transport = {
    token: "test-token", configuration: { config: { apiOrigin: "https://api.example.test" } },
    currentSession: { status: "authenticated", user: { userId } },
    ensureConnected: vi.fn(async () => undefined), requestBinaryBytes, activeRequests: new Map(),
  } as unknown as GatewayTransport;
  return { directory, transport, requestBinaryBytes };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("头像本地缓存与读取", () => {
  it("重复读取和重启复用磁盘字节，头像换对象键时读取新图片", async () => {
    const { directory, transport, requestBinaryBytes } = await setup();
    await getAvatar(transport, objectKey);
    createAvatarImageStore(directory);
    expect((await getAvatar(transport, objectKey)).imageBase64).toBe(bytes.toString("base64"));
    expect(requestBinaryBytes).toHaveBeenCalledOnce();
    await getAvatar(transport, objectKey.replace("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"));
    expect(requestBinaryBytes).toHaveBeenCalledTimes(2);
  });
  it("缓存命中仍检查本人归属，切账号不会取到旧头像", async () => {
    const { transport, requestBinaryBytes } = await setup();
    await getAvatar(transport, objectKey);
    transport.currentSession = { status: "authenticated", user: { userId: "another-user" } } as GatewayTransport["currentSession"];
    await expect(getAvatar(transport, objectKey)).rejects.toMatchObject({ code: "not_found" });
    expect(requestBinaryBytes).toHaveBeenCalledOnce();
  });
  it("10 MB 的头像可读取，读取期间切账号不返回也不缓存迟到字节", async () => {
    const { directory, transport, requestBinaryBytes } = await setup();
    requestBinaryBytes.mockResolvedValueOnce({ contentType: "image/png", bytes: Buffer.alloc(AVATAR_MAX_BYTES) });
    expect((await getAvatar(transport, objectKey)).byteLength).toBe(AVATAR_MAX_BYTES);
    expect(avatarGetResultV1Schema.safeParse({ version: 1, mimeType: "image/png", imageBase64: "AA==", byteLength: AVATAR_MAX_BYTES + 1 }).success).toBe(false);
    const nextKey = objectKey.replace("22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444");
    requestBinaryBytes.mockImplementationOnce(async () => { transport.token = "new-token"; return { contentType: "image/png", bytes }; });
    await expect(getAvatar(transport, nextKey)).rejects.toMatchObject({ code: "stale_workspace" });
    const load = vi.fn(async () => ({ bytes, mime: "image/png" }));
    await new AvatarImageStore(directory).get(JSON.stringify(["https://api.example.test", userId]), nextKey, load);
    expect(load).toHaveBeenCalledOnce();
  });
  it("上传成功直接写缓存，超过 10 MB 在发上传请求前拒绝", async () => {
    const { transport, requestBinaryBytes } = await setup();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: `/api/uploads/${objectKey}`, objectKey }), { status: 201 }));
    await uploadAvatar(transport, { fileName: "avatar.png", mimeType: "image/png", bytesBase64: bytes.toString("base64") });
    expect((await getAvatar(transport, objectKey)).imageBase64).toBe(bytes.toString("base64"));
    expect(requestBinaryBytes).not.toHaveBeenCalled();
    await expect(uploadAvatar(transport, { fileName: "large.png", mimeType: "image/png", bytesBase64: Buffer.alloc(AVATAR_MAX_BYTES + 1).toString("base64") })).rejects.toMatchObject({ code: "validation" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
