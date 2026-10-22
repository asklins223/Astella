import SwiftUI
import UIKit

struct AuthLoginBrandHero: View {
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image("AuthAppIcon")
                .resizable().scaledToFill()
                .frame(width: compact ? 72 : 84, height: compact ? 72 : 84)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(.white.opacity(0.82), lineWidth: 0.8)
                }
                .shadow(color: StudyPalette.ink.opacity(0.1), radius: 13, x: 0, y: 8)
                .accessibilityHidden(true)
                .padding(.bottom, compact ? 8 : 22)
            Text("拾星笔记")
                .font(.system(size: compact ? 26 : 29, weight: .medium))
                .tracking(-1)
                .foregroundStyle(StudyPalette.ink)
                .padding(.bottom, compact ? 6 : 11)
            Text("把读到的、想到的，慢慢拾成星光")
                .font(.system(size: 13))
                .lineSpacing(3)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
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
                .font(.system(size: compact ? 25 : 29, weight: .medium))
                .tracking(-1)
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
    var minHeight: CGFloat = 48
    @Environment(AppStore.self) private var store
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduced

    private var motionDisabled: Bool { reduced || store.localReduceMotion }

    func makeBody(configuration: Configuration) -> some View {
        let active = enabled || busy
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(active ? StudyPalette.accentLabel : StudyPalette.muted)
            .padding(.horizontal, 22)
            .frame(minHeight: minHeight)
            .frame(maxWidth: .infinity)
            .background(active ? StudyPalette.accent : StudyPalette.inset,
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(active ? .white.opacity(0.14) : StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.8)
            }
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(active ? (configuration.isPressed ? 0.86 : 1) : 0.6)
            .scaleEffect(configuration.isPressed && !motionDisabled ? 0.99 : 1)
            .animation(Motion.gated(motionDisabled, Motion.press), value: configuration.isPressed)
    }
}

/// Compact brand mark for the multi-step auth pages, matching the mockup's
/// icon + wordmark row above the page title.
struct AuthCompactBrandRow: View {
    var compact = false
    var body: some View {
        HStack(spacing: 11) {
            Image("AuthAppIcon")
                .resizable()
                .scaledToFill()
                .frame(width: compact ? 40 : 46, height: compact ? 40 : 46)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .shadow(color: StudyPalette.ink.opacity(0.08), radius: 8, x: 0, y: 4)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("拾星笔记")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text("ASTELLA")
                    .font(.system(size: 8, weight: .semibold))
                    .tracking(2.4)
                    .foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

struct AuthStepProgress: View {
    let title: String
    let current: Int
    let total: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                ForEach(0..<max(total, 0), id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(index < current ? StudyPalette.accent : StudyPalette.paperEdge)
                        .frame(width: 28, height: 4)
                }
            }
            Text("\(title) · \(current)/\(total)")
                .font(.system(size: 11, weight: .medium))
                .tracking(0.4)
                .foregroundStyle(StudyPalette.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)，第 \(current) 步，共 \(total) 步")
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

    private var glyph: AstellaGlyphKind {
        switch kind {
        case .error: .alert
        case .success: .check
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AstellaGlyph(kind: glyph, tint: tint).frame(width: 16, height: 16).padding(.top, 1)
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
        content.modifier(StudyGlassSurfaceStyle(radius: 16, interactive: true))
    }
}

struct AuthTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboardType: UIKeyboardType = .default
    var contentType: UITextContentType? = nil
    var secure = false
    var showGlyph = true
    @FocusState.Binding var focusedInput: AuthInput?
    let field: AuthInput
    let submitLabel: SubmitLabel
    let onSubmit: () -> Void
    @State private var revealsSecureText = false

    var body: some View {
        VStack(alignment: .leading, spacing: showGlyph ? 6 : 9) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .tracking(0.25)
                .foregroundStyle(StudyPalette.ink.opacity(0.82))
            HStack(spacing: 12) {
                if showGlyph {
                    AstellaGlyph(kind: glyph, tint: StudyPalette.muted)
                        .frame(width: 20, height: 20)
                        .accessibilityHidden(true)
                }
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
                .font(.system(size: 16))
                .foregroundStyle(StudyPalette.ink)
                .focused($focusedInput, equals: field)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit() }
                .accessibilityLabel(label)

                if secure {
                    Button { revealsSecureText.toggle() } label: {
                        AstellaGlyph(kind: revealsSecureText ? .eyeSlash : .eye, tint: StudyPalette.muted)
                            .frame(width: 18, height: 18)
                            .frame(width: 36, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(revealsSecureText ? "隐藏密码" : "显示密码")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, secure ? 7 : 16)
            .frame(minHeight: 52)
            .modifier(AuthInputSurface())
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(focusedInput == field ? StudyPalette.accent.opacity(0.5) : .clear, lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: contentType) { _, _ in revealsSecureText = false }
    }

    private var glyph: AstellaGlyphKind {
        switch field {
        case .email: .mail
        case .displayName: .person
        case .inviteToken: .key
        case .password, .confirmPassword: .lock
        case .code: .number
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
