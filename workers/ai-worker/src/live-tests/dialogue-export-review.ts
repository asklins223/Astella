import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDialogueReviewPacket, type DialogueReviewSample } from "./dialogue-review-packet.ts";
import { mkdirSync, writeFileSync } from "node:fs";

// Offline: no acceptance-common import, credential loading or network gate.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dir = `${root}outputs/audits/2026-10-07-live`;
const suffix = process.argv[2];
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Pass the matrix suffix");
const source = JSON.parse(readFileSync(`${dir}/dialogue-matrix-${suffix}.json`, "utf8"));
if (!Array.isArray(source.results)) throw new Error("Invalid matrix");
const samples: DialogueReviewSample[] = source.results.map((r: DialogueReviewSample) => ({
  caseId: r.caseId, repeat: r.repeat, condition: r.condition, answer: r.answer ?? "", structuralOk: r.structuralOk,
}));
const { packet, key } = buildDialogueReviewPacket(samples);
const publicFile = `${dir}/dialogue-review-${suffix}.json`, keyFile = `${dir}/dialogue-review-${suffix}-mapping.json`;
if ([publicFile, keyFile].some(existsSync)) throw new Error("Refusing to overwrite review materials");
mkdirSync(dir, { recursive: true });
writeFileSync(publicFile, JSON.stringify(packet, null, 2), { flag: "wx" });
writeFileSync(keyFile, JSON.stringify(key, null, 2), { flag: "wx" });
console.log(JSON.stringify({ packets: packet.packets.length, publicFile, keyFile, status: "unrated" }));
