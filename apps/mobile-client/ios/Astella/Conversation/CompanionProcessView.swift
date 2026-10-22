import Foundation
import SwiftUI

private func companionDurationLabel(_ run: ActiveRun) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    guard let start = date(run.createdAt) else { return "" }
    let end = run.isActive ? Date() : date(run.updatedAt) ?? Date()
    let seconds = max(0, end.timeIntervalSince(start))
    if seconds < 60 { return String(format: "%.1fs", seconds) }
    return "\(Int(seconds) / 60)m\(Int(seconds) % 60)s"
}

/// The assistant turn opener: who is speaking, which mode, and how long this
/// exchange took. The process trace belongs beneath it, not beside the answer.
struct AssistantTurnHead: View {
    var run: ActiveRun

    private var duration: String { companionDurationLabel(run) }

    var body: some View {
        HStack(spacing: 7) {
            Image("CompanionAvatar")
                .resizable()
                .scaledToFill()
                .frame(width: 22, height: 22)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 0.7))
                .accessibilityHidden(true)
            Text("阿星")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
            if run.thinkingText?.isEmpty == false {
                HStack(spacing: 4) {
                    AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent)
                        .frame(width: 10, height: 10)
                    Text("深想")
                        .font(.system(size: 9.5, weight: .semibold))
                }
                .foregroundStyle(StudyPalette.accent)
                .padding(.horizontal, 7)
                .frame(height: 21)
                .background(StudyPalette.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            Spacer(minLength: 6)
            if !duration.isEmpty {
                Text(duration)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(StudyPalette.muted.opacity(0.66))
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 2)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }
}

