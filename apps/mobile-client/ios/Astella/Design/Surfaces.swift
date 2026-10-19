import SwiftUI
import UIKit

struct DawnBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            ZStack {
                StudyPalette.canvas
                RadialGradient(
                    colors: [StudyPalette.paper.opacity(scheme == .dark ? 0.08 : 0.97), .clear],
                    center: UnitPoint(x: 0.08, y: 0.15),
                    startRadius: 0,
                    endRadius: max(width, height) * 0.72
                )
                RadialGradient(
                    colors: [StudyPalette.sky.opacity(scheme == .dark ? 0.23 : 0.25), .clear],
                    center: UnitPoint(x: 0.82, y: 0.83),
                    startRadius: 0,
                    endRadius: width * 0.72
                )

                if scheme == .dark {
                    Circle()
                        .fill(RadialGradient(colors: [StudyPalette.sky.opacity(0.14), .clear], center: .topLeading, startRadius: 4, endRadius: width * 0.65))
                        .frame(width: 290, height: 290)
                        .position(x: width - 10, y: height * 0.48 + 145)
                        .opacity(0.6)
                    Circle()
                        .fill(RadialGradient(colors: [StudyPalette.sky.opacity(0.09), .clear], center: .topLeading, startRadius: 4, endRadius: width * 0.72))
                        .frame(width: 460, height: 460)
                        .position(x: width - 20, y: height * 0.12 + 230)
                        .opacity(0.6)
                } else {
                    Image("SilverLight")
                        .resizable()
                        .scaledToFill()
                        .frame(width: width, height: height)
                        .clipped()
                        .opacity(0.72)

                    ambientOrb(width: 290, height: height, x: width - 10, y: height * 0.48 + 145, opacity: 1)
                    ambientOrb(width: 290, height: height, x: 5, y: height * 0.76 + 145, opacity: 0.3)
                    ambientOrb(width: 460, height: height, x: width - 20, y: height * 0.12 + 230, opacity: 0.6)
                }
            }
            .frame(width: width, height: height)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func ambientOrb(width: CGFloat, height: CGFloat, x: CGFloat, y: CGFloat, opacity: Double) -> some View {
        Circle()
            .fill(RadialGradient(
                colors: [Color.white.opacity(0.88), StudyPalette.paperEdge.opacity(0.10), .clear],
                center: UnitPoint(x: 0.22, y: 0.20),
                startRadius: 3,
                endRadius: width * 0.66
            ))
            .overlay(Circle().stroke(.white.opacity(0.30), lineWidth: 0.7))
            .frame(width: width, height: width)
            .position(x: x, y: y)
            .opacity(opacity)
            .blur(radius: 0.4)
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
                    if let tint {
                        shape.fill(tint)
                    } else {
                        shape.fill(LinearGradient(
                            colors: scheme == .dark
                                ? [StudyPalette.paper.opacity(0.16), StudyPalette.sky.opacity(0.10), StudyPalette.paper.opacity(0.08)]
                                : [Color.white.opacity(0.76), Color.white.opacity(0.42), StudyPalette.sky.opacity(0.30)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ))
                    }
                }
            }
            .overlay { shape.stroke(tint == nil ? Color.white.opacity(scheme == .dark ? 0.15 : 0.82) : .white.opacity(0.24), lineWidth: 0.85) }
            .overlay(alignment: .top) {
                shape.stroke(StudyPalette.paperEdge.opacity(scheme == .dark ? 0.13 : 0.33), lineWidth: 0.55)
                    .padding(1)
                    .mask(LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .bottom))
            }
            .shadow(color: StudyPalette.ink.opacity(scheme == .dark ? 0.12 : interactive ? 0.07 : 0.045), radius: interactive ? 17 : 11, x: 0, y: interactive ? 8 : 5)
    }
}
