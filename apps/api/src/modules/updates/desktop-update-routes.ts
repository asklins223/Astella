import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.ts";
import { readDesktopUpdateManifest } from "../app-release/service.ts";

/**
 * 桌面更新清单：**服务端下发**（2026-10-10 用户决定，替代客户端直连 GitHub 检查）。
 *
 * 客户端问的是这里，这里替它去 GitHub 现场取，然后按**我们自己的规则**改写下载地址：
 *
 * 1. 最新 tag 从 `releases.atom` 拿——这是 github.com 的普通 feed，**不占 api.github.com
 *    那 60 次/小时/IP 的匿名限额**，服务端出口 IP 不会被自己锁住；
 * 2. 对应的 `latest.yml` / `latest-mac.yml` 从那个 tag 的 Release 资产取；
 * 3. 清单里的 `url:` 改写成绝对地址——想直连、想挂镜像、想换包源，改这一处就行。
 *
 * 结果**落库**（`update_manifest_cache`，0406）：进程重启与容器重建都不丢，于是
 * "每个通道 5 分钟问一次 GitHub"跨进程、跨实例都成立；GitHub 连不上时拿上一次成功
 * 的结果顶着——只要曾经问到过一次，更新清单就不会因为断网而空手。
 *
 * **只发信息和地址，不发字节**：安装包仍从 GitHub/镜像下载，更新带宽不落自家服务器；
 * 清单彻底拿不到时客户端退回自己打包配置里的 GitHub 更新源（见 `desktop-update.ts`），
 * 所以自家 API 挂了也不会挡住更新。
 */
const RELEASES_ORIGIN = "https://github.com/asklins223/Astella";
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;

export const CHANNEL_FILES = ["latest.yml", "latest-mac.yml"] as const;
export type ChannelFile = (typeof CHANNEL_FILES)[number];

export interface StoredManifest {
  readonly tag: string;
  readonly body: string;
  readonly fetchedAt: Date;
}

export interface ManifestDeps {
  fetchText?: (url: string) => Promise<string>;
  load?: (channel: ChannelFile) => Promise<StoredManifest | null>;
  save?: (channel: ChannelFile, tag: string, body: string) => Promise<void>;
}

/** 取一个文档的纯文本；超时与非 2xx 一律抛，调用方按"取不到"处理。 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/xml, text/yaml, text/plain, */*" },
  });
  if (!response.ok) throw new Error(`update_source_${response.status}: ${url}`);
  return response.text();
}

/**
 * Atom feed → 最新 tag。
 *
 * 只认第一条 `<entry>` 里的 `/tag/<x>`：Release 按时间倒序排，第一条就是最新正式版。
 * 拿不到就抛——宁可让客户端退回 GitHub，也不要把一个猜测的版本发下去。
 */
