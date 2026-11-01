import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { z } from "zod";

import {
  MAX_SOURCE_TEXT_BYTES,
  OBJECT_TRANSFER_MAX_BYTES,
  TRANSFER_BASE64_MAX_CHARS,
  TRANSFER_MAX_BYTES,
  objectTransferRequestSchema,
} from "@astella/shared/object-transfer-contracts";
import { SOURCE_IMAGE_MAX_BYTES } from "@astella/shared/source-image-contracts";
import { AVATAR_MAX_BYTES, NOTE_DOC_UPDATE_MAX_CHARS } from "@astella/shared/desktop-ipc-contracts";
import { COMPANION_FILE_MAX_BYTES } from "@astella/shared/companion-file-contracts";
import { COMPANION_IMAGE_MAX_BYTES_V1 } from "@astella/shared/companion-conversation-contracts";
import { NOTE_IMAGE_UPLOAD_MAX_BYTES } from "@astella/shared/note-image-upload-contracts";
import {
  NOTE_DOC_UPDATE_BASE64_MAX_CHARS,
  NOTE_DOC_UPDATE_MAX_BYTES,
  noteDocUpdateRequestV1Schema,
} from "../modules/note/schema.ts";

/**
 * 尺寸判据的**对齐**守卫（2026-11-01 用户决定：笔记大小不要限制；要限就 100 MB，
 * 文件的上传下载也都按 100 MB）。
 *
 * 这一条链上每个环节过去都自己写一个数字（正文 10 MB、导入图 5 MB、头像 10 MB、
 * 伴星文件 20 MB、multipart 全局 10 MB、WS 单帧 256 KB、nginx 25 MB、iOS 3 M 字符）。
 * 症状从来不是"报个错"，而是**最先进不来的那一个**决定的就是用户实际能传多大，
 * 而界面上那句"太大了"往往来自另一处——2026-10-31 实测到的"客户端放行、服务端 413"
 * 就是这一类错位里最便宜的一个。
 *
 * 所以这里不测某个上限**数值合不合理**，只钉两件事：
 *  1. 该等于 100 MB 的都等于它（改一处忘改另一处，这条就红）；
 *  2. 已经比它宽的（对象导出 256 MB）不许被"统一"成更小的——那是往回收，不是对齐。
 */

const repoFile = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  "utf8",
);

test("上传与下载的用户内容上限都等于同一个 100 MB", () => {
  assert.equal(TRANSFER_MAX_BYTES, 100 * 1024 * 1024, "100 MB 这个数只声明在 `TRANSFER_MAX_BYTES` 一处");
  for (const [name, value] of [
    ["MAX_SOURCE_TEXT_BYTES（一份正文）", MAX_SOURCE_TEXT_BYTES],
    ["SOURCE_IMAGE_MAX_BYTES（导入随文图 / 站内图取回）", SOURCE_IMAGE_MAX_BYTES],
    ["NOTE_IMAGE_UPLOAD_MAX_BYTES（笔记贴图）", NOTE_IMAGE_UPLOAD_MAX_BYTES],
    ["AVATAR_MAX_BYTES（头像）", AVATAR_MAX_BYTES],
    ["COMPANION_FILE_MAX_BYTES（对话附件）", COMPANION_FILE_MAX_BYTES],
    ["COMPANION_IMAGE_MAX_BYTES_V1（对话图片，与识图同一上限）", COMPANION_IMAGE_MAX_BYTES_V1],
    ["NOTE_DOC_UPDATE_MAX_BYTES（一条正文增量）", NOTE_DOC_UPDATE_MAX_BYTES],
  ] as const) {
    assert.equal(value, TRANSFER_MAX_BYTES, `${name} 与传输上限不是一个数：${value} ≠ ${TRANSFER_MAX_BYTES}`);
  }
});

test("已经比 100 MB 更宽的那一格不是缺陷，不许被收小", () => {
  // 整包导出（workspace 全量）比单个文件大是本来就该如此；把它"统一"成 100 MB 会让
  // 能存下来的东西导不出去。
  assert.ok(OBJECT_TRANSFER_MAX_BYTES > TRANSFER_MAX_BYTES, "对象导出上限必须仍然宽于单文件上限");
});

