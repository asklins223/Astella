import Foundation
import Observation

@Observable
@MainActor
final class AppStore {
    let api = MobileAPI()
    let realtime = CompanionRealtime()

    var profile: UserProfile?
    var conversationId: String?
    var messages: [CompanionMessage] = []
    var notes: [NoteSummary] = []
    var notesNextCursor: String?
    private var notesQuery = ""
    private var notesRequestGeneration = 0
    var isLoadingMoreNotes = false
    var noteDocument: NoteDocument?
    var noteAnnotations: [NoteAnnotation] = []
    var isAnnotationBusy = false
    var annotationStatus: String?
    var annotationErrorMessage: String?
    private var noteRequestGeneration = 0
    private var annotationRequestGeneration = 0
    private var annotationOperationGeneration = 0
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
    var selectedImage: Data?
    var selectedImageName = "手机照片.jpg"
    var voiceArtifactId: String?

    var isAuthenticated: Bool { api.token != nil }

    init() {
        realtime.onEvent = { [weak self] event in self?.consume(event) }
        realtime.onState = { [weak self] state in self?.realtimeStatus = state }
        if api.token != nil {
            Task { await restoreSession() }
        }
    }

    func login(email: String, password: String) async {
        await authenticate("/auth/login", body: [
            "email": normalizedEmail(email),
            "password": password,
            "clientKind": "mobile",
            "remember": true,
        ], fallback: "邮箱或密码不正确，请检查后重试。")
    }

    func loginWithEmailCode(email: String, code: String) async {
        await authenticate("/auth/login-with-code", body: [
            "email": normalizedEmail(email),
            "code": code,
            "clientKind": "mobile",
            "remember": true,
        ], fallback: "验证码登录没有完成，请核对验证码后重试。")
    }

    @discardableResult
    func sendEmailCode(email: String, purpose: String) async -> Int? {
        isLoading = true
        authErrorMessage = nil
        authNoticeMessage = nil
        defer { isLoading = false }
        do {
            let result = try await api.request("/auth/email-code", method: "POST", body: [
                "email": normalizedEmail(email),
                "purpose": purpose,
            ]) as? [String: Any] ?? [:]
            let seconds = max(1, result["resendInSeconds"] as? Int ?? 60)
            authNoticeMessage = "验证码已发送至 \(normalizedEmail(email))，5 分钟内有效。没收到时可以看看垃圾邮件。"
            return seconds
        } catch {
            let fallback: String
            switch purpose {
            case "register": fallback = "验证邮件没有发出，请稍后重试。"
            case "reset_password": fallback = "重置验证码没有发出，请稍后重试。"
            default: fallback = "登录验证码没有发出，请稍后重试。"
            }
            authErrorMessage = friendlyAuthError(error, fallback: fallback)
            return nil
        }
    }

    func registerAccount(email: String, password: String, displayName: String, inviteToken: String, code: String) async {
        var body: [String: Any] = [
            "email": normalizedEmail(email),
            "password": password,
            "emailCode": code,
            "clientKind": "mobile",
        ]
        if !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["displayName"] = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if !inviteToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["inviteToken"] = inviteToken.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        await authenticate("/auth/register-v2", body: body, fallback: "账号创建没有完成，请检查验证码和填写内容后重试。")
    }

    @discardableResult
    func resetPassword(email: String, code: String, newPassword: String) async -> Bool {
        isLoading = true
        authErrorMessage = nil
        authNoticeMessage = nil
        defer { isLoading = false }
        do {
            _ = try await api.request("/auth/reset-password", method: "POST", body: [
                "email": normalizedEmail(email),
                "code": code,
                "newPassword": newPassword,
            ])
            authNoticeMessage = "密码已更新，请用新密码登录。"
            return true
        } catch {
            authErrorMessage = friendlyAuthError(error, fallback: "密码更新没有完成，请检查验证码和新密码后重试。")
            return false
        }
    }

    func clearAuthFeedback() {
        authErrorMessage = nil
        authNoticeMessage = nil
    }

    private func authenticate(_ path: String, body: [String: Any], fallback: String) async {
        isLoading = true
        authErrorMessage = nil
        authNoticeMessage = nil
        defer { isLoading = false }
        do {
            let result = try await api.request(path, method: "POST", body: body) as? [String: Any]
            guard let token = result?["token"] as? String, !token.isEmpty else {
                throw MobileAPIError(status: 0, code: "invalid_session", message: "登录响应缺少有效凭据。")
            }
            try KeychainTokenStore.save(token)
            api.token = token
            await restoreSession()
        } catch {
            authErrorMessage = friendlyAuthError(error, fallback: fallback)
        }
    }

