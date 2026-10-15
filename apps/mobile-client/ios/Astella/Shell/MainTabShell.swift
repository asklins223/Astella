import SwiftUI

struct MainTabShell: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        TabView(selection: Binding(get: { store.selectedTab }, set: { store.selectedTab = $0 })) {
            NavigationStack {
                ConversationScreen()
                    .navigationTitle("对话")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .id(store.conversationRootRevision)
            .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right.fill") }
            .tag(MainTab.conversation)

            NavigationStack {
                HandScreen()
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                            } label: {
                                Image(systemName: "person.crop.circle")
                            }
                            .accessibilityLabel("我的账户")
                        }
                    }
            }
            .tabItem { Label("手边", systemImage: "tray.full") }
            .tag(MainTab.hand)

            NavigationStack {
                NotesScreen()
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                            } label: {
                                Image(systemName: "person.crop.circle")
                            }
                            .accessibilityLabel("我的账户")
                        }
                    }
            }
            .tabItem { Label("手记", systemImage: "book.closed") }
            .tag(MainTab.notes)
        }
    }
}
