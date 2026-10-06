/**
 * 运维面板访问闸的契约测试。
 *
 * 重点是 fail closed：面板未启用时**不能**留下任何可被扫描到的端点。
 * 那条断言（"路由根本没注册"）在 auth.ts 的注释里被当作设计前提写了几次，
 * 这里必须有一处把它钉住，否则将来一次"先注册再拒绝"的顺手改动就会悄悄
 * 把它变成现实。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  MIN_ADMIN_TOKEN_LENGTH,
  evaluateAdminAuth,
  isAdminPanelEnabled,
  readAdminTokenHeader,
  resetAdminAuthAttempts,
  resolveAdminToken,
  tokensMatch,
} from "../auth.ts";
import { adminRoutes } from "../routes.ts";

const STRONG = "a-strong-operator-token-value";

test("未设置 / 太弱 / 占位值 一律视为未启用", () => {
  assert.equal(resolveAdminToken(undefined), null);
  assert.equal(resolveAdminToken(""), null);
  assert.equal(resolveAdminToken("   "), null);
  // 短于下限：即使看起来像个正经值。
  assert.equal(resolveAdminToken("x".repeat(MIN_ADMIN_TOKEN_LENGTH - 1)), null);
  // 够长但是占位值——长度闸和占位闸是两道独立的门。
  assert.equal(resolveAdminToken("change-me-please-now-ok"), null);
  assert.equal(resolveAdminToken("YOUR_TOKEN_GOES_HERE_ABC"), null);
  assert.equal(resolveAdminToken(STRONG), STRONG);
  assert.equal(isAdminPanelEnabled(STRONG), true);
  assert.equal(isAdminPanelEnabled(undefined), false);
});

test("令牌比较：等值才通过，长度不同直接判否", () => {
  assert.equal(tokensMatch(STRONG, STRONG), true);
  assert.equal(tokensMatch(STRONG, `${STRONG}x`), false);
  assert.equal(tokensMatch(`${STRONG}x`, STRONG), false);
  assert.equal(tokensMatch(STRONG, STRONG.slice(0, -1)), false);
});

test("请求头解析：自定义头与 Bearer 两种写法", () => {
  assert.equal(readAdminTokenHeader({ "x-admin-token": " abc " }), "abc");
  assert.equal(readAdminTokenHeader({ authorization: "Bearer xyz" }), "xyz");
  assert.equal(readAdminTokenHeader({ authorization: "bearer  xyz " }), "xyz");
  assert.equal(readAdminTokenHeader({ authorization: STRONG }), null, "没有 Bearer 前缀就不算令牌");
  assert.equal(readAdminTokenHeader({}), null);
});

test("判定：未配置返回 404（不留探测面）、错误令牌返回 401", () => {
  resetAdminAuthAttempts();
  assert.deepEqual(
    evaluateAdminAuth({ token: STRONG, expected: null, nowMs: 0, clientKey: "a" }),
    { ok: false, status: 404, error: "not_found" },
  );
  assert.deepEqual(
    evaluateAdminAuth({ token: null, expected: STRONG, nowMs: 0, clientKey: "b" }),
    { ok: false, status: 401, error: "forbidden" },
  );
  assert.equal(
    evaluateAdminAuth({ token: STRONG, expected: STRONG, nowMs: 0, clientKey: "c" }).ok,
    true,
  );
});

test("判定：连续失败会退避，且只影响同一个来源", () => {
  resetAdminAuthAttempts();
  const now = 1_000_000;
  // 前 7 次失败只是 401：太早拉闸会把"手滑输错一次"的运维挡在外面。
  for (let i = 0; i < 7; i += 1) {
    assert.equal(
      evaluateAdminAuth({ token: "wrong", expected: STRONG, nowMs: now, clientKey: "attacker" }).status,
      401,
    );
  }
  // 第 8 次失败触发阈值（BLOCK_AFTER_FAILURES）。
  assert.equal(
    evaluateAdminAuth({ token: "wrong", expected: STRONG, nowMs: now, clientKey: "attacker" }).status,
    401,
  );
  // 之后进入退避：即便这次令牌是对的、即便来源 IP 相同，也先被挡 5 分钟。
  // 这是刻意的——限流要按来源算，不能按"这次猜对了吗"算。
  const blocked = evaluateAdminAuth({ token: STRONG, expected: STRONG, nowMs: now, clientKey: "attacker" });
  assert.equal(blocked.status, 429);

  // 另一个来源不受牵连。
  assert.equal(
    evaluateAdminAuth({ token: STRONG, expected: STRONG, nowMs: now, clientKey: "operator" }).ok,
    true,
  );

  // 退避到期后自动恢复，不需要人工解锁。
  assert.equal(
    evaluateAdminAuth({ token: STRONG, expected: STRONG, nowMs: now + 6 * 60 * 1000, clientKey: "attacker" }).ok,
    true,
  );
  resetAdminAuthAttempts();
});

test("判定：输错后输对会清空失败记录（不会被自己的退避锁在外面）", () => {
  resetAdminAuthAttempts();
  const now = 2_000_000;
  evaluateAdminAuth({ token: "typo", expected: STRONG, nowMs: now, clientKey: "d" });
  const recovered = evaluateAdminAuth({ token: STRONG, expected: STRONG, nowMs: now + 1, clientKey: "d" });
  assert.equal(recovered.ok, true);
  // 成功之后再失败，从零重新计。
  assert.equal(
    evaluateAdminAuth({ token: "typo", expected: STRONG, nowMs: now + 2, clientKey: "d" }).status,
    401,
  );
  resetAdminAuthAttempts();
});

test("集成：令牌未配置时 /admin 路由根本不注册", async () => {
  const previous = process.env.ADMIN_PANEL_TOKEN;
  delete process.env.ADMIN_PANEL_TOKEN;
  const app = Fastify({ logger: false });
  try {
    await app.register(adminRoutes);
    await app.ready();
    // 未注册 → 落到全局 404，而不是 401/403。
    // 注意外壳也在其中：面板**关闭**时连登录页都不该存在。
    for (const path of ["/admin", "/admin/api/overview", "/admin/api/metrics", "/admin/api/config"]) {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 404, `${path} 应当不存在`);
    }
    // 路由表里也不该出现任何 admin 路径。
    const routes = app.printRoutes({ commonPrefix: false });
    assert.equal(routes.includes("/admin"), false, "路由表不应包含 /admin");
  } finally {
    if (previous !== undefined) process.env.ADMIN_PANEL_TOKEN = previous;
    await app.close();
  }
});

test("集成：外壳公开（否则浏览器看不到登录框），数据接口一条都要令牌", async () => {
  const previous = process.env.ADMIN_PANEL_TOKEN;
  process.env.ADMIN_PANEL_TOKEN = STRONG;
  const app = Fastify({ logger: false });
  try {
    await app.register(adminRoutes);
    await app.ready();

    // 数据接口：没令牌 / 错令牌都拒。
    assert.equal((await app.inject({ method: "GET", url: "/admin/api/overview" })).statusCode, 401);
    assert.equal(
      (await app.inject({
        method: "GET",
        url: "/admin/api/overview",
        headers: { authorization: "Bearer nope-nope-nope-nope" },
      })).statusCode,
      401,
    );

    const ok = await app.inject({
      method: "GET",
      url: "/admin/api/logs?limit=5",
      headers: { "x-admin-token": STRONG },
    });
    assert.equal(ok.statusCode, 200);

    // 外壳必须公开。这里曾经**是**要令牌的，结果是：浏览器打开 /admin
    // 拿到 {"error":"forbidden"}，而登录框就在这段 HTML 里——
    // 人永远看不到输入令牌的地方，被挡在门外。
    // 外壳里只有一个登录框和它的 CSS/JS，没有任何数据。
    for (const path of [
      "/admin",
      "/admin/app.js",
      "/admin/charts.js",
      "/admin/styles.css",
      "/admin/assets/astella-mark-v1.png",
    ]) {
      assert.equal(
        (await app.inject({ method: "GET", url: path })).statusCode,
        200,
        `${path} 是外壳，必须能在没有令牌时加载`,
      );
    }

    // 写接口同样受保护——只读外壳不代表写接口裸奔。
    assert.equal(
      (await app.inject({ method: "PUT", url: "/admin/api/config", payload: {} })).statusCode,
      401,
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PANEL_TOKEN;
    else process.env.ADMIN_PANEL_TOKEN = previous;
    resetAdminAuthAttempts();
    await app.close();
  }
});

test("集成：日志页的 limit 上界是 500（搜索要搜完整缓冲）", async () => {
  // 这条曾经是 200：前端搜索为了在完整缓冲里找关键词传 500，
  // 于是**每一次搜索都 400**——界面上表现为"搜索框好像没反应"，
  // 而不是任何报错。控制台只有一行不起眼的 "Failed to load resource"。
  const previous = process.env.ADMIN_PANEL_TOKEN;
  process.env.ADMIN_PANEL_TOKEN = STRONG;
  const app = Fastify({ logger: false });
  try {
    await app.register(adminRoutes);
    await app.ready();
    const ok = await app.inject({
      method: "GET",
      url: "/admin/api/logs?limit=500&level=trace",
      headers: { "x-admin-token": STRONG },
    });
    assert.equal(ok.statusCode, 200, "缓冲容量是 500，请求 500 不该被拒");

    const tooBig = await app.inject({
      method: "GET",
      url: "/admin/api/logs?limit=501",
      headers: { "x-admin-token": STRONG },
    });
    assert.equal(tooBig.statusCode, 400, "上界仍然要有，不能变成无界查询");

    const auditTooBig = await app.inject({
      method: "GET",
      url: "/admin/api/audit?limit=500",
      headers: { "x-admin-token": STRONG },
    });
    assert.equal(auditTooBig.statusCode, 400, "审计端点仍是 200 的口径（SQL 也夹 200）");
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PANEL_TOKEN;
    else process.env.ADMIN_PANEL_TOKEN = previous;
    resetAdminAuthAttempts();
    await app.close();
  }
});

test("集成：面板页带严格 CSP，且不返回内联脚本/样式", async () => {
  const previous = process.env.ADMIN_PANEL_TOKEN;
  process.env.ADMIN_PANEL_TOKEN = STRONG;
  const app = Fastify({ logger: false });
  try {
    await app.register(adminRoutes);
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { "x-admin-token": STRONG },
    });
    assert.equal(response.statusCode, 200);
    const csp = response.headers["content-security-policy"];
    assert.ok(csp, "必须带 CSP");
    // 无 'unsafe-inline' 才有意义——有它的话下面两条断言都是空的。
    assert.equal(csp.includes("unsafe-inline"), false);
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'self'"));
    // 页面本身不能有内联 <script>（否则 CSP 会直接把它掐掉）。
    assert.equal(response.body.includes("<script>"), false);
    assert.equal(response.body.includes("style=\""), false, "内联 style 属性会被 CSP 丢弃");
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PANEL_TOKEN;
    else process.env.ADMIN_PANEL_TOKEN = previous;
    resetAdminAuthAttempts();
    await app.close();
  }
});