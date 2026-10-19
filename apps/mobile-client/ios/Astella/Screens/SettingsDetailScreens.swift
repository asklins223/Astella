import AVFoundation
import SwiftUI
import UIKit
import UserNotifications

struct DevicePermissionsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var microphoneStatus = "正在读取"
    @State private var notificationsStatus = "正在读取"
    @State private var isRequestingMicrophone = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                Text("系统权限只在对应功能需要时才会请求。照片和文件通过 iOS 选择器按次授权，不会读取整个图库或文件夹。")
                    .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 3)

                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 9) {
                        AstellaGlyph(kind: .shield, tint: StudyPalette.accent).frame(width: 19, height: 19)
                        Text("由你决定何时开启").font(.system(size: 15, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    }
                    Text("语音需要麦克风；图片与文档只会访问你主动选择的项目。关闭权限时，键盘、共享书房和粘贴文字仍可继续使用。")
                        .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(StudyPalette.sky.opacity(0.7), in: RoundedRectangle(cornerRadius: 17, style: .continuous))

                VStack(alignment: .leading, spacing: 0) {
                    permissionRow(
                        title: "麦克风",
                        detail: "语音交流时录音；不会自动开始。",
                        status: microphoneStatus,
                        actionTitle: microphoneActionTitle,
                        action: microphoneAction
                    )
                    permissionDivider
                    permissionRow(
                        title: "照片",
                        detail: "使用系统照片选择器，按次读取你选中的图片。",
                        status: "系统按次授权",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        title: "相机",
                        detail: "当前版本没有拍摄入口，因此不会请求相机权限。",
                        status: "未使用",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        title: "文件",
                        detail: "通过系统文件选择器访问你挑选的文档。",
                        status: "系统按次授权",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        title: "通知",
                        detail: "仅用于系统推送；应用内内容不依赖通知权限。",
                        status: notificationsStatus,
                        actionTitle: nil,
                        action: nil
                    )
                }
                .padding(.horizontal, 15)
                .background(StudyPalette.paper.opacity(0.88), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))

                VStack(alignment: .leading, spacing: 9) {
                    Text("伴星操作范围").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
                    Text(companionPermissionTitle)
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    Text(companionPermissionDetail)
                        .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 32)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "设备权限") }
        .task { await refreshPermissionStatus() }
    }

    private var microphoneActionTitle: String? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: nil
        case .denied: "去系统设置"
        case .undetermined: isRequestingMicrophone ? "正在请求…" : "允许麦克风"
        @unknown default: nil
        }
    }

    private var microphoneAction: (() -> Void)? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: nil
        case .denied: { openApplicationSettings() }
        case .undetermined: { requestMicrophone() }
        @unknown default: nil
        }
    }

    private var companionPermissionTitle: String {
        switch store.companionPermissionLevel {
        case "read_only": "只读"
        case "guided": "每次操作前说明并等待确认"
        case "full": "已授权范围内可执行可逆操作"
        default: store.isAccountBusy ? "正在读取…" : "暂时没有读取到"
        }
    }

    private var companionPermissionDetail: String {
        switch store.companionPermissionLevel {
        case "read_only": "写入或执行操作前，伴星会先给你预览并征求确认。"
        case "guided": "伴星会说明下一步，再等你确认后执行；不可逆操作仍需单独确认。"
        case "full": "已授权范围内的可逆操作可以直接执行；不可逆操作仍需单独确认。"
        default: "这是伴星对可执行操作的范围，与麦克风、照片和文件等系统权限分开管理。"
        }
    }

    private var permissionDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7).padding(.leading, 45)
    }

    private func permissionRow(title: String, detail: String, status: String, actionTitle: String?, action: (() -> Void)?) -> some View {
        HStack(alignment: .center, spacing: 11) {
            AstellaGlyph(kind: title == "麦克风" ? .mic : title == "通知" ? .info : title == "照片" ? .photo : .document, tint: StudyPalette.accent)
                .frame(width: 18, height: 18).frame(width: 34, height: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 10)).lineSpacing(2).foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 5)
            VStack(alignment: .trailing, spacing: 5) {
                Text(status).font(.system(size: 10, weight: .medium)).foregroundStyle(permissionColor(status))
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(StudyPalette.accent)
                        .disabled(isRequestingMicrophone)
                }
            }
        }
        .frame(minHeight: 69)
    }

    private func permissionColor(_ status: String) -> Color {
        if status == "已允许" || status == "系统按次授权" { return StudyPalette.success }
        if status == "已拒绝" { return StudyPalette.danger }
        return StudyPalette.muted
    }

    private func refreshPermissionStatus() async {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: microphoneStatus = "已允许"
        case .denied: microphoneStatus = "已拒绝"
        case .undetermined: microphoneStatus = "未请求"
        @unknown default: microphoneStatus = "状态未知"
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: notificationsStatus = "已允许"
        case .denied: notificationsStatus = "已拒绝"
        case .notDetermined: notificationsStatus = "未请求"
        @unknown default: notificationsStatus = "状态未知"
        }
        if store.companionPermissionLevel == nil { await store.loadAccountSettings() }
    }

    private func requestMicrophone() {
        guard !isRequestingMicrophone else { return }
        isRequestingMicrophone = true
        AVAudioApplication.requestRecordPermission { _ in
            Task { @MainActor in
                await refreshPermissionStatus()
                isRequestingMicrophone = false
            }
        }
    }

    private func openApplicationSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

