/**
 * 0413 那道闸的**纯**判据：`isNoteContentWriteForbiddenForSession` 与登录接口那一格。
 *
 * 路由级的行为不在这里测——`integration-tests/mobile-note-write-scope-postgres.integration.ts`
 * 用真实 Postgres 与真实 session 打真请求：那里要证明的是"判据来自凭据"，
 * 而凭据只有过一遍 decodeToken 才算数（源码里 grep 一个字符串证明不了这件事）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  isNoteContentWriteForbiddenForSession,
  sessionClientKindSchema,
} from "../modules/identity/middleware.ts";
import { SESSION_CLIENT_KINDS } from "../modules/identity/credentials.ts";

describe("isNoteContentWriteForbiddenForSession", () => {
  it("手机会话拒改正文", () => {
    assert.equal(isNoteContentWriteForbiddenForSession({ clientKind: "mobile" }), true);
  });

  it("桌面会话放行：桌面端一次调用都不用改", () => {
    assert.equal(isNoteContentWriteForbiddenForSession({ clientKind: "desktop" }), false);
  });

  // 这一条是**有意**的取舍，不是漏判：缺省按桌面处理。做成"未知即拒绝"会让没读
  // 过这条规则的旧签发路径（以及库里没有 0413 的那台）一起变红，症状看起来是
  // "正文写不进去"，而不是"哪一端没带上客户端种类"。
  it("缺省与未知值按桌面处理", () => {
    assert.equal(isNoteContentWriteForbiddenForSession({}), false);
    assert.equal(isNoteContentWriteForbiddenForSession({ clientKind: null }), false);
    assert.equal(isNoteContentWriteForbiddenForSession({ clientKind: undefined }), false);
    assert.equal(isNoteContentWriteForbiddenForSession({ clientKind: "tablet" }), false);
  });

  it("只看这一位，不被相邻字段影响", () => {
    // 变量而不是字面量：这一条要证的就是"别人塞什么都无所谓"。
    const ctx = { clientKind: "mobile", membershipRole: "owner", workspaceOwnerId: "u1", userId: "u1" };
    assert.equal(isNoteContentWriteForbiddenForSession(ctx), true);
  });
});

describe("sessionClientKindSchema", () => {
  it("缺省 desktop——不发这一格的调用方（桌面端）拿到的正是桌面", () => {
    assert.equal(sessionClientKindSchema.parse(undefined), "desktop");
    // 对象里没这一格时 zod 给的是 undefined，缺省在**这一层**生效，不用调用方写 ??。
    assert.equal(z.object({ clientKind: sessionClientKindSchema }).parse({}).clientKind, "desktop");
  });

  it("接受两个合法值", () => {
    assert.equal(sessionClientKindSchema.parse("desktop"), "desktop");
    assert.equal(sessionClientKindSchema.parse("mobile"), "mobile");
  });

  // 拼错的一律 400，而不是**归一成 desktop**：归一等于"不知道规则的人拿到最宽的权限"，
  // 而这条规则要防的正是那一种人。
  it("非法取值被拒，不做归一", () => {
    for (const value of ["phone", "Desktop", "MOBILE", "", " mobile", 0, 1, true, {}, [], null]) {
      assert.equal(sessionClientKindSchema.safeParse(value).success, false, `${String(value)} 必须被拒`);
    }
  });

  // 取值域只有一份声明：`credentials.ts` 的 SESSION_CLIENT_KINDS ↔ 这里的 enum ↔
  // 库里 0413 那句 CHECK。这一条断的是前两份不各写各的（往 SESSION_CLIENT_KINDS
  // 加一种而忘了改这里/库里，这一条与迁移测试一起红）。
  it("取值域与 SESSION_CLIENT_KINDS 同步", () => {
    for (const kind of SESSION_CLIENT_KINDS) {
      assert.equal(sessionClientKindSchema.safeParse(kind).success, true, `${kind} 必须被接受`);
    }
    assert.equal(SESSION_CLIENT_KINDS.length, 2, "新增一种要同步 0413 的 CHECK 与这里的 enum");
  });
});
