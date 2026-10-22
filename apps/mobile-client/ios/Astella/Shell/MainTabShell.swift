import SwiftUI
import UIKit

struct MainTabShell: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Namespace private var dockSelectionLens
    @Namespace private var bottomGlassLens
    @State private var conversationPath = NavigationPath()
    @State private var libraryPath = NavigationPath()
    @State private var orbitPath = NavigationPath()
    @State private var mePath = NavigationPath()
    #if DEBUG
    @State private var didQueueReviewRoute = false
    #endif

    private var activeNavigationPath: NavigationPath {
        switch store.selectedTab {
        case .conversation: conversationPath
        case .library: libraryPath
        case .orbit: orbitPath
        case .me: mePath
        }
    }

    var body: some View {
        @Bindable var store = store
        // A real TabView keeps each tab's navigation stack, scroll offset and
        // loaded data alive. Swapping views by hand used to rebuild the page on
        // every tap: scroll jumped to the top, page fetches ran again and the
        // entrance animation replayed. The system tab bar itself stays hidden;
        // the glass dock is our bar.
        TabView(selection: $store.selectedTab) {
            Tab("相伴", systemImage: "sparkles", value: MainTab.conversation) {
                NavigationStack(path: $conversationPath) {
                    root(ConversationScreen(onOpenNote: { noteId in
                        store.selectedTab = .library
                        libraryPath.append(noteId)
                    }))
                }
                .id(store.conversationRootRevision)
                .toolbar(.hidden, for: .tabBar)
            }

            Tab("书房", systemImage: "books.vertical", value: MainTab.library) {
                NavigationStack(path: $libraryPath) { root(NotesScreen()) }
                    .toolbar(.hidden, for: .tabBar)
            }

            Tab("星轨", systemImage: "circle.dotted", value: MainTab.orbit) {
                NavigationStack(path: $orbitPath) { root(OrbitScreen()) }
                    .toolbar(.hidden, for: .tabBar)
            }

            Tab("我的", systemImage: "person", value: MainTab.me) {
                NavigationStack(path: $mePath) { root(AccountScreen()) }
                    .toolbar(.hidden, for: .tabBar)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) {
            if let target = store.resultReturnTo, store.selectedTab != .conversation {
                Button {
                    store.resultReturnTo = nil
                    store.returnToConversation(records: true)
                    store.resultPreview = target
                } label: {
                    HStack(spacing: 7) {
                        AstellaGlyph(kind: .back, tint: StudyPalette.ink).frame(width: 13, height: 13)
                        Text("返回手记与预览").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(StudyPalette.ink)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 42)
                    .modifier(StudyGlassSurfaceStyle(radius: 21, interactive: true))
                    .shadow(color: StudyPalette.ink.opacity(0.08), radius: 12, x: 0, y: 5)
                }
                .buttonStyle(AstellaPressStyle())
                .padding(.bottom, 96)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Motion.gated(reducedMotion || store.localReduceMotion, Motion.companionDock), value: store.resultReturnTo == nil)
        .onAppear {
            queueReviewRouteIfNeeded()
            #if DEBUG
            // Records the dock dissolving into the floating orb, then back.
            if store.uiReviewMode == "dock-switch" {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(12))
                    // Slow on purpose: this fixture is used to inspect the
                    // mid-flight frames of the dock → orb split.
                    withAnimation(.easeInOut(duration: 2.4)) { store.selectedTab = .library }
                    try? await Task.sleep(for: .seconds(6))
                    withAnimation(.easeInOut(duration: 2.4)) { store.selectedTab = .conversation }
                }
            }
            #endif
        }
        .onChange(of: store.pendingNoteReferenceID) { _, noteId in
            guard let noteId else { return }
            store.selectedTab = .library
            libraryPath.append(noteId)
            store.pendingNoteReferenceID = nil
        }
        // The dock is one persistent bottom overlay, so switching tabs never
        // rebuilds it. Its height is reserved inside each NavigationStack root
        // (`root(_:)`) instead of out here: a safeAreaInset applied around a
        // NavigationStack does not reach the stack's content, so the reserve has
        // to sit on the root view itself.
        .overlay(alignment: .bottom) {
            if dockReserveHeight > 0 { bottomChrome }
        }
        .background(DawnBackground()).toggleStyle(AstellaToggleStyle())
            .dropDestination(for: URL.self) { urls, _ in
                guard let url = urls.first else { return false }
                Task { await store.prepareFile(url); if store.errorMessage == nil { store.returnToConversation(records: false) } }
                return true
            }
    }

    /// Height the dock occupies, so page content and the composer never slide
    /// underneath it. Pushed pages keep only the orb, which needs no reserve.
    private var dockReserveHeight: CGFloat {
        activeNavigationPath.isEmpty ? 88 : 0
    }

    private var bottomChrome: some View {
        // The dock keeps one matched-geometry identity across tabs so switching
        // contracts it into place instead of rebuilding it, and the companion
        // orb is added inside the same glass container so iOS 26 splits it out.
        AstellaGlassContainer(spacing: 26) {
            HStack(spacing: 24) {
                if activeNavigationPath.isEmpty {
                    AstellaMainDock(selectionLens: dockSelectionLens, glassLink: "dock", glassNamespace: bottomGlassLens)
                        .frame(maxWidth: .infinity)
                        .matchedGeometryEffect(id: "main-dock", in: bottomGlassLens)
                        .astellaGlassMaterialize()
                } else {
                    Spacer(minLength: 0)
                }
                if activeNavigationPath.isEmpty || !store.hidesCompanionShortcut {
                    if store.selectedTab != .conversation {
                        AstellaCompanionShortcut(glassLink: "companion", glassNamespace: bottomGlassLens)
                            .astellaGlassMaterialize()
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, activeNavigationPath.isEmpty ? 8 : 5)
            .padding(.bottom, activeNavigationPath.isEmpty ? 4 : 6)
        }
        .animation(Motion.gated(reducedMotion || store.localReduceMotion, Motion.companionDock), value: activeNavigationPath.isEmpty)
        .animation(Motion.gated(reducedMotion || store.localReduceMotion, Motion.segment), value: store.hidesCompanionShortcut)
    }

    private func queueReviewRouteIfNeeded() {
        #if DEBUG
        guard !didQueueReviewRoute, let mode = store.uiReviewMode else { return }
        didQueueReviewRoute = true
        let accountRoutes: [String: AccountScreenRoute] = [
            "settings": .settings,
            "profile": .profile,
            "companion-settings": .companionSettings,
            "reading-settings": .readingSettings,
            "device-permissions": .devicePermissions,
            "ai-authorization": .aiAuthorization,
            "server-address": .serverAddress,
            "conventions": .conventions,
            "companion-center": .companionCenter,
            "change-password": .changePassword,
        ]
        if let route = accountRoutes[mode] { mePath.append(route) }
        if ["read", "note-overview", "note-overview-ready", "note-versions", "note-annotations", "note-annotations-multiple", "note-explain", "note-explain-ready", "note-expansion", "note-expansion-saved", "note-learning-card", "note-learning-practice", "note-learning-result"].contains(mode) {
            libraryPath.append("open-design-redwall")
        } else {
            let featureModes: [String: NoteFeatureKind] = [
                "note-mind-map": .mindMap,
            ]
            if let kind = featureModes[mode] {
                libraryPath.append(NoteFeatureRoute(noteId: "open-design-redwall", kind: kind))
            }
        }
        #endif
    }

    private func root<Content: View>(_ content: Content) -> some View {
        content
            .toolbar(.hidden, for: .navigationBar)
            .background(
                InteractivePopGestureEnabler()
                    .frame(width: 0, height: 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            )
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: dockReserveHeight)
            }
            .navigationDestination(for: AccountScreenRoute.self) { route in
                switch route {
                case .account: AccountScreen()
                case .settings: MobileSettingsScreen()
                case .companionCenter: CompanionCenterScreen()
                case .profile: AccountProfileScreen()
                case .companionSettings: CompanionSettingsScreen()
                case .readingSettings: ReadingSettingsScreen()
                case .conventions: PersonalConventionsScreen()
                case .devicePermissions: DevicePermissionsScreen()
                case .aiAuthorization: AIDataAuthorizationScreen()
                case .serverAddress: ServiceAddressScreen()
                case .changePassword: ChangePasswordScreen()
                }
            }
            .navigationDestination(for: OrbitNavigationRoute.self) { route in
                switch route {
                case .diaryDay(let date): OrbitDiaryDetailScreen(date: date)
                case .memory(let id): OrbitMemoryDetailScreen(memoryId: id)
                case .memoryRecycle: OrbitMemoryRecycleScreen()
                }
            }
    }

}

