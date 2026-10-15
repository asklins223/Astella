import SwiftUI
import UIKit

struct DawnBackground: View {
    var body: some View {
        StudyPalette.canvas.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct PaperSurface<Content: View>: View {
    var padding: CGFloat = StudySpacing.xl
    var radius: CGFloat = StudyRadius.lg
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
    var radius: CGFloat = StudyRadius.lg
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

/// Quiet, neutral glass: one blur plane, a uniform edge and a contact shadow.
struct StudyGlassSurfaceStyle: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var opaque
    var radius: CGFloat
    var interactive = false
    var tint: Color? = nil
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                ZStack {
                    if opaque { shape.fill(StudyPalette.paper) }
                    else { shape.fill(.ultraThinMaterial) }
                    shape.fill(tint ?? StudyPalette.paper.opacity(scheme == .dark ? 0.12 : 0.23))
                }
            }
            .overlay { shape.stroke(tint == nil ? StudyPalette.paperEdge.opacity(0.75) : .white.opacity(0.2), lineWidth: 0.8) }
            .shadow(color: .black.opacity(scheme == .dark ? 0.08 : interactive ? 0.045 : 0.025), radius: interactive ? 12 : 8, x: 0, y: 4)
    }
}
