import SwiftUI
import UIKit

/// 伴星 mode for the conversation screen.
///
/// The companion is the only permanent thing on this page. Her words appear in
/// the speech bubble only while she is speaking — a turn is running, an answer
/// is streaming in, or a saved answer is being read aloud — and the bubble
/// leaves by itself a reading beat after the last sentence. Nothing else
/// competes with her for the page, so the stage owns the freed space and the
/// artwork is larger and optically centred instead of being squeezed above a
/// list of shortcuts.
struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\EnvironmentValues.launchHidesCompanion) private var launchHidesCompanion: Bool
    var streamingText: String
    var audioActive = false
    var onOpenNote: ((String) -> Void)? = nil

    @State private var speechText = ""
    @State private var speechVisible = false
    @State private var speechWaiting = false
    @State private var presentedReplyId: String?
    @State private var hasAdmittedHistory = false
    @State private var dismissalTask: Task<Void, Never>?

    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }
    private var lastReply: CompanionMessage? { store.messages.last(where: { $0.role == "assistant" }) }
    private var playbackActive: Bool {
        store.voicePlayback.isLoading || store.voicePlayback.isPlaying || store.voicePlayback.isPaused
    }
    /// A turn is running, output is streaming, or the user is listening to the
    /// companion read. This is the window in which she is "speaking".
    private var companionResponding: Bool {
        store.isSending || !store.runs.isEmpty || !streamingText.isEmpty
    }

    var body: some View {
        GeometryReader { proxy in
            let layout = CompanionStageLayout(size: proxy.size)
            ZStack(alignment: .top) {
                stage(layout: layout, canvas: proxy.size)

                if speechVisible {
                    speechBubble
                        .padding(.horizontal, 22)
                        .padding(.top, 2)
                        .transition(bubbleTransition)
                        .zIndex(1)
                }

                if !store.runs.isEmpty {
                    CompanionLiveProgress()
                        .padding(.horizontal, 22)
                        .padding(.bottom, 8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .transition(.opacity.combined(with: .offset(y: 10)))
                        .zIndex(2)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .animation(Motion.gated(reduced, Motion.segment), value: store.runs.isEmpty)
        }
        .buttonStyle(AstellaPressStyle())
        .task { admitInitialState() }
        .onChange(of: companionResponding) { _, responding in
            if responding { beginSpeaking() } else { finishSpeaking() }
        }
        .onChange(of: streamingText) { _, text in
            guard !text.isEmpty else { return }
            showSpeech(text)
        }
        .onChange(of: lastReply?.id) { _, id in handleNewReply(id) }
        .onChange(of: playbackActive) { _, active in
            if active { beginPlayback() }
            else if !companionResponding { scheduleDismissal() }
        }
        .onDisappear {
            dismissalTask?.cancel()
            dismissalTask = nil
        }
    }

    // MARK: - Stage

    private func stage(layout: CompanionStageLayout, canvas: CGSize) -> some View {
        ZStack(alignment: .bottom) {
            Ellipse()
                .fill(RadialGradient(
                    colors: [StudyPalette.muted.opacity(0.13), StudyPalette.sky.opacity(0.10), .clear],
                    center: .center,
                    startRadius: 2,
                    endRadius: max(8, layout.width * 0.62)
                ))
                .frame(width: layout.width * 1.12, height: 32)
                .blur(radius: 14)
                .offset(y: 8)
                .accessibilityHidden(true)

            if layout.height > 40 {
                CompanionStageView(mouthOpen: .constant(store.voicePlayback.isPlaying ? store.voicePlayback.level : 0))
                    .frame(width: layout.width, height: layout.height)
                    .background {
                        GeometryReader { stage in
                            Color.clear.preference(key: LaunchCompanionFrameKey.self, value: stage.frame(in: .global))
                        }
                    }
                    .opacity(launchHidesCompanion ? 0 : 1)
                    .contentShape(Rectangle())
                    .onTapGesture { store.emitCompanion(.attention) }
                    .accessibilityLabel(audioActive ? "伴星正在听你说话或朗读" : "伴星在这里")
            }
        }
        .frame(width: layout.width, height: layout.height, alignment: .bottom)
        .position(x: canvas.width / 2, y: layout.top + layout.height / 2)
    }

    // MARK: - Speech bubble

    private var speechBubble: some View {
        Group {
            if speechWaiting {
                CompanionSpeakingDots()
            } else {
                CompanionMarkdownText(text: speechText, onOpenNote: onOpenNote)
                    .font(.system(size: 15.5))
                    .lineSpacing(6)
                    .lineLimit(3)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
        .background(StudyPalette.paper.opacity(0.92), in: bubbleShape)
        .overlay {
            bubbleShape.stroke(.white.opacity(0.9), lineWidth: 0.8)
        }
        .shadow(color: StudyPalette.ink.opacity(0.05), radius: 12, x: 0, y: 4)
    }

    private var bubbleShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 22,
            bottomLeadingRadius: 7,
            bottomTrailingRadius: 22,
            topTrailingRadius: 22,
            style: .continuous
        )
    }

    private var bubbleTransition: AnyTransition {
        reduced
            ? .opacity
            : .opacity.combined(with: .offset(y: -8)).combined(with: .scale(scale: 0.98, anchor: .topLeading))
    }

    private var showAnimation: Animation {
        reduced ? .easeOut(duration: 0.2) : .spring(duration: 0.34, bounce: 0.08)
    }

    private var hideAnimation: Animation {
        reduced ? .easeOut(duration: 0.16) : .easeOut(duration: 0.26)
    }

    // MARK: - Speech lifecycle

    private func admitInitialState() {
        presentedReplyId = lastReply?.id
        hasAdmittedHistory = !store.messages.isEmpty
        if companionResponding {
            if streamingText.isEmpty { showWaitingBubble() }
            else { showSpeech(streamingText) }
        } else if playbackActive {
            let spoken = store.voicePlayback.spokenText
            showSpeech(spoken.isEmpty ? (lastReply?.displayText ?? "") : spoken)
        }
    }

    private func beginSpeaking() {
        dismissalTask?.cancel()
        dismissalTask = nil
        if !streamingText.isEmpty {
            showSpeech(streamingText)
        } else if playbackActive, !store.voicePlayback.spokenText.isEmpty {
            showSpeech(store.voicePlayback.spokenText)
        } else if !speechVisible {
            showWaitingBubble()
        } else {
            // A new turn started while the previous sentence still lingered:
            // clear it before the first delta arrives so the page reads as a
            // new utterance rather than a silent text swap.
            speechText = ""
            speechWaiting = true
        }
    }

    private func beginPlayback() {
        dismissalTask?.cancel()
        dismissalTask = nil
        let spoken = store.voicePlayback.spokenText
        if !spoken.isEmpty {
            showSpeech(spoken)
        } else if let reply = lastReply, !reply.displayText.isEmpty, !speechVisible || speechWaiting {
            showSpeech(reply.displayText)
        }
    }

    private func finishSpeaking() {
        guard speechVisible else { return }
        if let reply = lastReply, reply.id != presentedReplyId, !reply.displayText.isEmpty {
            presentedReplyId = reply.id
            showSpeech(reply.displayText)
            scheduleDismissal()
            return
        }
        guard !speechWaiting else {
            // The turn ended before saying anything (failure or a run hand-off
            // between `isSending` and the run snapshot). Grant a short grace so
            // the hand-off does not flicker the bubble; a failed turn still
            // leaves quietly.
            scheduleDismissal()
            return
        }
        scheduleDismissal()
    }

    private func handleNewReply(_ id: String?) {
        guard let id else { return }
        let live = speechVisible || companionResponding || playbackActive
        guard hasAdmittedHistory || live else {
            // The first page of history was never "spoken" in this view.
            hasAdmittedHistory = true
            presentedReplyId = id
            return
        }
        hasAdmittedHistory = true
        guard id != presentedReplyId else { return }
        presentedReplyId = id
        guard let reply = lastReply, !reply.displayText.isEmpty else { return }
        if live {
            if !companionResponding {
                showSpeech(reply.displayText)
                scheduleDismissal()
            } else if !playbackActive {
                speechWaiting = false
                speechText = reply.displayText
            }
        } else {
            // A proactive reply the user did not watch being written: let her
            // say it once, then let it leave like every other sentence.
            showSpeech(reply.displayText)
            scheduleDismissal()
        }
    }

    private func showWaitingBubble() {
        dismissalTask?.cancel()
        dismissalTask = nil
        speechText = ""
        speechWaiting = true
        guard !speechVisible else { return }
        withAnimation(showAnimation) { speechVisible = true }
    }

    private func showSpeech(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        dismissalTask?.cancel()
        dismissalTask = nil
        speechWaiting = false
        speechText = text
        guard !speechVisible else { return }
        withAnimation(showAnimation) { speechVisible = true }
    }

    private func scheduleDismissal() {
        dismissalTask?.cancel()
        let linger = readingLinger(for: speechText)
        dismissalTask = Task { @MainActor in
            // Give the persisted assistant message a beat to replace the
            // streamed snapshot before the reading time is measured.
            try? await Task.sleep(for: .milliseconds(380))
            guard !Task.isCancelled else { return }
            if let reply = lastReply, !reply.displayText.isEmpty, reply.id != presentedReplyId {
                presentedReplyId = reply.id
                speechText = reply.displayText
            }
            try? await Task.sleep(for: .seconds(linger))
            guard !Task.isCancelled, !companionResponding, !playbackActive else { return }
            hideSpeech()
        }
    }

    private func hideSpeech() {
        dismissalTask?.cancel()
        dismissalTask = nil
        speechWaiting = false
        withAnimation(hideAnimation) { speechVisible = false }
    }

    private func readingLinger(for text: String) -> TimeInterval {
        min(5.5, 1.5 + Double(text.count) * 0.032)
    }
}

/// The companion artwork is 440×534 with ~23% transparent headroom above the
/// headdress (visible pixels start at y≈122). The frame keeps the artwork
/// ratio and the *visible* part is centered, so the bubble can float in that
/// clear band without covering her face while the stage still takes the whole
/// page.
private struct CompanionStageLayout {
    static let aspect = 440.0 / 534.0
    static let visibleTopFraction = 122.0 / 534.0
    static let visibleHeightFraction = 402.0 / 534.0
    /// Room kept above her head for the speech bubble (three lines + insets).
    static let bubbleReserve: CGFloat = 118

    let width: CGFloat
    let height: CGFloat
    let top: CGFloat

    init(size: CGSize) {
        let byWidthHeight = max(120, size.width - 16) / Self.aspect
        // On short pages, shrink the artwork so her headdress stays below the
        // bubble band instead of being covered by it.
        let byHeightHeight = max(120, (size.height - Self.bubbleReserve * 2) / Self.visibleHeightFraction)
        let height = min(byWidthHeight, byHeightHeight)
        self.height = height
        width = height * Self.aspect
        top = max(0, (size.height - Self.visibleHeightFraction * height) / 2 - Self.visibleTopFraction * height)
    }
}

/// Three quiet dots while a turn is running before its first words arrive.
private struct CompanionSpeakingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animating = false

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(StudyPalette.accent)
                    .frame(width: 7, height: 7)
                    .opacity(reduceMotion ? 0.6 : (animating ? 1 : 0.28))
                    .animation(
                        reduceMotion
                            ? nil
                            : .easeInOut(duration: 0.65)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.16),
                        value: animating
                    )
            }
        }
        .frame(height: 24)
        .onAppear { animating = true }
        .accessibilityLabel("伴星正在回应")
    }
}
