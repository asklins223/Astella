import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

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
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(query.isEmpty ? "全部手记" : "搜索结果")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text("\(store.notes.count) 篇")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(StudyPalette.muted)
                            .padding(.horizontal, 7).frame(height: 19)
                            .background(StudyPalette.inset, in: Capsule())
                        Spacer(minLength: 0)
                        Text(query.isEmpty ? "按最近更新" : "按相关度")
                            .font(.system(size: 10))
                            .foregroundStyle(StudyPalette.muted.opacity(0.82))
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 2)
                    .padding(.bottom, 6)

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
            NoteCover(title: note.title, seed: note.id, paletteIndex: paletteIndex, rotation: -1.6)
                .frame(width: 42, height: 58)
                .offset(y: -2)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("手记")
                        .font(.system(size: 8.5, weight: .semibold))
                        .tracking(1.4)
                        .foregroundStyle(StudyPalette.muted.opacity(0.9))
                    Circle().fill(StudyPalette.paperEdge).frame(width: 2.5, height: 2.5)
                    Text(Self.dateLabel(note.updatedAt))
                        .font(.system(size: 9.5))
                        .foregroundStyle(StudyPalette.muted.opacity(0.85))
                }
                Text(note.title)
                    .font(StudySerif.font(size: 17.5, weight: .semibold))
                    .tracking(0.4)
                    .foregroundStyle(StudyPalette.ink)
                    .multilineTextAlignment(.leading)
                    .lineLimit(1)
                if let snippet = note.snippet, !snippet.isEmpty {
                    Text(snippet)
                        .font(.system(size: 12.5))
                        .lineSpacing(3.5)
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                HStack(spacing: 5) {
                    Text("继续阅读")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                    AstellaGlyph(kind: .chevron, tint: StudyPalette.accent.opacity(0.8))
                        .frame(width: 8, height: 8)
                }
                .padding(.top, 3)
            }
            Spacer(minLength: 0)
            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.6))
                .frame(width: 13, height: 13)
                .padding(.top, 6)
        }
        .padding(.horizontal, 6)
        .padding(.top, 17)
        .padding(.bottom, 17)
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
        .contentShape(Rectangle())
    }

    static func dateLabel(_ value: String) -> String {
        guard let date = Self.parseDate(value) else { return "刚刚" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "今天" }
        if calendar.isDateInYesterday(date) { return "昨天" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = .current
        formatter.dateFormat = "M 月 d 日"
        return formatter.string(from: date)
    }

    private static func parseDate(_ value: String) -> Date? {
        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: value) { return date }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: value) { return date }
        let dayOnly = DateFormatter()
        dayOnly.locale = Locale(identifier: "en_US_POSIX")
        dayOnly.dateFormat = "yyyy-MM-dd"
        return dayOnly.date(from: value)
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
    @State private var selectedAnnotation: NoteAnnotation?
    @State private var annotationChoiceBlockOrdinal: Int?
    @State private var showsAnnotationChoices = false
    @State private var showsAnnotationsDrawer = false
    @State private var showSelection = false
    @State private var selectionOriginal = ""
    @State private var selectionBaseline = Set<String>()
    @State private var readingBlockOrdinal: Int?
    @State private var didRestoreReadingPosition = false
    @State private var showsReaderTools = false
    @State private var showsOverviewDrawer = false
    @State private var showsExpansionDrawer = false
    @State private var showsLearningCard = false
    @State private var showsVersionHistory = false
    @State private var annotationDrawerDetent: PresentationDetent = .medium
    @State private var overviewDetent: PresentationDetent = .fraction(0.95)
    @State private var versionDetent: PresentationDetent = .fraction(0.92)
    @State private var noteLoadRetry = 0
    @State private var showSlowLoadHint = false
    @State private var slowLoadTask: Task<Void, Never>?

    /// The reader renders the user's chosen point size directly: the preference
    /// slider expresses points (16 is the reference scale), matching the mockup's
    /// 19pt default body instead of double-scaling a 17pt base.
    private var bodySize: CGFloat { readerBodySize * store.readingScale }
    private var summary: NoteSummary? { store.notes.first(where: { $0.id == noteId }) }
    private var inkColor: UIColor { UIColor(StudyPalette.ink) }
    private var mutedColor: UIColor { UIColor(StudyPalette.muted) }

    var body: some View {
        readerScreen
            .task(id: "\(noteId)-\(noteLoadRetry)") {
                await loadVisibleNote()
                #if DEBUG
                if ["note-overview", "note-overview-ready"].contains(store.uiReviewMode ?? "") {
                    showsOverviewDrawer = true
                }
                if store.uiReviewMode == "note-versions" { showsVersionHistory = true }
                if ["note-expansion", "note-expansion-saved"].contains(store.uiReviewMode ?? "") { showsExpansionDrawer = true }
                if ["note-learning-card", "note-learning-practice", "note-learning-result"].contains(store.uiReviewMode ?? "") {
                    showsLearningCard = true
                }
                if ["note-explain", "note-explain-ready"].contains(store.uiReviewMode ?? "") {
                    annotationDrawerDetent = .fraction(0.95)
                    selectedAnnotationBlock = store.noteDocument?.blocks.first
                    if store.uiReviewMode == "note-explain-ready" {
                        selectedAnnotation = store.noteAnnotations.first { $0.anchor.startBlockOrdinal == selectedAnnotationBlock?.id }
                    }
                    showsAnnotationsDrawer = true
                }
                #endif
            }
            .onDisappear(perform: finishReadingSession)
            .sheet(isPresented: $showSelection, onDismiss: reloadAfterSelection) {
                CompanionSelectionSheet(original: selectionOriginal, baseline: selectionBaseline)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showsAnnotationsDrawer, onDismiss: {
                selectedAnnotationBlock = nil
                selectedAnnotation = nil
            }) {
                NoteAnnotationsDrawer(
                    noteId: noteId,
                    selectedAnchor: selectedAnnotationAnchor,
                    annotation: selectedAnnotation,
                    onLocate: { ordinal in
                        readingBlockOrdinal = ordinal
                        showsAnnotationsDrawer = false
                    }
                )
                .presentationDetents([.medium, .fraction(0.95)], selection: $annotationDrawerDetent)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(30)
            }
            .onChange(of: store.noteAnnotations) { oldAnnotations, newAnnotations in
                guard selectedAnnotation == nil,
                      let selectedAnchor = selectedAnnotationAnchor else { return }
                let oldIDs = Set(oldAnnotations.map(\.id))
                guard let newAnnotation = newAnnotations.first(where: {
                    $0.anchor == selectedAnchor && !oldIDs.contains($0.id)
                }) else { return }
                selectedAnnotation = newAnnotation
            }
            .sheet(isPresented: $showsVersionHistory) {
                NoteVersionsScreen(noteId: noteId)
                    .presentationDetents([.medium, .fraction(0.95)], selection: $versionDetent)
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(30)
            }
            .sheet(isPresented: $showsOverviewDrawer) {
                NoteOverviewScreen(noteId: noteId)
                    .presentationDetents([.medium, .fraction(0.95)], selection: $overviewDetent)
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(30)
            }
            .sheet(isPresented: $showsExpansionDrawer) {
                NoteExpansionDrawer(noteId: noteId)
                    .presentationDetents([.fraction(0.86), .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(30)
            }
            .fullScreenCover(isPresented: $showsLearningCard) {
                NoteLearningCardScreen(noteId: noteId, title: store.noteDocument?.title ?? summary?.title ?? "手记")
            }
            .confirmationDialog(
                "这段原文有 \(annotationChoices.count) 条批注",
                isPresented: $showsAnnotationChoices,
                titleVisibility: .visible
            ) {
                ForEach(annotationChoices) { annotation in
                    Button("\(annotationKindLabel(annotation)) · \(annotation.anchor.excerpt.prefix(32))") {
                        guard let document = store.noteDocument else { return }
                        openAnnotation(annotation, in: document)
                    }
                }
                Button("给这段原文留批注") {
                    guard let document = store.noteDocument,
                          let block = document.blocks.first(where: { $0.id == annotationChoiceBlockOrdinal }) else { return }
                    beginAnnotation(for: block, in: document, explain: false)
                }
                Button("请伴星讲解") {
                    guard let document = store.noteDocument,
                          let block = document.blocks.first(where: { $0.id == annotationChoiceBlockOrdinal }) else { return }
                    beginAnnotation(for: block, in: document, explain: true)
                }
                Button("取消", role: .cancel) {}
            }
    }

    private var readerScreen: some View {
        GeometryReader { viewport in
            readerScrollView(width: viewport.size.width, height: viewport.size.height)
                .scrollIndicators(.hidden)
                .scrollPosition(id: $readingBlockOrdinal, anchor: .top)
                .onChange(of: readingBlockOrdinal) { _, ordinal in readingPositionChanged(ordinal) }
                .onChange(of: store.noteDocument?.versionId) { _, _ in restoreCurrentReadingPosition() }
        }
        .background(DawnBackground())
        .toolbar(.hidden, for: .tabBar)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            readerHeaderContent
        }
    }

    @ViewBuilder
    private func readerScrollView(width: CGFloat, height: CGFloat) -> some View {
        ScrollView {
            readerContent(width: width, height: height)
        }
        .frame(width: width, height: height)
    }

    @ViewBuilder
    private func readerContent(width: CGFloat, height: CGFloat) -> some View {
        if let document = store.noteDocument, document.id == noteId {
            readerDocumentContent(document)
                .frame(width: width)
                .frame(minHeight: height, alignment: .topLeading)
        } else if let error = store.noteErrorMessage {
            noteLoadError(error)
                .frame(width: width)
                .frame(minHeight: height, alignment: .topLeading)
        } else {
            noteLoadingView(width: width, height: height)
                .frame(width: width)
                .frame(minHeight: height, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var readerHeaderContent: some View {
        if let document = store.noteDocument, document.id == noteId {
            readerHeader(document)
        } else {
            readerHeaderPlaceholder
        }
    }

    private func loadVisibleNote() async {
        let retryGeneration = noteLoadRetry
        didRestoreReadingPosition = false
        readingBlockOrdinal = nil
        showSlowLoadHint = false
        slowLoadTask?.cancel()
        store.visibleNoteId = noteId
        #if DEBUG
        if store.uiReviewMode != nil {
            didRestoreReadingPosition = true
            return
        }
        #endif
        slowLoadTask = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            guard retryGeneration == noteLoadRetry,
                  store.noteDocument?.id != noteId,
                  store.noteErrorMessage == nil else { return }
            showSlowLoadHint = true
        }
        await store.loadNote(noteId)
        guard retryGeneration == noteLoadRetry else { return }
        slowLoadTask?.cancel()
        slowLoadTask = nil
        showSlowLoadHint = false
        if let document = store.noteDocument, document.id == noteId {
            restoreReadingPosition(for: document)
        }
        await store.reportAwareness(topic: "page.arrived", foreground: true)
    }

    private func finishReadingSession() {
        slowLoadTask?.cancel()
        slowLoadTask = nil
        if let readingBlockOrdinal, store.noteDocument?.id == noteId {
            store.saveNoteReadingBlock(readingBlockOrdinal, noteId: noteId)
        }
        if store.visibleNoteId == noteId { store.visibleNoteId = nil }
    }

    private func reloadAfterSelection() {
        didRestoreReadingPosition = false
        Task { await store.loadNote(noteId) }
    }

    private var selectedAnnotationAnchor: NoteAnnotationAnchor? {
        if let selectedAnnotation { return selectedAnnotation.anchor }
        guard let document = store.noteDocument,
              let block = selectedAnnotationBlock else { return nil }
        return NoteAnnotationAnchor.wholeBlock(block, versionId: document.versionId)
    }

    private func currentAnnotations(for block: NoteBlock, document: NoteDocument) -> [NoteAnnotation] {
        guard store.noteDocument?.id == document.id else { return [] }
        return store.noteAnnotations
            .filter { annotation in
                annotation.versionState == "current"
                    && annotation.anchor.noteVersionId == document.versionId
                    && annotation.anchor.startBlockOrdinal <= block.id
                    && annotation.anchor.endBlockOrdinal >= block.id
                    && noteAnnotationAnchorMatches(annotation.anchor, blocks: document.blocks)
            }
            .sorted {
                if $0.anchor.startBlockOrdinal != $1.anchor.startBlockOrdinal {
                    return $0.anchor.startBlockOrdinal < $1.anchor.startBlockOrdinal
                }
                if $0.anchor.startOffset != $1.anchor.startOffset {
                    return $0.anchor.startOffset < $1.anchor.startOffset
                }
                return $0.id < $1.id
            }
    }

    private var annotationChoices: [NoteAnnotation] {
        guard let ordinal = annotationChoiceBlockOrdinal,
              let document = store.noteDocument,
              let block = document.blocks.first(where: { $0.id == ordinal }) else { return [] }
        return currentAnnotations(for: block, document: document)
    }

    private func annotationMarks(for block: NoteBlock, document: NoteDocument) -> [SelectableTextAnnotationMark] {
        guard let text = renderedNoteBlockText(block) else { return [] }
        let length = (text as NSString).length
        let annotations = currentAnnotations(for: block, document: document)
        let markerNumbers = Dictionary(uniqueKeysWithValues: annotations
            .filter { $0.anchor.endBlockOrdinal == block.id }
            .enumerated()
            .map { ($0.element.id, $0.offset + 1) })
        return annotations.compactMap { annotation in
            let anchor = annotation.anchor
            let start = anchor.startBlockOrdinal == block.id ? anchor.startOffset : 0
            let end = anchor.endBlockOrdinal == block.id ? anchor.endOffset : length
            guard start >= 0, end > start, end <= length else { return nil }
            return SelectableTextAnnotationMark(
                blockOrdinal: anchor.endBlockOrdinal,
                startOffset: start,
                endOffset: end,
                number: markerNumbers[annotation.id]
            )
        }
    }

    private func openAnnotations(in block: NoteBlock, document: NoteDocument) {
        let annotations = currentAnnotations(for: block, document: document)
        guard !annotations.isEmpty else { return }
        if annotations.count == 1 {
            openAnnotation(annotations[0], in: document)
        } else {
            annotationChoiceBlockOrdinal = block.id
            showsAnnotationChoices = true
        }
    }

    private func openAnnotation(_ annotation: NoteAnnotation, in document: NoteDocument) {
        store.clearAnnotationNotice()
        selectedAnnotation = annotation
        selectedAnnotationBlock = document.blocks.first { $0.id == annotation.anchor.startBlockOrdinal }
        showsAnnotationsDrawer = true
    }

    private func beginAnnotation(for block: NoteBlock, in document: NoteDocument, explain: Bool) {
        guard let anchor = NoteAnnotationAnchor.wholeBlock(block, versionId: document.versionId) else {
            store.annotationErrorMessage = "这段内容暂时无法精确对应到手记原文。"
            return
        }
        store.clearAnnotationNotice()
        selectedAnnotation = nil
        selectedAnnotationBlock = block
        annotationDrawerDetent = .fraction(0.95)
        showsAnnotationsDrawer = true
        if explain {
            Task { await store.explainNoteAnnotation(noteId: noteId, anchor: anchor) }
        }
    }

    private func annotationKindLabel(_ annotation: NoteAnnotation) -> String {
        annotation.generationJobId != nil || annotation.sourceMessageId != nil ? "伴星讲解" : "我的批注"
    }

    private func readingPositionChanged(_ ordinal: Int?) {
        guard didRestoreReadingPosition,
              let ordinal,
              store.noteDocument?.id == noteId else { return }
        store.saveNoteReadingBlock(ordinal, noteId: noteId)
    }

    private func restoreCurrentReadingPosition() {
        guard let document = store.noteDocument, document.id == noteId else { return }
        restoreReadingPosition(for: document)
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

                    Button { showsReaderTools = true } label: {
                        AstellaGlyph(kind: .settings, tint: StudyPalette.ink)
                            .frame(width: 19, height: 19)
                            .frame(width: 48, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityLabel("手记工具")
                    .popover(isPresented: $showsReaderTools, attachmentAnchor: .rect(.bounds), arrowEdge: .top) {
                        readerToolsPopover(document)
                    }
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

    private func readerToolGlyph(_ kind: NoteReaderTool) -> AstellaGlyphKind {
        switch kind {
        case .overview: .document
        case .mindMap: .mindMap
        case .versions: .history
        }
    }

    private func readerToolsPopover(_ document: NoteDocument) -> some View {
        VStack(spacing: 2) {
            ForEach(NoteReaderTool.allCases, id: \.self) { kind in
                if kind == .versions {
                    Button {
                        showsReaderTools = false
                        showsVersionHistory = true
                    } label: {
                        readerToolLabel(kind, glyph: readerToolGlyph(kind))
                    }
                    .buttonStyle(AstellaPressStyle())
                } else if kind == .overview {
                    Button {
                        showsReaderTools = false
                        showsOverviewDrawer = true
                    } label: {
                        readerToolLabel(kind, glyph: readerToolGlyph(kind))
                    }
                    .buttonStyle(AstellaPressStyle())
                } else if let featureKind = kind.featureKind {
                    NavigationLink(value: NoteFeatureRoute(noteId: noteId, kind: featureKind)) {
                        readerToolLabel(kind, glyph: readerToolGlyph(kind))
                    }
                    .buttonStyle(.plain)
                }
            }

            Button {
                showsReaderTools = false
                showsExpansionDrawer = true
            } label: {
                readerToolLabel(title: "拓展笔记", glyph: .sparkle)
            }
            .buttonStyle(AstellaPressStyle())

            Button {
                showsReaderTools = false
                showsLearningCard = true
            } label: {
                readerToolLabel(title: "学习卡", glyph: .recall)
            }
            .buttonStyle(AstellaPressStyle())

            Rectangle()
                .fill(StudyPalette.paperEdge.opacity(0.66))
                .frame(height: 0.7)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)

            Button {
                showsReaderTools = false
                store.continueWithNote(document)
            } label: {
                HStack(spacing: 12) {
                    AstellaGlyph(kind: .chat, tint: StudyPalette.accent)
                        .frame(width: 18, height: 18)
                        .frame(width: 22, height: 22)
                    Text("在对话里继续提问")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(StudyPalette.ink)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(height: 43)
                .contentShape(Rectangle())
            }
            .buttonStyle(AstellaPressStyle())
        }
        .padding(8)
        .frame(width: 238)
        .modifier(StudyGlassSurfaceStyle(radius: 23))
        .presentationCompactAdaptation(.popover)
    }

    private func readerToolLabel(_ kind: NoteReaderTool, glyph: AstellaGlyphKind) -> some View {
        readerToolLabel(title: kind.title, glyph: glyph)
    }

    private func readerToolLabel(title: String, glyph: AstellaGlyphKind) -> some View {
        HStack(spacing: 12) {
            AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
                .frame(width: 18, height: 18)
                .frame(width: 22, height: 22)
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(StudyPalette.ink)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 43)
        .contentShape(Rectangle())
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
        Button {
            showsVersionHistory = true
        } label: {
            HStack(spacing: 8) {
                AstellaGlyph(kind: .history, tint: StudyPalette.accent)
                    .frame(width: 13, height: 13)
                Text("第 \(document.versionNumber) 版")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Circle().fill(StudyPalette.muted.opacity(0.45)).frame(width: 2.5, height: 2.5)
                Text(versionDetail(document))
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(1)
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.7))
                    .frame(width: 9, height: 9)
                    .padding(.leading, 1)
            }
            .padding(.horizontal, 13)
            .frame(height: 34)
            .background(StudyPalette.sky.opacity(0.62), in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.5), lineWidth: 0.7))
            .contentShape(Capsule())
        }
        .buttonStyle(AstellaPressStyle())
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
            ReaderNoteReferenceText(
                text: block.content,
                blockType: block.type,
                fontSize: bodySize,
                style: CompanionTextStyle(
                    fontSize: bodySize,
                    serif: true,
                    firstLineIndent: 0,
                    lineSpacing: bodySize * 0.58,
                    paragraphSpacing: 0,
                    color: mutedColor
                ),
                onOpenNote: { store.requestNoteReference($0) },
                annotationMarks: annotationMarks(for: block, document: document),
                onOpenAnnotationBlock: { _ in openAnnotations(in: block, document: document) }
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
            ReaderNoteReferenceText(
                text: block.content,
                blockType: block.type,
                fontSize: bodySize,
                style: CompanionTextStyle(
                    fontSize: bodySize,
                    serif: true,
                    firstLineIndent: bodySize * 2,
                    lineSpacing: bodySize * 0.58,
                    paragraphSpacing: 0,
                    color: inkColor
                ),
                onOpenNote: { store.requestNoteReference($0) },
                annotationMarks: annotationMarks(for: block, document: document),
                onOpenAnnotationBlock: { _ in openAnnotations(in: block, document: document) }
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

    private func noteLoadingView(width: CGFloat, height: CGFloat) -> some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.regular)
            Text("正在打开手记…")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
            if showSlowLoadHint {
                Text("连接时间比平时长，手记还在读取中。")
                    .font(.system(size: 13))
                    .foregroundStyle(StudyPalette.muted)
                Button("重新加载") { noteLoadRetry &+= 1 }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.top, 2)
            } else {
                Text("正在读取正文和当前版本")
                    .font(.system(size: 12))
                    .foregroundStyle(StudyPalette.muted)
            }
        }
        .frame(width: width, height: max(height, 360))
    }

    private func readerDocumentContent(_ document: NoteDocument) -> some View {
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
                .padding(.top, 26)
            VStack(alignment: .leading, spacing: 25) {
                ForEach(document.blocks) { block in
                    readerBlock(block, document: document)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    .id(block.id)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contextMenu {
                        if ["paragraph", "heading", "quote", "code", "list"].contains(block.type) {
                            Button {
                                beginAnnotation(for: block, in: document, explain: false)
                            } label: { astellaLabel("给这一段留批注", glyph: .quote) }
                            Button {
                                beginAnnotation(for: block, in: document, explain: true)
                            } label: { astellaLabel("请伴星讲解", glyph: .companion) }
                        }
                    }
                }
            }
            .padding(.top, 26)
            .scrollTargetLayout()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 26)
        .padding(.top, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The parent shell keeps a floating companion shortcut on detail routes.
        // Reserve enough scrollable space so the last paragraph can pass above it.
        .padding(.bottom, 112)
        .opacity(didRestoreReadingPosition ? 1 : 0)
    }

    private func noteLoadError(_ message: String) -> some View {
        ContentUnavailableView {
            VStack(alignment: .leading, spacing: 8) {
                AstellaGlyph(kind: .book, tint: StudyPalette.muted).frame(width: 24, height: 24)
                Text("这篇手记暂时打不开").font(.headline)
                Text(message).font(.subheadline).foregroundStyle(StudyPalette.muted)
            }
        } actions: {
            Button("重新加载") { noteLoadRetry &+= 1 }
                .modifier(PrimaryActionStyle())
        }
        .padding(.top, 60)
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
            ReaderNoteReferenceText(
                text: block.content,
                fontSize: bodySize,
                onOpenNote: { store.requestNoteReference($0) }
            )
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

private struct NoteAnnotationsDrawer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let noteId: String
    let selectedAnchor: NoteAnnotationAnchor?
    let initialAnnotation: NoteAnnotation?
    let onLocate: (Int) -> Void

    @State private var activeAnnotationID: String?
    @State private var draft: String
    @State private var isEditing: Bool
    @State private var confirmsRemoval = false

    init(
        noteId: String,
        selectedAnchor: NoteAnnotationAnchor?,
        annotation: NoteAnnotation?,
        onLocate: @escaping (Int) -> Void
    ) {
        self.noteId = noteId
        self.selectedAnchor = selectedAnchor
        self.initialAnnotation = annotation
        self.onLocate = onLocate
        _activeAnnotationID = State(initialValue: annotation?.id)
        _draft = State(initialValue: annotation?.explanation ?? "")
        _isEditing = State(initialValue: annotation == nil)
    }

    private var annotation: NoteAnnotation? {
        guard let activeAnnotationID else { return initialAnnotation }
        return store.noteAnnotations.first(where: { $0.id == activeAnnotationID }) ?? initialAnnotation
    }

    private var anchor: NoteAnnotationAnchor? { selectedAnchor ?? annotation?.anchor }

    private var isCompanionExplanation: Bool {
        guard let annotation else { return false }
        return annotation.generationJobId != nil || annotation.sourceMessageId != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    excerptCard
                    if let annotation {
                        explanationCard(annotation)
                        if isEditing { editorCard }
                        actionRow(annotation)
                    } else {
                        editorCard
                    }
                    if let error = store.annotationErrorMessage {
                        featureError(error, retry: { Task { await store.loadNoteAnnotations(noteId) } })
                    } else if let status = store.annotationStatus {
                        statusRow(status)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 26)
            }
            .scrollIndicators(.hidden)
        }
        .background(DawnBackground())
        .task(id: noteId) { await store.loadNoteAnnotations(noteId) }
        .onChange(of: annotation?.id) { _, _ in syncEditor() }
        .confirmationDialog("撤下这条批注？", isPresented: $confirmsRemoval, titleVisibility: .visible) {
            Button("撤下批注", role: .destructive) {
                if let annotation { Task { await store.removeNoteAnnotation(noteId: noteId, annotation: annotation) } }
            }
            Button("保留", role: .cancel) {}
        } message: {
            Text("这条批注以及伴星为它写的讲解会一起移走，原文不受影响。")
        }
    }

    private var headerBar: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(isCompanionExplanation ? "伴星讲解" : (annotation == nil ? "新批注" : "我的批注"))
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(StudyPalette.accent)
                Text(isCompanionExplanation ? "这段原文的另一种读法" : (annotation == nil ? "写在这段原文旁" : "贴在原文旁的笔记"))
                    .font(StudySerif.font(size: 20, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if store.isAnnotationBusy {
                ProgressView().controlSize(.small).tint(StudyPalette.accent)
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(StudyPalette.muted).frame(width: 32, height: 32)
                    .background(StudyPalette.inset.opacity(0.7), in: Circle())
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("关闭批注")
        }
        .padding(.horizontal, 21).padding(.top, 16).padding(.bottom, 13)
    }

    private var excerptCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 7) {
                AstellaGlyph(kind: .quote, tint: StudyPalette.accent).frame(width: 12, height: 12)
                Text("原文")
                    .font(.system(size: 10, weight: .semibold)).tracking(1.8)
                    .foregroundStyle(StudyPalette.accent)
                Spacer(minLength: 0)
                if let anchor {
                    Button {
                        onLocate(anchor.startBlockOrdinal)
                        dismiss()
                    } label: {
                        HStack(spacing: 3) {
                            Text("回到原文")
                            AstellaGlyph(kind: .chevron, tint: StudyPalette.accent.opacity(0.8))
                                .frame(width: 9, height: 9)
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                    }
                }
            }
            HStack(alignment: .top, spacing: 11) {
                RoundedRectangle(cornerRadius: 2).fill(StudyPalette.accent.opacity(0.5)).frame(width: 2.5)
                Text(anchor?.excerpt ?? "这段原文没有可用的摘录。")
                    .font(StudySerif.font(size: 15))
                    .lineSpacing(5.5)
                    .foregroundStyle(StudyPalette.ink.opacity(0.94))
                    .lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let anchor {
                Text("第 \(anchor.startBlockOrdinal + 1) 段")
                    .font(.system(size: 9.5, weight: .medium))
                    .tracking(0.8)
                    .foregroundStyle(StudyPalette.muted.opacity(0.9))
            }
        }
        .padding(17)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.7), lineWidth: 0.7))
    }

    private func explanationCard(_ annotation: NoteAnnotation) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(isCompanionExplanation ? StudyPalette.accent.opacity(0.16) : StudyPalette.inset)
                        .frame(width: 24, height: 24)
                    AstellaGlyph(kind: isCompanionExplanation ? .companion : .edit,
                                 tint: isCompanionExplanation ? StudyPalette.accent : StudyPalette.muted)
                        .frame(width: 12, height: 12)
                }
                Text(isCompanionExplanation ? "伴星讲过" : "你写的")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(isCompanionExplanation ? StudyPalette.accent : StudyPalette.muted)
                Spacer(minLength: 0)
                Text("第 \(annotation.revision) 次修订")
                    .font(.system(size: 9.5))
                    .foregroundStyle(StudyPalette.muted.opacity(0.8))
            }
            Text(annotation.explanation)
                .font(StudySerif.font(size: 15))
                .lineSpacing(6.5)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isCompanionExplanation ? StudyPalette.sky.opacity(0.55) : StudyPalette.paper.opacity(0.8),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(isCompanionExplanation ? Color.clear : StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.7)
        )
    }

    private var editorCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(annotation == nil ? "写下你的批注" : "修改这条批注")
                .font(.system(size: 10, weight: .semibold)).tracking(1.2)
                .foregroundStyle(StudyPalette.muted)
            ZStack(alignment: .topLeading) {
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("这段话让你想到什么？可以只写一句。")
                        .font(.system(size: 13.5))
                        .foregroundStyle(StudyPalette.muted.opacity(0.8))
                        .padding(.horizontal, 14).padding(.top, 12)
                }
                TextEditor(text: $draft)
                    .font(.system(size: 14))
                    .lineSpacing(5)
                    .scrollContentBackground(.hidden)
                    .padding(9)
                    .frame(minHeight: 132)
                    .disabled(store.isAnnotationBusy)
            }
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
            Button {
                saveDraft()
            } label: {
                HStack(spacing: 8) {
                    if store.isAnnotationBusy { ProgressView().tint(StudyPalette.paper) }
                    Text(annotation == nil ? "留在这段原文旁" : "保存修改")
                }
            }
            .modifier(PrimaryActionStyle())
            .disabled(store.isAnnotationBusy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(16)
        .background(StudyPalette.inset.opacity(0.55), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func actionRow(_ annotation: NoteAnnotation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if !isEditing {
                    Button {
                        draft = annotation.explanation
                        withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) { isEditing = true }
                    } label: {
                        compactActionLabel("修改", glyph: .edit)
                    }
                    .buttonStyle(AstellaPressStyle())
                } else {
                    Button {
                        draft = annotation.explanation
                        withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) { isEditing = false }
                    } label: {
                        compactActionLabel("取消修改", glyph: .close)
                    }
                    .buttonStyle(AstellaPressStyle())
                }
                if !isCompanionExplanation, let anchor {
                    Button {
                        Task { await store.explainNoteAnnotation(noteId: noteId, anchor: anchor) }
                    } label: {
                        compactActionLabel("请伴星讲解这段", glyph: .sparkle, tinted: true)
                    }
                    .buttonStyle(AstellaPressStyle())
                    .disabled(store.isAnnotationBusy)
                }
                Spacer(minLength: 0)
            }
            Button("撤下这条批注") { confirmsRemoval = true }
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(StudyPalette.danger)
                .disabled(store.isAnnotationBusy)
                .padding(.leading, 3)
        }
    }

    private func compactActionLabel(_ title: String, glyph: AstellaGlyphKind, tinted: Bool = false) -> some View {
        HStack(spacing: 6) {
            AstellaGlyph(kind: glyph, tint: tinted ? StudyPalette.accent : StudyPalette.ink.opacity(0.82))
                .frame(width: 12, height: 12)
            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(tinted ? StudyPalette.accent : StudyPalette.ink.opacity(0.82))
        }
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(tinted ? StudyPalette.sky.opacity(0.85) : StudyPalette.inset.opacity(0.72), in: Capsule())
    }

    private func statusRow(_ status: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 14, height: 14)
            Text(status).font(.system(size: 11.5)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(StudyPalette.paper.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func syncEditor() {
        if let annotation {
            draft = annotation.explanation
            isEditing = false
        } else {
            draft = ""
            isEditing = true
        }
    }

    private func saveDraft() {
        guard let anchor else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task {
            if let annotation {
                await store.updateNoteAnnotation(noteId: noteId, annotation: annotation, explanation: text)
            } else {
                await store.saveNoteAnnotation(noteId: noteId, anchor: anchor, explanation: text)
            }
            if store.annotationErrorMessage == nil {
                withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) { isEditing = false }
            }
        }
    }
}


