import SwiftUI

private struct LaunchHidesCompanionKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var launchHidesCompanion: Bool {
        get { self[LaunchHidesCompanionKey.self] }
        set { self[LaunchHidesCompanionKey.self] = newValue }
    }
}

struct LaunchCompanionFrameKey: PreferenceKey {
    static var defaultValue: CGRect { .zero }
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if !next.isEmpty { value = next }
    }
}

/// Only artwork is rendered in WebKit. Authentication, data and home stay native.
struct LaunchMotionView: View {
    let dark: Bool
    let reduced: Bool
    let active: Bool
    let ready: Bool
    let target: CGRect?
    let onFinished: () -> Void
    @State private var rendered = false
    @State private var preparing = false

    var body: some View {
        // Keep the full-screen artwork centered in the window. Aligning the
        // entire stack to top-trailing shifted the safe-area-sized artwork to
        // the right and exposed a vertical strip of the backdrop on iPhone.
        ZStack(alignment: .center) {
            Color(red: dark ? 0.063 : 0.953, green: dark ? 0.110 : 0.965, blue: dark ? 0.212 : 0.996)
                .opacity(rendered ? 0 : 1)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            if !rendered {
                Image(dark ? "LaunchNight" : "LaunchDay").resizable().scaledToFit()
                    .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
            }

            LaunchMotionWebView(dark: dark, reduced: reduced, active: active, ready: ready,
                                target: target, onPreparing: { preparing = true },
                                onRendered: { rendered = true }, onFinished: onFinished)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
                .accessibilityHidden(true)
                .allowsHitTesting(false)

            VStack {
                HStack {
                    Spacer()
                    Button("跳过动画", action: onFinished)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(dark ? Color.white.opacity(0.8) : Color(red: 0.36, green: 0.43, blue: 0.61))
                        .padding(.horizontal, 18).frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                Spacer()
                if !ready {
                    Text("正在接回你的书房")
                        .font(.system(size: 11))
                        .foregroundStyle(dark ? Color.white.opacity(0.65) : Color.secondary)
                        .padding(.bottom, 14)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(active)-\(preparing)") {
            guard active else { return }
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            // A decorative renderer must never strand session recovery or home.
            if !rendered { onFinished() }
        }
    }
}
