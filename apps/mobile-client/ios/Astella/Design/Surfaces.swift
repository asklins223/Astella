import SwiftUI
import UIKit

struct DawnBackground: View {
    var body: some View {
        StudyPalette.canvas
        .ignoresSafeArea()
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
