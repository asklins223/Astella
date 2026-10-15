import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ConversationScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var composerFocused: Bool
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showNotes = false
    @State private var menuOpen = false
    @State private var voiceCapture = VoiceCapture()
    @State private var flight: CompanionFlight?
    @State private var flightOrigin: CGPoint?
    @State private var dragOffset = CGSize.zero
    @State private var attachmentTask: Task<Void, Never>?
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
                    ZStack {
                        if store.chatShowsRecords {
                            MessageHistory(messages: store.messages, streamingText: store.streamingText)
                                .transition(reduced ? .opacity : .offset(x: 24).combined(with: .opacity))
                        } else {
                            CompanionScene(message: store.messages.last(where: { $0.role == "assistant" }),
                                           streamingText: store.streamingText,
                                           audioLevel: voiceCapture.isRecording ? voiceCapture.level : store.voicePlayback.level,
                                           audioActive: voiceCapture.isRecording || store.voicePlayback.isPlaying) { prompt in
                                store.draft = prompt; composerFocused = true
                            }
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
                    composer
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
        .toolbar(.hidden, for: .tabBar)
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, .init(filenameExtension: "md") ?? .plainText, .init(filenameExtension: "docx") ?? .data]) { result in
            if case .success(let url) = result { Task { await store.prepareFile(url) } }
            if case .failure(let error) = result { store.errorMessage = error.localizedDescription }
        }
        .sheet(isPresented: $showNotes) { notePicker }
        .task { if store.conversationId == nil { await store.loadConversation() } }
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
                        } else { Image(systemName: "doc.text.fill").foregroundStyle(StudyPalette.accent) }
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
                    Button { store.selectedImage = nil; store.selectedFile = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(StudyPalette.muted) }
                        .frame(width: 44, height: 44).accessibilityLabel("移除附件")
                }.padding(.leading, 12).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 16))
            }
            if let context = store.pendingNoteContext {
                HStack {
                    Label(context.title, systemImage: "book.closed").font(.caption).lineLimit(1)
                    Spacer()
                    Button { store.clearPendingNoteContext() } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("移除引用")
                }.padding(12).background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 14))
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button {
                    composerFocused = false
                    withAnimation(Motion.gated(reduced, Motion.segment)) { menuOpen.toggle() }
                } label: {
                    Image(systemName: "plus").rotationEffect(.degrees(menuOpen ? 45 : 0)).font(.system(size: 20, weight: .light)).frame(width: 40, height: 40)
                        .foregroundStyle(StudyPalette.paper).background(StudyPalette.accent.opacity(0.92), in: RoundedRectangle(cornerRadius: 14))
                }.accessibilityLabel("添加图片或文件")
                TextField("和伴星说说…", text: $store.draft, axis: .vertical)
                    .font(.system(size: 14)).lineLimit(1...5).focused($composerFocused).padding(.vertical, 12).padding(.horizontal, 6)
                Button {
                    composerFocused = false
                    if voiceCapture.isRecording { Task { if let text = await voiceCapture.finish(store: store) { store.draft = text } } }
                    else { voiceCapture.start(store: store) }
                } label: {
                    Image(systemName: voiceCapture.isRecording ? "stop.fill" : "mic").font(.system(size: 20)).frame(width: 44, height: 46)
                }.disabled(voiceCapture.isTranscribing || store.isSending)
                    .foregroundStyle(voiceCapture.isRecording ? StudyPalette.danger : StudyPalette.accent)
                    .accessibilityLabel(voiceCapture.isRecording ? "完成录音" : "语音输入")
                Button {
                    let text = store.draft
                    Task {
                        await store.submit(text: text)
                        if store.errorMessage == nil && store.draft == text { store.draft = "" }
                    }
                } label: {
                    Image(systemName: store.isSending ? "ellipsis" : "arrow.up").font(.system(size: 17, weight: .semibold))
                        .frame(width: 40, height: 40).foregroundStyle(canSend ? .white : StudyPalette.muted)
                        .background(canSend ? StudyPalette.accent : StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13)).padding(3)
                }.disabled(!canSend).accessibilityLabel("发送")
            }.padding(8).modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
        }
        .padding(.horizontal, 22).padding(.top, 10).padding(.bottom, 14)
        .animation(Motion.gated(reduced, Motion.segment), value: store.selectedImage != nil || store.selectedFile != nil)
    }

    private var attachmentMenu: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack { Text("交给伴星").font(.system(size: 11, weight: .medium)).tracking(2); Spacer(); AstellaStar().fill(StudyPalette.accent).frame(width: 11, height: 15) }
                .foregroundStyle(StudyPalette.muted).padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 9)
            menuItem("加图片", detail: "一起看见细节", icon: "photo", index: 2) { showPhotos = true }
            menuItem("加文件", detail: "PDF · Word · 文本", icon: "doc.text", index: 1) { showFiles = true }
            menuItem("引用手记", detail: "接着已有的思路", icon: "book.closed", index: 0) { showNotes = true }
        }.padding(8).frame(width: 252).modifier(StudyGlassSurfaceStyle(radius: 24, interactive: true))
    }
    private func menuItem(_ label: String, detail: String, icon: String, index: Int, action: @escaping () -> Void) -> some View {
        Button { closeMenu(); action() } label: {
            HStack(spacing: 13) {
                Image(systemName: icon).font(.system(size: 19, weight: .light)).frame(width: 42, height: 42).background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 4) {
                    Text(label).font(.system(size: 14, weight: .medium))
                    Text(detail).font(.system(size: 10)).foregroundStyle(StudyPalette.muted)
                }
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
            }.foregroundStyle(StudyPalette.ink).frame(minHeight: 58).padding(.horizontal, 12)
        }.buttonStyle(AstellaPressStyle()).offset(y: menuOpen || reduced ? 0 : CGFloat(14 * index))
        .opacity(menuOpen ? 1 : 0)
        .animation(reduced ? nil : Motion.segment.delay(menuOpen ? Double(index) * Motion.menuStagger : 0), value: menuOpen)
    }
    private func closeMenu() { withAnimation(Motion.gated(reduced, Motion.press)) { menuOpen = false } }
    private func animateAbsorption() {
        guard !reduced else { return }
        flight = CompanionFlight(origin: flightOrigin, icon: store.selectedFile == nil ? "photo.fill" : "doc.text.fill")
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
                Button { store.voicePlayback.togglePause() } label: { Image(systemName: store.voicePlayback.isPaused ? "play.fill" : "pause.fill") }.frame(width: 44, height: 40)
            }
            Button { store.voicePlayback.stop() } label: { Image(systemName: "stop.fill") }.frame(width: 44, height: 40).accessibilityLabel("停止朗读")
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
                } label: { Label(note.title, systemImage: "doc.text") }
            }.navigationTitle("引用手记")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { showNotes = false } } }
                .task { await store.loadNotes() }
        }.presentationDetents([.medium, .large])
    }
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
    let icon: String
}
private struct CompanionFlightView: View {
    let flight: CompanionFlight
    let origin: CGPoint
    let target: CGPoint
    let completion: () -> Void
    @State private var progress: CGFloat = 0
    var body: some View {
        Image(systemName: flight.icon).font(.title2).foregroundStyle(StudyPalette.accent)
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
