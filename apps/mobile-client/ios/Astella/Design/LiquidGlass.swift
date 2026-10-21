import SwiftUI

/// The system Liquid Glass material exists from iOS 26. Older systems keep the
/// hand-built paper glass, so a surface only changes when the OS can render it.
enum AstellaGlass {
    static var isNative: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }
}

extension View {
    /// Lets a glass shape grow out of, or merge back into, a neighbouring one.
    @ViewBuilder
    func astellaGlassMaterialize() -> some View {
        if #available(iOS 26.0, *) {
            glassEffectTransition(.materialize)
        } else {
            self
        }
    }
}

/// Glass shapes inside one container merge and split as they move. Below iOS 26
/// the container is transparent and children keep their own fallback surfaces.
struct AstellaGlassContainer<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Applies `glassEffectID` only where the system glass exists; callers may pass
/// nil on either side to opt out.
struct AstellaGlassLink: ViewModifier {
    var id: String?
    var namespace: Namespace.ID?

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), let id, let namespace {
            content.glassEffectID(id, in: namespace)
        } else {
            content
        }
    }
}