private struct AstellaCompanionShortcut: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    var glassLink: String?
    var glassNamespace: Namespace.ID?

    var body: some View {
        Button {
            store.chatShowsRecords = false
            store.selectedTab = .conversation
        } label: {
            AstellaGlyph(kind: .companion, tint: StudyPalette.accent)
                .frame(width: 25, height: 25)
                .frame(width: 60, height: 60)
                .modifier(StudyGlassSurfaceStyle(radius: 30, interactive: true))
                .modifier(AstellaGlassLink(id: glassLink, namespace: glassNamespace))
                .overlay(Circle().stroke(.white.opacity(0.82), lineWidth: 0.8))
                .shadow(color: StudyPalette.ink.opacity(0.08), radius: 7, x: 0, y: 3)
                .contentShape(Circle())
        }
        .buttonStyle(AstellaRoundPressStyle())
        .accessibilityLabel("与伴星交流")
        .accessibilityHint("返回相伴页面")
    }
}

enum AccountScreenRoute: Hashable {
    case account
    case settings
    case companionCenter
    case profile
    case companionSettings
    case readingSettings
    case conventions
    case devicePermissions
    case aiAuthorization
    case serverAddress
    case changePassword
}

enum OrbitNavigationRoute: Hashable {
    case diaryDay(String)
    case memory(String)
    case memoryRecycle
}

