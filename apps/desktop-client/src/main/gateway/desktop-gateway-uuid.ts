/**
 * 把一个字符串解析成 uuid，**不是**就抛。
 *
 * ## 为什么它从 `DesktopGateway` 里出来（2026-09-30）
 *
 * 它原先是网关类的一个 `private` 方法，而**全类 94 个方法在调它**——
 * 每一个收 `noteId` / `objectiveId` / `runId` 的命名空间方法都要过这一道。
 * 一个被 94 处调用的东西藏在类的中段，读的人几乎不可能知道它的存在。
 *
 * 它**不碰任何状态**，所以这里就是一个自由函数：
 *
 * - **不该是 `private` 方法**——`private` 让它只能用 `this.` 调，于是每一个调用点
 *   都写成 `this.safeUuid(x)`，而这个「this」对它毫无意义。
 * - **不该挂在传输层上**——它不是请求、不是凭据、不是连接状态。挂在 `GatewayTransport`
 *   上会让那 100 多行传输层代码里混进一个与之无关的 uuid 校验。
 *
 * 所以它自己一个文件。**判据很简单：没有 `this` 的东西就不该是方法。**
 */
import { z } from "zod";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";

const uuidSchema = z.string().uuid();

export function safeUuid(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new DesktopGatewayFailure("invalid_request", "user_action");
  return parsed.data;
}
