import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct NotesScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var query = ""
    @State private var showImportPicker = false
    @State private var showExportExporter = false
    @State private var exportDocument: StudyWorkspaceExportDocument?
    @State private var exportError: String?
    @State private var showExportError = false
    @State private var isPreparingExport = false
    @State private var showProcessingStatus = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("YOUR LITTLE UNIVERSE")
                            .font(.system(size: horizontalSizeClass == .compact ? 8 : 10, weight: .semibold))
                            .tracking(horizontalSizeClass == .compact ? 1.25 : 1.7)
                            .foregroundStyle(StudyPalette.muted)
                            .padding(.bottom, 23)
                        Text("书房")
                            .font(.system(size: 37, weight: .semibold))
                            .tracking(-1.8)
                            .foregroundStyle(StudyPalette.ink)
                            .padding(.bottom, 16)
                        Text("已经留下的，随时回来读。")
                            .font(.system(size: 12))
                            .foregroundStyle(StudyPalette.muted)
                    }
                    Spacer(minLength: 0)
                    HStack(spacing: 9) {
                        Button {
                            Task { await prepareWorkspaceExport() }
                        } label: {
                            Group {
                                if isPreparingExport { ProgressView().tint(StudyPalette.accent) }
                                else { AstellaGlyph(kind: .download, tint: StudyPalette.ink) }
                            }
                                .frame(width: 18, height: 18)
                                .frame(width: 40, height: 40)
                                .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))
                        }
                        .buttonStyle(AstellaPressStyle())
                        .disabled(isPreparingExport)
                        .accessibilityLabel("导出整个书房备份")
                        Button { showImportPicker = true } label: {
                            AstellaGlyph(kind: .add, tint: .white)
                                .frame(width: 18, height: 18)
                                .frame(width: 40, height: 40)
                                .background(LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
                                .overlay(Circle().stroke(.white.opacity(0.48), lineWidth: 1))
                                .shadow(color: StudyPalette.accent.opacity(0.22), radius: 9, x: 0, y: 4)
                        }
                        .buttonStyle(AstellaPressStyle())
                        .accessibilityLabel("导入材料")
                    }
                    .padding(.top, 1)
                }
                    .padding(.leading, 7)
                    .padding(.trailing, 4)
                    .padding(.bottom, horizontalSizeClass == .compact ? 24 : 20)

                workspaceBar
                    .padding(.horizontal, 4)
                    .padding(.bottom, 12)

                HStack(spacing: 10) {
                    AstellaGlyph(kind: .search, tint: StudyPalette.muted).frame(width: 18, height: 18)
                    TextField("找手记、图片或一句话", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            AstellaGlyph(kind: .close, tint: StudyPalette.muted).frame(width: 15, height: 15)
                        }
                        .accessibilityLabel("清除搜索")
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 46)
                .modifier(StudyGlassSurfaceStyle(radius: 16, interactive: false))
                .padding(.horizontal, 2)
                .padding(.bottom, 14)

                if let file = store.selectedFile {
                    HStack(spacing: 10) {
                        AstellaGlyph(kind: .document, tint: StudyPalette.accent).frame(width: 19, height: 19)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(file.name).font(.footnote.weight(.medium)).lineLimit(1).foregroundStyle(StudyPalette.ink)
                            Text("导入到当前书房").font(.caption2).foregroundStyle(StudyPalette.muted)
                        }
                        Spacer(minLength: 0)
                        Button(store.isSending ? "正在导入" : "存为手记") {
                            Task { await store.importPreparedFile() }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StudyPalette.accent)
                        .disabled(store.isSending)
                        Button { store.selectedFile = nil } label: {
                            AstellaGlyph(kind: .close, tint: StudyPalette.muted).frame(width: 14, height: 14)
                                .frame(width: 28, height: 32)
                        }
                        .accessibilityLabel("移除已选材料")
                    }
                    .padding(12)
                    .modifier(StudyGlassSurfaceStyle(radius: 17, interactive: true))
                    .padding(.bottom, 12)
                }

                if let error = store.notesErrorMessage {
                    NoticeSurface {
                        VStack(alignment: .leading, spacing: 8) {
                            astellaLabel("手记暂时没有接回来", glyph: .alert)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(StudyPalette.ink)
                            Text(error).font(.footnote).foregroundStyle(StudyPalette.muted)
                            Button("重新加载") { Task { await store.loadNotes(query: query) } }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(StudyPalette.accent)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.bottom, 12)
                }

                if store.isLoading && store.notes.isEmpty {
                    ProgressView("正在接回手记…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 30)
                } else if store.notes.isEmpty && store.notesErrorMessage == nil {
                    VStack(alignment: .leading, spacing: 12) {
                        AstellaGlyph(kind: query.isEmpty ? .book : .search, tint: StudyPalette.accent).frame(width: 23, height: 23)
                            .frame(width: 54, height: 54)
                            .background(StudyPalette.sky, in: Circle())
                        Text(query.isEmpty ? "书架还空着" : "没有找到这篇手记")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text(query.isEmpty ? "和伴星聊出的学习成果，可以整理成手记，之后随时回来继续。" : "试试更短的关键词，或检查一下拼写。")
                            .font(.subheadline)
                            .lineSpacing(3)
                            .foregroundStyle(StudyPalette.muted)
                        if query.isEmpty {
                            Button { store.selectedTab = .conversation } label: {
                                astellaLabel("去对话里开始", glyph: .send)
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.top, 3)
                        }
                    }
                    .padding(.top, 22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        Text(store.profile?.workspaceName ?? "我的书房")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(StudyPalette.muted)
                        Spacer()
                        Text(query.isEmpty ? "按最近更新" : "搜索结果")
                            .font(.system(size: 10))
                            .foregroundStyle(StudyPalette.muted.opacity(0.82))
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 4)

                    LazyVStack(spacing: 0) {
                        ForEach(Array(store.notes.enumerated()), id: \.element.id) { index, note in
                            NavigationLink(value: note.id) {
                                NoteShelfRow(note: note, paletteIndex: index)
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                if store.notes.suffix(3).contains(where: { $0.id == note.id }) {
                                    Task { await store.loadMoreNotes(query: query) }
                                }
                            }
                            if index < store.notes.count - 1 {
                                Divider().overlay(StudyPalette.paperEdge.opacity(0.72))
                            }
                        }
                        if store.isLoadingMoreNotes {
                            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 14)
                        }
                    }

                    Button { showProcessingStatus = true } label: {
                        HStack(spacing: 8) {
                            AstellaGlyph(kind: .info, tint: StudyPalette.muted).frame(width: 13, height: 13)
                            Text("资料与处理状态").font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(StudyPalette.muted.opacity(0.85))
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(StudyPalette.paper.opacity(0.42), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(.white.opacity(0.55), lineWidth: 0.8))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .padding(.top, 22)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, horizontalSizeClass == .compact ? 10 : 12)
            .padding(.bottom, 128)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .refreshable { await store.loadNotes(query: query) }
        .fileImporter(
            isPresented: $showImportPicker,
            allowedContentTypes: [.plainText, .pdf, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "docx") ?? .data]
        ) { result in
            if case .success(let url) = result { Task { await store.prepareFile(url) } }
            if case .failure(let error) = result { store.errorMessage = error.localizedDescription }
        }
        .fileExporter(
            isPresented: $showExportExporter,
            document: exportDocument,
            contentType: .json,
            defaultFilename: exportFileName
        ) { result in
            if case .failure(let error) = result {
                exportError = "书房备份没有保存：\(error.localizedDescription)"
                showExportError = true
            }
            exportDocument = nil
        }
        .alert("导出没有完成", isPresented: $showExportError) {
            Button("好", role: .cancel) { }
        } message: {
            Text(exportError ?? "请稍后重试。")
        }
        .navigationDestination(for: String.self) { id in
            NoteDetailScreen(noteId: id)
        }
        .navigationDestination(for: NoteFeatureRoute.self) { route in
            NoteFeatureScreen(route: route)
        }
        .sheet(isPresented: $showProcessingStatus) {
            ProcessingStatusSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .task(id: query) {
            #if DEBUG
            if store.uiReviewMode != nil { return }
            #endif
            try? await Task.sleep(for: .milliseconds(260))
            guard !Task.isCancelled else { return }
            await store.loadNotes(query: query)
        }
        .task {
            if store.notes.isEmpty { await store.loadNotes() }
        }
    }

    private var noteListSummary: String {
        if store.isLoading && store.notes.isEmpty { return "正在接回手记…" }
        let count = store.notes.count
        if !query.isEmpty { return "\(count) 篇搜索结果" }
        return "\(count)\(store.notesNextCursor == nil ? "" : "+") 篇 · 最近更新在前"
    }

    private var exportFileName: String {
        let name = store.profile?.workspaceName ?? "Astella"
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return "\(safe)-书房备份"
    }

    private func prepareWorkspaceExport() async {
        guard store.profile?.isPersonalWorkspace == true || store.workspaces.first(where: { $0.id == store.profile?.workspaceId })?.role == "owner" else {
            exportError = "只有书房拥有者可以导出整间书房。"
            showExportError = true
            return
        }
        isPreparingExport = true
        defer { isPreparingExport = false }
        do {
            let payload = try await store.api.request("/export/workspace")
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            exportDocument = StudyWorkspaceExportDocument(data: data)
            showExportExporter = true
        } catch {
            exportError = "书房备份没有生成：\(error.localizedDescription)"
            showExportError = true
        }
    }

    private var workspaceBar: some View {
        Menu {
            ForEach(store.workspaces) { workspace in
                Button {
                    Task { await store.switchWorkspace(workspace) }
                } label: {
                    Label {
                        Text(workspace.name)
                    } icon: {
                        AstellaGlyph(kind: workspace.id == store.profile?.workspaceId ? .check : .library,
                                     tint: StudyPalette.accent).frame(width: 16, height: 16)
                    }
                }
            }
            if store.workspaces.isEmpty {
                Text(store.profile?.workspaceName ?? "我的书房")
            }
        } label: {
            HStack(spacing: 11) {
                AstellaGlyph(kind: .library, tint: StudyPalette.accent)
                    .frame(width: 20, height: 20)
                    .frame(width: 34, height: 34)
                    .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.profile?.workspaceName ?? "我的书房")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(StudyPalette.ink).lineLimit(1)
                    let kind = store.profile?.workspaceType == "shared" ? "协作空间" : "个人空间"
                    Text("\(kind) · \(store.notes.count) 篇")
                        .font(.system(size: 10)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("切换")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.accent)
                AstellaGlyph(kind: .chevron, tint: StudyPalette.accent).frame(width: 10, height: 10).rotationEffect(.degrees(90))
            }
            .padding(.horizontal, 13)
            .frame(height: horizontalSizeClass == .compact ? 60 : 56)
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .modifier(StudyGlassSurfaceStyle(radius: 18, interactive: true))
        }
        .buttonStyle(AstellaPressStyle())
        .disabled(store.isAccountBusy)
        .accessibilityLabel("当前书房：\(store.profile?.workspaceName ?? "我的书房")，切换书房")
    }
}