struct AstellaMainDock: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced
    let selectionLens: Namespace.ID
    var integrated = false
    var glassLink: String?
    var glassNamespace: Namespace.ID?
    private let items: [(MainTab, String, AstellaGlyphKind)] = [
        (.conversation, "相伴", .companion),
        (.library, "书房", .library),
        (.orbit, "星轨", .orbit),
        (.me, "我的", .person),
    ]
    var body: some View {
        Group {
            if integrated { dockContent }
            else {
                dockContent.modifier(StudyGlassSurfaceStyle(radius: 29, interactive: true))
                    .modifier(AstellaGlassLink(id: glassLink, namespace: glassNamespace))
            }
        }
        .sensoryFeedback(.selection, trigger: store.selectedTab)
        .padding(.horizontal, integrated ? 4 : 0)
        .padding(.bottom, integrated ? 2 : 3).padding(.top, integrated ? 0 : 5)
    }

    private var dockContent: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.0) { item in
                let selected = store.selectedTab == item.0
                Button {
                    withAnimation(Motion.gated(reduced || store.localReduceMotion, Motion.segment)) {
                        store.selectedTab = item.0
                    }
                } label: {
                    ZStack {
                        if selected {
                            RoundedRectangle(cornerRadius: 17, style: .continuous)
                                .fill(StudyPalette.sky)
                                .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.72), lineWidth: 0.8))
                                .shadow(color: StudyPalette.ink.opacity(0.035), radius: 5, x: 0, y: 2)
                                .matchedGeometryEffect(id: "dock-selection-lens", in: selectionLens)
                                .padding(.horizontal, 3)
                                .padding(.vertical, 2)
                        }
                        VStack(spacing: 3) {
                            AstellaGlyph(kind: item.2, tint: selected ? StudyPalette.accent : StudyPalette.muted)
                                .frame(width: 20, height: 20)
                            Text(item.1).font(.system(size: 10, weight: selected ? .semibold : .regular))
                        }
                        .foregroundStyle(selected ? StudyPalette.accent : StudyPalette.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 55)
                    .contentShape(Rectangle())
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
    }
}

/// Every page draws its own header and hides the system navigation bar. UIKit
/// turns the interactive pop gesture off together with that bar, so each stack
/// installs this bridge and gets the native swipe-back, with its own
/// rubber-banding and cancellation, back.
struct InteractivePopGestureEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Bridge { Bridge() }
    func updateUIViewController(_ controller: Bridge, context: Context) {}

    final class Bridge: UIViewController, UIGestureRecognizerDelegate {
        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            install()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }

        private func install() {
            guard let navigation = navigationController,
                  let gesture = navigation.interactivePopGestureRecognizer else { return }
            gesture.delegate = self
            gesture.isEnabled = true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            (navigationController?.viewControllers.count ?? 0) > 1
        }
    }
}
