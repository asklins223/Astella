import SwiftUI
import UIKit

struct MessageRow: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 15
    var message: CompanionMessage
    var maxBubbleWidth: CGFloat = 320
    var onOpenNote: ((String) -> Void)? = nil
    var showsAvatar: Bool = true
    var showsBodyLabel: Bool = false
    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if !isUser && showsAvatar {
                Image("CompanionAvatar")
                    .resizable()
                    .scaledToFill()
                    .frame(width: 26, height: 26)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 0.7))
                    .accessibilityHidden(true)
                    .padding(.top, 3)
            } else if isUser {
                Spacer(minLength: 38)
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 0) {
                if !isUser && showsBodyLabel {
                    HStack(spacing: 5) {
                        Text("正文")
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(0.9)
                            .foregroundStyle(StudyPalette.muted)
                        AstellaGlyph(kind: .checkmark, tint: StudyPalette.success)
                            .frame(width: 10, height: 10)
                        Text("已写完")
                            .font(.system(size: 9))
                            .foregroundStyle(StudyPalette.success)
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, 3)
                    .padding(.bottom, 5)
                }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
                    ForEach(Array(message.blocks.enumerated()), id: \.offset) { index, block in
                        if block.type == "image", let url = block.url {
                            AuthenticatedCompanionImage(url: url, label: block.alt ?? block.label ?? "对话图片")
                        }
                        if block.type == "file" {
                            astellaLabel(block.name ?? "文件附件", glyph: .document)
                                .font(.system(size: 13, weight: .medium))
                                .padding(.horizontal, 12)
                                .frame(minHeight: 42)
                                .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        if let proposalId = block.proposalId { CompanionProposalCard(proposalId: proposalId) }
                        if let note = block.noteTarget {
                            Button("预览《\(note.title)》") { var target = note; target.runId = message.runId; store.resultPreview = target }
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(StudyPalette.accent)
                                .padding(.horizontal, 11)
                                .frame(minHeight: 32)
                                .background(StudyPalette.sky, in: Capsule())
                                .buttonStyle(AstellaPressStyle())
                        }
                        if ["diagram", "card", "citation", "code", "quote"].contains(block.type) {
                            CompanionRichBlock(block: block, identity: "\(message.id):\(index):\(block.type)", runId: message.runId)
                        }
                        if !["file", "quote"].contains(block.type), let text = block.text, !text.isEmpty {
                            if isUser {
                                Text(AttributedString(text))
                                    .font(.system(size: bodyPointSize))
                                    .lineSpacing(7)
                                    .foregroundStyle(.white)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else {
                                CompanionMarkdownText(text: text, onOpenNote: onOpenNote)
                                    .font(.system(size: bodyPointSize))
                                    .lineSpacing(7)
                                    .foregroundStyle(StudyPalette.ink)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(maxWidth: maxBubbleWidth, alignment: .leading)
                .background {
                    if isUser {
                        UnevenRoundedRectangle(
                            topLeadingRadius: 20,
                            bottomLeadingRadius: 20,
                            bottomTrailingRadius: 6,
                            topTrailingRadius: 20,
                            style: .continuous
                        )
                        .fill(LinearGradient(
                            colors: [Color(red: 0.42, green: 0.59, blue: 0.93), Color(red: 0.25, green: 0.45, blue: 0.86)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ))
                        .shadow(color: StudyPalette.accent.opacity(0.12), radius: 10, x: 0, y: 4)
                    } else {
                        UnevenRoundedRectangle(
                            topLeadingRadius: 20,
                            bottomLeadingRadius: 7,
                            bottomTrailingRadius: 20,
                            topTrailingRadius: 20,
                            style: .continuous
                        )
                        .fill(StudyPalette.paper.opacity(0.86))
                        .overlay(
                            UnevenRoundedRectangle(
                                topLeadingRadius: 20,
                                bottomLeadingRadius: 7,
                                bottomTrailingRadius: 20,
                                topTrailingRadius: 20,
                                style: .continuous
                            )
                            .stroke(.white.opacity(0.86), lineWidth: 0.8)
                        )
                        .shadow(color: StudyPalette.ink.opacity(0.04), radius: 8, x: 0, y: 3)
                    }
                }
                .textSelection(.enabled)

                Text(messageTimeLabel)
                    .font(.system(size: 9.5, weight: .medium))
                    .tracking(0.4)
                    .foregroundStyle(StudyPalette.muted.opacity(0.72))
                    .frame(maxWidth: maxBubbleWidth, alignment: isUser ? .trailing : .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 5)
            }

            if !isUser { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .contextMenu {
            Button { UIPasteboard.general.string = message.displayText } label: { astellaLabel("复制", glyph: .copy) }
            if message.role == "assistant" {
                Button { store.voicePlayback.play(message.displayText, store: store) } label: { astellaLabel("朗读", glyph: .speaker) }
            }
        }
    }

    private var messageTimeLabel: String {
        guard let date = messageDate else { return "" }
        if abs(Date().timeIntervalSince(date)) < 90 { return "刚刚" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M月d日 HH:mm"
        return formatter.string(from: date)
    }

    var messageDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: message.createdAt) ?? ISO8601DateFormatter().date(from: message.createdAt)
    }
}

private struct AuthenticatedCompanionImage: View {
    @Environment(AppStore.self) private var store
    let url: String
    let label: String
    @State private var data: Data?
    @State private var failure: String?
    @State private var attempt = 0
    @State private var opened = false

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Button { opened = true } label: { Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous)) }.buttonStyle(.plain)
                    .accessibilityLabel("预览图片：\(label)")
            } else if let failure {
                VStack(alignment: .leading, spacing: 6) {
                    Text(failure).font(.system(size: 12.5))
                    Button("重新读取图片") { attempt += 1 }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(StudyPalette.accent)
                }
            } else {
                astellaLabel(label, glyph: .photo)
                    .font(.system(size: 12.5))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.vertical, 8)
            }
        }
        .task(id: "\(url):\(attempt)") {
            failure = nil
            do {
                let received = try await store.api.imageData(url)
                guard !Task.isCancelled else { return }
                guard UIImage(data: received) != nil else { throw URLError(.cannotDecodeContentData) }
                data = received
            } catch { if !Task.isCancelled { failure = "图片暂时无法读取，请检查连接后重试。" } }
        }
        .fullScreenCover(isPresented: $opened) {
            if let data, let image = UIImage(data: data) { CompanionImageReader(image: image, title: label) }
        }
        .accessibilityLabel(label)
    }
}

