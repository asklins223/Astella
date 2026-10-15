import SwiftUI

@main
struct AstellaApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(StudyPalette.accent)
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        applicationRoot
    }

    @ViewBuilder
    private var applicationRoot: some View {
        Group {
            if store.profile != nil {
                MainTabShell()
            } else if store.isAuthenticated {
                SessionRecoveryScreen()
            } else {
                LoginScreen()
            }
        }
        .transaction { if store.localReduceMotion { $0.animation = nil } }
        .background {
            DawnBackground()
        }
    }
}