// MARK: - Reader inline references

/// Renders one reader block through the shared selectable-text view, keeping
/// note-reference links and annotation marks clickable.
private struct ReaderNoteReferenceText: View {
    let text: String
    var blockType: String = "paragraph"
    var fontSize: CGFloat
    var style: CompanionTextStyle? = nil
    var onOpenNote: ((String) -> Void)? = nil
    var annotationMarks: [SelectableTextAnnotationMark] = []
    var onOpenAnnotationBlock: ((Int) -> Void)? = nil
    var onSelect: ((String, Bool) -> Void)? = nil

    var body: some View {
        CompanionSelectableText(
            text: text,
            fontSize: fontSize,
            style: style,
            onOpenNote: onOpenNote,
            annotationMarks: annotationMarks,
            onOpenAnnotationBlock: onOpenAnnotationBlock
        ) { selected, rewrite in
            onSelect?(selected, rewrite)
        }
    }
}

// MARK: - Image blocks

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

// MARK: - Note feature routes

enum NoteFeatureKind: String, Hashable, CaseIterable {
    case overview, mindMap, versions

    var title: String {
        switch self {
        case .overview: "速览"
        case .mindMap: "脑图"
        case .versions: "版本记录"
        }
    }

    var glyph: AstellaGlyphKind {
        switch self {
        case .overview: .document
        case .mindMap: .mindMap
        case .versions: .refresh
        }
    }
}

/// Entries of the reader's 手记工具 popover.
private enum NoteReaderTool: CaseIterable, Hashable {
    case overview, mindMap, versions

    var title: String {
        switch self {
        case .overview: "速览"
        case .mindMap: "脑图"
        case .versions: "版本记录"
        }
    }

    var featureKind: NoteFeatureKind? {
        switch self {
        case .mindMap: .mindMap
        default: nil
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
        Group {
            switch route.kind {
            case .overview: NoteOverviewScreen(noteId: route.noteId)
            case .mindMap: NoteMindMapScreen(noteId: route.noteId)
            case .versions: NoteVersionsScreen(noteId: route.noteId)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

// MARK: - Version history

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
        VStack(spacing: 0) {
            header
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let failure {
                        featureError(failure, retry: { Task { await load() } })
                            .padding(.bottom, 16)
                    }
                    if loading && items.isEmpty {
                        loadingState
                    } else if items.isEmpty && failure == nil {
                        emptyState
                    } else {
                        timeline
                    }
                }
                .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 30)
            }
            .scrollIndicators(.hidden)
        }
        .background(DawnBackground())
        .confirmationDialog("恢复到第 \(selected?["versionNo"] as? Int ?? 1) 版？", isPresented: $showRestore, titleVisibility: .visible) {
            Button("恢复这一版", role: .destructive) { Task { await restoreSelected() } }
            Button("取消", role: .cancel) { selected = nil }
        } message: {
            Text("当前内容会作为新版本保存，之后仍可切回其他记录。")
        }
        .task { await load() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    Text("保存轨迹")
                        .font(.system(size: 10.5, weight: .semibold))
                        .tracking(2.2)
                        .foregroundStyle(StudyPalette.accent)
                    if !items.isEmpty {
                        Circle().fill(StudyPalette.paperEdge).frame(width: 3, height: 3)
                        Text("\(items.count) 个版本")
                            .font(.system(size: 10.5))
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                Text("版本记录")
                    .font(StudySerif.font(size: 23, weight: .semibold))
                    .tracking(1)
                    .foregroundStyle(StudyPalette.ink)
                Text("恢复会另存为新版本，原来的内容仍会保留。")
                    .font(.system(size: 11.5))
                    .lineSpacing(3)
                    .foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(width: 32, height: 32)
                    .background(StudyPalette.inset.opacity(0.7), in: Circle())
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("收起版本记录")
        }
        .padding(.horizontal, 22).padding(.top, 16).padding(.bottom, 14)
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(StudyPalette.accent)
            Text("正在读取版本…")
                .font(.system(size: 12.5))
                .foregroundStyle(StudyPalette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 40)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            AstellaGlyph(kind: .history, tint: StudyPalette.accent)
                .frame(width: 22, height: 22)
                .frame(width: 52, height: 52)
                .background(StudyPalette.sky, in: Circle())
            Text("还没有版本记录")
                .font(StudySerif.font(size: 18, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
            Text("这篇手记目前只有当前版本。之后每次保存，都会沿着这条轨迹多留一页。")
                .font(.system(size: 12.5))
                .lineSpacing(4)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let failure { featureError(failure, retry: { Task { await load() } }).padding(.top, 6) }
        }
        .padding(.top, 34)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, version in
                versionRow(version, isLast: index == items.count - 1 && items.count > 1)
            }
            if items.count == 1 {
                upcomingRow
            }
        }
    }

