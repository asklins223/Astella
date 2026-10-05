/**
 * HTML → 正文/标题的提取。与 `parse-source.ts` 里的抓取机制（DNS 钉住、
 * 重定向逐跳校验、解压、大小上限）无关，所以单独成文件。
 *
 * 2026-10-05 从 `parse-source.ts` 拆出。动因是那条「神文件清单不增」的棘轮：
 * 该文件已近 1900 行，而 HTML 提取这一整块（约 430 行）本来就自包含——零外部依赖，
 * 只用到自己的三个 class 模式表和六个纯字符串函数。棘轮要求拆，不接受调大基线。
 *
 * 本文件全是纯字符串处理：不发请求、不碰网络、不读文件系统。
 */

/** 跨文件用到的两个；原先同处 parse-source.ts，未导出。 */
/**
 * 移除所有带指定 class 模式的 HTML 元素（含内容），支持嵌套同类标签。
 * 用简单的深度计数器找到匹配的闭合标签。
 * 先收集所有匹配区间的边界，再做单次重建，避免逐个匹配时反复
 * slice 拼接整个字符串导致 O(n^2)。
 */
function removeElementsByClass(
  html: string,
  tagName: string,
  classPattern: string,
  signal?: AbortSignal,
): string {
  const tagRe = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
  // Single-pass stack walk.  The former implementation restarted tagRe from
  // every matching opening tag, so deeply nested/repetitive markup could make
  // one class removal quadratic before the next class was even inspected.
  const stack: Array<{ start: number; matched: boolean }> = [];
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("HTML extraction aborted");
    }
    const tag = match[0];
    if (tag.startsWith("</")) {
      const entry = stack.pop();
      if (entry?.matched) ranges.push([entry.start, tagRe.lastIndex]);
      continue;
    }
    if (/\/\s*>$/.test(tag)) continue;
    const classMatch = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const classValue = classMatch?.[1] ?? classMatch?.[2] ?? "";
    stack.push({
      start: match.index,
      matched: classValue.split(/\s+/).includes(classPattern),
    });
  }
  if (ranges.length === 0) return html;

  // Nested matching containers produce overlapping ranges.  Merge them so a
  // single outer removal is emitted and the rebuild never duplicates gaps.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // 单次重建：按区间拼接保留片段
  const parts: string[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) parts.push(html.slice(pos, start));
    parts.push(" ");
    pos = end;
  }
  if (pos < html.length) parts.push(html.slice(pos));
  return parts.join("");
}

/**
 * 常见正文容器 class 模式（按优先级排列）。
 * 用于无 <article>/<main> 标签时，通过 class 定位正文区域。
 */
const CONTENT_CLASS_PATTERNS = [
  "opus-module-content",   // Bilibili opus
  "rich_media_content",    // 微信公众号正文容器
  "article-content",       // 通用
  "post-content",          // WordPress 等
  "entry-content",         // WordPress
  "rich-text",             // 富文本编辑器
  "content-body",          // 通用
  "markdown-body",         // GitHub 等
  "post-body",             // 博客
  "article-body",          // 新闻站
  "ql-editor",             // Quill 编辑器
  "read-content",          // Readability
];

interface ContentClassRange {
  patternIndex: number;
  start: number;
  end: number;
}

/**
 * Find all content containers in one tag pass.  The old implementation ran a
 * full tag scan for every matching opening tag, which becomes O(n²) on pages
 * with many nested containers.  This stack walk is linear and checks the
 * request abort signal between tags so a pathological document is bounded.
 */
