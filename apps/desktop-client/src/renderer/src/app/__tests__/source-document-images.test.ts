// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ epoch: 9, upload: vi.fn() }));
vi.mock("../desktop-client", () => ({ createRequestMeta: () => ({ workspaceEpoch: state.epoch }), getCurrentWorkspaceEpoch: () => state.epoch,
  unwrapGatewayResult: (result: { data: unknown; ok: boolean }) => { if (!result.ok) throw new Error("upload failed"); return result.data; }, gatewayErrorMessage: (error: Error) => error.message }));
import { createDocumentImageImporter } from "../source-document-images";
beforeEach(() => { state.epoch = 9; state.upload.mockReset().mockResolvedValue({ ok: true, data: { url: "/api/uploads/confirmed" } });
  vi.stubGlobal("crypto", webcrypto); window.astella = { source: { uploadImage: state.upload } } as unknown as typeof window.astella; });
it("identical embedded images upload once and only confirmed URLs enter the document", async () => {
  const importer = createDocumentImageImporter(), bytes = new Uint8Array([1, 2, 3]);
  expect(await importer.importImage(bytes, "image/png", "A")).toBe("/api/uploads/confirmed");
  expect(await importer.importImage(bytes, "image/png", "B")).toBe("/api/uploads/confirmed");
  expect(state.upload).toHaveBeenCalledOnce(); expect(importer.uploaded).toBe(1);
});
it("unsupported and failed images return a visible reason without aborting text import", async () => {
  const importer = createDocumentImageImporter();
  expect(await importer.importImage(new Uint8Array([1]), "image/tiff", "图1")).toBeNull();
  state.upload.mockRejectedValueOnce(new Error("network failed"));
  expect(await importer.importImage(new Uint8Array([2]), "image/png", "图2")).toBeNull();
  expect(importer.warnings.join("\n")).toContain("图1"); expect(importer.warnings.join("\n")).toContain("network failed");
});
it("a workspace switch stops subsequent uploads", async () => {
  const importer = createDocumentImageImporter(); state.epoch = 10;
  await expect(importer.importImage(new Uint8Array([1]), "image/png", "图")).rejects.toThrow("空间已经切换");
  expect(state.upload).not.toHaveBeenCalled();
});
