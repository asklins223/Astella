import { createRequestMeta } from "./desktop-client";

/** 桌面权限策略限制 Web Clipboard API，应用里的复制通过主进程完成。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.ailearn) {
      const result = await window.ailearn.clipboard.writeText({ meta: createRequestMeta(), request: { text } });
      return result.ok && result.data.written;
    }
    // 浏览器预览没有 preload，仍可使用浏览器自己的剪贴板能力。
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
