import Foundation

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 对话域首批 Codable DTO。字段与 shared 合同逐字段互指，改动顺序：          │
// │ 先改 packages/shared/src/contracts/，再同步这里。                        │
// │                                                                         │
// │ 来源 schema（packages/shared/src/contracts/）：                          │
// │  · companion-conversation-contracts.ts                                  │
// │    - companionConversationV1Schema（inbox/ensure 响应）                  │
// │    - companionMessageV1Schema（消息列表项）                              │
// │    - companionContentBlockV1Schema（消息块 discriminatedUnion）          │
// │    - createCompanionTurnResponseV1Schema（turn 提交响应）                │
// │  · companion-chat-desktop-contracts.ts                                  │
// │    - companionChatListMessagesResultV1Schema（消息列表响应信封）         │
// │    - companionRunNodesListResultV1Schema（run-nodes 快照）               │
// │    - companionRunSummaryV1Schema（run 摘要，runs[] 元素）                │
// │                                                                         │
// │ 只建模本次移动端实际读取的字段；未读取的信封字段（hasMore/oldestSeq/     │
// │ version/items 节点窗口等）与 WS 字典事件暂不建模，随用随补。              │
// └─────────────────────────────────────────────────────────────────────────┘

/// POST /companion/inbox/ensure 响应——移动端只用 `id` 定位会话。
/// 来源：companion-conversation-contracts.ts · companionConversationV1Schema
struct CompanionInboxDTO: Decodable {
    /// companionConversationV1Schema.id
    let id: String
}

/// GET /companion/conversations/:id/messages 响应信封。
/// 来源：companion-chat-desktop-contracts.ts · companionChatListMessagesResultV1Schema
struct CompanionMessagePageDTO: Decodable {
    /// companionChatListMessagesResultV1Schema.items
    /// （同 schema 的 version / hasMore / oldestSeq 本次未读取，暂不建模）
    let items: [CompanionMessageDTO]
}

/// 消息列表项。来源：companion-conversation-contracts.ts · companionMessageV1Schema
struct CompanionMessageDTO: Decodable {
    /// companionMessageV1Schema.id（uuid；缺项按合同不会出现，解码失败整页上抛）
    let id: String
    /// companionMessageV1Schema.seq（会话内单调递增）
    let seq: Int
    /// companionMessageV1Schema.role（"user" | "assistant" | "system"）
    let role: String
    /// companionMessageV1Schema.createdAt（ISO 8601）
    let createdAt: String
    let runId: String?
    /// companionMessageV1Schema.blocks → companionContentBlockV1Schema
    /// 块级只取渲染在用的五个字段；其余键（assetId、quote 引用等）解码时忽略
    let blocks: [CompanionMessageBlockDTO]
}

/// 单个内容块。来源：companion-conversation-contracts.ts · companionContentBlockV1Schema
/// （discriminatedUnion 按 type 分派：text/quote/image/…；这里按 iOS 渲染所需字段收口）
struct CompanionMessageBlockDTO: Decodable {
    /// block.type（"text" | "image" | "quote" | …；与旧字典路径一致，缺省按 "text" 渲染）
    let type: String?
    /// block.text（text / quote 块正文）
    let text: String?
    /// block.url（image 块地址）
    let url: String?
    /// block.label（image 块展示名）
    let label: String?
    /// block.alt（image 块替代文本）
    let alt: String?
    let name: String?
    let proposalId: String?
    let code: String?
}

/// GET /companion/conversations/:id/run-nodes 响应快照。
/// 来源：companion-chat-desktop-contracts.ts · companionRunNodesListResultV1Schema
struct CompanionRunNodesSnapshotDTO: Decodable {
    /// companionRunNodesListResultV1Schema.latestSeq（WS 游标起点）
    let latestSeq: Int
    /// companionRunNodesListResultV1Schema.runs（元素见 CompanionRunSummaryDTO；
    /// 同 schema 的 items 节点窗口本次未读取，暂不建模）
    let runs: [CompanionRunSummaryDTO]
}

/// 一轮 run 的摘要。来源：companion-chat-desktop-contracts.ts · companionRunSummaryV1Schema
struct CompanionRunSummaryDTO: Decodable {
    /// companionRunSummaryV1Schema.runId
    let runId: String
    /// companionRunSummaryV1Schema.status（"accepted" | "running" | … 见 companionRunStatusV1Schema）
    let status: String
    /// companionRunSummaryV1Schema.stepCount（服务端记录的真实消耗）
    let stepCount: Int
    /// companionRunSummaryV1Schema.toolCallCount
    let toolCallCount: Int
    /// companionRunSummaryV1Schema.thinkingText（nullable + optional，仅 includeThinking 时返回）
    let thinkingText: String?
}

/// POST /companion/conversations/:id/turns 响应（移动端当前只校验形状、不读字段）。
/// 来源：companion-conversation-contracts.ts · createCompanionTurnResponseV1Schema
struct CompanionTurnSubmitResponseDTO: Decodable {
    /// createCompanionTurnResponseV1Schema.version（literal 1）
    let version: Int
    /// createCompanionTurnResponseV1Schema.conversationId
    let conversationId: String
    /// createCompanionTurnResponseV1Schema.clientMessageId（回显提交时的幂等键）
    let clientMessageId: String
    /// createCompanionTurnResponseV1Schema.userMessageId
    let userMessageId: String
    /// createCompanionTurnResponseV1Schema.runId
    let runId: String
    /// createCompanionTurnResponseV1Schema.generation（活动 run 接替需精确相等）
    let generation: Int
    /// createCompanionTurnResponseV1Schema.status（幂等重放返回真实终态）
    let status: String
    /// createCompanionTurnResponseV1Schema.eventCursor
    let eventCursor: Int
}
