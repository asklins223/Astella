import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCompanionExportFile } from "../companion-export-file";
import { DesktopGatewayFailure } from "../desktop-gateway-failure";

let downloadsPath: string;
const directory = () => join(downloadsPath, "Astella", "伴星");
beforeEach(async () => { downloadsPath = await mkdtemp(join(tmpdir(), "companion-export-")); });
afterEach(async () => { await rm(downloadsPath, { recursive: true, force: true }); });

describe("伴星副本直接保存到下载目录", () => {
  it("完整流写入后才确认，按实际字节数返回，文件仅本人可读写", async () => {
    const text = '{"记忆":"认真思考"}\n{"对话":"你好"}\n';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); controller.close();
    } });
    const beforeCommit = vi.fn();
    const result = await saveCompanionExportFile({ downloadsPath, kind: "all", response: new Response(stream), beforeCommit });
    expect(result).toMatchObject({ saved: true, canceled: false, bytes: bytes.length });
    expect(result.fileName).toMatch(/\.ndjson$/);
    expect(await readFile(join(directory(), result.fileName), "utf8")).toBe(text);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(await readdir(directory())).toEqual([result.fileName]);
    expect((await stat(join(directory(), result.fileName))).mode & 0o777).toBe(0o600);
  });

  it("同一范围重复导出独立命名，记忆和操作记录使用 JSON", async () => {
    const results = await Promise.all(["memory", "memory", "audit"].map(kind => saveCompanionExportFile({
      downloadsPath, kind: kind as "memory" | "audit", response: new Response('{"items":[]}'), beforeCommit: () => {},
    })));
    expect(new Set(results.map(result => result.fileName)).size).toBe(3);
    expect(results.every(result => result.fileName.endsWith(".json"))).toBe(true);
    expect(await readdir(directory())).toHaveLength(3);
  });

  it("流失败不会留下不完整副本，也不会返回保存成功", async () => {
    const beforeCommit = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("partial")); controller.error(new Error("stream failed"));
    } });
    await expect(saveCompanionExportFile({ downloadsPath, kind: "all", response: new Response(stream), beforeCommit })).rejects.toThrow("stream failed");
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(await readdir(directory())).toEqual([]);
  });

  it("写入期间切换书房会清理暂存文件，并保留需要重新同步的错误", async () => {
    const stale = new DesktopGatewayFailure("stale_workspace", "resync_first");
    await expect(saveCompanionExportFile({ downloadsPath, kind: "memory", response: new Response("{}"), beforeCommit: () => { throw stale; } })).rejects.toBe(stale);
    expect(await readdir(directory())).toEqual([]);
  });

  it("目录不能写入时不生成回执或破坏既有文件", async () => {
    await writeFile(join(downloadsPath, "Astella"), "existing file");
    await expect(saveCompanionExportFile({ downloadsPath, kind: "audit", response: new Response("{}"), beforeCommit: () => {} })).rejects.toThrow();
    expect(await readFile(join(downloadsPath, "Astella"), "utf8")).toBe("existing file");
  });
});