private struct StudyWorkspaceExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        data = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

struct NoteShelfRow: View {
    var note: NoteSummary
    var paletteIndex: Int = 0

    var body: some View {
        HStack(alignment: .top, spacing: 15) {
            NoteCover(title: note.title, seed: note.id, paletteIndex: paletteIndex)
                .frame(width: 35, height: 49)
                .offset(y: -3)
            VStack(alignment: .leading, spacing: 5) {
                Text("手记")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(1.1)
                    .foregroundStyle(StudyPalette.muted)
                Text(note.title)
                    .font(.system(size: 15.5, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                    .multilineTextAlignment(.leading)
                    .lineLimit(1)
                if let snippet = note.snippet, !snippet.isEmpty {
                    Text(snippet)
                        .font(.system(size: 12))
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(1)
                        .multilineTextAlignment(.leading)
                }
                Text("最近更新 · \(Self.dateLabel(note.updatedAt))")
                    .font(.system(size: 10))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.top, 11)
            }
            Spacer(minLength: 0)
            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.7)).frame(width: 14, height: 14).padding(.top, 4)
        }
        .padding(.horizontal, 6)
        .padding(.top, 18)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, minHeight: 127, alignment: .topLeading)
    }

    static func dateLabel(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return "刚刚" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

struct NoteCover: View {
    let title: String
    let seed: String
    var paletteIndex: Int? = nil
    var rotation: Double = 0
    private var coverCharacters: [String] { title.prefix(4).map(String.init) }
    private var palette: Color {
        let colors: [Color] = [
            Color(red: 0.40, green: 0.52, blue: 0.68),
            Color(red: 0.62, green: 0.58, blue: 0.48),
            Color(red: 0.37, green: 0.51, blue: 0.48),
            Color(red: 0.49, green: 0.47, blue: 0.61),
            Color(red: 0.38, green: 0.53, blue: 0.62),
        ]
        let value = seed.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fffffff }
        return colors[(paletteIndex ?? value) % colors.count]
    }
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(LinearGradient(colors: [palette.opacity(0.78), palette], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .stroke(.white.opacity(0.32), lineWidth: 0.7)
                    }
                    .overlay(alignment: .leading) {
                        Rectangle().fill(.white.opacity(0.3)).frame(width: 2)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .stroke(.white.opacity(0.22), lineWidth: 0.55)
                            .padding(4)
                    }
                    .shadow(color: StudyPalette.ink.opacity(0.13), radius: 5, x: 2, y: 4)
                VStack(spacing: -1) {
                    ForEach(coverCharacters.indices, id: \.self) { index in
                        Text(coverCharacters[index])
                            .font(.system(size: min(10, proxy.size.width * 0.28), weight: .regular, design: .serif))
                            .foregroundStyle(.white.opacity(0.92))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.vertical, 5)
                .allowsHitTesting(false)
            }
            .rotationEffect(.degrees(rotation))
        }
        .accessibilityHidden(true)
    }
}

