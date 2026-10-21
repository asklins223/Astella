import SwiftUI
import UIKit

struct LoginScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var route: AuthRoute
    @State private var navigatingBack = false
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var displayName = ""
    @State private var inviteToken = ""
    @State private var code = ""
    @State private var showInviteField = false
    @State private var resendIn = 0
    @FocusState private var focusedInput: AuthInput?

    init(initialRoute: AuthRoute = .login, reviewSample: Bool = false) {
        _route = State(initialValue: initialRoute)
        let sampleRoutes: Set<AuthRoute> = [.login, .registerCode, .reset, .resetPassword, .emailLoginCode]
        _email = State(initialValue: reviewSample && sampleRoutes.contains(initialRoute) ? "lin.xia@mail.com" : "")
    }

    private var reducedMotion: Bool { reduceMotion || store.localReduceMotion }

    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validEmail: Bool {
        let parts = normalizedEmail.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }
    private var validCode: Bool { code.count == 6 && code.allSatisfy(\.isNumber) }
    private var passwordReady: Bool { password.count >= 8 && password.count <= 200 }
    private var confirmMatches: Bool { !confirmPassword.isEmpty && confirmPassword == password }
    private func validationMessage(for route: AuthRoute) -> String? {
        switch route {
        case .login:
            if normalizedEmail.isEmpty { return "请填写邮箱地址" }
            if !validEmail { return "请输入有效的邮箱地址" }
            if password.isEmpty { return "请填写密码" }
        case .register, .forgot, .emailLogin:
            if normalizedEmail.isEmpty { return "请填写邮箱地址" }
            if !validEmail { return "请输入有效的邮箱地址" }
        case .registerPassword, .resetPassword:
            if !passwordReady { return "密码需为 8–200 位" }
            if !confirmMatches { return "两次输入的密码不一致" }
            if route == .resetPassword && !validCode { return "请填写完整的 6 位验证码" }
        case .registerCode, .reset, .emailLoginCode:
            if !validCode { return "请填写完整的 6 位验证码" }
        }
        return nil
    }

    private func title(for route: AuthRoute) -> String {
        switch route {
        case .login: "欢迎回来"
        case .register: "创建账号"
        case .registerPassword: "设置密码"
        case .registerCode: "验证邮箱"
        case .reset, .emailLoginCode: "输入验证码"
        case .forgot: "找回密码"
        case .resetPassword: "设置新密码"
        case .emailLogin: "邮箱登录"
        }
    }

    private func detail(for route: AuthRoute) -> String {
        switch route {
        case .login: "和伴星一起，继续你的学习。"
        case .register: "先告诉伴星，该怎么称呼你"
        case .registerPassword: "8–200 位"
        case .registerCode: "验证码已发送至 \(normalizedEmail)"
        case .forgot: "输入注册邮箱，我们会发送验证码帮你重置"
        case .reset: "已发送至 \(normalizedEmail)"
        case .resetPassword: "验证通过，请设置新的登录密码"
        case .emailLogin: "输入邮箱，我们会发送一个 6 位验证码"
        case .emailLoginCode: "已发送至 \(normalizedEmail)"
        }
    }

    private func flowName(for route: AuthRoute) -> String {
        switch route {
        case .register, .registerPassword, .registerCode: "创建账号"
        case .forgot, .reset, .resetPassword: "找回密码"
        default: "验证码登录"
        }
    }

    private func progress(for route: AuthRoute) -> (current: Int, total: Int)? {
        switch route {
        case .register: (1, 3)
        case .registerPassword: (2, 3)
        case .registerCode: (3, 3)
        default: nil
        }
    }

    private var codePurpose: String {
        switch route {
        case .registerPassword, .registerCode: "register"
        case .forgot, .reset, .resetPassword: "reset_password"
        default: "login"
        }
    }

    private func errorTitle(for route: AuthRoute) -> String {
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
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    if route != .login { authBackButton.transition(.opacity) }
                }
                .frame(maxWidth: 432, minHeight: route == .login ? 0 : 44, alignment: .leading)
                .padding(.horizontal, 30)
                .padding(.top, route == .login ? 0 : -12)
                .padding(.bottom, route == .login ? 0 : 6)
                .frame(maxWidth: .infinity)
                .disabled(store.isLoading)

                authPage(route, compact: compact)
            }
            .animation(reducedMotion ? nil : Motion.authRoute, value: compact)
        }
        .background(DawnBackground())
        .preferredColorScheme(.light)
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

    private func authPage(_ page: AuthRoute, compact: Bool) -> some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if page == .login {
                        AuthLoginBrandHero(compact: compact)
                            .padding(.top, compact ? 20 : 28)
                            .padding(.bottom, compact ? 20 : 20)
                    } else if page == .emailLogin {
                        emailLoginHero(compact: compact)
                    } else {
                        AuthCompactBrandRow(compact: compact)
                            .padding(.top, 10)
                            .padding(.bottom, 2)
                            .transition(contentTransition)
                        if let step = progress(for: page) {
                            AuthStepProgress(title: flowName(for: page), current: step.current, total: step.total)
                                .padding(.top, 12)
                                .transition(contentTransition)
                        }
                        AuthHeading(title: title(for: page), detail: detail(for: page), compact: compact, transition: contentTransition)
                            .transaction { if reducedMotion { $0.animation = Motion.authFade } }
                            .padding(.top, 18)
                            .padding(.bottom, 11)
                    }
                    authForm(compact: compact, route: page)
                    routeFooter(for: page)
                        .id(page)
                        .transition(.opacity)
                        .padding(.top, compact ? 8 : (page == .login ? 12 : 16))
                    if page != .login {
                        Spacer(minLength: compact ? 12 : 28)
                    }
                    if page == .login {
                        Text("登录即表示同意《服务协议》与《隐私政策》。阅读与手记不需要 AI 授权。")
                            .font(.system(size: 11))
                            .foregroundStyle(StudyPalette.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.top, compact ? 12 : 7)
                    }
                }
                .padding(.horizontal, 30)
                .padding(.bottom, 16)
                .frame(maxWidth: 480, minHeight: proxy.size.height, alignment: .topLeading)
                .frame(maxWidth: .infinity)
                .disabled(store.isLoading)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
    }

    private func emailLoginHero(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Image("AuthAppIcon")
                .resizable()
                .scaledToFill()
                .frame(width: compact ? 72 : 84, height: compact ? 72 : 84)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: StudyPalette.ink.opacity(0.1), radius: 13, x: 0, y: 8)
                .accessibilityHidden(true)
                .padding(.bottom, compact ? 16 : 22)
            AuthHeading(title: title(for: .emailLogin), detail: detail(for: .emailLogin), compact: compact, transition: contentTransition)
        }
        .padding(.top, compact ? 18 : 20)
        .padding(.bottom, 11)
    }

    private var contentTransition: AnyTransition {
        if reducedMotion { return .opacity }
        let direction: CGFloat = navigatingBack ? -1 : 1
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 22 * direction)),
            removal: .opacity.combined(with: .offset(x: -14 * direction))
        )
    }

    private func fields(for page: AuthRoute) -> [AuthInput] {
        switch page {
        case .login: [.email, .password]
        case .register: [.email, .displayName]
        case .registerPassword, .resetPassword: [.password, .confirmPassword]
        case .forgot, .emailLogin: [.email]
        case .registerCode, .reset, .emailLoginCode: []
        }
    }

    @ViewBuilder
    private func sharedInput(_ field: AuthInput, page: AuthRoute) -> some View {
        switch field {
        case .email:
            input("邮箱",
                  placeholder: "you@example.com",
                  text: $email, field: .email, keyboardType: .emailAddress, contentType: .emailAddress,
                  next: page == .login ? .password : page == .register ? .displayName : nil)
        case .displayName:
            input("称呼", placeholder: "例如：夏夏", text: $displayName, field: .displayName, contentType: .name)
        case .password:
            input(page == .resetPassword ? "新密码" : "密码",
                  placeholder: page == .login ? "请输入密码" : "8–200 位",
                  text: $password, field: .password, contentType: page == .login ? .password : .newPassword,
                  secure: true, next: page == .login ? nil : .confirmPassword)
        case .confirmPassword:
            input(page == .resetPassword ? "确认新密码" : "确认密码",
                  placeholder: page == .resetPassword ? "请再次输入新密码" : "请再次输入密码",
                  text: $confirmPassword, field: .confirmPassword, contentType: .newPassword, secure: true)
        case .inviteToken, .code: EmptyView()
        }
    }

    private func authForm(compact: Bool, route: AuthRoute) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : (route == .login ? 3 : 14)) {
            // Stable field IDs preserve the email/password controls and their positions across routes.
            AuthFieldGroup(spacing: compact ? 10 : (route == .login ? 18 : 13)) {
                ForEach(fields(for: route), id: \.self) { field in
                    sharedInput(field, page: route)
                        .transition(contentTransition)
                }
            }
            if fields(for: route).contains(.email), !normalizedEmail.isEmpty && !validEmail && focusedInput != .email {
                fieldError("请输入有效的邮箱地址")
            }
            Group {
                switch route {
                case .login:
                    HStack {
                        Spacer()
                        Button("忘记密码？") { navigate(.forgot) }
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(StudyPalette.accent)
                            .frame(minHeight: 40)
                    }
                case .register:
                    Button(showInviteField ? "收起邀请码" : "有邀请码？") {
                        withAnimation(reducedMotion ? Motion.authFade : Motion.authRoute) { showInviteField.toggle() }
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(StudyPalette.accent)
                    .frame(minHeight: 36, alignment: .leading)
                    if showInviteField {
                        input("邀请码", placeholder: "选填", text: $inviteToken, field: .inviteToken)
                            .transition(contentTransition)
                    }
                case .registerPassword, .resetPassword:
                    if !confirmPassword.isEmpty && !confirmMatches { fieldError("两次输入的密码不一致") }
                case .registerCode, .reset, .emailLoginCode:
                    AuthCodeInput(code: $code, focusedInput: $focusedInput)
                        .frame(height: 58)
                    codeActions
                case .forgot, .emailLogin:
                    EmptyView()
                }
            }
            .transition(contentTransition)

            if let error = store.authErrorMessage {
                AuthFeedbackBanner(title: errorTitle(for: route), message: error, kind: .error)
            }
            if let notice = store.authNoticeMessage, route != .registerCode, route != .reset, route != .emailLoginCode {
                AuthFeedbackBanner(title: "已完成", message: notice, kind: .success)
            }

            primaryAction(for: route)
                .padding(.top, compact ? 0 : (route == .login ? 17 : 14))
            if route == .register {
                Text("填写邮箱和称呼后即可继续")
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
            }
        }
        .padding(.top, compact ? 16 : 15)
    }

    private var codeActions: some View {
        Button(resendIn > 0 ? "重新发送（\(resendIn)秒）" : "重新发送验证码") {
            sendCode(advance: false)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(resendIn > 0 ? StudyPalette.muted : StudyPalette.accent)
        .frame(maxWidth: .infinity, minHeight: 44)
        .buttonStyle(AstellaPressStyle())
        .disabled(store.isLoading || resendIn > 0)
    }

    @ViewBuilder
    private func routeFooter(for route: AuthRoute) -> some View {
        Group {
            switch route {
            case .login:
                Button("注册新账号") { navigate(.register) }
            case .register:
                HStack(spacing: 5) {
                    Text("已有账号？").foregroundStyle(StudyPalette.muted)
                        Button("去登录") { navigate(.login) }
                }
            case .registerCode:
                Text("完成验证后，将自动登录。")
                    .foregroundStyle(StudyPalette.muted)
            case .emailLogin:
                HStack(spacing: 22) {
                    Button("用密码登录") { navigate(.login) }
                    Button("注册新账号") { navigate(.register) }
                }
            case .forgot:
                HStack(spacing: 5) {
                    Text("想起来了？").foregroundStyle(StudyPalette.muted)
                    Button("去登录") { navigate(.login) }
                }
            case .registerPassword, .reset, .resetPassword, .emailLoginCode:
                EmptyView()
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(StudyPalette.accent)
        .buttonStyle(AstellaPressStyle())
        .frame(maxWidth: .infinity, minHeight: route == .login ? 40 : 44)
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
            showGlyph: false,
            focusedInput: $focusedInput,
            field: field,
            submitLabel: next == nil ? .go : .next
        ) {
            if let next { focusedInput = next } else { submit() }
        }
    }

    private func fieldError(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            AstellaGlyph(kind: .alert, tint: StudyPalette.danger).frame(width: 15, height: 15)
            Text(message)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(StudyPalette.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func primaryAction(for route: AuthRoute) -> some View {
        let title = store.isLoading ? busyTitle(for: route) : actionTitle(for: route)
        return Group {
            if route == .forgot || route == .emailLogin {
                Button(action: submit) {
                    actionLabel(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(StudyPalette.ink)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .modifier(StudyGlassSurfaceStyle(radius: 16, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .disabled(store.isLoading)
            } else {
                Button(action: submit) {
                    actionLabel(title).frame(maxWidth: .infinity)
                }
                .buttonStyle(AuthPrimaryButtonStyle(busy: store.isLoading, minHeight: route == .login ? 51 : 48))
                .disabled(store.isLoading)
            }
        }
    }

    private func actionLabel(_ title: String) -> some View {
        HStack(spacing: 8) {
            if store.isLoading { ProgressView().tint(StudyPalette.ink) }
            Text(title).contentTransition(.opacity)
        }
    }

    private var authBackButton: some View {
        Button(action: goBack) {
            AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                .frame(width: 18, height: 18)
                .frame(width: 44, height: 44)
                .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityLabel("返回上一步")
    }

    private func actionTitle(for route: AuthRoute) -> String {
        switch route {
        case .login: "登录"
        case .register: "继续"
        case .registerPassword: "完成注册"
        case .registerCode: "验证并进入"
        case .forgot: "发送验证码"
        case .reset: "继续设置密码"
        case .resetPassword: "保存并去登录"
        case .emailLogin: "发送验证码"
        case .emailLoginCode: "验证登录"
        }
    }

    private func busyTitle(for route: AuthRoute) -> String {
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
        guard !store.isLoading else { return }
        if let message = validationMessage(for: route) {
            store.authErrorMessage = message
            return
        }
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
        guard next != route, !store.isLoading else { return }
        focusedInput = nil
        navigatingBack = next.depth < route.depth
        if !preserveNotice { store.clearAuthFeedback() }
        withAnimation(Motion.gated(reducedMotion, Motion.authRoute)) {
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

enum AuthRoute: Hashable {
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

private extension AuthRoute {
    var depth: Int {
        switch self {
        case .login: 0
        case .register, .forgot, .emailLogin: 1
        case .registerPassword, .reset, .emailLoginCode: 2
        case .registerCode, .resetPassword: 3
        }
    }
}

enum AuthInput: Hashable {
    case email
    case displayName
    case inviteToken
    case password
    case confirmPassword
    case code
}
