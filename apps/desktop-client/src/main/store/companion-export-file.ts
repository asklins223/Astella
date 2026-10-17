import type { CompanionExportKindV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Stream into a private temporary file; publish the receipt only after scope and write checks. */
export async function saveCompanionExportFile(input: {
  downloadsPath: string;
  kind: CompanionExportKindV1;
  response: Response;
  beforeCommit: () => void;
}) {
  const date = new Date().toISOString().slice(0, 10);
  const directory = join(input.downloadsPath, "Astella", "伴星");
  const suffix = randomBytes(6).toString("hex");
  const fileName = input.kind === "all" ? `astella-companion-${date}-${suffix}.ndjson`
    : `astella-companion-${input.kind}-${date}-${suffix}.json`;
  const filePath = join(directory, fileName);
  const partialPath = `${filePath}.partial`;
  try {
    await mkdir(directory, { recursive: true });
    await pipeline(Readable.fromWeb(input.response.body as never), createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
    input.beforeCommit();
    await rename(partialPath, filePath);
    const saved = await stat(filePath);
    return { version: 1 as const, saved: true, canceled: false, fileName, bytes: saved.size };
  } catch (cause) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}
