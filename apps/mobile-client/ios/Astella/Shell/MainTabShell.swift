import SwiftUI

struct MainTabShell: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Namespace private var dockSelectionLens
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
        ZStack {
                switch store.selectedTab {
                case .conversation:
                    NavigationStack(path: $conversationPath) {
                        root(ConversationScreen(selectionLens: dockSelectionLens, onOpenNote: { noteId in
                            store.selectedTab = .library
                            libraryPath.append(noteId)
                        }))
                    }
                        .id(store.conversationRootRevision)
                        .transition(.opacity)
                case .library:
                    NavigationStack(path: $libraryPath) { root(NotesScreen()) }.transition(.opacity)
                case .orbit:
                    NavigationStack(path: $orbitPath) { root(OrbitScreen()) }.transition(.opacity)
                case .me:
                    NavigationStack(path: $mePath) { root(AccountScreen()) }.transition(.opacity)
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Motion.gated(reducedMotion || store.localReduceMotion, Motion.segment), value: store.selectedTab)
        .onAppear { queueReviewRouteIfNeeded() }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if store.selectedTab != .conversation {
                if activeNavigationPath.isEmpty {
                    HStack(spacing: 24) {
                        AstellaMainDock(selectionLens: dockSelectionLens)
                            .frame(maxWidth: .infinity)
                        AstellaCompanionShortcut()
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .offset(y: 16)
                } else {
                    HStack {
                        Spacer()
                        AstellaCompanionShortcut()
                    }
                    .padding(.trailing, 22)
                    .padding(.top, 5)
                    .padding(.bottom, 6)
                    .offset(y: 22)
                }
            }
        }
        .background(DawnBackground()).toggleStyle(AstellaToggleStyle())
            .dropDestination(for: URL.self) { urls, _ in
                guard let url = urls.first else { return false }
                Task { await store.prepareFile(url); if store.errorMessage == nil { store.returnToConversation(records: false) } }
                return true
            }
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
        if mode == "read" { libraryPath.append("open-design-redwall") }
        #endif
    }

    private func root<Content: View>(_ content: Content) -> some View {
        content
            .toolbar(.hidden, for: .navigationBar)
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

    var body: some View {
        Button {
            withAnimation(Motion.gated(reducedMotion || store.localReduceMotion, Motion.routePush)) {
                store.chatShowsRecords = false
                store.selectedTab = .conversation
            }
        } label: {
            AstellaGlyph(kind: .companion, tint: StudyPalette.accent)
                .frame(width: 25, height: 25)
                .frame(width: 60, height: 60)
                .modifier(StudyGlassSurfaceStyle(radius: 30, interactive: true))
                .overlay(Circle().stroke(.white.opacity(0.82), lineWidth: 0.8))
                .shadow(color: StudyPalette.ink.opacity(0.08), radius: 7, x: 0, y: 3)
                .contentShape(Circle())
        }
        .buttonStyle(AstellaPressStyle())
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
    private let items: [(MainTab, String, AstellaGlyphKind)] = [
        (.conversation, "相伴", .companion),
        (.library, "书房", .library),
        (.orbit, "星轨", .orbit),
        (.me, "我的", .person),
    ]
    var body: some View {
        Group {
            if integrated { dockContent }
            else { dockContent.modifier(StudyGlassSurfaceStyle(radius: 29, interactive: true)) }
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
                                .fill(Color.white.opacity(0.82))
                                .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(.white.opacity(0.8), lineWidth: 0.8))
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
