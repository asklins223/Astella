import Foundation
import Observation

enum StartupLoadState: Equatable {
    case idle, loading, ready, failed
}

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
    var recentNoteId: String?
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
    var orbitRootSection = "diary"
    var conversationRootRevision = 0
    var chatShowsRecords = false
    var readingScale = 19.0 / 16.0
    var localReduceMotion = false
    var pendingNoteContext: PendingNoteContext?
    var pendingDiaryReference: PendingDiaryReference?
    var workspaces: [WorkspaceSummary] = []
    var aiSettings: AISettings?
    var companionPermissionLevel: String?
    var accountError: String?
    var accountNotice: String?
    var isAccountBusy = false
    var streamingText = ""
    var realtimeStatus = "尚未连接"
    var isLoading = false
    var startupLoadState: StartupLoadState = .idle
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
    var composerFocusRequestID = 0
    var pendingNoteReferenceID: String?
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

    #if DEBUG
    var uiReviewMode: String?
    #endif

    var isAuthenticated: Bool { api.token != nil }

    init() {
        companionModel = ModelDownloadManager(api: api)
        realtime.onEvent = { [weak self] event in self?.consume(event) }
        realtime.onState = { [weak self] state in self?.realtimeStatus = state }
        #if DEBUG
        let uiReviewMode = ProcessInfo.processInfo.environment["ASTELLA_UI_REVIEW"]
            ?? CommandLine.arguments.first(where: { $0.hasPrefix("--ui-review=") })?.replacingOccurrences(of: "--ui-review=", with: "")
        if ["auth-login", "auth-register", "auth-register-password", "auth-register-code", "auth-forgot", "auth-reset", "auth-reset-password", "auth-email-login", "auth-email-login-code"].contains(uiReviewMode ?? "") {
            self.uiReviewMode = uiReviewMode
        } else if ["conversation", "records", "library", "orbit", "orbit-memory", "orbit-tasks", "read", "me", "settings", "profile", "companion-settings", "reading-settings", "device-permissions", "ai-authorization", "server-address", "conventions", "companion-center", "change-password"].contains(uiReviewMode ?? "") {
            let reviewTime = ISO8601DateFormatter()
            self.uiReviewMode = uiReviewMode
            profile = UserProfile([
                "userId": "open-design-review",
                "displayName": "林夏",
                "email": "lin.xia@mail.com",
                "workspaceName": "高二语文",
                "workspaceId": "open-design-review",
                "workspaceType": "personal",
                "isPersonal": true,
            ])
            conversationId = "open-design-review"
            if let note = NoteSummary(id: "open-design-redwall", title: "赤壁赋", updatedAt: "2026-10-19", snippet: "先把改写放在这里。你确认后我才写回原文。") {
                notes = [note]
                recentNoteId = note.id
            }
            messages = [
                CompanionMessage(
                    id: "open-design-first-greeting",
                    seq: 1,
                    role: "assistant",
                    blocks: [CompanionBlock(type: "text", text: "你来啦。今天想聊聊，还是接着读昨天那一页？")],
                    createdAt: reviewTime.string(from: Date().addingTimeInterval(-40))
                ),
                CompanionMessage(
                    id: "open-design-reading-prompt",
                    seq: 2,
                    role: "user",
                    blocks: [CompanionBlock(type: "text", text: "一起读吧。那句「水波不兴」，我还想再听你说说。")],
                    createdAt: reviewTime.string(from: Date().addingTimeInterval(-24))
                ),
                CompanionMessage(
                    id: "open-design-greeting",
                    seq: 3,
                    role: "assistant",
                    blocks: [CompanionBlock(type: "text", text: "风很轻，水面安静得没有波纹。我们就从这份安静里，慢慢读下去。")],
                    createdAt: reviewTime.string(from: Date().addingTimeInterval(-8))
                ),
            ]
            if uiReviewMode == "companion-center", let latestIndex = messages.indices.last {
                messages[latestIndex].blocks = [CompanionBlock(
                    type: "text",
                    text: "搜到了，标题念给你：\n- **瑞利散射的适用条件**\n- **瑞利散射与天空的颜色**\n- **AI 延迟验证：瑞利散射**"
                )]
            }
            companionModel.state = .failed
            aiSettings = AISettings([
                "requiresConsent": false,
                "consentVersion": "v2.3",
                "consentAt": "2026-10-12T21:16:00Z",
                "dataPolicy": [
                    "sendToExternal": true,
                    "sendImageContent": true,
                    "piiDetection": true,
                    "auditLogging": false,
                ],
            ])
            switch uiReviewMode {
            case "records": chatShowsRecords = true
            case "library": selectedTab = .library
            case "orbit": selectedTab = .orbit
            case "orbit-memory": selectedTab = .orbit; orbitRootSection = "memory"
            case "orbit-tasks": selectedTab = .orbit; orbitRootSection = "hand"
            case "read": selectedTab = .library
            case "me": selectedTab = .me
            case "settings", "profile", "companion-settings", "reading-settings", "device-permissions", "ai-authorization", "server-address", "conventions", "companion-center", "change-password": selectedTab = .me
            default: break
            }
            if uiReviewMode == "read" {
                if let linkedNote = NoteSummary(
                    id: "e1199b07-2a56-44fc-bba2-ae8d66af33cf",
                    title: "无标题笔记",
                    updatedAt: "2026-10-18",
                    snippet: "另一篇手记，供引用链接预览。"
                ) {
                    notes.append(linkedNote)
                }
                noteDocument = NoteDocument([
                    "noteId": "open-design-redwall",
                    "title": "赤壁赋",
                    "currentVersion": [
                        "versionId": "open-design-redwall-v2",
                        "versionNo": 2,
                        "blocks": [
                            [
                                "ordinal": 1,
                                "type": "paragraph",
                                "content": "壬戌之秋，七月既望，苏子与客泛舟游于赤壁之下。清风徐来，水波不兴。举酒属客，诵明月之诗，歌窈窕之章。少焉，月出于东山之上，徘徊于斗牛之间。白露横江，水光接天。纵一苇之所如，凌万顷之茫然。浩浩乎如冯虚御风，而不知其所止；飘飘乎如遗世独立，羽化而登仙。",
                            ],
                            [
                                "ordinal": 2,
                                "type": "paragraph",
                                "content": "于是饮酒乐甚，扣舷而歌之。歌曰：“桂棹兮兰桨，击空明兮溯流光。渺渺兮予怀，望美人兮天一方。”客有吹洞箫者，倚歌而和之。其声呜呜然，如怨如慕，如泣如诉，余音袅袅，不绝如缕。舞幽壑之潜蛟，泣孤舟之嫠妇。引用另一篇：[无标题笔记](astella-note:e1199b07-2a56-44fc-bba2-ae8d66af33cf)。",
                            ],
                            [
                                "ordinal": 3,
                                "type": "paragraph",
                                "content": "苏子愀然，正襟危坐而问客曰：“何为其然也？”客曰：“‘月明星稀，乌鹊南飞’，此非曹孟德之诗乎？西望夏口，东望武昌，山川相缪，郁乎苍苍，此非孟德之困于周郎者乎？方其破荆州，下江陵，顺流而东也，舳舻千里，旌旗蔽空，酾酒临江，横槊赋诗，固一世之雄也，而今安在哉？”",
                            ],
                        ],
                    ],
                ])
            }
        }
        #endif
#if DEBUG
        let shouldRestoreSession = self.uiReviewMode == nil && api.token != nil
#else
        let shouldRestoreSession = api.token != nil
#endif
        if shouldRestoreSession {
            startupLoadState = .loading
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