    @ViewBuilder
    private func versionRow(_ version: [String: Any], isLast: Bool) -> some View {
        let current = version["id"] as? String == store.noteDocument?.versionId
        HStack(alignment: .top, spacing: 15) {
            ZStack {
                Circle()
                    .fill(current ? StudyPalette.accent : StudyPalette.paper)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(current ? Color.clear : StudyPalette.paperEdge, lineWidth: 1.4))
                if current {
                    Circle().fill(StudyPalette.accent.opacity(0.24)).frame(width: 18, height: 18)
                }
            }
            .frame(width: 10)
            .padding(.top, 17)

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("第 \(version["versionNo"] as? Int ?? 1) 版")
                        .font(StudySerif.font(size: 17, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Spacer(minLength: 0)
                    if current {
                        Text("正在读")
                            .font(.system(size: 9.5, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.horizontal, 8).frame(height: 20)
                            .background(StudyPalette.sky, in: Capsule())
                    } else {
                        Button {
                            selected = version
                            showRestore = true
                        } label: {
                            Text("恢复这一版")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(StudyPalette.accent)
                                .padding(.horizontal, 11).frame(height: 28)
                                .background(StudyPalette.sky.opacity(0.85), in: Capsule())
                        }
                        .buttonStyle(AstellaPressStyle())
                        .disabled(restoring)
                    }
                }
                Text(dateLabel(version["createdAt"] as? String))
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
                if current, let document = store.noteDocument, document.id == noteId,
                   let excerpt = document.blocks.first(where: { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.type != "image" })?.content {
                    HStack(alignment: .top, spacing: 9) {
                        RoundedRectangle(cornerRadius: 2).fill(StudyPalette.accent.opacity(0.45)).frame(width: 2)
                        Text(excerpt.replacingOccurrences(of: "\n", with: " "))
                            .font(StudySerif.font(size: 13))
                            .lineSpacing(4.5)
                            .foregroundStyle(StudyPalette.ink.opacity(0.82))
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                current ? StudyPalette.paper : StudyPalette.paper.opacity(0.55),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(current ? StudyPalette.accent.opacity(0.28) : StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8)
            )
        }
        .background(alignment: .topLeading) {
            if !isLast {
                GeometryReader { proxy in
                    Rectangle()
                        .fill(StudyPalette.accent.opacity(0.22))
                        .frame(width: 1.2, height: proxy.size.height + 14)
                        .offset(x: 4.4, y: 22)
                }
            }
        }
    }

    private var upcomingRow: some View {
        HStack(alignment: .top, spacing: 15) {
            Circle()
                .strokeBorder(StudyPalette.paperEdge, style: StrokeStyle(lineWidth: 1.2, dash: [2.5, 2.5]))
                .frame(width: 10, height: 10)
                .padding(.top, 8)
            VStack(alignment: .leading, spacing: 4) {
                Text("接下来的保存")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text("新版本会沿着这条轨迹追加，原来的内容仍会保留。")
                    .font(.system(size: 11.5))
                    .lineSpacing(3)
                    .foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 2)
            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }

    private func load() async {
        #if DEBUG
        if store.uiReviewMode == "note-versions" {
            items = Self.reviewItems
            failure = nil
            return
        }
        #endif
        loading = true; failure = nil
        defer { loading = false }
        do {
            let page = try await store.noteVersions(noteId: noteId)
            items = page["items"] as? [[String: Any]] ?? []
        } catch { failure = noteFeatureFailure(error) }
    }

    #if DEBUG
    private static let reviewItems: [[String: Any]] = [
        [
            "id": "open-design-redwall-v2",
            "versionNo": 2,
            "createdAt": "2026-10-19T09:12:00Z",
        ],
        [
            "id": "open-design-redwall-v1",
            "versionNo": 1,
            "createdAt": "2026-10-17T21:40:00Z",
        ],
    ]
    #endif

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
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M 月 d 日 · HH:mm"
        return formatter.string(from: date)
    }
}

private struct NoteOverviewScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var noteId: String
    @State private var overview: [String: Any]?
    @State private var task: [String: Any]?
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Text("速览")
                            .font(.system(size: 10.5, weight: .semibold))
                            .tracking(2.2)
                            .foregroundStyle(StudyPalette.accent)
                        Circle().fill(StudyPalette.paperEdge).frame(width: 3, height: 3)
                        Text("第 \(store.noteDocument?.versionNumber ?? 1) 版")
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(StudyPalette.muted)
                    }
                    Text(store.noteDocument?.title ?? "这篇手记")
                        .font(StudySerif.font(size: 23, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("主线 · 要点 · 原文依据")
                        .font(.system(size: 11.5))
                        .foregroundStyle(StudyPalette.muted)
                }
                Spacer(minLength: 0)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
                        .frame(width: 32, height: 32).background(StudyPalette.inset.opacity(0.65), in: Circle())
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("收起速览")
            }
            .padding(.horizontal, 22).padding(.top, 16).padding(.bottom, 6)
            HStack(spacing: 8) {
                AstellaGlyph(kind: .quote, tint: StudyPalette.muted.opacity(0.8))
                    .frame(width: 11, height: 11)
                Text("从原文归纳，不改动正文")
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 0)
                Text("\(store.noteDocument?.blocks.count ?? 0) 段")
                    .font(.system(size: 10))
                    .foregroundStyle(StudyPalette.muted.opacity(0.85))
            }
            .padding(.horizontal, 22).padding(.bottom, 4)
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) { featureError(failure, retry: { Task { await load() } }) }
                        if loading && overview == nil {
                            NoteFeatureLoadingState(title: "正在读取速览")
                        }
                        if working {
                            NoteFeatureLoadingState(title: taskTitle)
                        }
                        if let overview {
                            let older = overview["versionState"] as? String == "older"
                            let points = overview["points"] as? [[String: Any]] ?? []
                            if older { featureNotice("这份速览基于第 \(overview["noteVersionNumber"] as? Int ?? 1) 版，当前正文可能已经变化。") }
                            overviewSummaryCard(overview)
                            if !points.isEmpty {
                                overviewPointsCard(points)
                            }
                            if let coverage = overview["coverage"] as? [String: Any], (coverage["imageBlocksNotRead"] as? Int ?? 0) > 0 {
                                featureNotice("有图片内容没有纳入这次速览，请结合原文查看。")
                            }
                        } else if !loading && !working {
                            FeatureGenerationPrimer(kind: "overview", document: store.noteDocument)
                        }
                    }
                    .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 22)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .topLeading)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(DawnBackground())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            NoteFeatureActionDock(
                actionTitle: overview == nil ? "生成速览" : "按当前版本重新整理",
                isWorking: working,
                isAvailable: store.noteDocument != nil,
                error: failure,
                action: { Task { await generate() } }
            )
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.canUseExternalAI == true && (requiresAIConsent(failure) || requiresAIDataPolicy(failure)) { failure = nil }
        }
    }

    private func overviewSummaryCard(_ overview: [String: Any]) -> some View {
        HStack(alignment: .top, spacing: 13) {
            RoundedRectangle(cornerRadius: 2)
                .fill(StudyPalette.accent.opacity(0.45))
                .frame(width: 2.5)
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 8) {
                    AstellaGlyph(kind: .quote, tint: StudyPalette.accent).frame(width: 14, height: 14)
                    Text("核心脉络")
                        .font(.system(size: 10.5, weight: .semibold))
                        .tracking(1.6)
                        .foregroundStyle(StudyPalette.accent)
                    Spacer()
                    Text("第 \(overview["noteVersionNumber"] as? Int ?? store.noteDocument?.versionNumber ?? 1) 版")
                        .font(.system(size: 10))
                        .foregroundStyle(StudyPalette.muted)
                        .padding(.horizontal, 8)
                        .frame(height: 20)
                        .background(StudyPalette.inset.opacity(0.8), in: Capsule())
                }
                Text(overview["body"] as? String ?? "")
                    .font(StudySerif.font(size: 17.5))
                    .tracking(0.2)
                    .lineSpacing(7)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(19)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.7)
        )
    }

    private func overviewPointsCard(_ points: [[String: Any]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("要点与原文")
                    .font(StudySerif.font(size: 16, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Spacer(minLength: 0)
                Text("\(points.count) 个关键点")
                    .font(.system(size: 10))
                    .foregroundStyle(StudyPalette.muted)
            }
            .padding(.bottom, 4)
            ForEach(Array(points.enumerated()), id: \.offset) { entry in
                if entry.offset > 0 {
                    Rectangle()
                        .fill(StudyPalette.paperEdge.opacity(0.55))
                        .frame(height: 0.7)
                        .padding(.vertical, 15)
                }
                overviewPoint(entry.offset + 1, point: entry.element)
                    .padding(.top, entry.offset == 0 ? 12 : 0)
            }
        }
        .padding(19)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper.opacity(0.72), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7)
        )
    }

    private func overviewPoint(_ number: Int, point: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 11) {
                Text(String(format: "%02d", number))
                    .font(StudySerif.font(size: 15, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(StudyPalette.accent.opacity(0.85))
                    .frame(width: 24, alignment: .leading)
                Text(point["explanation"] as? String ?? "")
                    .font(.system(size: 15, weight: .medium))
                    .lineSpacing(5)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let quote = point["quote"] as? String, !quote.isEmpty {
                HStack(alignment: .top, spacing: 9) {
                    RoundedRectangle(cornerRadius: 2).fill(StudyPalette.accent.opacity(0.45)).frame(width: 2)
                    Text(quote)
                        .font(StudySerif.font(size: 13.5))
                        .lineSpacing(4.5)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 9)
                .padding(.horizontal, 11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StudyPalette.inset.opacity(0.62), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.leading, 35)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var taskTitle: String { (task?["status"] as? String) == "queued" ? "已排入整理" : "正在整理这篇手记…" }

    private func load() async {
        #if DEBUG
        if store.uiReviewMode == "note-overview" { return }
        if store.uiReviewMode == "note-overview-ready" {
            overview = [
                "noteVersionNumber": 2,
                "versionState": "current",
                "body": "《赤壁赋》从月夜泛舟写起，转入主客关于人生与天地的问答，最后以江水、明月的恒常之理化解悲意，回到开阔平静的夜色。",
                "points": [
                    ["explanation": "开篇借清风、明月与江面铺开自由开阔的夜游之境。", "quote": "清风徐来，水波不兴。"],
                    ["explanation": "客人的歌声引出对人生短促、功业无常的感慨。", "quote": "哀吾生之须臾，羡长江之无穷。"],
                    ["explanation": "苏子以江水与明月说明变化和恒常可以同时成立。", "quote": "逝者如斯，而未尝往也。"],
                ],
                "coverage": ["imageBlocksNotRead": 0],
            ] as [String: Any]
            return
        }
        #endif
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
        guard store.aiSettings?.canUseExternalAI == true,
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

private struct NoteExpansionDrawer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var noteId: String
    @State private var task: [String: Any]?
    @State private var links: [[String: Any]] = []
    @State private var drafts: [[String: Any]] = []
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?
    @State private var savedTitles: [String] = []

    private var status: String { task?["status"] as? String ?? "" }
    private var currentVersionId: String? { store.noteDocument?.versionId }
    private var selectedDraftIDs: [String] {
        drafts.compactMap { ($0["selected"] as? Bool == true) ? $0["candidateId"] as? String : nil }
    }
    private var allDraftsSelected: Bool {
        !drafts.isEmpty && drafts.allSatisfy { $0["selected"] as? Bool == true }
    }
    /// Select-all / clear-all for the ready drafts, matching the desktop picker.
    private func toggleAllDrafts() {
        let target = !allDraftsSelected
        for index in drafts.indices { drafts[index]["selected"] = target }
    }

    var body: some View {
        VStack(spacing: 0) {
            drawerHeader
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    sourceCard
                    if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) {
                        featureError(failure, retry: { Task { await load() } })
                    }
                    if requiresAIConsent(failure) || requiresAIDataPolicy(failure) {
                        NoteAIConsentNotice()
                    }
                    if !links.isEmpty { linksSection }
                    drawerContent
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 26)
            }
            .scrollIndicators(.hidden)
            drawerDock
        }
        .background(DawnBackground())
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.canUseExternalAI == true,
               requiresAIConsent(failure) || requiresAIDataPolicy(failure) { failure = nil }
        }
    }

    private var drawerHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("拓展笔记")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(StudyPalette.accent)
                Text("从这篇手记\n长出新的笔记")
                    .font(StudySerif.font(size: 22, weight: .semibold))
                    .lineSpacing(5)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(StudyPalette.muted).frame(width: 32, height: 32)
                    .background(StudyPalette.inset.opacity(0.7), in: Circle())
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("关闭拓展笔记")
        }
        .padding(.horizontal, 21).padding(.top, 16).padding(.bottom, 14)
    }

    private var sourceCard: some View {
        HStack(spacing: 10) {
            AstellaGlyph(kind: .book, tint: StudyPalette.accent)
                .frame(width: 14, height: 14)
                .frame(width: 30, height: 30)
                .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("来自这篇手记")
                    .font(.system(size: 9, weight: .semibold)).tracking(1)
                    .foregroundStyle(StudyPalette.muted)
                Text(store.noteDocument?.title ?? "当前手记")
                    .font(StudySerif.font(size: 13.5, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text("第 \(store.noteDocument?.versionNumber ?? 1) 版 · \(store.noteDocument?.blocks.count ?? 0) 段")
                .font(.system(size: 10))
                .foregroundStyle(StudyPalette.muted)
        }
        .padding(.horizontal, 11)
        .frame(height: 48)
        .background(StudyPalette.paper.opacity(0.55), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.7)
        )
    }

    @ViewBuilder private var drawerContent: some View {
        if loading && task == nil {
            expansionWaitingState(title: "正在读取拓展草稿", caption: "看看这篇手记此前生成过哪些内容。")
        } else if working || ["queued", "running"].contains(status) {
            expansionWaitingState(title: "正在围绕原文准备拓展", caption: "完成后会先给出草稿，由你挑选要收下的内容。")
        } else if status == "ready", !drafts.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("选择要收下的草稿")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text("\(drafts.count) 篇")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.horizontal, 7).frame(height: 19)
                        .background(StudyPalette.sky, in: Capsule())
                    Spacer(minLength: 0)
                    Button(allDraftsSelected ? "取消全选" : "全选") { toggleAllDrafts() }
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.horizontal, 10).frame(height: 28)
                        .background(StudyPalette.inset.opacity(0.8), in: Capsule())
                        .buttonStyle(.plain)
                }
                Text("确认后会另存为新手记，并保留与这篇原文的关系。")
                    .font(.system(size: 12)).lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
                ForEach(drafts.indices, id: \.self) { index in
                    expansionDraftCard(drafts[index], index: index)
                }
            }
        } else {
            expansionPrimer
        }
    }

    private func expansionWaitingState(title: String, caption: String) -> some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().fill(StudyPalette.sky).frame(width: 74, height: 74)
                AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent).frame(width: 26, height: 26)
                Circle().trim(from: 0, to: 0.3)
                    .stroke(StudyPalette.accent.opacity(0.6), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 88, height: 88)
                    .rotationEffect(.degrees(working || loading ? 360 : 0))
                    .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: working || loading)
            }
            Text(title).font(StudySerif.font(size: 18, weight: .semibold)).foregroundStyle(StudyPalette.ink)
            Text(caption)
                .font(.system(size: 12)).lineSpacing(4)
                .multilineTextAlignment(.center)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }

    private var expansionPrimer: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent)
                    .frame(width: 18, height: 18)
                    .frame(width: 40, height: 40)
                    .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("从原文长出下一篇手记")
                        .font(StudySerif.font(size: 17, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text("围绕当前版本准备几份草稿，你可以挑选要收下的。")
                        .font(.system(size: 11.5)).lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                }
            }
            VStack(spacing: 0) {
                primerStep(number: "01", title: "先看草稿", caption: "每篇都展示它和原文的关系与引用。")
                Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7).padding(.leading, 38)
                primerStep(number: "02", title: "自己挑选", caption: "确认后另存为新手记，原文不动。")
                Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7).padding(.leading, 38)
                primerStep(number: "03", title: "留下联系", caption: "之后可以从任一篇跳回另一篇。")
            }
            .padding(.vertical, 2)
            .background(StudyPalette.inset.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .padding(16)
        .modifier(StudyGlassSurfaceStyle(radius: 20))
    }

    private func primerStep(number: String, title: String, caption: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(StudyPalette.accent)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text(caption).font(.system(size: 10.5)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private var linksSection: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 8) {
                Text("已经长出的手记")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text("\(links.count) 篇")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 7).frame(height: 19)
                    .background(StudyPalette.inset, in: Capsule())
                Spacer(minLength: 0)
            }
            ForEach(links.indices, id: \.self) { index in expansionLinkRow(links[index]) }
        }
        .padding(.top, 4)
    }

    @ViewBuilder private var drawerDock: some View {
        if ["queued", "running"].contains(status) {
            EmptyView()
        } else {
            VStack(spacing: 7) {
                Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
                if status == "ready", !drafts.isEmpty {
                    NoteFeatureActionDock(
                        actionTitle: "收下已选拓展 · \(selectedDraftIDs.count)",
                        isWorking: working,
                        isAvailable: !selectedDraftIDs.isEmpty,
                        error: failure,
                        action: { Task { await confirmSelected() } }
                    )
                    Text("收下后会另存为新手记，保留与原文的关系。")
                        .font(.system(size: 10)).foregroundStyle(StudyPalette.muted)
                } else {
                    NoteFeatureActionDock(
                        actionTitle: task == nil ? "生成拓展草稿" : "再生成一组草稿",
                        isWorking: working,
                        isAvailable: store.noteDocument != nil,
                        error: failure,
                        action: { Task { await generate() } }
                    )
                    Text("生成需要一点时间，可以先回原文继续读。")
                        .font(.system(size: 10)).foregroundStyle(StudyPalette.muted)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
        }
    }

    private func expansionDraftCard(_ draft: [String: Any], index: Int) -> some View {
        let selected = draft["selected"] as? Bool == true
        let refs = draft["sourceReferences"] as? [[String: Any]] ?? []
        let blocks = draft["blocks"] as? [[String: Any]] ?? []
        return Button {
            drafts[index]["selected"] = !selected
        } label: {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .top, spacing: 11) {
                    ZStack {
                        Circle()
                            .fill(selected ? StudyPalette.accent : Color.clear)
                            .overlay(Circle().stroke(selected ? Color.clear : StudyPalette.paperEdge, lineWidth: 1.2))
                            .frame(width: 23, height: 23)
                        if selected {
                            AstellaGlyph(kind: .check, tint: StudyPalette.paper).frame(width: 12, height: 12)
                        }
                    }
                    .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(draft["title"] as? String ?? "未命名拓展")
                            .font(StudySerif.font(size: 16.5, weight: .semibold))
                            .lineSpacing(3)
                            .foregroundStyle(StudyPalette.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if let relationship = draft["relationship"] as? String, !relationship.isEmpty {
                            Text(relationship)
                                .font(.system(size: 11.5)).lineSpacing(4)
                                .foregroundStyle(StudyPalette.muted)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    Text("草稿 \(index + 1)")
                        .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(StudyPalette.muted)
                        .padding(.horizontal, 7).frame(height: 18)
                        .background(StudyPalette.inset, in: Capsule())
                }
                if !refs.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(refs.indices, id: \.self) { refIndex in
                            HStack(alignment: .top, spacing: 8) {
                                AstellaGlyph(kind: .quote, tint: StudyPalette.accent.opacity(0.7)).frame(width: 11, height: 11)
                                Text(refs[refIndex]["quote"] as? String ?? "")
                                    .font(.system(size: 11.5)).lineSpacing(4)
                                    .foregroundStyle(StudyPalette.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(.leading, 34)
                }
                if !blocks.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("正文预览")
                            .font(.system(size: 9.5, weight: .semibold)).tracking(1)
                            .foregroundStyle(StudyPalette.muted)
                        Text(blocks.compactMap { $0["content"] as? String }.joined(separator: "\n\n"))
                            .font(.system(size: 12)).lineSpacing(4.5)
                            .foregroundStyle(StudyPalette.ink.opacity(0.9))
                            .lineLimit(6)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(StudyPalette.inset.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(.leading, 34)
                }
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? StudyPalette.sky.opacity(0.32) : StudyPalette.paper.opacity(0.72),
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(selected ? StudyPalette.accent.opacity(0.7) : StudyPalette.paperEdge, lineWidth: selected ? 1.2 : 0.7))
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityLabel("\(selected ? "已选择" : "未选择")拓展：\(draft["title"] as? String ?? "草稿 \(index + 1)")")
    }

    private func expansionLinkRow(_ item: [String: Any]) -> some View {
        let targetId = item["direction"] as? String == "source_note" ? item["sourceNoteId"] as? String : item["expandedNoteId"] as? String
        let fromHere = item["direction"] as? String != "source_note"
        return Button {
            if let targetId { store.requestNoteReference(targetId); dismiss() }
        } label: {
            HStack(spacing: 12) {
                AstellaGlyph(kind: .book, tint: StudyPalette.accent)
                    .frame(width: 17, height: 17)
                    .frame(width: 36, height: 36)
                    .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item["otherNoteTitle"] as? String ?? "拓展手记")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text(fromHere ? "由这篇拓展" : "来自另一篇")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(StudyPalette.accent)
                            .padding(.horizontal, 6).frame(height: 17)
                            .background(StudyPalette.sky, in: Capsule())
                        Text("第 \(item["direction"] as? String == "source_note" ? item["sourceNoteVersionNumber"] as? Int ?? 1 : item["expandedNoteVersionNumber"] as? Int ?? 1) 版")
                            .font(.system(size: 10))
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                Spacer(minLength: 0)
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12)
            }
            .padding(12)
            .modifier(StudyGlassSurfaceStyle(radius: 17, interactive: true))
        }.buttonStyle(AstellaPressStyle())
    }

    private func load() async {
        #if DEBUG
        if let fixture = store.uiReviewMode, fixture.hasPrefix("note-expansion") {
            task = Self.reviewTask; drafts = Self.reviewDrafts
            if fixture == "note-expansion-saved" { links = Self.reviewLinks }
            return
        }
        #endif
        guard let versionId = currentVersionId else { return }
        loading = true; failure = nil
        defer { loading = false }
        do {
            let page = try await store.noteExpansions(noteId: noteId)
            links = page["items"] as? [[String: Any]] ?? []
            savedTitles = links.compactMap { $0["otherNoteTitle"] as? String }
            let receipt = try await store.latestNoteExpansionTask(noteId: noteId, noteVersionId: versionId)
            if let latest = receipt["task"] as? [String: Any] { task = latest; drafts = latest["drafts"] as? [[String: Any]] ?? [] }
            if let latest = task, ["queued", "running"].contains(latest["status"] as? String ?? "") { await poll(latest) }
        } catch { failure = noteFeatureFailure(error) }
    }

    #if DEBUG
    private static let reviewDrafts: [[String: Any]] = [
        [
            "candidateId": "10000000-0000-0000-0000-000000000001",
            "requestId": "20000000-0000-0000-0000-000000000001",
            "title": "风与水：赤壁赋里的安静从哪来",
            "relationship": "从开篇的江上夜游接出去，把“清风徐来，水波不兴”的静与后面的箫声、问答连成一条线。",
            "sourceReferences": [["blockOrdinal": 1, "quote": "清风徐来，水波不兴。"]],
            "blocks": [
                ["type": "paragraph", "content": "苏轼先写风，再写水。风是“徐来”，水是“不兴”，两句都没有用重笔，却把整个夜游的底色定下来了。"],
                ["type": "heading", "content": "一、安静不是空白"],
                ["type": "paragraph", "content": "安静在这里不是什么都没有，而是让人有余地听见后面的箫声。正因为它先静下来，客人的愁才有地方落。"],
            ],
            "selected": true,
        ],
        [
            "candidateId": "10000000-0000-0000-0000-000000000002",
            "requestId": "20000000-0000-0000-0000-000000000002",
            "title": "从乐到悲：一次宴饮里的转折",
            "relationship": "抓住“饮酒乐甚”到“苏子愀然”的转折，整理情绪变化的几个落点。",
            "sourceReferences": [["blockOrdinal": 2, "quote": "客有吹洞箫者，倚歌而和之。"]],
            "blocks": [
                ["type": "paragraph", "content": "前半段还在扣舷而歌，洞箫一进来，气氛就沉下去了。转折并不突兀，它藏在歌声和箫声的接续里。"],
            ],
            "selected": false,
        ],
    ]
    private static let reviewTask: [String: Any] = [
        "taskId": "30000000-0000-0000-0000-000000000001",
        "noteId": "open-design-redwall",
        "noteVersionId": "open-design-redwall-v2",
        "status": "ready",
        "drafts": reviewDrafts,
        "confirmedCandidateIds": NSNull(),
        "failureReason": NSNull(),
        "createdAt": "2026-10-21T09:20:00Z",
    ]
    private static let reviewLinks: [[String: Any]] = [[
        "expansionId": "40000000-0000-0000-0000-000000000001",
        "sourceNoteId": "open-design-redwall",
        "sourceNoteVersionId": "open-design-redwall-v2",
        "sourceNoteVersionNumber": 2,
        "expandedNoteId": "50000000-0000-0000-0000-000000000001",
        "expandedNoteVersionId": "60000000-0000-0000-0000-000000000001",
        "expandedNoteVersionNumber": 1,
        "otherNoteTitle": "风与水：赤壁赋里的安静从哪来",
        "direction": "expanded_from_here",
        "createdAt": "2026-10-21T09:24:00Z",
    ]]
    #endif

    private func generate() async {
        guard store.aiSettings?.canUseExternalAI == true,
              let versionId = currentVersionId else { return }
        working = true; failure = nil
        defer { working = false }
        do { task = try await store.createNoteExpansionTask(noteId: noteId, noteVersionId: versionId); await poll(task ?? [:]) }
        catch {
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
                let value = try await store.noteExpansionTask(noteId: noteId, taskId: taskId)
                task = value; drafts = value["drafts"] as? [[String: Any]] ?? []
                let state = value["status"] as? String ?? ""
                if state == "ready" || state == "confirmed" { working = false; return }
                if state == "failed" { failure = failureLabel(value["failureReason"] as? String); working = false; return }
                try await Task.sleep(for: .seconds(2))
            } catch { failure = noteFeatureFailure(error); working = false; return }
        }
        working = false; failure = "拓展仍在后台准备，稍后重新打开这里即可继续挑选。"
    }

    private func confirmSelected() async {
        guard let taskId = task?["taskId"] as? String, !selectedDraftIDs.isEmpty else { return }
        working = true; failure = nil
        defer { working = false }
        do {
            let saved = try await store.reviewNoteExpansionTask(noteId: noteId, taskId: taskId, drafts: drafts)
            task = saved; drafts = saved["drafts"] as? [[String: Any]] ?? drafts
            let result = try await store.confirmNoteExpansionTask(noteId: noteId, taskId: taskId, candidateIds: selectedDraftIDs)
            links = result + links
            savedTitles = links.compactMap { $0["otherNoteTitle"] as? String }
            task?["status"] = "confirmed"
            task?["confirmedCandidateIds"] = selectedDraftIDs
        } catch { failure = noteFeatureFailure(error) }
    }
}

private struct NoteAIConsentNotice: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AstellaGlyph(kind: .info, tint: StudyPalette.accent).frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 5) {
                Text("这项整理需要你的授权").font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text("请先在「我的 → AI 与数据」阅读协议，并允许发送笔记内容。")
                    .font(.system(size: 12)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                NoteAISettingsButton {
                    Text("查看 AI 使用设置").font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                }
            }
        }.padding(14).modifier(StudyGlassSurfaceStyle(radius: 17))
    }
}

