/**
 * GitHub 下载加速（国内用户）：直连先试，失败再走 GH-Proxy。
 *
 * 安装包直连 `github.com` / `objects.githubusercontent.com`，在部分网络下会中途断掉；
 * GH-Proxy 是把同一个 Release 资产按前缀镜像一份：
 * `https://v4.gh-proxy.org/https://github.com/<owner>/<repo>/releases/download/...`
 *
 * 为什么不一开始就走代理：更新包要过用户的 SHA-512 校验，多一层第三方站点就多一层
 * 被改写的机会，也把所有人的下载流量交给第三方。所以只有**直连失败时**才回头走代理，
 * 代理也失败就把直连那次的错报出去——它才是用户更可能遇到、也更能读出原因的那条路。
 *
 * 只代理 GitHub 自己的下载域名：别的地址前缀一把会得到一个既不是我们的包、
 * 又仍然会失败的 URL。
 */
const MIRROR_PREFIX = 'https://v4.gh-proxy.org/'
const DIRECT_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'])

/** 直连地址 → 镜像地址；不代理非 GitHub 的地址（返回 null，代表"不该走代理"）。 */
export function mirrorUrl(url: URL): URL | null {
  if (!DIRECT_DOWNLOAD_HOSTS.has(url.hostname)) return null
  return new URL(`${MIRROR_PREFIX}${url.toString()}`)
}

/**
 * 直连下载，失败且地址可代理时用镜像重试一次。
 *
 * 两次都失败时抛**第一次**的错：那是直连的真实原因（超时、404、限流…），
 * 用镜像的错覆盖它只会让用户看到一个更陌生、更难照做的提示。
 */
export async function downloadDirectThenMirrored<T>(
  url: URL,
  download: (target: URL) => Promise<T>,
): Promise<T> {
  let directError: unknown
  try {
    return await download(url)
  } catch (error) {
    directError = error
    const mirrored = mirrorUrl(url)
    if (!mirrored) throw error
    try {
      return await download(mirrored)
    } catch {
      throw directError
    }
  }
}
