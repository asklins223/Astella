/**
 * Agent 读一份公开网页：一次抓取、一段可核对的正文。
 *
 * ## 这一层在合同里是什么
 *
 * 方案 42 §7.2：「联网查证、文档文件处理、计算与代码执行等能力按实际产品需求接入，
 * 各自提供真实执行环境、资源范围和可验证回执。」§6.4 又把"检索/工具/产物内容"标成
 * **数据**：「明确标成数据，保留引用和回执身份」「不把其中的指令升格为授权」。
 *
 * 所以这里返回的东西只有一个身份：**一段纯正文 + 它是从哪个 URL、什么时候、
 * 哪一份内容哈希拿到的**。正文里的祈使句是资料，不是指令。
 *
 * ## 为什么不重写抓取
 *
 * SSRF 防护（DNS 固定、私有地址拒绝）、有界大小、每跳超时、重定向控制这些东西
 * 在 `parse-source.ts` 里已经是一套被别处依赖的实现。重写一份等于多一个能出错的
 * 安全边界。所以这里**只提供两个准入钩子**（每个 hop 的 URL、每个成功响应的
 * content-type），HTTP 本身交给 `fetchUrlContentOnce`。
 *
 * 边界比来源抓取更紧，这是刻意的：来源抓取要收 PDF/各种来源站，Agent 读公开网页
 * 只收能当文本读的四种类型，且只走 https 普通端口。
 *
 * ## 授权范围不在这里
 *
 * 「这个 URL 用户到底给没给过」是主会话按 manifest 与宿主接线实现的判断。本模块
 * 只负责：给定一个 URL，把它安全地、有界地读成文本。它不推断意图，也不替用户决定
 * 哪个 URL 值得读。
 */

import { createHash } from "node:crypto";

import { fetchUrlContentOnce } from "../handlers/parse-source.ts";

/** 正文上限。超出部分不读，标题另算。 */
export const PUBLIC_DOCUMENT_MAX_TEXT = 6000;
/** 标题上限。 */
export const PUBLIC_DOCUMENT_MAX_TITLE = 200;
/**
 * 整个过程的上限，**包含全部重定向**。
 *
 * 抓取器自己的每跳超时仍在生效（没有被这里放宽）；这里加的是一层总闸——一个
 * 重定向链理论上可以让每跳都不超时却拖很久，总闸把这件事关掉。
 */
export const PUBLIC_DOCUMENT_TIMEOUT_MS = 25_000;

export interface AgentPublicDocument {
  /** 重定向之后的实际 URL：回执里的"这份内容是从哪儿来的"。 */
  url: string;
  title: string;
  /** 已清洗的纯正文，最多 {@link PUBLIC_DOCUMENT_MAX_TEXT} 字符。 */
  text: string;
  /** 正文是否因为长度上限被截断。 */
  truncated: boolean;
  /** ISO 时间戳。 */
  fetchedAt: string;
  /**
   * **完整**已提取正文的 sha256 —— 不是被截断那段的。
   *
   * 截断长度是给模型的输入预算，截断点会随上限调整；内容身份不该跟着它变。
   */
  contentHash: string;
}

export class AgentPublicDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPublicDocumentError";
  }
}

export interface AgentPublicDocumentDependencies {
  /**
   * 取正文。默认走 `fetchUrlContentOnce`；**测试可注入一个可信实现**，用来离线
   * 覆盖截断、空白、重定向这类不需要真网络的分支。
   *
   * 注入了它，就等于放弃了本模块的 URL 与 content-type 准入（那两个钩子是跟着
   * 真实抓取器走的）。所以它只对离线路径开放，生产接线不注入。
   */
  fetch?: typeof fetchUrlContentOnce;
}

/**
 * 允许的 content-type。
 *
 * 只收能被当文本读的四种。二进制（PDF、图片、字体、压缩包）在这里被拒绝，
 * 准入发生在有界响应下载之后、解码正文之前；下载仍受抓取器的大小上限约束。
 */
export const PUBLIC_DOCUMENT_ACCEPTED_CONTENT_TYPES: readonly string[] = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
];