struct NoteDetailScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @ScaledMetric(relativeTo: .largeTitle) private var readerTitleSize: CGFloat = 39
    @ScaledMetric(relativeTo: .body) private var readerBodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .title3) private var readerHeadingSize: CGFloat = 22
    var noteId: String
    @State private var selectedAnnotationBlock: NoteBlock?
    @State private var pendingAnnotationRemoval: NoteAnnotation?
    @State private var confirmsAnnotationRemoval = false
    @State private var showSelection = false
    @State private var selectionOriginal = ""
    @State private var selectionBaseline = Set<String>()
    @State private var readingBlockOrdinal: Int?
    @State private var didRestoreReadingPosition = false

    /// The reader renders the user's chosen point size directly: the preference
    /// slider expresses points (16 is the reference scale), matching the mockup's
    /// 19pt default body instead of double-scaling a 17pt base.
    private var bodySize: CGFloat { readerBodySize * store.readingScale }
    private var summary: NoteSummary? { store.notes.first(where: { $0.id == noteId }) }
    private var inkColor: UIColor { UIColor(StudyPalette.ink) }
    private var mutedColor: UIColor { UIColor(StudyPalette.muted) }

    var body: some View {
        ScrollView {
            if let document = store.noteDocument, document.id == noteId {
                VStack(alignment: .leading, spacing: 0) {
                    metadataEyebrow(document)
                    Text(document.title)
                        .font(StudySerif.font(size: readerTitleSize))
                        .tracking(3)
                        .foregroundStyle(StudyPalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 16)
                    if let subtitle = summary?.snippet?.trimmingCharacters(in: .whitespacesAndNewlines), !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 13))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 11)
                    }
                    versionRow(document)
                        .padding(.top, 24)
                    VStack(alignment: .leading, spacing: 22) {
                        ForEach(document.blocks) { block in
                            readerBlock(block, document: document)
                                .id(block.id)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contextMenu {
                                    if ["paragraph", "heading", "quote", "code", "list"].contains(block.type) {
                                        Button {
                                            store.clearAnnotationNotice()
                                            selectedAnnotationBlock = block
                                        } label: { astellaLabel("给这一段留批注", glyph: .quote) }
                                        Button {
                                            guard let anchor = NoteAnnotationAnchor.wholeBlock(block, versionId: document.versionId) else {
                                                store.annotationErrorMessage = "这段内容暂时无法精确对应到手记原文。"
                                                return
                                            }
                                            Task { await store.explainNoteAnnotation(noteId: noteId, anchor: anchor) }
                                        } label: { astellaLabel("请伴星讲解", glyph: .companion) }
                                    }
                                }
                        }
                    }
                    .padding(.top, 26)
                    .scrollTargetLayout()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    annotationSection
                    if let error = store.annotationErrorMessage {
                        astellaLabel(error, glyph: .alert)
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.danger)
                            .padding(.top, 16)
                        Button("重新读取批注") { Task { await store.loadNoteAnnotations(noteId) } }
                            .font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    } else if let status = store.annotationStatus {
                        astellaLabel(status, glyph: .check)
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.success)
                            .padding(.top, 16)
                    }
                }
                .padding(.horizontal, 26)
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 40)
                .opacity(didRestoreReadingPosition ? 1 : 0)
            } else if let error = store.noteErrorMessage {
                ContentUnavailableView {
                    VStack(alignment: .leading, spacing: 8) {
                        AstellaGlyph(kind: .book, tint: StudyPalette.muted).frame(width: 24, height: 24)
                        Text("这篇手记暂时打不开").font(.headline)
                        Text(error).font(.subheadline).foregroundStyle(StudyPalette.muted)
                    }
                } actions: {
                    Button("重新加载") { Task { await store.loadNote(noteId) } }
                        .modifier(PrimaryActionStyle())
                }
                .padding(.top, 60)
            } else {
                ProgressView("正在打开手记…")
                    .frame(maxWidth: .infinity, minHeight: 240)
            }
        }
        .scrollIndicators(.hidden)
        .scrollPosition(id: $readingBlockOrdinal, anchor: .top)
        .onChange(of: readingBlockOrdinal) { _, ordinal in
            guard didRestoreReadingPosition,
                  let ordinal,
                  store.noteDocument?.id == noteId else { return }
            store.saveNoteReadingBlock(ordinal, noteId: noteId)
        }
        .onChange(of: store.noteDocument?.versionId) { _, _ in
            guard let document = store.noteDocument, document.id == noteId else { return }
            restoreReadingPosition(for: document)
        }
        .background(DawnBackground())
        .toolbar(.hidden, for: .tabBar)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            if let document = store.noteDocument, document.id == noteId {
                readerHeader(document)
            } else {
                readerHeaderPlaceholder
            }
        }
        .task(id: noteId) {
            didRestoreReadingPosition = false
            readingBlockOrdinal = nil
            store.visibleNoteId = noteId
            #if DEBUG
            if store.uiReviewMode != nil {
                didRestoreReadingPosition = true
                return
            }
            #endif
            await store.loadNote(noteId)
            if let document = store.noteDocument, document.id == noteId {
                restoreReadingPosition(for: document)
            }
            await store.reportAwareness(topic: "page.arrived", foreground: true)
        }
        .onDisappear {
            if let readingBlockOrdinal, store.noteDocument?.id == noteId {
                store.saveNoteReadingBlock(readingBlockOrdinal, noteId: noteId)
            }
            if store.visibleNoteId == noteId { store.visibleNoteId = nil }
        }
        .sheet(isPresented: $showSelection, onDismiss: {
            didRestoreReadingPosition = false
            Task { await store.loadNote(noteId) }
        }) {
            CompanionSelectionSheet(original: selectionOriginal, baseline: selectionBaseline)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .sheet(item: $selectedAnnotationBlock) { block in
            if let document = store.noteDocument, let anchor = NoteAnnotationAnchor.wholeBlock(block, versionId: document.versionId) {
                NoteAnnotationComposer(noteId: noteId, anchor: anchor)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
        .confirmationDialog("撤下这条批注？", isPresented: $confirmsAnnotationRemoval, titleVisibility: .visible) {
            Button("撤下批注与讲解", role: .destructive) {
                if let annotation = pendingAnnotationRemoval {
                    Task { await store.removeNoteAnnotation(noteId: noteId, annotation: annotation) }
                }
            }
            Button("保留", role: .cancel) { pendingAnnotationRemoval = nil }
        } message: {
            Text("已生成的原文讲解也会一并移除；对话记录不会删除。")
        }
    }

    // MARK: - Reader chrome

    /// The mockup reader floats a back circle, a centred version caption and a
    /// typography / tools pill over the paper. Native navigation and materials are
    /// kept; only the measured geometry and hierarchy follow the reference.
    private func readerHeader(_ document: NoteDocument) -> some View {
        ZStack {
            Text("第 \(document.versionNumber) 版 · 一起读")
                .font(.system(size: 12, weight: .medium))
                .tracking(0.2)
                .foregroundStyle(StudyPalette.muted)
                .lineLimit(1)
                .accessibilityHidden(true)
            HStack(spacing: 10) {
                Button {
                    dismiss()
                } label: {
                    AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                        .frame(width: 19, height: 19)
                        .frame(width: 44, height: 44)
                        .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("返回书房")

                Spacer(minLength: 72)

                HStack(spacing: 0) {
                    NavigationLink(value: AccountScreenRoute.readingSettings) {
                        Text("T")
                            .font(.system(size: 18, weight: .medium, design: .serif))
                            .foregroundStyle(StudyPalette.ink)
                            .frame(width: 48, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityLabel("阅读与显示设置")

                    Rectangle()
                        .fill(StudyPalette.paperEdge.opacity(0.66))
                        .frame(width: 0.7, height: 19)
                        .accessibilityHidden(true)

                    Menu {
                        ForEach(NoteFeatureKind.allCases, id: \.self) { kind in
                            NavigationLink(value: NoteFeatureRoute(noteId: noteId, kind: kind)) {
                                Label(kind.title, systemImage: readerFeatureSymbol(kind))
                            }
                        }
                        Divider()
                        Button {
                            store.continueWithNote(document)
                        } label: {
                            Label("在对话里继续提问", systemImage: "bubble.left.and.text.bubble.right")
                        }
                    } label: {
                        AstellaGlyph(kind: .settings, tint: StudyPalette.ink)
                            .frame(width: 19, height: 19)
                            .frame(width: 48, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("手记工具")
                }
                .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .frame(height: 64)
    }

    private var readerHeaderPlaceholder: some View {
        ZStack {
            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                        .frame(width: 19, height: 19)
                        .frame(width: 44, height: 44)
                        .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("返回书房")
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .frame(height: 64)
    }

    private func readerFeatureSymbol(_ kind: NoteFeatureKind) -> String {
        switch kind {
        case .overview: "doc.text.magnifyingglass"
        case .mindMap: "point.3.connected.trianglepath.dotted"
        case .explain: "text.bubble"
        case .versions: "clock.arrow.circlepath"
        }
    }

    // MARK: - Reader content

    private func metadataEyebrow(_ document: NoteDocument) -> some View {
        HStack(spacing: 7) {
            AstellaGlyph(kind: .library, tint: StudyPalette.accent)
                .frame(width: 13, height: 13)
            Text(metadataLine(document))
                .font(.system(size: 11.5, weight: .medium))
                .tracking(0.3)
                .foregroundStyle(StudyPalette.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
        }
    }

    private func metadataLine(_ document: NoteDocument) -> String {
        var parts: [String] = ["手记", "第 \(document.versionNumber) 版"]
        let space = store.profile?.isPersonalWorkspace == true
            ? "个人书房"
            : (store.profile?.workspaceName ?? "书房")
        parts.append(space)
        return parts.joined(separator: " · ")
    }

    private func versionRow(_ document: NoteDocument) -> some View {
        NavigationLink(value: NoteFeatureRoute(noteId: noteId, kind: .versions)) {
            HStack(spacing: 13) {
                AstellaGlyph(kind: .refresh, tint: StudyPalette.accent)
                    .frame(width: 17, height: 17)
                    .frame(width: 37, height: 37)
                    .background(StudyPalette.sky.opacity(0.72), in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text("第 \(document.versionNumber) 版")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text(versionDetail(document))
                        .font(.system(size: 11))
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.8))
                    .frame(width: 15, height: 15)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 68)
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("第 \(document.versionNumber) 版，查看版本记录")
    }

    private func versionDetail(_ document: NoteDocument) -> String {
        if let updated = summary?.updatedAt, !updated.isEmpty, let date = ISO8601DateFormatter().date(from: updated) {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "zh_CN")
            formatter.dateFormat = "M 月 d 日"
            return "最近更新 · \(formatter.string(from: date))"
        }
        return "\(document.blocks.count) 段 · 一起读"
    }

    @ViewBuilder
    private func readerBlock(_ block: NoteBlock, document: NoteDocument) -> some View {
        switch block.type {
        case "heading":
            Text(Self.headingText(block.content))
                .font(StudySerif.font(size: readerHeadingSize, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
        case "quote":
            CompanionSelectableText(
                text: Self.quoteText(block.content),
                fontSize: bodySize,
                style: CompanionTextStyle(
                    fontSize: bodySize,
                    serif: true,
                    firstLineIndent: 0,
                    lineSpacing: bodySize * 0.58,
                    paragraphSpacing: 0,
                    color: mutedColor
                ),
                onOpenNote: { store.requestNoteReference($0) }
            ) { selected, rewrite in
                beginSelection(selected, rewrite: rewrite, document: document)
            }
            .padding(.leading, 16)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(StudyPalette.accent.opacity(0.55))
                    .frame(width: 2.5)
            }
        case "paragraph":
            CompanionSelectableText(
                text: block.content,
                fontSize: bodySize,
                style: CompanionTextStyle(
                    fontSize: bodySize,
                    serif: true,
                    firstLineIndent: bodySize * 2,
                    lineSpacing: bodySize * 0.58,
                    paragraphSpacing: 0,
                    color: inkColor
                ),
                onOpenNote: { store.requestNoteReference($0) }
            ) { selected, rewrite in
                beginSelection(selected, rewrite: rewrite, document: document)
            }
        default:
            noteBlock(block)
        }
    }

    private func beginSelection(_ selected: String, rewrite: Bool, document: NoteDocument) {
        selectionOriginal = selected
        selectionBaseline = Set(store.messages.map(\.id))
        showSelection = true
        Task { await store.askAboutSelection(selected, document: document, rewrite: rewrite) }
    }

    @ViewBuilder
    private var annotationSection: some View {
        if !store.noteAnnotations.isEmpty {
            PaperSurface {
                VStack(alignment: .leading, spacing: 11) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("留在原文旁").font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                        Spacer()
                        Text("\(store.noteAnnotations.count) 条").font(.caption).foregroundStyle(StudyPalette.muted)
                    }
                    ForEach(store.noteAnnotations) { annotation in
                        Divider().overlay(StudyPalette.paperEdge)
                        Text("“\(annotation.anchor.excerpt)”")
                            .font(StudySerif.font(size: 15))
                            .foregroundStyle(StudyPalette.ink)
                            .lineLimit(5)
                        Text(annotation.explanation)
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.muted)
                        Text(annotation.versionState == "current" ? "对应当前版本" : "来自较早版本")
                            .font(.caption2.weight(.medium)).foregroundStyle(StudyPalette.muted)
                        HStack {
                            Button("再讲一次") {
                                Task { await store.explainNoteAnnotation(noteId: noteId, anchor: annotation.anchor) }
                            }
                            .disabled(store.isAnnotationBusy || annotation.versionState != "current")
                            Spacer()
                            Button("撤下", role: .destructive) {
                                pendingAnnotationRemoval = annotation
                                confirmsAnnotationRemoval = true
                            }
                            .disabled(store.isAnnotationBusy)
                        }
                        .font(.footnote.weight(.semibold))
                    }
                }
            }
            .padding(.top, 24)
        }
    }

    private func restoreReadingPosition(for document: NoteDocument) {
        guard !didRestoreReadingPosition else { return }
        let savedOrdinal = store.savedNoteReadingBlock(noteId: noteId)
        readingBlockOrdinal = savedOrdinal.flatMap { ordinal in
            document.blocks.contains(where: { $0.id == ordinal }) ? ordinal : nil
        }
        didRestoreReadingPosition = true
        store.recordNoteOpened(noteId)
    }

    @ViewBuilder
    private func noteBlock(_ block: NoteBlock) -> some View {
        switch block.type {
        case "heading":
            Text(Self.headingText(block.content))
                .font(StudySerif.font(size: readerHeadingSize, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
                .padding(.top, 8)
        case "quote":
            Text(Self.quoteText(block.content))
                .font(StudySerif.font(size: bodySize))
                .italic()
                .foregroundStyle(StudyPalette.muted)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(StudyPalette.accent.opacity(0.6))
                        .frame(width: 3)
                }
        case "code":
            ScrollView(.horizontal) {
                Text(block.content)
                    .font(.system(size: bodySize * 0.82, design: .monospaced))
                    .foregroundStyle(StudyPalette.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(14)
            }
            .scrollIndicators(.hidden)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.045), in: RoundedRectangle(cornerRadius: 13))
        case "image":
            NoteImageBlock(block: block)
        case "list":
            let lines = Self.listLines(block.content)
            let ordered = Self.isOrderedList(block.content)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(lines.indices, id: \.self) { index in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(.system(size: bodySize, weight: .semibold))
                            .foregroundStyle(StudyPalette.accent)
                        Text(lines[index])
                            .font(StudySerif.font(size: bodySize))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case "table":
            let rows = Self.tableRows(block.content)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows.indices, id: \.self) { rowIndex in
                    HStack(alignment: .top, spacing: 9) {
                        ForEach(rows[rowIndex].indices, id: \.self) { columnIndex in
                            Text(rows[rowIndex][columnIndex])
                                .font(.system(size: bodySize * 0.9, weight: rowIndex == 0 ? .semibold : .regular))
                                .foregroundStyle(rowIndex == 0 ? StudyPalette.ink : StudyPalette.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 9)
                    if rowIndex < rows.count - 1 { Divider().overlay(StudyPalette.paperEdge) }
                }
            }
            .padding(.horizontal, 11)
            .background(StudyPalette.inset.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        default:
            Text(block.content)
                .font(StudySerif.font(size: bodySize))
                .lineSpacing(bodySize * 0.58)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private static func headingText(_ content: String) -> String {
        content.replacingOccurrences(of: #"^\s*<h[1-6]\b[^>]*>|</h[1-6]>\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"^\s*#{1,6}\s+"#, with: "", options: .regularExpression)
    }

    private static func quoteText(_ content: String) -> String {
        content.replacingOccurrences(of: #"(?m)^\s*>\s?"#, with: "", options: .regularExpression)
    }

    private static func listLines(_ content: String) -> [String] {
        content.split(separator: "\n", omittingEmptySubsequences: true).map {
            String($0).replacingOccurrences(of: #"^\s*(?:[-+*]|\d+[.)])\s+"#, with: "", options: .regularExpression)
        }
    }

    private static func isOrderedList(_ content: String) -> Bool {
        content.split(separator: "\n", omittingEmptySubsequences: true).first.map {
            String($0).range(of: #"^\s*\d+[.)]\s+"#, options: .regularExpression) != nil
        } ?? false
    }

    private static func tableRows(_ content: String) -> [[String]] {
        content.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            let cells = line.split(separator: "|", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            var row = cells
            while row.first?.isEmpty == true { row.removeFirst() }
            while row.last?.isEmpty == true { row.removeLast() }
            guard !row.isEmpty, !row.allSatisfy({ $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil }) else { return nil }
            return row
        }
    }
}

private struct NoteAnnotationComposer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var noteId: String
    var anchor: NoteAnnotationAnchor
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    SectionEyebrow(text: "绑定到当前手记版本")
                    Text("这段原文")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text(anchor.excerpt)
                        .font(.body)
                        .lineSpacing(4)
                        .foregroundStyle(StudyPalette.ink)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Text("可以记下自己的理解，也可以请伴星把讲解贴回这段原文。")
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                    TextEditor(text: $draft)
                        .frame(minHeight: 110)
                        .scrollContentBackground(.hidden)
                        .padding(9)
                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty {
                                Text("记下你的理解、疑问或提醒")
                                    .font(.body)
                                    .foregroundStyle(StudyPalette.muted.opacity(0.75))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 17)
                                    .allowsHitTesting(false)
                            }
                        }
                    if let error = store.annotationErrorMessage {
                            astellaLabel(error, glyph: .alert)
                            .font(.footnote)
                            .foregroundStyle(StudyPalette.danger)
                    }
                    if store.isAnnotationBusy {
                        HStack(spacing: 9) {
                            ProgressView()
                            Text(store.annotationStatus ?? "正在保存或生成…")
                                .font(.footnote)
                                .foregroundStyle(StudyPalette.muted)
                        }
                    }
                    HStack(spacing: 10) {
                        Button {
                            Task { await store.explainNoteAnnotation(noteId: noteId, anchor: anchor) }
                        } label: {
                            astellaLabel("请伴星讲解", glyph: .companion).frame(maxWidth: .infinity)
                        }
                        .modifier(SecondaryActionStyle())
                        .disabled(store.isAnnotationBusy)
                        Button {
                            Task { await store.saveNoteAnnotation(noteId: noteId, anchor: anchor, explanation: draft) }
                        } label: {
                            Text("留下批注").frame(maxWidth: .infinity)
                        }
                        .modifier(PrimaryActionStyle())
                        .disabled(store.isAnnotationBusy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(20)
            }
            .background(DawnBackground())
            .navigationTitle("批注与讲解")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }.disabled(store.isAnnotationBusy)
                }
            }
            .interactiveDismissDisabled(store.isAnnotationBusy)
            .onChange(of: store.annotationStatus) { _, status in
                if status != nil { dismiss() }
            }
        }
    }
}

private struct NoteImageReference {
    var url: String
    var alt: String

    static func parse(_ content: String) -> NoteImageReference? {
        if let match = content.range(of: #"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)"#, options: .regularExpression) {
            let markup = String(content[match])
            let captures = try? NSRegularExpression(pattern: #"!\[([^\]]*)\]\(([^)\s]+)"#)
                .firstMatch(in: markup, range: NSRange(markup.startIndex..., in: markup))
            if let captures, let altRange = Range(captures.range(at: 1), in: markup), let urlRange = Range(captures.range(at: 2), in: markup) {
                return NoteImageReference(url: String(markup[urlRange]), alt: String(markup[altRange]))
            }
        }
        if let match = try? NSRegularExpression(pattern: #"<img\b[^>]*>"#, options: [.caseInsensitive]).firstMatch(in: content, range: NSRange(content.startIndex..., in: content)),
           let tagRange = Range(match.range, in: content) {
            let tag = String(content[tagRange])
            let source = attribute("src", in: tag)
            guard let source, !source.isEmpty else { return nil }
            return NoteImageReference(url: source, alt: attribute("alt", in: tag) ?? "")
        }
        return nil
    }

    private static func attribute(_ name: String, in tag: String) -> String? {
        let pattern = "\\b\(name)\\s*=\\s*([\\\"'])(.*?)\\1"
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
              let range = Range(match.range(at: 2), in: tag) else { return nil }
        return String(tag[range])
    }
}

private struct NoteImageBlock: View {
    @Environment(AppStore.self) private var store
    var block: NoteBlock
    @State private var imageData: Data?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var reference: NoteImageReference? { NoteImageReference.parse(block.content) }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Group {
                if let image = imageData.flatMap(UIImage.init(data:)) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 420)
                } else if isLoading {
                    ProgressView("正在打开图片…")
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
            astellaLabel(errorMessage ?? "图片暂时无法打开", glyph: .photo)
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                        .frame(maxWidth: .infinity, minHeight: 96)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            if let alt = reference?.alt, !alt.isEmpty {
                Text(alt).font(.caption).foregroundStyle(StudyPalette.muted)
            }
        }
        .padding(10)
        .background(StudyPalette.inset.opacity(0.75), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .task(id: reference?.url) {
            guard let address = reference?.url else {
                imageData = nil
                errorMessage = "图片地址无效。"
                return
            }
            isLoading = true
            defer { isLoading = false }
            do {
                imageData = try await store.api.imageData(address)
                errorMessage = nil
            } catch {
                imageData = nil
                errorMessage = error.localizedDescription
            }
        }
    }
}

enum NoteFeatureKind: String, Hashable, CaseIterable {
    case overview, mindMap, explain, versions

    var title: String {
        switch self {
        case .overview: "速览"
        case .mindMap: "脑图"
        case .explain: "讲解"
        case .versions: "版本"
        }
    }

    var glyph: AstellaGlyphKind {
        switch self {
        case .overview: .document
        case .mindMap: .mindMap
        case .explain: .play
        case .versions: .refresh
        }
    }
}

struct NoteFeatureRoute: Hashable {
    var noteId: String
    var kind: NoteFeatureKind
}

private struct NoteFeatureScreen: View {
    var route: NoteFeatureRoute

    @ViewBuilder
    var body: some View {
        Group { switch route.kind {
        case .overview: NoteOverviewScreen(noteId: route.noteId)
        case .mindMap: NoteMindMapScreen(noteId: route.noteId)
        case .explain: NoteExplainScreen(noteId: route.noteId)
        case .versions: NoteVersionsScreen(noteId: route.noteId)
        } }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "手记 · 学习") }
    }
}

private struct NoteVersionsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var noteId: String
    @State private var items: [[String: Any]] = []
    @State private var loading = false
    @State private var restoring = false
    @State private var failure: String?
    @State private var selected: [String: Any]?
    @State private var showRestore = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PageHeading(eyebrow: "保存轨迹", title: "版本记录", subtitle: "恢复会另存为新版本，原来的内容仍会保留。")
                if let failure { featureError(failure, retry: { Task { await load() } }) }
                if loading && items.isEmpty { ProgressView("正在读取版本…").frame(maxWidth: .infinity).padding(28) }
                else if items.isEmpty && failure == nil {
                    VStack(alignment: .leading, spacing: 9) {
                        AstellaGlyph(kind: .refresh, tint: StudyPalette.accent).frame(width: 23, height: 23)
                        Text("还没有版本记录").font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                        Text("这篇手记目前只有当前版本。").font(.subheadline).foregroundStyle(StudyPalette.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 18)
                } else {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, version in
                        versionRow(version)
                    }
                    if items.count == 1 {
                        HStack(alignment: .top, spacing: 13) {
                            VStack(spacing: 0) {
                                Circle().fill(StudyPalette.paperEdge).frame(width: 9, height: 9)
                                Rectangle().fill(StudyPalette.paperEdge.opacity(0.75)).frame(width: 1, height: 34)
                            }
                            .padding(.leading, StudySpacing.lg + 7)
                            .padding(.top, 5)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("接下来的保存")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(StudyPalette.ink)
                                Text("新版本会沿着这条轨迹追加，原来的内容仍会保留。")
                                    .font(.footnote)
                                    .lineSpacing(3)
                                    .foregroundStyle(StudyPalette.muted)
                            }
                            .padding(.top, 1)
                        }
                        .padding(.top, 1)
                    }
                }
            }
            .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 28)
        }
        .background(DawnBackground())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("恢复到第 \(selected?["versionNo"] as? Int ?? 1) 版？", isPresented: $showRestore, titleVisibility: .visible) {
            Button("恢复这一版", role: .destructive) { Task { await restoreSelected() } }
            Button("取消", role: .cancel) { selected = nil }
        } message: {
            Text("当前内容会作为新版本保存，之后仍可切回其他记录。")
        }
        .task { await load() }
    }

    @ViewBuilder
    private func versionRow(_ version: [String: Any]) -> some View {
        let current = version["id"] as? String == store.noteDocument?.versionId
        if current {
            PaperSurface(padding: StudySpacing.lg, radius: StudyRadius.xl) {
                VStack(alignment: .leading, spacing: 11) {
                    HStack(spacing: 11) {
                        AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 22, height: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("第 \(version["versionNo"] as? Int ?? 1) 版")
                                .font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                            Text(dateLabel(version["createdAt"] as? String))
                                .font(.caption).foregroundStyle(StudyPalette.muted)
                        }
                        Spacer()
                        Text("当前")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudyPalette.accent)
                    }
                    if let document = store.noteDocument, document.id == noteId,
                       let excerpt = document.blocks.first(where: { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.type != "image" })?.content {
                        Divider().overlay(StudyPalette.paperEdge)
                        Text(excerpt.replacingOccurrences(of: "\n", with: " "))
                            .font(.subheadline)
                            .lineSpacing(3)
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(3)
                    }
                }
            }
        } else {
            HStack(alignment: .center, spacing: 13) {
                AstellaGlyph(kind: .refresh, tint: StudyPalette.muted)
                    .frame(width: 16, height: 16).frame(width: 32, height: 32)
                    .background(StudyPalette.inset, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text("第 \(version["versionNo"] as? Int ?? 1) 版")
                        .font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                    Text(dateLabel(version["createdAt"] as? String))
                        .font(.caption).foregroundStyle(StudyPalette.muted)
                }
                Spacer()
                Button("恢复") { selected = version; showRestore = true }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    .disabled(restoring)
            }
            .padding(.vertical, 10)
        }
    }

    private func load() async {
        loading = true; failure = nil
        defer { loading = false }
        do {
            let page = try await store.noteVersions(noteId: noteId)
            items = page["items"] as? [[String: Any]] ?? []
        } catch { failure = noteFeatureFailure(error) }
    }

    private func restoreSelected() async {
        guard let versionId = selected?["id"] as? String, let baseVersionId = store.noteDocument?.versionId else { return }
        restoring = true; failure = nil
        defer { restoring = false; selected = nil }
        do {
            try await store.restoreNoteVersion(noteId: noteId, versionId: versionId, baseVersionId: baseVersionId)
            await store.loadNote(noteId)
            await load()
        } catch { failure = noteFeatureFailure(error) }
    }

    private func dateLabel(_ raw: String?) -> String {
        guard let raw, let date = ISO8601DateFormatter().date(from: raw) else { return "保存时间未提供" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct NoteOverviewScreen: View {
    @Environment(AppStore.self) private var store
    var noteId: String
    @State private var overview: [String: Any]?
    @State private var task: [String: Any]?
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            PageHeading(eyebrow: "围绕当前手记", title: "速览", subtitle: store.noteDocument?.title ?? "")
                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 8)
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        FeatureAuthorizationNotice(error: failure)
                        if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) { featureError(failure, retry: { Task { await load() } }) }
                        if loading && overview == nil { ProgressView("正在读取速览…").frame(maxWidth: .infinity).padding(18) }
                        if working { ProgressView(taskTitle).frame(maxWidth: .infinity).padding(18) }
                        if let overview {
                            let older = overview["versionState"] as? String == "older"
                            let points = overview["points"] as? [[String: Any]] ?? []
                            if older { featureNotice("这份速览基于第 \(overview["noteVersionNumber"] as? Int ?? 1) 版，当前正文可能已经变化。") }
                            VStack(alignment: .leading, spacing: 16) {
                                VStack(alignment: .leading, spacing: 8) {
                                    astellaLabel("核心脉络", glyph: .quote)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(StudyPalette.accent)
                                    Text(overview["body"] as? String ?? "")
                                        .font(.body).lineSpacing(5).foregroundStyle(StudyPalette.ink)
                                }
                                ForEach(Array(points.enumerated()), id: \.offset) { entry in
                                    let point = entry.element
                                    Divider().overlay(StudyPalette.paperEdge)
                                    HStack(alignment: .top, spacing: 12) {
                                        Text(String(format: "%02d", entry.offset + 1))
                                            .font(.caption.monospacedDigit().weight(.semibold))
                                            .foregroundStyle(StudyPalette.accent)
                                            .padding(.top, 2)
                                        VStack(alignment: .leading, spacing: 7) {
                                            Text(point["explanation"] as? String ?? "").font(.body).foregroundStyle(StudyPalette.ink)
                                            Text("“\(point["quote"] as? String ?? "")”")
                                                .font(.callout.italic()).foregroundStyle(StudyPalette.muted)
                                        }
                                    }
                                }
                                if let coverage = overview["coverage"] as? [String: Any], (coverage["imageBlocksNotRead"] as? Int ?? 0) > 0 {
                                    astellaLabel("有图片内容没有纳入这次速览，请结合原文查看。", glyph: .info)
                                        .font(.caption).foregroundStyle(StudyPalette.muted)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        } else if !loading && !working {
                            FeatureGenerationPrimer(kind: "overview", document: store.noteDocument)
                        }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 16)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .topLeading)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(DawnBackground())
        .safeAreaInset(edge: .bottom, spacing: 0) {
                            Button { Task { await generate() } } label: {
                astellaLabel(overview == nil ? "生成速览" : "按当前版本重新整理", glyph: .companion)
                    .frame(maxWidth: .infinity)
            }
            .modifier(PrimaryActionStyle())
            .disabled(working || store.noteDocument == nil || store.aiSettings?.requiresConsent != false || store.aiSettings?.dataPolicy.sendToExternal != true || requiresAIConsent(failure) || requiresAIDataPolicy(failure))
            .padding(.horizontal, 20)
            .padding(.trailing, 74)
            .padding(.vertical, 11)
            .background(StudyPalette.canvas)
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.requiresConsent == false && settings?.dataPolicy.sendToExternal == true && (requiresAIConsent(failure) || requiresAIDataPolicy(failure)) { failure = nil }
        }
    }

    private var taskTitle: String { (task?["status"] as? String) == "queued" ? "已排入整理" : "正在整理这篇手记…" }

    private func load() async {
        guard let versionId = store.noteDocument?.versionId else { return }
        loading = true; failure = nil
        defer { loading = false }
        do {
            let page = try await store.noteOverviews(noteId: noteId)
            let items = page["items"] as? [[String: Any]] ?? []
            overview = items.first(where: { $0["noteVersionId"] as? String == versionId }) ?? items.first
            let latest = try await store.latestOverviewTask(noteId: noteId, noteVersionId: versionId)
            task = latest["task"] as? [String: Any]
            if let current = task, ["queued", "running"].contains(current["status"] as? String ?? "") { await pollTask(current) }
        } catch { failure = noteFeatureFailure(error) }
    }

    private func generate() async {
        guard store.aiSettings?.requiresConsent == false, store.aiSettings?.dataPolicy.sendToExternal == true,
              let versionId = store.noteDocument?.versionId else { return }
        working = true; failure = nil
        defer { working = false }
        do {
            let created = try await store.createOverviewTask(noteId: noteId, noteVersionId: versionId)
            task = created
            await pollTask(created)
        } catch {
            failure = noteFeatureFailure(error)
            if requiresAIConsent(failure) { store.markAIConsentRequired() }
            if requiresAIDataPolicy(failure) { Task { await store.loadAccountSettings() } }
        }
    }

    private func pollTask(_ initial: [String: Any]) async {
        guard let taskId = initial["taskId"] as? String else { return }
        working = true
        for _ in 0..<30 {
            do {
                let value = try await store.overviewTask(noteId: noteId, taskId: taskId)
                task = value
                if let result = value["overview"] as? [String: Any] { overview = result }
                let status = value["status"] as? String ?? ""
                if status == "ready" { working = false; return }
                if status == "failed" { failure = failureLabel(value["failureReason"] as? String); working = false; return }
                try await Task.sleep(for: .seconds(2))
            } catch { failure = noteFeatureFailure(error); working = false; return }
        }
        working = false
        failure = "整理仍在后台进行。稍后重新打开此页即可接着查看。"
    }
}

