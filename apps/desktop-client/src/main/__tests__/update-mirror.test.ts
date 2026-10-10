/**
 * 下载镜像（`src/main/update-mirror.ts`）的判断，不是下载能力——那部分要真实 Release 才能验。
 *
 * 1. 只代理 GitHub 自己的下载域名，别的一律不改（改了会得到一个既不是我们的包、
 *    又照样失败的地址）。
 * 2. 直连成功就不碰镜像：更新包要过 SHA-512，能不走第三方就不走。
 * 3. 直连失败才回头走镜像；镜像也失败时抛**直连那次的错**，它才带着可读的原因。
 */
import { describe, expect, it } from "vitest";
import { downloadDirectThenMirrored, mirrorUrl } from "../update-mirror";

const asset = new URL("https://github.com/asklins223/Astella/releases/download/v1.6.0/astella-1.6.0-mac-arm64.zip");

describe("mirrorUrl", () => {
  it("GitHub 资产加代理前缀，前缀后面是完整的原地址", () => {
    expect(mirrorUrl(asset)?.toString())
      .toBe("https://v4.gh-proxy.org/https://github.com/asklins223/Astella/releases/download/v1.6.0/astella-1.6.0-mac-arm64.zip");
  });

  it("GitHub 的内容 CDN 同样代理——直连断在这一步最常见", () => {
    expect(mirrorUrl(new URL("https://objects.githubusercontent.com/x"))?.hostname).toBe("v4.gh-proxy.org");
  });

  it("非 GitHub 地址不代理", () => {
    expect(mirrorUrl(new URL("https://example.com/astella.zip"))).toBeNull();
    expect(mirrorUrl(new URL("https://evil.example/github.com/releases"))).toBeNull();
  });
});

describe("downloadDirectThenMirrored", () => {
  it("直连成功就只有一次下载，不碰镜像", async () => {
    const seen: string[] = [];
    const result = await downloadDirectThenMirrored(asset, async (target) => {
      seen.push(target.toString());
      return "zip";
    });
    expect(result).toBe("zip");
    expect(seen).toEqual([asset.toString()]);
  });

  it("直连失败才走镜像，镜像的返回值原样交给调用方", async () => {
    const seen: string[] = [];
    const result = await downloadDirectThenMirrored(asset, async (target) => {
      seen.push(target.toString());
      if (target.hostname === "github.com") throw new Error("net::ERR_CONNECTION_RESET");
      return "zip-from-mirror";
    });
    expect(result).toBe("zip-from-mirror");
    expect(seen[0]).toBe(asset.toString());
    expect(seen[1]).toContain("v4.gh-proxy.org");
  });

  it("两次都失败时抛直连那次的错，不拿镜像的错顶替", async () => {
    const error = await downloadDirectThenMirrored(asset, async (target) => {
      throw new Error(target.hostname === "github.com" ? "direct timed out" : "mirror timed out");
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("direct timed out");
  });

  it("不可代理的地址直接失败，不尝试第二次", async () => {
    let calls = 0;
    await expect(downloadDirectThenMirrored(new URL("https://example.com/file.zip"), async () => {
      calls += 1;
      throw new Error("nope");
    })).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});
