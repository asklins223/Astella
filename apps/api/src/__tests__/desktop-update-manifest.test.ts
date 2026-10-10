/**
 * 桌面更新清单（服务端下发 + 落库缓存）的判断，不真连 GitHub，也不连库。
 *
 * 1. 最新 tag 从 `releases.atom` 的第一条 entry 取——不占 api.github.com 的匿名限额；
 * 2. 清单里的 `url:` 必须改写成绝对地址：通用更新源会把它拼到我们的 base 上，
 *    而我们不托管安装包，不改写就会指到自家域名 404；
 * 3. `version`/`sha512`/`size` 一个字节都不动——那是校验码；
 * 4. **先看库里有没有新的**（0 次外呼）→ 过期才问 GitHub → 问不到用库里旧的顶着，
 *    两头都没有才抛。这三条顺序决定了 GitHub 请求数的上界。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desktopUpdateManifest,
  latestTagFromFeed,
  rewriteChannelManifest,
  type ChannelFile,
  type ManifestDeps,
  type StoredManifest,
} from "../modules/updates/desktop-update-routes.ts";

const FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><link href="https://github.com/asklins223/Astella/releases/tag/v1.6.0"/></entry>
  <entry><link href="https://github.com/asklins223/Astella/releases/tag/v1.5.0"/></entry>
</feed>`;

const YAML = [
  "version: 1.6.0",
  "files:",
  "  - url: astella-1.6.0-mac-arm64.zip",
  "    sha512: QUJDREVGQUJDRA==",
  "    size: 123456789",
  "path: astella-1.6.0-mac-arm64.zip",
  "releaseDate: '2026-10-10T13:10:00.000Z'",
  "",
].join("\n");

/** 换算过的旧清单：库里存的永远是改写后的成品。 */
const STORED_BODY = rewriteChannelManifest(YAML, "v1.6.0");

function harness(options: { stored?: StoredManifest | null; failFetch?: boolean; failLoad?: boolean } = {}) {
  const calls = { fetch: [] as string[], saved: [] as Array<{ tag: string; body: string }> };
  const deps: ManifestDeps = {
    fetchText: async (url) => {
      calls.fetch.push(url);
      if (options.failFetch) throw new Error("update_source_503: github down");
      return url.endsWith("releases.atom") ? FEED : YAML;
    },
    load: async () => {
      if (options.failLoad) throw new Error("db down");
      return options.stored ?? null;
    },
    save: async (_channel: ChannelFile, tag: string, body: string) => { calls.saved.push({ tag, body }); },
  };
  return { deps, calls };
}

const fresh = (body: string): StoredManifest => ({ tag: "v1.6.0", body, fetchedAt: new Date() });
const stale = (body: string): StoredManifest => ({ tag: "v1.5.0", body, fetchedAt: new Date(Date.now() - 60 * 60_000) });

test("最新 tag 取 feed 第一条 entry 的 /tag/", () => {
  assert.equal(latestTagFromFeed(FEED), "v1.6.0");
  assert.throws(() => latestTagFromFeed("<feed></feed>"), /no_tag/);
});

test("相对 url 改写成 Release 资产绝对地址，校验字段原样保留", () => {
  const rewritten = rewriteChannelManifest(YAML, "v1.6.0");
  assert.match(rewritten, /url: https:\/\/github\.com\/asklins223\/Astella\/releases\/download\/v1\.6\.0\/astella-1\.6\.0-mac-arm64\.zip/);
  assert.match(rewritten, /version: 1\.6\.0/);
  assert.match(rewritten, /sha512: QUJDREVGQUJDRA==/);
  assert.match(rewritten, /size: 123456789/);
  assert.match(rewritten, /path: astella-1\.6\.0-mac-arm64\.zip/);
});

test("已经是绝对地址的 url 不再拼一遍（有人显式指过源）", () => {
  const absolute = "files:\n  - url: https://cdn.example.com/astella.zip\n";
  assert.equal(rewriteChannelManifest(absolute, "v1.6.0"), absolute);
});

test("库里还新鲜就直接给，一次 GitHub 都不问", async () => {
  const { deps, calls } = harness({ stored: fresh(STORED_BODY) });
  assert.equal(await desktopUpdateManifest("latest-mac.yml", deps), STORED_BODY);
  assert.deepEqual(calls.fetch, [], "新鲜的缓存不该触发任何外呼");
  assert.deepEqual(calls.saved, []);
});

test("库里过期才去 GitHub，问到之后写回（tag 与成品一起存）", async () => {
  const { deps, calls } = harness({ stored: stale(STORED_BODY) });
  const body = await desktopUpdateManifest("latest-mac.yml", deps);
  assert.deepEqual(calls.fetch, [
    "https://github.com/asklins223/Astella/releases.atom",
    "https://github.com/asklins223/Astella/releases/download/v1.6.0/latest-mac.yml",
  ]);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0]?.tag, "v1.6.0");
  assert.equal(calls.saved[0]?.body, body);
});

test("GitHub 这次拿不到就用库里旧的顶着（任何年龄）", async () => {
  const { deps } = harness({ stored: stale(STORED_BODY), failFetch: true });
  assert.equal(await desktopUpdateManifest("latest.yml", deps), STORED_BODY, "过期的好清单比拿不到强");
});

test("库里没有、GitHub 也拿不到才抛——客户端据此退回自己的更新源", async () => {
  const { deps } = harness({ failFetch: true });
  await assert.rejects(desktopUpdateManifest("latest.yml", deps), /update_source_503/);
});

test("读库失败（表还没建/连接断）当成没有缓存，照样去问 GitHub", async () => {
  const { deps, calls } = harness({ failLoad: true });
  const body = await desktopUpdateManifest("latest-mac.yml", deps);
  assert.equal(calls.fetch.length, 2);
  assert.match(body, /releases\/download\/v1\.6\.0/);
});