struct AIDataAuthorizationScreen: View {
    @Environment(AppStore.self) private var store
    @State private var policy = AIDataPolicy(sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true)
    @State private var consentAccepted = false
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        AstellaGlyph(kind: .companion, tint: StudyPalette.accent).frame(width: 17, height: 17)
                        Text("AI 使用范围由你决定").font(.system(size: 15, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    }
                    Text("阅读和手记不需要 AI 授权。需要外部 AI 的功能只有在账号授权和对应数据开关都允许后才会发送内容。")
                        .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .background(StudyPalette.sky.opacity(0.70), in: RoundedRectangle(cornerRadius: 17, style: .continuous))

                consentStatus
                if let settings = store.aiSettings, settings.requiresConsent && settings.consentVersion == nil {
                    consentForm
                }

                VStack(alignment: .leading, spacing: 0) {
                    Text("数据授权项").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted).padding(.bottom, 7)
                    policyToggle("允许使用外部 AI 服务", detail: "关闭后，阅读与手记仍可使用；需要外部 AI 的功能会停止发送内容。", keyPath: \.sendToExternal,
                                 disabled: store.aiSettings?.requiresConsent == true && store.aiSettings?.consentVersion == nil)
                    policyDivider
                    policyToggle("允许发送图片内容", detail: "图片只会随你主动发起的 AI 请求发送。", keyPath: \.sendImageContent)
                    policyDivider
                    policyToggle("启用个人信息识别", detail: "在请求处理中按服务策略识别可能的个人信息。", keyPath: \.piiDetection)
                    policyDivider
                    policyToggle("记录 AI 调用审计", detail: "保留服务调用的审计记录，供你了解数据使用情况。", keyPath: \.auditLogging)
                }
                .padding(.horizontal, 15).padding(.vertical, 13)
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))

                Button(isLoading || store.isAccountBusy ? "正在保存…" : "保存数据偏好") {
                    Task { await store.saveAIDataPolicy(policy) }
                }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 47)
                .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .buttonStyle(AstellaPressStyle()).disabled(isLoading || store.isAccountBusy)
                .padding(.trailing, 74)

                if let message = store.accountError { OrbitDetailMessage(text: message, isError: true) }
                else if let message = store.accountNotice { OrbitDetailMessage(text: message, isError: false) }
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 32)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden).background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "AI 授权与数据") }
        .task(id: store.profile?.userId) { await load() }
        .onChange(of: store.aiSettings) { _, settings in
            if let settings { policy = settings.dataPolicy }
        }
    }

    @ViewBuilder private var consentStatus: some View {
        if let settings = store.aiSettings, let version = settings.consentVersion {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    AstellaGlyph(kind: .check, tint: StudyPalette.success).frame(width: 17, height: 17)
                    Text("已签署 AI 使用授权").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    Spacer(minLength: 5)
                    Text(version).font(.caption2).foregroundStyle(StudyPalette.muted)
                }
                if let date = settings.consentAt, !date.isEmpty {
                    Text("签署时间：\(String(date.prefix(10)))").font(.caption).foregroundStyle(StudyPalette.muted)
                }
                if !settings.dataPolicy.sendToExternal {
                    Text("授权仍有效，但外部 AI 已关闭；需要外部服务的功能不会发送内容。")
                        .font(.caption).lineSpacing(3).foregroundStyle(StudyPalette.muted).padding(.top, 3)
                }
            }
            .padding(15).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))
        } else if store.aiSettings?.requiresConsent == true {
            VStack(alignment: .leading, spacing: 7) {
                Text("尚未签署 AI 使用授权").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text("未确认前，需要授权的外部 AI 调用不会执行。阅读与手记仍然可用。")
                    .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
            }
            .padding(15).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))
        } else if store.aiSettings != nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("当前服务不要求签署").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text("你仍可在下方管理数据偏好。服务关闭外部 AI 时，这些开关不会触发外发。")
                    .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
            }
            .padding(15).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))
        } else if isLoading {
            OrbitLoadingRow()
        } else {
            OrbitDetailMessage(text: "暂时没有读到授权状态。", isError: true)
        }
    }

    private var consentForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("授权前请了解").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
            Text("你主动发起需要 AI 的任务时，任务所需的手记、对话或图片可能会发送给模型服务；语音讲解会把讲解文字发送给语音服务。外部调用遵循下方的数据偏好。")
                .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.ink)
            Toggle("我已阅读并同意《AI 使用协议》", isOn: $consentAccepted)
                .font(.footnote.weight(.medium)).tint(StudyPalette.accent).disabled(store.isAccountBusy)
            Button(store.isAccountBusy ? "正在保存…" : "同意并开启外部 AI") {
                Task { await store.acceptAIConsent() }
            }
            .font(.footnote.weight(.semibold)).foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 43)
            .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .buttonStyle(AstellaPressStyle()).disabled(store.isAccountBusy || !consentAccepted)
        }
        .padding(15).background(StudyPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))
    }

    private var policyDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7).padding(.leading, 3)
    }

    private func policyToggle(_ title: String, detail: String, keyPath: WritableKeyPath<AIDataPolicy, Bool>, disabled: Bool = false) -> some View {
        Toggle(isOn: Binding(get: { policy[keyPath: keyPath] }, set: { policy[keyPath: keyPath] = $0 })) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 10)).lineSpacing(3).foregroundStyle(StudyPalette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(StudyPalette.accent).disabled(store.isAccountBusy || disabled)
        .padding(.vertical, 8)
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        if store.aiSettings == nil { await store.loadAccountSettings() }
        if let settings = store.aiSettings { policy = settings.dataPolicy }
    }
}