private struct NoteLearningCardScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    let noteId: String
    let title: String
    @State private var card: [String: Any]?
    @State private var attempts: [[String: Any]] = []
    @State private var activeAttempt: [String: Any]?
    @State private var resultAttempt: [String: Any]?
    @State private var answers: [String: Any] = [:]
    @State private var pendingAnswers: [String: Any] = [:]
    @State private var scene = "front"
    @State private var index = 0
    @State private var questionCount = 6
    @State private var replayingOperationQuestionId: String?
    @State private var loading = true
    @State private var generating = false
    @State private var busy = false
    @State private var saving = false
    @State private var failure: String?
    @State private var saveTask: Task<Void, Never>?
    @State private var resultFilter = "all"
    @State private var expandedQuestions: Set<String> = []
    @State private var resultLitStars = 0
    @State private var displayedScore: Double = 0
    @State private var gradingSpin = false
    @State private var slideForward = true

    private var questions: [[String: Any]] { card?["questions"] as? [[String: Any]] ?? [] }
    private var question: [String: Any]? { questions.indices.contains(index) ? questions[index] : nil }
    private var cardId: String? { card?["cardId"] as? String }
    private var bestScore: Int? { card?["bestScore"] as? Int }
    private var bestStars: Int? { card?["bestStars"] as? Int }
    private var completedCount: Int { attempts.filter { $0["status"] as? String == "completed" }.count }
    private var answeredCount: Int {
        questions.filter { question in
            let answer = answers[question["questionId"] as? String ?? ""]
            return hasAnswer(question, answer) || (answer as? [String: Any])?["skipped"] as? Bool == true
        }.count
    }

    // MARK: - Page chrome

    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                switch scene {
                case "setup": setupScene
                case "practice": practiceScene
                case "grading": gradingScene
                case "result": resultScene
                default: frontScene
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(DawnBackground())
        .task { await load() }
        .onDisappear { saveTask?.cancel() }
        .confirmationDialog("结束这次练习？", isPresented: Binding(
            get: { scene == "practice" && showSubmitConfirmation },
            set: { if !$0 { showSubmitConfirmation = false } }
        ), titleVisibility: .visible) {
            Button("交卷并批改") { showSubmitConfirmation = false; Task { await submit() } }
            Button("继续作答", role: .cancel) { showSubmitConfirmation = false }
        } message: {
            Text("未完成的题目会记为跳过。交卷后才能查看答案、原文依据和批改结果。")
        }
        .onChange(of: scene) { _, value in
            if value == "result" { prepareResultMotion() }
            if value == "front" { resetResultMotion() }
        }
    }

    @State private var showSubmitConfirmation = false

    private var header: some View {
        HStack(spacing: 12) {
            Button { Task { await close() } } label: {
                AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                    .frame(width: 18, height: 18)
                    .frame(width: 42, height: 42)
                    .modifier(StudyGlassSurfaceStyle(radius: 21, interactive: true))
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("返回手记")

            VStack(alignment: .leading, spacing: 3) {
                Text("学习卡")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(StudyPalette.muted)
                Text(title)
                    .font(StudySerif.font(size: 17, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if saving {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).tint(StudyPalette.accent)
                    Text("保存中").font(.system(size: 10)).foregroundStyle(StudyPalette.muted)
                }
            } else if !questions.isEmpty, scene == "practice" {
                Text("\(answeredCount)/\(questions.count)")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.horizontal, 10).frame(height: 26)
                    .background(StudyPalette.sky, in: Capsule())
            }
        }
        .padding(.horizontal, 19)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    // MARK: - Front

    private var versionNumber: Int {
        (card?["versionNo"] as? Int) ?? store.noteDocument?.versionNumber ?? 1
    }

    private var frontScene: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) {
                    featureError(failure, retry: { Task { await load() } })
                }
                if loading {
                    cardLoadingState
                } else if generating {
                    cardGeneratingState
                } else if card == nil {
                    cardEmptyState
                } else {
                    cardHeroSection
                    cardPrimaryAction
                    cardSecondaryRows
                }
                if card != nil, !loading, !generating {
                    regenerateLink
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 38)
        }
        .scrollIndicators(.hidden)
    }

    private var cardHeroSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("学习卡")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(StudyPalette.accent)
                Spacer(minLength: 0)
                Text("第 \(versionNumber) 版 · \(questions.count) 道题")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 9).frame(height: 22)
                    .background(StudyPalette.inset, in: Capsule())
            }

            Text(title)
                .font(StudySerif.font(size: 25, weight: .semibold))
                .tracking(0.4)
                .lineSpacing(4)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)

            HStack(spacing: 10) {
                LearningCardStars(stars: bestStars, size: 17, animated: true, reduceMotion: reduced)
                Text(bestStars == nil ? "还没有点亮星级" : "最佳 \(bestStars ?? 0) 星")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
            }
            .padding(.top, 12)

            Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
                .padding(.vertical, 18)

            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(bestScore.map(String.init) ?? "—")
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                    .tracking(-1.5)
                    .foregroundStyle(StudyPalette.ink)
                    .contentTransition(.numericText())
                Text("分")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("最佳得分")
                        .font(.system(size: 10.5, weight: .medium))
                        .tracking(0.8)
                        .foregroundStyle(StudyPalette.muted)
                    Text(completedCount > 0 ? "保留每一次认真尝试" : "等一次认真尝试")
                        .font(.system(size: 10.5))
                        .foregroundStyle(StudyPalette.muted.opacity(0.85))
                }
            }

            HStack(spacing: 0) {
                heroStatCell("最佳星级", bestStars.map { "\($0) / 5" } ?? "—")
                heroStatDivider
                heroStatCell("练习次数", "\(completedCount)")
                heroStatDivider
                heroStatCell("题目数", questions.isEmpty ? "—" : "\(questions.count) 题")
            }
            .padding(.top, 18)
        }
        .padding(21)
        .modifier(StudyGlassSurfaceStyle(radius: 26))
    }

    private var heroStatDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.7)).frame(width: 0.7, height: 30)
    }

    private func heroStatCell(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(StudyPalette.ink)
            Text(label)
                .font(.system(size: 10))
                .tracking(0.4)
                .foregroundStyle(StudyPalette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, label == "最佳星级" ? 0 : 14)
    }

    private var latestCompletedAttempt: [String: Any]? {
        attempts.first { $0["status"] as? String == "completed" }
    }

    @ViewBuilder private var cardPrimaryAction: some View {
        let resuming = activeAttempt.map { ["in_progress", "grading_failed"].contains($0["status"] as? String ?? "") } ?? false
        Button {
            Task {
                if let activeAttempt, activeAttempt["status"] as? String == "grading_failed" {
                    await submit(retry: true)
                } else if resuming {
                    withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "practice" }
                } else {
                    await startAttempt()
                }
            }
        } label: {
            HStack(spacing: 10) {
                AstellaGlyph(kind: resuming ? .play : .sparkle, tint: StudyPalette.paper)
                    .frame(width: 17, height: 17)
                Text(resuming ? (activeAttempt?["status"] as? String == "grading_failed" ? "重新批改" : "继续作答") : (completedCount > 0 ? "再练一次" : "开始练习"))
                Spacer(minLength: 0)
                if resuming {
                    Text("已答 \(answeredCount)/\(questions.count)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(StudyPalette.paper.opacity(0.8))
                } else if !questions.isEmpty {
                    Text("\(questions.count) 道题")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(StudyPalette.paper.opacity(0.8))
                }
            }
        }
        .modifier(PrimaryActionStyle())
        .disabled(busy || questions.isEmpty)
        .accessibilityHint("一题一页，交卷后展开答案与原文依据")
    }

    private var cardSecondaryRows: some View {
        VStack(spacing: 10) {
            if let latest = latestCompletedAttempt {
                Button {
                    resultAttempt = latest
                    withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "result" }
                } label: {
                    HStack(spacing: 13) {
                        AstellaGlyph(kind: .history, tint: StudyPalette.accent)
                            .frame(width: 17, height: 17)
                            .frame(width: 38, height: 38)
                            .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text("最近一次练习")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(StudyPalette.ink)
                            Text("\(latest["score"] as? Int ?? 0) 分 · \(attemptDate(latest["completedAt"] as? String ?? latest["startedAt"] as? String))")
                                .font(.system(size: 11))
                                .foregroundStyle(StudyPalette.muted)
                        }
                        Spacer(minLength: 0)
                        Text("查看回看")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(StudyPalette.accent)
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12)
                    }
                    .padding(13)
                    .modifier(StudyGlassSurfaceStyle(radius: 18, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
            }
            if activeAttempt?["status"] as? String == "in_progress" {
                Text("草稿会自动保存，下次回来可以继续。")
                    .font(.system(size: 11))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 4)
            }
        }
    }

    private var regenerateLink: some View {
        Button {
            withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "setup" }
        } label: {
            HStack(spacing: 7) {
                AstellaGlyph(kind: .refresh, tint: StudyPalette.muted).frame(width: 13, height: 13)
                Text("按当前笔记版本重新生成")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    private var cardLoadingState: some View {
        cardCenterState(glyph: .book, title: "正在打开学习卡", caption: "读取这张卡与最近的练习记录…", showsSpinner: true)
    }

    private var cardGeneratingState: some View {
        VStack(spacing: 18) {
            cardCenterState(glyph: .sparkle, title: "正在制作你的学习卡", caption: "读取原文、搭配题型，再逐题核对依据。只有通过校验的题目才会收进这张卡。", showsSpinner: true)
            Button("刷新状态") { Task { await load() } }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(StudyPalette.accent)
        }
    }

    private func cardCenterState(glyph: AstellaGlyphKind, title: String, caption: String, showsSpinner: Bool) -> some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(StudyPalette.sky).frame(width: 86, height: 86)
                AstellaGlyph(kind: glyph, tint: StudyPalette.accent).frame(width: 30, height: 30)
                if showsSpinner {
                    Circle().trim(from: 0, to: 0.32)
                        .stroke(StudyPalette.accent.opacity(0.6), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: 100, height: 100)
                        .rotationEffect(.degrees(generating || loading ? 360 : 0))
                        .animation(reduced ? nil : .linear(duration: 1.1).repeatForever(autoreverses: false), value: generating || loading)
                }
            }
            Text(title).font(StudySerif.font(size: 21, weight: .semibold)).foregroundStyle(StudyPalette.ink)
            Text(caption)
                .font(.system(size: 12.5)).lineSpacing(4)
                .multilineTextAlignment(.center)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 18)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var cardEmptyState: some View {
        VStack(alignment: .leading, spacing: 18) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(StudyPalette.sky.opacity(0.65))
                    .frame(width: 150, height: 104)
                    .rotationEffect(.degrees(-7))
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(StudyPalette.paper)
                    .frame(width: 150, height: 104)
                    .rotationEffect(.degrees(4))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.8))
                VStack(spacing: 8) {
                    AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent).frame(width: 26, height: 26)
                    Text("第一张学习卡")
                        .font(.system(size: 10, weight: .semibold)).tracking(1.6)
                        .foregroundStyle(StudyPalette.muted)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)

            Text("把这篇手记\n变成可以练习的题")
                .font(StudySerif.font(size: 24, weight: .semibold))
                .lineSpacing(6)
                .foregroundStyle(StudyPalette.ink)

            Text("围绕当前保存的版本出题，一题一页，每道题都能回到原文核对。")
                .font(.system(size: 13)).lineSpacing(5)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)

            cardPromiseRows

            Button {
                withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "setup" }
            } label: {
                HStack(spacing: 9) {
                    AstellaGlyph(kind: .sparkle, tint: StudyPalette.paper).frame(width: 17, height: 17)
                    Text("准备学习卡")
                }
            }
            .modifier(PrimaryActionStyle())
            .disabled(store.noteDocument == nil)
            .padding(.top, 2)
        }
    }

    private var cardPromiseRows: some View {
        VStack(spacing: 0) {
            promiseRow(glyph: .book, title: "围绕原文出题", caption: "每道题都标注可核对的原文依据")
            promiseDivider
            promiseRow(glyph: .document, title: "一页一题", caption: "可以自由跳题，草稿自动保存")
            promiseDivider
            promiseRow(glyph: .sparkle, title: "分数与星级", caption: "全部题目等权计分，星级保留最佳一次")
        }
        .modifier(StudyGlassSurfaceStyle(radius: 20))
    }

    private var promiseDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7).padding(.leading, 50)
    }

    private func promiseRow(glyph: AstellaGlyphKind, title: String, caption: String) -> some View {
        HStack(spacing: 12) {
            AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
                .frame(width: 17, height: 17)
                .frame(width: 34, height: 34)
                .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                Text(caption).font(.system(size: 10.5)).foregroundStyle(StudyPalette.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13).padding(.vertical, 11)
    }

    // MARK: - Setup

    private var setupScene: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("准备一张新的学习卡")
                        .font(StudySerif.font(size: 24, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text("会根据已保存的笔记版本搭配题目，完成后回到卡面开始练习。")
                        .font(.system(size: 12.5)).lineSpacing(4)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if requiresAIConsent(failure) || requiresAIDataPolicy(failure) { NoteAIConsentNotice() }

                VStack(alignment: .leading, spacing: 10) {
                    Text("这次准备多少道题")
                        .font(.system(size: 11, weight: .semibold)).tracking(0.8)
                        .foregroundStyle(StudyPalette.muted)
                    HStack(spacing: 10) {
                        ForEach([4, 6, 8], id: \.self) { value in
                            Button { questionCount = value } label: {
                                VStack(spacing: 5) {
                                    Text("\(value)")
                                        .font(.system(size: 26, weight: .semibold, design: .rounded))
                                        .foregroundStyle(questionCount == value ? StudyPalette.accent : StudyPalette.ink)
                                    Text(value == 4 ? "轻试" : value == 6 ? "刚好" : "深入")
                                        .font(.system(size: 10.5, weight: .medium))
                                        .foregroundStyle(questionCount == value ? StudyPalette.accent : StudyPalette.muted)
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 84)
                                .background(questionCount == value ? StudyPalette.sky : StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(questionCount == value ? StudyPalette.accent.opacity(0.85) : StudyPalette.paperEdge, lineWidth: questionCount == value ? 1.2 : 0.7))
                            }
                            .buttonStyle(AstellaPressStyle())
                        }
                    }
                }

                cardPromiseRows
                Spacer(minLength: 0)
                Button { Task { await generate() } } label: {
                    HStack(spacing: 9) {
                        if busy { ProgressView().tint(StudyPalette.paper) }
                        else { AstellaGlyph(kind: .sparkle, tint: StudyPalette.paper).frame(width: 17, height: 17) }
                        Text(busy ? "正在创建…" : "生成学习卡")
                    }
                }
                .modifier(PrimaryActionStyle())
                .disabled(busy || store.noteDocument?.versionId == nil)
                .padding(.top, 4)
                if card != nil {
                    Button("先看已有学习卡") {
                        withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "front" }
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: - Practice

    private func questionTypeLabel(_ type: String) -> String {
        ["single_choice": "单选", "multi_choice": "多选", "true_false": "判断", "fill_blank": "填空",
         "short_answer": "简答", "ordering": "排序", "matching": "配对", "operation": "操作"][type] ?? "练习"
    }

    private var practiceScene: some View {
        VStack(spacing: 0) {
            practiceProgressHeader
            if let question {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(question["stem"] as? String ?? "")
                            .font(StudySerif.font(size: 21, weight: .medium))
                            .lineSpacing(8)
                            .foregroundStyle(StudyPalette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(answerHint(question))
                            .font(.system(size: 12))
                            .foregroundStyle(StudyPalette.muted)
                        if isSkipped(question) {
                            skippedNotice(question)
                        }
                        answerEditor(question)
                    }
                    .padding(.horizontal, 21)
                    .padding(.top, 18)
                    .padding(.bottom, 26)
                    .id(index)
                    .transition(reduced ? .opacity : .asymmetric(
                        insertion: .move(edge: slideForward ? .trailing : .leading).combined(with: .opacity),
                        removal: .move(edge: slideForward ? .leading : .trailing).combined(with: .opacity)
                    ))
                }
                .scrollIndicators(.hidden)
                .animation(Motion.gated(reduced, Motion.segment), value: index)
                practiceDock(question)
            }
        }
    }

    private var practiceProgressHeader: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                if let question {
                    Text(questionTypeLabel(question["type"] as? String ?? ""))
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(1)
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.horizontal, 9).frame(height: 21)
                        .background(StudyPalette.sky, in: Capsule())
                }
                Text("第 \(index + 1) / \(questions.count) 题")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 0)
                Text("答案与原文在交卷后展开")
                    .font(.system(size: 10))
                    .foregroundStyle(StudyPalette.muted.opacity(0.85))
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(StudyPalette.inset).frame(height: 4)
                    Capsule().fill(StudyPalette.accent)
                        .frame(width: max(6, proxy.size.width * CGFloat(index + 1) / CGFloat(max(questions.count, 1))), height: 4)
                }
            }
            .frame(height: 4)
        }
        .padding(.horizontal, 21)
        .padding(.top, 4)
        .padding(.bottom, 10)
    }

    private func skippedNotice(_ question: [String: Any]) -> some View {
        HStack(spacing: 9) {
            AstellaGlyph(kind: .info, tint: StudyPalette.muted).frame(width: 15, height: 15)
            Text("这题暂时跳过了，草稿仍为你保留。")
                .font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
            Spacer(minLength: 0)
            if let draft = (answers[question["questionId"] as? String ?? ""] as? [String: Any])?["draft"], !(draft is NSNull) {
                Button("回到作答") {
                    changeAnswer(question["questionId"] as? String ?? "", draft)
                }
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(StudyPalette.accent)
            }
        }
        .padding(12)
        .background(StudyPalette.inset.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func practiceDock(_ question: [String: Any]) -> some View {
        VStack(spacing: 0) {
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
            HStack(spacing: 10) {
                Button("上一题") { goToQuestion(index - 1) }
                    .modifier(SecondaryActionStyle())
                    .disabled(index == 0 || busy)
                Button("先跳过") {
                    let id = question["questionId"] as? String ?? ""
                    changeAnswer(id, ["skipped": true, "draft": answers[id] ?? NSNull()])
                    goToQuestion(index + 1)
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(StudyPalette.muted)
                .lineLimit(1)
                .fixedSize()
                .disabled(busy)
                Button(index == questions.count - 1 ? "检查并交卷" : "下一题") {
                    if index == questions.count - 1 { showSubmitConfirmation = true } else { goToQuestion(index + 1) }
                }
                .modifier(PrimaryActionStyle())
                .disabled(busy)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(.ultraThinMaterial)
        }
    }

    private func goToQuestion(_ target: Int) {
        guard questions.indices.contains(target) else {
            if target >= questions.count { showSubmitConfirmation = true }
            return
        }
        slideForward = target >= index
        withAnimation(Motion.gated(reduced, Motion.segment)) { index = target }
    }

    private func answerHint(_ question: [String: Any]) -> String {
        switch question["type"] as? String ?? "" {
        case "single_choice", "true_false": "选择你认为正确的一项。"
        case "multi_choice": "选出所有符合题意的选项。"
        case "fill_blank": "按原文补全空白，可以只写关键词。"
        case "short_answer": "用自己的话回答，可以先写下想到的关键词。"
        case "ordering": "按原文出现的先后顺序依次点选。"
        case "matching": "为每一项选择对应的解释。"
        case "operation": "在下方操作区域完成题目要求。"
        default: "按你的理解作答。"
        }
    }

    // MARK: - Grading

    private var gradingScene: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(StudyPalette.sky).frame(width: 92, height: 92)
                AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent).frame(width: 30, height: 30)
                Circle().trim(from: 0, to: 0.3)
                    .stroke(StudyPalette.accent.opacity(0.65), style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    .frame(width: 108, height: 108)
                    .rotationEffect(.degrees(gradingSpin ? 360 : 0))
                    .animation(reduced ? nil : .linear(duration: 1.2).repeatForever(autoreverses: false), value: gradingSpin)
            }
            .onAppear { gradingSpin = true }
            .onDisappear { gradingSpin = false }

            Text("正在批改这次练习")
                .font(StudySerif.font(size: 21, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
            Text("客观题自动核对，简答会对照原文依据逐题评分。\n答案与草稿都不会丢失，请稍等片刻。")
                .font(.system(size: 12.5)).lineSpacing(5)
                .multilineTextAlignment(.center)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 30)
            Button("刷新状态") { Task { await pollGrading() } }
                .modifier(SecondaryActionStyle())
                .frame(maxWidth: 190)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 30)
    }

    // MARK: - Result

    @ViewBuilder private var resultScene: some View {
        if let resultAttempt {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    resultHero(resultAttempt)
                    resultStats(resultAttempt)
                    resultFilters(resultAttempt)
                    VStack(spacing: 10) {
                        ForEach(filteredQuestions(resultAttempt), id: \.self) { qIndex in
                            resultReviewCard(resultAttempt, qIndex: qIndex)
                        }
                        if filteredQuestions(resultAttempt).isEmpty {
                            Text(resultFilter == "wrong" ? "这次没有需要回看的题目。" : "这次没有跳过的题目。")
                                .font(.system(size: 12))
                                .foregroundStyle(StudyPalette.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 12)
                        }
                    }
                    resultSummary(resultAttempt)
                    resultActions
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        } else {
            cardCenterState(glyph: .history, title: "正在整理这次的结果", caption: "逐题核对作答与原文依据…", showsSpinner: true)
        }
    }

    private func resultHero(_ result: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("本次练习")
                    .font(.system(size: 10.5, weight: .semibold)).tracking(2)
                    .foregroundStyle(StudyPalette.accent)
                Spacer(minLength: 0)
                Text(statusSummary(result))
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
            }
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(Int(displayedScore.rounded()))")
                    .font(.system(size: 62, weight: .bold, design: .rounded))
                    .tracking(-2)
                    .foregroundStyle(StudyPalette.ink)
                    .contentTransition(.numericText())
                Text("分")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("最佳 \(bestScore ?? result["score"] as? Int ?? 0) 分")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                    Text("最佳 \(bestStars ?? result["stars"] as? Int ?? 0) 星")
                        .font(.system(size: 10.5))
                        .foregroundStyle(StudyPalette.muted)
                }
            }
            .padding(.top, 10)
            HStack(spacing: 10) {
                LearningCardStars(stars: result["stars"] as? Int, size: 22, animated: true, reduceMotion: reduced, litOverride: resultLitStars)
                Text("点亮 \(resultLitStars) 星")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(StudyPalette.accent)
            }
            .padding(.top, 14)
            Text(celebrateLine(result))
                .font(.system(size: 12.5)).lineSpacing(4)
                .foregroundStyle(StudyPalette.muted)
                .padding(.top, 10)
        }
        .padding(21)
        .modifier(StudyGlassSurfaceStyle(radius: 26))
    }

    private func celebrateLine(_ result: [String: Any]) -> String {
        let score = result["score"] as? Int ?? 0
        if score >= 90 { return "这一遍很稳，答案与原文基本对上了。" }
        if score >= 60 { return "已经抓住大部分要点，回看几处就能更稳。" }
        return "完成了就是一步，先看看哪些地方值得再读一遍。"
    }

    private func statusSummary(_ result: [String: Any]) -> String {
        let skipped = resultSkippedCount(result)
        return skipped > 0 ? "跳过 \(skipped) 题" : "全部作答"
    }

    private func resultStats(_ result: [String: Any]) -> some View {
        HStack(spacing: 0) {
            resultStatCell("答对", "\(resultCounts(result).correct)")
            heroStatDivider
            resultStatCell("待回看", "\(resultCounts(result).partial + resultCounts(result).wrong)")
            heroStatDivider
            resultStatCell("跳过", "\(resultCounts(result).skipped)")
        }
        .padding(.vertical, 15).padding(.horizontal, 6)
        .modifier(StudyGlassSurfaceStyle(radius: 20))
    }

    private func resultStatCell(_ label: String, _ value: String) -> some View {
        VStack(spacing: 5) {
            Text(value).font(.system(size: 20, weight: .semibold, design: .rounded)).foregroundStyle(StudyPalette.ink)
            Text(label).font(.system(size: 10)).tracking(0.4).foregroundStyle(StudyPalette.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func resultFilters(_ result: [String: Any]) -> some View {
        let counts = resultCounts(result)
        return HStack(spacing: 8) {
            filterChip("全部", count: questions.count, id: "all")
            filterChip("错题", count: counts.partial + counts.wrong, id: "wrong")
            filterChip("跳过", count: counts.skipped, id: "skipped")
        }
    }

    private func filterChip(_ title: String, count: Int, id: String) -> some View {
        Button {
            withAnimation(Motion.gated(reduced, Motion.segment)) { resultFilter = id }
        } label: {
            HStack(spacing: 6) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(resultFilter == id ? StudyPalette.accentLabel.opacity(0.8) : StudyPalette.muted)
            }
            .foregroundStyle(resultFilter == id ? StudyPalette.accentLabel : StudyPalette.ink)
            .padding(.horizontal, 13)
            .frame(height: 34)
            .background(resultFilter == id ? StudyPalette.accent : StudyPalette.paper, in: Capsule())
            .overlay(Capsule().stroke(resultFilter == id ? Color.clear : StudyPalette.paperEdge, lineWidth: 0.7))
        }
        .buttonStyle(AstellaPressStyle())
    }

    private func filteredQuestions(_ result: [String: Any]) -> [Int] {
        questions.indices.filter { qIndex in
            let outcome = resultOutcome(result, qIndex: qIndex)
            switch resultFilter {
            case "wrong": return outcome == "partial" || outcome == "wrong"
            case "skipped": return outcome == "skipped"
            default: return true
            }
        }
    }

    private func resultReviewCard(_ result: [String: Any], qIndex: Int) -> some View {
        let q = questions[qIndex]
        let qid = q["questionId"] as? String ?? ""
        let receipt = (result["answers"] as? [[String: Any]] ?? []).first { $0["questionId"] as? String == qid }
        let outcome = resultOutcome(result, qIndex: qIndex)
        let expanded = expandedQuestions.contains(qid)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.gated(reduced, Motion.segment)) {
                    if expanded { expandedQuestions.remove(qid) } else { expandedQuestions.insert(qid) }
                }
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Text(String(format: "%02d", qIndex + 1))
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(StudyPalette.muted)
                        .frame(width: 26, height: 26)
                        .background(StudyPalette.inset, in: Circle())
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 7) {
                            Text(questionTypeLabel(q["type"] as? String ?? ""))
                                .font(.system(size: 10, weight: .semibold)).tracking(0.8)
                                .foregroundStyle(StudyPalette.accent)
                            Text(resultOutcomeLabel(outcome, score: receipt?["score"] as? Int))
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(resultOutcomeColor(outcome))
                        }
                        Text(q["stem"] as? String ?? "")
                            .font(.system(size: 14, weight: .medium))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink)
                            .multilineTextAlignment(.leading)
                            .lineLimit(expanded ? nil : 2)
                    }
                    Spacer(minLength: 0)
                    AstellaGlyph(kind: .chevron, tint: StudyPalette.muted)
                        .frame(width: 12, height: 12)
                        .rotationEffect(.degrees(expanded ? -90 : 90))
                        .padding(.top, 6)
                }
                .padding(15)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 14) {
                    Rectangle().fill(StudyPalette.paperEdge.opacity(0.6)).frame(height: 0.7)
                    reviewLabeledRow("你的作答", answerDescription(receipt?["answer"], for: q))
                    if let rubric = rubricDescription(receipt?["rubric"]) {
                        reviewLabeledRow("评分要点", rubric)
                    }
                    if let reference = receipt?["referenceAnswer"] {
                        reviewLabeledRow("参考答案", answerDescription(reference, for: q))
                    } else {
                        reviewLabeledRow("参考答案", "请结合下方原文依据核对。")
                    }
                    if let feedback = feedbackText(receipt?["feedback"]), !feedback.isEmpty {
                        reviewLabeledRow("伴星点评", feedback, accent: true)
                    }
                    resultGroundingRows(receipt?["grounding"] as? [String: Any] ?? q["grounding"] as? [String: Any] ?? [:])
                    if q["type"] as? String == "operation", let artifactId = q["operationArtifactId"] as? String {
                        operationReplay(artifactId: artifactId, questionId: qid, receipt: receipt)
                    }
                }
                .padding(.horizontal, 15)
                .padding(.bottom, 16)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .modifier(StudyGlassSurfaceStyle(radius: 20))
    }

    private func reviewLabeledRow(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 10, weight: .semibold)).tracking(1)
                .foregroundStyle(StudyPalette.muted)
            Text(value)
                .font(.system(size: 13.5)).lineSpacing(5)
                .foregroundStyle(accent ? StudyPalette.accent : StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func resultGroundingRows(_ grounding: [String: Any]) -> some View {
        let sources = grounding["note"] as? [[String: Any]] ?? []
        if !sources.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("原文依据")
                    .font(.system(size: 10, weight: .semibold)).tracking(1)
                    .foregroundStyle(StudyPalette.muted)
                ForEach(sources.indices, id: \.self) { sourceIndex in
                    HStack(alignment: .top, spacing: 9) {
                        Capsule().fill(StudyPalette.accent.opacity(0.5)).frame(width: 2)
                        Text(sources[sourceIndex]["quote"] as? String ?? "")
                            .font(StudySerif.font(size: 13))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink.opacity(0.92))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        if let evidence = grounding["extension"] as? [String: Any] {
            extensionEvidence(evidence)
        }
    }

    private func operationReplay(artifactId: String, questionId: String, receipt: [String: Any]?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.gated(reduced, Motion.segment)) {
                    replayingOperationQuestionId = replayingOperationQuestionId == questionId ? nil : questionId
                }
            } label: {
                HStack(spacing: 7) {
                    AstellaGlyph(kind: .play, tint: StudyPalette.accent).frame(width: 12, height: 12)
                    Text(replayingOperationQuestionId == questionId ? "收起操作回看" : "回看当时的操作（只读）")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                }
            }
            .buttonStyle(.plain)
            if replayingOperationQuestionId == questionId {
                let saved: Any? = {
                    guard let answer = receipt?["answer"] as? [String: Any], answer["skipped"] as? Bool == true else { return receipt?["answer"] }
                    return answer["draft"] as? [String: Any]
                }()
                NoteLearningCardOperationView(artifactId: artifactId, initialAnswer: saved, readOnly: true) { _ in }
                    .frame(minHeight: 300)
                    .modifier(StudyGlassSurfaceStyle(radius: 16))
                    .id("replay-\(artifactId)")
            }
        }
    }

    private func resultSummary(_ result: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent).frame(width: 14, height: 14)
                Text("本次点评")
                    .font(.system(size: 11, weight: .semibold)).tracking(1.4)
                    .foregroundStyle(StudyPalette.accent)
                Spacer(minLength: 0)
            }
            if let summary = summaryText(result["summary"]), !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 13.5)).lineSpacing(6)
                    .foregroundStyle(StudyPalette.ink.opacity(0.94))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("这次总评还没有生成，分数和星级已经保留，可以逐题回看。")
                    .font(.system(size: 12.5)).lineSpacing(4)
                    .foregroundStyle(StudyPalette.muted)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.sky.opacity(0.55), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(StudyPalette.sky, lineWidth: 0.9))
    }

    private var resultActions: some View {
        VStack(spacing: 10) {
            Button { Task { await startAttempt() } } label: {
                HStack(spacing: 9) {
                    AstellaGlyph(kind: .refresh, tint: StudyPalette.paper).frame(width: 16, height: 16)
                    Text("再练一次")
                }
            }
            .modifier(PrimaryActionStyle())
            .disabled(busy)
            Button("回到学习卡") {
                withAnimation(Motion.gated(reduced, Motion.segment)) { scene = "front" }
            }
            .modifier(SecondaryActionStyle())
        }
        .padding(.top, 6)
    }

    // Result helpers -------------------------------------------------------

    private struct ResultCounts { var correct = 0; var partial = 0; var wrong = 0; var skipped = 0 }

    private func resultOutcome(_ result: [String: Any], qIndex: Int) -> String {
        guard questions.indices.contains(qIndex) else { return "wrong" }
        let q = questions[qIndex]
        let qid = q["questionId"] as? String ?? ""
        let receipt = (result["answers"] as? [[String: Any]] ?? []).first { $0["questionId"] as? String == qid }
        let answer = receipt?["answer"] as? [String: Any]
        if answer?["skipped"] as? Bool == true || receipt?["skipped"] as? Bool == true { return "skipped" }
        let score = receipt?["score"] as? Int ?? 0
        if score >= 100 { return "correct" }
        if score > 0 { return "partial" }
        return "wrong"
    }

    private func resultCounts(_ result: [String: Any]) -> ResultCounts {
        var counts = ResultCounts()
        for qIndex in questions.indices {
            switch resultOutcome(result, qIndex: qIndex) {
            case "correct": counts.correct += 1
            case "partial": counts.partial += 1
            case "skipped": counts.skipped += 1
            default: counts.wrong += 1
            }
        }
        return counts
    }

    private func resultSkippedCount(_ result: [String: Any]) -> Int { resultCounts(result).skipped }

    private func resultOutcomeLabel(_ outcome: String, score: Int?) -> String {
        switch outcome {
        case "correct": return "答对"
        case "partial": return "部分答对"
        case "skipped": return "已跳过"
        default: return "值得回看"
        }
    }

    private func resultOutcomeColor(_ outcome: String) -> Color {
        switch outcome {
        case "correct": return StudyPalette.success
        case "partial": return StudyPalette.accent
        case "skipped": return StudyPalette.muted
        default: return StudyPalette.danger
        }
    }

    private func attemptDate(_ value: String?) -> String {
        guard let value, let date = ISO8601DateFormatter().date(from: value) else { return "刚刚" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M 月 d 日"
        return formatter.string(from: date)
    }

    private func prepareResultMotion() {
        guard let result = resultAttempt else { return }
        let target = result["score"] as? Int ?? 0
        let stars = result["stars"] as? Int ?? 0
        if reduced {
            displayedScore = Double(target)
            resultLitStars = stars
            return
        }
        displayedScore = 0
        resultLitStars = 0
        withAnimation(.easeOut(duration: 0.9)) { displayedScore = Double(target) }
        Task { @MainActor in
            for value in 1...max(stars, 0) {
                try? await Task.sleep(for: .milliseconds(value == 1 ? 380 : 150))
                withAnimation(Motion.press) { resultLitStars = value }
            }
        }
    }

    private func resetResultMotion() {
        displayedScore = 0
        resultLitStars = 0
        resultFilter = "all"
        expandedQuestions = []
    }

    // MARK: - Answer editors

    @ViewBuilder private func answerEditor(_ q: [String: Any]) -> some View {
        let id = q["questionId"] as? String ?? ""
        let kind = q["type"] as? String ?? ""
        let options = q["options"] as? [String] ?? []
        let stored = answers[id]
        let raw = ((stored as? [String: Any])?["skipped"] as? Bool == true) ? (stored as? [String: Any])?["draft"] : stored
        let answer = raw as? [String: Any] ?? [:]
        if kind == "single_choice" || kind == "multi_choice" || kind == "true_false" {
            let choices = kind == "true_false" ? ["正确", "错误"] : options
            let selected: [String] = kind == "true_false" ? (raw as? Bool).map { [$0 ? "0" : "1"] } ?? []
                : kind == "multi_choice" ? answer["optionIds"] as? [String] ?? [] : [answer["optionId"] as? String ?? ""].filter { !$0.isEmpty }
            VStack(spacing: 10) {
                ForEach(choices.indices, id: \.self) { option in
                    let key = String(option), active = selected.contains(key)
                    Button {
                        if kind == "true_false" { changeAnswer(id, option == 0) }
                        else if kind == "multi_choice" { changeAnswer(id, ["optionIds": active ? selected.filter { $0 != key } : (selected + [key]).sorted { (Int($0) ?? 0) < (Int($1) ?? 0) }]) }
                        else { changeAnswer(id, ["optionId": key]) }
                    } label: {
                        HStack(spacing: 13) {
                            Text(String(UnicodeScalar(65 + option) ?? "A".unicodeScalars.first!))
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(active ? StudyPalette.paper : StudyPalette.accent)
                                .frame(width: 28, height: 28)
                                .background(active ? StudyPalette.accent : StudyPalette.sky, in: Circle())
                            Text(choices[option])
                                .font(.system(size: 14.5))
                                .lineSpacing(3)
                                .foregroundStyle(StudyPalette.ink)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            if active {
                                AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 15, height: 15)
                            }
                        }
                        .padding(.horizontal, 15)
                        .frame(minHeight: 56)
                        .background(active ? StudyPalette.sky.opacity(0.85) : StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(active ? StudyPalette.accent.opacity(0.85) : StudyPalette.paperEdge, lineWidth: active ? 1.2 : 0.7))
                    }
                    .buttonStyle(AstellaPressStyle())
                }
            }
        } else if kind == "fill_blank" {
            let count = q["blankCount"] as? Int ?? 1
            let values = answer["values"] as? [String] ?? []
            VStack(spacing: 10) {
                ForEach(0..<count, id: \.self) { blank in
                    HStack(spacing: 12) {
                        Text("\(blank + 1)")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(StudyPalette.accent)
                            .frame(width: 26, height: 26)
                            .background(StudyPalette.sky, in: Circle())
                        TextField("填写第 \(blank + 1) 空", text: Binding(
                            get: { values.indices.contains(blank) ? values[blank] : "" },
                            set: { value in var next = Array(values.prefix(count)); while next.count < count { next.append("") }; next[blank] = value; changeAnswer(id, ["values": next]) }
                        ))
                        .font(.system(size: 15))
                        .textFieldStyle(.plain)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
                }
            }
        } else if kind == "short_answer" {
            VStack(alignment: .leading, spacing: 8) {
                Text("你的回答")
                    .font(.system(size: 10.5, weight: .semibold)).tracking(0.8)
                    .foregroundStyle(StudyPalette.muted)
                ZStack(alignment: .topLeading) {
                    if (answer["text"] as? String ?? "").isEmpty {
                        Text("可以先写下想到的关键词…")
                            .font(.system(size: 14))
                            .foregroundStyle(StudyPalette.muted.opacity(0.8))
                            .padding(.horizontal, 15).padding(.top, 14)
                    }
                    TextEditor(text: Binding(get: { answer["text"] as? String ?? "" }, set: { changeAnswer(id, ["text": $0]) }))
                        .font(.system(size: 15))
                        .lineSpacing(5)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .frame(minHeight: 176)
                }
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
            }
        } else if kind == "ordering" {
            let order = answer["order"] as? [String] ?? []
            VStack(alignment: .leading, spacing: 12) {
                if order.isEmpty {
                    Text("按原文顺序依次点选下列内容。")
                        .font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                }
                ForEach(order.indices, id: \.self) { position in
                    HStack(spacing: 11) {
                        Text("\(position + 1)")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(StudyPalette.accent)
                            .frame(width: 24, height: 24)
                            .background(StudyPalette.sky, in: Circle())
                        Text(orderingLabel(order[position], options: options))
                            .font(.system(size: 14))
                            .foregroundStyle(StudyPalette.ink)
                            .lineSpacing(3)
                        Spacer(minLength: 0)
                        Button { moveOrdering(id, order: order, at: position, by: -1) } label: {
                            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12).rotationEffect(.degrees(-90))
                                .frame(width: 32, height: 32).background(StudyPalette.inset, in: Circle())
                        }
                        .buttonStyle(AstellaPressStyle())
                        .disabled(position == 0)
                        Button { moveOrdering(id, order: order, at: position, by: 1) } label: {
                            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 12, height: 12).rotationEffect(.degrees(90))
                                .frame(width: 32, height: 32).background(StudyPalette.inset, in: Circle())
                        }
                        .buttonStyle(AstellaPressStyle())
                        .disabled(position == order.count - 1)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
                }
                let remaining = options.indices.filter { !order.contains(String($0)) }
                if !remaining.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("待选择").font(.system(size: 10.5, weight: .semibold)).tracking(0.8).foregroundStyle(StudyPalette.muted)
                        FlowChips(items: remaining.map { (String($0), options[$0]) }) { key in
                            changeAnswer(id, ["order": order + [key]])
                        }
                    }
                }
                if !order.isEmpty {
                    Button("重新排列") { changeAnswer(id, ["order": []]) }
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(StudyPalette.muted)
                }
            }
        } else if kind == "matching" {
            let pairs = answer["pairs"] as? [String: String] ?? [:]
            let right = q["rightOptions"] as? [String] ?? []
            VStack(spacing: 10) {
                ForEach(options.indices, id: \.self) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(String(UnicodeScalar(65 + item) ?? "A".unicodeScalars.first!)) · \(options[item])")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(StudyPalette.ink)
                        Menu {
                            ForEach(right, id: \.self) { option in
                                Button(option) { var next = pairs; next[String(item)] = option; changeAnswer(id, ["pairs": next]) }
                            }
                        } label: {
                            HStack {
                                Text(pairs[String(item)] ?? "选择对应项")
                                    .font(.system(size: 13)).foregroundStyle(StudyPalette.accent)
                                Spacer()
                                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 11, height: 11).rotationEffect(.degrees(90))
                            }
                            .padding(.horizontal, 13)
                            .frame(minHeight: 44)
                            .background(StudyPalette.sky.opacity(0.7), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        }
                    }
                    .padding(14)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge, lineWidth: 0.7))
                }
            }
        } else if kind == "operation", let artifactId = q["operationArtifactId"] as? String {
            NoteLearningCardOperationView(artifactId: artifactId, initialAnswer: raw) { changeAnswer(id, $0) }
                .frame(minHeight: 300)
                .modifier(StudyGlassSurfaceStyle(radius: 18))
                .id(artifactId)
        } else {
            ContentUnavailableView("题目类型暂不可用", systemImage: "questionmark.circle", description: Text("可以先跳过这题，交卷后再回看。"))
        }
    }

    private func isSkipped(_ q: [String: Any]) -> Bool {
        (answers[q["questionId"] as? String ?? ""] as? [String: Any])?["skipped"] as? Bool == true
    }

    // MARK: - Grounding / rubric helpers

    private func groundingExtension(_ grounding: [String: Any]) -> [String: Any]? {
        grounding["extension"] as? [String: Any]
    }

    private func extensionEvidence(_ evidence: [String: Any]) -> some View {
        let kind = evidence["kind"] as? String ?? "existing_source"
        let kindLabel = ["ai_generated": "AI 补充", "web": "联网资料", "existing_source": "已有资料"][kind] ?? "拓展依据"
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text(kindLabel)
                    .font(.system(size: 9.5, weight: .semibold)).tracking(0.6)
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.horizontal, 7).frame(height: 19)
                    .background(StudyPalette.sky, in: Capsule())
                Text(evidence["title"] as? String ?? "拓展依据")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink.opacity(0.9))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            Text(evidence["quote"] as? String ?? "")
                .font(.system(size: 12.5)).lineSpacing(4)
                .foregroundStyle(StudyPalette.ink.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)
            if let relation = evidence["relation"] as? String, !relation.isEmpty {
                Text(relation).font(.system(size: 11)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
            }
            if kind == "web", let rawURL = evidence["url"] as? String, let url = URL(string: rawURL), url.scheme == "https" || url.scheme == "http" {
                Link(destination: url) {
                    HStack(spacing: 5) {
                        Text("打开资料来源").font(.system(size: 11, weight: .semibold))
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.accent).frame(width: 9, height: 9).rotationEffect(.degrees(-45))
                    }
                    .foregroundStyle(StudyPalette.accent)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.sky.opacity(0.45), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private func rubricDescription(_ value: Any?) -> String? {
        if let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        if let points = value as? [String] {
            let text = points.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "；")
            return text.isEmpty ? nil : text
        }
        guard let points = value as? [[String: Any]] else { return nil }
        let text = points.compactMap { $0["keyword"] as? String ?? $0["description"] as? String ?? $0["text"] as? String }
            .filter { !$0.isEmpty }.joined(separator: "；")
        return text.isEmpty ? nil : text
    }

    private func orderingLabel(_ id: String, options: [String]) -> String {
        guard let index = Int(id), options.indices.contains(index) else { return "未识别项目" }
        return options[index]
    }

    private func moveOrdering(_ questionId: String, order: [String], at index: Int, by delta: Int) {
        let target = index + delta
        guard order.indices.contains(index), order.indices.contains(target) else { return }
        var next = order; next.swapAt(index, target); changeAnswer(questionId, ["order": next])
    }

    private func load() async {
        #if DEBUG
        if let fixture = store.uiReviewMode, fixture.hasPrefix("note-learning-") {
            loading = false
            card = Self.reviewCard
            attempts = Self.reviewAttempts
            if fixture == "note-learning-practice" {
                activeAttempt = ["attemptId": "70000000-0000-0000-0000-000000000001", "status": "in_progress", "answers": []]
                scene = "practice"
            } else if fixture == "note-learning-result" {
                resultAttempt = attempts.first
                scene = "result"
                if let first = Self.reviewQuestions.first?["questionId"] as? String {
                    expandedQuestions = [first]
                }
            }
            return
        }
        #endif
        if store.aiSettings == nil { await store.loadAccountSettings() }
        loading = true; failure = nil
        defer { loading = false }
        do {
            let read = try await store.noteLearningCard(noteId: noteId)
            card = read["card"] as? [String: Any]
            if read["generating"] as? Bool == true { generating = true; await pollGeneration() }
            if let cardId { await loadAttempts(cardId: cardId) }
            if let generationFailure = read["generationFailure"] as? String, card == nil { failure = failureLabel(generationFailure) }
        } catch { failure = noteFeatureFailure(error) }
    }

    private func loadAttempts(cardId: String) async {
        do {
            attempts = try await store.noteLearningCardAttempts(cardId: cardId)
            activeAttempt = attempts.first { ["in_progress", "grading", "grading_failed"].contains($0["status"] as? String ?? "") }
            if let activeAttempt {
                answers = Dictionary(uniqueKeysWithValues: (activeAttempt["answers"] as? [[String: Any]] ?? []).compactMap { row in
                    guard let id = row["questionId"] as? String, let value = row["answer"] else { return nil }; return (id, value)
                })
                if activeAttempt["status"] as? String == "grading" { scene = "grading"; Task { await pollGrading() } }
                else if activeAttempt["status"] as? String == "in_progress" {
                    index = questions.indices.first(where: { questionIndex in
                        let question = questions[questionIndex]
                        let answer = answers[question["questionId"] as? String ?? ""]
                        return !hasAnswer(question, answer) && (answer as? [String: Any])?["skipped"] as? Bool != true
                    }) ?? 0
                }
            }
        } catch { failure = noteFeatureFailure(error) }
    }

    private func loadAttemptsReceipt(attemptId: String) async -> [String: Any]? {
        guard let cardId else { return nil }
        do { return try await store.noteLearningCardAttempts(cardId: cardId).first { $0["attemptId"] as? String == attemptId } }
        catch { failure = noteFeatureFailure(error); return nil }
    }

    private func pollGeneration() async {
        generating = true
        for _ in 0..<30 {
            do {
                let value = try await store.noteLearningCard(noteId: noteId)
                if let ready = value["card"] as? [String: Any] { card = ready; generating = false; await loadAttempts(cardId: ready["cardId"] as? String ?? ""); return }
                if value["generating"] as? Bool != true { generating = false; failure = value["generationFailure"] as? String ?? "学习卡生成没有完成，可以重新尝试。"; return }
                try await Task.sleep(for: .seconds(2))
            } catch { generating = false; failure = noteFeatureFailure(error); return }
        }
        generating = false; failure = "学习卡还在后台制作，稍后重新打开即可继续。"
    }

    private func generate() async {
        guard store.aiSettings?.canUseExternalAI == true else {
            failure = store.aiSettings?.needsSigning == true ? "ai_consent_required" : "当前 AI 数据设置不允许生成学习卡。"
            return
        }
        guard let versionId = store.noteDocument?.versionId else { failure = "请先打开并保存这篇手记，再生成学习卡。"; return }
        busy = true; failure = nil; defer { busy = false }
        do {
            let receipt = try await store.generateNoteLearningCard(noteId: noteId, noteVersionId: versionId, questionCount: questionCount)
            if receipt["queued"] as? Bool == true || receipt["reason"] as? String == "generating" { await pollGeneration() }
            else { await load() }
            scene = "front"
        } catch { failure = noteFeatureFailure(error) }
    }

    private func startAttempt() async {
        guard let cardId else { return }
        busy = true; failure = nil; defer { busy = false }
        do {
            let receipt = try await store.startNoteLearningCardAttempt(cardId: cardId)
            activeAttempt = ["attemptId": receipt["attemptId"] as? String ?? "", "status": "in_progress", "answers": []]
            answers = [:]; pendingAnswers = [:]; index = 0; scene = "practice"
            await loadAttempts(cardId: cardId)
            scene = "practice"
        } catch { failure = noteFeatureFailure(error) }
    }

    private func changeAnswer(_ questionId: String, _ value: Any) {
        answers[questionId] = value; pendingAnswers[questionId] = value; saving = true
        saveTask?.cancel()
        saveTask = Task { try? await Task.sleep(for: .milliseconds(450)); if !Task.isCancelled { await flushAnswers() } }
    }

    private func flushAnswers() async {
        guard let cardId, let attemptId = activeAttempt?["attemptId"] as? String else { return }
        saveTask?.cancel(); saveTask = nil
        for questionId in pendingAnswers.keys.sorted() {
            guard let answer = pendingAnswers[questionId] else { continue }
            do {
                try await store.saveNoteLearningCardAnswer(cardId: cardId, attemptId: attemptId, questionId: questionId, answer: answer)
                pendingAnswers.removeValue(forKey: questionId)
            } catch is CancellationError {
                return
            } catch {
                let nsError = error as NSError
                // A newer tap cancels the in-flight debounce; that cancellation
                // surfaces as NSURLErrorCancelled and must not be shown to the
                // learner as a failed save. The pending answer stays queued and
                // the next autosave (or submit) posts it again.
                if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
                failure = "这道题的作答暂时没有保存，请检查网络后再试。"
                saving = false
                return
            }
        }
        saving = false
    }

    private func submit(retry: Bool = false) async {
        guard let cardId, let attemptId = activeAttempt?["attemptId"] as? String else { return }
        busy = true; failure = nil; defer { busy = false }
        if !retry {
            for q in questions {
                let questionId = q["questionId"] as? String ?? ""
                if !hasAnswer(q, answers[questionId]) && (answers[questionId] as? [String: Any])?["skipped"] as? Bool != true {
                    let current = answers[questionId]
                    let skipped: [String: Any] = ["skipped": true, "draft": current ?? NSNull()]
                    answers[questionId] = skipped; pendingAnswers[questionId] = skipped
                }
            }
            await flushAnswers()
            guard failure == nil else { return }
        }
        do {
            _ = try await store.completeNoteLearningCardAttempt(cardId: cardId, attemptId: attemptId)
            activeAttempt?["status"] = "grading"; scene = "grading"
            await pollGrading()
        } catch { failure = noteFeatureFailure(error) }
    }

    private func pollGrading() async {
        guard let attemptId = activeAttempt?["attemptId"] as? String else { return }
        for _ in 0..<30 {
            guard let value = await loadAttemptsReceipt(attemptId: attemptId) else { return }
            activeAttempt = value
            let state = value["status"] as? String ?? ""
            if state == "completed" {
                if let cardId, let refreshed = try? await store.noteLearningCardAttempts(cardId: cardId) { attempts = refreshed }
                resultAttempt = value
                scene = "result"
                return
            }
            if state == "grading_failed" { activeAttempt = value; scene = "front"; failure = "批改没有完成，作答已保存，可以重新批改。"; return }
            try? await Task.sleep(for: .seconds(2))
        }
        failure = "批改仍在后台进行，稍后打开学习卡即可查看。"
    }

    private func close() async {
        await flushAnswers()
        if failure == nil { dismiss() }
    }

    #if DEBUG
    private static let reviewQuestions: [[String: Any]] = [
        [
            "questionId": "80000000-0000-0000-0000-000000000001",
            "ordinal": 0,
            "type": "single_choice",
            "stem": "“清风徐来，水波不兴”在开篇主要写出了怎样的夜游环境？",
            "options": ["热闹喧腾的宴饮场面", "安静开阔的江上夜色", "萧瑟凄凉的秋日江岸", "急促紧张的行程"],
            "rightOptions": NSNull(), "blankCount": NSNull(), "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 1, "quote": "清风徐来，水波不兴。"]], "extension": NSNull()],
        ],
        [
            "questionId": "80000000-0000-0000-0000-000000000002",
            "ordinal": 1,
            "type": "multi_choice",
            "stem": "下列哪些内容出现在客人感慨人生短促、功业无常的段落里？",
            "options": ["月明星稀，乌鹊南飞", "舳舻千里，旌旗蔽空", "清风徐来，水波不兴", "哀吾生之须臾"],
            "rightOptions": NSNull(), "blankCount": NSNull(), "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 3, "quote": "方其破荆州，下江陵，顺流而东也，舳舻千里，旌旗蔽空。"]], "extension": ["kind": "ai_generated", "title": "赤壁之战的时间线", "quote": "建安十三年，曹操南下荆州，随后在赤壁与孙刘联军交战。", "relation": "帮助理解客人口中孟德往事的来历。"]],
        ],
        [
            "questionId": "80000000-0000-0000-0000-000000000003",
            "ordinal": 2,
            "type": "fill_blank",
            "stem": "苏子以江水与明月说明变化和恒常可以同时成立：逝者如斯，而未尝往也；____，而卒莫消长也。",
            "options": NSNull(), "rightOptions": NSNull(), "blankCount": 1, "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 3, "quote": "逝者如斯，而未尝往也。"]], "extension": NSNull()],
        ],
        [
            "questionId": "80000000-0000-0000-0000-000000000004",
            "ordinal": 3,
            "type": "short_answer",
            "stem": "用自己的话说说，苏子是怎样化解客人“哀吾生之须臾”的悲意的？",
            "options": NSNull(), "rightOptions": NSNull(), "blankCount": NSNull(), "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 3, "quote": "逝者如斯，而未尝往也。"]], "extension": NSNull()],
        ],
        [
            "questionId": "80000000-0000-0000-0000-000000000005",
            "ordinal": 4,
            "type": "ordering",
            "stem": "按文章推进的顺序排列下列内容。",
            "options": ["月夜泛舟，写清风明月", "扣舷而歌，箫声随之", "客人感慨人生短促", "苏子以水月作答"],
            "rightOptions": NSNull(), "blankCount": NSNull(), "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 1, "quote": "壬戌之秋，七月既望，苏子与客泛舟游于赤壁之下。"]], "extension": NSNull()],
        ],
        [
            "questionId": "80000000-0000-0000-0000-000000000006",
            "ordinal": 5,
            "type": "matching",
            "stem": "把下列意象与它在文中的作用配对。",
            "options": ["江水", "明月", "箫声"],
            "rightOptions": ["引出客人的悲意", "说明变化与恒常", "承载盛衰之叹"],
            "blankCount": NSNull(), "operationArtifactId": NSNull(),
            "grounding": ["note": [["blockOrdinal": 2, "quote": "客有吹洞箫者，倚歌而和之。"]], "extension": NSNull()],
        ],
    ]
    private static let reviewCard: [String: Any] = [
        "cardId": "90000000-0000-0000-0000-000000000001",
        "noteId": "open-design-redwall",
        "noteVersionId": "open-design-redwall-v2",
        "status": "active",
        "questions": reviewQuestions,
        "bestScore": 82,
        "bestStars": 4,
        "completedAttemptCount": 1,
        "lastAttempt": NSNull(),
        "createdAt": "2026-10-21T09:12:00Z",
        "updatedAt": "2026-10-21T09:12:00Z",
    ]
    private static let reviewAttempts: [[String: Any]] = [[
        "attemptId": "a0000000-0000-0000-0000-000000000001",
        "status": "completed",
        "score": 82,
        "stars": 4,
        "summary": "第1题：判断准确，能直接回到开篇的安静。\n第2题：选出了与客人感慨相关的句子，漏了“月明星稀”。\n第3题：空白处补全正确。\n第4题：答出了水月之喻，可以把“变与不变”说得更具体。\n\n下一步：重读第三段，试着用一句话概括苏子的回答。",
        "startedAt": "2026-10-21T09:14:00Z",
        "completedAt": "2026-10-21T09:16:00Z",
        "answers": [
            ["questionId": "80000000-0000-0000-0000-000000000001", "answer": ["optionId": "1"], "score": 100, "feedback": ["correct": true], "skipped": false, "referenceAnswer": ["correctOptionId": "1"], "rubric": NSNull(), "grounding": ["note": [["blockOrdinal": 1, "quote": "清风徐来，水波不兴。"]]]],
            ["questionId": "80000000-0000-0000-0000-000000000002", "answer": ["optionIds": ["1"]], "score": 50, "feedback": ["correct": false], "skipped": false, "referenceAnswer": ["correctOptionIds": ["0", "1", "3"]], "rubric": NSNull(), "grounding": ["note": [["blockOrdinal": 3, "quote": "方其破荆州，下江陵，顺流而东也，舳舻千里，旌旗蔽空。"]]]],
            ["questionId": "80000000-0000-0000-0000-000000000003", "answer": ["values": ["盈虚者如彼"]], "score": 100, "feedback": ["correct": true], "skipped": false, "referenceAnswer": ["blanks": [["盈虚者如彼"]]], "rubric": NSNull(), "grounding": ["note": [["blockOrdinal": 3, "quote": "逝者如斯，而未尝往也。"]]]],
            ["questionId": "80000000-0000-0000-0000-000000000004", "answer": ["text": "他说江水一直流走，可江水从来没有真的消失；月亮有圆缺，可月亮也没有增减。"], "score": 80, "feedback": "抓住了变与不变，可以再点明他借此把悲意放回天地之间。", "skipped": false, "referenceAnswer": ["rubric": ["提到江水与明月", "说明变与不变并存", "落到心境的开阔"]], "rubric": ["提到江水与明月", "说明变与不变并存", "落到心境的开阔"], "grounding": ["note": [["blockOrdinal": 3, "quote": "逝者如斯，而未尝往也。"]]]],
            ["questionId": "80000000-0000-0000-0000-000000000005", "answer": ["order": ["0", "1", "2", "3"]], "score": 100, "feedback": ["correct": true], "skipped": false, "referenceAnswer": ["order": ["0", "1", "2", "3"]], "rubric": NSNull(), "grounding": ["note": [["blockOrdinal": 1, "quote": "壬戌之秋，七月既望，苏子与客泛舟游于赤壁之下。"]]]],
            ["questionId": "80000000-0000-0000-0000-000000000006", "answer": ["pairs": ["0": "1", "1": "1", "2": "0"]], "score": 66, "feedback": ["correct": false], "skipped": false, "referenceAnswer": ["pairs": ["0": "1", "1": "1", "2": "0"]], "rubric": NSNull(), "grounding": ["note": [["blockOrdinal": 2, "quote": "客有吹洞箫者，倚歌而和之。"]]]],
        ],
    ]]
    #endif

    private func hasAnswer(_ q: [String: Any], _ value: Any?) -> Bool {
        guard let value, !(value is NSNull) else { return false }
        if let skipped = (value as? [String: Any])?["skipped"] as? Bool, skipped { return false }
        let type = q["type"] as? String ?? ""
        let answer = value as? [String: Any] ?? [:]
        switch type {
        case "single_choice": return answer["optionId"] != nil
        case "multi_choice": return (answer["optionIds"] as? [String])?.isEmpty == false
        case "true_false": return value is Bool
        case "fill_blank": return (answer["values"] as? [String])?.count == (q["blankCount"] as? Int ?? 1)
            && (answer["values"] as? [String])?.allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty } == true
        case "short_answer": return !(answer["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case "ordering":
            guard let order = answer["order"] as? [String], let options = q["options"] as? [String] else { return false }
            return order.count == options.count && Set(order).count == options.count
                && order.allSatisfy { Int($0).map(options.indices.contains) == true }
        case "matching":
            guard let pairs = answer["pairs"] as? [String: String], let options = q["options"] as? [String] else { return false }
            return options.indices.allSatisfy { index in
                guard let value = pairs[String(index)] else { return false }
                return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
        case "operation":
            return (answer["kind"] as? String == "controls" && (answer["values"] as? [String: Any])?.isEmpty == false)
                || (answer["kind"] as? String == "steps" && (answer["steps"] as? [String])?.isEmpty == false)
        default: return false
        }
    }

    private func questionType(_ type: String) -> String {
        ["single_choice": "单选", "multi_choice": "多选", "true_false": "判断", "fill_blank": "填空", "short_answer": "简答", "ordering": "排序", "matching": "配对", "operation": "操作"][type] ?? "练习"
    }

    private func answerDescription(_ value: Any?, for item: [String: Any]? = nil) -> String {
        guard let value else { return "本题已跳过" }
        if let bool = value as? Bool { return bool ? "正确" : "错误" }
        if let object = value as? [String: Any] {
            if object["skipped"] as? Bool == true { return "本题已跳过" }
            let data = object["draft"] as? [String: Any] ?? object
            let options = (item ?? question)?["options"] as? [String] ?? []
            if let correct = data["correct"] as? Bool { return correct ? "正确" : "错误" }
            if let id = data["correctOptionId"] as? String { return Int(id).flatMap { options.indices.contains($0) ? options[$0] : nil } ?? id }
            if let ids = data["correctOptionIds"] as? [String] { return ids.compactMap { Int($0).flatMap { options.indices.contains($0) ? options[$0] : nil } }.joined(separator: "、") }
            if let id = data["optionId"] as? String { return Int(id).flatMap { options.indices.contains($0) ? options[$0] : nil } ?? id }
            if let ids = data["optionIds"] as? [String] { return ids.compactMap { Int($0).flatMap { options.indices.contains($0) ? options[$0] : nil } }.joined(separator: "、") }
            if let values = data["values"] as? [String] { return values.joined(separator: " / ") }
            if let blanks = data["blanks"] as? [[String]] { return blanks.map { $0.joined(separator: " / ") }.joined(separator: "；") }
            if let blanks = data["blanks"] as? [String] { return blanks.joined(separator: " / ") }
            if let text = data["text"] as? String { return text }
            if let order = data["order"] as? [String] { return order.compactMap { Int($0).flatMap { options.indices.contains($0) ? options[$0] : nil } }.joined(separator: " → ") }
            if let pairs = data["pairs"] as? [String: String] { return pairs.keys.sorted { (Int($0) ?? 0) < (Int($1) ?? 0) }.map { key in
                let left = Int(key).flatMap { options.indices.contains($0) ? options[$0] : nil } ?? key
                return "\(left) → \(pairs[key] ?? "")"
            }.joined(separator: "；") }
            if data["kind"] as? String == "controls", let values = data["values"] as? [String: Any] {
                return values.keys.sorted().map { "\($0)：\(String(describing: values[$0] ?? ""))" }.joined(separator: "；")
            }
            if let steps = data["steps"] as? [String] { return steps.joined(separator: " → ") }
            if let target = data["target"] as? [String: Any] {
                return target.keys.sorted().map { "\($0)：\(String(describing: target[$0] ?? ""))" }.joined(separator: "；")
            }
        }
        if let values = value as? [Any] {
            return values.map { item in
                if let item = item as? String { return item }
                if let data = try? JSONSerialization.data(withJSONObject: item),
                   let text = String(data: data, encoding: .utf8) { return text }
                return String(describing: item)
            }.joined(separator: "；")
        }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        return "本题已跳过"
    }

    private func qGrounding(_ q: [String: Any]) -> [[String: Any]] {
        (q["grounding"] as? [String: Any])?["note"] as? [[String: Any]] ?? []
    }

    /// The server stores the card summary as `{ text }`; a retry may also mark it failed.
    private func summaryText(_ value: Any?) -> String? {
        if let text = value as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let object = value as? [String: Any] else { return nil }
        if let text = object["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        if object["status"] as? String == "failed" { return "这次总评没能生成，分数和星级已经保留，可以逐题回看。" }
        return nil
    }

    /// `feedback` is `{ kind, text? }` for objective and companion-graded questions.
    private func feedbackText(_ value: Any?) -> String? {
        if let text = value as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let object = value as? [String: Any] else { return nil }
        if let text = object["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        if object["kind"] as? String == "skipped" { return "本题已跳过。" }
        if object["correct"] as? Bool == false { return "这题没有答对，可以对照下面的原文依据再看一遍。" }
        return nil
    }
}


// MARK: - Learning card local components

/// Five-star row used by the card hero and the result page. Stars may animate
/// in one by one after a score settles; Reduce Motion places them immediately.
private struct LearningCardStars: View {
    var stars: Int?
    var size: CGFloat = 18
    var animated = false
    var reduceMotion = false
    var litOverride: Int? = nil

    private var target: Int { litOverride ?? min(5, max(0, stars ?? 0)) }

    var body: some View {
        HStack(spacing: size * 0.18) {
            ForEach(0..<5, id: \.self) { index in
                Image(systemName: "star.fill")
                    .font(.system(size: size, weight: .semibold))
                    .foregroundStyle(target > index ? StudyPalette.accent : StudyPalette.paperEdge)
                    .scaleEffect(target > index ? 1 : 0.9)
                    .opacity(target > index ? 1 : 0.55)
                    .animation(starAnimation(index), value: target)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stars == nil ? "还没有点亮星级" : "最佳 \(stars ?? 0) 星")
    }

    private func starAnimation(_ index: Int) -> Animation? {
        guard animated, !reduceMotion else { return nil }
        return Motion.press.delay(Double(index) * 0.07)
    }
}

/// Wrapping chip row for the ordering question's remaining items.
private struct FlowChips: View {
    let items: [(String, String)]
    let onTap: (String) -> Void

    var body: some View {
        FlowChipLayout(spacing: 8) {
            ForEach(items, id: \.0) { item in
                Button {
                    onTap(item.0)
                } label: {
                    Text(item.1)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.horizontal, 13)
                        .frame(height: 38)
                        .background(StudyPalette.sky, in: Capsule())
                        .overlay(Capsule().stroke(StudyPalette.accent.opacity(0.35), lineWidth: 0.8))
                }
                .buttonStyle(AstellaPressStyle())
            }
        }
    }
}

private struct FlowChipLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0 && rowWidth + spacing + size.width > maxWidth {
                totalHeight += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth > 0 ? spacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth.isFinite ? maxWidth : rowWidth, height: totalHeight + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

private struct NoteAISettingsButton<Label: View>: View {
    @State private var showsSettings = false
    @ViewBuilder let label: Label

    var body: some View {
        Button { showsSettings = true } label: { label }
            .sheet(isPresented: $showsSettings) {
                NavigationStack {
                    AIDataAuthorizationScreen()
                }
                .presentationDetents([.fraction(0.95)])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(30)
            }
    }
}

private struct NoteLearningCardOperationView: View {
    @Environment(AppStore.self) private var store
    let artifactId: String
    let initialAnswer: Any?
    var readOnly = false
    let onAnswer: (Any) -> Void
    @State private var html: String?
    @State private var failure: String?
    @State private var contentHeight: CGFloat = 320

    var body: some View {
        Group {
            if let html {
                LearningCardOperationWebView(html: html, initialAnswer: initialAnswer, readOnly: readOnly, onAnswer: onAnswer) { reportedHeight in
                    let boundedHeight = min(900, max(260, reportedHeight))
                    if abs(contentHeight - boundedHeight) > 2 { contentHeight = boundedHeight }
                }
                .frame(height: contentHeight)
            } else if let failure {
                VStack(spacing: 8) { Text(failure).font(.footnote).foregroundStyle(StudyPalette.muted); Button("重新打开") { Task { await load() } }.font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent) }.padding(18)
            } else { ProgressView("正在打开操作区域…").padding(20) }
        }.task(id: artifactId) { await load() }
    }

    private func load() async {
        do {
            let data = try await store.api.imageData("/v2/note-learning-card-operation-artifacts/\(artifactId)")
            guard let value = String(data: data, encoding: .utf8) else { throw MobileAPIError(status: 0, code: "invalid_artifact", message: "操作区域格式无效。") }
            html = value; failure = nil
        } catch { failure = noteFeatureFailure(error) }
    }
}

private struct LearningCardOperationWebView: UIViewRepresentable {
    let html: String
    let initialAnswer: Any?
    let readOnly: Bool
    let onAnswer: (Any) -> Void
    let onContentHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onAnswer: onAnswer, onContentHeight: onContentHeight, readOnly: readOnly) }
    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "astellaOperationAnswer")
        controller.addUserScript(WKUserScript(source: "window.addEventListener('message',function(e){if(e.source!==window)return;var d=e.data;if(!d||d.channel!=='astella:artifact-frame'||d.direction!=='frame->host')return;if(d.phase==='ready'||d.phase==='heartbeat'){window.webkit.messageHandlers.astellaOperationAnswer.postMessage({phase:d.phase,contentHeight:d.contentHeight});return;}if(d.phase==='answer')window.webkit.messageHandlers.astellaOperationAnswer.postMessage(d.answer);},true);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration(); config.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false; web.backgroundColor = UIColor(StudyPalette.paper); web.scrollView.isScrollEnabled = false
        web.navigationDelegate = context.coordinator
        context.coordinator.webView = web
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onAnswer = onAnswer
        context.coordinator.onContentHeight = onContentHeight
        context.coordinator.initialAnswer = initialAnswer
        context.coordinator.readOnly = readOnly
        context.coordinator.restoreAnswerIfNeeded()
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        context.coordinator.didFinishDocument = false
        web.loadHTMLString(html, baseURL: nil)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onAnswer: (Any) -> Void
        var onContentHeight: (CGFloat) -> Void
        var initialAnswer: Any?
        var readOnly: Bool
        var loadedHTML: String?
        var didFinishDocument = false
        var restoredAnswerFingerprint: String?
        weak var webView: WKWebView?
        init(onAnswer: @escaping (Any) -> Void, onContentHeight: @escaping (CGFloat) -> Void, readOnly: Bool) {
            self.onAnswer = onAnswer; self.onContentHeight = onContentHeight; self.readOnly = readOnly
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "astellaOperationAnswer" else { return }
            if let body = message.body as? [String: Any], let phase = body["phase"] as? String,
               phase == "ready" || phase == "heartbeat" {
                if let number = body["contentHeight"] as? NSNumber, number.doubleValue.isFinite, number.doubleValue > 0 {
                    onContentHeight(CGFloat(number.doubleValue))
                }
                if phase == "ready" { didFinishDocument = true; restoreAnswerIfNeeded() }
                return
            }
            guard !readOnly else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: message.body, options: [.fragmentsAllowed]), data.count <= 64_000 else { return }
            onAnswer(message.body)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            didFinishDocument = true
            reportContentHeight()
            restoreAnswerIfNeeded()
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.targetFrame?.isMainFrame == false ? .allow : navigationAction.navigationType == .other ? .allow : .cancel)
        }

        func restoreAnswerIfNeeded() {
            guard didFinishDocument, let webView, initialAnswer != nil || readOnly else { return }
            let answer = initialAnswer ?? NSNull()
            guard let payload = try? JSONSerialization.data(withJSONObject: answer, options: [.fragmentsAllowed]),
                  payload.count <= 64_000 else { return }
            let fingerprint = "\(readOnly ? "read-only" : "editable"):\(payload.base64EncodedString())"
            guard restoredAnswerFingerprint != fingerprint else { return }
            let envelope: [String: Any] = [
                "channel": "astella:artifact-frame",
                "direction": "host->frame",
                "command": "restore-answer",
                "answer": answer,
                "readOnly": readOnly,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.fragmentsAllowed]) else { return }
            let encoded = data.base64EncodedString()
            let script = "window.postMessage(JSON.parse(decodeURIComponent(escape(atob('\(encoded)')))),'*');"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                if error == nil { self?.restoredAnswerFingerprint = fingerprint }
            }
        }

        private func reportContentHeight() {
            webView?.evaluateJavaScript("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)") { [weak self] value, _ in
                guard let height = value as? NSNumber, height.doubleValue.isFinite, height.doubleValue > 0 else { return }
                self?.onContentHeight(CGFloat(height.doubleValue))
            }
        }
    }
}

