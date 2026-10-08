import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));
vi.mock("electron", () => electron);

import { createSessionCredentialStore } from "../session-credential-store";

describe("session credential storage", () => {
  let directory: string;
  const filename = () => process.platform === "darwin" && electron.app.isPackaged
    ? "session-credential-packaged-v2.bin" : "session-credential-v1.bin";
  const ciphertext = Buffer.from("encrypted fixture, not a bearer token");

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), "astella-session-test-"));
    electron.app.isPackaged = true;
    electron.app.getPath.mockReturnValue(directory);
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    electron.safeStorage.encryptString.mockReturnValue(ciphertext);
    electron.safeStorage.decryptString.mockReturnValue("test-session-token");
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("does not touch Keychain during boot, runtime snapshots, or loading an absent credential", async () => {
    const store = createSessionCredentialStore();
    expect(store.available).toBe(true);
    expect(store.hasStored()).toBe(false);
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(electron.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(electron.safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")("ignores development's old encrypted session in an installed app", async () => {
    await writeFile(join(directory, "session-credential-v1.bin"), ciphertext);
    const installed = createSessionCredentialStore();
    expect(installed.hasStored()).toBe(false);
    expect(await installed.load()).toBeNull();
    await installed.clear();
    expect(electron.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "session-credential-v1.bin"))).toEqual(ciphertext);

    electron.app.isPackaged = false;
    const development = createSessionCredentialStore();
    expect(development.hasStored()).toBe(true);
    expect(await development.load()).toBe("test-session-token");
  });

  it("encrypts an explicitly remembered session and restores it after a restart", async () => {
    const store = createSessionCredentialStore();
    await store.save("test-session-token");
    expect(await readFile(join(directory, filename()))).toEqual(ciphertext);
    expect((await stat(join(directory, filename()))).mode & 0o777).toBe(0o600);
    expect(electron.safeStorage.encryptString).toHaveBeenCalledWith("test-session-token");
    expect(await createSessionCredentialStore().load()).toBe("test-session-token");
    await store.clear();
    expect(store.hasStored()).toBe(false);
  });

  it("fails closed after access is denied and does not retry Keychain during this launch", async () => {
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const store = createSessionCredentialStore();
    await expect(store.save("test-session-token")).rejects.toThrow("Session encryption unavailable");
    expect(store.available).toBe(false);
    expect(store.hasStored()).toBe(false);
    await expect(store.save("test-session-token")).rejects.toThrow();
    expect(electron.safeStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled();
    await expect(stat(join(directory, filename()))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an encrypted session when Keychain is temporarily unavailable", async () => {
    await writeFile(join(directory, filename()), ciphertext);
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const store = createSessionCredentialStore();
    expect(await store.load()).toBeNull();
    expect(await readFile(join(directory, filename()))).toEqual(ciphertext);
    expect(electron.safeStorage.decryptString).not.toHaveBeenCalled();
    await store.clear();
    await expect(stat(join(directory, filename()))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops corrupted credentials so they are not repeatedly decrypted on startup", async () => {
    await writeFile(join(directory, filename()), ciphertext);
    electron.safeStorage.decryptString.mockImplementation(() => { throw new Error("Bad ciphertext"); });
    const store = createSessionCredentialStore();
    expect(await store.load()).toBeNull();
    expect(store.hasStored()).toBe(false);
    expect(await store.load()).toBeNull();
    expect(electron.safeStorage.decryptString).toHaveBeenCalledTimes(1);
  });
});
