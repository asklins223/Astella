import SwiftUI
import UIKit

enum StudyPalette {
    static let ink = Color(uiColor: .label)
    static let muted = Color(uiColor: .secondaryLabel)
    static let blue = Color(uiColor: .systemBlue)
    static let blueDeep = Color(uiColor: .systemBlue)
    static let sky = Color(uiColor: UIColor.systemBlue.withAlphaComponent(0.09))
    static let canvas = Color(uiColor: .systemBackground)
    static let paper = Color(uiColor: .secondarySystemBackground)
    static let inset = Color(uiColor: .tertiarySystemBackground)
    static let paperEdge = Color(uiColor: .separator)
    static let success = Color(uiColor: .systemGreen)
    static let danger = Color(uiColor: .systemRed)
}

struct DawnBackground: View {
    var body: some View {
        StudyPalette.canvas
        .ignoresSafeArea()
    }
}

struct PaperSurface<Content: View>: View {
    var padding: CGFloat = 20
    var radius: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(StudyPalette.paperEdge.opacity(0.52), lineWidth: 0.7)
            }
    }
}

struct NoticeSurface<Content: View>: View {
    // Status and explanatory content belongs to the content layer, not Liquid Glass.
    var padding: CGFloat = 14
    var radius: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(StudyPalette.paperEdge.opacity(0.52), lineWidth: 0.7)
            }
    }
}

struct StudyGlassSurfaceStyle: ViewModifier {
    var radius: CGFloat
    var interactive = false

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if #available(iOS 26.0, *) {
            if interactive {
                content.glassEffect(.regular.interactive(), in: shape)
            } else {
                content.glassEffect(.regular, in: shape)
            }
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay { shape.stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.7) }
        }
    }
}

struct PageHeading: View {
    let eyebrow: String
    let title: String
    var subtitle: String? = nil
    var trailing: AnyView? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                SectionEyebrow(text: eyebrow)
                Text(title)
                    .font(.system(.largeTitle, weight: .semibold))
                    .tracking(-0.45)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
    }
}

struct SectionEyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(StudyPalette.muted)
    }
}

struct CompanionPortrait: View {
    var body: some View {
        Image("Companion")
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 190)
        .frame(maxWidth: .infinity, minHeight: 140, maxHeight: 210)
        .accessibilityLabel("伴星在书桌前陪你学习")
    }
}

struct PrimaryActionStyle: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent).buttonBorderShape(.capsule)
        } else {
            content.buttonStyle(LegacyPrimaryActionButtonStyle())
        }
    }
}

private struct LegacyPrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let label = configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white.opacity(isEnabled ? 1 : 0.82))
            .padding(.horizontal, 18)
            .frame(minHeight: 52)
            .frame(maxWidth: .infinity)
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed && isEnabled && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.22, bounce: 0.06), value: configuration.isPressed)
        label.background(StudyPalette.blue.opacity(isEnabled ? 1 : 0.42), in: Capsule())
    }
}

struct SecondaryActionStyle: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glass).buttonBorderShape(.capsule)
        } else {
            content.buttonStyle(LegacySecondaryActionButtonStyle())
        }
    }
}

struct GlassIconActionStyle: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glass).buttonBorderShape(.circle)
        } else {
            content.buttonStyle(.plain)
                .background(.regularMaterial, in: Circle())
                .overlay { Circle().stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.7) }
        }
    }
}

private struct LegacySecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(StudyPalette.blueDeep.opacity(isEnabled ? 1 : 0.55))
            .padding(.horizontal, 18)
            .frame(minHeight: 46)
            .frame(maxWidth: .infinity)
            .scaleEffect(configuration.isPressed && isEnabled && !reduceMotion ? 0.99 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.2, bounce: 0.04), value: configuration.isPressed)
            .background(.regularMaterial, in: Capsule())
            .overlay { Capsule().stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.7) }
    }
}
