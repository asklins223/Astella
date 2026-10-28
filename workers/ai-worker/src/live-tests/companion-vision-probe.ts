import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { deflateSync } from "node:zlib";

/**
 * Live check: can she actually read the picture?
 *
 * The failure this guards against is fluency without looking: before the fix the
 * model received only "image 1: assetId=…" and confidently described a picture
 * it had never seen. The probe therefore asserts against *content we control* —
 * a picture whose text is a random token the model cannot guess.
 */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
assert.ok(databaseUrl, "database configuration is required");
const url = new URL(databaseUrl);
url.pathname = "/astella";
url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const base = "http://127.0.0.1:4000";
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");

/** A 600x200 PNG whose visible text is exactly `token`, drawn as blocks. */
function pngWithText(text: string): Buffer {
  // Hand-rolled 5x7 bitmap font for A-Z0-9 so the picture needs no dependency.
  const G: Record<string, string[]> = {
    A: ["01110","10001","10001","11111","10001","10001","10001"],
    B: ["11110","10001","10001","11110","10001","10001","11110"],
    C: ["01111","10000","10000","10000","10000","10000","01111"],
    D: ["11110","10001","10001","10001","10001","10001","11110"],
    E: ["11111","10000","10000","11110","10000","10000","11111"],
    F: ["11111","10000","10000","11110","10000","10000","10000"],
    G: ["01111","10000","10000","10111","10001","10001","01110"],
    H: ["10001","10001","10001","11111","10001","10001","10001"],
    I: ["11111","00100","00100","00100","00100","00100","11111"],
    J: ["00111","00010","00010","00010","10010","10010","01100"],
    K: ["10001","10010","10100","11000","10100","10010","10001"],
    L: ["10000","10000","10000","10000","10000","10000","11111"],
    M: ["10001","11011","10101","10101","10001","10001","10001"],
    N: ["10001","11001","10101","10011","10001","10001","10001"],
    O: ["01110","10001","10001","10001","10001","10001","01110"],
    P: ["11110","10001","10001","11110","10000","10000","10000"],
    Q: ["01110","10001","10001","10001","10101","10010","01101"],
    R: ["11110","10001","10001","11110","10100","10010","10001"],
    S: ["01111","10000","10000","01110","00001","00001","11110"],
    T: ["11111","00100","00100","00100","00100","00100","00100"],
    U: ["10001","10001","10001","10001","10001","10001","01110"],
    V: ["10001","10001","10001","10001","10001","01010","00100"],
    W: ["10001","10001","10001","10101","10101","11011","10001"],
    X: ["10001","10001","01010","00100","01010","10001","10001"],
    Y: ["10001","10001","01010","00100","00100","00100","00100"],
    Z: ["11111","00001","00010","00100","01000","10000","11111"],
    "0": ["01110","10001","10011","10101","11001","10001","01110"],
    "1": ["00100","01100","00100","00100","00100","00100","01110"],
    "2": ["01110","10001","00001","00010","00100","01000","11111"],
    "3": ["11110","00001","00001","01110","00001","00001","11110"],
    "4": ["00010","00110","01010","10010","11111","00010","00010"],
    "5": ["11111","10000","11110","00001","00001","10001","01110"],
    "6": ["00110","01000","10000","11110","10001","10001","01110"],
    "7": ["11111","00001","00010","00100","01000","01000","01000"],
    "8": ["01110","10001","10001","01110","10001","10001","01110"],
    "9": ["01110","10001","10001","01111","00001","00010","01100"],
  };
  const scale = 8, width = 600, height = 200;
  const px = Buffer.alloc(width * height, 0xff); // white, 1 byte per pixel (grayscale)
  const chars = [...text.toUpperCase()];
  const cellW = 6 * scale, startX = 20, startY = Math.floor((height - 7 * scale) / 2);
  chars.forEach((char, index) => {
    const glyph = G[char];
    if (!glyph) return;
    glyph.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit !== "1") return;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        const py = startY + y * scale + dy, pxx = startX + index * cellW + x * scale + dx;
        if (py < height && pxx < width) px[py * width + pxx] = 0x00;
      }
    }));
  });
  // 8-bit grayscale PNG.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    px.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcValue = Buffer.alloc(4); crcValue.writeUInt32BE(crc(typeAndData));
    return Buffer.concat([length, typeAndData, crcValue]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const token1 = "ZX7Q", token2 = "K4MP";
await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`vision-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Vision live check',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '4 hours')`;
});

