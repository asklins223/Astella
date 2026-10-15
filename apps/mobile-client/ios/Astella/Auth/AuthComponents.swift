import SwiftUI
import UIKit

struct AuthStepProgress: View {
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
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.interactive(),
                in: RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous)
            )
        } else {
            content
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous)
                        .stroke(StudyPalette.paperEdge.opacity(0.8), lineWidth: 0.8)
                }
        }
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

struct AuthCodeInput: View {
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
        .contentShape(RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
        .modifier(AuthInputSurface())
        .onTapGesture { focusedInput = .code }
    }
}
