// 2026-10-29：正文权限来自空间角色；客户端种类仍校验并记录在会话。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  isWorkspaceOwner,
  sessionClientKindSchema,
} from "../modules/identity/middleware.ts";
import { SESSION_CLIENT_KINDS } from "../modules/identity/credentials.ts";

describe("note ownership is independent of client kind", () => {
  for (const clientKind of ["mobile", "desktop"]) {
    it(`${clientKind} owner can edit`, () => {
      const context = { userId: "owner", workspaceOwnerId: "owner", membershipRole: "owner", clientKind };
      assert.equal(isWorkspaceOwner(context), true);
    });
    it(`${clientKind} member remains read only`, () => {
      const context = { userId: "member", workspaceOwnerId: "owner", membershipRole: "member", clientKind };
      assert.equal(isWorkspaceOwner(context), false);
    });
  }
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