private struct NoteMindMapScreen: View {
    @Environment(AppStore.self) private var store
    var noteId: String
    @State private var map: [String: Any]?
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            PageHeading(eyebrow: "从主题看见关系", title: "脑图", subtitle: store.noteDocument?.title)
                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 8)
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                FeatureAuthorizationNotice(error: failure)
                        if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) { featureError(failure, retry: { Task { await load() } }) }
                if loading && map == nil { ProgressView("正在读取脑图…").frame(maxWidth: .infinity).padding(18) }
                if working { ProgressView("正在整理思路…").frame(maxWidth: .infinity).padding(18) }
                if let map, let content = map["content"] as? [String: Any], let nodes = content["nodes"] as? [[String: Any]] {
                    let byId = Dictionary(uniqueKeysWithValues: nodes.compactMap { node -> (String, [String: Any])? in
                        guard let id = node["id"] as? String else { return nil }; return (id, node)
                    })
                    if map["versionState"] as? String == "older" { featureNotice("这张图基于第 \(map["noteVersionNumber"] as? Int ?? 1) 版。") }
                    let rootId = content["rootId"] as? String ?? ""
                    let ordered = orderedNodes(nodes: nodes, byId: byId, rootId: rootId)
                    ForEach(Array(ordered.enumerated()), id: \.offset) { entry in
                        let item = entry.element
                        let node = item.node
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 10) {
                                Circle().fill(node["kind"] as? String == "root" ? StudyPalette.accent : StudyPalette.muted.opacity(0.55))
                                    .frame(width: node["kind"] as? String == "root" ? 10 : 7, height: node["kind"] as? String == "root" ? 10 : 7)
                                Text(node["label"] as? String ?? "")
                                    .font((node["kind"] as? String == "root" ? Font.title3 : Font.subheadline).weight(.semibold))
                                    .foregroundStyle(StudyPalette.ink)
                            }
                            .padding(.leading, CGFloat(item.depth) * 18)
                            if let explanation = node["explanation"] as? String, !explanation.isEmpty {
                                Text(explanation).font(.footnote).lineSpacing(2).foregroundStyle(StudyPalette.muted)
                                    .padding(.leading, CGFloat(item.depth) * 18 + 20)
                            }
                            ForEach(Array(((node["references"] as? [[String: Any]]) ?? []).enumerated()), id: \.offset) { entry in
                                let ref = entry.element
                                astellaLabel(ref["quote"] as? String ?? "", glyph: .quote)
                                    .font(.caption).foregroundStyle(StudyPalette.accent).padding(.leading, CGFloat(item.depth) * 18 + 20)
                            }
                        }
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(item.depth == 0 ? StudyPalette.paper : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .padding(.leading, CGFloat(item.depth) * 7)
                    }
                } else if !loading && !working {
                    FeatureGenerationPrimer(kind: "mindmap", document: store.noteDocument)
                }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 16)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .topLeading)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(DawnBackground())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button { Task { await generate() } } label: {
                astellaLabel(map == nil ? "生成脑图" : "按当前版本重新整理", glyph: .companion).frame(maxWidth: .infinity)
            }
            .modifier(PrimaryActionStyle())
            .disabled(working || store.noteDocument == nil || store.aiSettings?.requiresConsent != false || store.aiSettings?.dataPolicy.sendToExternal != true || requiresAIConsent(failure) || requiresAIDataPolicy(failure))
            .padding(.horizontal, 20)
            .padding(.trailing, 74)
            .padding(.vertical, 11)
            .background(StudyPalette.canvas)
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.requiresConsent == false && settings?.dataPolicy.sendToExternal == true && (requiresAIConsent(failure) || requiresAIDataPolicy(failure)) { failure = nil }
        }
    }

    private func load() async {
        guard let versionId = store.noteDocument?.versionId else { return }
        loading = true; failure = nil; defer { loading = false }
        do {
            let page = try await store.noteMindMaps(noteId: noteId)
            let items = page["items"] as? [[String: Any]] ?? []
            map = items.first(where: { $0["noteVersionId"] as? String == versionId }) ?? items.first
            let latest = try await store.latestMindMapTask(noteId: noteId, noteVersionId: versionId)
            if let task = latest["task"] as? [String: Any], ["queued", "running"].contains(task["status"] as? String ?? "") { await poll(task) }
        } catch { failure = noteFeatureFailure(error) }
    }

    private func generate() async {
        guard store.aiSettings?.requiresConsent == false, store.aiSettings?.dataPolicy.sendToExternal == true,
              let versionId = store.noteDocument?.versionId else { return }
        loading = true; failure = nil; defer { loading = false }
        do {
            let task = try await store.createMindMapTask(noteId: noteId, noteVersionId: versionId)
            await poll(task)
        } catch {
            failure = noteFeatureFailure(error)
            if requiresAIConsent(failure) { store.markAIConsentRequired() }
            if requiresAIDataPolicy(failure) { Task { await store.loadAccountSettings() } }
        }
    }

    private func poll(_ initial: [String: Any]) async {
        guard let taskId = initial["taskId"] as? String else { return }
        working = true
        for _ in 0..<30 {
            do {
                let value = try await store.mindMapTask(noteId: noteId, taskId: taskId)
                if let result = value["mindMap"] as? [String: Any] { map = result }
                let status = value["status"] as? String ?? ""
                if status == "ready" { working = false; return }
                if status == "failed" { failure = failureLabel(value["failureReason"] as? String); working = false; return }
                try await Task.sleep(for: .seconds(2))
            } catch { failure = noteFeatureFailure(error); working = false; return }
        }
        working = false; failure = "脑图仍在后台整理。稍后重新打开此页即可接着查看。"
    }
}

