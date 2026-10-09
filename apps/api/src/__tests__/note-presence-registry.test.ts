import assert from "node:assert/strict";
import test from "node:test";
import {
  closeNotePresenceSlot,
  notePresenceReported,
  notePresenceSnapshot,
  openNotePresenceSlot,
  sanitizePresenceState,
} from "../modules/note/collaboration.ts";

/**
 * 「此刻谁开着这一篇」那份登记表。
 *
 * 它只有三条必须站得住的规则，每一条都有对应的坏样子：
 *  1. **同一个人开两个窗口算一个人**——引用计数漏了就会在同一个人的名字旁边长出第二枚印章；
 *  2. **最后一条连接断了才销**——早销是"人还在，名字先没了"，晚销是"人走了，名字还挂着"，
 *     这一份不落库，所以靠的全是连接生死本身；
 *  3. **名字由服务端说**——对端自报那一位不能穿到别人屏上。
 *
 * 「登记排在两道拒绝之后」那条是源码形状，住在 `note-presence-registration-guard.test.ts`：
 * 把它挪到这里会让这份变成混合守卫，而它守的顺序换不动位置，行为用例却抓不到它。
 */

const space = "space-presence-probe";
const otherSpace = "space-presence-probe-elsewhere";
let seq = 0;
const freshNote = () => `note-presence-${seq += 1}`;

test("同一篇的两条连接算一个人，最后一条断了才销", () => {
  const noteId = freshNote();
  const userId = "user-two-windows";
  openNotePresenceSlot({ workspaceId: space, noteId, userId, displayName: "小琳" });
  openNotePresenceSlot({ workspaceId: space, noteId, userId, displayName: "小琳" });
  const both = notePresenceSnapshot(space).find((item) => item.noteId === noteId);
  assert.equal(both?.viewers.length, 1, "两条连接在同一篇上是**一个人**，不是两个");
  assert.equal(both?.viewers[0]?.displayName, "小琳");

  closeNotePresenceSlot(noteId, userId);
  assert.equal(notePresenceSnapshot(space).find((item) => item.noteId === noteId)?.viewers.length, 1,
    "还剩一条连接，名字应当在");
  closeNotePresenceSlot(noteId, userId);
  assert.equal(notePresenceSnapshot(space).find((item) => item.noteId === noteId), undefined,
    "最后一条断了就该干净——否则别人那一排永远挂着一个已经走了的人");
});

test("刚连上还没报状态，读成「在读」而不是「在写」", () => {
  const noteId = freshNote();
  openNotePresenceSlot({ workspaceId: space, noteId, userId: "user-unreported", displayName: "" });
  const [viewer] = notePresenceSnapshot(space).find((item) => item.noteId === noteId)?.viewers ?? [];
  assert.equal(viewer?.mode, "reading", "没报过的只能是「开着这一篇」这一件确定的事");
  assert.equal(viewer?.block, null);
  assert.equal(viewer?.displayName, "", "没留下名字的人不编名字，界面据这一刻画一枚「?」印章");
});

test("报了在写之后才是「在写」，离开这篇之后迟到的那一条不会把人塞回来", () => {
  const noteId = freshNote();
  const userId = "user-writer";
  openNotePresenceSlot({ workspaceId: space, noteId, userId, displayName: "Asklins" });
  notePresenceReported(noteId, userId, { mode: "editing", block: 3 });
  let viewers = notePresenceSnapshot(space).find((item) => item.noteId === noteId)?.viewers;
  assert.equal(viewers?.[0]?.mode, "editing");
  assert.equal(viewers?.[0]?.block, 3);

  closeNotePresenceSlot(noteId, userId);
  notePresenceReported(noteId, userId, { mode: "editing", block: 4 });
  viewers = notePresenceSnapshot(space).find((item) => item.noteId === noteId)?.viewers;
  assert.equal(viewers, undefined, "登记表跟着连接走：一条迟到的 awareness 不该把已经离开的人重新登记上");
});

test("认不出来的 mode 与 block 落到「在读」「不在任何块里」", () => {
  const clean = sanitizePresenceState({ name: "冒充别人", mode: "shouting", block: -2 }, "服务端那份名字");
  assert.deepEqual(clean, { name: "服务端那份名字", mode: "reading", block: null });
  assert.equal(sanitizePresenceState({ mode: "editing", block: 7 }, "").block, 7);
  assert.equal(sanitizePresenceState({ mode: "editing", block: 1.5 }, "").mode, "editing",
    "块号认不出不影响档位本身");
});

test("快照按空间切：别处的连接不从这一份端出去", () => {
  const noteId = freshNote();
  openNotePresenceSlot({ workspaceId: otherSpace, noteId, userId: "user-elsewhere", displayName: "别人空间的人" });
  assert.equal(notePresenceSnapshot(space).find((item) => item.noteId === noteId), undefined);
  assert.equal(notePresenceSnapshot(otherSpace).find((item) => item.noteId === noteId)?.viewers.length, 1);
  closeNotePresenceSlot(noteId, "user-elsewhere");
});
