import type { App } from "electron";

/** Set before ready: Chromium uses the app name to select its Keychain item. */
export function configureDesktopAppIdentity(
  app: Pick<App, "isPackaged" | "getPath" | "setPath" | "setName">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!app.isPackaged || platform !== "darwin") return;

  // Keep the existing profile (including an explicit --user-data-dir). The
  // installed app must not borrow the development Electron's Safe Storage key.
  const userData = app.getPath("userData");
  app.setName("Astella");
  app.setPath("userData", userData);
}
