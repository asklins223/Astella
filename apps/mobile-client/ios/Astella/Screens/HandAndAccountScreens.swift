import SwiftUI
import PhotosUI
import UIKit
import ImageIO

struct HandScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    SectionEyebrow(text: store.profile?.workspaceName ?? "我的书房")
                    Text("手边")
                        .font(.system(.largeTitle, weight: .semibold))
                        .tracking(-0.45)
                        .foregroundStyle(StudyPalette.ink)
                    Text("需要你接续的学习工作，会在这里等你。")
                        .font(.subheadline)
                        .foregroundStyle(StudyPalette.muted)
                }

                HStack(spacing: 8) {
                    Circle().fill(store.realtimeStatus == "已连接" ? StudyPalette.success : StudyPalette.muted.opacity(0.65))
                        .frame(width: 8, height: 8)
                    Text(store.realtimeStatus == "已连接" ? "书房已连接" : store.realtimeStatus)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(StudyPalette.muted)
                    Spacer()
                    if store.realtimeStatus != "已连接" {
                        Button("重新连接") { Task { await store.loadConversation() } }
                            .font(.footnote.weight(.semibold))
                    }
                }

                if let error = store.errorMessage {
                    statusPanel(title: "连接暂时中断", detail: error, symbol: "wifi.exclamationmark") {
                        Task { await store.loadConversation() }
                    }
                }

                if !store.runs.isEmpty {
                    HStack(alignment: .firstTextBaseline) {
                        Text("正在进行")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Spacer()
                        Text("\(store.runs.count) 项")
                            .font(.caption)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    ForEach(store.runs) { run in
                        VStack(alignment: .leading, spacing: 11) {
                            HStack(spacing: 9) {
                                Image(systemName: run.status == "waiting_for_confirmation" ? "hand.raised" : "clock.arrow.circlepath")
                                    .foregroundStyle(StudyPalette.accent)
                                Text(run.statusLabel)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(StudyPalette.ink)
                                Spacer()
                                if run.status != "waiting_for_confirmation" { ProgressView().controlSize(.small) }
                            }
                            Text(run.thinkingText ?? defaultDescription(for: run))
                                .font(.body)
                                .lineSpacing(3)
                                .foregroundStyle(StudyPalette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 8) {
                                Text("\(run.stepCount) 步")
                                Text("·")
                                Text("\(run.toolCallCount) 次工具调用")
                                Spacer()
                                Button("查看对话") { store.selectedTab = .conversation }
                                    .font(.footnote.weight(.semibold))
                            }
                            .font(.caption)
                            .foregroundStyle(StudyPalette.muted)
                        }
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Divider().overlay(StudyPalette.paperEdge) }
                    }
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 31, weight: .light))
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.bottom, 5)
                        Text("暂时没有待确认事项")
                            .font(.title3.weight(.semibold))
                            .tracking(-0.25)
                            .foregroundStyle(StudyPalette.ink)
                        Text("新的学习步骤会在需要你时出现在这里。")
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("回到对话") { store.selectedTab = .conversation }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.top, 3)
                            .frame(minHeight: 44)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.vertical, 20)
                }

                if !store.runs.isEmpty || store.realtimeStatus != "已连接" {
                    HStack(spacing: 8) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .foregroundStyle(StudyPalette.muted)
                        Text("工作状态会和同一书房的其他设备同步。")
                            .foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                }
            }
                .padding(.horizontal, 24)
                .padding(.top, 14)
                .padding(.bottom, 28)
                .frame(minHeight: proxy.size.height, alignment: .top)
            }
            .scrollIndicators(.hidden)
        }
        .background(DawnBackground())
        .refreshable {
            await store.refreshMessages()
            await store.refreshRuns()
        }
    }

    private func defaultDescription(for run: ActiveRun) -> String {
        switch run.status {
        case "accepted": return "这一轮已经接收，马上开始处理。"
        case "waiting_for_confirmation": return "伴星正在等你确认下一步。请回到对话查看具体内容。"
        case "cancel_requested": return "正在结束这一轮，稍后会同步最终状态。"
        default: return "这一轮还在路上。你可以切去读手记，工作会继续。"
        }
    }

    private func statusPanel(title: String, detail: String, symbol: String, retry: @escaping () -> Void) -> some View {
        NoticeSurface {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).foregroundStyle(StudyPalette.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                    Text(detail).font(.footnote).foregroundStyle(StudyPalette.muted)
                    Button("重新连接", action: retry)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct AccountScreen: View {
    @Environment(AppStore.self) private var store
    @State private var address = ""
    @State private var displayName = ""
    @State private var consentAccepted = false
    @State private var avatarItem: PhotosPickerItem?
    @State private var policy = AIDataPolicy(sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true)

    var body: some View {
        let currentAvatarURL = store.profile?.avatarURL
        let isAccountBusy = store.isAccountBusy
        Form {
            if let message = store.accountError {
                Section { accountNotice(message, symbol: "exclamationmark.circle.fill", color: StudyPalette.danger) }
            } else if let message = store.accountNotice {
                Section { accountNotice(message, symbol: "checkmark.circle.fill", color: StudyPalette.success) }
            }

            Section("账号") {
                HStack(spacing: 12) {
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        if let avatarURL = currentAvatarURL {
                            ProfileAvatarImage(url: avatarURL, fallback: profileInitial)
                        } else {
                            Text(profileInitial)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(StudyPalette.accent)
                                .frame(width: 48, height: 48)
                                .background(StudyPalette.sky, in: Circle())
                        }
                    }
                    .disabled(isAccountBusy)
                    .accessibilityLabel("更换头像")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(store.profile?.displayName.isEmpty == false ? store.profile!.displayName : store.profile?.email ?? "")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text(store.profile?.email ?? "")
                            .font(.caption)
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                TextField("显示名称", text: $displayName, prompt: Text("留空时使用邮箱前缀"))
                    .textContentType(.name)
                    .onChange(of: displayName) { _, value in
                        if value.count > 32 { displayName = String(value.prefix(32)) }
                    }
                Text("最多 32 个字符。清空后会使用邮箱前缀作为称呼。")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
                Button {
                    Task { await store.saveProfile(displayName: displayName) }
                } label: {
                    if isAccountBusy { ProgressView() }
                    else {
                        let normalized = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                        Text(normalized.isEmpty ? "清除称呼" : "保存称呼")
                    }
                }
                .disabled(isAccountBusy || displayName.trimmingCharacters(in: .whitespacesAndNewlines) == (store.profile?.displayName ?? ""))
            }

            Section("伴星权限") {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(permissionDescription(store.companionPermissionLevel))
                            .font(.subheadline)
                            .foregroundStyle(StudyPalette.ink)
                        if store.companionPermissionLevel == nil {
                            Button("重新读取") { Task { await store.loadAccountSettings() } }
                                .font(.footnote.weight(.semibold))
                                .disabled(isAccountBusy)
                        }
                    }
                } icon: {
                    Image(systemName: "hand.raised")
                        .foregroundStyle(StudyPalette.muted)
                }
            }

            Section("拾星") {
                NavigationLink {
                    MobileSettingsScreen()
                } label: {
                    Label("使用设置", systemImage: "textformat.size")
                }
                NavigationLink {
                    CompanionCenterScreen()
                } label: {
                    Label("伴星中心", systemImage: "sparkles")
                }
            }

            if store.workspaces.count > 1 {
                Section("书房") {
                    Menu {
                        ForEach(store.workspaces) { workspace in
                            Button {
                                Task { await store.switchWorkspace(workspace) }
                            } label: {
                                if workspace.id == store.profile?.workspaceId { Label(workspace.name, systemImage: "checkmark") }
                                else { Text(workspace.name) }
                            }
                        }
                    } label: {
                        HStack {
                            Text("当前空间")
                            Spacer()
                            Text(store.profile?.workspaceName ?? "选择书房")
                                .foregroundStyle(StudyPalette.muted)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(StudyPalette.muted)
                        }
                    }
                    .disabled(isAccountBusy)
                    Text("切换后会重新接回该书房的对话与手记。")
                        .font(.caption)
                        .foregroundStyle(StudyPalette.muted)
                }
            }

            if let settings = store.aiSettings {
                Section("AI 与数据") {
                    Text("控制哪些内容可以发送到外部模型服务。")
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                    if settings.requiresConsent && settings.consentVersion == nil {
                        Text("任务所需的手记、对话或图片可能发送给模型服务；语音讲解也会将讲解文字交给语音服务。授权由你本人签署，未签署前需要授权的外部调用不会执行。生成内容请结合原文核对。")
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.muted)
                        Toggle("我已阅读并同意《AI 使用协议》", isOn: $consentAccepted)
                            .font(.footnote.weight(.medium))
                            .tint(StudyPalette.accent)
                            .disabled(isAccountBusy)
                        Button("同意并开启外部 AI") { Task { await store.acceptAIConsent() } }
                            .disabled(isAccountBusy || !consentAccepted)
                    } else if let consentVersion = settings.consentVersion {
                        Label("已签署 \(consentVersion)\(settings.consentAt.map { " · \($0.prefix(10))" } ?? "")", systemImage: "checkmark.shield")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(StudyPalette.success)
                    } else {
                        Text("当前服务未启用外部 AI，无需签署。")
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    policyToggle("允许使用外部 AI 服务", detail: "决定是否向外部 AI 服务发送内容。", keyPath: \.sendToExternal,
                                 disabled: settings.requiresConsent && settings.consentVersion == nil)
                    policyToggle("允许发送图片内容", detail: "图片不会脱离这项设置单独授权。", keyPath: \.sendImageContent)
                    policyToggle("启用个人信息识别", detail: "在请求处理中识别可能的个人信息。", keyPath: \.piiDetection)
                    policyToggle("记录 AI 调用审计", detail: "保留服务调用的审计记录。", keyPath: \.auditLogging)
                    Button("保存数据偏好") { Task { await store.saveAIDataPolicy(policy) } }
                        .disabled(isAccountBusy)
                }
            } else if isAccountBusy {
                Section("AI 与数据") { ProgressView("正在读取账户设置…") }
            }

            Section {
                DisclosureGroup("开发与服务") {
                    Text("仅在自建服务时修改。保存后会退出当前会话。")
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                    TextField("https://study.example.com", text: $address)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    Button("保存并重新登录") {
                        store.setServiceAddress(address)
                        store.logout()
                    }
                    .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            Section {
                Button(role: .destructive) { store.logout() } label: {
                    Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .navigationTitle("我的")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            address = store.api.baseURL
            displayName = store.profile?.displayName ?? ""
            await store.loadAccountSettings()
            if let loaded = store.aiSettings { policy = loaded.dataPolicy }
        }
        .onChange(of: store.profile?.displayName ?? "") { _, value in displayName = value }
        .onChange(of: store.aiSettings) { _, value in
            if let value { policy = value.dataPolicy }
        }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            Task {
                do {
                    guard let original = try await item.loadTransferable(type: Data.self) else {
                        store.accountError = "这张图片暂时无法读取，请换一张图片后重试。"
                        return
                    }
                    guard original.count <= 10 * 1024 * 1024 else {
                        store.accountError = "头像不能超过 10 MB，请换一张小一点的。"
                        return
                    }
                    let source = CGImageSourceCreateWithData(original as CFData, nil)
                    let thumbnail = source.flatMap {
                        CGImageSourceCreateThumbnailAtIndex(
                            $0,
                            0,
                            [
                                kCGImageSourceCreateThumbnailFromImageAlways: true,
                                kCGImageSourceCreateThumbnailWithTransform: true,
                                kCGImageSourceThumbnailMaxPixelSize: 1024,
                            ] as CFDictionary
                        )
                    }
                    guard let thumbnail,
                          let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.88) else {
                        store.accountError = "这张图片暂时无法读取，请换一张图片后重试。"
                        return
                    }
                    await store.saveAvatar(data: jpeg, fileName: "astella-avatar.jpg")
                    avatarItem = nil
                } catch {
                    store.accountError = "头像没有读取成功：\(error.localizedDescription)"
                }
            }
        }
    }

    private func policyToggle(_ title: String, detail: String, keyPath: WritableKeyPath<AIDataPolicy, Bool>, disabled: Bool = false) -> some View {
        Toggle(isOn: Binding(
            get: { policy[keyPath: keyPath] },
            set: { policy[keyPath: keyPath] = $0 }
        )) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.caption).foregroundStyle(StudyPalette.muted)
            }
        }
        .tint(StudyPalette.accent)
        .disabled(store.isAccountBusy || disabled)
    }

    private func accountNotice(_ message: String, symbol: String, color: Color) -> some View {
        Label(message, systemImage: symbol)
            .font(.footnote.weight(.medium))
            .foregroundStyle(color)
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var profileInitial: String {
        String((store.profile?.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first)
            ?? store.profile?.email.first
            ?? "阅").uppercased()
    }

    private func permissionDescription(_ level: String?) -> String {
        switch level {
        case "read_only": "需要写入或执行操作时，伴星会先给你预览并征求确认。"
        case "full": "已授权范围内的可逆操作可以直接执行；不可逆操作仍需你确认。"
        case "guided": "伴星会先说明下一步，再等你确认后执行。"
        default: store.isAccountBusy ? "正在读取当前权限…" : "暂时没有读取到权限信息。"
        }
    }

    private func accountLink(title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17, weight: .medium)).foregroundStyle(StudyPalette.accent)
                .frame(width: 34, height: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.caption).foregroundStyle(StudyPalette.muted)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.muted.opacity(0.8))
        }
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

