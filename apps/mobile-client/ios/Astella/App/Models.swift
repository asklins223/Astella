import Foundation

let aiConsentVersion = "ai-consent-v1"

struct UserProfile: Equatable {
    var userId: String
    var displayName: String
    var avatarURL: String?
    var email: String
    var workspaceName: String
    var workspaceId: String
    var workspaceType: String
    var isPersonalWorkspace: Bool

    init(_ value: [String: Any]) {
        userId = value["userId"] as? String ?? ""
        displayName = value["displayName"] as? String ?? ""
        avatarURL = value["avatarUrl"] as? String
        email = value["email"] as? String ?? ""
        workspaceName = value["workspaceName"] as? String ?? "我的书房"
        workspaceId = value["workspaceId"] as? String ?? ""
        workspaceType = value["workspaceType"] as? String ?? "personal"
        isPersonalWorkspace = value["isPersonal"] as? Bool ?? true
    }
}

struct CompanionDiagramStep: Hashable, Decodable { var label: String; var detail: String? }
struct CompanionCitationTarget: Hashable, Decodable { var kind: String; var href: String?; var entityRef: String? }
struct CompanionQuoteSource: Hashable, Decodable {
    var kind: String; var noteId: String?; var noteVersionId: String?; var blockOrdinal: Int?; var sourceId: String?; var segmentOrdinal: Int?
    init?(value: [String: Any]?) {
        guard let value, let kind = value["kind"] as? String, ["note", "source"].contains(kind) else { return nil }
        self.kind = kind; noteId = value["noteId"] as? String; noteVersionId = value["noteVersionId"] as? String
        blockOrdinal = value["blockOrdinal"] as? Int; sourceId = value["sourceId"] as? String; segmentOrdinal = value["segmentOrdinal"] as? Int
    }
}
struct CompanionBlock: Hashable {
    var type: String
    var text: String?
    var url: String?
    var label: String?
    var alt: String?
    var name: String? = nil
    var proposalId: String? = nil
    var code: String? = nil
    var noteTarget: CompanionNoteTarget? = nil
    var title: String? = nil
    var steps: [CompanionDiagramStep] = []
    var front: String? = nil
    var summary: String? = nil
    var citation: CompanionCitationTarget? = nil
    var sourceRef: CompanionQuoteSource? = nil
}

struct CompanionMessage: Identifiable, Hashable {
    var id: String
    var seq: Int
    var role: String
    var blocks: [CompanionBlock]
    var createdAt: String
    var runId: String? = nil

    var displayText: String {
        blocks.compactMap { block in
            guard block.type != "file" else { return nil }
            return block.text ?? block.code
        }.joined(separator: "\n\n")
    }

    init(id: String, seq: Int, role: String, blocks: [CompanionBlock], createdAt: String, runId: String? = nil) {
        self.id = id
        self.seq = seq
        self.role = role
        self.blocks = blocks
        self.createdAt = createdAt
        self.runId = runId
    }

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String else { return nil }
        self.id = id
        seq = value["seq"] as? Int ?? 0
        role = value["role"] as? String ?? "assistant"
        createdAt = value["createdAt"] as? String ?? ""
        runId = value["runId"] as? String
        blocks = (value["blocks"] as? [[String: Any]] ?? []).map {
            CompanionBlock(
                type: $0["type"] as? String ?? "text",
                text: $0["text"] as? String,
                url: $0["url"] as? String,
                label: $0["label"] as? String,
                alt: $0["alt"] as? String,
                name: $0["name"] as? String,
                proposalId: $0["proposalId"] as? String,
                code: $0["code"] as? String,
                noteTarget: CompanionNoteTarget(route: $0["route"] as? [String: Any], title: $0["label"] as? String),
                title: $0["title"] as? String,
                steps: ($0["steps"] as? [[String: Any]] ?? []).compactMap { step in
                    guard let label = step["label"] as? String else { return nil }
                    return CompanionDiagramStep(label: label, detail: step["detail"] as? String)
                },
                front: $0["front"] as? String, summary: $0["summary"] as? String,
                citation: ($0["target"] as? [String: Any]).flatMap { target in
                    guard let kind = target["kind"] as? String else { return nil }
                    return CompanionCitationTarget(kind: kind, href: target["href"] as? String, entityRef: target["entityRef"] as? String)
                },
                sourceRef: CompanionQuoteSource(value: $0["sourceRef"] as? [String: Any])
            )
        }
    }
}

struct NoteSummary: Identifiable, Hashable {
    var id: String
    var title: String
    var updatedAt: String
    var snippet: String?

