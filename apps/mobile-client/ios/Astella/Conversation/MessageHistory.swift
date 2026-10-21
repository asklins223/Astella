import SwiftUI

/// 记录 mode. The header anchors who is speaking; messages keep a stable
/// rhythm (day separator → bubbles → process card), and long history stays
/// scroll-position-aware.
struct MessageHistory: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 15
    var messages: [CompanionMessage]
    var streamingText: String
    var onMore: () -> Void = {}
    var onOpenNote: ((String) -> Void)? = nil
    @State private var isFollowingLatest = true
    @State private var didInitialScroll = false
    @State private var position = ScrollPosition(y: 0)

    private var motionDisabled: Bool { reduceMotion || store.localReduceMotion }

    var body: some View {
        VStack(spacing: 0) {
            historyHeader
            GeometryReader { geometry in
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if store.historyHasMore {
                                Button(store.historyLoadingOlder ? "正在读取更早记录…" : "查看更早的手记") {
                                    Task { await store.loadOlderConversationMessages() }
                                }
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(StudyPalette.accent)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 36)
                                .background(StudyPalette.sky.opacity(0.8), in: Capsule())
                                .buttonStyle(AstellaPressStyle())
                                .disabled(store.historyLoadingOlder)
                                .padding(.bottom, 18)
                            }
                            if let error = store.processError {
                                Text(error)
                                    .font(.system(size: 12))
                                    .foregroundStyle(StudyPalette.muted)
                                    .padding(.bottom, 16)
                            }
                            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                if startsNewDay(at: index) {
                                    daySeparator(for: message)
                                }
                                let availableWidth = geometry.size.width - 44
                                let maxBubbleWidth = max(220, availableWidth * (message.role == "user" ? 0.83 : 0.79))
                                MessageRow(message: message, maxBubbleWidth: maxBubbleWidth, onOpenNote: onOpenNote)
                                    .id(message.id)
                                    .transition(motionDisabled ? .opacity : .offset(y: 14).combined(with: .opacity).combined(with: .scale(scale: 0.98, anchor: message.role == "user" ? .bottomTrailing : .bottomLeading)))
                                    .padding(.bottom, 16)
                                ForEach(store.processRuns.filter { $0.userMessageId == message.id || ($0.userMessageId == nil && $0.assistantMessageId == message.id) }) { run in
                                    CompanionRunProcessView(run: run).padding(.bottom, 16)
                                }
                            }
                            if !streamingText.isEmpty {
                                streamingBubble
                                    .id("streaming")
                            }
                            Color.clear.frame(height: 1).id("latest")
                        }
                        .animation(Motion.gated(motionDisabled, Motion.messageSend), value: messages.count)
                        .padding(.horizontal, 22)
                        .padding(.top, 2)
                        .padding(.bottom, 20)
                    }
                    .scrollPosition($position)
                    .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in
                        if didInitialScroll { store.journalOffset = offset }
                    }
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentSize.height - geometry.visibleRect.maxY < 72
                    } action: { _, isNearLatest in
                        isFollowingLatest = isNearLatest
                        if didInitialScroll { store.journalFollowsLatest = isNearLatest }
                    }
                    .overlay {
                        if messages.isEmpty && streamingText.isEmpty {
                            emptyState
                                .allowsHitTesting(false)
                        }
                    }
                    .onAppear {
                        guard !didInitialScroll else { return }
                        guard !messages.isEmpty || !streamingText.isEmpty else { return }
                        didInitialScroll = true
                        isFollowingLatest = store.journalFollowsLatest
                        if !scrollToTarget(proxy) {
                            if store.journalFollowsLatest { proxy.scrollTo("latest", anchor: .bottom) }
                            else { position.scrollTo(y: store.journalOffset) }
                        }
                    }
                    .onChange(of: messages.count) { _, _ in
                        if scrollToTarget(proxy) { return }
                        if !didInitialScroll {
                            didInitialScroll = true
                            proxy.scrollTo("latest", anchor: .bottom)
                            return
                        }
                        guard store.journalFollowsLatest else { return }
                        if motionDisabled {
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
                        guard store.journalFollowsLatest else { return }
                        if motionDisabled {
                            proxy.scrollTo("latest", anchor: .bottom)
                        } else {
                            withAnimation(Motion.messageSend) { proxy.scrollTo("latest", anchor: .bottom) }
                        }
                    }
                    .onChange(of: store.journalTargetRunId) { _, _ in _ = scrollToTarget(proxy) }
                    .onChange(of: store.processRuns) { _, _ in _ = scrollToTarget(proxy) }
                    .overlay(alignment: .bottomTrailing) {
                        if !store.journalFollowsLatest {
                            Button {
                                store.journalFollowsLatest = true
                                if motionDisabled { proxy.scrollTo("latest", anchor: .bottom) }
                                else { withAnimation(Motion.messageSend) { proxy.scrollTo("latest", anchor: .bottom) } }
                            } label: {
                                HStack(spacing: 6) {
                                    AstellaGlyph(kind: .chevron, tint: StudyPalette.accent)
                                        .frame(width: 11, height: 11)
                                        .rotationEffect(.degrees(90))
                                    Text("回到最新").font(.system(size: 12, weight: .semibold))
                                }
                                .foregroundStyle(StudyPalette.ink)
                                .padding(.horizontal, 13)
                                .frame(minHeight: 36)
                                .modifier(StudyGlassSurfaceStyle(radius: 18, interactive: true))
                            }
                            .buttonStyle(AstellaPressStyle())
                            .padding(.trailing, 18)
                            .padding(.bottom, 14)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                }
            }
        }
    }

    private var historyHeader: some View {
        HStack(spacing: 11) {
            Image("CompanionAvatar")
                .resizable()
                .scaledToFill()
                .frame(width: 40, height: 40)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 0.8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("阿星")
                    .font(.system(size: 16, weight: .semibold))
                    .tracking(-0.3)
                    .foregroundStyle(StudyPalette.ink)
                Text("同一段相伴，慢慢聊下去。")
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
            Button(action: onMore) {
                AstellaGlyph(kind: .more, tint: StudyPalette.ink)
                    .frame(width: 17, height: 17)
                    .frame(width: 38, height: 38)
                    .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("对话操作")
        }
        .padding(.horizontal, 22)
        .padding(.top, 2)
        .padding(.bottom, 12)
    }

    private var streamingBubble: some View {
        HStack(alignment: .top, spacing: 10) {
            Image("CompanionAvatar")
                .resizable()
                .scaledToFill()
                .frame(width: 26, height: 26)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 0.7))
                .accessibilityHidden(true)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).tint(StudyPalette.accent)
                    Text("正在回应")
                        .font(.system(size: 10.5, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(StudyPalette.muted)
                }
                CompanionMarkdownText(text: streamingText, onOpenNote: onOpenNote)
                    .font(.system(size: bodyPointSize))
                    .lineSpacing(7)
                    .foregroundStyle(StudyPalette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .background(StudyPalette.paper.opacity(0.86), in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 7, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous))
            .overlay {
                UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 7, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous)
                    .stroke(.white.opacity(0.86), lineWidth: 0.8)
            }
            Spacer(minLength: 0)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            AstellaGlyph(kind: .chat, tint: StudyPalette.muted)
                .frame(width: 26, height: 26)
                .frame(width: 54, height: 54)
                .background(StudyPalette.paper.opacity(0.75), in: Circle())
            Text("还没有交流记录")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
                .padding(.top, 3)
            Text("在下方输入，和伴星开始一段交流。")
                .font(.system(size: 12.5))
                .lineSpacing(3)
                .foregroundStyle(StudyPalette.muted)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func daySeparator(for message: CompanionMessage) -> some View {
        HStack(spacing: 10) {
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.4)).frame(height: 0.7)
            Text(dateGroupLabel(for: message))
                .font(.system(size: 10, weight: .medium))
                .tracking(0.7)
                .foregroundStyle(StudyPalette.muted.opacity(0.8))
                .fixedSize()
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.4)).frame(height: 0.7)
        }
        .padding(.top, 2)
        .padding(.bottom, 18)
    }

    @discardableResult
    private func scrollToTarget(_ proxy: ScrollViewProxy) -> Bool {
        guard let runId = store.journalTargetRunId,
              let run = store.processRuns.first(where: { $0.id == runId }),
              messages.contains(where: { $0.id == run.userMessageId || $0.id == run.assistantMessageId }) else { return false }
        store.journalFollowsLatest = false
        proxy.scrollTo(run.userMessageId ?? run.assistantMessageId ?? "run:\(runId)", anchor: .top)
        store.journalTargetRunId = nil
        return true
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
