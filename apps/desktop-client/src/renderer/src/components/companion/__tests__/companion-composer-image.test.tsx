// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  noteImageUploadFailureMessage,
} from "@astella/shared/note-image-upload-contracts";
import {
  RendererGatewayError,
  gatewayErrorMessage,
} from "../../../app/desktop-client";
import { formatComposerImageLabel, useCompanionImageAttachment } from "../companion-composer-image";

const uploadImage = vi.hoisted(() => vi.fn());
vi.mock("../../../app/desktop-client", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../app/desktop-client")>()),
  requireWorkspaceEpoch: async () => 7,
  createRequestMeta: () => ({}),
  unwrapGatewayResult: (value: unknown) => value,
}));

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const uploadedUrl = `/api/uploads/${WORKSPACE}/companion/${ASSET}.png`;

/** `\x89PNG` 四个**字节**（用字符串构造会被按 UTF-8 编码成 5 个字节）。 */
function png(name = "截屏 2026-10-06.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

/** 挂载钩子并跑完一次 `pick`，返回可直接读最新状态的 ref。 */
async function picked(file: File) {
  const view = renderHook(() => useCompanionImageAttachment());
  await act(async () => { await view.result.current.pick(file); });
  return view.result;
}

beforeEach(() => {
  uploadImage.mockReset();
  Object.defineProperty(window, "astella", {
    configurable: true,
    value: { companion: { uploadImage } },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("本地校验先挡住：类型与体积不符都不碰网关", async () => {
  const svg = await picked(new File(["<svg/>"], "图标.svg", { type: "image/svg+xml" }));
  expect(svg.current.error).toBe(noteImageUploadFailureMessage({ httpStatus: 415 }));
  expect(svg.current.image).toBeNull();
  expect(uploadImage).not.toHaveBeenCalled();

  const tooBig = png("大图.png");
  Object.defineProperty(tooBig, "size", { value: NOTE_IMAGE_UPLOAD_MAX_BYTES + 1 });
  const over = await picked(tooBig);
  expect(over.current.error).toBe(noteImageUploadFailureMessage({ httpStatus: 413 }));
  expect(uploadImage).not.toHaveBeenCalled();
});

it("上传成功后附件就是回执里的站内地址，图名取文件名", async () => {
  uploadImage.mockResolvedValue({
    version: 1, url: uploadedUrl, byteLength: 4, mimeType: "image/png", width: 2, height: 2,
  });
  const state = await picked(png());
  expect(state.current.uploading).toBe(false);
  expect(state.current.error).toBeNull();
  expect(state.current.image).toEqual({ url: uploadedUrl, label: "截屏 2026-10-06" });
  const input = uploadImage.mock.calls[0]?.[0] as {
    request: { fileName: string; mimeType: string; bytesBase64: string };
  };
  expect(input?.request.mimeType).toBe("image/png");
  expect(atob(input.request.bytesBase64)).toBe("\x89PNG");
});

it("失败按状态码与网关 code 分别给得出路", async () => {
  uploadImage.mockRejectedValueOnce(new RendererGatewayError({
    code: "rate_limited", safeMessageKey: "error.rate_limited", retry: "safe_retry", httpStatus: 429,
  }));
  expect((await picked(png())).current.error).toBe(noteImageUploadFailureMessage({ httpStatus: 429 }));

  const unavailable = new RendererGatewayError({
    code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "safe_retry",
  });
  uploadImage.mockRejectedValueOnce(unavailable);
  expect((await picked(png())).current.error).toBe(gatewayErrorMessage(unavailable));

  // 连网关都没碰到（读文件、编码这类本机失败）不该冒充"服务返回的结果"。
  uploadImage.mockRejectedValueOnce(new Error("boom"));
  const local = await picked(png());
  expect(local.current.error).toBe(noteImageUploadFailureMessage({}));
  expect(local.current.uploading).toBe(false);
});

it("移除或发送后清干净，失败的那张可以原样重试", async () => {
  uploadImage.mockResolvedValue({
    version: 1, url: uploadedUrl, byteLength: 4, mimeType: "image/png", width: 2, height: 2,
  });
  const state = await picked(png());
  expect(state.current.image?.url).toBe(uploadedUrl);
  act(() => { state.current.clear(); });
  expect(state.current.image).toBeNull();
  expect(state.current.error).toBeNull();

  uploadImage.mockRejectedValueOnce(new Error("boom"));
  await act(async () => { await state.current.pick(png("另一张.png")); });
  expect(state.current.image).toBeNull();
  expect(state.current.error).toBe(noteImageUploadFailureMessage({}));

  uploadImage.mockResolvedValueOnce({
    version: 1, url: uploadedUrl, byteLength: 4, mimeType: "image/png", width: 2, height: 2,
  });
  await act(async () => { await state.current.pick(png("另一张.png")); });
  expect(state.current.image?.label).toBe("另一张");
  expect(state.current.error).toBeNull();
});

it("图名用文件名去扩展名，过长时截断", () => {
  expect(formatComposerImageLabel("截屏 2026-10-06.png")).toBe("截屏 2026-10-06");
  expect(formatComposerImageLabel("无扩展名")).toBe("无扩展名");
  expect(formatComposerImageLabel("   ")).toBe("图片");
  expect(formatComposerImageLabel("一".repeat(40))).toBe(`${"一".repeat(24)}…`);
});
