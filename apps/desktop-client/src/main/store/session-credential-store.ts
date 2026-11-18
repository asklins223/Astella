import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app, safeStorage } from "electron";
import { rememberedDesktopAccountV1Schema } from "@astella/shared/desktop-ipc-contracts";
import type { SessionCredentialStore } from "../gateway/desktop-gateway-credentials";

const ENCRYPTED_PREFIX = "astella-safe-storage-v1:";

function requireSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()))) {
    throw new Error("Secure credential storage is unavailable");
  }
}

function encrypt(value: string): string {
  requireSecureStorage();
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString("base64");
}

function decrypt(value: string): string {
  requireSecureStorage();
  return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
}

/** Persist bearer tokens using the platform credential encryption service. */
export function createSessionCredentialStore(): SessionCredentialStore {
  const filePath = resolve(app.getPath("userData"), "session-credential-local-v1.txt");
  const temporaryPath = `${filePath}.tmp`;
  const rememberedPath = resolve(app.getPath("userData"), "quick-login-account-v1.json");

  async function writeEncrypted(path: string, value: string): Promise<void> {
    const ciphertext = encrypt(value);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, ciphertext, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async function readAndMigrate(path: string): Promise<string | null> {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null || !raw.trim()) return null;
    if (raw.startsWith(ENCRYPTED_PREFIX)) return decrypt(raw);
    // Migrate only after encryption and atomic replacement succeed. On failure
    // retain the legacy file so a temporary keychain outage cannot erase it.
    await writeEncrypted(path, raw);
    return raw;
  }

  return {
    async loadRemembered() {
      try {
        const value = await readAndMigrate(rememberedPath);
        if (!value) return null;
        const raw = JSON.parse(value);
        const { origin, token, ...hint } = raw;
        const parsed = rememberedDesktopAccountV1Schema.safeParse(hint);
        if (!parsed.success || typeof origin !== "string" || !/^https?:\/\//.test(origin)
          || typeof token !== "string" || !token.trim()) return null;
        return { ...parsed.data, origin, token };
      } catch { return null; }
    },
    async saveRemembered(credential) {
      await writeEncrypted(rememberedPath, JSON.stringify(credential));
    },
    async clearRemembered() {
      await Promise.all([rm(rememberedPath, { force: true }), rm(`${rememberedPath}.tmp`, { force: true })]);
    },
    hasStored(): boolean {
      return existsSync(filePath);
    },

    async load(): Promise<string | null> {
      // 读不出来就当没有：文件坏了由服务端那道 401 去作废它，而不是在这里删掉，
      // 一次偶发的读取失败不该让人重登。
      const token = await readAndMigrate(filePath).catch(() => null);
      return token && token.trim() ? token.trim() : null;
    },

    async save(token: string): Promise<void> {
      await writeEncrypted(filePath, token);
    },

    async clear(): Promise<void> {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(temporaryPath, { force: true }),
      ]).catch(() => undefined);
    },
  };
}
