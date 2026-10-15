import SwiftUI

struct MainTabShell: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        ZStack {
            switch store.selectedTab {
            case .conversation:
                NavigationStack { root(ConversationScreen()) }.id(store.conversationRootRevision)
            case .hand:
                NavigationStack { root(HandScreen()) }
            case .notes:
                NavigationStack { root(NotesScreen()) }
            }
        }.background(DawnBackground()).toggleStyle(AstellaToggleStyle())
            .dropDestination(for: URL.self) { urls, _ in
                guard let url = urls.first else { return false }
                Task { await store.prepareFile(url); if store.errorMessage == nil { store.returnToConversation(records: false) } }
                return true
            }
    }
    private func root<Content: View>(_ content: Content) -> some View {
        content.toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { AstellaAppHeader() }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !store.composerHasFocus { AstellaMainDock() }
            }
    }
}

private struct AstellaMainDock: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Namespace private var indicator
    private let items: [(MainTab, String, String)] = [(.conversation, "伴星", "sparkle"), (.hand, "手边", "square.stack.3d.up"), (.notes, "手记", "book.closed")]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.0) { item in
                Button { withAnimation(Motion.gated(reduced || store.localReduceMotion, Motion.segment)) { store.selectedTab = item.0 } } label: {
                    VStack(spacing: 6) {
                        ZStack {
                            if store.selectedTab == item.0 {
                                Capsule().fill(StudyPalette.accent.opacity(0.85)).frame(width: 13, height: 2).matchedGeometryEffect(id: "dock", in: indicator).offset(y: -19)
                            }
                            Image(systemName: item.2).font(.system(size: 21, weight: .light))
                        }
                        Text(item.1).font(.system(size: 10, weight: store.selectedTab == item.0 ? .semibold : .regular)).tracking(1)
                    }.foregroundStyle(store.selectedTab == item.0 ? StudyPalette.ink : StudyPalette.muted)
                        .frame(maxWidth: .infinity).frame(height: 59).contentShape(Rectangle())
                }.accessibilityAddTraits(store.selectedTab == item.0 ? [.isSelected] : [])
            }
        }.padding(.horizontal, 10).padding(.vertical, 5)
            .modifier(StudyGlassSurfaceStyle(radius: 29, interactive: true))
            .padding(.horizontal, 42).padding(.bottom, 5).padding(.top, 8)
            .buttonStyle(AstellaPressStyle())
    }
}