export function latestTagFromFeed(atom: string, tagPrefix?: string): string {
  const tags: string[] = [];
  for (const match of atom.matchAll(/<entry>[\s\S]*?<link[^>]*href="([^"]+)"/g)) {
    const tag = match[1]?.match(/\/tag\/([^/?#]+)/)?.[1];
    if (tag) tags.push(tag);
  }
  if (tags.length === 0) throw new Error("update_source_no_tag");
  // 桌面发布改用 c-v 前缀；老版本仍是 v*。优先取带前缀的最新一条，找不到再退回第一条，
  // 这样迁移前后都不会把「最新 tag」认成服务端/手机端的发布。
  return tags.find((tag) => !tagPrefix || tag.startsWith(tagPrefix)) ?? tags[0]!;
}

/**
 * 清单里的 `url:` 改写成绝对地址。
 *
 * electron-builder 写下的 `url:` 是**相对文件名**，通用更新源会把它拼到自己的 base
 * 上——而我们并不托管安装包，拼出来会指到自家域名然后 404。所以这里显式拼回
 * Release 资产；已经是绝对地址的原样留着（那是有人显式指过的源）。
 *
 * 其余字段（`version`、`sha512`、`size`、`path`、`releaseDate`）一个字节都不动：
 * 校验码来自 GitHub 的原始清单，改了就装不上。
 */
export function rewriteChannelManifest(yaml: string, tag: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const relative = /^(\s*-?\s*url:\s*)(.+?)\s*$/.exec(line);
      if (!relative) return line;
      const target = relative[2].replace(/^["']|["']$/g, "");
      if (/^https?:\/\//i.test(target)) return line;
      return `${relative[1]}${RELEASES_ORIGIN}/releases/download/${tag}/${target}`;
    })
    .join("\n");
}

/** 缓存行的读写；表不在就不缓存（本地无迁移的环境），照样能出清单。 */
async function loadChannel(channel: ChannelFile): Promise<StoredManifest | null> {
  try {
    const rows = await db.execute<{ tag: string; body: string; fetched_at: Date }>(sql`
      SELECT tag, body, fetched_at FROM update_manifest_cache WHERE channel = ${channel}`);
    const row = (Array.isArray(rows) ? rows : [])[0];
    return row ? { tag: row.tag, body: row.body, fetchedAt: new Date(row.fetched_at) } : null;
  } catch {
    return null;
  }
}

async function saveChannel(channel: ChannelFile, tag: string, body: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO update_manifest_cache(channel, tag, body, fetched_at)
      VALUES(${channel}, ${tag}, ${body}, now())
      ON CONFLICT (channel) DO UPDATE SET tag = EXCLUDED.tag, body = EXCLUDED.body, fetched_at = now()`);
  } catch {
    // 写不进只是下次多问一次 GitHub，不该让清单本身拿不到。
  }
}

/**
 * 一次清单的完整取回：库里有新的就直接用，过期了才去 GitHub，GitHub 不给就用旧的顶。
 *
 * 顺序是有意的：**先看本地**（0 次外呼），**再问 GitHub**（每通道 5 分钟一次），
 * **失败回退旧值**（任何年龄）。这样最坏情况下的 GitHub 请求数是
 * 「进程数 × 每 5 分钟 2 次」，而不是「用户数 × 每次检查」。
 */
export async function desktopUpdateManifest(channel: ChannelFile, deps: ManifestDeps = {}): Promise<string> {
  const fetcher = deps.fetchText ?? fetchText;
  const load = deps.load ?? loadChannel;
  const save = deps.save ?? saveChannel;
  // 缓存的读写都不许把清单本身拖垮：读失败当成没有，写失败只是下次多问一次。
  let stored: StoredManifest | null = null;
  try { stored = await load(channel) } catch { stored = null }
  if (stored && Date.now() - stored.fetchedAt.getTime() < CACHE_TTL_MS) return stored.body;

  try {
    const feed = await fetcher(`${RELEASES_ORIGIN}/releases.atom`);
    const tag = latestTagFromFeed(feed, "c-v");
    const yaml = await fetcher(`${RELEASES_ORIGIN}/releases/download/${tag}/${channel}`);
    const body = rewriteChannelManifest(yaml, tag);
    await save(channel, tag, body).catch(() => undefined);
    return body;
  } catch (error) {
    if (stored) return stored.body;
    throw error;
  }
}

export async function desktopUpdateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/updates/desktop/:channelFile", async (req, reply) => {
    const params = z.strictObject({ channelFile: z.enum(CHANNEL_FILES) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "update_channel_not_found" });
    try {
      // Release Center 是首选事实源；只有它还没有当前版本时才回退 GitHub 缓存。
      const stored = await readDesktopUpdateManifest(params.data.channelFile).catch(() => null);
      const body = stored ?? await desktopUpdateManifest(params.data.channelFile);
      reply.header("Content-Type", "text/yaml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=300");
      return reply.send(body);
    } catch {
      // 502：客户端把这当成"自家清单没拿到"，退回它自己打包配置里的更新源。
      return reply.code(502).send({ error: "update_manifest_unavailable" });
    }
  });
}
