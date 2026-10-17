/**
 * 把一个 File 读成纯 base64（不带 `data:` 前缀）。
 *
 * 上传通道要的是 base64 字节（渲染层不碰网络，字节交给 main 以 multipart 送出）。
 * 这里用 FileReader 而不是 `file.arrayBuffer()`：前者在本项目的两个宿主里都在，
 * 后者在测试环境（jsdom）的 File 上不存在——同一条链路不该在真实窗口能跑、
 * 在测试里静默失败。
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