private struct ProfileAvatarImage: View {
    @Environment(AppStore.self) private var store
    var url: String
    var fallback: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(fallback).font(.title2.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    .frame(width: 54, height: 54).background(StudyPalette.sky)
            }
        }
        .frame(width: 54, height: 54)
        .clipShape(Circle())
        .task(id: url) {
            do { image = UIImage(data: try await store.api.imageData(url)) }
            catch { image = nil }
        }
    }
}

private struct MobileSettingsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @ScaledMetric(relativeTo: .body) private var previewPointSize: CGFloat = 16
    @State private var textScale = 1.0
    @State private var showRecords = false
    @State private var reduceMotion = false

    private var userId: String { store.profile?.userId ?? "unknown" }

    var body: some View {
        Form {
            Section("阅读") {
                Picker("正文大小", selection: Binding(
                    get: { textScale },
                    set: { value in
                        textScale = value
                        store.setReadingScale(value)
                        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "textScale"))
                    }
                )) {
                    Text("标准").tag(1.0)
                    Text("较大").tag(1.2)
                    Text("大字").tag(1.4)
                }
                .pickerStyle(.segmented)
                Text("先看一个例子，再用自己的话解释。")
                    .font(.system(size: previewPointSize * textScale))
                    .lineSpacing(4)
                    .foregroundStyle(StudyPalette.ink)
                    .padding(.vertical, 5)
                Toggle("打开时显示交流记录", isOn: Binding(
                    get: { showRecords },
                    set: { value in
                        showRecords = value
                        store.setChatShowsRecords(value)
                        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "showRecords"))
                    }
                ))
                Text("伴星场景与记录共用同一段交流。")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
            }
            Section("我们怎样相处") { ParticipationPreferencesEditor() }
            Section("动效") {
                Toggle("减少动效", isOn: Binding(
                    get: { reduceMotion },
                    set: { value in
                        reduceMotion = value
                        store.setLocalReduceMotion(value)
                        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "reduceMotion"))
                    }
                ))
                .tint(StudyPalette.accent)
                .disabled(systemReduceMotion)
                Text(systemReduceMotion ? "系统辅助功能已要求减少动效。" : reduceMotion ? "此设备会减少页面过渡。" : "使用轻柔的原生页面过渡。")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
            }
            Section {
                Text("阅读字号、打开方式和动效偏好只保存在这台设备上。")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
            }
        }
        .scrollContentBackground(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .navigationTitle("使用设置").navigationBarTitleDisplayMode(.inline)
        .task(id: userId) {
            textScale = UserDefaults.standard.object(forKey: mobilePreferenceKey(userId, "textScale")) as? Double ?? 1
            showRecords = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "showRecords"))
            reduceMotion = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "reduceMotion"))
        }
    }
}

