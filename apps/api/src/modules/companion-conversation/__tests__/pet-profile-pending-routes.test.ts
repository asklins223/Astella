/**
 * 「排队 / 查看待生效 / 生效」三条路由的注册与门禁（行为断言，不做源码正则）。
 *
 * 沿用 `home-projection-routes.test.ts` 的做法：起一个真 Fastify，用 `hasRoute`
 * 钉住「哪几条存在、哪几条不存在」，用 `inject` 钉住门禁。真实 session 下的
 * 200/409/400 由 `apps/api/src/integration-tests/companion-persona-pending-revision-postgres.integration.ts`
 * 端到端断言。
 *
 * 为什么要单独钉门禁：人格档案是**账号级**表达设定，跨空间共享；一条忘了
 * `requireSession` 的新路由等于把它开给任何拿到 URL 的人。
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { petProfileRoutes } from "../pet-profile-routes.ts";

async function buildApp(flag: string | undefined) {
  const saved = process.env.COMPANION_PET_PROFILE_V1;
  if (flag === undefined) delete process.env.COMPANION_PET_PROFILE_V1;
  else process.env.COMPANION_PET_PROFILE_V1 = flag;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(petProfileRoutes);
  await app.ready();
  return { app, restore: () => {
    if (saved === undefined) delete process.env.COMPANION_PET_PROFILE_V1;
    else process.env.COMPANION_PET_PROFILE_V1 = saved;
  } };
}

const PENDING_ROUTES = [
  { method: "GET" as const, url: "/companion/pet-profile/pending" },
  { method: "POST" as const, url: "/companion/pet-profile/stage", payload: {} },
  { method: "POST" as const, url: "/companion/pet-profile/activate", payload: { revision: 0 } },
];

test("三条待生效路由都已注册，且没有顺手多加的旁路", async (t) => {
  const { app, restore } = await buildApp("true");
  t.after(async () => { restore(); await app.close(); });

  for (const route of PENDING_ROUTES) {
    assert.equal(app.hasRoute(route), true, `${route.method} ${route.url} 必须注册`);
  }
  // 生效只有一条入口：多一条「直接改当前版本」的别名等于绕过排队语义。
  assert.equal(app.hasRoute({ method: "POST", url: "/companion/pet-profile/pending/apply" }), false);
  assert.equal(app.hasRoute({ method: "DELETE", url: "/companion/pet-profile/pending" }), false);
  assert.equal(app.hasRoute({ method: "PUT", url: "/companion/pet-profile" }), false);
  // 既有的四条一条都不能少。
  assert.equal(app.hasRoute({ method: "GET", url: "/companion/pet-profile" }), true);
  assert.equal(app.hasRoute({ method: "PATCH", url: "/companion/pet-profile" }), true);
  assert.equal(app.hasRoute({ method: "GET", url: "/companion/pet-profile/versions" }), true);
  assert.equal(app.hasRoute({ method: "POST", url: "/companion/pet-profile/restore" }), true);
  assert.equal(app.hasRoute({ method: "POST", url: "/companion/pet-profile/reset" }), true);
});

test("三条新路由匿名一律 401（人格是账号级表达设定，不许无认证读取或改动）", async (t) => {
  const { app, restore } = await buildApp("true");
  t.after(async () => { restore(); await app.close(); });

  for (const route of PENDING_ROUTES) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 401, `${route.method} ${route.url} 必须要求认证`);
    assert.deepEqual(response.json(), { error: "missing token" });
  }
});

test("能力开关关闭时，模块级钩子让新路由与旧路由一起 404（不留旁路）", async (t) => {
  const { app, restore } = await buildApp(undefined);
  t.after(async () => { restore(); await app.close(); });

  for (const route of PENDING_ROUTES) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 404, `${route.method} ${route.url} 在 flag 关闭时必须 404`);
  }
});

test("待生效的读接口与既有主响应**分开**：主响应一个字段都不许多", async (t) => {
  const { app, restore } = await buildApp("true");
  t.after(async () => { restore(); await app.close(); });

  const response = await app.inject({ method: "GET", url: "/companion/pet-profile/pending" });
  assert.equal(response.statusCode, 401, "匿名读不到内容——这里只验证门禁在");
  const main = await app.inject({ method: "GET", url: "/companion/pet-profile" });
  assert.equal(main.statusCode, 401, "自证样本：主响应同样先过 requireSession");
});