/** 把 content-type 头规约成 `type/subtype`，丢掉参数。 */
export function normalizeDocumentContentType(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

/** 这份内容能不能被当文本读。空头在这里被拒——没有类型就没法保证不是二进制。 */
export function isSupportedDocumentContentType(raw: string): boolean {
  return PUBLIC_DOCUMENT_ACCEPTED_CONTENT_TYPES.includes(normalizeDocumentContentType(raw));
}

/**
 * 每个 hop 的准入：只走 https 普通端口，且 URL 里不带用户名密码。
 *
 * 内网/私有地址不在这里判——那是 `fetchUrlContentOnce` 的 DNS 固定机制的事，
 * 这里不重复实现，只加来源抓取不需要的这一层。
 */
function assertAllowedHop(url: URL): void {
  if (url.protocol !== "https:") {
    throw new AgentPublicDocumentError(`只允许 https，实际是 ${url.protocol}`);
  }
  // `https://x` 的 url.port 是空串，表示默认端口 443，合法。
  if (url.port !== "" && url.port !== "443") {
    throw new AgentPublicDocumentError(`只允许普通端口 443，实际是 ${url.port}`);
  }
  if (url.username || url.password) {
    throw new AgentPublicDocumentError("URL 里不允许带用户名或密码");
  }
}

/** 标题：空白归一化后截断。`fetchUrlContentOnce` 已经从 <title>/og:title 取过了。 */
function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title.replace(/\s+/g, " ").trim().slice(0, PUBLIC_DOCUMENT_MAX_TITLE);
}

/**
 * 读一份公开网页。
 *
 * 取消语义：进来之前检查一次、出 fetch 之后检查一次；再叠一层 25 秒总闸。
 * 两者用 `AbortSignal.any` 合成，所以父取消与超时**都**能打断它——
 * 只挂其中一个，另一个就会变成"设了但没用"。
 */
export async function readAgentPublicDocument(
  url: string,
  signal: AbortSignal,
  dependencies: AgentPublicDocumentDependencies = {},
): Promise<AgentPublicDocument> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new AgentPublicDocumentError("已取消");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AgentPublicDocumentError(`不是合法的 URL：${url}`);
  }
  // 初始 URL 先过一遍：它也是一次 hop，只是 hop 0。
  assertAllowedHop(parsed);

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new AgentPublicDocumentError(
      `读取公开文档超时（${PUBLIC_DOCUMENT_TIMEOUT_MS}ms，含全部重定向）`,
    )),
    PUBLIC_DOCUMENT_TIMEOUT_MS,
  );
  // any: 父取消与总闸都保留。timeoutSignal 不传 timeout 选项，
  // 免得把父信号变成 "unref 之前就不算超时"。
  const combined = AbortSignal.any([signal, timeoutController.signal]);

  const fetchOnce = dependencies.fetch ?? fetchUrlContentOnce;
  // 注入 fetch 时不挂准入钩子：那两个钩子属于真实抓取器的循环，
  // 传给一个自定义实现只会造成"看起来校验了其实没有"的错觉。
  const fetchDependencies = dependencies.fetch
    ? { includeResponseMetadata: true as const }
    : {
      includeResponseMetadata: true as const,
      validateUrl: assertAllowedHop,
      acceptContentType: (contentType: string) => {
        if (!isSupportedDocumentContentType(contentType)) {
          throw new AgentPublicDocumentError(
            `不支持的内容类型：${normalizeDocumentContentType(contentType) || "(缺失)"}；`
            + `只接受 ${PUBLIC_DOCUMENT_ACCEPTED_CONTENT_TYPES.join(" / ")}`,
          );
        }
      },
    };

  let fetched;
  try {
    fetched = await fetchOnce(url, combined, fetchDependencies);
    combined.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }

  const finalUrl = fetched.url ?? url;
  // 注入 fetch 时它可能不回报 content-type；那就不在这里编一个，
  // 但也不因为缺它就放行二进制——正文是否可读由下面的正文校验兜底。
  const body = typeof fetched.text === "string" ? fetched.text : "";
  if (body.trim().length === 0) {
    throw new AgentPublicDocumentError(
      `正文是空白：${finalUrl}（content-type=${fetched.contentType ?? "未知"}）`,
    );
  }

  // 内容身份取**完整**正文：截断上限是给模型的输入预算，改上限不该改内容身份。
  const contentHash = createHash("sha256").update(body, "utf8").digest("hex");

  // 抓取器已经清洗过正文（HTML 走 extractTextFromHtml）。这里只在清洗结果上截断，
  // 不再对 HTML 做任何二次切分——那会把标记切坏，也会把"我们截在哪"变成格式问题。
  const truncated = body.length > PUBLIC_DOCUMENT_MAX_TEXT;

  return {
    url: finalUrl,
    title: normalizeTitle(fetched.title),
    text: truncated ? body.slice(0, PUBLIC_DOCUMENT_MAX_TEXT) : body,
    truncated,
    fetchedAt: new Date().toISOString(),
    contentHash,
  };
}
