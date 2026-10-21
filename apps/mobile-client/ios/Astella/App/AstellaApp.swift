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
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("study.appearance.dark") private var darkMode = false
    @AppStorage("study.appearance.mode") private var appearanceMode = "light"
    @State private var launchFinished = false
    @State private var companionFrame: CGRect = .zero

    private var showsArrival: Bool {
        return !launchFinished && (store.startupLoadState == .loading || store.startupLoadState == .ready)
    }

    private var wantsCompanionLanding: Bool {
        store.selectedTab == .conversation && !store.chatShowsRecords
    }

    private var reviewAuthRoute: AuthRoute? {
        #if DEBUG
        switch store.uiReviewMode {
        case "auth-login": .login
        case "auth-register": .register
        case "auth-register-password": .registerPassword
        case "auth-register-code": .registerCode
        case "auth-forgot": .forgot
        case "auth-reset": .reset
        case "auth-reset-password": .resetPassword
        case "auth-email-login": .emailLogin
        case "auth-email-login-code": .emailLoginCode
        default: nil
        }
        #else
        nil
        #endif
    }

    var body: some View {
        ZStack {
            applicationRoot
                .environment(\.launchHidesCompanion, showsArrival)
            if showsArrival {
                LaunchMotionView(
                    dark: appearanceMode == "dark" || (appearanceMode == "system" && systemColorScheme == .dark),
                    reduced: systemReduceMotion || store.localReduceMotion,
                    active: scenePhase == .active,
                    ready: store.startupLoadState == .ready && (!wantsCompanionLanding || !companionFrame.isEmpty),
                    target: wantsCompanionLanding && !companionFrame.isEmpty ? companionFrame : nil,
                    onFinished: { launchFinished = true }
                )
                .zIndex(100)
            }
        }
            .onPreferenceChange(LaunchCompanionFrameKey.self) { companionFrame = $0 }
            .onChange(of: store.startupLoadState) { _, state in
                if state == .loading { launchFinished = false; companionFrame = .zero }
            }
            .preferredColorScheme(rootColorScheme)
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

    private var colorScheme: ColorScheme? {
        switch appearanceMode {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    private var rootColorScheme: ColorScheme? {
        // Authentication keeps its designed light surface. A saved in-app
        // appearance preference applies after the user enters the study room.
        if reviewAuthRoute != nil || (store.profile == nil && !store.isAuthenticated) { return .light }
        return colorScheme
    }

    @ViewBuilder
    private var applicationRoot: some View {
        Group {
            if let reviewAuthRoute {
                LoginScreen(initialRoute: reviewAuthRoute, reviewSample: true)
            } else if store.profile != nil {
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