/// One exchange's process, folded into a quiet disclosure. The answer stays the
/// heaviest thing on screen: collapsed, this is only a header; expanded, the
/// steps get a rail that lives *inside* the process instead of beside the answer.
struct CompanionRunProcessView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduce
    var run: ActiveRun
    @State private var recovering = false
    @State private var recoveryNotice = ""
    @State private var openNodes: Set<String> = []

    private var motionDisabled: Bool { systemReduce || store.localReduceMotion }
    private var expanded: Bool { !store.journalCollapsed.contains(run.id) }
    private var faint: Color { StudyPalette.muted.opacity(0.66) }
    private var rail: Color { StudyPalette.muted.opacity(0.28) }
    private var cardFill: Color { StudyPalette.paper.opacity(0.68) }
    private var emptyProcessMessage: String {
        if run.isActive { return "已接下请求，等待第一段进展。" }
        if run.nodeCount > 0 { return "详细过程暂时无法读取；已保存的消息和成果仍可查看。" }
        return "这次交流没有留下可展示的步骤。"
    }
    private var headerSubtitle: String {
        if run.isActive { return run.progressLabel }
        let tools = visibleNodes.isEmpty ? "思考" : "\(visibleNodes.count) 个工具"
        return expanded ? "\(tools) · 可收起" : "\(tools) · 已收起，可展开回看"
    }
    private var hasActions: Bool {
        run.isActive || run.canResume || visibleNodes.contains { $0.status == "outcome_unknown" }
    }
    private var elapsedLabel: String { companionDurationLabel(run) }
    private var visibleNodes: [CompanionProcessNode] {
        run.nodes.filter { !$0.id.hasPrefix("status:") }
    }
    private var visibleStepCount: Int {
        visibleNodes.count + (run.thinkingText?.isEmpty == false ? 1 : 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    if run.status == "failed" {
                        Text(run.failureDescription)
                            .font(.system(size: 12))
                            .lineSpacing(3)
                            .foregroundStyle(StudyPalette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(StudyPalette.danger.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if visibleStepCount > 0 {
                        timeline
                    } else {
                        Text(emptyProcessMessage)
                            .font(.system(size: 12.5))
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                .padding(.top, 2)
                .padding(.leading, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            actions
                .padding(.top, hasActions ? 8 : 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id("run:\(run.id)")
    }

    private var header: some View {
        Button {
            withAnimation(Motion.gated(motionDisabled, Motion.segment)) {
                if expanded { store.journalCollapsed.insert(run.id) } else { store.journalCollapsed.remove(run.id) }
            }
        } label: {
            HStack(spacing: 8) {
                iconTile(.sparkle, size: 27, iconSize: 13)
                VStack(alignment: .leading, spacing: 2) {
                    Text("思考与工具")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text(headerSubtitle)
                        .font(.system(size: 10))
                        .foregroundStyle(faint)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                if !elapsedLabel.isEmpty {
                    Text(elapsedLabel)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(faint)
                        .monospacedDigit()
                }
                AstellaGlyph(kind: .chevron, tint: faint)
                    .frame(width: 15, height: 15)
                    .rotationEffect(.degrees(expanded ? 90 : -90))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityLabel(expanded ? "收起这次过程" : "展开这次过程")
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let thinking = run.thinkingText, !thinking.isEmpty {
                timelineRow(
                    id: "thinking",
                    label: "想了想",
                    code: "thought",
                    icon: .sparkle,
                    state: run.isActive ? "整理中" : "已想",
                    stateTint: run.isActive ? StudyPalette.accent : StudyPalette.success,
                    dotTint: run.isActive ? StudyPalette.accent : StudyPalette.success,
                    pulsing: run.isActive,
                    isLast: visibleNodes.isEmpty,
                    hasBody: true,
                    showsCheck: !run.isActive
                ) {
                    Text(thinking)
                        .font(.system(size: 12))
                        .lineSpacing(4)
                        .foregroundStyle(StudyPalette.muted)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            ForEach(Array(visibleNodes.enumerated()), id: \.element.id) { index, node in
                let succeeded = node.status == "succeeded"
                timelineRow(
                    id: node.id,
                    label: node.label,
                    code: nodeCode(node),
                    icon: icon(for: node),
                    state: succeeded ? "完成" : (node.isRunning && !run.isActive ? "结果待核对" : node.statusLabel),
                    stateTint: stateTint(for: node),
                    dotTint: node.isRunning ? StudyPalette.accent : (succeeded ? StudyPalette.success : StudyPalette.muted.opacity(0.55)),
                    pulsing: node.isRunning && run.isActive,
                    isLast: index == visibleNodes.count - 1,
                    hasBody: hasBody(node),
                    showsCheck: succeeded
                ) {
                    nodeCard(node)
                }
            }
        }
    }

    private func timelineRow<Content: View>(
        id: String, label: String, code: String?, icon: AstellaGlyphKind,
        state: String?, stateTint: Color, dotTint: Color, pulsing: Bool,
        isLast: Bool, hasBody: Bool, showsCheck: Bool = false,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let runningHere = run.isActive && visibleNodes.first(where: { $0.id == id })?.isRunning == true
        let isOpen = hasBody && (openNodes.contains(id) || runningHere)
        return HStack(alignment: .top, spacing: 0) {
            VStack(spacing: 0) {
                Circle()
                    .fill(dotTint)
                    .frame(width: 7, height: 7)
                    .overlay {
                        if pulsing {
                            Circle().stroke(dotTint.opacity(0.22), lineWidth: 3).padding(-3)
                        }
                    }
                    .padding(.top, 18)
                if !isLast {
                    Rectangle()
                        .fill(rail)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.top, 4)
                }
            }
            .frame(width: 9)

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    guard hasBody else { return }
                    withAnimation(Motion.gated(motionDisabled, Motion.segment)) {
                        if openNodes.contains(id) { openNodes.remove(id) } else { openNodes.insert(id) }
                    }
                } label: {
                    HStack(spacing: 8) {
                        iconTile(icon)
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(label)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(StudyPalette.ink)
                                .lineLimit(1)
                            if let code, !code.isEmpty {
                                Text(code)
                                    .font(.system(size: 8.5, design: .monospaced))
                                    .foregroundStyle(faint)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 4)
                        if showsCheck {
                            AstellaGlyph(kind: .checkmark, tint: stateTint)
                                .frame(width: 9, height: 9)
                        }
                        if let state, !state.isEmpty {
                            Text(state)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(stateTint)
                                .lineLimit(1)
                        }
                        AstellaGlyph(kind: .chevron, tint: faint)
                            .frame(width: 15, height: 15)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                            .opacity(hasBody ? 1 : 0)
                    }
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!hasBody)
                .accessibilityLabel(hasBody ? (isOpen ? "收起\(label)" : "展开\(label)") : label)

                if isOpen {
                    content()
                        .padding(11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(cardFill, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .stroke(StudyPalette.paperEdge.opacity(0.4), lineWidth: 0.7)
                        }
                        .padding(.bottom, 8)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.leading, 10)
        }
        .padding(.bottom, isLast ? 0 : 2)
    }

    @ViewBuilder private func nodeCard(_ node: CompanionProcessNode) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if let summary = node.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 12))
                    .lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = node.note {
                Button { store.resultPreview = note } label: {
                    HStack(spacing: 6) {
                        AstellaGlyph(kind: .book, tint: StudyPalette.accent).frame(width: 12, height: 12)
                        Text("预览《\(note.title)》").font(.system(size: 11.5, weight: .medium))
                    }
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 30)
                    .background(StudyPalette.sky, in: Capsule())
                }
                .buttonStyle(AstellaPressStyle())
            }
            if let proposalId = node.proposalId, node.status == "waiting_confirmation" {
                CompanionProposalCard(proposalId: proposalId)
            }
        }
    }

    private func iconTile(_ kind: AstellaGlyphKind, size: CGFloat = 22, iconSize: CGFloat = 12) -> some View {
        RoundedRectangle(cornerRadius: size * 0.34, style: .continuous)
            .fill(StudyPalette.paper.opacity(0.78))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.34, style: .continuous)
                    .stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7)
            }
            .overlay {
                AstellaGlyph(kind: kind, tint: StudyPalette.muted)
                    .frame(width: iconSize, height: iconSize)
            }
            .frame(width: size, height: size)
    }

    private func nodeCode(_ node: CompanionProcessNode) -> String? {
        if node.id.hasPrefix("tool:") { return String(node.id.dropFirst(5)) }
        return nil
    }

    private func icon(for node: CompanionProcessNode) -> AstellaGlyphKind {
        let key = "\(node.id) \(node.label)".lowercased()
        if key.contains("read") || key.contains("note") || key.contains("book") || key.contains("读") { return .book }
        if key.contains("search") || key.contains("lookup") || key.contains("查") { return .search }
        if key.contains("write") || key.contains("edit") || key.contains("save") || key.contains("写") { return .edit }
        if key.contains("quote") || key.contains("注") { return .quote }
        return node.note == nil ? .sparkle : .book
    }

    private func hasBody(_ node: CompanionProcessNode) -> Bool {
        (node.summary?.isEmpty == false) || node.note != nil || (node.proposalId != nil && node.status == "waiting_confirmation")
    }

    private func stateTint(for node: CompanionProcessNode) -> Color {
        if node.isRunning { return StudyPalette.accent }
        if node.status == "succeeded" { return StudyPalette.success }
        if ["failed", "outcome_unknown"].contains(node.status) { return StudyPalette.danger }
        if node.status == "waiting_confirmation" { return StudyPalette.accent }
        return faint
    }

    @ViewBuilder private var actions: some View {
        let needsReconcile = !run.isActive && run.nodes.contains { $0.status == "outcome_unknown" }
        if run.isActive || needsReconcile || run.canResume || !recoveryNotice.isEmpty {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 10) {
                    if run.isActive {
                        Button("停止这次任务") { Task { await store.cancelProcessRun(run.id) } }
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(StudyPalette.muted)
                            .frame(minHeight: 34)
                    }
                    if needsReconcile {
                        Button("核对保存结果") { recover(reconcileOnly: true) }
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(StudyPalette.accent)
                            .frame(minHeight: 34)
                            .disabled(recovering)
                    }
                    if run.canResume {
                        Button(recovering ? "正在继续…" : "从中断处继续") { recover() }
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 34)
                            .background(StudyPalette.sky, in: Capsule())
                            .disabled(recovering)
                    }
                    Spacer(minLength: 0)
                }
                if !recoveryNotice.isEmpty {
                    Text(recoveryNotice)
                        .font(.system(size: 11.5))
                        .foregroundStyle(StudyPalette.muted)
                }
            }
        }
    }

    private func recover(reconcileOnly: Bool = false) {
        guard !recovering else { return }
        recovering = true
        Task { recoveryNotice = await store.recoverProcessRun(run, reconcileOnly: reconcileOnly); recovering = false }
    }
}