private struct CompanionContentSnapshot: Identifiable { var id: String; var block: CompanionBlock; var readSource = false }
private struct CompanionRichBlock: View {
    @Environment(AppStore.self) private var store
    var block: CompanionBlock
    var identity: String
    var runId: String?
    @State private var opened: CompanionContentSnapshot?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CompanionRichContent(block: block)
            if let source = block.sourceRef {
                if source.kind == "note", let noteId = source.noteId {
                    Button("预览引用的笔记原文") { store.resultPreview = .init(noteId: noteId, noteVersionId: source.noteVersionId, title: block.label ?? "引用原文", runId: runId, blockOrdinal: source.blockOrdinal) }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(StudyPalette.accent)
                } else if source.kind == "source", source.sourceId != nil {
                    Button("预览来源全文") { opened = .init(id: identity + ":source", block: block, readSource: true) }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(StudyPalette.accent)
                }
            }
            if block.type != "citation" {
                Button("展开预览") { opened = .init(id: identity, block: block) }
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(StudyPalette.accent)
            }
        }
        .sheet(item: $opened) { snapshot in
            CompanionContentReader(snapshot: snapshot, runId: runId)
        }
    }
}

private struct CompanionRichContent: View {
    @Environment(AppStore.self) private var store
    var block: CompanionBlock
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if block.type == "diagram" {
                Text(block.title ?? "步骤流程").font(.system(size: 14, weight: .semibold))
                ForEach(Array(block.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)")
                            .font(.system(size: 11, weight: .semibold).monospacedDigit())
                            .foregroundStyle(StudyPalette.accent)
                            .frame(width: 22, height: 22)
                            .background(StudyPalette.sky, in: Circle())
                        VStack(alignment: .leading, spacing: 4) {
                            Text(step.label).font(.system(size: 13, weight: .medium))
                            if let detail = step.detail { CompanionMarkdownText(text: detail, onOpenNote: { store.requestNoteReference($0) }).font(.system(size: 12.5)).foregroundStyle(StudyPalette.muted) }
                        }
                    }
                }
            } else if block.type == "card" {
                Text("保存的题面").font(.system(size: 10.5, weight: .semibold)).tracking(0.6).foregroundStyle(StudyPalette.muted)
                CompanionMarkdownText(text: block.front ?? "这份记录没有保留题面。", onOpenNote: { store.requestNoteReference($0) })
                if let summary = block.summary, !summary.isEmpty { CompanionMarkdownText(text: summary, onOpenNote: { store.requestNoteReference($0) }).foregroundStyle(StudyPalette.muted) }
            } else if block.type == "quote" {
                Text(block.label ?? "引用原文").font(.system(size: 10.5, weight: .semibold)).tracking(0.6).foregroundStyle(StudyPalette.muted)
                CompanionMarkdownText(text: block.text ?? "", onOpenNote: { store.requestNoteReference($0) })
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(StudyPalette.accent.opacity(0.35)).frame(width: 2) }
            } else if let citation = block.citation {
                if citation.kind == "external_https", let href = citation.href, let url = URL(string: href), url.scheme == "https" {
                    Link(destination: url) {
                        HStack(spacing: 6) {
                            AstellaGlyph(kind: .document, tint: StudyPalette.accent).frame(width: 13, height: 13)
                            Text(block.label ?? "查看来源").font(.system(size: 12.5, weight: .medium))
                        }
                        .foregroundStyle(StudyPalette.accent)
                    }
                } else {
                    Text(block.label ?? "来源").font(.system(size: 13, weight: .medium))
                    Text("这份来源需要在书房中定位：\(citation.entityRef ?? "标识暂缺")")
                        .font(.system(size: 12))
                        .foregroundStyle(StudyPalette.muted)
                }
            } else if let code = block.code {
                ScrollView(.horizontal) { Text(code).font(.system(size: 12, design: .monospaced)).padding(12) }
                    .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 10))
            }
        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }
}