function collectContentClassRanges(
  html: string,
  patterns: readonly string[],
  signal?: AbortSignal,
): ContentClassRange[] {
  const tagRe = /<(\/)?(div|section|article)\b[^>]*>/gi;
  const stack: Array<{ tagName: string; contentStart: number; patternIndex: number }> = [];
  const ranges: ContentClassRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("HTML extraction aborted");
    }
    const closing = Boolean(match[1]);
    const tagName = match[2]!.toLowerCase();
    const tag = match[0];
    if (closing) {
      let closeIndex = stack.length - 1;
      while (closeIndex >= 0 && stack[closeIndex]!.tagName !== tagName) closeIndex -= 1;
      if (closeIndex < 0) continue;
      for (let i = stack.length - 1; i >= closeIndex; i -= 1) {
        const entry = stack[i]!;
        if (entry.patternIndex >= 0) {
          ranges.push({ patternIndex: entry.patternIndex, start: entry.contentStart, end: match.index });
        }
      }
      stack.length = closeIndex;
      continue;
    }
    if (/\/\s*>$/.test(tag)) continue;
    const classMatch = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    const classTokens = classMatch?.[2]?.split(/\s+/).filter(Boolean) ?? [];
    const patternIndex = patterns.findIndex((pattern) => classTokens.includes(pattern));
    stack.push({ tagName, contentStart: tagRe.lastIndex, patternIndex });
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * 常见噪声元素 class 模式，提取前移除以减少干扰。
 */
const NOISE_CLASS_PATTERNS = [
  "opus-toc",              // Bilibili 目录
  "table-of-contents",     // 通用目录
  "toc",
  "share",                 // 分享栏
  "comment",               // 评论区
  "sidebar",               // 侧边栏
  "breadcrumb",            // 面包屑
  "pagination",            // 分页
  "related-post",          // 相关推荐
  "recommend",             // 推荐栏
  "opus-pic-view__caption", // Bilibili 图片默认说明文字（"图片"）
  // 微信公众号噪声元素
  // 注意：removeElementsByClass 用 \b 做单词边界匹配，_ 是 \w 字符，
  // 所以 \b 在 _ 前后不会匹配。必须用完整 class 名，不能用前缀。
  "mp_profile_iframe_wrp",            // 作者名片
  "rich_media_area_extra",            // 底部推荐区
  "rich_media_info",                  // 底部信息栏
  "rich_media_tool__wrp",             // 底部工具栏容器（点赞、分享等）
  "rich_media_tool_area",             // 底部工具栏区域
  "qr_code_pc_outer",                 // 二维码外层容器
  "weui-dialog",                      // 弹窗/对话框（\b 匹配 weui-dialog weui-dialog_link）
  "weui-mask",                        // 遮罩层
  "wx_network_msg_wrp",               // 网络消息提示
  "comment_primary_emotion_panel_wrp",// 评论表情面板
  "wx-edui-video_source_link",        // 视频号来源链接
  "jump_author_avatar",               // 作者头像跳转
  "jump_wx_qrcode_desc",              // 二维码描述
  "bottom_bar_wrp",                   // 底部操作栏
  "outer_dialog",                     // 外部对话框
  "sns_opr_gap",                      // 社交操作间距
  "media_tool_meta",                  // 媒体工具元信息
];

/**
 * 代码块 UI 噪声 class 模式。
 * 这些元素是代码高亮组件的 UI 控件（工具栏、行号、复制按钮、提示通知等），
 * 不属于正文内容，提取前移除以减少噪声。
 * 对 div 和 span 两种标签都尝试移除。
 */
const CODE_NOISE_CLASS_PATTERNS = [
  // Bilibili 代码块 UI（div + span 混合标签）
  // code-block-header 是工具栏外层 div，移除后内部的 label/lang/actions 一起消失。
  // 以下 label/lang/line-number 作为安全网：当 HTML 结构变化或 header 未匹配时
  // 仍能逐个清除噪声 span。
  "code-block-header",       // div: 工具栏（代码块标签、语言标签、自动换行、复制代码）
  "code-block-gutter",       // div: 行号容器（移除后行号 span 一起消失）
  "code-block-line-numbers", // div: Bilibili 行号容器（复数形式，\b 无法匹配单数 pattern）
  "code-block-toast",        // div: "复制成功" 提示
  "code-block-label",        // span: "代码块" 文字标签
  "code-block-lang",         // span: 语言标签（如 PlainText）
  "code-block-line-number",  // span: 行号
  // 通用代码高亮库 UI（仅移除 UI 控件，不移除包含代码的外层容器）
  // 注意：不加 "toolbar"——太宽泛，\btoolbar\b 会匹配 page-toolbar、action-toolbar
  // 等非代码元素，造成误杀。如需 highlight.js toolbar 支持应使用更具体的模式。
  "copy-button",            // div/span: 通用复制按钮
];