private struct NoteMindMapScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var noteId: String
    @State private var map: [String: Any]?
    @State private var loading = false
    @State private var working = false
    @State private var failure: String?
    @State private var zoom: CGFloat = 1
    @State private var canvasPan = CGSize.zero

    private var graphNodes: [NoteMindMapNode] {
        guard let content = map?["content"] as? [String: Any],
              let rawNodes = content["nodes"] as? [[String: Any]] else { return [] }
        return rawNodes.compactMap(NoteMindMapNode.init)
    }

    var body: some View {
        VStack(spacing: 0) {
            mindMapToolbar
            FeatureAuthorizationNotice(error: failure)
                .padding(.horizontal, 22)
                .padding(.top, 8)
            if let failure, !requiresAIConsent(failure), !requiresAIDataPolicy(failure) {
                featureError(failure, retry: { Task { await load() } })
                    .padding(.horizontal, 22)
                    .padding(.top, 8)
            }
            if map?["versionState"] as? String == "older" {
                featureNotice("这张图基于第 \(map?["noteVersionNumber"] as? Int ?? 1) 版。")
                    .padding(.horizontal, 22)
                    .padding(.top, 8)
            }
            if loading && map == nil {
                NoteFeatureLoadingState(title: "正在读取脑图")
                    .padding(.horizontal, 22)
                    .padding(.top, 6)
                Spacer(minLength: 0)
            } else if working && map == nil {
                NoteFeatureLoadingState(title: "正在围绕原文整理思路")
                    .padding(.horizontal, 22)
                    .padding(.top, 6)
                Spacer(minLength: 0)
            } else if graphNodes.isEmpty {
                ScrollView {
                    FeatureGenerationPrimer(kind: "mindmap", document: store.noteDocument)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 18)
                }
                .scrollIndicators(.hidden)
            } else {
                NoteMindMapCanvas(
                    nodes: graphNodes,
                    zoom: $zoom,
                    pan: $canvasPan
                )
            }
        }
        .background(DawnBackground())
        .onAppear { store.hidesCompanionShortcut = true }
        .onDisappear { store.hidesCompanionShortcut = false }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            mapDock
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .task {
            if store.aiSettings == nil { await store.loadAccountSettings() }
            await load()
        }
        .onChange(of: store.aiSettings) { _, settings in
            if settings?.canUseExternalAI == true && (requiresAIConsent(failure) || requiresAIDataPolicy(failure)) { failure = nil }
        }
    }

    private var mindMapToolbar: some View {
        HStack(spacing: 11) {
            Button { dismiss() } label: {
                AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                    .frame(width: 18, height: 18)
                    .frame(width: 40, height: 40)
                    .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))
            }
            .buttonStyle(AstellaPressStyle())
            .accessibilityLabel("返回阅读")

            VStack(alignment: .leading, spacing: 2) {
                Text("脑图")
                    .font(StudySerif.font(size: 17, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text(mapSubtitle)
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var mapSubtitle: String {
        let title = store.noteDocument?.title ?? "当前手记"
        guard !graphNodes.isEmpty else { return "从 \(title) 展开" }
        return "\(title) · 第 \(store.noteDocument?.versionNumber ?? 1) 版 · \(graphNodes.count) 个节点"
    }

    private var mapDock: some View {
        HStack(spacing: 6) {
            Button {
                withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) {
                    zoom = max(0.6, zoom / 1.22)
                }
            } label: {
                Image(systemName: "minus.magnifyingglass")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(StudyPalette.ink.opacity(graphNodes.isEmpty ? 0.35 : 0.86))
                    .frame(width: 44, height: 38)
            }
            .buttonStyle(AstellaPressStyle())
            .disabled(graphNodes.isEmpty)
            .accessibilityLabel("缩小脑图")

            Button {
                withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) {
                    canvasPan = .zero
                    zoom = 1
                }
            } label: {
                Text("适应")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(width: 52, height: 38)
            }
            .buttonStyle(AstellaPressStyle())
            .disabled(graphNodes.isEmpty)
            .accessibilityLabel("适应屏幕")

            Button {
                withAnimation(Motion.gated(store.localReduceMotion, Motion.segment)) {
                    zoom = min(2.2, zoom * 1.22)
                }
            } label: {
                Image(systemName: "plus.magnifyingglass")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(StudyPalette.ink.opacity(graphNodes.isEmpty ? 0.35 : 0.86))
                    .frame(width: 44, height: 38)
            }
            .buttonStyle(AstellaPressStyle())
            .disabled(graphNodes.isEmpty)
            .accessibilityLabel("放大脑图")

            Rectangle()
                .fill(StudyPalette.paperEdge.opacity(0.8))
                .frame(width: 0.7, height: 22)
                .padding(.horizontal, 6)

            Button {
                Task { await generate() }
            } label: {
                HStack(spacing: 7) {
                    if loading || working {
                        ProgressView().controlSize(.mini).tint(StudyPalette.accent)
                    } else {
                        AstellaGlyph(kind: .refresh, tint: StudyPalette.accent).frame(width: 14, height: 14)
                    }
                    Text(loading || working
                         ? (graphNodes.isEmpty ? "正在读取…" : "正在整理…")
                         : (graphNodes.isEmpty ? "生成脑图" : "重新生成"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                }
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(StudyPalette.sky.opacity(0.9), in: Capsule())
            }
            .buttonStyle(AstellaPressStyle())
            .disabled(loading || working || store.noteDocument == nil || store.aiSettings?.canUseExternalAI != true || requiresAIConsent(failure) || requiresAIDataPolicy(failure))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .modifier(StudyGlassSurfaceStyle(radius: 22))
        .padding(.horizontal, 20)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(StudyPalette.canvas.opacity(0.001))
    }

    private func load() async {
#if DEBUG
        if store.uiReviewMode == "note-mind-map" {
            let nodes: [[String: Any]] = [
                ["id": "root", "parentId": NSNull(), "kind": "root", "label": "赤壁赋", "explanation": "", "references": []],
                ["id": "opening", "parentId": "root", "kind": "group", "label": "起 · 泛舟", "explanation": "清风明月，遗世独立。", "references": []],
                ["id": "breeze", "parentId": "opening", "kind": "concept", "label": "清风徐来", "explanation": "以风与水写出夜游开篇的安宁。", "references": [["quote": "清风徐来，水波不兴。"]]],
                ["id": "moonlight", "parentId": "opening", "kind": "concept", "label": "白露横江", "explanation": "水光接天，天地忽然开阔。", "references": [["quote": "白露横江，水光接天。"]]],
                ["id": "dialogue", "parentId": "root", "kind": "group", "label": "中 · 问答", "explanation": "主客问答推动全文转折。", "references": []],
                ["id": "guest-sorrow", "parentId": "dialogue", "kind": "concept", "label": "客之悲", "explanation": "客人感叹人生短促、渺小。", "references": [["quote": "寄蜉蝣于天地，渺沧海之一粟。"]]],
                ["id": "su-answer", "parentId": "dialogue", "kind": "concept", "label": "苏子之解", "explanation": "借江月说变与不变，把悲意化为开阔。", "references": [["quote": "逝者如斯，而未尝往也。"]]],
                ["id": "ease", "parentId": "root", "kind": "group", "label": "结 · 释然", "explanation": "结尾回到轻松，归于释然。", "references": []],
                ["id": "shared-ease", "parentId": "ease", "kind": "concept", "label": "客喜而笑", "explanation": "客人转悲为喜，气氛重回轻松。", "references": [["quote": "客喜而笑，洗盏更酌。"]]],
                ["id": "together", "parentId": "ease", "kind": "concept", "label": "相与枕藉", "explanation": "以舟中相枕而眠收束全篇。", "references": [["quote": "相与枕藉乎舟中，不知东方之既白。"]]],
            ]
            map = ["versionState": "current", "noteVersionNumber": 2, "content": ["rootId": "root", "nodes": nodes]]
            return
        }
#endif
        guard let versionId = store.noteDocument?.versionId else { return }
        loading = true
        failure = nil
        defer { loading = false }
        do {
            let page = try await store.noteMindMaps(noteId: noteId)
            let items = page["items"] as? [[String: Any]] ?? []
            map = items.first(where: { $0["noteVersionId"] as? String == versionId }) ?? items.first
            let latest = try await store.latestMindMapTask(noteId: noteId, noteVersionId: versionId)
            if let task = latest["task"] as? [String: Any], ["queued", "running"].contains(task["status"] as? String ?? "") {
                await poll(task)
            }
        } catch {
            failure = noteFeatureFailure(error)
        }
    }

    private func generate() async {
        guard store.aiSettings?.canUseExternalAI == true,
              let versionId = store.noteDocument?.versionId else { return }
        loading = true
        failure = nil
        defer { loading = false }
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
                if let result = value["mindMap"] as? [String: Any] {
                    map = result
                }
                let status = value["status"] as? String ?? ""
                if status == "ready" { working = false; return }
                if status == "failed" {
                    failure = failureLabel(value["failureReason"] as? String)
                    working = false
                    return
                }
                try await Task.sleep(for: .seconds(2))
            } catch {
                failure = noteFeatureFailure(error)
                working = false
                return
            }
        }
        working = false
        failure = "脑图仍在后台整理。稍后重新打开此页即可接着查看。"
    }
}

private struct NoteMindMapNode: Identifiable {
    let id: String
    let parentID: String?
    let kind: String
    let label: String
    let explanation: String?
    let references: [String]

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String,
              let label = value["label"] as? String else { return nil }
        self.id = id
        parentID = value["parentId"] as? String
        kind = value["kind"] as? String ?? "concept"
        self.label = label
        explanation = value["explanation"] as? String
        references = (value["references"] as? [[String: Any]] ?? []).compactMap { $0["quote"] as? String }
    }
}

