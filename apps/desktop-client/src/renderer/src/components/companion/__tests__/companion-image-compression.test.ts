// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { prepareCompanionUploadImage } from "../content/companion-image-compression.ts";
import { COMPANION_IMAGE_UPLOAD_TARGET_BYTES_V1 as limit } from "@astella/shared/companion-conversation-contracts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("小图保留原始字节，大图在上传之前自动编码且释放解码资源", async () => {
  const small = new File(["small"], "原图.png", { type: "image/png" });
  expect(await prepareCompanionUploadImage(small)).toBe(small);
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 5000, height: 4000, close }));
  vi.stubGlobal("createImageBitmap", decode);
  const draw = vi.fn(), fill = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage: draw, fillRect: fill })) as unknown as HTMLCanvasElement["getContext"]);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(callback) {
    callback(new Blob([new Uint8Array(2_000_000)], { type: "image/jpeg" }));
  });
  const large = new File([new Uint8Array(limit + 1)], "高分辨率.png", { type: "image/png" });
  const prepared = await prepareCompanionUploadImage(large);
  expect(prepared.size).toBeLessThanOrEqual(limit);
  expect(prepared.type).toBe("image/jpeg");
  expect(prepared.name).toBe("高分辨率.jpg");
  expect(canvas).toHaveBeenCalledTimes(1);
  expect(draw.mock.calls[0]?.slice(1)).toEqual([0, 0, 4096, 3276]);
  expect(close).toHaveBeenCalledOnce();
});

it("质量调节仍过大时自动缩小尺寸，失败也释放位图", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1000, height: 1000, close }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage() {}, fillRect() {} })) as unknown as HTMLCanvasElement["getContext"]);
  let calls = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(callback) {
    calls++; callback(new Blob([new Uint8Array(calls <= 4 ? limit + 1 : 1000)], { type: "image/jpeg" }));
  });
  const large = new File([new Uint8Array(limit + 1)], "photo.png", { type: "image/png" });
  expect((await prepareCompanionUploadImage(large)).size).toBe(1000);
  expect(calls).toBe(5);
  expect(close).toHaveBeenCalledOnce();
});