    private func normalizedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func friendlyAuthError(_ error: Error, fallback: String) -> String {
        if error is TokenStoreError {
            return "登录已成功，但无法安全保存本机登录状态，请稍后重试。"
        }
        guard let apiError = error as? MobileAPIError else {
            if let urlError = error as? URLError, urlError.code == .timedOut || urlError.code == .cannotFindHost || urlError.code == .cannotConnectToHost || urlError.code == .notConnectedToInternet {
                return "暂时连接不上书房，请检查网络或服务地址后重试。"
            }
            return fallback
        }

        switch apiError.code {
        case "invalid_credentials": return "邮箱或密码不正确，请检查后重试。"
        case "invalid_code": return "验证码不正确，请核对邮件中的 6 位数字。"
        case "expired_code": return "验证码已过期，请重新发送。"
        case "code_attempts_exhausted": return "尝试次数已用完，请重新发送验证码。"
        case "email_channel_unavailable": return "邮箱验证服务暂不可用，请稍后再试。"
        case "email_send_failed": return "邮件暂时没有发出去，请稍后重试。"
        case "email_exists": return "这个邮箱已经注册，请直接登录。"
        case "rate_limited", "resend_too_soon", "daily_limit_reached":
            return safeAuthMessage(apiError.message, fallback: "操作太频繁了，请稍后再试。")
        default:
            if apiError.status == 0 {
                return "暂时连接不上书房，请检查网络或服务地址后重试。"
            }
            if apiError.status == 401 {
                return fallback
            }
            return safeAuthMessage(apiError.message, fallback: fallback)
        }
    }

    private func safeAuthMessage(_ message: String, fallback: String) -> String {
        let clean = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let generic = ["请求错误", "请求失败", "请求没有完成，请稍后重试。", "Request failed", "Internal Server Error"]
        return clean.isEmpty || generic.contains(where: { clean.localizedCaseInsensitiveCompare($0) == .orderedSame })
            ? fallback
            : clean
    }