private struct NoteMindMapPosition: Identifiable {
    let node: NoteMindMapNode
    let depth: Int
    let centerY: CGFloat
    var id: String { node.id }

    static let columnX: [CGFloat] = [20, 156, 306]

    var x: CGFloat { Self.columnX[min(depth, Self.columnX.count - 1)] }
    var width: CGFloat {
        switch node.kind {
        case "root": 112
        case "group": 124
        default: 154
        }
    }
}

private struct NoteMindMapLayout {
    let positions: [NoteMindMapPosition]
    let byID: [String: NoteMindMapPosition]
    let size: CGSize

    init(nodes: [NoteMindMapNode], targetHeight: CGFloat = 0) {
        let nodeByID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        let children = Dictionary(grouping: nodes.compactMap { node -> (String, NoteMindMapNode)? in
            guard let parent = node.parentID else { return nil }
            return (parent, node)
        }, by: \.0).mapValues { $0.map(\.1) }
        let rootID = nodes.first(where: { $0.kind == "root" })?.id ?? nodes.first?.id
        var output: [NoteMindMapPosition] = []
        var row = 0
        let topInset: CGFloat = 40
        let leafCount = nodes.filter { (children[$0.id] ?? []).isEmpty }.count
        let rowSpacing: CGFloat = targetHeight > 0
            ? min(150, max(94, (targetHeight - topInset * 2) / CGFloat(max(1, leafCount - 1))))
            : 92

        func place(_ nodeID: String, depth: Int) -> CGFloat {
            guard let node = nodeByID[nodeID] else { return topInset }
            let visibleChildren = children[nodeID] ?? []
            let centerY: CGFloat
            if visibleChildren.isEmpty {
                centerY = topInset + CGFloat(row) * rowSpacing
                row += 1
            } else {
                let childCenters = visibleChildren.map { place($0.id, depth: depth + 1) }
                centerY = ((childCenters.first ?? topInset) + (childCenters.last ?? topInset)) / 2
            }
            output.append(NoteMindMapPosition(node: node, depth: depth, centerY: centerY))
            return centerY
        }

        if let rootID { _ = place(rootID, depth: 0) }
        positions = output
        byID = Dictionary(uniqueKeysWithValues: output.map { ($0.id, $0) })
        size = CGSize(
            width: 482,
            height: targetHeight > 0
                ? targetHeight
                : max(CGFloat(600), topInset * 2 + CGFloat(max(1, row - 1)) * rowSpacing + 70)
        )
    }
}

