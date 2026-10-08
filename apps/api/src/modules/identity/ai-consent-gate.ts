import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { userAiSettings } from "@astella/shared/db-schema/identity";
import { withWorkspaceTransaction } from "../../db/client.ts";

/**
 * 外发同意门（doc 34 L13）。
 *
 * `PRODUCT.md:50` 把账号级同意写成数据出本机的**唯一**闸门：签了就在哪个空间都算同意，
 * 没签就在哪个空间都发不出去。文字那条路确实有这道门（worker 侧
 * `lib/governance.ts` 的 `sendToExternal` 判据），但语音两条路此前只有
 * `requireSession` + 限流——**TTS 要把正文发给外部合成服务，ASR 更直接把麦克风音频发出去**，
 * 一个人没签同意也能被语音路径绕过闸门。
 *
 * 判据只写一次，且与 `identity/invite-service.ts` 里那句 `ai_consent` 完全同一形状
 * （`consentAt && consentVersion`）：两处各写一份，迟早一处放宽一处收紧。
 *
 * 同意存于按用户隔离的 `user_ai_settings`；读取必须设置当前用户上下文。
 */
async function readExternalAiSettings(scope: { workspaceId: string; userId: string }) {
  const row = await withWorkspaceTransaction(scope, (tx) => tx
    .select({
      consentAt: userAiSettings.consentAt,
      consentVersion: userAiSettings.consentVersion,
      dataPolicy: userAiSettings.dataPolicy,
    })
    .from(userAiSettings)
    .where(eq(userAiSettings.userId, scope.userId))
    .limit(1));
  return row[0] ?? null;
}

function consentSigned(settings: Awaited<ReturnType<typeof readExternalAiSettings>>): boolean {
  return Boolean(settings?.consentAt && settings.consentVersion);
}

export async function hasExternalAiConsent(scope: { workspaceId: string; userId: string }): Promise<boolean> {
  return consentSigned(await readExternalAiSettings(scope));
}

/**
 * preHandler：没签同意就把请求挡在合成/转写之前，**不回退成"静默用默认"**。
 *
 * 故意不缓存：这是一次单行主键读，而"刚签完就能出声"比省一次查询值钱；
 * 反过来把同意状态缓存在进程里，就会造出"界面上已同意、这一路还拒绝"的第二个来源。
 */
export async function requireAiConsent(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const settings = await readExternalAiSettings(req.session);
  if (consentSigned(settings)) {
    if (settings?.dataPolicy.sendToExternal === true) return;
    await reply.code(403).send({
      error: "ai_data_policy_denied",
      message: "外部 AI 已关闭，请在 AI 数据同意页开启「允许发送到外部模型服务」后继续。",
    });
    return;
  }
  // 403 + 一个可判定的错误码：桌面端据此说"先去设置里同意"，而不是"语音坏了"。
  await reply.code(403).send({
    error: "ai_consent_required",
    message: "还没有同意使用 AI 服务，请先在设置中确认后再使用 AI 功能。",
  });
}
