import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ConversationScreen: View {
    var onOpenNote: (String) -> Void
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var composerFocused: Bool
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showNotes = false
    @State private var showHistoryActions = false
    @State private var menuOpen = false
    @State private var voiceCapture = VoiceCapture()
    @State private var flight: CompanionFlight?
    @State private var flightOrigin: CGPoint?
    @State private var dragOffset = CGSize.zero
    @State private var attachmentTask: Task<Void, Never>?
    @State private var lastHandledComposerFocusRequestID = 0
    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }
    private var canSend: Bool {
        store.conversationId != nil && !store.isSending && !voiceCapture.isRecording && !voiceCapture.isTranscribing &&
        (!store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.selectedImage != nil || store.selectedFile != nil)
    }

    var body: some View {
        @Bindable var store = store
        GeometryReader { geometry in
            ZStack(alignment: .bottomLeading) {
                VStack(spacing: 0) {
                    ConversationTopBar(isVoiceBusy: voiceCapture.isRecording || voiceCapture.isTranscribing)
                    ZStack {
                        if store.chatShowsRecords {
                            MessageHistory(
                                messages: store.messages,
                                streamingText: store.streamingText,
                                onMore: { showHistoryActions = true },
                                onOpenNote: onOpenNote
                            )
                                .transition(reduced ? .opacity : .offset(x: 24).combined(with: .opacity))
                        } else {
                            CompanionScene(message: store.messages.last(where: { $0.role == "assistant" }),
                                           streamingText: store.streamingText,
                                           audioActive: voiceCapture.isRecording || store.voicePlayback.isPlaying,
                                           onOpenNote: { onOpenNote($0) })
                            .transition(reduced ? .opacity : .offset(x: -24).combined(with: .opacity))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .animation(Motion.gated(reduced, Motion.segment), value: store.chatShowsRecords)
                    if let error = store.errorMessage {
                        ConversationFailurePanel(message: error) { Task { await store.loadConversation() } }
                    }
                    if voiceCapture.isRecording || voiceCapture.isTranscribing { recordingBar }
                    if store.voicePlayback.isPlaying || store.voicePlayback.isPaused || store.voicePlayback.isLoading { playbackBar }
                }
                Color.black.opacity(menuOpen ? 0.08 : 0).ignoresSafeArea()
                    .onTapGesture { closeMenu() }.allowsHitTesting(menuOpen).accessibilityHidden(true)
                    .animation(reduced ? nil : .easeOut(duration: 0.16), value: menuOpen)
                attachmentMenu.padding(.leading, 22).padding(.bottom, 92)
                    .opacity(menuOpen ? 1 : 0)
                    .scaleEffect(menuOpen || reduced ? 1 : 0.94, anchor: .bottomLeading)
                    .animation(Motion.gated(reduced, Motion.segment), value: menuOpen)
                    .allowsHitTesting(menuOpen).accessibilityHidden(!menuOpen)
                if let flight, !reduced {
                    CompanionFlightView(flight: flight,
                        origin: flight.origin ?? CGPoint(x: 54, y: geometry.size.height - 110),
                        target: CGPoint(x: geometry.size.width * 0.5, y: geometry.size.height * 0.3)) {
                            if self.flight?.id == flight.id { self.flight = nil; store.emitCompanion(.absorb(success: true)) }
                        }.id(flight.id).allowsHitTesting(false)
                }
            }
            .coordinateSpace(name: "conversation")
        }
        .background(DawnBackground())
        .sheet(item: Bindable(store).resultPreview) { target in
            CompanionResultPreviewSheet(target: target, onOpenNote: onOpenNote)
        }
        .onChange(of: store.chatShowsRecords) { _, records in
            if records { Task { await store.refreshRuns(includeThinking: true) } }
        }
        .toolbar(.hidden, for: .tabBar)
        // The dock lives in MainTabShell and never leaves the screen; the composer
        // floats just above it, the way an iOS 26 bottom accessory sits over the
        // tab bar. Keeping the dock out of this screen is what stops it from being
        // rebuilt (and hard-cutting) on every tab change.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AstellaGlassContainer(spacing: 14) {
                composer
                    .padding(.horizontal, 6)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .modifier(StudyGlassSurfaceStyle(radius: 27, interactive: true))
                    .astellaGlassMaterialize()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 6)
        }
        .confirmationDialog("对话操作", isPresented: $showHistoryActions, titleVisibility: .visible) {
            Button("递一份材料") { withAnimation(Motion.gated(reduced, Motion.segment)) { menuOpen = true } }
            Button("回到伴星") { withAnimation(Motion.gated(reduced, Motion.segment)) { store.chatShowsRecords = false } }
            Button("取消", role: .cancel) {}
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, .init(filenameExtension: "md") ?? .plainText, .init(filenameExtension: "docx") ?? .data]) { result in
            if case .success(let url) = result { Task { await store.prepareFile(url) } }
            if case .failure(let error) = result { store.errorMessage = error.localizedDescription }
        }
        .sheet(isPresented: $showNotes) { notePicker }
        .task {
            if store.conversationId == nil { await store.loadConversation() }
            honorComposerFocusRequest()
        }
        .onAppear { honorComposerFocusRequest() }
        .onChange(of: photoItem) { _, item in
            attachmentTask?.cancel()
            attachmentTask = Task {
                do {
                    guard let item, let data = try await item.loadTransferable(type: Data.self), !Task.isCancelled else { return }
                    store.prepareImage(data)
                } catch { store.errorMessage = "这张图片没有读取完成，请重新选择。" }
            }
        }
        .onChange(of: store.attachmentRevision) { _, _ in animateAbsorption() }
        .onChange(of: composerFocused) { _, focused in
            store.composerHasFocus = focused
            if focused { closeMenu() }
        }
        .onChange(of: store.composerFocusRequestID) { _, _ in honorComposerFocusRequest() }
        .onChange(of: reduced) { _, disabled in if disabled { flight = nil } }
        .onChange(of: store.draft) { _, value in if value != voiceCapture.transcript { store.voiceArtifactId = nil } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { voiceCapture.cancel(); store.voicePlayback.stop() } }
        .onDisappear { store.composerHasFocus = false; voiceCapture.cancel(); store.voicePlayback.stop(); attachmentTask?.cancel() }
        .dropDestination(for: URL.self) { urls, point in
            guard let url = urls.first else { return false }
            flightOrigin = point
            Task {
                if ["jpg", "jpeg", "png", "webp", "heic"].contains(url.pathExtension.lowercased()) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    do { store.prepareImage(try Data(contentsOf: url)) }
                    catch { store.errorMessage = "图片没有读到，请重新添加。" }
                } else { await store.prepareFile(url) }
            }
            return true
        } isTargeted: { targeted in if targeted { store.emitCompanion(.attention) } }
    }

    private var composer: some View {
        @Bindable var store = store
        return VStack(spacing: 8) {
            if store.selectedImage != nil || store.selectedFile != nil {
                HStack(spacing: 10) {
                    Group {
                        if let data = store.selectedImage, let image = UIImage(data: data) {
                            Image(uiImage: image).resizable().scaledToFill()
                        } else { AstellaGlyph(kind: .document, tint: StudyPalette.accent) }
                    }.frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 10))
                        .offset(dragOffset)
                        .gesture(DragGesture(coordinateSpace: .named("conversation"))
                            .onChanged { dragOffset = $0.translation; store.emitCompanion(.attention) }
                            .onEnded { value in
                                dragOffset = .zero
                                if value.translation.height < -40 { flightOrigin = value.location; animateAbsorption() }
                            })
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.selectedFile?.name ?? "已添加图片").font(.footnote.weight(.medium)).lineLimit(1)
                        Text("发送时交给伴星").font(.caption2).foregroundStyle(StudyPalette.muted)
                    }
                    Spacer(minLength: 0)
                    if store.selectedFile != nil {
                        Button("存为手记") { Task { await store.importPreparedFile() } }.font(.caption.weight(.semibold)).disabled(store.isSending)
                    }
                    Button { store.selectedImage = nil; store.selectedFile = nil } label: { AstellaGlyph(kind: .close, tint: StudyPalette.muted).frame(width: 17, height: 17) }
                        .frame(width: 44, height: 44).accessibilityLabel("移除附件")
                }.padding(.leading, 12).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 16))
            }
            if let context = store.pendingNoteContext {
                HStack {
                    HStack(spacing: 7) { AstellaGlyph(kind: .book, tint: StudyPalette.accent).frame(width: 15, height: 15); Text(context.title) }.font(.caption).lineLimit(1)
                    Spacer()
                    Button { store.clearPendingNoteContext() } label: { AstellaGlyph(kind: .close, tint: StudyPalette.muted).frame(width: 15, height: 15) }.accessibilityLabel("移除引用")
                }.padding(12).background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 14))
            } else if let reference = store.pendingDiaryReference {
                HStack {
                    HStack(spacing: 7) {
                        AstellaGlyph(kind: .orbit, tint: StudyPalette.accent).frame(width: 15, height: 15)
                        Text("日记 · \(reference.date) · 第 \(reference.version) 版")
                    }.font(.caption).lineLimit(1)
                    Spacer()
                    Button { store.clearPendingDiaryReference() } label: { AstellaGlyph(kind: .close, tint: StudyPalette.muted).frame(width: 15, height: 15) }.accessibilityLabel("移除日记引用")
                }.padding(12).background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 14))
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button {
                    composerFocused = false
                    withAnimation(Motion.gated(reduced, Motion.segment)) { menuOpen.toggle() }
                } label: {
                        AstellaGlyph(kind: .add, tint: StudyPalette.muted).rotationEffect(.degrees(menuOpen ? 45 : 0)).frame(width: 25, height: 25)
                            .frame(width: 42, height: 42)
                }.accessibilityLabel("添加图片或文件")
                TextField("说给伴星听…", text: $store.draft, axis: .vertical)
                    .font(.system(size: 16)).lineLimit(1...5).focused($composerFocused).padding(.vertical, 9).padding(.horizontal, 6)
                let voiceAction = store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.selectedImage == nil && store.selectedFile == nil
                Button {
                    composerFocused = false
                    if voiceCapture.isRecording {
                        Task { if let text = await voiceCapture.finish(store: store) { store.draft = text } }
                    } else if voiceAction {
                        voiceCapture.start(store: store)
                    } else {
                        let text = store.draft
                        Task {
                            await store.submit(text: text)
                            if store.errorMessage == nil && store.draft == text { store.draft = "" }
                        }
                    }
                } label: {
                    let glyph: AstellaGlyphKind = voiceCapture.isRecording ? .stop : (voiceAction ? .mic : (store.isSending ? .more : .send))
                    AstellaGlyph(kind: glyph, tint: voiceCapture.isRecording ? StudyPalette.danger : (!voiceAction && canSend ? .white : StudyPalette.accent))
                        .frame(width: 21, height: 21).frame(width: 42, height: 42)
                        .background(!voiceAction && canSend ? StudyPalette.accent : StudyPalette.sky, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                }.disabled(voiceCapture.isTranscribing || store.isSending || (!voiceAction && !canSend))
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityLabel(voiceCapture.isRecording ? "完成录音" : (voiceAction ? "语音输入" : "发送"))
            }.padding(6)
        }
        .animation(Motion.gated(reduced, Motion.segment), value: store.selectedImage != nil || store.selectedFile != nil)
    }

    private func honorComposerFocusRequest() {
        let requestID = store.composerFocusRequestID
        guard requestID != lastHandledComposerFocusRequestID else { return }
        lastHandledComposerFocusRequestID = requestID
        Task { @MainActor in
            await Task.yield()
            guard store.selectedTab == .conversation, store.composerFocusRequestID == requestID else { return }
            composerFocused = true
        }
    }

    private var attachmentMenu: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack { Text("交给伴星").font(.system(size: 10.5, weight: .semibold)).tracking(1.4); Spacer(); AstellaStar().fill(StudyPalette.accent).frame(width: 11, height: 15) }
                .foregroundStyle(StudyPalette.muted).padding(.horizontal, 14).padding(.top, 13).padding(.bottom, 9)
            menuItem("加图片", detail: "一起看见细节", icon: .photo, index: 2) { showPhotos = true }
            menuItem("加文件", detail: "PDF · Word · 文本", icon: .document, index: 1) { showFiles = true }
            menuItem("引用手记", detail: "接着已有的思路", icon: .book, index: 0) { showNotes = true }
        }.padding(8).frame(width: 254).modifier(StudyGlassSurfaceStyle(radius: 24, interactive: true))
    }
    private func menuItem(_ label: String, detail: String, icon: AstellaGlyphKind, index: Int, action: @escaping () -> Void) -> some View {
        Button { closeMenu(); action() } label: {
            HStack(spacing: 13) {
                AstellaGlyph(kind: icon, tint: StudyPalette.accent).frame(width: 20, height: 20).frame(width: 40, height: 40).background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 3) {
                    Text(label).font(.system(size: 14, weight: .medium))
                    Text(detail).font(.system(size: 10.5)).foregroundStyle(StudyPalette.muted)
                }
                Spacer()
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 11, height: 11)
            }.foregroundStyle(StudyPalette.ink).frame(minHeight: 56).padding(.horizontal, 12)
        }.buttonStyle(AstellaPressStyle()).offset(y: menuOpen || reduced ? 0 : CGFloat(14 * index))
        .opacity(menuOpen ? 1 : 0)
        .animation(reduced ? nil : Motion.segment.delay(menuOpen ? Double(index) * Motion.menuStagger : 0), value: menuOpen)
    }
    private func closeMenu() { withAnimation(Motion.gated(reduced, Motion.press)) { menuOpen = false } }
    private func animateAbsorption() {
        guard !reduced else { return }
        flight = CompanionFlight(origin: flightOrigin, icon: store.selectedFile == nil ? .photo : .document)
        flightOrigin = nil
    }
    private var recordingBar: some View {
        HStack(spacing: 12) {
            Circle().fill(StudyPalette.danger).frame(width: 7, height: 7)
            Text(voiceCapture.isTranscribing ? "正在听清这句话…" : "伴星在听，点麦克风完成").font(.caption)
            Spacer()
            if voiceCapture.isRecording { Button("取消") { voiceCapture.cancel() }.font(.caption.weight(.medium)) }
        }.padding(.horizontal, 24).padding(.vertical, 10)
    }
    private var playbackBar: some View {
        HStack {
            Text(store.voicePlayback.isLoading ? "正在接回声音…" : "伴星的声音").font(.caption)
            Spacer()
            if !store.voicePlayback.isLoading {
                Button { store.voicePlayback.togglePause() } label: { AstellaGlyph(kind: store.voicePlayback.isPaused ? .play : .pause).frame(width: 18, height: 18) }.frame(width: 44, height: 40)
            }
            Button { store.voicePlayback.stop() } label: { AstellaGlyph(kind: .stop).frame(width: 16, height: 16) }.frame(width: 44, height: 40).accessibilityLabel("停止朗读")
        }.padding(.horizontal, 24)
    }
    private var notePicker: some View {
        NavigationStack {
            List(store.notes) { note in
                Button {
                    Task {
                        await store.loadNote(note.id)
                        if let document = store.noteDocument { store.continueWithNote(document); showNotes = false }
                    }
                } label: { HStack(spacing: 10) { AstellaGlyph(kind: .book, tint: StudyPalette.accent).frame(width: 18, height: 18); Text(note.title) } }
            }.navigationTitle("引用手记")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { showNotes = false } } }
                .task { await store.loadNotes() }
        }.presentationDetents([.medium, .large])
    }
}