private struct NoteMindMapCanvas: View {
    @Environment(\.colorScheme) private var scheme
    let nodes: [NoteMindMapNode]
    @Binding var zoom: CGFloat
    @Binding var pan: CGSize
    @GestureState private var dragTranslation = CGSize.zero
    @GestureState private var pinchScale: CGFloat = 1

    var body: some View {
        GeometryReader { proxy in
            let fit = min(1, (proxy.size.width - 24) / 482)
            let layout = NoteMindMapLayout(
                nodes: nodes,
                targetHeight: fit > 0 ? (proxy.size.height - 32) / fit : 600
            )
            let canvasZoom = min(2.4, max(0.4, zoom * fit * pinchScale))
            let originX = (proxy.size.width - layout.size.width * canvasZoom) / 2 + pan.width + dragTranslation.width
            let originY = max(18, (proxy.size.height - layout.size.height * canvasZoom) / 2) + pan.height + dragTranslation.height
            ZStack(alignment: .topLeading) {
                Color.clear.contentShape(Rectangle())
                dotGrid
                    .frame(width: proxy.size.width, height: proxy.size.height)
                Canvas { context, _ in
                    for position in layout.positions {
                        guard let parentID = position.node.parentID,
                              let parent = layout.byID[parentID] else { continue }
                        var path = Path()
                        let start = CGPoint(
                            x: originX + (parent.x + parent.width) * canvasZoom,
                            y: originY + parent.centerY * canvasZoom
                        )
                        let end = CGPoint(x: originX + position.x * canvasZoom, y: originY + position.centerY * canvasZoom)
                        let reach = max(18 * canvasZoom, (end.x - start.x) * 0.5)
                        path.move(to: start)
                        path.addCurve(
                            to: end,
                            control1: CGPoint(x: start.x + reach, y: start.y),
                            control2: CGPoint(x: end.x - reach, y: end.y)
                        )
                        let strength: Double = position.depth <= 1 ? 0.42 : 0.26
                        context.stroke(
                            path,
                            with: .color(StudyPalette.accent.opacity(strength)),
                            style: StrokeStyle(lineWidth: 1.4 * canvasZoom, lineCap: .round)
                        )
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height)

                ForEach(layout.positions) { position in
                    nodeCard(position)
                        .scaleEffect(canvasZoom)
                        .position(
                            x: originX + (position.x + position.width / 2) * canvasZoom,
                            y: originY + position.centerY * canvasZoom
                        )
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 8)
                    .updating($dragTranslation) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        pan.width += value.translation.width
                        pan.height += value.translation.height
                    }
            )
            .simultaneousGesture(
                MagnificationGesture()
                    .updating($pinchScale) { value, state, _ in state = value }
                    .onEnded { value in zoom = min(2.4, max(0.4, zoom * value)) }
            )
            .accessibilityLabel("无限画布脑图，可拖动平移并双指缩放")
        }
    }