private struct CompanionContentReader: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var snapshot: CompanionContentSnapshot
    var runId: String?
    @State private var position = ScrollPosition(edge: .top)
    @State private var readingOffset: CGFloat = 0
    @State private var restored = false
    @State private var source: [(ordinal: Int, text: String)]?
    @State private var failure: String?
    @State private var attempt = 0
    var body: some View {
        NavigationStack {
            ScrollView {
                if snapshot.readSource {
                    if let source { VStack(alignment: .leading, spacing: 16) {
                        if source.isEmpty { Text("这份来源暂时没有可阅读的正文，原摘录仍在手记中。") }
                        ForEach(source, id: \.ordinal) { segment in CompanionMarkdownText(text: segment.text, onOpenNote: { store.requestNoteReference($0) }).textSelection(.enabled).id(segment.ordinal) }
                    }.padding(24).frame(maxWidth: 680, alignment: .leading) }
                    else if let failure { VStack { Text(failure); Button("重新读取来源") { attempt += 1 }.tint(.blue) }.padding(24) }
                    else { ProgressView("正在读取来源全文…").padding(24) }
                } else { CompanionRichContent(block: snapshot.block).padding(24).frame(maxWidth: 680) }
            }
                .scrollPosition($position)
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in readingOffset = offset }
                .onChange(of: source?.count, initial: true) { _, _ in
                    guard !restored, !snapshot.readSource || source != nil else { return }
                    if let saved = store.resultPreviewOffsets[snapshot.id] { position.scrollTo(y: saved) }
                    else if snapshot.readSource, let ordinal = snapshot.block.sourceRef?.segmentOrdinal { position.scrollTo(id: ordinal, anchor: .top) }
                    restored = true
                }
                .onDisappear { if !snapshot.readSource || source != nil { store.resultPreviewOffsets[snapshot.id] = readingOffset } }
                .task(id: attempt) {
                    guard snapshot.readSource, let sourceId = snapshot.block.sourceRef?.sourceId else { return }
                    let session = store.api.token, workspace = store.profile?.workspaceId
                    failure = nil
                    do {
                        let response = try await store.api.request("/sources/\(sourceId)") as? [String: Any] ?? [:]
                        guard !Task.isCancelled, session == store.api.token, workspace == store.profile?.workspaceId else { return }
                        guard let segments = response["segments"] as? [[String: Any]] else { throw URLError(.cannotParseResponse) }
                        source = segments.compactMap { segment in guard let ordinal = segment["ordinal"] as? Int, let text = segment["text"] as? String else { return nil }; return (ordinal, text) }
                    } catch { if !Task.isCancelled { failure = "来源暂时无法读取，可能已删除、权限变化或连接中断。" } }
                }
                .navigationTitle(snapshot.block.title ?? snapshot.block.label ?? "内容预览").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
                .safeAreaInset(edge: .bottom) { if let runId { Button("查看这次完整记录") { dismiss(); store.showRunInJournal(runId) }.tint(.blue).padding().frame(maxWidth: .infinity).background(.bar) } }
        }
    }
}

private struct CompanionImageReader: View {
    @Environment(\.dismiss) private var dismiss
    var image: UIImage
    var title: String
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) { Image(uiImage: image).resizable().scaledToFit().frame(width: geometry.size.width * scale).accessibilityLabel(title) }
                    .gesture(MagnifyGesture().onChanged { scale = min(5, max(1, baseScale * $0.magnification)) }.onEnded { _ in baseScale = scale })
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }; ToolbarItem(placement: .primaryAction) { Button("还原") { scale = 1; baseScale = 1 } } }
        }
    }
}

private func astellaLabel(_ title: String, glyph: AstellaGlyphKind) -> some View {
    Label {
        Text(title)
    } icon: {
        AstellaGlyph(kind: glyph, tint: StudyPalette.muted).frame(width: 16, height: 16)
    }
}
