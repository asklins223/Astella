import SwiftUI

struct SessionRecoveryScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 14) {
            AstellaGlyph(kind: .book, tint: StudyPalette.accent)
                .frame(width: 28, height: 28)
                .frame(width: 64, height: 64)
                .background(StudyPalette.sky, in: Circle())
            Text("正在接回你的书房")
                .font(.title2.weight(.semibold)).foregroundStyle(StudyPalette.ink)
            Text(store.errorMessage ?? "正在恢复登录状态与学习记录。")
                .font(.subheadline).foregroundStyle(StudyPalette.muted).multilineTextAlignment(.center)
            if store.isLoading {
                ProgressView().padding(.top, 4)
            } else {
                Button("重新连接") { Task { await store.restoreSession() } }
                    .modifier(PrimaryActionStyle()).padding(.top, 4)
                Button("返回登录") { store.logout() }
                    .font(.subheadline.weight(.medium)).foregroundStyle(StudyPalette.accent)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DawnBackground())
    }
}
