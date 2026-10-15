import SwiftUI
import UIKit

struct AuthBrandHeader: View {
    var compact = false

    var body: some View {
        HStack(spacing: 11) {
            Image("BrandMark")
                .resizable().scaledToFit()
                .frame(width: compact ? 36 : 44, height: compact ? 36 : 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("拾星笔记")
                    .font(.system(size: compact ? 16 : 18, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text("ASTELLA")
                    .font(.system(size: 9, weight: .medium))
                    .tracking(2.5)
                    .foregroundStyle(StudyPalette.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("拾星笔记，Astella")
    }
}

struct AuthHeading: View {
    let title: String
    let detail: String
    var compact = false
    var transition: AnyTransition = .opacity

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 10) {
            Text(title)
                .font(compact ? .title2.weight(.semibold) : .largeTitle.weight(.semibold))
                .tracking(-0.8)
                .foregroundStyle(StudyPalette.ink)
                .id(title)
                .transition(transition)
            if !compact {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .id(detail)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AuthPrimaryButtonStyle: ButtonStyle {
    var busy = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduced

    func makeBody(configuration: Configuration) -> some View {
        let active = enabled || busy
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(active ? StudyPalette.ink : StudyPalette.muted)
            .padding(.horizontal, 22)
            .frame(minHeight: 56)
            .modifier(StudyGlassSurfaceStyle(radius: 28, interactive: true,
                                           tint: active ? StudyPalette.actionFill.opacity(0.82) : nil))
            .contentShape(Capsule())
            .opacity(active ? (configuration.isPressed ? 0.76 : 1) : 0.6)
            .scaleEffect(configuration.isPressed && !reduced ? 0.98 : 1)
            .animation(Motion.gated(reduced, Motion.press), value: configuration.isPressed)
    }
}

struct AuthStepProgress: View {
    let title: String
    let current: Int
    let total: Int

    var body: some View {
        Text("\(title) · \(current) / \(total)")
            .font(.footnote.weight(.medium).monospacedDigit())
            .foregroundStyle(StudyPalette.muted)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("第 \(current) 步，共 \(total) 步")
    }
}

struct AuthFieldGroup<Content: View>: View {
    var spacing: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) { content }
    }
}

enum AuthFeedbackKind {
    case error
    case success
}

struct AuthFeedbackBanner: View {
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
        .padding(.horizontal, StudySpacing.md)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous)
                .stroke(tint.opacity(0.12), lineWidth: 0.8)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct AuthInputSurface: ViewModifier {
    func body(content: Content) -> some View {
        content.modifier(StudyGlassSurfaceStyle(radius: 26, interactive: true))
    }
}

struct AuthTextField: View {
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
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(width: 21)
                    .accessibilityHidden(true)
                Group {
                    if secure && !revealsSecureText {
                        SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(StudyPalette.muted))
                    } else {
                        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(StudyPalette.muted))
                    }
                }
                .textContentType(contentType)
                .keyboardType(keyboardType)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body)
                .foregroundStyle(StudyPalette.ink)
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
            .padding(.leading, 19)
            .padding(.trailing, secure ? 8 : 19)
            .frame(minHeight: 56)
            .modifier(AuthInputSurface())
            .overlay {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(focusedInput == field ? StudyPalette.accent.opacity(0.5) : .clear, lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: contentType) { _, _ in revealsSecureText = false }
    }

    private var symbol: String {
        switch field {
        case .email: "envelope"
        case .displayName: "person"
        case .inviteToken: "gift"
        case .password, .confirmPassword: "lock"
        case .code: "number"
        }
    }
}

struct AuthCodeInput: View {
    @Binding var code: String
    @FocusState.Binding var focusedInput: AuthInput?
    @ScaledMetric(relativeTo: .title3) private var digitPointSize: CGFloat = 21

    private var digits: [Character] { Array(code) }

    var body: some View {
        ZStack {
            HStack(spacing: 8) {
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
                    .frame(maxWidth: .infinity, minHeight: 58)
                    .modifier(StudyGlassSurfaceStyle(radius: 16))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(focusedInput == .code && index == min(code.count, 5) ? StudyPalette.accent.opacity(0.5) : .clear, lineWidth: 1)
                    }
                }
            }
            .accessibilityHidden(true)
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
        .frame(maxWidth: .infinity, minHeight: 58)
        .contentShape(RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
        .onTapGesture { focusedInput = .code }
    }
}