test("走文本通道的那几格按字节推出来，不各写一个乘数", () => {
  assert.equal(TRANSFER_BASE64_MAX_CHARS, Math.ceil(TRANSFER_MAX_BYTES / 3) * 4 + 64);
  assert.equal(NOTE_DOC_UPDATE_BASE64_MAX_CHARS, TRANSFER_BASE64_MAX_CHARS);
  // 桌面过 IPC 的那一帧与 HTTP 上送的是同一串字节：两边不同数，症状是一边放行一边拒收。
  assert.equal(NOTE_DOC_UPDATE_MAX_CHARS, NOTE_DOC_UPDATE_BASE64_MAX_CHARS);
  // 字符上界必须**容得下**满额字节：判小了就是"服务端自己收不下自己声明能收的增量"。
  const fullPayloadBase64Length = Math.ceil(TRANSFER_MAX_BYTES / 3) * 4;
  assert.ok(
    NOTE_DOC_UPDATE_BASE64_MAX_CHARS >= fullPayloadBase64Length,
    "base64 字符上界比满额增量的编码长度还小，2 MiB 那一类错位会换个尺寸重演",
  );
});

test("尺寸判据分得清：刚好满额收，超一个字节拒", () => {
  const encode = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
  assert.equal(noteDocUpdateRequestV1Schema.safeParse({ update: encode(TRANSFER_MAX_BYTES - 1024) }).success, true);
  assert.equal(noteDocUpdateRequestV1Schema.safeParse({ update: encode(TRANSFER_MAX_BYTES + 1024) }).success, false);

  const request = (byteLength: number) => ({
    purpose: "note_image",
    fileName: "a.png",
    mimeType: "image/png",
    byteLength,
    sha256: "0".repeat(64),
    noteId: "00000000-0000-0000-0000-000000000000",
  });
  assert.equal(objectTransferRequestSchema.safeParse(request(TRANSFER_MAX_BYTES)).success, true);
  assert.equal(objectTransferRequestSchema.safeParse(request(TRANSFER_MAX_BYTES + 1)).success, false);
});

test("服务端注册的两个通道数字跟着同一个上限走", () => {
  const server = repoFile("../../src/server.ts");
  assert.match(
    server,
    /maxPayload:\s*TRANSFER_MAX_BYTES\s*\+\s*64 \* 1024/,
    "WS 单帧上限必须引用传输上限（2026-10-31 实测：400 KB 的一帧把连接打断，改动一个字都没落库）",
  );
  assert.match(server, /fileSize:\s*TRANSFER_MAX_BYTES/, "multipart 的全局上限必须引用传输上限");
  assert.doesNotMatch(server, /fileSize:\s*\d+ \* 1024 \* 1024/, "multipart 不许再自己写一个 MB 数字");
});

test("反向代理放行的是信封，不是内容", () => {
  const proxy = repoFile("../../../../infra/deploy/nginx.conf");
  const declared = /client_max_body_size\s+(\d+)m;/.exec(proxy);
  assert.ok(declared, "nginx 的 body 上限没找到");
  const megabytes = Number(declared![1]);
  assert.ok(
    megabytes * 1024 * 1024 >= TRANSFER_BASE64_MAX_CHARS,
    `代理挡的比 API 自己声明过的最宽一发还小（${megabytes}m），用户拿到的是 nginx 那页没有原因码的 413`,
  );
});

test("笔记正文本身没有第二道尺寸判据", () => {
  // 「提交并确认」/新建那一侧的块内容上限必须与一份正文的上限同源：
  // 它比正文小的话，长文会以"字段过长"的形状被拒，而那既不是用户要的限制也看不见来源。
  const schema = repoFile("../modules/note/schema.ts");
  assert.match(schema, /content: z\.string\(\)\.max\(NOTE_BLOCK_CONTENT_MAX_CHARS\)/);
  assert.match(schema, /const NOTE_BLOCK_CONTENT_MAX_CHARS = MAX_SOURCE_TEXT_BYTES/);
  const noteCreate = z.object({ blocks: z.array(z.object({ type: z.string(), content: z.string().max(MAX_SOURCE_TEXT_BYTES) })) });
  assert.equal(noteCreate.safeParse({ blocks: [{ type: "paragraph", content: "x".repeat(MAX_SOURCE_TEXT_BYTES) }] }).success, true);
});
