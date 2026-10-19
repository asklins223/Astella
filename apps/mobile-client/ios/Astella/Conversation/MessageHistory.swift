import SwiftUI
import UIKit

struct MessageHistory: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 15
    var messages: [CompanionMessage]
    var streamingText: String
    var onMore: () -> Void = {}
    @State private var isFollowingLatest = true
    @State private var didInitialScroll = false

    var body: some View {
        GeometryReader { geometry in
            let screenHeight = UIScreen.main.bounds.height
            let sceneOriginY = geometry.frame(in: .global).minY
            let designOffset: CGFloat = 0
            let headerTop = 48 + 81 + designOffset - sceneOriginY
            let timelineTop = 48 + 147 + designOffset - sceneOriginY
            let timelineBottom = screenHeight - 174 + designOffset - sceneOriginY

            ScrollViewReader { proxy in
                ZStack(alignment: .topLeading) {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                if startsNewDay(at: index) {
                                    Text(dateGroupLabel(for: message))
                                        .font(.system(size: 10))
                                        .tracking(0.7)
                                        .foregroundStyle(StudyPalette.muted.opacity(0.74))
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 3)
                                        .padding(.bottom, 23)
                                }
                                let availableWidth = geometry.size.width - 48
                                let maxBubbleWidth = max(220, availableWidth * (message.role == "user" ? 0.83 : 0.785))
                                MessageRow(message: message, maxBubbleWidth: maxBubbleWidth)
                                    .id(message.id)
                                    .transition(reduceMotion || store.localReduceMotion ? .opacity : .offset(y: 18).combined(with: .opacity).combined(with: .scale(scale: 0.97, anchor: message.role == "user" ? .bottomTrailing : .bottomLeading)))
                                    .padding(.bottom, 18)
                            }
                            if !streamingText.isEmpty {
                                HStack {
                                    Text(companionMarkdown(streamingText))
                                        .font(.system(size: bodyPointSize))
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
                        .animation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.messageSend), value: messages.count)
                        .padding(.horizontal, 24)
                        .padding(.top, max(12, timelineTop + 9))
                        .padding(.bottom, 18)
                    }
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentSize.height - geometry.visibleRect.maxY < 72
                    } action: { _, isNearLatest in
                        isFollowingLatest = isNearLatest
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
                            .position(x: geometry.size.width / 2, y: max(headerTop + 48, (timelineTop + timelineBottom) / 2))
                            .allowsHitTesting(false)
                        }
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
                            withAnimation(Motion.messageSend) { proxy.scrollTo("latest", anchor: .bottom) }
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
                            withAnimation(Motion.messageSend) { proxy.scrollTo("latest", anchor: .bottom) }
                        }
                    }

                    historyHeader(top: headerTop)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func historyHeader(top: CGFloat) -> some View {
        HStack(spacing: 11) {
            Image("CompanionAvatar")
                .resizable()
                .scaledToFill()
                .frame(width: 38, height: 38)
                .clipShape(Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("阿星")
                    .font(.system(size: 17, weight: .medium))
                    .tracking(-0.4)
                    .foregroundStyle(StudyPalette.ink)
                Text("同一段相伴，慢慢聊下去。")
                    .font(.system(size: 10))
                    .foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
            Button(action: onMore) {
                AstellaGlyph(kind: .more, tint: StudyPalette.ink)
                    .frame(width: 18, height: 18)
                    .frame(width: 38, height: 38)
                    .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("对话操作")
        }
        .frame(height: 48)
        .padding(.horizontal, 27)
        .frame(maxWidth: .infinity, alignment: .leading)
        .offset(y: top)
    }

    private func startsNewDay(at index: Int) -> Bool {
        guard messages.indices.contains(index) else { return false }
        guard index > messages.startIndex else { return true }
        let current = messageDate(messages[index].createdAt)
        let previous = messageDate(messages[index - 1].createdAt)
        guard let current, let previous else { return index == messages.startIndex }
        return !Calendar.current.isDate(current, inSameDayAs: previous)
    }

    private func dateGroupLabel(for message: CompanionMessage) -> String {
        guard let date = messageDate(message.createdAt) else { return "今天 · 一起慢慢来" }
        if Calendar.current.isDateInToday(date) { return "今天 · 一起慢慢来" }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter.string(from: date)
    }

    private func messageDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
