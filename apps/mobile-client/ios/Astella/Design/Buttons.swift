import SwiftUI
import UIKit

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
            .animation(Motion.gated(reduceMotion, Motion.press), value: configuration.isPressed)
        label.background(StudyPalette.accent.opacity(isEnabled ? 1 : 0.42), in: Capsule())
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
            .foregroundStyle(StudyPalette.accent.opacity(isEnabled ? 1 : 0.55))
            .padding(.horizontal, 18)
            .frame(minHeight: 46)
            .frame(maxWidth: .infinity)
            .scaleEffect(configuration.isPressed && isEnabled && !reduceMotion ? 0.99 : 1)
            .animation(Motion.gated(reduceMotion, Motion.pressSoft), value: configuration.isPressed)
            .background(.regularMaterial, in: Capsule())
            .overlay { Capsule().stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.7) }
    }
}
