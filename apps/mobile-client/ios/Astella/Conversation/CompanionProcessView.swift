import SwiftUI

/// One completed exchange's process, folded into a quiet card. The header keeps
/// the status legible at a glance; expanding reveals a real timeline with a
/// continuous rule, so the steps read as one sequence instead of equal-weight rows.
struct CompanionRunProcessView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduce
    var run: ActiveRun
    @State private var recovering = false
    @State private var recoveryNotice = ""

    private var motionDisabled: Bool { systemReduce || store.localReduceMotion }
    private var expanded: Bool { !store.journalCollapsed.contains(run.id) }
    private var emptyProcessMessage: String {
        if run.isActive { return "已接下请求，等待第一段进展。" }
        if run.nodeCount > 0 { return "详细过程暂时无法读取；已保存的消息和成果仍可查看。" }
        return "这次交流没有留下可展示的步骤。"
    }
    private var statusTint: Color {
        if run.status == "failed" { return StudyPalette.danger }
        return run.isActive ? StudyPalette.accent : StudyPalette.success
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.gated(motionDisabled, Motion.segment)) {
                    if expanded { store.journalCollapsed.insert(run.id) } else { store.journalCollapsed.remove(run.id) }
                }
            } label: {
                HStack(spacing: 9) {
                    Circle()
                        .fill(statusTint)
                        .frame(width: 6, height: 6)
                        .overlay {
                            if run.isActive {
                                Circle().stroke(statusTint.opacity(0.22), lineWidth: 4).padding(-4)
                            }
                        }
                    Text("这次交流的过程")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Spacer(minLength: 8)
                    Text(run.statusLabel)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(statusTint)
                        .padding(.horizontal, 8)
                        .frame(minHeight: 22)
                        .background(statusTint.opacity(0.10), in: Capsule())
                    AstellaGlyph(kind: .chevron, tint: StudyPalette.muted)
                        .frame(width: 11, height: 11)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel(expanded ? "收起这次过程" : "展开这次过程")

            if expanded {
                VStack(alignment: .leading, spacing: 13) {
                    CompanionRunClock(run: run)

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

                    if let thinking = run.thinkingText, !thinking.isEmpty {
                        Text(thinking)
                            .font(.system(size: 12.5))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.muted)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if !run.nodes.isEmpty {
                        timeline
                    } else if run.thinkingText?.isEmpty != false {
                        Text(emptyProcessMessage)
                            .font(.system(size: 12.5))
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                .padding(.top, 13)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            actions
                .padding(.top, 12)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8)
        }
        .id("run:\(run.id)")
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(run.nodes.enumerated()), id: \.element.id) { index, node in
                HStack(alignment: .top, spacing: 11) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(node.isRunning ? StudyPalette.accent : StudyPalette.paperEdge)
                            .frame(width: 7, height: 7)
                            .padding(.top, 5)
                        if index < run.nodes.count - 1 {
                            Rectangle()
                                .fill(StudyPalette.paperEdge.opacity(0.5))
                                .frame(width: 1)
                                .frame(maxHeight: .infinity)
                        }
                    }
                    .frame(width: 9)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(node.label)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(StudyPalette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 4)
                            if node.id.hasPrefix("tool:") {
                                Text(node.isRunning && !run.isActive ? "结果待核对" : node.statusLabel)
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(StudyPalette.muted)
                            }
                        }
                        if let summary = node.summary, !summary.isEmpty {
                            Text(summary)
                                .font(.system(size: 12))
                                .lineSpacing(3)
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
                    .padding(.bottom, index < run.nodes.count - 1 ? 14 : 0)
                }
            }
        }
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