    init?(id: String, title: String, updatedAt: String = "", snippet: String? = nil) {
        guard !id.isEmpty else { return nil }
        self.id = id
        self.title = title.isEmpty ? "未命名手记" : title
        self.updatedAt = updatedAt
        self.snippet = snippet
    }

    init?(_ value: [String: Any]) {
        self.init(
            id: value["id"] as? String ?? value["objectId"] as? String ?? "",
            title: value["title"] as? String ?? "未命名手记",
            updatedAt: value["updatedAt"] as? String ?? value["indexedAt"] as? String ?? "",
            snippet: value["snippet"] as? String
        )
    }
}

struct NoteBlock: Identifiable, Hashable {
    var id: Int
    var type: String
    var content: String
}

struct NoteDocument: Equatable {
    var id: String
    var versionId: String
    var versionNumber: Int
    var title: String
    var blocks: [NoteBlock]

    init?(_ value: [String: Any]) {
        guard
            let id = value["noteId"] as? String,
            let version = value["currentVersion"] as? [String: Any]
        else { return nil }
        self.id = id
        versionId = version["versionId"] as? String ?? value["currentVersionId"] as? String ?? ""
        versionNumber = version["versionNo"] as? Int ?? 1
        title = value["title"] as? String ?? "手记"
        blocks = (version["blocks"] as? [[String: Any]] ?? []).compactMap { block in
            guard let ordinal = block["ordinal"] as? Int else { return nil }
            return NoteBlock(
                id: ordinal,
                type: block["type"] as? String ?? "paragraph",
                content: block["content"] as? String ?? ""
            )
        }
    }
}

struct NoteAnnotationAnchor: Equatable {
    var noteVersionId: String
    var startBlockOrdinal: Int
    var startOffset: Int
    var endBlockOrdinal: Int
    var endOffset: Int
    var excerpt: String
    var prefix: String
    var suffix: String

    var requestBody: [String: Any] {
        [
            "noteVersionId": noteVersionId,
            "startBlockOrdinal": startBlockOrdinal,
            "startOffset": startOffset,
            "endBlockOrdinal": endBlockOrdinal,
            "endOffset": endOffset,
            "excerpt": excerpt,
            "prefix": prefix,
            "suffix": suffix,
        ]
    }

    static func wholeBlock(_ block: NoteBlock, versionId: String) -> NoteAnnotationAnchor? {
        guard let text = renderedNoteBlockText(block), !text.isEmpty else { return nil }
        let ns = text as NSString
        let end = min(ns.length, 2_000)
        guard end > 0 else { return nil }
        return NoteAnnotationAnchor(
            noteVersionId: versionId,
            startBlockOrdinal: block.id,
            startOffset: 0,
            endBlockOrdinal: block.id,
            endOffset: end,
            excerpt: ns.substring(to: end),
            prefix: "",
            suffix: ns.substring(from: end).prefix(120).description,
        )
    }
}

struct NoteAnnotation: Identifiable, Equatable {
    var id: String
    var anchor: NoteAnnotationAnchor
    var explanation: String
    var revision: Int
    var versionState: String
    var sourceMessageId: String?
    var generationJobId: String?

    init?(_ value: [String: Any]) {
        guard let id = value["annotationId"] as? String,
              let rawAnchor = value["anchor"] as? [String: Any],
              let versionId = rawAnchor["noteVersionId"] as? String,
              let excerpt = rawAnchor["excerpt"] as? String else { return nil }
        self.id = id
        anchor = NoteAnnotationAnchor(
            noteVersionId: versionId,
            startBlockOrdinal: rawAnchor["startBlockOrdinal"] as? Int ?? 0,
            startOffset: rawAnchor["startOffset"] as? Int ?? 0,
            endBlockOrdinal: rawAnchor["endBlockOrdinal"] as? Int ?? 0,
            endOffset: rawAnchor["endOffset"] as? Int ?? 0,
            excerpt: excerpt,
            prefix: rawAnchor["prefix"] as? String ?? "",
            suffix: rawAnchor["suffix"] as? String ?? "",
        )
        explanation = value["explanation"] as? String ?? ""
        revision = value["revision"] as? Int ?? 1
        versionState = value["versionState"] as? String ?? "current"
        sourceMessageId = value["sourceMessageId"] as? String
        generationJobId = value["generationJobId"] as? String
    }
}

