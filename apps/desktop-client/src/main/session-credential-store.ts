import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app, safeStorage } from "electron";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";
import { readSessionCredentialSigningIdentity } from "./session-credential-identity";

/**
 * Persists the bearer token between launches, encrypted with Electron's
 * `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 *
 * Availability is checked only when reading an existing credential or saving
 * an explicitly remembered session. Even isEncryptionAvailable() can prompt on
 * macOS, so constructing the store and taking runtime snapshots must not call it.
 * Encryption failure keeps the session in memory; plaintext is never written.
 */
export function createSessionCredentialStore(): SessionCredentialStore {
  const guardedMac = process.platform === "darwin" && app.isPackaged;
  // The old macOS file belongs to the development Electron's Keychain key.
  // It cannot be decrypted with the installed app's independent Astella key.
  // Leave it for development; the installed app signs in once to create v2.
  const filename = process.platform === "darwin" && app.isPackaged
    ? "session-credential-packaged-v2.bin"
    : "session-credential-v1.bin";
  const filePath = resolve(app.getPath("userData"), filename);
  const temporaryPath = `${filePath}.tmp`;
  const identityPath = `${filePath}.identity.json`;
  let signingIdentity: Promise<string | null> | undefined;
  const identity = () => signingIdentity ??= readSessionCredentialSigningIdentity();

  async function rememberIdentity(access: "allowed" | "denied") {
    if (!guardedMac) return;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(identityPath, JSON.stringify({ version: 1, identity: await identity(), access }), { mode: 0o600 });
  }

  let encryptionAvailable: boolean | undefined;
  function checkEncryptionAvailable(): boolean {
    if (encryptionAvailable !== undefined) return encryptionAvailable;
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch {
      encryptionAvailable = false;
    }
    return encryptionAvailable;
  }

  return {
    get available(): boolean {
      return encryptionAvailable !== false;
    },

    hasStored(): boolean {
      return encryptionAvailable !== false && existsSync(filePath);
    },

    async load(): Promise<string | null> {
      let encrypted: Buffer;
      try {
        encrypted = await readFile(filePath);
      } catch {
        return null;
      }
      if (guardedMac) {
        const current = await identity();
        let stored: { identity?: string; access?: string } | null = null;
        try { stored = JSON.parse(await readFile(identityPath, "utf8")); } catch { /* pre-guard credential */ }
        // An old ad-hoc build's grant cannot authorize this build. Never touch
        // Keychain silently to discover that fact on every launch.
        if (!current || stored?.access === "denied" || stored && stored.identity !== current
          || !stored && current.startsWith("adhoc:")) return null;
      }
      if (!checkEncryptionAvailable()) {
        await rememberIdentity("denied").catch(() => undefined);
        return null;
      }
      try {
        const token = safeStorage.decryptString(encrypted);
        return token.trim() ? token : null;
      } catch {
        // A credential we cannot decrypt is useless and must not be retried on
        // every launch; drop it so the user simply signs in again.
        await rm(filePath, { force: true }).catch(() => undefined);
        await rememberIdentity("denied").catch(() => undefined);
        return null;
      }
    },

    async save(token: string): Promise<void> {
      // Throw rather than report a successful save when no encrypted file was
      // written; GatewayTransport then correctly keeps persistence in memory.
      if (!checkEncryptionAvailable()) throw new Error("Session encryption unavailable");
      const encrypted = safeStorage.encryptString(token);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, filePath);
      await rememberIdentity("allowed");
    },

    async clear(): Promise<void> {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(temporaryPath, { force: true }),
        rm(identityPath, { force: true }),
      ]).catch(() => undefined);
    },
  };
}