    private var dotGrid: some View {
        Canvas { context, size in
            let spacing: CGFloat = 26
            guard spacing > 0 else { return }
            var y: CGFloat = 13
            while y < size.height {
                var x: CGFloat = 13
                while x < size.width {
                    context.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: 1.6, height: 1.6)),
                        with: .color(StudyPalette.paperEdge.opacity(0.72))
                    )
                    x += spacing
                }
                y += spacing
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func nodeCard(_ position: NoteMindMapPosition) -> some View {
        let node = position.node
        switch node.kind {
        case "root":
            VStack(spacing: 7) {
                AstellaGlyph(kind: .companion, tint: .white.opacity(0.72))
                    .frame(width: 13, height: 13)
                Text(node.label)
                    .font(StudySerif.font(size: 18, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(.white.opacity(0.96))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(width: position.width - 24)
            .frame(minHeight: 68)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(LinearGradient(
                        colors: scheme == .dark
                            ? [Color(red: 0.14, green: 0.21, blue: 0.36), Color(red: 0.10, green: 0.15, blue: 0.27)]
                            : [StudyPalette.ink, StudyPalette.ink.opacity(0.84)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(.white.opacity(0.16), lineWidth: 0.8)
            )
            .shadow(color: StudyPalette.ink.opacity(0.22), radius: 12, x: 0, y: 6)
            .accessibilityLabel("中心主题：\(node.label)")
        case "group":
            HStack(alignment: .center, spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(StudyPalette.accent)
                    .frame(width: 3, height: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(node.label)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let explanation = node.explanation, !explanation.isEmpty {
                        Text(explanation)
                            .font(.system(size: 10.5))
                            .lineSpacing(2)
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .frame(width: position.width, alignment: .leading)
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(StudyPalette.paperEdge.opacity(0.9), lineWidth: 0.8)
            )
            .shadow(color: StudyPalette.ink.opacity(0.06), radius: 8, x: 0, y: 4)
            .accessibilityLabel("分支：\(node.label)")
        default:
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Circle()
                        .fill(StudyPalette.accent.opacity(0.85))
                        .frame(width: 4, height: 4)
                    Text(node.label)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if let explanation = node.explanation?.trimmingCharacters(in: .whitespacesAndNewlines), !explanation.isEmpty {
                    Text(explanation)
                        .font(.system(size: 11))
                        .lineSpacing(2.5)
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(width: position.width, alignment: .leading)
            .background(StudyPalette.paper.opacity(0.94), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(Color.white.opacity(scheme == .dark ? 0.10 : 0.9), lineWidth: 0.8)
            )
            .shadow(color: StudyPalette.ink.opacity(0.05), radius: 7, x: 0, y: 3)
            .accessibilityLabel("要点：\(node.label)")
        }
    }
}

private struct FeatureAuthorizationNotice: View {
    @Environment(AppStore.self) private var store
    var error: String?

    var body: some View {
        Group {
            if store.aiSettings?.needsSigning == true || requiresAIConsent(error) {
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
                NoteAISettingsButton {
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

private struct NoteFeatureLoadingState: View {
    var title: String

    var body: some View {
        HStack(spacing: 11) {
            ProgressView().tint(StudyPalette.accent)
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(StudyPalette.muted)
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(StudyGlassSurfaceStyle(radius: 18))
    }
}

private struct NoteFeatureActionDock: View {
    @Environment(AppStore.self) private var store
    var actionTitle: String
    var isWorking: Bool
    var isAvailable: Bool
    var error: String?
    var action: () -> Void

    private var needsSigning: Bool {
        store.aiSettings?.needsSigning == true || requiresAIConsent(error)
    }
    private var externalAIBlocked: Bool {
        store.aiSettings?.dataPolicy.sendToExternal == false || requiresAIDataPolicy(error)
    }

    var body: some View {
        VStack(spacing: 10) {
            if needsSigning || externalAIBlocked {
                HStack(alignment: .top, spacing: 10) {
                    AstellaGlyph(kind: .info, tint: StudyPalette.accent).frame(width: 19, height: 19)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(needsSigning ? "这项整理需要你的授权" : "外部 AI 已关闭")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                        Text(needsSigning
                             ? "先在「我的 → AI 与数据」阅读协议，再由你决定是否授权。确认前不会发送这篇手记。"
                             : "当前数据偏好不允许外部 AI 处理这篇手记。")
                            .font(.caption).lineSpacing(2).foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.62), lineWidth: 0.7))

                NoteAISettingsButton {
                    astellaLabel("查看 AI 使用设置", glyph: .settings).frame(maxWidth: .infinity)
                }
                .modifier(PrimaryActionStyle())
            } else if store.aiSettings == nil {
                if store.isAccountBusy {
                    HStack(spacing: 9) {
                        ProgressView().controlSize(.small).tint(StudyPalette.accent)
                        Text("正在确认使用设置…").font(.footnote).foregroundStyle(StudyPalette.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                } else {
                    Button { Task { await store.loadAccountSettings() } } label: {
                        astellaLabel("重新读取使用设置", glyph: .refresh).frame(maxWidth: .infinity)
                    }
                    .modifier(SecondaryActionStyle())
                }
            } else {
                Button(action: action) {
                    HStack(spacing: 8) {
                        if isWorking { ProgressView().tint(.white) }
                        else { AstellaGlyph(kind: .companion, tint: .white).frame(width: 17, height: 17) }
                        Text(isWorking ? "正在整理…" : actionTitle)
                    }
                    .frame(maxWidth: .infinity)
                }
                .modifier(PrimaryActionStyle())
                .disabled(isWorking || !isAvailable)
            }
        }
        .padding(.horizontal, 20)
        .padding(.trailing, 74)
        .padding(.top, 12)
        .padding(.bottom, 7)
        .background(StudyPalette.canvas.ignoresSafeArea(edges: .bottom))
    }
}

private struct FeatureGenerationPrimer: View {
    let kind: String
    let document: NoteDocument?

    private var title: String {
        switch kind {
        case "overview": "先抓住整篇主线，再回看关键原句"
        case "mindmap": "脑图会按层级展开"
        case "expansion": "从原文生长出下一篇手记"
        case "learning-card": "一题一页，按这版笔记练习"
        default: "跟着原文一步一步读懂"
        }
    }

    private var description: String {
        switch kind {
        case "overview": "把一篇长手记整理成主线、关键点和对应的原文依据。"
        case "mindmap": "从这份手记提取主题、分支关系和原文出处。"
        case "expansion": "围绕当前版本准备几份拓展草稿，你可以挑选要收下的笔记。"
        case "learning-card": "题型随笔记内容搭配，每题都有原文依据，完成后再一起核对。"
        default: "从主题开始逐步解释，每一步都能对照到这篇手记里的段落。"
        }
    }

    private var excerpt: String? {
        guard let document else { return nil }
        let candidates = document.blocks
            .filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0.type.lowercased().contains("image") }
            .map { $0.content.replacingOccurrences(of: "\n", with: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        guard let value = candidates.first(where: { $0.count >= 30 }) ?? candidates.first else { return nil }
        let excerpt = String(value.prefix(112))
        return excerpt + (value.count > 112 ? "…" : "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            HStack(alignment: .top, spacing: 12) {
                AstellaGlyph(kind: kind == "mindmap" ? .mindMap : kind == "overview" ? .document : .book, tint: StudyPalette.accent)
                    .frame(width: 21, height: 21)
                    .frame(width: 44, height: 44)
                    .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    Text("尚未生成 · 第 \(document?.versionNumber ?? 1) 版")
                        .font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    Text(description).font(.subheadline).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                    Text(kind == "overview" ? "整理后会看到" : kind == "mindmap" ? "从正文长出" : kind == "expansion" ? "你可以这样使用" : kind == "learning-card" ? "答题会这样进行" : "讲解会这样展开")
                    .font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.muted)
                if kind == "overview" {
                    previewRow("01", title: "主线", detail: "一段话看清整篇在说什么", isFirst: true)
                    previewRow("02", title: "关键点", detail: "把重要的转折和关系分开")
                    previewRow("03", title: "原文依据", detail: "每个要点都能回到对应原句")
                } else if kind == "mindmap" {
                    previewRow("01", title: "主题与分支", detail: "从中心向外展开，不挤在一屏里", isFirst: true)
                    previewRow("02", title: "原文出处", detail: "节点保留对应的笔记段落")
                } else if kind == "expansion" {
                    previewRow("01", title: "先看草稿", detail: "每篇都展示它和原文的关系", isFirst: true)
                    previewRow("02", title: "自己挑选", detail: "确认后另存为新手记")
                    previewRow("03", title: "保留关系", detail: "新旧手记之间可以互相找到")
                } else if kind == "learning-card" {
                    previewRow("01", title: "一题一页", detail: "在手机上逐题作答", isFirst: true)
                    previewRow("02", title: "草稿自动保存", detail: "可以跳题，之后继续")
                    previewRow("03", title: "交卷后回看", detail: "答案、批改和原文依据一起显示")
                } else {
                    previewRow("01", title: "先看主题", detail: "先说明这部分在讲什么", isFirst: true)
                    previewRow("02", title: "结合原文解释", detail: "沿着段落次序逐步展开")
                    previewRow("03", title: "留下出处", detail: "每一步都能对照原文")
                }
            }
            if let excerpt {
                VStack(alignment: .leading, spacing: 7) {
                    Text("从这段原文开始")
                        .font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.muted)
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2).fill(StudyPalette.accent.opacity(0.58)).frame(width: 2)
                        Text("“\(excerpt)”")
                            .font(.system(size: 14))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink.opacity(0.78))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack(spacing: 7) {
                AstellaGlyph(kind: .info, tint: StudyPalette.muted).frame(width: 13, height: 13)
                Text("这份整理会单独保存，不会改动原文。")
                    .font(.caption).foregroundStyle(StudyPalette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .modifier(StudyGlassSurfaceStyle(radius: 22))
    }

    private func previewRow(_ number: String, title: String, detail: String, isFirst: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(number)
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(isFirst ? StudyPalette.accent : StudyPalette.muted)
                .frame(width: 27, alignment: .leading)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.caption).foregroundStyle(StudyPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
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
