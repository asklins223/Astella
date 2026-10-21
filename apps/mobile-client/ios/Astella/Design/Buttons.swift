import SwiftUI

struct PrimaryActionStyle: ViewModifier {
    func body(content: Content) -> some View { content.buttonStyle(AstellaActionStyle(primary: true)) }
}
struct SecondaryActionStyle: ViewModifier {
    func body(content: Content) -> some View { content.buttonStyle(AstellaActionStyle(primary: false)) }
}
struct GlassIconActionStyle: ViewModifier {
    func body(content: Content) -> some View {
        content.buttonStyle(AstellaPressStyle()).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
    }
}
struct AstellaPressStyle: ButtonStyle {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled

    private var motionDisabled: Bool { reduced || store.localReduceMotion }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(enabled ? (configuration.isPressed ? 0.76 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !motionDisabled ? 0.97 : 1)
            .animation(Motion.gated(motionDisabled, Motion.press), value: configuration.isPressed)
    }
}
private struct AstellaActionStyle: ButtonStyle {
    var primary: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceTransparency) private var opaque

    @ViewBuilder
    func makeBody(configuration: Configuration) -> some View {
        let label = configuration.label.font(.system(size: 15, weight: .semibold)).tracking(0.3)
            .frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 18)
        if primary {
            label
                .foregroundStyle(StudyPalette.paper)
                .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 16))
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
        } else if #available(iOS 26.0, *), !opaque {
            label
                .foregroundStyle(StudyPalette.ink)
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .opacity(enabled ? 1 : 0.45)
        } else {
            label
                .foregroundStyle(StudyPalette.ink)
                .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 16))
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
        }
    }
}