struct CompanionRunClock: View {
    var run: ActiveRun
    private func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let end = run.isActive ? context.date : date(run.updatedAt) ?? context.date
            let elapsed = max(0, Int(end.timeIntervalSince(date(run.createdAt) ?? end)))
            let last = run.nodes.compactMap { date($0.occurredAt) }.max() ?? date(run.updatedAt) ?? date(run.createdAt)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(date(run.createdAt) == nil ? "" : "已用 \(elapsed / 60)分\(elapsed % 60)秒 · ")\(run.nodes.filter { $0.note != nil }.count) 份成果已保存")
                    .monospacedDigit()
                if run.isActive, let last, context.date.timeIntervalSince(last) >= 30 {
                    Text("暂时没有新进展。已有成果可以先看，也可以停止等待。")
                }
            }
            .font(.system(size: 10.5))
            .foregroundStyle(StudyPalette.muted)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Live process card pinned above the composer while a run is in flight.
struct CompanionLiveProgress: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Circle().fill(StudyPalette.accent).frame(width: 6, height: 6)
                Text("正在发生")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 6)
                if let first = store.runs.first {
                    Button("查看过程") { store.showRunInJournal(first.id) }
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                }
            }
            ForEach(store.runs) { run in
                VStack(alignment: .leading, spacing: 5) {
                    Text(run.progressLabel)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(2)
                    CompanionRunClock(run: run)
                }
                let results = run.nodes.compactMap(\.note)
                if !results.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(results) { note in
                                Button("预览《\(note.title)》") { store.resultPreview = note }
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(StudyPalette.accent)
                                    .padding(.horizontal, 10)
                                    .frame(minHeight: 30)
                                    .background(StudyPalette.sky, in: Capsule())
                                    .buttonStyle(AstellaPressStyle())
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
            if let error = store.processError {
                Text(error).font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8)
        }
        .shadow(color: StudyPalette.ink.opacity(0.05), radius: 10, x: 0, y: 4)
    }
}

