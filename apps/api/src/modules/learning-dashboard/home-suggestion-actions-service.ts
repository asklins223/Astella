/**
 * 首页「换一个／暂不处理」的**落库那一发**（39d W7-4 刀五；39 §12.1）。
 *
 * 刀四的判据把 `dismissedThisSession` 写成**入参**，于是那一格从哪来仍然没人答——
 * 两颗按钮按下去不落库，下一刷首页还推同一件。这一份是那个入参唯一的出处。
 *
 * ## 为什么按**日历日**有界，而不是永久黑名单
 *
 * 永久黑名单是省事写法，而那正是 §12.1 明确**不**要的：她今天不想做"用几个小问题回访
 * 这篇笔记"，明天那件事又到期了，首页却再也不提——**建议变成了一个慢慢烂掉的角落**。
 * 只放前端内存也不行：刷新一次页面就回来了，而"我说了暂不处理"是**她刚做过的一个
 * 决定**，刷新不该撤销它。
 *
 * 边界取她的日历日，与 §9.4「本批」的边界同源：**明天那件事重新变成候选，而要重新
 * 推荐它有一个说得出的理由——新的一天。**
 *
 * ## 「换一个」与「暂不处理」都要记，但记不同的话
 *
 * 两颗按钮屏上要念不同的话，所以 `action` 有两档而不是一档。而**「换一个」也要让那一项
 * 本次不再排在最前**——否则点它等于没点（下一刷还是它）。两档都进 `dismissedThisSession`
 * 交给判据，差别留给屏上的文案与日志。
 */
import { and, eq } from "drizzle-orm";
import { homeSuggestionDismissalsV2 } from "@astella/shared/db-schema/evidence";
import { dayKeyForV2 } from "./daily-batch-lock-service.ts";

export type ApiTx = Parameters<Parameters<typeof import("../../db/client.ts").withWorkspaceTransaction>[1]>[0];

export type HomeSuggestionActionV2 = "swapped" | "dismissed";

/**
 * 记一次「换一个」或「暂不处理」。**幂等**：同一项同一天点两下只留一行，且以**最后
 * 一次**为准（`dismissed` 覆盖 `swapped`）——屏上只念最后一次。
 */
export async function recordHomeSuggestionActionV2(
  tx: ApiTx,
  input: {
    workspaceId: string;
    userId: string;
    timeZone: string;
    now: Date;
    itemKey: string;
    action: HomeSuggestionActionV2;
  },
): Promise<{ itemKey: string; action: HomeSuggestionActionV2 }> {
  const dayKey = dayKeyForV2(input.now, input.timeZone);
  await tx
    .insert(homeSuggestionDismissalsV2)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      dayKey,
      itemKey: input.itemKey,
      action: input.action,
    })
    .onConflictDoUpdate({
      target: [
        homeSuggestionDismissalsV2.workspaceId,
        homeSuggestionDismissalsV2.userId,
        homeSuggestionDismissalsV2.dayKey,
        homeSuggestionDismissalsV2.itemKey,
      ],
      set: { action: input.action, createdAt: input.now },
    });
  return { itemKey: input.itemKey, action: input.action };
}

/**
 * 读**今天**她已经略过的那几项，交给刀四的判据当 `dismissedThisSession`。
 *
 * 只读**今天**——这一格是整个「本次不反复推荐」的落点，读成"她历史上略过的所有项"
 * 就变回永久黑名单了。
 */
export async function dismissedHomeItemsForTodayV2(
  tx: ApiTx,
  input: { workspaceId: string; userId: string; timeZone: string; now: Date },
): Promise<string[]> {
  const rows = await tx
    .select({ itemKey: homeSuggestionDismissalsV2.itemKey })
    .from(homeSuggestionDismissalsV2)
    .where(and(
      eq(homeSuggestionDismissalsV2.workspaceId, input.workspaceId),
      eq(homeSuggestionDismissalsV2.userId, input.userId),
      eq(homeSuggestionDismissalsV2.dayKey, dayKeyForV2(input.now, input.timeZone)),
    ));
  return rows.map((row) => row.itemKey);
}
