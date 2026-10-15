import SwiftUI

struct MessageHistory: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var messages: [CompanionMessage]
    var streamingText: String
    @State private var isFollowingLatest = true
    @State private var didInitialScroll = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(messages) { message in
                        MessageRow(message: message)
                            .id(message.id)
                    }
                    if !streamingText.isEmpty {
                        HStack {
                            Text(streamingText)
                                .font(.system(size: bodyPointSize * store.readingScale))
                                .lineSpacing(4)
                                .foregroundStyle(StudyPalette.ink)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Spacer(minLength: 34)
                        }
                        .padding(16)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18))
                        .id("streaming")
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 72
            } action: { _, isNearLatest in
                isFollowingLatest = isNearLatest
            }
            .onAppear {
                guard !didInitialScroll else { return }
                guard !messages.isEmpty || !streamingText.isEmpty else { return }
                didInitialScroll = true
                proxy.scrollTo("latest", anchor: .bottom)
            }
            .onChange(of: messages.count) { _, _ in
                if !didInitialScroll {
                    didInitialScroll = true
                    proxy.scrollTo("latest", anchor: .bottom)
                    return
                }
                guard isFollowingLatest else { return }
                if reduceMotion || store.localReduceMotion {
                    proxy.scrollTo("latest", anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("latest", anchor: .bottom) }
                }
            }
            .onChange(of: streamingText) { _, _ in
                if !didInitialScroll {
                    didInitialScroll = true
                    proxy.scrollTo("latest", anchor: .bottom)
                    return
                }
                guard isFollowingLatest else { return }
                if reduceMotion || store.localReduceMotion {
                    proxy.scrollTo("latest", anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("latest", anchor: .bottom) }
                }
            }
            .overlay {
                if messages.isEmpty && streamingText.isEmpty {
                    VStack(spacing: 7) {
                        Text("还没有交流记录")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text("在下方输入，和伴星开始一段交流。")
                            .font(.subheadline)
                            .foregroundStyle(StudyPalette.muted)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                }
            }
        }
    }
}
