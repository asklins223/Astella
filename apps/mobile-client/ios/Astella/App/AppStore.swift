import Foundation
import Observation

/// 主声明：全部存储属性与根初始化留在本文件。
/// 各域方法按 extension 拆在 Store/ 下——SessionMethods、ConversationMethods、
/// NotesMethods、HandMethods、AccountMethods；属性不再用 private，供跨文件扩展访问。
@Observable
@MainActor
final class AppStore {
    let api = MobileAPI()
    let realtime = CompanionRealtime()
    /// 伴星 Live2D 模型下载/缓存（阶段 4a）；init 中绑定 api，见下。
    var companionModel: ModelDownloadManager

    var profile: UserProfile?
    var conversationId: String?
    var messages: [CompanionMessage] = []
    var notes: [NoteSummary] = []
    var notesNextCursor: String?
    var notesQuery = ""
    var notesRequestGeneration = 0
    var isLoadingMoreNotes = false
    var noteDocument: NoteDocument?
    var noteAnnotations: [NoteAnnotation] = []
    var isAnnotationBusy = false
    var annotationStatus: String?
    var annotationErrorMessage: String?
    var noteRequestGeneration = 0
    var annotationRequestGeneration = 0
    var annotationOperationGeneration = 0
    var runs: [ActiveRun] = []
    var selectedTab: MainTab = .conversation
    var conversationRootRevision = 0
    var chatShowsRecords = false
    var readingScale = 1.0
    var localReduceMotion = false
    var pendingNoteContext: PendingNoteContext?
    var workspaces: [WorkspaceSummary] = []
    var aiSettings: AISettings?
    var companionPermissionLevel: String?
    var accountError: String?
    var accountNotice: String?
    var isAccountBusy = false
    var streamingText = ""
    var realtimeStatus = "尚未连接"
    var isLoading = false
    var isSending = false
    var errorMessage: String?
    var notesErrorMessage: String?
    var noteErrorMessage: String?
    var authErrorMessage: String?
    var authNoticeMessage: String?
    let awarenessLaunchId = UUID().uuidString.lowercased()
    var lastInteraction = ProcessInfo.processInfo.systemUptime
    var lastObservation = ProcessInfo.processInfo.systemUptime
    var visibleNoteId: String?
    var composerHasFocus = false
    var draft = ""
    var selectedFile: CompanionFile?
    var attachmentRevision = UUID()
    var intakeGeneration = 0
    var companionEvent: CompanionEvent = .idle
    var companionEventRevision = 0
    var voicePlayback = CompanionVoicePlayback()
    var pendingTurnSignature: Data?
    var pendingTurnRequest: [String: Any]?
    var streamingRunId: String?
    var pendingSelection: String?
    var selectionRequestTitle: String?
    var selectionRunId: String?
    var openedNoteId: String?
    var selectedImage: Data?
    var selectedImageName = "手机照片.jpg"
    var voiceArtifactId: String?

    var isAuthenticated: Bool { api.token != nil }

    init() {
        companionModel = ModelDownloadManager(api: api)
        realtime.onEvent = { [weak self] event in self?.consume(event) }
        realtime.onState = { [weak self] state in self?.realtimeStatus = state }
        if api.token != nil {
            Task { await restoreSession() }
        }
    }
}

func mobileServerMessage(_ rawMessage: String?, fallback: String) -> String {
    let message = rawMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let genericMessages = ["请求错误", "请求失败", "请求没有完成，请稍后重试。", "Request failed", "Internal Server Error"]
    return message.isEmpty || genericMessages.contains(where: { message.localizedCaseInsensitiveCompare($0) == .orderedSame })
        ? fallback
        : message
}

func mobilePageError(_ error: Error, fallback: String) -> String {
    if let apiError = error as? MobileAPIError {
        let message = apiError.message.trimmingCharacters(in: .whitespacesAndNewlines)
        let genericMessages = ["请求错误", "请求失败", "请求没有完成，请稍后重试。", "Request failed", "Internal Server Error"]
        if apiError.status == 0 { return "暂时连接不上书房，请检查网络或服务地址后重试。" }
        if apiError.status == 401 { return "登录状态已过期，请重新登录。" }
        if apiError.status == 403 { return "当前账号没有权限查看这项内容。" }
        if apiError.status >= 500 { return "服务暂时忙不过来，请稍后重试。" }
        if genericMessages.contains(where: { message.localizedCaseInsensitiveCompare($0) == .orderedSame }) {
            return fallback
        }
        return message.isEmpty ? fallback : message
    }
    if let urlError = error as? URLError,
       [.timedOut, .cannotFindHost, .cannotConnectToHost, .notConnectedToInternet].contains(urlError.code) {
        return "暂时连接不上书房，请检查网络或服务地址后重试。"
    }
    let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return message.isEmpty ? fallback : message
}