    func restoreSession() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let raw = try await api.request("/auth/me") as? [String: Any] ?? [:]
            profile = UserProfile(raw)
            loadDevicePreferences(for: profile?.userId ?? "")
            await loadConversation()
            await loadNotes()
        } catch {
            if (error as? MobileAPIError)?.status == 401 {
                logout()
            } else {
                errorMessage = mobilePageError(error, fallback: "暂时接不上你的书房，请检查网络后重试。")
            }
        }
    }

    func loadConversation() async {
        errorMessage = nil
        do {
            let inbox = try await api.request("/companion/inbox/ensure", method: "POST", body: [:]) as? [String: Any]
            guard let id = inbox?["id"] as? String else { return }
            conversationId = id
            await refreshMessages()
            await refreshRuns()
            let snapshot = try await api.request("/companion/conversations/\(id)/run-nodes",
                                                 query: [URLQueryItem(name: "after", value: "0")]) as? [String: Any] ?? [:]
            let cursor = snapshot["latestSeq"] as? Int ?? 0
            realtime.start(api: api, conversationId: id, cursor: cursor)
        } catch {
            errorMessage = mobilePageError(error, fallback: "伴星暂时没有接回来，请检查连接后重试。")
        }
    }

    func refreshMessages() async {
        guard let conversationId else { return }
        do {
            let page = try await api.request("/companion/conversations/\(conversationId)/messages",
                                             query: [URLQueryItem(name: "limit", value: "50")]) as? [String: Any]
            let items = page?["items"] as? [[String: Any]] ?? []
            messages = items.compactMap(CompanionMessage.init).sorted { $0.seq < $1.seq }
            streamingText = ""
        } catch {
            errorMessage = mobilePageError(error, fallback: "对话记录暂时无法读取，请重新连接后重试。")
        }
    }

    func refreshRuns() async {
        guard let conversationId else { return }
        do {
            let snapshot = try await api.request("/companion/conversations/\(conversationId)/run-nodes",
                                                 query: [URLQueryItem(name: "after", value: "0")]) as? [String: Any]
            runs = (snapshot?["runs"] as? [[String: Any]] ?? [])
                .compactMap(ActiveRun.init)
                .filter(\.isActive)
        } catch {
            runs = []
        }
    }

    func loadNotes(query: String = "") async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        notesRequestGeneration += 1
        let requestGeneration = notesRequestGeneration
        notesQuery = normalized
        notesNextCursor = nil
        isLoadingMoreNotes = false
        isLoading = true
        notesErrorMessage = nil
        defer {
            if requestGeneration == notesRequestGeneration { isLoading = false }
        }
        do {
            let path = normalized.isEmpty ? "/notes" : "/search"
            let params: [URLQueryItem] = normalized.isEmpty
                ? [URLQueryItem(name: "limit", value: "30")]
                : [
                    URLQueryItem(name: "q", value: normalized),
                    URLQueryItem(name: "type", value: "note"),
                    URLQueryItem(name: "limit", value: "30")
                ]
            let page = try await api.request(path, query: params) as? [String: Any]
            guard requestGeneration == notesRequestGeneration else { return }
            notes = (page?["items"] as? [[String: Any]] ?? []).compactMap(NoteSummary.init)
            notesNextCursor = page?["nextCursor"] as? String
        } catch {
            guard requestGeneration == notesRequestGeneration else { return }
            notesErrorMessage = mobilePageError(error, fallback: "手记暂时无法读取，请检查连接后重新加载。")
        }
    }

    func loadMoreNotes(query: String) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isLoading, !isLoadingMoreNotes, normalized == notesQuery, let cursor = notesNextCursor else { return }
        let requestGeneration = notesRequestGeneration
        isLoadingMoreNotes = true
        defer {
            if requestGeneration == notesRequestGeneration { isLoadingMoreNotes = false }
        }
        do {
            let path = normalized.isEmpty ? "/notes" : "/search"
            var params = [URLQueryItem(name: "limit", value: "30"), URLQueryItem(name: "cursor", value: cursor)]
            if !normalized.isEmpty {
                params.append(URLQueryItem(name: "q", value: normalized))
                params.append(URLQueryItem(name: "type", value: "note"))
            }
            let page = try await api.request(path, query: params) as? [String: Any]
            guard requestGeneration == notesRequestGeneration, normalized == notesQuery, notesNextCursor == cursor else { return }
            let next = (page?["items"] as? [[String: Any]] ?? []).compactMap(NoteSummary.init)
            var seen = Set(notes.map(\.id))
            notes.append(contentsOf: next.filter { seen.insert($0.id).inserted })
            notesNextCursor = page?["nextCursor"] as? String
        } catch {
            guard requestGeneration == notesRequestGeneration, normalized == notesQuery else { return }
            notesErrorMessage = mobilePageError(error, fallback: "下一页手记没有加载出来，请稍后重试。")
        }
    }

    func loadNote(_ id: String) async {
        noteRequestGeneration += 1
        let requestGeneration = noteRequestGeneration
        annotationRequestGeneration += 1
        annotationOperationGeneration += 1
        noteDocument = nil
        noteAnnotations = []
        isAnnotationBusy = false
        annotationErrorMessage = nil
        annotationStatus = nil
        noteErrorMessage = nil
        do {
            let value = try await api.request("/v2/notes/\(id)") as? [String: Any] ?? [:]
            guard requestGeneration == noteRequestGeneration else { return }
            guard let document = NoteDocument(value) else {
                throw MobileAPIError(status: 0, code: "invalid_note", message: "手记没有返回可阅读的版本内容。")
            }
            noteDocument = document
            await loadNoteAnnotations(id)
        } catch {
            guard requestGeneration == noteRequestGeneration else { return }
            noteErrorMessage = mobilePageError(error, fallback: "这篇手记暂时无法打开，请检查连接后重新加载。")
        }
    }

    func loadNoteAnnotations(_ noteId: String) async {
        guard noteDocument?.id == noteId else { return }
        annotationRequestGeneration += 1
        let requestGeneration = annotationRequestGeneration
        do {
            let page = try await api.request("/v2/notes/\(noteId)/annotations") as? [String: Any] ?? [:]
            guard requestGeneration == annotationRequestGeneration, noteDocument?.id == noteId else { return }
            noteAnnotations = (page["items"] as? [[String: Any]] ?? []).compactMap(NoteAnnotation.init)
            annotationErrorMessage = nil
        } catch {
            guard requestGeneration == annotationRequestGeneration, noteDocument?.id == noteId else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注暂时无法读取，请重新加载后再试。")
        }
    }

    func clearAnnotationNotice() {
        annotationErrorMessage = nil
        annotationStatus = nil
    }

    func saveNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor, explanation: String) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = nil
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            _ = try await api.request("/v2/notes/\(noteId)/annotations", method: "POST", body: [
                "anchor": anchor.requestBody,
                "explanation": explanation.trimmingCharacters(in: .whitespacesAndNewlines),
            ])
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            await loadNoteAnnotations(noteId)
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationStatus = "已把这条批注留在原文旁。"
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注没有保存，请检查连接后重试。")
        }
    }

    func explainNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = "伴星正在读这段原文…"
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            let task = try await api.request("/v2/notes/\(noteId)/annotation-tasks", method: "POST", body: [
                "anchor": anchor.requestBody,
                "requestId": UUID().uuidString.lowercased(),
            ]) as? [String: Any] ?? [:]
            guard let taskId = task["taskId"] as? String, !taskId.isEmpty else {
                throw MobileAPIError(status: 0, code: "missing_task", message: "讲解任务没有返回编号。")
            }
            for _ in 0..<80 {
                guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                try await Task.sleep(for: .milliseconds(1_500))
                let status = try await api.request("/v2/notes/\(noteId)/annotation-tasks/\(taskId)") as? [String: Any] ?? [:]
                guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                switch status["status"] as? String {
                case "ready":
                    await loadNoteAnnotations(noteId)
                    guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                    annotationStatus = "伴星已经把讲解贴回这段原文。"
                    return
                case "failed":
                    let reason = status["failureReason"] as? String
                    annotationErrorMessage = switch reason {
                    case "ai_consent_required": "请先到账户页签署 AI 使用协议。"
                    case "ai_data_policy_denied": "账户暂未允许此类 AI 处理，请先检查数据偏好。"
                    case "generation_incomplete": "这次讲解没有完成，原文还在，可以再试一次。"
                    default: "讲解暂时没有生成，原文还在，可以再试一次。"
                    }
                    annotationStatus = nil
                    return
                default: continue
                }
            }
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = "讲解还在后台整理，稍后重新打开这篇手记查看。"
            annotationStatus = nil
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "讲解没有开始，请检查连接后重试。")
            annotationStatus = nil
        }
    }

    func removeNoteAnnotation(noteId: String, annotation: NoteAnnotation) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = nil
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            let result = try await api.request("/v2/notes/\(noteId)/annotations/\(annotation.id)", method: "DELETE", body: [
                "expectedRevision": annotation.revision,
            ]) as? [String: Any] ?? [:]
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            await loadNoteAnnotations(noteId)
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            let removedArtifacts = result["removedArtifacts"] as? Int ?? 0
            annotationStatus = removedArtifacts > 0
                ? "批注已撤下，连带移除了 \(removedArtifacts) 条讲解。"
                : "批注已撤下。"
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注没有撤下，请刷新后再试。")
        }
    }

    private func isCurrentNoteOperation(_ noteId: String, generation: Int) -> Bool {
        generation == annotationOperationGeneration && noteDocument?.id == noteId
    }

    func continueWithNote(_ document: NoteDocument) {
        guard !document.versionId.isEmpty else {
            accountError = "没有取得这篇手记的版本信息，请重新打开后再试。"
            return
        }
        pendingNoteContext = PendingNoteContext(noteId: document.id, versionId: document.versionId, title: document.title)
        selectedTab = .conversation
    }

    func clearPendingNoteContext() {
        pendingNoteContext = nil
    }

    func loadAccountSettings() async {
        isAccountBusy = true
        accountError = nil
        defer { isAccountBusy = false }
        do {
            let workspaceResponse = try await api.request("/auth/workspaces") as? [String: Any] ?? [:]
            workspaces = (workspaceResponse["workspaces"] as? [[String: Any]] ?? []).compactMap(WorkspaceSummary.init)
            let settings = try await api.request("/me/ai-settings") as? [String: Any] ?? [:]
            aiSettings = AISettings(settings)
            let companion = try await api.request("/me/companion") as? [String: Any] ?? [:]
            let account = companion["account"] as? [String: Any] ?? companion
            let agent = account["agentSettings"] as? [String: Any] ?? [:]
            companionPermissionLevel = agent["permissionLevel"] as? String
        } catch {
            accountError = mobilePageError(error, fallback: "账户设置暂时无法读取，请稍后重新加载。")
        }
    }

    func markAIConsentRequired() {
        guard var settings = aiSettings else {
            Task { await loadAccountSettings() }
            return
        }
        settings.requiresConsent = true
        aiSettings = settings
    }

    func saveProfile(displayName rawName: String) async {
        let displayName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            _ = try await api.request("/auth/profile", method: "PUT", body: ["displayName": displayName.isEmpty ? NSNull() : displayName as Any])
            if var profile {
                profile.displayName = displayName
                self.profile = profile
            }
            accountNotice = "昵称已保存。"
        } catch {
            accountError = mobilePageError(error, fallback: "昵称没有保存，请检查连接后重试。")
        }
    }

    func saveAvatar(data: Data, fileName: String) async {
        guard !isAccountBusy, let profile else { return }
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            let uploaded = try await api.uploadAvatar(data, fileName: fileName, mimeType: "image/jpeg")
            guard let avatarURL = uploaded["url"] as? String, !avatarURL.isEmpty else {
                throw MobileAPIError(status: 0, code: "invalid_avatar_upload", message: "服务端没有返回可用的头像地址。")
            }
            var updated = profile
            updated.avatarURL = avatarURL
            self.profile = updated
            accountNotice = "头像已更新。"
        } catch { accountError = mobilePageError(error, fallback: "头像没有更新，请检查连接后重试。") }
    }

    func switchWorkspace(_ workspace: WorkspaceSummary) async {
        guard workspace.id != profile?.workspaceId else { return }
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            let result = try await api.request("/auth/switch-workspace", method: "POST", body: ["workspaceId": workspace.id]) as? [String: Any] ?? [:]
            guard let token = result["token"] as? String, !token.isEmpty else {
                throw MobileAPIError(status: 0, code: "missing_session", message: "切换书房后没有收到新的登录凭据。")
            }
            try KeychainTokenStore.save(token)
            api.token = token
            realtime.stop()
            conversationId = nil
            messages = []
            runs = []
            notes = []
            noteDocument = nil
            pendingNoteContext = nil
            selectedTab = .conversation
            await restoreSession()
            await loadAccountSettings()
            accountNotice = "已切换到「\(workspace.name)」。"
        } catch {
            accountError = mobilePageError(error, fallback: "书房没有切换，请重试。")
        }
    }

    func saveAIDataPolicy(_ policy: AIDataPolicy) async {
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            _ = try await api.request("/me/ai-data-policy", method: "PUT", body: policy.requestBody)
            if var settings = aiSettings {
                settings.dataPolicy = policy
                aiSettings = settings
            }
            accountNotice = "数据使用偏好已保存。"
        } catch {
            accountError = mobilePageError(error, fallback: "数据偏好没有保存，请重试。")
        }
    }

    func acceptAIConsent() async {
        guard aiSettings?.requiresConsent == true else {
            accountError = "当前没有可确认的授权版本。"
            return
        }
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            _ = try await api.request("/me/ai-consent", method: "PUT", body: ["consentVersion": aiConsentVersion])
            if var settings = aiSettings {
                settings.requiresConsent = false
                settings.consentVersion = aiConsentVersion
                settings.consentAt = ISO8601DateFormatter().string(from: Date())
                settings.dataPolicy.sendToExternal = true
                aiSettings = settings
            }
            accountNotice = "AI 使用授权已确认。"
        } catch {
            accountError = mobilePageError(error, fallback: "授权没有保存，请检查连接后重试。")
        }
    }

    func submit(text rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let conversationId, !isSending,
              !text.isEmpty || selectedImage != nil else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            var blocks: [[String: Any]] = [[
                "type": "text",
                "text": text.isEmpty ? "看看这张图" : text
            ]]
            var inputKind = "text"
            var request: [String: Any] = [
                "version": 1,
                "clientMessageId": UUID().uuidString.lowercased(),
                "inputKind": inputKind,
                "sourceSurface": "main"
            ]
            if let image = selectedImage {
                let upload = try await api.uploadImage(image, fileName: selectedImageName, mimeType: "image/jpeg")
                guard let url = upload["url"] as? String,
                      let assetId = upload["assetId"] as? String else {
                    throw MobileAPIError(status: 0, code: "invalid_upload", message: "服务端没有返回可用的图片地址。")
                }
                blocks.append([
                    "type": "image",
                    "url": url,
                    "label": selectedImageName,
                    "alt": selectedImageName,
                    "assetId": assetId
                ])
            } else if let voiceArtifactId {
                inputKind = "voice_transcript"
                request["voiceArtifactId"] = voiceArtifactId
                request["inputKind"] = inputKind
            }
            request["blocks"] = blocks
            if let context = pendingNoteContext {
                request["context"] = [
                    "pageKind": "note",
                    "sharing": "page_registered",
                    "noteId": context.noteId,
                    "noteVersionId": context.versionId
                ]
            }
            if realtime.isReady {
                do {
                    try await realtime.submit(request)
                } catch {
                    _ = try await api.request(
                        "/companion/conversations/\(conversationId)/turns",
                        method: "POST",
                        body: request,
                        idempotencyKey: request["clientMessageId"] as? String
                    )
                }
            } else {
                _ = try await api.request(
                    "/companion/conversations/\(conversationId)/turns",
                    method: "POST",
                    body: request,
                    idempotencyKey: request["clientMessageId"] as? String
                )
            }
            selectedImage = nil
            voiceArtifactId = nil
            pendingNoteContext = nil
            await refreshMessages()
        } catch {
            errorMessage = mobilePageError(error, fallback: "这一轮还没有发出去，草稿已保留，请重试。")
        }
    }

    func acceptTranscription(_ value: [String: Any]) {
        voiceArtifactId = value["voiceArtifactId"] as? String
    }

    func logout() {
        realtime.stop()
        KeychainTokenStore.delete()
        api.token = nil
        profile = nil
        conversationId = nil
        messages = []
        notes = []
        runs = []
        pendingNoteContext = nil
        workspaces = []
        aiSettings = nil
        companionPermissionLevel = nil
        accountError = nil
        accountNotice = nil
        streamingText = ""
        selectedImage = nil
        voiceArtifactId = nil
        errorMessage = nil
    }

    func setServiceAddress(_ value: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.isEmpty { api.baseURL = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    }

    func setChatShowsRecords(_ value: Bool) {
        chatShowsRecords = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "showRecords"))
    }

    func returnToConversation(records: Bool) {
        setChatShowsRecords(records)
        selectedTab = .conversation
        conversationRootRevision &+= 1
    }

    func setReadingScale(_ value: Double) {
        guard [1.0, 1.2, 1.4].contains(value) else { return }
        readingScale = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "textScale"))
    }

    func setLocalReduceMotion(_ value: Bool) {
        localReduceMotion = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "reduceMotion"))
    }

    private func loadDevicePreferences(for userId: String) {
        guard !userId.isEmpty else { return }
        chatShowsRecords = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "showRecords"))
        let savedScale = UserDefaults.standard.object(forKey: mobilePreferenceKey(userId, "textScale")) as? Double ?? 1
        readingScale = [1.0, 1.2, 1.4].contains(savedScale) ? savedScale : 1
        localReduceMotion = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "reduceMotion"))
    }

    private func consume(_ event: [String: Any]) {
        let type = event["type"] as? String ?? ""
        let payload = event["payload"] as? [String: Any] ?? [:]
        switch type {
        case "assistant.delta":
            streamingText += payload["textDelta"] as? String ?? ""
        case "sync.required":
            Task { await loadConversation() }
        case "turn.completed", "assistant.final":
            Task {
                await refreshMessages()
                await refreshRuns()
            }
        case "turn.accepted", "assistant.status", "agent.tool":
            Task { await refreshRuns() }
        case "error":
            errorMessage = mobileServerMessage(payload["message"] as? String, fallback: "这一轮暂时没有完成，请保留草稿后重试。")
            Task { await refreshMessages() }
        default:
            break
        }
    }
}

private func mobileServerMessage(_ rawMessage: String?, fallback: String) -> String {
    let message = rawMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let genericMessages = ["请求错误", "请求失败", "请求没有完成，请稍后重试。", "Request failed", "Internal Server Error"]
    return message.isEmpty || genericMessages.contains(where: { message.localizedCaseInsensitiveCompare($0) == .orderedSame })
        ? fallback
        : message
}

private func mobilePageError(_ error: Error, fallback: String) -> String {
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