private struct NoteExplainScreen: View {
    @Environment(AppStore.self) private var store
    var noteId: String
    @State private var artifact: [String: Any]?
    @State private var task: [String: Any]?
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            PageHeading(eyebrow: "围绕原文逐步展开", title: "讲解", subtitle: store.noteDocument?.title)
                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 8)
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 15) {
                FeatureAuthorizationNotice(error: failure)
                        if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) { featureError(failure, retry: { Task { await load() } }) }
                if loading && artifact == nil { ProgressView("正在读取讲解…").frame(maxWidth: .infinity).padding(18) }
                if working { ProgressView("正在准备讲解…").frame(maxWidth: .infinity).padding(18) }
                if let artifact {
                    let outline = artifact["outline"] as? [[String: Any]] ?? []
                    VStack(alignment: .leading, spacing: 9) {
                            Text(artifact["subject"] as? String ?? "")
                                .font(.headline).foregroundStyle(StudyPalette.ink)
                            Text(artifact["caution"] as? String ?? "")
                                .font(.footnote).foregroundStyle(StudyPalette.muted)
                            if artifact["versionState"] as? String == "older" {
                                Text("基于第 \(artifact["noteVersionNumber"] as? Int ?? 1) 版手记")
                                    .font(.caption.weight(.medium)).foregroundStyle(StudyPalette.accent)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(Array(outline.enumerated()), id: \.offset) { entry in
                        let index = entry.offset
                        let item = entry.element
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .center, spacing: 11) {
                                Text(String(format: "%02d", index + 1))
                                    .font(.caption.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(StudyPalette.accentLabel)
                                    .frame(width: 29, height: 29)
                                    .background(StudyPalette.accent, in: Circle())
                                Text(item["title"] as? String ?? "")
                                    .font(.headline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                            }
                            Text(item["narration"] as? String ?? "").font(.body).lineSpacing(4).foregroundStyle(StudyPalette.ink)
                            astellaLabel(item["quote"] as? String ?? "", glyph: .quote)
                                .font(.caption).lineSpacing(2).foregroundStyle(StudyPalette.muted)
                        }
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { if index < outline.count - 1 { Divider().overlay(StudyPalette.paperEdge).padding(.leading, 40) } }
                    }
                } else if !loading && !working {
                    FeatureGenerationPrimer(kind: "explain", document: store.noteDocument)
                }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 16)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .topLeading)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(DawnBackground())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button { Task { await generate() } } label: {
                astellaLabel(artifact == nil ? "生成讲解" : "重新生成讲解", glyph: .companion).frame(maxWidth: .infinity)
            }
            .modifier(PrimaryActionStyle())
            .disabled(working || store.noteDocument == nil || store.aiSettings?.requiresConsent != false || store.aiSettings?.dataPolicy.sendToExternal != true || requiresAIConsent(failure) || requiresAIDataPolicy(failure))
            .padding(.horizontal, 20)
            .padding(.trailing, 74)
            .padding(.vertical, 11)
            .background(StudyPalette.canvas)
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.requiresConsent == false && settings?.dataPolicy.sendToExternal == true && (requiresAIConsent(failure) || requiresAIDataPolicy(failure)) { failure = nil }
        }
    }

    private func load() async {
        guard let versionId = store.noteDocument?.versionId else { return }
        loading = true; failure = nil; defer { loading = false }
        do {
            let page = try await store.learningArtifactTasks(noteId: noteId, noteVersionId: versionId)
            let tasks = page["items"] as? [[String: Any]] ?? []
            let latest = tasks.first(where: { $0["sourceKind"] as? String == "overview" })
            task = latest
            artifact = latest?["artifact"] as? [String: Any]
            if let latest, ["queued", "running"].contains(latest["status"] as? String ?? "") { await poll(latest) }
        } catch { failure = noteFeatureFailure(error) }
    }

    private func generate() async {
        guard store.aiSettings?.requiresConsent == false, store.aiSettings?.dataPolicy.sendToExternal == true,
              let versionId = store.noteDocument?.versionId else { return }
        working = true; failure = nil; defer { working = false }
        do {
            let created = try await store.createLearningArtifactTask(noteId: noteId, noteVersionId: versionId)
            task = created
            await poll(created)
        } catch {
            failure = noteFeatureFailure(error)
            if requiresAIConsent(failure) { store.markAIConsentRequired() }
            if requiresAIDataPolicy(failure) { Task { await store.loadAccountSettings() } }
        }
    }

    private func poll(_ initial: [String: Any]) async {
        guard let taskId = initial["taskId"] as? String else { return }
        working = true
        for _ in 0..<30 {
            do {
                let value = try await store.learningArtifactTask(noteId: noteId, taskId: taskId)
                task = value
                if let result = value["artifact"] as? [String: Any] { artifact = result }
                let status = value["status"] as? String ?? ""
                if status == "ready" { working = false; return }
                if status == "failed" { failure = failureLabel(value["failureReason"] as? String); working = false; return }
                try await Task.sleep(for: .seconds(2))
            } catch { failure = noteFeatureFailure(error); working = false; return }
        }
        working = false; failure = "讲解仍在后台准备。稍后重新打开此页即可接着查看。"
    }
}