/**
 * 解码数学公式图片的 alt 文本。
 * Bilibili 等平台将 LaTeX 公式 URL-encode 后存入 alt 属性，
 * 例如 alt="x%E2%80%99_i" 实际表示 x'_i。
 */
function decodeFormulaAlt(alt: string): string {
  try {
    return decodeURIComponent(alt);
  } catch {
    return alt;
  }
}

/**
 * 将 <img> 的 src 和 alt 转为 markdown 图片语法，解析相对 URL。
 * 跳过 data: URI 和空 src。
 * 解码 HTML 实体（如 &amp; → &），微信公众号图片 URL 常含 &amp;。
 */
function imgReplacement(src: string, alt: string, baseUrl?: string): string {
  const trimmedSrc = decodeHtmlEntities(src.trim());
  if (!trimmedSrc || trimmedSrc.startsWith("data:")) return "";
  let resolved = trimmedSrc;
  if (baseUrl) {
    try {
      resolved = new URL(trimmedSrc, baseUrl).href;
    } catch {
      return "";
    }
  }
  const cleanAlt = alt.trim() || "图片";
  return `\n![${cleanAlt}](${resolved})\n`;
}

/**
 * R-014: 从 HTML 中提取纯文本。
 * 改进：
 * - 支持 <article>/<main> 标签和常见正文 class 容器
 * - 移除常见噪声元素（目录、分享栏、评论区等）
 * - 保留 <img> alt 文本（数学公式等以图片形式展示）
 * - 更激进的空白行压缩
 */
