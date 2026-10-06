/**
 * 伴星进程间通知的**通道名与载荷形状**（P1-6：中立层）。
 *
 * ## 为什么一个字符串常量值得单独一个文件
 *
 * 收口前 `COMPANION_ACCOUNT_NOTIFY_CHANNEL` 住在
 * `modules/companion-conversation/delivery/companion-notify.ts`，而
 * `modules/companion-shell/service.ts` 要用它发 `pg_notify`。
 * 这就形成了 `shell → conversation` 的一条边——与另一条
 * `conversation → shell` 的边合起来是一个环。
 *
 * 断环时**没有**把整个 `companion-notify.ts`（198 行，LISTEN/NOTIFY 的收发实现）
 * 搬走：shell 侧只需要那个通道名和载荷形状，搬整个实现过去等于把一个模块的
 * 职责搬到另一个模块名下，环虽然断了但归属还是乱的。
 *
 * 所以这里只搬**契约**（通道名 + 三个 interface），实现留在 conversation 侧，
 * 由 `companion-notify.ts` 从这里 re-export 出去——对既有调用方零变化。
 *
 * 形状类的东西（通道名、载荷）本来就该在一个中立位置：
 * 生产方与消费方各写一遍的话，改名的那天两边会错开，
 * 而症状是"通知静默不达"——没有任何异常。
 */

/** 账户维度（user/workspace epoch 变化）的专用通道。 */
export const COMPANION_ACCOUNT_NOTIFY_CHANNEL = "astella_companion_account_v1";

/** 对话增量（conversation maxSeq 推进）通道。 */
export const COMPANION_CONVERSATION_NOTIFY_CHANNEL = "astella_companion_events_v1";

/** inbox delivery 通道由 packages/shared 提供（16 §14.3），这里只做转发声明。 */
export { COMPANION_INBOX_NOTIFY_CHANNEL } from "@astella/shared/companion-conversation-contracts";

export interface CompanionNotifyPayload {
  conversationId: string;
  maxSeq: number;
}

export interface CompanionAccountNotifyPayload {
  userId: string;
  epoch: number;
}

export interface CompanionInboxNotifyPayload {
  userId: string;
}