struct CompanionResultPreviewSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var target: CompanionNoteTarget
    var onOpenNote: (String) -> Void
    @State private var document: NoteDocument?
    @State private var failure: String?
    @State private var attempt = 0
    @State private var position = ScrollPosition(y: 0)
    @State private var readingOffset: CGFloat = 0

    var body: some View {
        NavigationStack {
            Group {
                if let document {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(document.title).font(.title2.weight(.semibold))
                            Text("保存的第 \(document.versionNumber) 版").font(.caption).foregroundStyle(.secondary)
                            if let ordinal = target.blockOrdinal, !document.blocks.contains(where: { $0.id == ordinal }) {
                                Text("原段落已不在这份版本中，以下保留完整正文。").font(.caption).foregroundStyle(.secondary)
                            }
                            ForEach(document.blocks) { block in CompanionMarkdownText(text: block.content, onOpenNote: { store.requestNoteReference($0) }).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).id(block.id) }
                        }.padding(22).frame(maxWidth: 680)
                    }
                    .scrollPosition($position)
                    .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in readingOffset = offset }
                    .onAppear { if let saved = store.resultPreviewOffsets[target.id] { position.scrollTo(y: saved) }
                        else if let ordinal = target.blockOrdinal { position.scrollTo(id: ordinal, anchor: .top) } }
                    .onDisappear { store.resultPreviewOffsets[target.id] = readingOffset }
                } else if let failure {
                    ContentUnavailableView {
                        Label("暂时无法预览", systemImage: "doc.text")
                    } description: { Text(failure) } actions: { Button("重新读取") { attempt += 1 }.buttonStyle(.borderedProminent).tint(.blue) }
                } else { ProgressView("正在读取已保存的内容…") }
            }
            .navigationTitle("成果预览").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    if let runId = target.runId { Button("查看这次完整记录") { dismiss(); store.showRunInJournal(runId) }.tint(.blue) }
                    Button("打开当前笔记") { store.resultReturnTo = target; store.resultPreview = nil; onOpenNote(target.noteId) }
                        .buttonStyle(.borderedProminent).tint(.blue).disabled(document == nil)
                }.frame(maxWidth: .infinity).padding().background(.bar)
            }
        }
        .task(id: "\(target.id):\(attempt)") {
            document = nil; failure = nil
            do { let result = try await store.loadResultPreview(target); try Task.checkCancellation(); document = result }
            catch is CancellationError { }
            catch { failure = mobilePageError(error, fallback: "内容无法读取，可能已删除、权限变化或连接中断。原记录仍在，可以重试读取。") }
        }
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
}