export function extractTextFromHtml(html: string, baseUrl?: string, signal?: AbortSignal): string {
  // Step 1: 预清理 — 移除 script/style/noscript
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // 移除语义化噪声标签
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // Step 2: 移除噪声元素（按 class 模式）
  for (const noise of NOISE_CLASS_PATTERNS) {
    cleaned = removeElementsByClass(cleaned, "div", noise, signal);
  }

  // Step 2b: 移除代码块 UI 元素（工具栏、行号、复制按钮、提示通知等）
  // 这些元素同时包含 div 和 span 标签，需要分别处理
  for (const noise of CODE_NOISE_CLASS_PATTERNS) {
    cleaned = removeElementsByClass(cleaned, "div", noise, signal);
    cleaned = removeElementsByClass(cleaned, "span", noise, signal);
  }

  // Step 3: 处理 <img> 标签
  // 数学公式图片（class 含 formula）→ 解码 alt 文本（URL-encoded），用 $...$ 包裹为行内公式
  // 内容图片（有 src 或 data-src）→ 转为 markdown ![alt](url) 以便后续下载上传
  cleaned = cleaned
    // 数学公式图片：解码 alt 文本（Bilibili 的 alt 是 URL-encoded LaTeX），用 $...$ 包裹
    .replace(/<img[^>]*class="[^"]*formula[^"]*"[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => `$${decodeFormulaAlt(alt)}$`)
    .replace(/<img[^>]*alt="([^"]*)"[^>]*class="[^"]*formula[^"]*"[^>]*>/gi, (_, alt) => `$${decodeFormulaAlt(alt)}$`)
    .replace(/<img[^>]*class="[^"]*formula[^"]*"[^>]*alt='([^']*)'[^>]*>/gi, (_, alt) => `$${decodeFormulaAlt(alt)}$`)
    // 内容图片：转为 markdown 图片语法
    // data-src 优先于 src：部分平台（微信公众号）用 data-src 懒加载真实图片 URL，
    // src 可能为占位图或缺失。先匹配 data-src 再匹配 src，确保使用真实 URL。
    .replace(/<img[^>]*data-src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, (_, src, alt) => imgReplacement(src, alt, baseUrl))
    .replace(/<img[^>]*alt="([^"]*)"[^>]*data-src="([^"]*)"[^>]*>/gi, (_, alt, src) => imgReplacement(src, alt, baseUrl))
    .replace(/<img[^>]*data-src="([^"]*)"[^>]*>/gi, (_, src) => imgReplacement(src, "图片", baseUrl))
    // src 图片（data-src 已在上一步处理，不含 data-src 的图片走此分支）
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, (_, src, alt) => imgReplacement(src, alt, baseUrl))
    .replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, (_, alt, src) => imgReplacement(src, alt, baseUrl))
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => imgReplacement(src, "图片", baseUrl))
    // 移除剩余无 src/data-src 的 img 标签
    .replace(/<img[^>]*>/gi, "");

  // Step 4: 尝试提取正文区域
  let contentHtml: string;

  // 4a: <article> 标签（取最长匹配）
  const articleMatches = [...cleaned.matchAll(/<article[\s\S]*?<\/article>/gi)];
  const articleContent = articleMatches.length > 0
    ? articleMatches.reduce((a, b) => a[0].length > b[0].length ? a : b)[0]
    : null;

  // 4b: <main> 标签
  const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i);

  // 4c: 按 class 模式提取正文容器。单次栈扫描，避免每个 class/open tag
  // 再次从头扫描整份 HTML。
  let classContent: string | null = null;
  const classRanges = collectContentClassRanges(cleaned, CONTENT_CLASS_PATTERNS, signal);
  for (let patternIndex = 0; patternIndex < CONTENT_CLASS_PATTERNS.length; patternIndex += 1) {
    const parts = classRanges
      .filter((range) => range.patternIndex === patternIndex)
      .map((range) => cleaned.slice(range.start, range.end));
    if (parts.length > 0) {
      const joined = parts.join("\n\n");
      const previewText = joined.replace(/<[^>]+>/g, "").trim();
      if (previewText.length >= 200) {
        classContent = joined;
        break;
      }
    }
  }

  contentHtml = articleContent || mainMatch?.[0] || classContent || cleaned;

  // fallback：如果提取后的纯文本过短（< 200 字符），回退到全文
  if (contentHtml !== cleaned) {
    const previewText = contentHtml.replace(/<[^>]+>/g, "").trim();
    if (previewText.length < 200) {
      contentHtml = cleaned;
    }
  }

  // 代码块用占位符替换，在空白清理后还原，以保留代码缩进。
  // 否则 .replace(/^[ \t]+/gm, "") 会剥离代码块内的行首缩进。
  const codeBlocks: string[] = [];

  return contentHtml
    // Step 5: 代码块 <pre>...</pre> → 占位符（在标签剥离前提取，保留代码内容）
    // 微信公众号代码块结构：<section style="background:..."><pre>●●●<code>tokens</code></pre></section>
    // 语法高亮把每个 token 放在嵌套 <span> 中，token 间无空格，需要手动插入。
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
      let code = content
        // 移除彩色圆点（macOS 窗口控制装饰）
        .replace(/●/g, "")
        // <br> 转换行（在标签剥离前处理，保留代码换行）
        .replace(/<br\s*\/?>/gi, "\n")
        // 微信语法高亮：<span style="color:..."><span leaf="">token</span></span>
        // 相邻 token 间无空格，在双闭合 </span></span> 处插入空格
        .replace(/<\/span><\/span>/gi, " ")
        // 剥离所有剩余 HTML 标签（语法高亮 span、code 标签等）
        .replace(/<[^>]+>/g, "");
      // 解码 HTML 实体（&nbsp; → 空格等）
      code = decodeHtmlEntities(code);
      // 清理 token 间空格：移除标点前的空格，折叠多余空格
      // 注意：用 [ \t] 而非 \s，避免吞掉换行符导致代码行合并
      code = code
        .replace(/[ \t]+([,.;:()\[\]{}])/g, "$1")
        .replace(/([.\[{(])[ \t]+/g, "$1")
        .replace(/([^ \n]) {2,}/g, "$1 ")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
      if (!code.trim()) return "";
      codeBlocks.push(code.trim());
      return `\n\u0000CODEBLOCK${codeBlocks.length - 1}\u0000\n`;
    })
    // Step 5b: 行内 <code> → backtick 包裹（在 <pre> 占位后处理，避免重复匹配）
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
      const decoded = decodeHtmlEntities(code.replace(/<[^>]+>/g, "")).trim();
      return decoded ? `\`${decoded}\`` : "";
    })
    // Step 6: 块级标签转换为换行
    .replace(/<\/?(p|div|br|h[1-6]|li|ul|ol|blockquote|pre|tr|table)[^>]*>/gi, "\n")
    // Step 7: 移除所有其他 HTML 标签
    .replace(/<[^>]+>/g, "")
    // Step 8: 解码常见 HTML 实体
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Step 9: 去除每行首尾空白（减少缩进噪声）
    .replace(/^[ \t]+/gm, "")
    .replace(/[ \t]+$/gm, "")
    // Step 10: 压缩空白：移除纯空白行，折叠连续空行
    .replace(/\n[ \t]*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    // Step 11: 还原代码块占位符为 markdown 代码块
    .replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => `\n\`\`\`\n${codeBlocks[Number(i)]}\n\`\`\`\n`)
    // Step 12: 将独占一行的 $...$ 升级为块级公式 $$...$$
    .replace(/^\$([^$\n]+)\$$/gm, (_, formula) => `$$${formula}$$`)
    .trim();
}

