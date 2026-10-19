import AVFoundation
import Foundation
import SwiftUI
import UIKit
import UserNotifications

struct DevicePermissionsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var microphoneStatus = "正在读取"
    @State private var notificationsStatus = "正在读取"
    @State private var isRequestingMicrophone = false
    @State private var isRequestingNotifications = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("系统权限只在对应功能需要时才会请求。照片和文件通过 iOS 选择器按次授权，不会读取整个图库或文件夹。")
                    .font(.system(size: 14))
                    .lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
                    .padding(.bottom, 17)

                CompanionBubbleRow(text: "我需要其中几项才能陪你读书。关掉时，我会说明原因，也会给你别的办法。")
                    .padding(.bottom, 24)

                sectionLabel("权限")
                    .padding(.bottom, 11)

                VStack(spacing: 0) {
                    permissionRow(
                        icon: .mic,
                        title: "麦克风",
                        detail: "语音随记时录音",
                        status: microphoneStatus,
                        actionTitle: microphoneActionTitle,
                        action: microphoneAction
                    )
                    permissionDivider
                    permissionRow(
                        icon: .photo,
                        title: "相册",
                        detail: "选择图片作为材料",
                        status: "系统按次授权",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        icon: .camera,
                        title: "相机",
                        detail: "当前版本没有拍摄入口",
                        status: "未使用",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        icon: .document,
                        title: "文件",
                        detail: "通过选择器导入 PDF 与文档",
                        status: "系统按次授权",
                        actionTitle: nil,
                        action: nil
                    )
                    permissionDivider
                    permissionRow(
                        icon: .info,
                        title: "通知",
                        detail: "复习与陪伴提醒",
                        status: notificationsStatus,
                        actionTitle: notificationActionTitle,
                        action: notificationAction
                    )
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 6)
                .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))

                sectionLabel("被拒绝时怎么办")
                    .padding(.top, 28)
                    .padding(.bottom, 11)

                VStack(spacing: 0) {
                    guidanceRow(title: "相机", detail: "可以先用文件选择器选图片，之后再补拍。")
                    permissionDivider
                    guidanceRow(title: "通知", detail: "仍会在应用内显示提醒，只是没有系统推送。")
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 6)
                .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))

                VStack(alignment: .leading, spacing: 7) {
                    SectionEyebrow(text: "伴星操作范围")
                    Text(companionPermissionTitle)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text(companionPermissionDetail)
                        .font(.system(size: 12))
                        .lineSpacing(4)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .background(StudyPalette.paper.opacity(0.78), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7))
                .padding(.top, 26)

                Button {
                    Task { await refreshPermissionStatus() }
                } label: {
                    HStack(spacing: 9) {
                        AstellaGlyph(kind: .refresh, tint: StudyPalette.accent).frame(width: 16, height: 16)
                        Text("刷新权限状态").font(.system(size: 15, weight: .medium))
                    }
                    .foregroundStyle(StudyPalette.ink)
                    .padding(.horizontal, 18)
                    .frame(minHeight: 46)
                    .modifier(StudyGlassSurfaceStyle(radius: 23, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .padding(.top, 26)
            }
            .padding(.horizontal, 22)
            .padding(.top, 18)
            .padding(.bottom, 40)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "设备权限") }
        .task { await refreshPermissionStatus() }
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12.5, weight: .medium))
            .tracking(0.6)
            .foregroundStyle(StudyPalette.muted)
            .padding(.leading, 2)
    }

    private var microphoneActionTitle: String? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "撤销"
        case .denied: "去系统设置"
        case .undetermined: isRequestingMicrophone ? "正在请求…" : "允许"
        @unknown default: nil
        }
    }

    private var microphoneAction: (() -> Void)? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: { openApplicationSettings() }
        case .denied: { openApplicationSettings() }
        case .undetermined: { requestMicrophone() }
        @unknown default: nil
        }
    }

    private var notificationActionTitle: String? {
        switch notificationsStatus {
        case "已允许": "撤销"
        case "已拒绝": "去系统设置"
        case "未请求": isRequestingNotifications ? "正在请求…" : "允许"
        default: nil
        }
    }

    private var notificationAction: (() -> Void)? {
        switch notificationsStatus {
        case "已允许", "已拒绝": { openApplicationSettings() }
        case "未请求": { requestNotifications() }
        default: nil
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
        Rectangle()
            .fill(StudyPalette.paperEdge.opacity(0.55))
            .frame(height: 0.7)
            .padding(.leading, 68)
    }

    private func permissionRow(icon: AstellaGlyphKind, title: String, detail: String, status: String, actionTitle: String?, action: (() -> Void)?) -> some View {
        HStack(alignment: .center, spacing: 13) {
            AstellaGlyph(kind: icon, tint: StudyPalette.accent)
                .frame(width: 17, height: 17)
                .frame(width: 36, height: 36)
                .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            HStack(spacing: 8) {
                SettingsStatusPill(text: status, color: permissionColor(status))
                if let actionTitle, let action {
                    Button(action: action) {
                        Text(actionTitle)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(StudyPalette.ink)
                            .padding(.horizontal, 11)
                            .frame(minHeight: 28)
                            .background(StudyPalette.paper.opacity(0.9), in: Capsule())
                            .overlay(Capsule().stroke(StudyPalette.paperEdge.opacity(0.7), lineWidth: 0.7))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .disabled(isRequestingMicrophone || isRequestingNotifications)
                }
            }
        }
        .padding(.vertical, 12)
        .frame(minHeight: 62)
    }

    private func guidanceRow(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(StudyPalette.ink)
            Text(detail).font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
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
        #if DEBUG
        if store.uiReviewMode != nil {
            if store.companionPermissionLevel == nil { store.companionPermissionLevel = "guided" }
            return
        }
        #endif
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

    private func requestNotifications() {
        guard !isRequestingNotifications else { return }
        isRequestingNotifications = true
        Task { @MainActor in
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshPermissionStatus()
            isRequestingNotifications = false
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
    @State private var isExporting = false
    @State private var exportFileURL: URL?
    @State private var showExportSheet = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CompanionBubbleRow(text: "你的手记只在你允许时才会交给我。下面每一项都可以单独关掉。")
                    .padding(.bottom, 22)

                consentStatus

                if let settings = store.aiSettings, settings.requiresConsent && settings.consentVersion == nil {
                    consentForm.padding(.top, 18)
                }

                sectionLabel("授权项")
                    .padding(.top, 26)
                    .padding(.bottom, 11)

                VStack(spacing: 0) {
                    policyRow(icon: .lock, title: "把选中的手记外发给模型",
                              detail: "关闭后伴星读不到手记内容；阅读与手记不受影响",
                              keyPath: \.sendToExternal,
                              disabled: store.aiSettings?.requiresConsent == true && store.aiSettings?.consentVersion == nil)
                    policyDivider
                    policyRow(icon: .photo, title: "外发内容可包含图片",
                              detail: "关闭后图片只在本地处理，不进入模型",
                              keyPath: \.sendImageContent)
                    policyDivider
                    policyRow(icon: .shield, title: "外发前做个人信息检测",
                              detail: "命中时先提醒，可撤回再发送",
                              keyPath: \.piiDetection)
                    policyDivider
                    policyRow(icon: .document, title: "记录 AI 调用审计日志",
                              detail: "供你自查调用记录",
                              keyPath: \.auditLogging)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 6)
                .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))

                Button(isLoading || store.isAccountBusy ? "正在保存…" : "保存数据偏好") {
                    Task { await store.saveAIDataPolicy(policy) }
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(StudyPalette.accentLabel)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(
                    LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                )
                .buttonStyle(AstellaPressStyle())
                .disabled(isLoading || store.isAccountBusy)
                .opacity(isLoading || store.isAccountBusy ? 0.65 : 1)
                .padding(.top, 20)

                if let message = store.accountError { OrbitDetailMessage(text: message, isError: true).padding(.top, 14) }
                else if let message = store.accountNotice { OrbitDetailMessage(text: message, isError: false).padding(.top, 14) }
                if let message = exportError { OrbitDetailMessage(text: message, isError: true).padding(.top, 14) }

                sectionLabel("数据与记录")
                    .padding(.top, 30)
                    .padding(.bottom, 11)

                VStack(spacing: 0) {
                    infoRow(icon: .book, title: "对话记录保存", detail: "本地保留时长跟随服务策略", value: "跟随服务")
                    policyDivider
                    Button {
                        Task { await prepareExport() }
                    } label: {
                        infoRow(icon: .document, title: "导出我的数据", detail: "手记、批注与记忆导出为 JSON", value: isExporting ? "正在整理…" : nil, showsChevron: true)
                    }
                    .buttonStyle(.plain)
                    .disabled(isExporting)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 6)
                .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))

                Text("以上为你的账号设置。阅读和手记不需要 AI 授权；关闭外发后，伴星回应会使用本地可用内容。")
                    .font(.system(size: 11.5))
                    .lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, 22)
            .padding(.top, 18)
            .padding(.bottom, 40)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "AI 使用授权与数据") }
        .task(id: store.profile?.userId) { await load() }
        .onChange(of: store.aiSettings) { _, settings in
            if let settings { policy = settings.dataPolicy }
        }
        .sheet(isPresented: $showExportSheet) {
            NavigationStack {
                VStack(spacing: 18) {
                    AstellaGlyph(kind: .download, tint: StudyPalette.accent)
                        .frame(width: 28, height: 28)
                        .frame(width: 62, height: 62)
                        .background(StudyPalette.sky, in: Circle())
                    Text("书房数据已整理成 JSON 文件").font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                    Text("你可以存到文件，或分享到别的设备。")
                        .font(.footnote).foregroundStyle(StudyPalette.muted)
                    if let exportFileURL {
                        ShareLink(item: exportFileURL) {
                            Text("分享或存储文件").modifier(PrimaryActionStyle())
                        }
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .background(DawnBackground())
                .navigationTitle("导出我的数据")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { showExportSheet = false } } }
            }
            .presentationDetents([.medium])
        }
    }

    @State private var exportError: String?

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12.5, weight: .medium))
            .tracking(0.6)
            .foregroundStyle(StudyPalette.muted)
            .padding(.leading, 2)
    }

    @ViewBuilder private var consentStatus: some View {
        if let settings = store.aiSettings, let version = settings.consentVersion {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("已签署 AI 使用授权").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    Spacer(minLength: 4)
                    Text(consentStamp(version: version, date: settings.consentAt))
                        .font(.system(size: 10))
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(1)
                }
                Text("读取你选择的手记，用于生成回应与摘要")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(StudyPalette.ink)
                if !settings.dataPolicy.sendToExternal {
                    Text("授权仍有效，但外部 AI 已关闭；需要外部服务的功能不会发送内容。")
                        .font(.system(size: 11)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                }
            }
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StudyPalette.sky.opacity(0.62), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.sky, lineWidth: 0.8))
        } else if store.aiSettings?.requiresConsent == true {
            VStack(alignment: .leading, spacing: 7) {
                Text("尚未签署 AI 使用授权").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text("未确认前，需要授权的外部 AI 调用不会执行。阅读与手记仍然可用。")
                    .font(.system(size: 12)).lineSpacing(4).foregroundStyle(StudyPalette.muted)
            }
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StudyPalette.paper.opacity(0.85), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
        } else if store.aiSettings != nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("当前服务不要求签署").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text("你仍可在下方管理数据偏好。服务关闭外部 AI 时，这些开关不会触发外发。")
                    .font(.system(size: 12)).lineSpacing(4).foregroundStyle(StudyPalette.muted)
            }
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StudyPalette.paper.opacity(0.85), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
        } else if isLoading {
            OrbitLoadingRow()
        } else {
            OrbitDetailMessage(text: "暂时没有读到授权状态。", isError: true)
        }
    }

    private func consentStamp(version: String, date: String?) -> String {
        guard let date, !date.isEmpty else { return version }
        return "\(version) · \(String(date.prefix(10)))"
    }

    private var consentForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("授权前请了解").font(.system(size: 12, weight: .semibold)).foregroundStyle(StudyPalette.muted)
            Text("你主动发起需要 AI 的任务时，任务所需的手记、对话或图片可能会发送给模型服务；语音讲解会把讲解文字发送给语音服务。外部调用遵循下方的数据偏好。")
                .font(.system(size: 12)).lineSpacing(4).foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("我已阅读并同意《AI 使用协议》", isOn: $consentAccepted)
                .font(.system(size: 13, weight: .medium)).tint(StudyPalette.accent).disabled(store.isAccountBusy)
            Button(store.isAccountBusy ? "正在保存…" : "同意并开启外部 AI") {
                Task { await store.acceptAIConsent() }
            }
            .font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.accentLabel)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .buttonStyle(AstellaPressStyle()).disabled(store.isAccountBusy || !consentAccepted)
        }
        .padding(17)
        .background(StudyPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
    }

    private var policyDivider: some View {
        Rectangle()
            .fill(StudyPalette.paperEdge.opacity(0.55))
            .frame(height: 0.7)
            .padding(.leading, 68)
    }

    private func policyRow(icon: AstellaGlyphKind, title: String, detail: String, keyPath: WritableKeyPath<AIDataPolicy, Bool>, disabled: Bool = false) -> some View {
        Toggle(isOn: Binding(get: { policy[keyPath: keyPath] }, set: { policy[keyPath: keyPath] = $0 })) {
            HStack(alignment: .center, spacing: 13) {
                AstellaGlyph(kind: icon, tint: StudyPalette.accent)
                    .frame(width: 17, height: 17)
                    .frame(width: 36, height: 36)
                    .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    Text(detail).font(.system(size: 11)).lineSpacing(2).foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .tint(StudyPalette.accent)
        .disabled(store.isAccountBusy || disabled)
        .padding(.vertical, 11)
        .frame(minHeight: 60)
    }

    private func infoRow(icon: AstellaGlyphKind, title: String, detail: String, value: String?, showsChevron: Bool = false) -> some View {
        HStack(alignment: .center, spacing: 13) {
            AstellaGlyph(kind: icon, tint: StudyPalette.accent)
                .frame(width: 17, height: 17)
                .frame(width: 36, height: 36)
                .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 6)
            if let value {
                Text(value).font(.system(size: 12)).foregroundStyle(StudyPalette.muted)
            }
            if showsChevron {
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.8)).frame(width: 15, height: 15)
            }
        }
        .padding(.vertical, 12)
        .frame(minHeight: 62)
        .contentShape(Rectangle())
    }

    private func load() async {
        guard !isLoading else { return }
        #if DEBUG
        if store.uiReviewMode != nil {
            if let settings = store.aiSettings { policy = settings.dataPolicy }
            return
        }
        #endif
        isLoading = true
        defer { isLoading = false }
        if store.aiSettings == nil { await store.loadAccountSettings() }
        if let settings = store.aiSettings { policy = settings.dataPolicy }
    }

    private func prepareExport() async {
        guard !isExporting else { return }
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            let payload = try await store.api.request("/export/workspace")
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            let safeName = (store.profile?.workspaceName ?? "Astella").replacingOccurrences(of: "/", with: "-")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(safeName)-数据导出.json")
            try data.write(to: url, options: .atomic)
            exportFileURL = url
            showExportSheet = true
        } catch {
            exportError = mobilePageError(error, fallback: "数据导出没有完成，请稍后重试。")
        }
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
            VStack(alignment: .leading, spacing: 0) {
                Text("仅在连接自建或私有部署时修改。保存后会退出当前会话，需要用新地址重新登录。")
                    .font(.system(size: 14))
                    .lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
                    .padding(.bottom, 18)

                Text("服务地址")
                    .font(.system(size: 12.5, weight: .medium))
                    .tracking(0.6)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.leading, 2)
                    .padding(.bottom, 8)

                TextField("https://study.example.com", text: $address)
                    .font(.system(size: 16))
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .focused($isAddressFocused)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 52)
                    .modifier(StudyGlassSurfaceStyle(radius: 16, interactive: true))
                    .onChange(of: address) { _, _ in connectionState = .idle }

                connectionFeedback
                    .padding(.top, 12)

                HStack(spacing: 12) {
                    Button(connectionState.isTesting ? "正在测试…" : "测试连接") { Task { await testConnection() } }
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(StudyPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.7))
                        .buttonStyle(AstellaPressStyle())
                        .disabled(connectionState.isTesting || validatedHealthURL() == nil)

                    Button("保存并重新登录") {
                        guard let normalized = normalizedAddress() else {
                            connectionState = .failed("请输入有效的 http 或 https 服务地址。")
                            return
                        }
                        isAddressFocused = false
                        store.setServiceAddress(normalized)
                        store.logout()
                    }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.accentLabel)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(
                        LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                    )
                    .buttonStyle(AstellaPressStyle())
                    .disabled(normalizedAddress() == nil)
                }
                .padding(.top, 14)

                VStack(alignment: .leading, spacing: 6) {
                    Text("保存后需要重新登录才会生效。输入会作为草稿保留，出错不会丢失。")
                    Text("当前生效：\(store.api.baseURL)")
                    Text("公网服务建议使用 HTTPS。本地开发或可信内网可使用 HTTP。")
                    Button("恢复默认地址") {
                        address = store.api.defaultBaseURL
                        connectionState = .idle
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.top, 4)
                }
                .font(.system(size: 12))
                .lineSpacing(3)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 2)
                .padding(.top, 16)
            }
            .padding(.horizontal, 22)
            .padding(.top, 18)
            .padding(.bottom, 40)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
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
                .foregroundStyle(StudyPalette.accentLabel)
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