private struct FeatureAuthorizationNotice: View {
    @Environment(AppStore.self) private var store
    var error: String?

    var body: some View {
        Group {
            if store.aiSettings?.requiresConsent == true || requiresAIConsent(error) {
                featureError("ai_consent_required", retry: { Task { await store.loadAccountSettings() } })
            } else if store.aiSettings?.dataPolicy.sendToExternal == false || requiresAIDataPolicy(error) {
                featureError("ai_data_policy_denied", retry: { Task { await store.loadAccountSettings() } })
            } else if store.aiSettings == nil && store.isAccountBusy {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text("正在确认 AI 使用授权…")
                        .font(.footnote).foregroundStyle(StudyPalette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
            } else if store.aiSettings == nil {
                featureError(
                    store.accountError ?? "AI 使用授权暂时无法确认，当前不能开始整理。",
                    retry: { Task { await store.loadAccountSettings() } }
                )
            }
        }
    }
}

private func featureError(_ message: String, retry: @escaping () -> Void) -> some View {
    let consentRequired = requiresAIConsent(message)
    let policyDisabled = requiresAIDataPolicy(message)
    return HStack(alignment: .top, spacing: 10) {
        AstellaGlyph(
            kind: consentRequired || policyDisabled ? .info : .alert,
            tint: consentRequired || policyDisabled ? StudyPalette.accent : StudyPalette.danger,
        )
            .frame(width: 22, height: 24)
        VStack(alignment: .leading, spacing: 4) {
            Text(consentRequired ? "这项整理需要你的授权" : policyDisabled ? "外部 AI 已关闭" : "这次整理没有完成")
                .font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
            Text(consentRequired
                 ? "请先在「我的 → AI 与数据」阅读协议，再由你决定是否同意。确认前不会发送这篇手记。"
                 : policyDisabled
                    ? "账号的数据偏好已关闭外部 AI。你可以在设置中了解并自行调整；重新开启前不会提交这篇手记。"
                    : message)
                .font(.footnote).foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if consentRequired || policyDisabled {
                NavigationLink(value: AccountScreenRoute.account) {
                    Text("查看 AI 使用设置")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(StudyPalette.accent)
                }
                .padding(.top, 2)
            } else {
                Button("重新读取", action: retry)
                    .font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    .padding(.top, 2)
            }
        }
        Spacer(minLength: 0)
    }
}

private func requiresAIConsent(_ message: String?) -> Bool {
    guard let message else { return false }
    return message.localizedCaseInsensitiveContains("ai_consent_required")
        || message.localizedCaseInsensitiveContains("AI 使用协议")
        || message.localizedCaseInsensitiveContains("AI 使用说明")
}

private func requiresAIDataPolicy(_ message: String?) -> Bool {
    guard let message else { return false }
    return message.localizedCaseInsensitiveContains("ai_data_policy_denied")
        || message.localizedCaseInsensitiveContains("AI 数据设置不允许")
        || message.localizedCaseInsensitiveContains("AI 数据策略不允许")
}

private func noteFeatureFailure(_ error: Error) -> String {
    if let apiError = error as? MobileAPIError {
        switch apiError.code {
        case "ai_consent_required": return "ai_consent_required"
        case "ai_data_policy_denied": return "当前 AI 数据设置不允许这项整理，请在「我的 → AI 与数据」核对。"
        default: break
        }
        if apiError.status == 0 { return "暂时连接不上书房，请检查网络或服务地址后重试。" }
        if apiError.status == 401 { return "登录状态已过期，请重新登录。" }
        if apiError.status == 403 { return "当前账号没有权限查看这项内容。" }
        if apiError.status >= 500 { return "服务暂时忙不过来，请稍后重试。" }
        let message = apiError.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if containsCJK(message) { return message }
        return "这次整理没有完成，请稍后重试。"
    }
    if let urlError = error as? URLError,
       [.timedOut, .cannotFindHost, .cannotConnectToHost, .notConnectedToInternet].contains(urlError.code) {
        return "暂时连接不上书房，请检查网络或服务地址后重试。"
    }
    let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return containsCJK(message) ? message : "这次整理没有完成，请检查连接后重试。"
}

private func containsCJK(_ value: String) -> Bool {
    value.unicodeScalars.contains { (0x4e00...0x9fff).contains(Int($0.value)) }
}

private struct FeatureGenerationPrimer: View {
    let kind: String
    let document: NoteDocument?

