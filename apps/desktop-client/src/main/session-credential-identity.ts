import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Keychain identifies ad-hoc builds by their code hash even when ShipIt uses
 * a stable designated requirement. Inspecting the signature never opens it. */
export function sessionCredentialSigningIdentity(details: string): string | null {
  const id = /^Identifier=(.+)$/m.exec(details)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1];
  if (!id) return null;
  if (/^Authority=Developer ID Application:/m.test(details) && team && team !== "not set") return `developer-id:${team}:${id}`;
  const hash = /^CDHash=([a-f\d]+)$/m.exec(details)?.[1];
  return /^Signature=adhoc$/m.test(details) && hash ? `adhoc:${id}:${hash}` : null;
}

export async function readSessionCredentialSigningIdentity(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execute("/usr/bin/codesign", ["--display", "--verbose=4", process.execPath], { timeout: 5000 });
    return sessionCredentialSigningIdentity(`${stdout}${stderr}`);
  } catch { return null; }
}
