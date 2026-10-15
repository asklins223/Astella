import SwiftUI
import PhotosUI
import UIKit

@main
struct AstellaApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(StudyPalette.accent)
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        applicationRoot
    }

    @ViewBuilder
    private var applicationRoot: some View {
        Group {
            if store.profile != nil {
                MainTabShell()
            } else if store.isAuthenticated {
                SessionRecoveryScreen()
            } else {
                LoginScreen()
            }
        }
        .transaction { if store.localReduceMotion { $0.animation = nil } }
        .background {
            DawnBackground()
        }
    }
}

private struct SessionRecoveryScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "books.vertical")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(StudyPalette.accent)
                .frame(width: 64, height: 64)
                .background(StudyPalette.sky, in: Circle())
            Text("正在接回你的书房")
                .font(.title2.weight(.semibold)).foregroundStyle(StudyPalette.ink)
            Text(store.errorMessage ?? "正在恢复登录状态与学习记录。")
                .font(.subheadline).foregroundStyle(StudyPalette.muted).multilineTextAlignment(.center)
            if store.isLoading {
                ProgressView().padding(.top, 4)
            } else {
                Button("重新连接") { Task { await store.restoreSession() } }
                    .modifier(PrimaryActionStyle()).padding(.top, 4)
                Button("返回登录") { store.logout() }
                    .font(.subheadline.weight(.medium)).foregroundStyle(StudyPalette.accent)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DawnBackground())
    }
}

struct MainTabShell: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        TabView(selection: Binding(get: { store.selectedTab }, set: { store.selectedTab = $0 })) {
            NavigationStack {
                ConversationScreen()
                    .navigationTitle("对话")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .id(store.conversationRootRevision)
            .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right.fill") }
            .tag(MainTab.conversation)

            NavigationStack {
                HandScreen()
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                            } label: {
                                Image(systemName: "person.crop.circle")
                            }
                            .accessibilityLabel("我的账户")
                        }
                    }
            }
            .tabItem { Label("手边", systemImage: "tray.full") }
            .tag(MainTab.hand)

            NavigationStack {
                NotesScreen()
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                            } label: {
                                Image(systemName: "person.crop.circle")
                            }
                            .accessibilityLabel("我的账户")
                        }
                    }
            }
            .tabItem { Label("手记", systemImage: "book.closed") }
            .tag(MainTab.notes)
        }
    }
}

