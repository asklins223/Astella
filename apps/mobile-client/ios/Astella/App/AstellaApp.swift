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
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        applicationRoot
            .simultaneousGesture(TapGesture().onEnded { store.lastInteraction = ProcessInfo.processInfo.systemUptime })
            .onChange(of: store.draft) { _, _ in store.lastInteraction = ProcessInfo.processInfo.systemUptime }
            .onChange(of: store.selectedTab) { _, _ in
                store.visibleNoteId = nil
                store.lastInteraction = ProcessInfo.processInfo.systemUptime
                Task { await store.reportAwareness(topic: "page.arrived", foreground: scenePhase == .active) }
            }
            .onChange(of: scenePhase) { _, phase in
                store.lastInteraction = ProcessInfo.processInfo.systemUptime
                store.lastObservation = ProcessInfo.processInfo.systemUptime
                Task { await store.reportAwareness(topic: phase == .active ? "app.foreground" : "context.updated", foreground: phase == .active) }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await store.reportAwareness(topic: "app.started", foreground: true)
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    await store.reportAwareness(topic: ProcessInfo.processInfo.systemUptime - store.lastInteraction >= 90 ? "presence.quiet" : "context.updated", foreground: true)
                }
            }
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