    private var title: String {
        switch kind {
        case "overview": "速览整理后会包含"
        case "mindmap": "脑图会按层级展开"
        default: "讲解会围绕原文推进"
        }
    }

    private var description: String {
        switch kind {
        case "overview": "提炼主线和要点，并保留可回看的原文出处。"
        case "mindmap": "从这份手记提取主题、分支关系和原文出处。"
        default: "按理解步骤展开，每一步都能对照对应段落。"
        }
    }

    private var excerpt: String? {
        guard let document else { return nil }
        let candidates = document.blocks
            .filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0.type.lowercased().contains("image") }
            .map { $0.content.replacingOccurrences(of: "\n", with: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        guard let value = candidates.first(where: { $0.count >= 30 }) ?? candidates.first else { return nil }
        return String(value.prefix(240))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("尚未生成 · 第 \(document?.versionNumber ?? 1) 版")
                    .font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                Text(title).font(.title3.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                Text(description).font(.subheadline).lineSpacing(3).foregroundStyle(StudyPalette.muted)
            }
            if let document {
                VStack(alignment: .leading, spacing: 8) {
                    Text("取材自第 \(document.versionNumber) 版 · \(document.blocks.count) 个内容块")
                        .font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.muted)
                    if let excerpt {
                        Text("“\(excerpt)”")
                            .font(.footnote).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                            .padding(.leading, 12).padding(.vertical, 2)
                            .overlay(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 1).fill(StudyPalette.accent.opacity(0.58)).frame(width: 2)
                            }
                            .lineLimit(4)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 7) {
                    AstellaGlyph(kind: kind == "mindmap" ? .mindMap : kind == "overview" ? .document : .book, tint: StudyPalette.muted)
                        .frame(width: 14, height: 14)
                    Text("整理后的结构")
                        .foregroundStyle(StudyPalette.muted)
                    Text("·")
                        .foregroundStyle(StudyPalette.muted)
                    Text("预览，不是生成结果")
                        .foregroundStyle(StudyPalette.muted)
                }
                .font(.caption.weight(.medium))
                if kind == "overview" {
                    HStack(alignment: .center, spacing: 7) {
                        previewStep("01", title: "主线", isFirst: true)
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12)
                        previewStep("02", title: "关键点")
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12)
                        previewStep("03", title: "原文依据")
                    }
                    Text("图片覆盖情况会单独说明。")
                        .font(.footnote).foregroundStyle(StudyPalette.muted)
                } else if kind == "mindmap" {
                    HStack(alignment: .top, spacing: 14) {
                        Text("主题")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.horizontal, 11).padding(.vertical, 8)
                            .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 10) {
                            astellaLabel("概念分支", glyph: .mindMap)
                            astellaLabel("对应原文段落", glyph: .quote)
                        }
                        .font(.subheadline).foregroundStyle(StudyPalette.ink)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(["先说明主题", "再结合原文解释", "留下可回看的依据"].enumerated()), id: \.offset) { index, label in
                            HStack(alignment: .top, spacing: 12) {
                                Text(String(format: "%02d", index + 1))
                                    .font(.caption.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(StudyPalette.accent)
                                    .frame(width: 25, alignment: .leading)
                                Text(label).font(.subheadline.weight(index == 0 ? .semibold : .regular)).foregroundStyle(StudyPalette.ink)
                            }
                            .padding(.vertical, 7)
                            .overlay(alignment: .bottom) { if index < 2 { Divider().overlay(StudyPalette.paperEdge) } }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 13)
            .overlay(alignment: .top) { Divider().overlay(StudyPalette.paperEdge) }
            Text("结果会另存为一份整理，不会改动原文。")
                .font(.caption).foregroundStyle(StudyPalette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func previewStep(_ number: String, title: String, isFirst: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(number).font(.caption2.monospacedDigit().weight(.semibold)).foregroundStyle(StudyPalette.muted)
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(isFirst ? StudyPalette.accent : StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func featureNotice(_ text: String) -> some View {
    astellaLabel(text, glyph: .refresh)
        .font(.footnote).foregroundStyle(StudyPalette.muted)
        .padding(13).frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.52), lineWidth: 0.7)
        }
}

private func astellaLabel(_ title: String, glyph: AstellaGlyphKind) -> some View {
    Label {
        Text(title)
    } icon: {
        AstellaGlyph(kind: glyph, tint: StudyPalette.accent).frame(width: 16, height: 16)
    }
}

private func failureLabel(_ reason: String?) -> String {
    switch reason {
    case "ai_consent_required": "需要先在账户页阅读并确认 AI 使用说明。"
    case "ai_data_policy_denied": "当前 AI 数据策略不允许这项整理，请到账户页核对设置。"
    case "generation_incomplete": "这次整理没有完整完成，可以稍后重试。"
    default: "这次整理没有完成，可以检查连接后重试。"
    }
}

private func orderedNodes(nodes: [[String: Any]], byId: [String: [String: Any]], rootId: String) -> [(node: [String: Any], depth: Int)] {
    var output: [(node: [String: Any], depth: Int)] = []
    func visit(_ id: String, depth: Int) {
        guard let node = byId[id], !output.contains(where: { $0.node["id"] as? String == id }) else { return }
        output.append((node, depth))
        for child in nodes where child["parentId"] as? String == id {
            if let childId = child["id"] as? String { visit(childId, depth: depth + 1) }
        }
    }
    visit(rootId, depth: 0)
    return output
}

/// The mockup closes the library with a faint “资料与处理状态” entry. There is no
/// per-file processing API on mobile, so this sheet reports what the client
/// actually knows locally (workspace, note count, sync time) and links to the
/// system permission surface instead of inventing job states.
private struct ProcessingStatusSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("书房里的资料来源、解析结果与处理状态都保存在这台设备上。")
                        .font(.system(size: 13))
                        .lineSpacing(4)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 0) {
                        statusRow(
                            title: "当前书房",
                            detail: store.profile?.workspaceName ?? "我的书房",
                            value: "\(store.notes.count) 篇手记"
                        )
                        divider
                        statusRow(
                            title: "导入来源",
                            detail: "文件选择器、相册与伴星整理",
                            value: "仅本机"
                        )
                        divider
                        statusRow(
                            title: "解析状态",
                            detail: "手记正文与批注按需读取",
                            value: "已连接"
                        )
                        divider
                        Button {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        } label: {
                            HStack(spacing: 13) {
                                AstellaGlyph(kind: .shield, tint: StudyPalette.accent)
                                    .frame(width: 17, height: 17)
                                    .frame(width: 36, height: 36)
                                    .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("设备权限").font(.system(size: 16, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                                    Text("麦克风、相册、相机、文件与通知").font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
                                }
                                Spacer(minLength: 6)
                                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.8)).frame(width: 15, height: 15)
                            }
                            .padding(.vertical, 12)
                            .frame(minHeight: 62)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 6)
                    .modifier(StudyGlassSurfaceStyle(radius: 24, interactive: false))
                }
                .padding(.horizontal, 22)
                .padding(.top, 16)
                .padding(.bottom, 30)
            }
            .scrollIndicators(.hidden)
            .background(DawnBackground())
            .navigationTitle("资料与处理状态")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
        }
    }

    private func statusRow(title: String, detail: String, value: String) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 6)
            Text(value).font(.system(size: 12)).foregroundStyle(StudyPalette.muted)
        }
        .padding(.vertical, 13)
    }

    private var divider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7)
    }
}
