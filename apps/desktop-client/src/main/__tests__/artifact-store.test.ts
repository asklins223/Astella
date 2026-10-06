/**
 * 产物落盘口的三条硬约定（39d W4-6 刀五；D4 §6、§8）：幂等、整份、不静默。
 *
 * 这一层是"谁写 `<userData>/artifacts/<id>.html`"的产品实现，读侧是 `index.ts` 的
 * `artifactSourcePath`。测试全部对着临时目录与假取件函数跑，不碰 Electron、不碰网络。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_MAX_BYTES } from "../artifact-surface";
import { ArtifactStoreFailure, ensureArtifactStored, type ArtifactStoreDeps } from "../artifact-store";
import { DesktopGatewayFailure } from "../desktop-gateway-failure";

let userDataDir: string;
let artifactId: string;

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "astella-artifact-store-"));
  artifactId = randomUUID();
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** 落点与 `index.ts` 读侧同一个路径：`<userData>/artifacts/<id>.html`。 */
function targetPath(): string {
  return resolve(userDataDir, "artifacts", `${artifactId}.html`);
}

/** 目录里还剩什么。目录不存在按"空"读——"一个字节都没落"正是要断言的形状之一。 */
async function artifactDirEntries(): Promise<string[]> {
  try {
    return await readdir(resolve(userDataDir, "artifacts"));
  } catch {
    return [];
  }
}

function deps(fetchArtifactHtml: ArtifactStoreDeps["fetchArtifactHtml"]): ArtifactStoreDeps {
  return { userDataDir, fetchArtifactHtml };
}

describe("ensureArtifactStored", () => {
  it("盘上已有 ⇒ stored:false，不重新下载，字节数是盘上真数", async () => {
    const onDisk = "<html><body>已经在了</body></html>";
    await mkdir(resolve(userDataDir, "artifacts"), { recursive: true });
    await writeFile(targetPath(), onDisk, "utf8");

    const fetchArtifactHtml = vi.fn(async () => "<html>不该被取</html>");
    const result = await ensureArtifactStored({ artifactId }, deps(fetchArtifactHtml));

    expect(result).toEqual({ stored: false, bytes: Buffer.byteLength(onDisk, "utf8") });
    // 幂等这条约定最关键的一半：网络一次都不该被碰。
    expect(fetchArtifactHtml).not.toHaveBeenCalled();
  });

  it("盘上没有 ⇒ stored:true，整份写进 <userData>/artifacts/<id>.html，字节数与 UTF-8 长度一致", async () => {
    // 带多字节字符：`bytes` 必须是 UTF-8 字节数，不是 JS 字符串长度。
    const html = "<html><body><p>动态讲解 · 第一步</p><script>void 0</script></body></html>";
    const fetchArtifactHtml = vi.fn(async () => html);

    const result = await ensureArtifactStored({ artifactId }, deps(fetchArtifactHtml));

    expect(result).toEqual({ stored: true, bytes: Buffer.byteLength(html, "utf8") });
    expect(fetchArtifactHtml).toHaveBeenCalledWith(artifactId, undefined);
    const written = await readFile(targetPath());
    // 逐字节相同：落盘不许做任何转码或改写。
    expect(written.equals(Buffer.from(html, "utf8"))).toBe(true);
  });

  it("fetch 回超配额 ⇒ 整份拒绝：抛错、不落盘、目录里不留 .tmp-*", async () => {
    const oversize = "a".repeat(ARTIFACT_MAX_BYTES + 1);
    const fetchArtifactHtml = vi.fn(async () => oversize);

    const failure = await ensureArtifactStored({ artifactId }, deps(fetchArtifactHtml)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactStoreFailure);
    expect((failure as ArtifactStoreFailure).code).toBe("unsupported_contract");
    expect((failure as ArtifactStoreFailure).detail).toContain("配额");
    // 半份 HTML 在 frame 里只会画成怪东西；临时名也不许留下（写一半的产物会被误读）。
    expect(await artifactDirEntries()).toEqual([]);
  });

  it("id 形状不对 ⇒ validation，且一个文件都不落（路径安全靠这一条）", async () => {
    const fetchArtifactHtml = vi.fn(async () => "<html>不该被取</html>");

    for (const badId of ["不是个 uuid", `../${artifactId}`, `${artifactId}/../x`]) {
      const failure = await ensureArtifactStored({ artifactId: badId }, deps(fetchArtifactHtml)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ArtifactStoreFailure);
      expect((failure as ArtifactStoreFailure).code).toBe("validation");
    }
    expect(fetchArtifactHtml).not.toHaveBeenCalled();
    expect(await artifactDirEntries()).toEqual([]);
  });

  it("落点被目录占用 ⇒ safe_internal_error（不当成'已经在了'，也不去取件）", async () => {
    await mkdir(targetPath(), { recursive: true });
    const fetchArtifactHtml = vi.fn(async () => "<html>不该被取</html>");

    const failure = await ensureArtifactStored({ artifactId }, deps(fetchArtifactHtml)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactStoreFailure);
    expect((failure as ArtifactStoreFailure).code).toBe("safe_internal_error");
    expect(fetchArtifactHtml).not.toHaveBeenCalled();
  });

  it("fetch 抛错 ⇒ 原样向上抛，绝不折成 stored:false", async () => {
    const networkFailure = new DesktopGatewayFailure("not_found", "never");
    const fetchArtifactHtml = vi.fn(async () => {
      throw networkFailure;
    });

    // 同一个错误实例往上走：调用方（IPC 层）要看见 `code`，而不是一句"没落下来"。
    await expect(ensureArtifactStored({ artifactId }, deps(fetchArtifactHtml))).rejects.toBe(networkFailure);
    expect(await artifactDirEntries()).toEqual([]);
    // 落点此刻确实不存在——若实现把失败折成 `stored:false`，界面会把它读成"已经在了"。
    await expect(stat(targetPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
