import SwiftUI
import UIKit

struct LoginScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var route: AuthRoute = .login
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

    private var reducedMotion: Bool { reduceMotion || store.localReduceMotion }

    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validEmail: Bool {
        let parts = normalizedEmail.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }
    private var validCode: Bool { code.count == 6 && code.allSatisfy(\.isNumber) }
    private var passwordReady: Bool { password.count >= 8 && password.count <= 200 }
    private var confirmMatches: Bool { !confirmPassword.isEmpty && confirmPassword == password }
    private func canContinue(for route: AuthRoute) -> Bool {
        switch route {
        case .login: validEmail && !password.isEmpty
        case .register: validEmail
        case .registerPassword, .resetPassword: passwordReady && confirmMatches
        case .registerCode, .reset, .emailLoginCode: validCode
        case .forgot, .emailLogin: validEmail
        }
    }

    private func title(for route: AuthRoute) -> String {
        switch route {
        case .login: "欢迎回来"
        case .register: "创建账号"
        case .registerPassword: "设置密码"
        case .registerCode, .reset: "验证邮箱"
        case .forgot: "找回密码"
        case .resetPassword: "设置新密码"
        case .emailLogin: "邮箱登录"
        case .emailLoginCode: "查收邮件"
        }
    }

    private func detail(for route: AuthRoute) -> String {
        switch route {
        case .login: "和伴星一起，继续你的学习。"
        case .register: "和伴星一起，开启你的学习。"
        case .registerPassword: "为你的手记与对话，添一份安心。"
        case .registerCode: "只差一步，就能和伴星相遇。"
        case .forgot: "验证邮箱，就能重新设置密码。"
        case .reset: "确认是你，再为账号设置新密码。"
        case .resetPassword: "换一个新密码，继续你的学习。"
        case .emailLogin: "一封验证码，继续你的学习。"
        case .emailLoginCode: "输入验证码，和伴星继续同行。"
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
                ZStack(alignment: .leading) {
                    AuthBrandHeader(compact: compact)
                        .scaleEffect(route == .login ? 1 : 0.94, anchor: .leading)
                        .offset(x: route == .login ? 0 : 56)
                    if route != .login {
                        authBackButton.transition(.opacity)
                    }
                }
                .frame(maxWidth: 432, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, compact ? 8 : 12)
                .frame(maxWidth: .infinity)
                .disabled(store.isLoading)

                authPage(route, compact: compact)
            }
            .animation(reducedMotion ? nil : Motion.authRoute, value: compact)
        }
        .background(Color.white.ignoresSafeArea())
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
                    AuthHeading(title: title(for: page), detail: detail(for: page), compact: compact, transition: contentTransition)
                        .transaction { if reducedMotion { $0.animation = Motion.authFade } }
                        .padding(.top, compact ? 18 : page == .login ? 52 : 34)
                    if let step = progress(for: page) {
                        AuthStepProgress(title: flowName(for: page), current: step.current, total: step.total)
                            .padding(.top, compact ? 12 : 24)
                            .transition(contentTransition)
                    }
                    authForm(compact: compact, route: page)
                    routeFooter(for: page)
                        .id(page)
                        .transition(.opacity)
                        .padding(.top, compact ? 8 : 16)
                    Spacer(minLength: compact ? 12 : 28)
                    if !compact {
                        Text("你的手记与对话，会在各端同步")
                            .font(.caption)
                            .foregroundStyle(StudyPalette.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 16)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 16)
                .frame(maxWidth: 480, minHeight: proxy.size.height, alignment: .topLeading)
                .frame(maxWidth: .infinity)
                .disabled(store.isLoading)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color.white)
        .toolbar(.hidden, for: .navigationBar)
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
            input(page == .forgot ? "注册邮箱" : "邮箱",
                  placeholder: page == .forgot ? "请输入注册时的邮箱" : "请输入邮箱地址",
                  text: $email, field: .email, keyboardType: .emailAddress, contentType: .emailAddress,
                  next: page == .login ? .password : page == .register ? .displayName : nil)
        case .displayName:
            input("称呼（选填）", placeholder: "希望伴星怎么称呼你", text: $displayName, field: .displayName, contentType: .name)
        case .password:
            input(page == .resetPassword ? "新密码" : "密码",
                  placeholder: page == .login ? "请输入密码" : "至少 8 个字符",
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
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            // Stable field IDs preserve the email/password controls and their positions across routes.
            AuthFieldGroup(spacing: compact ? 10 : 15) {
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
                    Text(route == .registerPassword ? "密码可随时重置，请放心记录。" : "更新后，请使用新密码登录。")
                        .font(.caption)
                        .foregroundStyle(StudyPalette.muted)
                case .registerCode, .reset, .emailLoginCode:
                    codeRecipient(for: route)
                    Text("邮箱验证码")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(StudyPalette.ink.opacity(0.82))
                    AuthCodeInput(code: $code, focusedInput: $focusedInput)
                        .frame(height: 58)
                    codeActions
                case .forgot, .emailLogin:
                    Text(route == .forgot ? "我们会向此邮箱发送重置验证码。" : "无需密码，验证码将发送到你的邮箱。")
                        .font(.caption)
                        .foregroundStyle(StudyPalette.muted)
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
                .padding(.top, compact ? 0 : 4)
            if route == .login { emailCodeAction.transition(.opacity) }
        }
        .padding(.top, compact ? 16 : 24)
    }

    private func codeRecipient(for route: AuthRoute) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(route == .reset ? "重置验证码已发送至" : "验证码已发送至")
                .font(.subheadline)
                .foregroundStyle(StudyPalette.muted)
            HStack(spacing: 8) {
                Text(normalizedEmail)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(StudyPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Button("更改邮箱") {
                    switch route {
                    case .registerCode: navigate(.register)
                    case .reset: navigate(.forgot)
                    case .emailLoginCode: navigate(.emailLogin)
                    default: break
                    }
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(StudyPalette.accent)
                .frame(minHeight: 44)
                .buttonStyle(AstellaPressStyle())
            }
        }
        .padding(.bottom, 8)
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
                HStack(spacing: 5) {
                    Text("还没有账号？").foregroundStyle(StudyPalette.muted)
                    Button("创建账号") { navigate(.register) }
                }
            case .register:
                HStack(spacing: 5) {
                    Text("已有账号？").foregroundStyle(StudyPalette.muted)
                    Button("返回登录") { navigate(.login) }
                }
            case .registerCode:
                Text("完成验证后，将自动登录。")
                    .foregroundStyle(StudyPalette.muted)
            case .emailLogin, .emailLoginCode:
                Button("使用密码登录") { navigate(.login) }
            case .forgot, .resetPassword:
                Button("返回登录") { navigate(.login) }
            case .registerPassword, .reset:
                Button("返回上一步", action: goBack)
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(StudyPalette.accent)
        .buttonStyle(AstellaPressStyle())
        .frame(maxWidth: .infinity, minHeight: 44)
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

    private func primaryAction(for route: AuthRoute) -> some View {
        Button(action: submit) {
            HStack(spacing: 8) {
                if store.isLoading { ProgressView().tint(StudyPalette.ink) }
                Text(store.isLoading ? busyTitle(for: route) : actionTitle(for: route))
                    .contentTransition(.opacity)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(AuthPrimaryButtonStyle(busy: store.isLoading))
        .disabled(store.isLoading || !canContinue(for: route))
    }

    private var emailCodeAction: some View {
        Button("邮箱验证码登录") { navigate(.emailLogin) }
            .font(.subheadline.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 44)
            .buttonStyle(AstellaPressStyle())
            .foregroundStyle(StudyPalette.accent)
    }

    private var authBackButton: some View {
        Button(action: goBack) {
            Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(StudyPalette.ink)
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
        case .registerPassword: "发送验证码"
        case .registerCode: "验证并创建账号"
        case .forgot: "发送验证码"
        case .reset: "继续设置密码"
        case .resetPassword: "更新密码"
        case .emailLogin: "发送验证码"
        case .emailLoginCode: "验证并登录"
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
        guard canContinue(for: route), !store.isLoading else { return }
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