struct LoginScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var route: AuthRoute = .login
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var displayName = ""
    @State private var inviteToken = ""
    @State private var code = ""
    @State private var showInviteField = false
    @State private var resendIn = 0
    @FocusState private var focusedInput: AuthInput?

    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validEmail: Bool {
        let parts = normalizedEmail.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }
    private var validCode: Bool { code.count == 6 && code.allSatisfy(\.isNumber) }
    private var passwordReady: Bool { password.count >= 8 && password.count <= 200 }
    private var confirmMatches: Bool { !confirmPassword.isEmpty && confirmPassword == password }
    private var canContinue: Bool {
        switch route {
        case .login: validEmail && !password.isEmpty
        case .register: validEmail
        case .registerPassword, .resetPassword: passwordReady && confirmMatches
        case .registerCode, .reset, .emailLoginCode: validCode
        case .forgot, .emailLogin: validEmail
        }
    }

    private var title: String {
        switch route {
        case .login: "继续你的学习"
        case .register: "创建你的书房"
        case .registerPassword: "设置登录密码"
        case .registerCode: "确认你的邮箱"
        case .forgot: "重置登录密码"
        case .reset: "验证你的邮箱"
        case .resetPassword: "设置新密码"
        case .emailLogin: "通过邮箱登录"
        case .emailLoginCode: "输入登录验证码"
        }
    }

    private var detail: String {
        switch route {
        case .login: "登录后，你的手记、对话和进度都会同步。"
        case .register: "填写邮箱和称呼，下一步为书房设置密码。"
        case .registerPassword: "密码至少 8 位。设置完成后，我们会发送验证邮件。"
        case .registerCode: "输入发到邮箱的 6 位验证码，完成注册。"
        case .forgot: "填写注册邮箱，我们会发送密码重置验证码。"
        case .reset: "输入邮件中的 6 位验证码，确认这是你的邮箱。"
        case .resetPassword: "设置至少 8 位新密码，完成后即可重新登录。"
        case .emailLogin: "我们会发送一次性验证码，不需要密码。"
        case .emailLoginCode: "输入邮件中的 6 位验证码，安全登录书房。"
        }
    }

    private var symbol: String {
        switch route {
        case .login: "book.closed.fill"
        case .register: "person.crop.circle.badge.plus"
        case .registerPassword, .resetPassword: "lock.fill"
        case .registerCode, .reset, .emailLoginCode: "envelope.badge.fill"
        case .forgot: "key.fill"
        case .emailLogin: "envelope.fill"
        }
    }

    private var progress: (current: Int, total: Int)? {
        switch route {
        case .register: (1, 3)
        case .registerPassword: (2, 3)
        case .registerCode: (3, 3)
        case .forgot: (1, 3)
        case .reset: (2, 3)
        case .resetPassword: (3, 3)
        case .emailLogin: (1, 2)
        case .emailLoginCode: (2, 2)
        case .login: nil
        }
    }

    private var codePurpose: String {
        switch route {
        case .registerPassword, .registerCode: "register"
        case .forgot, .reset, .resetPassword: "reset_password"
        default: "login"
        }
    }

    private var errorTitle: String {
        switch route {
        case .login, .emailLoginCode: "登录没有完成"
        case .register, .registerPassword, .registerCode: "账号还没有创建"
        case .forgot, .reset, .resetPassword: "密码还没有更新"
        case .emailLogin: "验证码没有发送"
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let compact = proxy.size.height < 660 || focusedInput != nil || dynamicTypeSize.isAccessibilitySize
                || (store.authErrorMessage != nil && proxy.size.height < 720)
            VStack(alignment: .leading, spacing: 0) {
                if route == .login {
                    brandHeader(compact: compact)
                    loginHeading(compact: compact)
                } else {
                    flowHeader(compact: compact)
                }

                authForm(compact: compact)
                    .id(route)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 5)))
                if !compact {
                    routeFooter
                        .padding(.top, route == .login ? 13 : 10)
                }
                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 27)
            .padding(.top, compact ? 8 : 20)
            .padding(.bottom, compact ? 8 : 20)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: compact)
            .disabled(store.isLoading)
        }
        .task(id: resendIn) {
            guard resendIn > 0 else { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if !Task.isCancelled { resendIn -= 1 }
        }
        .onChange(of: route) { _, _ in focusedInput = nil }
        .onChange(of: email) { _, _ in
            code = ""
            resendIn = 0
            store.clearAuthFeedback()
        }
        .onChange(of: password) { _, _ in
            if route != .login || store.authNoticeMessage == nil { store.authErrorMessage = nil }
        }
        .onChange(of: code) { _, value in
            let digits = String(value.filter(\.isNumber).prefix(6))
            if digits != value { code = digits }
            store.authErrorMessage = nil
        }
    }

    private func brandHeader(compact: Bool) -> some View {
        HStack(spacing: 11) {
            Image("BrandMark")
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: compact ? 38 : 46, height: compact ? 38 : 46)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("拾星笔记")
                    .font(compact ? .subheadline.weight(.semibold) : .headline.weight(.semibold))
                    .tracking(-0.35)
                    .foregroundStyle(StudyPalette.ink)
                Text("ASTELLA")
                    .font(.system(.caption2, design: .rounded).weight(.medium))
                    .tracking(2.0)
                    .foregroundStyle(StudyPalette.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("拾星笔记，Astella")
        .padding(.top, compact ? 2 : 7)
    }

    private func loginHeading(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            Text(title)
                .font(compact ? .title.weight(.semibold) : .largeTitle.weight(.semibold))
                .tracking(-0.8)
                .foregroundStyle(StudyPalette.ink)
            if !compact {
                Text(detail)
                    .font(.body)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, compact ? 18 : 34)
    }

    private func flowHeader(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 17) {
            HStack {
                authBackButton
                Spacer()
                if let progress {
                    AuthStepProgress(current: progress.current, total: progress.total)
                }
            }
            .frame(minHeight: 42)

            HStack(spacing: 13) {
                Image(systemName: symbol)
                    .font(.system(size: compact ? 19 : 23, weight: .medium))
                    .foregroundStyle(StudyPalette.accent)
                    .frame(width: compact ? 44 : 54, height: compact ? 44 : 54)
                    .background(StudyPalette.sky, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(compact ? .title2.weight(.semibold) : .title.weight(.semibold))
                        .tracking(-0.65)
                        .foregroundStyle(StudyPalette.ink)
                    if !compact {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.top, compact ? 0 : 3)
    }

    @ViewBuilder
    private func authForm(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            switch route {
            case .login:
                AuthFieldGroup(spacing: compact ? 10 : 15) {
                    input("邮箱", placeholder: "name@example.com", text: $email, field: .email,
                          keyboardType: .emailAddress, contentType: .emailAddress, next: .password)
                    input("密码", placeholder: "输入密码", text: $password, field: .password,
                          contentType: .password, secure: true)
                }
                if !normalizedEmail.isEmpty && !validEmail { fieldError("请输入有效的邮箱地址") }
                HStack {
                    Spacer()
                    Button("忘记密码？") { navigate(.forgot) }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(StudyPalette.accent)
                        .frame(minHeight: 40)
                }
            case .register:
                AuthFieldGroup(spacing: compact ? 10 : 15) {
                    input("邮箱", placeholder: "name@example.com", text: $email, field: .email,
                          keyboardType: .emailAddress, contentType: .emailAddress, next: .displayName)
                    input("称呼", placeholder: "选填", text: $displayName, field: .displayName,
                          contentType: .name)
                }
                if !normalizedEmail.isEmpty && !validEmail { fieldError("请输入有效的邮箱地址") }
                Button(showInviteField ? "收起邀请码" : "有邀请码？") {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { showInviteField.toggle() }
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(StudyPalette.accent)
                .frame(minHeight: 36, alignment: .leading)
                if showInviteField {
                    input("邀请码", placeholder: "选填", text: $inviteToken, field: .inviteToken)
                }
            case .registerPassword:
                AuthFieldGroup(spacing: compact ? 10 : 15) {
                    input("密码", placeholder: "至少 8 个字符", text: $password, field: .password,
                          contentType: .newPassword, secure: true, next: .confirmPassword)
                    input("确认密码", placeholder: "再输入一次", text: $confirmPassword, field: .confirmPassword,
                          contentType: .newPassword, secure: true)
                }
                if !confirmPassword.isEmpty && !confirmMatches { fieldError("两次输入的密码不一致") }
                Text("密码仅用于保护你的书房，可随时重置。")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
            case .registerCode, .reset, .emailLoginCode:
                codeRecipient
                AuthCodeInput(code: $code, focusedInput: $focusedInput)
                    .frame(height: 60)
                codeActions
            case .resetPassword:
                AuthFieldGroup(spacing: compact ? 10 : 15) {
                    input("新密码", placeholder: "至少 8 个字符", text: $password, field: .password,
                          contentType: .newPassword, secure: true, next: .confirmPassword)
                    input("确认新密码", placeholder: "再输入一次", text: $confirmPassword, field: .confirmPassword,
                          contentType: .newPassword, secure: true)
                }
                if !confirmPassword.isEmpty && !confirmMatches { fieldError("两次输入的密码不一致") }
            case .forgot, .emailLogin:
                input("邮箱", placeholder: "name@example.com", text: $email, field: .email,
                      keyboardType: .emailAddress, contentType: .emailAddress)
                if !normalizedEmail.isEmpty && !validEmail { fieldError("请输入有效的邮箱地址") }
            }

            if let error = store.authErrorMessage {
                AuthFeedbackBanner(title: errorTitle, message: error, kind: .error)
            }
            if let notice = store.authNoticeMessage, route != .registerCode, route != .reset, route != .emailLoginCode {
                AuthFeedbackBanner(title: "已完成", message: notice, kind: .success)
            }

            primaryAction
                .padding(.top, compact ? 0 : 4)

            if route == .login && !compact {
                HStack(spacing: 12) {
                    Rectangle().fill(StudyPalette.paperEdge.opacity(0.8)).frame(height: 1)
                    Text("或")
                        .font(.caption)
                        .foregroundStyle(StudyPalette.muted)
                    Rectangle().fill(StudyPalette.paperEdge.opacity(0.8)).frame(height: 1)
                }
                .padding(.top, 2)
                emailCodeAction
            }
        }
        .padding(.top, route == .login ? (compact ? 14 : 23) : (compact ? 10 : 16))
    }

    private var codeRecipient: some View {
        HStack(spacing: 9) {
            Image(systemName: "envelope.fill")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(StudyPalette.accent)
            Text(normalizedEmail)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(StudyPalette.ink)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            Button("更改") {
                switch route {
                case .registerCode: navigate(.register)
                case .reset: navigate(.forgot)
                case .emailLoginCode: navigate(.emailLogin)
                default: break
                }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(StudyPalette.accent)
            .frame(minHeight: 40)
        }
        .padding(.horizontal, 12)
        .background(StudyPalette.sky.opacity(0.6), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var codeActions: some View {
        HStack {
            Text("没有收到邮件？")
                .font(.caption)
                .foregroundStyle(StudyPalette.muted)
            Spacer()
            Button(resendIn > 0 ? "\(resendIn)s 后重发" : "重新发送") {
                sendCode(advance: false)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(StudyPalette.accent)
            .disabled(store.isLoading || resendIn > 0)
            .frame(minHeight: 40)
        }
    }

    private var routeFooter: some View {
        VStack(spacing: 17) {
            if route == .login {
                HStack(spacing: 5) {
                    Text("第一次使用？").foregroundStyle(StudyPalette.muted)
                    Button("创建账号") { navigate(.register) }
                        .fontWeight(.semibold)
                        .foregroundStyle(StudyPalette.accent)
                }
                .font(.subheadline)
                HStack(spacing: 6) {
                    Image(systemName: "icloud")
                        .font(.caption)
                    Text("学习记录会在拾星各端同步")
                        .font(.caption)
                }
                .foregroundStyle(StudyPalette.muted)
            } else if route == .register {
                Button("已经有书房？返回登录") { navigate(.login) }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(minHeight: 40)
            } else if route == .forgot {
                Button("想起密码了？返回登录") { navigate(.login) }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(minHeight: 40)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func input(
        _ label: String,
        placeholder: String,
        text: Binding<String>,
        field: AuthInput,
        keyboardType: UIKeyboardType = .default,
        contentType: UITextContentType? = nil,
        secure: Bool = false,
        next: AuthInput? = nil
    ) -> some View {
        AuthTextField(
            label: label,
            placeholder: placeholder,
            text: text,
            keyboardType: keyboardType,
            contentType: contentType,
            secure: secure,
            focusedInput: $focusedInput,
            field: field,
            submitLabel: next == nil ? .go : .next
        ) {
            if let next { focusedInput = next } else { submit() }
        }
    }

    private func fieldError(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.footnote)
            Text(message)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(StudyPalette.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var primaryActionLabel: some View {
        HStack(spacing: 8) {
            if store.isLoading { ProgressView().tint(.white) }
            Text(store.isLoading ? busyTitle : actionTitle)
        }
        .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 52)
        .contentShape(Capsule())
    }

    @ViewBuilder
    private var primaryAction: some View {
        if #available(iOS 26.0, *) {
            Button(action: submit) { primaryActionLabel }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(StudyPalette.accent)
                .disabled(store.isLoading || !canContinue)
        } else {
            Button(action: submit) { primaryActionLabel }
                .modifier(PrimaryActionStyle())
                .disabled(store.isLoading || !canContinue)
        }
    }

    private var emailCodeAction: some View {
        Button { navigate(.emailLogin) } label: {
            Label("邮箱验证码登录", systemImage: "envelope")
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(StudyPalette.accent)
    }

    @ViewBuilder
    private var authBackButton: some View {
        if #available(iOS 26.0, *) {
            Button(action: goBack) {
                Label("返回", systemImage: "chevron.left")
                    .font(.subheadline.weight(.medium))
                    .frame(minHeight: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .tint(StudyPalette.accent)
        } else {
            Button(action: goBack) {
                Label("返回", systemImage: "chevron.left")
                    .font(.subheadline.weight(.medium))
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(StudyPalette.accent)
        }
    }

    private var actionTitle: String {
        switch route {
        case .login: "登录"
        case .register: "继续"
        case .registerPassword: "发送验证邮件"
        case .registerCode: "验证并创建账号"
        case .forgot: "发送重置验证码"
        case .reset: "继续设置密码"
        case .resetPassword: "更新密码"
        case .emailLogin: "发送验证码"
        case .emailLoginCode: "验证并登录"
        }
    }

    private var busyTitle: String {
        switch route {
        case .registerPassword, .forgot, .emailLogin: "正在发送验证码"
        case .registerCode: "正在创建账号"
        case .resetPassword: "正在更新密码"
        case .emailLoginCode: "正在验证"
        case .login: "正在登录"
        case .register, .reset: "请稍候"
        }
    }

    private func submit() {
        guard canContinue, !store.isLoading else { return }
        focusedInput = nil
        switch route {
        case .login:
            Task { await store.login(email: normalizedEmail, password: password) }
        case .register:
            navigate(.registerPassword)
        case .registerPassword:
            sendCode(advance: true)
        case .registerCode:
            Task {
                await store.registerAccount(email: normalizedEmail, password: password,
                                            displayName: displayName, inviteToken: inviteToken, code: code)
            }
        case .forgot, .emailLogin:
            sendCode(advance: true)
        case .reset:
            navigate(.resetPassword)
        case .resetPassword:
            Task {
                if await store.resetPassword(email: normalizedEmail, code: code, newPassword: password) {
                    password = ""
                    confirmPassword = ""
                    code = ""
                    resendIn = 0
                    navigate(.login, preserveNotice: true)
                }
            }
        case .emailLoginCode:
            Task { await store.loginWithEmailCode(email: normalizedEmail, code: code) }
        }
    }

    private func sendCode(advance: Bool) {
        focusedInput = nil
        Task {
            guard let seconds = await store.sendEmailCode(email: normalizedEmail, purpose: codePurpose) else { return }
            resendIn = seconds
            code = ""
            if advance {
                switch route {
                case .registerPassword: navigate(.registerCode, preserveNotice: true)
                case .forgot: navigate(.reset, preserveNotice: true)
                case .emailLogin: navigate(.emailLoginCode, preserveNotice: true)
                default: break
                }
            }
        }
    }

    private func navigate(_ next: AuthRoute, preserveNotice: Bool = false) {
        focusedInput = nil
        if !preserveNotice { store.clearAuthFeedback() }
        withAnimation(Motion.gated(reduceMotion, Motion.routePush)) {
            route = next
        }
    }

    private func goBack() {
        switch route {
        case .register: navigate(.login)
        case .registerPassword: navigate(.register)
        case .registerCode: code = ""; resendIn = 0; navigate(.registerPassword)
        case .forgot: navigate(.login)
        case .reset: code = ""; resendIn = 0; navigate(.forgot)
        case .resetPassword: navigate(.reset)
        case .emailLogin: navigate(.login)
        case .emailLoginCode: code = ""; resendIn = 0; navigate(.emailLogin)
        case .login: break
        }
    }
}

private enum AuthRoute: Hashable {
    case login
    case register
    case registerPassword
    case registerCode
    case forgot
    case reset
    case resetPassword
    case emailLogin
    case emailLoginCode
}

private enum AuthInput: Hashable {
    case email
    case displayName
    case inviteToken
    case password
    case confirmPassword
    case code
}

private struct AuthStepProgress: View {
    let current: Int
    let total: Int

    var body: some View {
        HStack(spacing: 7) {
            HStack(spacing: 4) {
                ForEach(0..<total, id: \.self) { index in
                    Capsule()
                        .fill(index < current ? StudyPalette.accent : StudyPalette.paperEdge)
                        .frame(width: 17, height: 4)
                }
            }
            Text("\(current) / \(total)")
                .font(.caption2.weight(.medium).monospacedDigit())
                .foregroundStyle(StudyPalette.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("第 \(current) 步，共 \(total) 步")
    }
}

private struct AuthFieldGroup<Content: View>: View {
    var spacing: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) { content }
    }
}

private enum AuthFeedbackKind {
    case error
    case success
}

private struct AuthFeedbackBanner: View {
    let title: String
    let message: String
    let kind: AuthFeedbackKind

    private var tint: Color {
        switch kind {
        case .error: StudyPalette.danger
        case .success: StudyPalette.accent
        }
    }

    private var symbol: String {
        switch kind {
        case .error: "exclamationmark.circle.fill"
        case .success: "checkmark.circle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(tint.opacity(0.12), lineWidth: 0.8)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

private struct AuthInputSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.interactive(),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
        } else {
            content
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(StudyPalette.paperEdge.opacity(0.8), lineWidth: 0.8)
                }
        }
    }
}

private struct AuthTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboardType: UIKeyboardType = .default
    var contentType: UITextContentType? = nil
    var secure = false
    @FocusState.Binding var focusedInput: AuthInput?
    let field: AuthInput
    let submitLabel: SubmitLabel
    let onSubmit: () -> Void
    @State private var revealsSecureText = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(StudyPalette.ink.opacity(0.82))
            HStack(spacing: 10) {
                Group {
                    if secure && !revealsSecureText {
                        SecureField(placeholder, text: $text)
                    } else {
                        TextField(placeholder, text: $text)
                    }
                }
                .textContentType(contentType)
                .keyboardType(keyboardType)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body)
                .focused($focusedInput, equals: field)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit() }
                .accessibilityLabel(label)

                if secure {
                    Button { revealsSecureText.toggle() } label: {
                        Image(systemName: revealsSecureText ? "eye.slash" : "eye")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(StudyPalette.muted)
                            .frame(width: 36, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(revealsSecureText ? "隐藏密码" : "显示密码")
                }
            }
            .padding(.horizontal, 15)
            .frame(minHeight: 54)
            .modifier(AuthInputSurface())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AuthCodeInput: View {
    @Binding var code: String
    @FocusState.Binding var focusedInput: AuthInput?
    @ScaledMetric(relativeTo: .title3) private var digitPointSize: CGFloat = 21

    private var digits: [Character] { Array(code) }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                ForEach(0..<6, id: \.self) { index in
                    VStack(spacing: 5) {
                        Text(index < digits.count ? String(digits[index]) : " ")
                            .font(.system(size: digitPointSize, weight: .semibold, design: .rounded).monospacedDigit())
                            .foregroundStyle(StudyPalette.ink)
                            .frame(maxWidth: .infinity, minHeight: 27)
                        Capsule()
                            .fill(focusedInput == .code && index == min(code.count, 5) ? StudyPalette.accent : .clear)
                            .frame(width: 19, height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    if index < 5 {
                        Rectangle()
                            .fill(StudyPalette.paperEdge.opacity(0.75))
                            .frame(width: 1, height: 22)
                    }
                }
            }
            TextField("验证码", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(.clear)
                .tint(.clear)
                .opacity(0.02)
                .focused($focusedInput, equals: .code)
                .accessibilityLabel("6 位邮箱验证码")
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 58)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .modifier(AuthInputSurface())
        .onTapGesture { focusedInput = .code }
    }
}

struct ConversationScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool
    @State private var draft = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var voiceCapture = VoiceCapture()

    private var latestMessage: CompanionMessage? {
        store.messages.last(where: { $0.role == "assistant" })
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("交流视图", selection: Binding(get: { store.chatShowsRecords }, set: { store.setChatShowsRecords($0) })) {
                Text("伴星").tag(false)
                Text("记录").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 6)

            Group {
                if store.chatShowsRecords {
                    MessageHistory(messages: store.messages, streamingText: store.streamingText)
                        .transition(reduceMotion || store.localReduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                } else {
                    CompanionScene(message: latestMessage, streamingText: store.streamingText) { prompt in
                        draft = prompt
                        composerFocused = true
                    }
                        .transition(reduceMotion || store.localReduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment), value: store.chatShowsRecords)

            if let error = store.errorMessage {
                ConversationFailurePanel(message: error) {
                    Task { await store.loadConversation() }
                }
            }
            composer
        }
        .background(DawnBackground())
        .toolbar(composerFocused ? .hidden : .visible, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 10) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(store.realtimeStatus == "已连接" ? StudyPalette.success : StudyPalette.muted.opacity(0.6))
                            .frame(width: 7, height: 7)
                        Text(store.realtimeStatus)
                            .font(.caption2)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    NavigationLink {
                        AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("我的账户")
                }
            }
        }
        .task {
            if store.messages.isEmpty { await store.loadConversation() }
        }
        .onChange(of: photoItem) { _, item in
            Task {
                guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
                store.selectedImage = data
                store.selectedImageName = "手机照片.jpg"
            }
        }
        .onChange(of: draft) { _, value in
            if value != voiceCapture.transcript { store.voiceArtifactId = nil }
        }
    }

    private var composer: some View {
        VStack(spacing: 9) {
            if let image = store.selectedImage, let uiImage = UIImage(data: image) {
                HStack(spacing: 10) {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    Text("图片已准备好，发送时才会上传")
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                    Spacer()
                    Button {
                        store.selectedImage = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    .accessibilityLabel("移除图片")
                }
                .padding(.horizontal, 12)
            }
            if let context = store.pendingNoteContext {
                HStack(spacing: 9) {
                    Image(systemName: "book.closed.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StudyPalette.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("正在围绕手记交流")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text(context.title)
                            .font(.caption2)
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button { store.clearPendingNoteContext() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(StudyPalette.muted)
                    }
                    .accessibilityLabel("移除手记上下文")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(StudyPalette.sky.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.horizontal, 12)
            }
            HStack(alignment: .bottom, spacing: 9) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 19, weight: .medium))
                        .frame(width: 42, height: 46)
                        .foregroundStyle(StudyPalette.accent)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("选择图片")
                Button {
                    if voiceCapture.isRecording {
                        Task {
                            if let transcript = await voiceCapture.finish(store: store) { draft = transcript }
                        }
                    } else {
                        voiceCapture.start(store: store)
                    }
                } label: {
                    Image(systemName: voiceCapture.isRecording ? "stop.circle.fill" : "mic")
                        .font(.system(size: 19, weight: .medium))
                        .frame(width: 38, height: 46)
                        .foregroundStyle(voiceCapture.isRecording ? StudyPalette.danger : StudyPalette.accent)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(voiceCapture.isRecording ? "结束录音并识别" : "语音输入")
                TextField(voiceCapture.isRecording ? "正在录音，点红色按钮结束" : "和伴星说说你在想什么…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .textInputAutocapitalization(.sentences)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .background(Color.clear)
                Button {
                    let text = draft
                    Task {
                        await store.submit(text: text)
                        if store.errorMessage == nil {
                            draft = ""
                            composerFocused = false
                        }
                    }
                } label: { sendButtonLabel }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .modifier(StudyGlassSurfaceStyle(radius: StudyRadius.xxl, interactive: true))
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.clear)
    }

    private var canSend: Bool {
        !store.isSending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.selectedImage != nil)
    }

    @ViewBuilder
    private var sendButtonLabel: some View {
        let icon = Image(systemName: store.isSending ? "ellipsis" : "arrow.up")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(canSend ? Color.white : StudyPalette.muted)
            .frame(width: 40, height: 40)
            .contentShape(Circle())
        if #available(iOS 26.0, *) {
            if canSend {
                icon.glassEffect(.regular.tint(StudyPalette.accent).interactive(), in: Circle())
            } else {
                icon.glassEffect(.regular, in: Circle())
            }
        } else {
            icon.background(canSend ? StudyPalette.accent : StudyPalette.inset, in: Circle())
        }
    }
}

private struct ConversationFailurePanel: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(StudyPalette.danger)
                .frame(width: 30, height: 30)
                .background(StudyPalette.danger.opacity(0.08), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("伴星暂时没有接回来")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button("重试", action: retry)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(StudyPalette.accent)
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.7), lineWidth: 1)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 5)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var message: CompanionMessage?
    var streamingText: String
    var onPrompt: (String) -> Void

    var body: some View {
        GeometryReader { proxy in
            let isEmpty = message == nil && streamingText.isEmpty
            ScrollView {
                if isEmpty {
                    VStack(spacing: 0) {
                        CompanionPortrait()
                            .frame(height: min(max(proxy.size.height * 0.27, 154), 186))
                            .padding(.bottom, 6)
                        Text("今天，想学点什么？")
                            .font(.system(.title2, weight: .semibold))
                            .tracking(-0.4)
                            .foregroundStyle(StudyPalette.ink)
                        Text("正在读的内容、没想通的问题，都可以直接告诉伴星。")
                            .font(.subheadline)
                            .lineSpacing(2)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 6)
                            .padding(.horizontal, 14)
                        VStack(alignment: .leading, spacing: 9) {
                            SectionEyebrow(text: "试着问")
                            HStack(spacing: 7) {
                                ForEach([("梳理思路", "帮我梳理思路"), ("解释概念", "解释一个概念"), ("开始学习", "我今天想学……")], id: \.0) { title, prompt in
                                    Button { onPrompt(prompt) } label: {
                                        Text(title)
                                            .font(.footnote.weight(.medium))
                                            .foregroundStyle(StudyPalette.accent)
                                            .padding(.horizontal, 10)
                                            .frame(minHeight: 40)
                                            .modifier(StudyGlassSurfaceStyle(radius: StudyRadius.xl, interactive: true))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.top, 18)
                        if !store.runs.isEmpty {
                            Label("有 \(store.runs.count) 项学习工作正在进行", systemImage: "clock.arrow.circlepath")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 13)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                } else {
                    VStack(spacing: 0) {
                        CompanionPortrait()
                            .frame(height: min(max(proxy.size.height * 0.22, 132), 166))
                        Text(streamingText.isEmpty ? (message?.displayText ?? "") : streamingText)
                            .font(.system(size: bodyPointSize * store.readingScale))
                            .lineSpacing(4)
                            .multilineTextAlignment(.leading)
                            .foregroundStyle(StudyPalette.ink)
                            .frame(maxWidth: .infinity)
                            .textSelection(.enabled)
                            .padding(.horizontal, 24)
                            .padding(.top, 10)
                        if !streamingText.isEmpty {
                            Label("正在接着回答", systemImage: "ellipsis")
                                .font(.caption)
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 10)
                        }
                        if !store.runs.isEmpty {
                            Label("有 \(store.runs.count) 项学习工作正在进行", systemImage: "clock.arrow.circlepath")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 12)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .top)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

struct MessageHistory: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var messages: [CompanionMessage]
    var streamingText: String
    @State private var isFollowingLatest = true
    @State private var didInitialScroll = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                    if !streamingText.isEmpty {
                        HStack {
                            Text(streamingText)
                                .font(.system(size: bodyPointSize * store.readingScale))
                                .lineSpacing(4)
                                .foregroundStyle(StudyPalette.ink)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Spacer(minLength: 34)
                        }
                        .padding(16)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18))
                        .id("streaming")
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 72
            } action: { _, isNearLatest in
                isFollowingLatest = isNearLatest
            }
            .onAppear {
                guard !didInitialScroll else { return }
                guard !messages.isEmpty || !streamingText.isEmpty else { return }
                didInitialScroll = true
                proxy.scrollTo("latest", anchor: .bottom)
            }
            .onChange(of: messages.count) { _, _ in
                if !didInitialScroll {
                    didInitialScroll = true
                    proxy.scrollTo("latest", anchor: .bottom)
                    return
                }
                guard isFollowingLatest else { return }
                if reduceMotion || store.localReduceMotion {
                    proxy.scrollTo("latest", anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("latest", anchor: .bottom) }
                }
            }
            .onChange(of: streamingText) { _, _ in
                if !didInitialScroll {
                    didInitialScroll = true
                    proxy.scrollTo("latest", anchor: .bottom)
                    return
                }
                guard isFollowingLatest else { return }
                if reduceMotion || store.localReduceMotion {
                    proxy.scrollTo("latest", anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("latest", anchor: .bottom) }
                }
            }
            .overlay {
                if messages.isEmpty && streamingText.isEmpty {
                    VStack(spacing: 7) {
                        Text("还没有交流记录")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text("在下方输入，和伴星开始一段交流。")
                            .font(.subheadline)
                            .foregroundStyle(StudyPalette.muted)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                }
            }
        }
    }
}

struct MessageRow: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var message: CompanionMessage

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if message.role == "assistant" {
                Image("BrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 23, height: 23)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .accessibilityHidden(true)
            } else {
                Spacer(minLength: 34)
            }
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    if block.type == "image", let url = block.url {
                        AuthenticatedCompanionImage(url: url, label: block.alt ?? block.label ?? "对话图片")
                    }
                    if let text = block.text, !text.isEmpty {
                        Text(text)
                            .font(.system(size: bodyPointSize * store.readingScale))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(message.role == "user" ? 13 : 0)
            .frame(maxWidth: message.role == "user" ? 310 : .infinity, alignment: .leading)
            .background(message.role == "user" ? StudyPalette.sky.opacity(0.68) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            if message.role == "user" {
                Spacer(minLength: 0)
            }
        }
    }
}

private struct AuthenticatedCompanionImage: View {
    @Environment(AppStore.self) private var store
    let url: String
    let label: String
    @State private var data: Data?

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Label(label, systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.vertical, 8)
            }
        }
        .task(id: url) { data = try? await store.api.imageData(url) }
        .accessibilityLabel(label)
    }
}