function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result).slice(0, 200)}`);
    return result as any;
  });
}

// Store the two pictures the same way an upload does.
const s3 = new S3Client({
  region: env.S3_REGION ?? "us-east-1",
  endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? "astella", secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD ?? "astella_dev_secret" },
});
const bucket = env.S3_BUCKET ?? "astella-workspaces";
const images: Array<{ id: string; objectKey: string }> = [];
for (const token of [token1, token2]) {
  const bytes = pngWithText(token);
  // The site-internal key shape the turn API accepts:
  // {workspaceId}/companion/{uuid}.png
  const objectKey = `${workspaceId}/companion/${randomUUID()}.png`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: "image/png" }));
  const id = randomUUID();
  await db.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO note_image_assets(id,workspace_id,object_key,sha256,mime_type,byte_size,width,height,status,created_by)
      VALUES(${id},${workspaceId},${objectKey},${createHash("sha256").update(bytes).digest("hex")},'image/png',${bytes.byteLength},600,200,'ready',${userId})`;
  });
  images.push({ id, objectKey });
}

const conversation = await api("/companion/inbox/ensure", {});
const conversationId = conversation.id ?? conversation.conversationId;
const results: Record<string, unknown>[] = [];

async function turn(text: string, blocks: unknown[]): Promise<{ runId: string; status: string; visible: string }> {
  const accepted = await api(`/companion/conversations/${conversationId}/turns`, {
    version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
    blocks: [{ type: "text", text }, ...blocks],
  }, { "Idempotency-Key": randomUUID() });
  const runId = accepted.runId as string;
  const until = Date.now() + 240_000;
  let status = "";
  while (Date.now() < until) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    status = String(row?.status ?? "");
    if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const rows = await db`select blocks from companion_messages where run_id=${runId} and role='assistant' order by seq`;
  const visible = rows.map(row => (row.blocks as Array<{ type?: string; text?: string }>)
    .filter(block => block.type === "text").map(block => block.text ?? "").join("")).join("\n\n");
  return { runId, status, visible };
}

const imageBlock = (image: { id: string; objectKey: string }, label: string) => ({
  type: "image", url: `/api/uploads/${image.objectKey}`, label, assetId: image.id,
});

// 0. No picture in this conversation yet: the model must not answer from imagination.
const none = await turn("图里写的是什么？", []);
const noneOk = !none.visible.toUpperCase().includes(token1) && !none.visible.toUpperCase().includes(token2);
results.push({ case: "no-image-honest", ok: noneOk, status: none.status, visible: none.visible.slice(0, 160) });

// 1. One picture: the answer must contain the token that is only in the pixels.
const single = await turn("这张图里写的是什么？只回答那串字母数字。", [
  imageBlock(images[0]!, "第一张"),
]);
const singleOk = single.visible.toUpperCase().includes(token1);
results.push({ case: "single-image", ok: singleOk, status: single.status,
  expected: token1, visible: single.visible.slice(0, 160) });

// 2. Two pictures + a document + a note quote in one turn.
// A note exists so the turn carries a quoted document alongside the pictures.
await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO notes(workspace_id,title,created_by) VALUES(${workspaceId},'引用的手记',${userId})`;
});
// A document travels as extracted text plus its own private upload.
const fileBytes = Buffer.from("# 说明\n这两张图各写了一个编号。", "utf8");
// File names are ASCII-only on the wire (object-key shape).
const fileObjectKey = `${workspaceId}/companion-files/${userId}/brief.md`;
await s3.send(new PutObjectCommand({ Bucket: bucket, Key: fileObjectKey, Body: fileBytes, ContentType: "text/markdown" }));
const multi = await turn("这两张图里各写的是什么？分别告诉我。文档和手记只是背景。", [
  imageBlock(images[0]!, "第一张"),
  imageBlock(images[1]!, "第二张"),
  { type: "file", url: `/api/uploads/${fileObjectKey}`, name: "brief.md", mime: "text/markdown",
    byteLength: fileBytes.byteLength, text: fileBytes.toString("utf8") },
]);
const multiOk = multi.visible.toUpperCase().includes(token1) && multi.visible.toUpperCase().includes(token2);
results.push({ case: "two-images-doc-quote", ok: multiOk, status: multi.status,
  expected: [token1, token2], visible: multi.visible.slice(0, 240) });

for (const row of results) console.log(JSON.stringify(row));
const passed = results.filter(row => row.ok).length;
console.log(`\nVISION ${passed}/${results.length}`);
await db.end();
process.exit(passed === results.length ? 0 : 1);
