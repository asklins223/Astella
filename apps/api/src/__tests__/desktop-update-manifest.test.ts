/**
 * 桌面更新清单（服务端下发）的判断，不真连 GitHub。
 *
 * 1. 最新 tag 从 `releases.atom` 的第一条 entry 取——不占 api.github.com 的匿名限额；
 * 2. 清单里的 `url:` 必须被改写成绝对地址：通用更新源会把它拼到我们的 base 上，
 *    而我们不托管安装包，不改写就会指到自家域名 404；
 * 3. `version`/`sha512`/`size` 一个字节都不动——那是校验码；
 * 4. GitHub 临时取不到时用上一次成功的清单顶着，第一次就失败才抛（客户端据此回退）。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  desktopUpdateManifest,
  latestTagFromFeed,
  resetUpdateManifestCacheForTests,
  rewriteChannelManifest,
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

beforeEach(() => resetUpdateManifestCacheForTests());

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

test("取回一次之后 5 分钟内不再问 GitHub", async () => {
  const seen: string[] = [];
  const fetcher = async (url: string) => {
    seen.push(url);
    return url.endsWith("releases.atom") ? FEED : YAML;
  };
  const first = await desktopUpdateManifest("latest-mac.yml", { fetchText: fetcher });
  const second = await desktopUpdateManifest("latest-mac.yml", { fetchText: fetcher });
  assert.equal(second, first);
  assert.deepEqual(seen, [
    "https://github.com/asklins223/Astella/releases.atom",
    "https://github.com/asklins223/Astella/releases/download/v1.6.0/latest-mac.yml",
  ]);
});

test("清单这次取不到时用上一次成功的顶着，第一次就失败则抛", async () => {
  let fail = false;
  const fetcher = async (url: string) => {
    if (fail) throw new Error("update_source_503: github down");
    return url.endsWith("releases.atom") ? FEED : YAML;
  };
  const body = await desktopUpdateManifest("latest.yml", { fetchText: fetcher });
  fail = true;
  assert.equal(await desktopUpdateManifest("latest.yml", { fetchText: fetcher }), body, "过期的好清单比拿不到强");

  resetUpdateManifestCacheForTests();
  await assert.rejects(desktopUpdateManifest("latest.yml", { fetchText: async () => { throw new Error("update_source_503"); } }),
    /update_source_503/);
});
