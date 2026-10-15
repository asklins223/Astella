import SwiftUI
import UIKit

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
                .accessibilityHidden(true)
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
        .background(StudyPalette.sky.opacity(0.6), in: RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
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

enum AuthInput: Hashable {
    case email
    case displayName
    case inviteToken
    case password
    case confirmPassword
    case code
}
