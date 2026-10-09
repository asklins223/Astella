import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn() },
}));
vi.mock("electron", () => electron);

import { createSessionCredentialStore } from "../session-credential-store";

const filename = "session-credential-local-v1.txt";

describe("session credential storage", () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), "astella-session-test-"));
    electron.app.isPackaged = true;
    electron.app.getPath.mockReturnValue(directory);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("keeps the session across a restart without asking the system for anything", async () => {
    const store = createSessionCredentialStore();
    await store.save("test-session-token");

    expect((await readFile(join(directory, filename), "utf8"))).toBe("test-session-token");
    expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o600);

    const restarted = createSessionCredentialStore();
    expect(restarted.hasStored()).toBe(true);
    await expect(restarted.load()).resolves.toBe("test-session-token");
    expect(await readFile(join(directory, filename), "utf8")).toBe("test-session-token");
  });

  it("reports nothing stored until a credential is saved", async () => {
    const store = createSessionCredentialStore();
    expect(store.hasStored()).toBe(false);
    await expect(store.load()).resolves.toBeNull();
  });

  it("treats a blank credential as absent", async () => {
    await writeFile(join(directory, filename), "   \n", "utf8");
    await expect(createSessionCredentialStore().load()).resolves.toBeNull();
  });

  it("keeps a credential it cannot make sense of for the server to reject", async () => {
    // 一次偶发的读取问题不该让人重登，更不该把还可能是好的凭据删掉。
    await writeFile(join(directory, filename), "not-a-token-from-this-app", "utf8");
    const store = createSessionCredentialStore();
    await expect(store.load()).resolves.toBe("not-a-token-from-this-app");
    await expect(stat(join(directory, filename))).resolves.toBeTruthy();
  });

  it("throws when the write cannot land, so the caller keeps the session in memory", async () => {
    electron.app.getPath.mockReturnValue(join("/no-such-root-astella-test", directory));
    const store = createSessionCredentialStore();
    await expect(store.save("test-session-token")).rejects.toThrow();
  });

  it("clears the credential without leaving a partial write behind", async () => {
    const store = createSessionCredentialStore();
    await store.save("test-session-token");
    await writeFile(join(directory, `${filename}.tmp`), "stale", "utf8");
    await store.clear();

    expect(store.hasStored()).toBe(false);
    await expect(readFile(join(directory, filename), "utf8")).rejects.toThrow();
    await expect(readFile(join(directory, `${filename}.tmp`), "utf8")).rejects.toThrow();
  });

  it("replaces the remembered credential when a different account signs in", async () => {
    const store = createSessionCredentialStore();
    await store.save("first-account-token");
    await store.save("second-account-token");
    await expect(createSessionCredentialStore().load()).resolves.toBe("second-account-token");
  });
});
