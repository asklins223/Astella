/**
 * 网关的「产物登记」那一族方法 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 为什么搬
 *
 * `desktop-gateway.ts` 当时 5916 行 / 248 个方法。这个命名空间的 2 个方法
 * **对类状态的依赖集合是空的**：它们只碰 `transport`（2026-09-30 已经抽出去了）。
 * 所以它们可以整体变成自由函数，第一个参数是那一个 `t: GatewayTransport`。
 *
 * ## 为什么这一步排在其他命名空间前面
 *
 * 实测（AST）：13 个命名空间里，**只有 5 个是零依赖**——其余每一个都还要用类里的
 * `private` 成员（`note` 12 个、`companion` 14 个、`auth` 11 个…）。
 * **零依赖的先搬**，每搬完一族都保持 typecheck 与 49 个主进程测试全绿；
 * 下一族有变化时，回滚的范围就只有一族。
 *
 * ## 与 `desktop-ipc.ts` 的关系
 *
 * 这些方法原先是 `gateway.foo(…)`，现在调用点是 `foo(gateway.transport, …)`。
 * **`desktop-ipc.ts` 里那一处改动与这里是同一次改动**——两边分开改会让它同时知道
 * 两套形状，比搬之前更难读。
 *
 * 下面的代码是**逐字搬移**：成员由脚本从 `desktop-gateway.ts` 按 TS AST 的精确源区间
 * 切出，只做了两处改写——签名前加 `t: GatewayTransport`（方法体里的
 * `this.transport.` 换成 `t.`）。手抄这类搬移最容易走形。
 */
import { z } from "zod";
import { ARTIFACT_MAX_BYTES } from "./artifact-surface";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import { safeUuid } from "./desktop-gateway-uuid";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function getNoteLearningArtifactHtml(t: GatewayTransport, artifactId: string, requestId?: string): Promise<string> {
    await t.ensureConnected(requestId);
    const result = await t.requestBinaryBytes(
      `/v2/note-learning-artifacts/${safeUuid(artifactId)}`,
      { method: "GET" },
      { accept: "text/html", contentTypePrefix: "text/html", maxBytes: ARTIFACT_MAX_BYTES },
      requestId,
    );
    return Buffer.from(result.bytes).toString("utf8");
  }

export async function getNoteLearningRoundArtifactHtml(t: GatewayTransport, artifactId: string, requestId?: string): Promise<string> {
    await t.ensureConnected(requestId);
    const result = await t.requestBinaryBytes(
      `/v2/note-learning-round-artifacts/${safeUuid(artifactId)}`,
      { method: "GET" },
      { accept: "text/html", contentTypePrefix: "text/html", maxBytes: ARTIFACT_MAX_BYTES },
      requestId,
    );
    return Buffer.from(result.bytes).toString("utf8");
  }