private struct ParticipationPreferencesEditor: View {
    @Environment(AppStore.self) private var store
    @State private var revision = 0
    @State private var enabled = true
    @State private var markdown = ""
    @State private var savedMarkdown = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var error: String?
    @State private var notice: String?
    @State private var conflictLatestMarkdown: String?
    @State private var showDefaults = false
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
                Text("默认陪伴能力一直生效；个人约定用于补充你希望她怎样陪你学习。")
                    .font(.footnote).foregroundStyle(StudyPalette.muted)
                DisclosureGroup("默认陪伴方式", isExpanded: $showDefaults) {
                    Text("页面帮助、自然分句、主动问候与久学休息会根据你实际在看的内容和相处偏好判断是否出现。")
                        .font(.footnote).foregroundStyle(StudyPalette.muted).padding(.top, 7)
                }
                .font(.subheadline.weight(.medium)).tint(StudyPalette.accent)
                if isLoading && !loaded { ProgressView("正在读取个人约定…") }
                else {
                    TextField("写下你希望她怎样陪你学习", text: $markdown, axis: .vertical)
                        .lineLimit(2...5)
                        .padding(10)
                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .disabled(isSaving)
                    HStack {
                        Button(isSaving ? "正在保存…" : "保存约定") { Task { await save(enabled: enabled) } }
                            .modifier(SecondaryActionStyle()).disabled(isSaving || !loaded || markdown == savedMarkdown)
                        if !markdown.isEmpty {
                            Button(enabled ? "暂停" : "恢复") { Task { await save(enabled: !enabled) } }
                                .font(.subheadline.weight(.medium)).foregroundStyle(StudyPalette.accent).disabled(isSaving)
                        }
                    }
                    Text(markdown.isEmpty ? "尚未添加个人约定，默认陪伴方式会照常生效。" : enabled ? "个人约定正在生效。" : "个人约定已暂停，默认陪伴方式仍会生效。")
                        .font(.caption).foregroundStyle(StudyPalette.muted)
                }
                if let error {
                    featureAccountMessage(error, isError: true, retry: {
                        Task { await load(preservingDraft: error.contains("另一台设备刚改过约定")) }
                    })
                }
                if let notice { featureAccountMessage(notice, isError: false, retry: nil) }
                if let conflictLatestMarkdown {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("另一台设备保存的版本")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudyPalette.muted)
                        Text(conflictLatestMarkdown.isEmpty ? "（云端约定为空）" : conflictLatestMarkdown)
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("上方输入框仍保留你的草稿。合并需要的内容后，保存会以草稿作为最新版本。")
                            .font(.caption)
                            .foregroundStyle(StudyPalette.muted)
                        Button("用另一台设备的版本替换草稿") {
                            markdown = conflictLatestMarkdown
                            self.conflictLatestMarkdown = nil
                        }
                        .font(.footnote.weight(.medium))
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: store.profile?.userId) { await load() }
    }

    private func load(preservingDraft: Bool = false) async {
        let localDraft = markdown
        isLoading = true; error = nil
        defer { isLoading = false }
        do {
            let value = try await store.loadParticipation()
            let serverMarkdown = value["markdown"] as? String ?? ""
            revision = value["revision"] as? Int ?? 0
            enabled = value["enabled"] as? Bool ?? true
            savedMarkdown = serverMarkdown
            markdown = preservingDraft ? localDraft : serverMarkdown
            conflictLatestMarkdown = preservingDraft ? serverMarkdown : nil
            loaded = true
        } catch let cause { error = "个人约定没有同步成功：\(cause.localizedDescription)" }
    }

    private func save(enabled nextEnabled: Bool) async {
        isSaving = true; error = nil; notice = nil
        defer { isSaving = false }
        do {
            let result = try await store.saveParticipation(expectedRevision: revision, markdown: markdown, enabled: nextEnabled)
            revision = result["revision"] as? Int ?? revision + 1
            enabled = result["enabled"] as? Bool ?? nextEnabled
            markdown = result["markdown"] as? String ?? markdown
            savedMarkdown = markdown
            conflictLatestMarkdown = nil
            notice = nextEnabled ? "个人约定已保存并生效。" : "个人约定已暂停，默认陪伴方式仍会生效。"
        } catch {
            let apiError = error as? MobileAPIError
            if apiError?.status == 409 {
                self.error = "另一台设备刚改过约定。读取最新版本时会保留你的草稿，核对并合并后再保存。"
            } else {
                self.error = "这次没有保存成功，编辑内容还在。\(error.localizedDescription)"
            }
        }
    }
}

