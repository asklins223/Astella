import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * 桌面更新清单：**服务端下发**（2026-10-10 用户决定，替代客户端直连 GitHub 检查）。
 *
 * 客户端问的是这里，这里替它去 GitHub 现场取：
 *
 * 1. 最新 tag 从 `releases.atom` 拿——这是 github.com 的普通 feed，**不占 api.github.com
 *    那 60 次/小时/IP 的匿名限额**，服务端出口 IP 不会被自己锁住；
 * 2. 对应的 `latest.yml` / `latest-mac.yml` 从那个 tag 的 Release 资产取；
 * 3. 清单里的 `url:` 按**我们自己的规则**改写成绝对地址。
 *
 * 第 3 步是这次改架构的理由：地址从此由服务端说了算——想直连、想挂镜像、
 * 想换成自己的包源，改这一处就行，客户端不再认 GitHub 的地址。
 *
 * **只发信息和地址，不发字节**：安装包仍从 GitHub/镜像下载，更新带宽不落自家服务器；
 * 清单拿不到时客户端退回自己打包配置里的 GitHub 更新源（见 `desktop-update.ts`），
 * 所以自家 API 挂了不会挡住更新。
 */
const RELEASES_ORIGIN = "https://github.com/asklins223/Astella";
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;

export const CHANNEL_FILES = ["latest.yml", "latest-mac.yml"] as const;
export type ChannelFile = (typeof CHANNEL_FILES)[number];

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
 * 只认第一条 `<entry>` 里的 `/tag/<x>`：Release 是按时间倒序排的，第一条就是最新正式版。
 * 拿不到就抛——宁可让客户端退回 GitHub，也不要把一个猜测的版本发下去。
 */
export function latestTagFromFeed(atom: string): string {
  const tag = /<entry>[\s\S]*?<link[^>]*href="([^"]+)"/.exec(atom)?.[1];
  const matched = tag?.match(/\/tag\/([^/?#]+)/);
  if (!matched) throw new Error("update_source_no_tag");
  return matched[1];
}

/**
 * 清单里的 `url:` 改写成绝对地址。
 *
 * electron-builder 写下的 `url:` 是**相对文件名**，通用更新源会把它拼到自己的 base
 * 上——而我们并不托管安装包，拼出来会指到自家域名然后 404。所以这里显式拼回
 * Release 资产；已经是绝对地址的原样留着（那是有人显式指过的源）。
 *
 * 其余字段（`version`、`sha512`、`size`、`path`、`releaseDate`）一个字都不动：
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

interface ManifestCache { at: number; body: string | null }
const tags = new Map<string, ManifestCache>();
const manifests = new Map<string, ManifestCache>();

/**
 * 一次清单的完整取回（现场拉 GitHub → 改写地址）。
 *
 * 成功结果缓存 5 分钟：一次更新检查会让客户端问一个文件，缓存挡掉的是
 * **同一批用户在同几分钟里对 GitHub 的重复请求**，也让我们这条公开路由不会
 * 被当成 GitHub 的镜像用。
 */
export async function desktopUpdateManifest(channel: ChannelFile, deps: { fetchText?: (url: string) => Promise<string> } = {}): Promise<string> {
  const fetcher = deps.fetchText ?? fetchText;
  const cached = manifests.get(channel);
  if (cached !== undefined && cached.body !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

  const cachedTag = tags.get("latest");
  let tag = cachedTag !== undefined && cachedTag.body !== null && Date.now() - cachedTag.at < CACHE_TTL_MS
    ? cachedTag.body : null;
  if (tag === null) {
    const feed = await fetcher(`${RELEASES_ORIGIN}/releases.atom`);
    tag = latestTagFromFeed(feed);
    tags.set("latest", { at: Date.now(), body: tag });
  }

  try {
    const yaml = await fetcher(`${RELEASES_ORIGIN}/releases/download/${tag}/${channel}`);
    const body = rewriteChannelManifest(yaml, tag);
    manifests.set(channel, { at: Date.now(), body });
    return body;
  } catch (error) {
    // GitHub 临时取不到时用上一次成功的清单顶一顶（`at` 不动，下一次仍会重试）：
    // 过期的好清单比 502 有用——客户端据此照常去下载同一个包。没有旧的就放行去兜底。
    if (cached !== undefined && cached.body !== null) return cached.body;
    throw error;
  }
}

export async function desktopUpdateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/updates/desktop/:channelFile", async (req, reply) => {
    const params = z.strictObject({ channelFile: z.enum(CHANNEL_FILES) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "update_channel_not_found" });
    try {
      const body = await desktopUpdateManifest(params.data.channelFile);
      reply.header("Content-Type", "text/yaml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=300");
      return reply.send(body);
    } catch {
      // 502：客户端把这当成"自家清单没拿到"，退回它自己打包配置里的更新源。
      return reply.code(502).send({ error: "update_manifest_unavailable" });
    }
  });
}

/** 只给测试用：清掉模块级缓存，两条用例之间不能串上一份旧清单。 */
export function resetUpdateManifestCacheForTests(): void {
  tags.clear();
  manifests.clear();
}