struct ServiceAddressScreen: View {
    @Environment(AppStore.self) private var store
    @FocusState private var isAddressFocused: Bool
    @State private var address = ""
    @State private var connectionState: ConnectionState = .idle

    private enum ConnectionState {
        case idle
        case testing
        case connected(Int)
        case failed(String)

        var isTesting: Bool {
            if case .testing = self { return true }
            return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                Text("仅在连接自建或私有部署时修改。保存后会退出当前会话，需要用新地址重新登录。")
                    .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted).padding(.horizontal, 3)

                VStack(alignment: .leading, spacing: 9) {
                    Text("服务地址").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
                    TextField("https://study.example.com", text: $address)
                        .font(.system(size: 14)).textInputAutocapitalization(.never).keyboardType(.URL)
                        .autocorrectionDisabled().focused($isAddressFocused)
                        .padding(.horizontal, 14).frame(minHeight: 48)
                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .onChange(of: address) { _, _ in connectionState = .idle }
                    Text("当前生效：\(store.api.baseURL)")
                        .font(.caption).lineLimit(2).foregroundStyle(StudyPalette.muted)
                    Text("公网服务建议使用 HTTPS。本地开发或可信内网可使用 HTTP。")
                        .font(.caption2).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                }
                .padding(16).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.8))

                connectionFeedback

                HStack(spacing: 10) {
                    Button(connectionState.isTesting ? "正在测试…" : "测试连接") { Task { await testConnection() } }
                        .font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .buttonStyle(AstellaPressStyle()).disabled(connectionState.isTesting || validatedHealthURL() == nil)
                    Button("恢复默认地址") { address = store.api.defaultBaseURL; connectionState = .idle }
                        .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.ink)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .buttonStyle(AstellaPressStyle())
                }

                Button("保存并重新登录") {
                    guard let normalized = normalizedAddress() else {
                        connectionState = .failed("请输入有效的 http 或 https 服务地址。")
                        return
                    }
                    isAddressFocused = false
                    store.setServiceAddress(normalized)
                    store.logout()
                }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .buttonStyle(AstellaPressStyle()).disabled(normalizedAddress() == nil)
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 32)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively).background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "服务地址") }
        .task { address = store.api.baseURL }
    }

    @ViewBuilder private var connectionFeedback: some View {
        switch connectionState {
        case .idle: EmptyView()
        case .testing:
            HStack(spacing: 8) { ProgressView().tint(StudyPalette.accent); Text("正在检查服务状态…").font(.footnote).foregroundStyle(StudyPalette.muted) }
                .frame(maxWidth: .infinity, alignment: .leading).padding(13)
                .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        case .connected(let milliseconds):
            OrbitDetailMessage(text: "连接成功 · \(milliseconds) ms", isError: false)
        case .failed(let message):
            OrbitDetailMessage(text: message, isError: true)
        }
    }

    private func normalizedAddress() -> String? {
        let raw = address.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var parts = URLComponents(string: raw),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        parts.path = ""
        return parts.string?.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func validatedHealthURL() -> URL? {
        guard let address = normalizedAddress(), var parts = URLComponents(string: address) else { return nil }
        parts.path = "/health"
        return parts.url
    }

    private func testConnection() async {
        guard let url = validatedHealthURL() else { connectionState = .failed("请输入有效的服务地址。") ; return }
        connectionState = .testing
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let start = Date()
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  payload["status"] as? String == "ok", payload["service"] as? String == "api" else {
                connectionState = .failed("服务没有返回有效的 API 健康状态。")
                return
            }
            connectionState = .connected(max(1, Int(Date().timeIntervalSince(start) * 1000)))
        } catch {
            connectionState = .failed("连接失败：请检查地址、网络和服务状态。")
        }
    }
}

