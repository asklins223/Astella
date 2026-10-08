import { describe, expect, it, vi } from "vitest";
import { configureDesktopAppIdentity } from "../desktop-app-identity";

describe("desktop app Keychain identity", () => {
  it("gives the installed app its own name before ready while retaining the existing profile", () => {
    let name = "astella-desktop-client";
    let profile = "/existing/astella-desktop-client";
    const app = {
      isPackaged: true,
      getPath: vi.fn(() => profile),
      setName: vi.fn((next: string) => {
        name = next;
        profile = `/default/${next}`;
      }),
      setPath: vi.fn((_path: string, next: string) => { profile = next; }),
    };

    configureDesktopAppIdentity(app, "darwin");

    expect(name).toBe("Astella");
    expect(profile).toBe("/existing/astella-desktop-client");
    expect(app.getPath).toHaveBeenCalledWith("userData");
    expect(app.setPath).toHaveBeenCalledWith("userData", "/existing/astella-desktop-client");
  });

  it("keeps development's existing name and profile", () => {
    const app = {
      isPackaged: false,
      getPath: vi.fn(),
      setName: vi.fn(),
      setPath: vi.fn(),
    };
    configureDesktopAppIdentity(app, "darwin");
    expect(app.getPath).not.toHaveBeenCalled();
    expect(app.setName).not.toHaveBeenCalled();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("retains the existing %s encryption identity", (platform) => {
    const app = { isPackaged: true, getPath: vi.fn(), setName: vi.fn(), setPath: vi.fn() };
    configureDesktopAppIdentity(app, platform);
    expect(app.setName).not.toHaveBeenCalled();
    expect(app.getPath).not.toHaveBeenCalled();
  });
});
