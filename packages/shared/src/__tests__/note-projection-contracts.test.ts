import assert from "node:assert/strict";
import test from "node:test";
import { noteDetailV1Schema } from "../contracts/note/note-projection-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function fixture(role: "owner" | "member" = "member") {
  return {
    version: 1 as const,
    noteId: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "真实 Note",
    titleSource: "manual" as const,
    sourceId: null,
    currentVersionId: VERSION_ID,
    currentVersion: {
      versionId: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 3,
      contentHash: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      blocks: [{ ordinal: 0, type: "paragraph" as const, content: "正文" }],
    },
    permissions: {
      canRead: true as const,
      canEdit: role === "owner",
      canSave: role === "owner",
      // 作者判据，不是角色判据；这里只是夹具值，规则本身在服务端那一处。
      canShare: true,
    },
    shareScope: "private" as const,
    revision: VERSION_ID,
    snapshotAt: "2026-08-23T00:00:02.000Z",
  };
}

test("NoteDetailV1 accepts the safe Owner/Member read shape", () => {
  assert.equal(noteDetailV1Schema.parse(fixture("owner")).permissions.canEdit, true);
  assert.equal(noteDetailV1Schema.parse(fixture("member")).permissions.canEdit, false);
});

test("NoteDetailV1 rejects private or unknown fields", () => {
  const value = { ...fixture(), currentVersion: { ...fixture().currentVersion, imageAssetId: VERSION_ID } };
  assert.equal(noteDetailV1Schema.safeParse(value).success, false);
});

test("少了归属的那一份读形不放行", () => {
  // 「仅自己可见 / 已共享给空间」是界面要常驻显示的一位。投影漏带一次的话，
  // 表现不是报错而是界面上那一篇悄悄没有状态——所以契约必须硬要。
  const { shareScope: _omitted, ...withoutScope } = fixture();
  assert.equal(noteDetailV1Schema.safeParse(withoutScope).success, false);
  assert.equal(noteDetailV1Schema.safeParse({ ...fixture(), shareScope: "everyone" }).success, false);
});

test("NoteDetailV1 binds the OCC revision to the current version", () => {
  const value = { ...fixture(), revision: NOTE_ID };
  assert.equal(noteDetailV1Schema.safeParse(value).success, false);
});


test("超过一万块的长笔记照样读得回（写侧不设块数，读侧就不许设）", () => {
  // 实测事故（2026-10-14）：markdown 导入造出的 12,000 块笔记，`GET /v2/notes/:id`
  // 被这里的 `.max(10_000)` 判红 → ZodError → 500。响应合同只核结构，不替写侧发明上限。
  const blocks = Array.from({ length: 12_000 }, (_, ordinal) => ({
    ordinal,
    type: "paragraph" as const,
    content: `第${ordinal}段`,
  }));
  const value = { ...fixture(), currentVersion: { ...fixture().currentVersion, blocks } };
  const parsed = noteDetailV1Schema.safeParse(value);
  assert.equal(parsed.success, true,
    !parsed.success ? parsed.error.issues[0]?.message : "");
  if (parsed.success) assert.equal(parsed.data.currentVersion.blocks.length, 12_000);
});