/**
 * 解码常见 HTML 实体。与 extractTextFromHtml 中的实体解码保持一致。
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * 从 HTML 中提取标题。优先 og:title，其次 <title>。
 * 定义在 parse-source.ts 模块级别，仅由 fetchUrlContentOnce 调用
 * （在 extractTextFromHtml 剥离标签前从原始 HTML 提取标题）。
 */
export function extractHtmlTitle(html: string): string | null {
  // 性能优化：og:title 和 <title> 都在 <head> 中，先截取 <head> 部分可减少
  // 正则在 500KB HTML 上的扫描范围。如 <head> 不存在则回退到全文匹配。
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch?.[1] ?? html;

  // og:title：先匹配整个 <meta> 标签，再从中提取 content 属性，
  // 避免假设 property/name 在 content 之前（部分 HTML 中属性顺序可能反转）。
  const ogTagMatch = head.match(/<meta\s+[^>]*?(?:property|name)=["']og:title["'][^>]*?>/i);
  if (ogTagMatch?.[0]) {
    // 使用反向引用 (\1) 匹配与开头相同类型的引号，
    // 使标题中可以包含另一种引号（如 content="John's Blog" 不被截断）。
    const contentMatch = ogTagMatch[0].match(/content=(["'])([\s\S]*?)\1/i);
    if (contentMatch?.[2]?.trim()) {
      // 解码 HTML 实体并归一化空白（与 <title> 路径一致）
      return decodeHtmlEntities(contentMatch[2].trim()).replace(/\s+/g, " ").slice(0, 100);
    }
  }
  // 使用 [\s\S]*? 非贪婪匹配，支持标题中含 < 字符（如 <title>A < B</title>）。
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) {
    // 解码 HTML 实体（如 &amp; → &），与 extractTextFromHtml 的实体解码一致
    return decodeHtmlEntities(titleMatch[1].trim()).replace(/\s+/g, " ").slice(0, 100);
  }
  return null;
}