func renderedNoteBlockText(_ block: NoteBlock) -> String? {
    var text = block.content
    switch block.type {
    case "image", "table": return nil
    case "heading":
        text = text.replacingOccurrences(of: #"^\s*<h[1-6]\b[^>]*>"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"</h[1-6]>\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"^\s*#{1,6}\s+"#, with: "", options: .regularExpression)
    case "quote":
        text = text.replacingOccurrences(of: #"(?m)^\s*>\s?"#, with: "", options: .regularExpression)
    case "list":
        text = text.split(separator: "\n", omittingEmptySubsequences: true).map {
            String($0).replacingOccurrences(of: #"^\s*(?:[-+*]|\d+[.)])\s+"#, with: "", options: .regularExpression)
        }.joined(separator: "\n")
    default: break
    }
    text = text.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]+\)"#, with: "", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
    text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
    text = text.replacingOccurrences(of: #"(?<!\\)(?:\*{1,3}|_{1,3}|~~|`)"#, with: "", options: .regularExpression)
    for (entity, character) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&quot;", "\""), ("&#39;", "'")] {
        text = text.replacingOccurrences(of: entity, with: character)
    }
    return text
}

func noteAnnotationAnchorMatches(_ anchor: NoteAnnotationAnchor, blocks: [NoteBlock]) -> Bool {
    guard anchor.endBlockOrdinal >= anchor.startBlockOrdinal else { return false }
    let selected = blocks
        .filter { $0.id >= anchor.startBlockOrdinal && $0.id <= anchor.endBlockOrdinal }
        .sorted { $0.id < $1.id }
    guard selected.count == anchor.endBlockOrdinal - anchor.startBlockOrdinal + 1,
          let firstBlock = selected.first,
          let lastBlock = selected.last,
          let firstText = renderedNoteBlockText(firstBlock),
          let lastText = renderedNoteBlockText(lastBlock) else { return false }

    let rendered = selected.compactMap(renderedNoteBlockText)
    guard rendered.count == selected.count else { return false }
    let first = firstText as NSString
    let last = lastText as NSString
    guard anchor.startOffset >= 0, anchor.startOffset <= first.length,
          anchor.endOffset >= 0, anchor.endOffset <= last.length,
          selected.count > 1 || anchor.endOffset > anchor.startOffset else { return false }

    let excerpt = rendered.enumerated().map { index, text -> String in
        let value = text as NSString
        let start = index == 0 ? anchor.startOffset : 0
        let end = index == rendered.count - 1 ? anchor.endOffset : value.length
        guard start <= end, end <= value.length else { return "" }
        return value.substring(with: NSRange(location: start, length: end - start))
    }.joined(separator: "\n\n")
    let prefixStart = max(0, anchor.startOffset - 120)
    let prefix = first.substring(with: NSRange(location: prefixStart, length: anchor.startOffset - prefixStart))
    let suffixLength = min(120, last.length - anchor.endOffset)
    let suffix = last.substring(with: NSRange(location: anchor.endOffset, length: suffixLength))
    return excerpt == anchor.excerpt && prefix == anchor.prefix && suffix == anchor.suffix
}

struct PendingNoteContext: Equatable {
    var noteId: String
    var versionId: String
    var title: String
}

struct PendingDiaryReference: Equatable {
    var date: String
    var version: Int
}

struct WorkspaceSummary: Identifiable, Equatable {
    var id: String
    var name: String
    var role: String
    var type: String
    var isPersonal: Bool

    init?(_ value: [String: Any]) {
        guard let id = value["workspaceId"] as? String, !id.isEmpty else { return nil }
        self.id = id
        name = value["workspaceName"] as? String ?? "书房"
        role = value["role"] as? String ?? "member"
        type = value["workspaceType"] as? String ?? "personal"
        isPersonal = value["isPersonal"] as? Bool ?? false
    }
}

struct AIDataPolicy: Equatable {
    var sendToExternal: Bool
    var sendImageContent: Bool
    var piiDetection: Bool
    var auditLogging: Bool

    init(sendToExternal: Bool, sendImageContent: Bool, piiDetection: Bool, auditLogging: Bool) {
        self.sendToExternal = sendToExternal
        self.sendImageContent = sendImageContent
        self.piiDetection = piiDetection
        self.auditLogging = auditLogging
    }

    init(_ value: [String: Any]) {
        self.init(
            sendToExternal: value["sendToExternal"] as? Bool ?? false,
            sendImageContent: value["sendImageContent"] as? Bool ?? false,
            piiDetection: value["piiDetection"] as? Bool ?? true,
            auditLogging: value["auditLogging"] as? Bool ?? true
        )
    }