private struct ConversationTopBar: View {
    var isVoiceBusy = false
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("study.appearance.dark") private var darkMode = false
    @AppStorage("study.appearance.mode") private var appearanceMode = "light"
    private var isDark: Bool { appearanceMode == "dark" || (appearanceMode == "system" && colorScheme == .dark) }

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < 410
            let modeWidth = compact ? min(116, geometry.size.width * 0.31) : 122
            let workspaceWidth = max(100, geometry.size.width - modeWidth - 104)

            HStack(spacing: 8) {
                Menu {
                    ForEach(store.workspaces) { workspace in
                        Button {
                            Task { await store.switchWorkspace(workspace) }
                        } label: {
                            Label {
                                Text(workspace.name)
                            } icon: {
                                if workspace.id == store.profile?.workspaceId {
                                    AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 15, height: 15)
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(StudyPalette.actionFill).frame(width: 6, height: 6)
                        Text(store.profile?.workspaceName ?? "我的书房")
                            .font(.system(size: 12.5, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .foregroundStyle(StudyPalette.ink)
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 9, height: 9).rotationEffect(.degrees(90))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .frame(width: workspaceWidth, alignment: .leading)
                .disabled(store.workspaces.count < 2 || store.isAccountBusy || store.isSending || isVoiceBusy)
                .accessibilityLabel("切换书房")

                Spacer(minLength: 2)
                HStack(spacing: 0) {
                    modeButton(title: "伴星", records: false)
                    modeButton(title: "记录", records: true)
                }
                .frame(width: modeWidth, height: 38)
                .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
                .accessibilityElement(children: .contain)
                Spacer(minLength: 2)

                Button {
                    let next = !isDark
                    withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment)) {
                        darkMode = next
                        appearanceMode = next ? "dark" : "light"
                    }
                } label: {
                    AstellaGlyph(kind: isDark ? .sun : .moon, tint: StudyPalette.ink)
                        .frame(width: 22, height: 22)
                        .frame(width: 38, height: 38)
                        .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel(isDark ? "切换到浅色外观" : "切换到深色外观")
            }
            .padding(.horizontal, 22)
            .padding(.top, 2)
            .padding(.bottom, 8)
        }
        .frame(height: 62)
        .sensoryFeedback(.selection, trigger: store.chatShowsRecords)
    }

    private func modeButton(title: String, records: Bool) -> some View {
        let selected = store.chatShowsRecords == records
        return Button {
            withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment)) {
                store.chatShowsRecords = records
            }
        } label: {
            ZStack {
                if selected {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(StudyPalette.sky)
                        .overlay(
                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                .stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.7)
                        )
                        .shadow(color: StudyPalette.ink.opacity(0.05), radius: 4, x: 0, y: 2)
                        .matchedGeometryEffect(id: "conversation-mode-lens", in: modeLens)
                        .padding(3)
                }
                Text(title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    @Namespace private var modeLens
}

private struct CompanionAbsorptionFlight: AnimatableModifier {
    var progress: CGFloat
    let origin: CGPoint
    let target: CGPoint
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        let t = progress, u = 1 - t
        let control = CGPoint(x: target.x + 90, y: origin.y - 180)
        let x = u * u * origin.x + 2 * u * t * control.x + t * t * target.x
        let y = u * u * origin.y + 2 * u * t * control.y + t * t * target.y
        content.scaleEffect(1 - t * 0.86).rotationEffect(.degrees(Double(t) * -24))
            .opacity(Double(min(1, (1 - t) * 6))).position(x: x, y: y)
    }
}

private struct CompanionFlight: Identifiable {
    let id = UUID()
    let origin: CGPoint?
    let icon: AstellaGlyphKind
}
private struct CompanionFlightView: View {
    let flight: CompanionFlight
    let origin: CGPoint
    let target: CGPoint
    let completion: () -> Void
    @State private var progress: CGFloat = 0
    var body: some View {
        AstellaGlyph(kind: flight.icon, tint: StudyPalette.accent).frame(width: 22, height: 22)
            .padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
            .modifier(CompanionAbsorptionFlight(progress: progress, origin: origin, target: target))
            .task {
                withAnimation(.timingCurve(0.2, 0.7, 0.15, 1, duration: 0.52), completionCriteria: .logicallyComplete) {
                    progress = 1
                } completion: {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    completion()
                }
            }
    }
}