private struct OrbitDetailMessage: View {
    let text: String
    let isError: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AstellaGlyph(kind: isError ? .alert : .check, tint: isError ? StudyPalette.danger : StudyPalette.success).frame(width: 16, height: 16)
            Text(text).font(.footnote).lineSpacing(3).foregroundStyle(StudyPalette.muted)
            Spacer(minLength: 0)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

/// 修改密码。服务端改密会撤销全部会话，所以成功后直接回到登录页并留下提示；
/// 版式沿用设置栈：44pt 返回玻璃圆、31-34pt 标题、组内三行密码卡与底部主按钮。
struct ChangePasswordScreen: View {
    @Environment(AppStore.self) private var store
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var reveals = [false, false, false]

    private var canSubmit: Bool {
        !store.isAccountBusy
            && !currentPassword.isEmpty
            && newPassword.count >= 8 && newPassword.count <= 200
            && confirmPassword == newPassword
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(spacing: 0) {
                    passwordField(index: 0, label: "当前密码", placeholder: "输入当前密码", text: $currentPassword)
                    passwordDivider
                    passwordField(index: 1, label: "新密码", placeholder: "8–200 位", text: $newPassword)
                    passwordDivider
                    passwordField(index: 2, label: "确认新密码", placeholder: "再输入一次", text: $confirmPassword)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
                .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))

                Button(store.isAccountBusy ? "正在保存…" : "保存新密码") {
                    guard canSubmit else { return }
                    Task { _ = await store.changePassword(currentPassword: currentPassword, newPassword: newPassword) }
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(
                    LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                )
                .buttonStyle(AstellaPressStyle())
                .disabled(!canSubmit)
                .opacity(canSubmit ? 1 : 0.55)

                Text("修改后，其它设备上的登录会失效。")
                    .font(.system(size: 12))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(maxWidth: .infinity)

                if let message = store.accountError {
                    OrbitDetailMessage(text: message, isError: true)
                }
            }
            .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 32)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "修改密码") }
    }

    private func passwordField(index: Int, label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(StudyPalette.muted)
            HStack(spacing: 10) {
                Group {
                    if reveals[index] {
                        TextField(placeholder, text: text)
                    } else {
                        SecureField(placeholder, text: text)
                    }
                }
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.newPassword)
                Button {
                    reveals[index].toggle()
                } label: {
                    AstellaGlyph(kind: reveals[index] ? .eyeSlash : .eye, tint: StudyPalette.muted)
                        .frame(width: 20, height: 20)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel(reveals[index] ? "隐藏密码" : "显示密码")
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .padding(.vertical, 10)
    }

    private var passwordDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
    }
}