    var requestBody: [String: Any] {
        ["sendToExternal": sendToExternal, "sendImageContent": sendImageContent,
         "piiDetection": piiDetection, "auditLogging": auditLogging]
    }
}

struct AISettings: Equatable {
    var requiresConsent: Bool
    var consentVersion: String?
    var consentAt: String?
    var dataPolicy: AIDataPolicy

    init(_ value: [String: Any]) {
        requiresConsent = value["requiresConsent"] as? Bool ?? false
        consentVersion = value["consentVersion"] as? String
        consentAt = value["consentAt"] as? String
        dataPolicy = AIDataPolicy(value["dataPolicy"] as? [String: Any] ?? [:])
    }

    /// `requiresConsent` is the deployment capability flag: it says this server
    /// uses external AI and therefore needs a signature, and stays true for
    /// every account. The account's own signature is `consentVersion`/`consentAt`.
    var isSigned: Bool { consentVersion != nil || consentAt != nil }
    /// The account still has to read and sign the agreement before generating.
    var needsSigning: Bool { requiresConsent && !isSigned }
    /// One predicate for every AI-generation gate: signed (when required) and
    /// the data policy allows sending content to external AI.
    var canUseExternalAI: Bool { !needsSigning && dataPolicy.sendToExternal }
}

struct ActiveRun: Identifiable, Hashable {
    var id: String
    var status: String
    var stepCount: Int
    var toolCallCount: Int
    var thinkingText: String?
    var generation: Int = 0
    var userMessageId: String?
    var assistantMessageId: String?
    var createdAt: String?
    var updatedAt: String?
    var nodes: [CompanionProcessNode] = []
    var nodeCount: Int = 0
    var errorCode: String?
    var eventCursor: Int = 0
    var canResume: Bool { status == "failed" && ["PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_FIRST_OUTPUT_TIMEOUT", "PROVIDER_IDLE_TIMEOUT", "RATE_LIMITED", "JOB_DEAD", "JOB_MISSING"].contains(errorCode ?? "") }
    var progressLabel: String { isActive ? nodes.max(by: { $0.seq < $1.seq })?.label ?? statusLabel : statusLabel }
    var failureDescription: String {
        switch errorCode {
        case "PROVIDER_FIRST_OUTPUT_TIMEOUT": "模型尚未返回首段输出，等待已超时。已保存的成果仍然保留。"
        case "PROVIDER_IDLE_TIMEOUT": "模型输出中断，等待新的进展已超时。已有内容仍然保留。"
        case "RATE_LIMITED": "当前服务繁忙，请稍后从中断处继续。"
        case "CONTEXT_STALE": "资料或授权已经变化，请核对当前内容后重新发起请求。"
        default: "这次任务未能完成，原记录和已保存的成果仍然保留。"
        }
    }

    init(id: String, status: String, stepCount: Int, toolCallCount: Int, thinkingText: String?) {
        self.id = id
        self.status = status
        self.stepCount = stepCount
        self.toolCallCount = toolCallCount
        self.thinkingText = thinkingText
    }

    init?(_ value: [String: Any]) {
        guard let id = value["runId"] as? String else { return nil }
        self.id = id
        status = value["status"] as? String ?? "running"
        stepCount = value["stepCount"] as? Int ?? 0
        toolCallCount = value["toolCallCount"] as? Int ?? 0
        thinkingText = value["thinkingText"] as? String
        generation = value["generation"] as? Int ?? 0
        userMessageId = value["userMessageId"] as? String
        assistantMessageId = value["assistantMessageId"] as? String
        createdAt = value["createdAt"] as? String
        updatedAt = value["updatedAt"] as? String
        errorCode = value["errorCode"] as? String
        eventCursor = value["eventCursor"] as? Int ?? 0
        nodeCount = value["nodeCount"] as? Int ?? 0
    }

    var isActive: Bool {
        ["running", "accepted", "waiting_for_confirmation", "cancel_requested"].contains(status.lowercased())
    }

    var statusLabel: String {
        switch status.lowercased() {
        case "accepted": return "准备开始"
        case "waiting_for_confirmation": return "等你确认"
        case "cancel_requested": return "正在收尾"
        case "succeeded", "completed": return "已完成"
        case "failed": return "未完成"
        case "cancelled": return "已停止"
        default: return "进行中"
        }
    }
}

enum MainTab: String, CaseIterable {
    case conversation = "相伴"
    case library = "书房"
    case orbit = "星轨"
    case me = "我的"
}