private struct CompanionCenterScreen: View {
    @Environment(AppStore.self) private var store

    private var latest: String {
        store.streamingText.isEmpty ? store.messages.last(where: { $0.role == "assistant" })?.displayText ?? "还没有新的回复，回去告诉她你想聊什么。" : store.streamingText
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .center, spacing: 12) {
                        CompanionPortrait().frame(width: 118, height: 136)
                        VStack(alignment: .leading, spacing: 6) {
                            SectionEyebrow(text: "拾星 · ASTELLA")
                            Text("伴星")
                                .font(.system(.title, weight: .semibold))
                                .foregroundStyle(StudyPalette.ink)
                            Text(store.profile?.workspaceName ?? "我的书房")
                                .font(.subheadline)
                                .foregroundStyle(StudyPalette.muted)
                            HStack(spacing: 6) {
                                Circle().fill(store.realtimeStatus == "已连接" ? StudyPalette.success : StudyPalette.muted)
                                    .frame(width: 7, height: 7)
                                Text(store.realtimeStatus)
                                    .font(.caption)
                                    .foregroundStyle(StudyPalette.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }

                    Divider().overlay(StudyPalette.paperEdge)
                    VStack(alignment: .leading, spacing: 8) {
                        SectionEyebrow(text: "最近一次回应")
                        Text(latest)
                            .font(.subheadline)
                            .lineSpacing(3)
                            .foregroundStyle(StudyPalette.ink)
                            .lineLimit(5)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(spacing: 3) {
                        Button {
                            store.returnToConversation(records: false)
                        } label: {
                            Label("回到伴星身边", systemImage: "bubble.left.and.bubble.right")
                                .frame(maxWidth: .infinity)
                        }
                        .modifier(PrimaryActionStyle())
                        Button {
                            store.returnToConversation(records: true)
                        } label: {
                            Label("查看完整记录", systemImage: "book.open")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(StudyPalette.accent)
                        .frame(minHeight: 44)
                    }
                    .padding(.top, 3)
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
            }
            .scrollIndicators(.hidden)
        }
        .background(DawnBackground()).navigationTitle("伴星中心").navigationBarTitleDisplayMode(.inline)
    }
}

func mobilePreferenceKey(_ userId: String, _ name: String) -> String {
    "astella.mobile.\(userId).\(name)"
}

private func featureAccountMessage(_ text: String, isError: Bool, retry: (() -> Void)?) -> some View {
    HStack(alignment: .top, spacing: 8) {
        Image(systemName: isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
            .foregroundStyle(isError ? StudyPalette.danger : StudyPalette.success)
        VStack(alignment: .leading, spacing: 5) {
            Text(text).font(.footnote).foregroundStyle(StudyPalette.muted)
            if let retry { Button("重新读取", action: retry).font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent) }
        }
    }.padding(11).frame(maxWidth: .infinity, alignment: .leading).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13))
}
