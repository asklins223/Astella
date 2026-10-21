import Foundation

// MARK: - Account（账户设置、书房与 AI 授权）

extension AppStore {
    func loadAccountSettings() async {
        accountSettingsGeneration += 1
        let requestGeneration = accountSettingsGeneration
        let session = api.token
        let workspaceId = profile?.workspaceId
        isAccountBusy = true
        accountError = nil
        defer {
            if requestGeneration == accountSettingsGeneration,
               session == api.token, workspaceId == profile?.workspaceId {
                isAccountBusy = false
            }
        }
        do {
            let workspaceResponse = try await api.request("/auth/workspaces") as? [String: Any] ?? [:]
            guard requestGeneration == accountSettingsGeneration,
                  session == api.token, workspaceId == profile?.workspaceId else { return }
            workspaces = (workspaceResponse["workspaces"] as? [[String: Any]] ?? []).compactMap(WorkspaceSummary.init)
            let settings = try await api.request("/me/ai-settings") as? [String: Any] ?? [:]
            guard requestGeneration == accountSettingsGeneration,
                  session == api.token, workspaceId == profile?.workspaceId else { return }
            aiSettings = AISettings(settings)
            let companion = try await api.request("/me/companion") as? [String: Any] ?? [:]
            guard requestGeneration == accountSettingsGeneration,
                  session == api.token, workspaceId == profile?.workspaceId else { return }
            let account = companion["account"] as? [String: Any] ?? companion
            let agent = account["agentSettings"] as? [String: Any] ?? [:]
            companionPermissionLevel = agent["permissionLevel"] as? String
        } catch {
            guard !Task.isCancelled, requestGeneration == accountSettingsGeneration,
                  session == api.token, workspaceId == profile?.workspaceId else { return }
            accountError = mobilePageError(error, fallback: "账户设置暂时无法读取，请稍后重新加载。")
        }
    }

    /// The API rejected a generation because this account has not signed the AI
    /// agreement. `requiresConsent` is the deployment capability flag, so the
    /// signature itself is what has to be invalidated here.
    func markAIConsentRequired() {
        guard var settings = aiSettings else {
            Task { await loadAccountSettings() }
            return
        }
        settings.consentVersion = nil
        settings.consentAt = nil
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
        guard workspace.id != profile?.workspaceId, !isSending else { return }
        let session = api.token
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            let result = try await api.request("/auth/switch-workspace", method: "POST", body: ["workspaceId": workspace.id]) as? [String: Any] ?? [:]
            guard session == api.token else { return }
            guard let token = result["token"] as? String, !token.isEmpty else {
                throw MobileAPIError(status: 0, code: "missing_session", message: "切换书房后没有收到新的登录凭据。")
            }
            try KeychainTokenStore.save(token)
            api.token = token
            sessionRestoreGeneration += 1
            accountSettingsGeneration += 1
            notesRequestGeneration += 1
            noteRequestGeneration += 1
            annotationRequestGeneration += 1
            annotationOperationGeneration += 1
            realtime.stop()
            conversationId = nil
            messages = []
            resetProcessPresentation()
            isSending = false
            pendingTurnRequest = nil
            pendingTurnSignature = nil
            selectedImage = nil
            selectedFile = nil
            attachmentRevision = UUID()
            voiceArtifactId = nil
            notes = []
            notesNextCursor = nil
            notesQuery = ""
            notesErrorMessage = nil
            noteDocument = nil
            noteAnnotations = []
            isAnnotationBusy = false
            noteErrorMessage = nil
            annotationErrorMessage = nil
            annotationStatus = nil
            visibleNoteId = nil
            pendingNoteContext = nil
            pendingDiaryReference = nil
            selectedTab = .conversation
            profile = nil
            workspaces = []
            aiSettings = nil
            companionPermissionLevel = nil
            await restoreSession()
            await loadAccountSettings()
            accountNotice = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "已切换到「\(workspace.name)」。"
                : "已切换到「\(workspace.name)」。未发送的文字草稿已保留；附件和原文引用已清除，请确认内容后再发送。"
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
        guard aiSettings?.needsSigning == true else {
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
                // `requiresConsent` stays exactly as the server reports it (a
                // capability flag); the signature is the account-level state.
                settings.consentVersion = aiConsentVersion
                settings.consentAt = ISO8601DateFormatter().string(from: Date())
                settings.dataPolicy.sendToExternal = true
                aiSettings = settings
            }
            Task { await loadAccountSettings() }
            accountNotice = "AI 使用授权已确认。"
        } catch {
            accountError = mobilePageError(error, fallback: "授权没有保存，请检查连接后重试。")
        }
    }

    func setServiceAddress(_ value: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.isEmpty { api.baseURL = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    }

    func setReadingScale(_ value: Double) {
        guard value.isFinite, (15.0 / 16.0...25.0 / 16.0).contains(value) else { return }
        readingScale = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "textScale"))
    }

    func setLocalReduceMotion(_ value: Bool) {
        localReduceMotion = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "reduceMotion"))
    }

    /// 修改密码：服务端会撤销全部会话（含当前设备），因此成功后回到登录页并给出提示。
    func changePassword(currentPassword: String, newPassword: String) async -> Bool {
        guard !isAccountBusy else { return false }
        isAccountBusy = true
        accountError = nil
        accountNotice = nil
        defer { isAccountBusy = false }
        do {
            _ = try await api.request("/auth/change-password", method: "POST", body: [
                "currentPassword": currentPassword,
                "newPassword": newPassword,
            ])
            authNoticeMessage = "密码已更新，请用新密码登录。"
            logout()
            return true
        } catch {
            accountError = mobilePageError(error, fallback: "密码没有更新，请核对当前密码后重试。")
            return false
        }
    }
}
