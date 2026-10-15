import SwiftUI
import PhotosUI
import UIKit

struct ConversationScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool
    @State private var draft = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var voiceCapture = VoiceCapture()

    private var latestMessage: CompanionMessage? {
        store.messages.last(where: { $0.role == "assistant" })
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("交流视图", selection: Binding(get: { store.chatShowsRecords }, set: { store.setChatShowsRecords($0) })) {
                Text("伴星").tag(false)
                Text("记录").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 6)

            Group {
                if store.chatShowsRecords {
                    MessageHistory(messages: store.messages, streamingText: store.streamingText)
                        .transition(reduceMotion || store.localReduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                } else {
                    CompanionScene(message: latestMessage, streamingText: store.streamingText) { prompt in
                        draft = prompt
                        composerFocused = true
                    }
                        .transition(reduceMotion || store.localReduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment), value: store.chatShowsRecords)

            if let error = store.errorMessage {
                ConversationFailurePanel(message: error) {
                    Task { await store.loadConversation() }
                }
            }
            composer
        }
        .background(DawnBackground())
        .toolbar(composerFocused ? .hidden : .visible, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 10) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(store.realtimeStatus == "已连接" ? StudyPalette.success : StudyPalette.muted.opacity(0.6))
                            .frame(width: 7, height: 7)
                        Text(store.realtimeStatus)
                            .font(.caption2)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    NavigationLink {
                        AccountScreen().navigationTitle("我的").navigationBarTitleDisplayMode(.large)
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("我的账户")
                }
            }
        }
        .task {
            if store.messages.isEmpty { await store.loadConversation() }
        }
        .onChange(of: photoItem) { _, item in
            Task {
                guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
                store.selectedImage = data
                store.selectedImageName = "手机照片.jpg"
            }
        }
        .onChange(of: draft) { _, value in
            if value != voiceCapture.transcript { store.voiceArtifactId = nil }
        }
    }

    private var composer: some View {
        VStack(spacing: 9) {
            if let image = store.selectedImage, let uiImage = UIImage(data: image) {
                HStack(spacing: 10) {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    Text("图片已准备好，发送时才会上传")
                        .font(.footnote)
                        .foregroundStyle(StudyPalette.muted)
                    Spacer()
                    Button {
                        store.selectedImage = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    .accessibilityLabel("移除图片")
                }
                .padding(.horizontal, 12)
            }
            if let context = store.pendingNoteContext {
                HStack(spacing: 9) {
                    Image(systemName: "book.closed.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StudyPalette.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("正在围绕手记交流")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text(context.title)
                            .font(.caption2)
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button { store.clearPendingNoteContext() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(StudyPalette.muted)
                    }
                    .accessibilityLabel("移除手记上下文")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(StudyPalette.sky.opacity(0.5), in: RoundedRectangle(cornerRadius: StudyRadius.md, style: .continuous))
                .padding(.horizontal, 12)
            }
            HStack(alignment: .bottom, spacing: 9) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 19, weight: .medium))
                        .frame(width: 42, height: 46)
                        .foregroundStyle(StudyPalette.accent)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("选择图片")
                Button {
                    if voiceCapture.isRecording {
                        Task {
                            if let transcript = await voiceCapture.finish(store: store) { draft = transcript }
                        }
                    } else {
                        voiceCapture.start(store: store)
                    }
                } label: {
                    Image(systemName: voiceCapture.isRecording ? "stop.circle.fill" : "mic")
                        .font(.system(size: 19, weight: .medium))
                        .frame(width: 38, height: 46)
                        .foregroundStyle(voiceCapture.isRecording ? StudyPalette.danger : StudyPalette.accent)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(voiceCapture.isRecording ? "结束录音并识别" : "语音输入")
                TextField(voiceCapture.isRecording ? "正在录音，点红色按钮结束" : "和伴星说说你在想什么…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .textInputAutocapitalization(.sentences)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .background(Color.clear)
                Button {
                    let text = draft
                    Task {
                        await store.submit(text: text)
                        if store.errorMessage == nil {
                            draft = ""
                            composerFocused = false
                        }
                    }
                } label: { sendButtonLabel }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .modifier(StudyGlassSurfaceStyle(radius: StudyRadius.xxl, interactive: true))
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.clear)
    }

    private var canSend: Bool {
        !store.isSending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.selectedImage != nil)
    }

    @ViewBuilder
    private var sendButtonLabel: some View {
        let icon = Image(systemName: store.isSending ? "ellipsis" : "arrow.up")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(canSend ? Color.white : StudyPalette.muted)
            .frame(width: 40, height: 40)
            .contentShape(Circle())
        if #available(iOS 26.0, *) {
            if canSend {
                icon.glassEffect(.regular.tint(StudyPalette.accent).interactive(), in: Circle())
            } else {
                icon.glassEffect(.regular, in: Circle())
            }
        } else {
            icon.background(canSend ? StudyPalette.accent : StudyPalette.inset, in: Circle())
        }
    }
}
