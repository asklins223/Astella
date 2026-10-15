import Foundation

// MARK: - Session（认证、登录态恢复与登出）

extension AppStore {
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
            // 会话恢复成功后，后台校验/下载伴星 Live2D 模型（失败走 PNG 降级）。
            startCompanionModelDownload()
        } catch {
            if (error as? MobileAPIError)?.status == 401 {
                logout()
            } else {
                errorMessage = mobilePageError(error, fallback: "暂时接不上你的书房，请检查网络后重试。")
            }
        }
    }

    func logout() {
        voicePlayback.stop()
        intakeGeneration += 1
        draft = ""
        selectedFile = nil
        pendingTurnRequest = nil; pendingTurnSignature = nil
        selectionRunId = nil; streamingRunId = nil
        pendingSelection = nil
        selectionRequestTitle = nil
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

    private func loadDevicePreferences(for userId: String) {
        guard !userId.isEmpty else { return }
        chatShowsRecords = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "showRecords"))
        let savedScale = UserDefaults.standard.object(forKey: mobilePreferenceKey(userId, "textScale")) as? Double ?? 1
        readingScale = [1.0, 1.2, 1.4].contains(savedScale) ? savedScale : 1
        localReduceMotion = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "reduceMotion"))
    }
}
