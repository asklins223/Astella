import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app } from "electron";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";

/**
 * 登录凭据存在 userData 下一个 0600 的本地文件里，不经过钥匙串。
 *
 * 这是 2026-10-09 的用户裁决：登录态必须无感。Electron 的 `safeStorage` 在临时签名
 * 的构建上每次都要重新授权，拒一次就把这次会话降级成「只在此有效」，还会连已有凭据
 * 一起作废。同一个目录里笔记正文、语音与导出本来就是明文，token 单独进钥匙串并没有
 * 改变实际的威胁模型。
 */
export function createSessionCredentialStore(): SessionCredentialStore {
  const filePath = resolve(app.getPath("userData"), "session-credential-local-v1.txt");
  const temporaryPath = `${filePath}.tmp`;

  return {
    hasStored(): boolean {
      return existsSync(filePath);
    },

    async load(): Promise<string | null> {
      // 读不出来就当没有：文件坏了由服务端那道 401 去作废它，而不是在这里删掉，
      // 一次偶发的读取失败不该让人重登。
      const token = await readFile(filePath, "utf8").catch(() => null);
      return token && token.trim() ? token.trim() : null;
    },

    async save(token: string): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, token, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    },

    async clear(): Promise<void> {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(temporaryPath, { force: true }),
      ]).catch(() => undefined);
    },
  };
}
