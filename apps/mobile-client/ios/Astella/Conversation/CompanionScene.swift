import SwiftUI
import UIKit

/// 伴星 mode for the conversation screen. One focal subject (the companion) and
/// three supporting layers: her current sentence, the quiet shortcuts, and the
/// note you were reading together. Sections use different weights instead of
/// repeating the same glass card, and the companion keeps the flexible space.
struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\EnvironmentValues.launchHidesCompanion) private var launchHidesCompanion: Bool
    var message: CompanionMessage?
    var streamingText: String
    var audioActive = false
    var onOpenNote: ((String) -> Void)? = nil

    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }
    private var replyText: String {
        if !streamingText.isEmpty { return streamingText }
        if let message, !message.displayText.isEmpty { return message.displayText }
        return "你来啦。今天想先从哪一句聊起？"
    }
    private var replyStatus: String {
        if !streamingText.isEmpty { return "正在回应" }
        if audioActive { return "此刻，听见彼此" }
        return "阿星轻轻说"
    }

    var body: some View {
        GeometryReader { proxy in
            let compact = proxy.size.height < 560
            VStack(spacing: 0) {
                replySurface
                    .padding(.horizontal, 22)
                    .padding(.top, 6)

                stage
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.top, compact ? 0 : 6)
                    .padding(.bottom, compact ? 4 : 10)

                quickActions
                    .padding(.horizontal, 22)
                    .padding(.bottom, compact ? 8 : 12)

                readingRow(compact: compact)

                if !store.runs.isEmpty {
                    CompanionLiveProgress()
                        .padding(.horizontal, 22)
                        .padding(.top, 10)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .animation(Motion.gated(reduced, Motion.segment), value: replyText)
            .animation(Motion.gated(reduced, Motion.segment), value: store.notes.first?.id)
        }
        .buttonStyle(AstellaPressStyle())
    }

    private var replySurface: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle()
                    .fill(streamingText.isEmpty && !audioActive ? StudyPalette.success : StudyPalette.accent)
                    .frame(width: 5, height: 5)
                Text(replyStatus)
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 0)
                if audioActive {
                    AstellaGlyph(kind: .wave, tint: StudyPalette.accent).frame(width: 15, height: 15)
                }
            }

            CompanionMarkdownText(text: replyText, onOpenNote: onOpenNote)
                .font(.system(size: 15.5))
                .lineSpacing(6.5)
                .lineLimit(3)
                .foregroundStyle(StudyPalette.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.updatesFrequently)
        }
        .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
        .padding(.horizontal, 17)
        .padding(.vertical, 14)
        .background(StudyPalette.paper.opacity(0.84), in: UnevenRoundedRectangle(
            topLeadingRadius: 22,
            bottomLeadingRadius: 7,
            bottomTrailingRadius: 22,
            topTrailingRadius: 22,
            style: .continuous
        ))
        .overlay {
            UnevenRoundedRectangle(
                topLeadingRadius: 22,
                bottomLeadingRadius: 7,
                bottomTrailingRadius: 22,
                topTrailingRadius: 22,
                style: .continuous
            )
            .stroke(.white.opacity(0.88), lineWidth: 0.8)
        }
        .shadow(color: StudyPalette.ink.opacity(0.04), radius: 9, x: 0, y: 3)
    }

    private var stage: some View {
        GeometryReader { proxy in
            let height = min(proxy.size.height, max(140, proxy.size.width * 0.94))
            let width = min(proxy.size.width - 56, height * 0.92)
            ZStack(alignment: .bottom) {
                Ellipse()
                    .fill(RadialGradient(
                        colors: [StudyPalette.muted.opacity(0.13), StudyPalette.sky.opacity(0.10), .clear],
                        center: .center,
                        startRadius: 2,
                        endRadius: max(8, width * 0.62)
                    ))
                    .frame(width: width * 1.18, height: 32)
                    .blur(radius: 14)
                    .offset(y: 8)
                    .accessibilityHidden(true)

                if height > 40 {
                    CompanionStageView(mouthOpen: .constant(store.voicePlayback.isPlaying ? store.voicePlayback.level : 0))
                        .frame(width: width, height: height)
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
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }

    private var quickActions: some View {
        HStack(spacing: 10) {
            quickAction("回想练习", glyph: .recall) { store.chatShowsRecords = true }
            quickAction("今日手边", glyph: .tasks) {
                store.orbitRootSection = "hand"
                store.selectedTab = .orbit
            }
        }
    }

    private func quickAction(_ title: String, glyph: AstellaGlyphKind, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                AstellaGlyph(kind: glyph, tint: StudyPalette.ink).frame(width: 14, height: 14)
                Text(title)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(StudyPalette.ink)
            }
            .frame(maxWidth: .infinity, minHeight: 38)
            .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
        }
        .buttonStyle(AstellaPressStyle())
    }

    @ViewBuilder private func readingRow(compact: Bool) -> some View {
        if let latest = store.notes.first(where: { $0.id == store.recentNoteId }) ?? store.notes.first,
           let onOpenNote {
            Button { onOpenNote(latest.id) } label: {
                VStack(spacing: 0) {
                    Rectangle()
                        .fill(StudyPalette.paperEdge.opacity(0.5))
                        .frame(height: 0.7)
                        .accessibilityHidden(true)
                    HStack(spacing: 14) {
                        NoteCover(title: latest.title, seed: latest.id, paletteIndex: 0, rotation: -8)
                            .frame(width: compact ? 36 : 44, height: compact ? 50 : 60)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("继续一起读")
                                .font(.system(size: 10, weight: .medium))
                                .tracking(1)
                                .foregroundStyle(StudyPalette.muted)
                            Text(readingTitle(latest.title))
                                .font(.system(size: 17, weight: .medium))
                                .tracking(-0.4)
                                .foregroundStyle(StudyPalette.ink)
                                .lineLimit(1)
                            HStack(spacing: 8) {
                                Text(readingMetadata(for: latest.id))
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(StudyPalette.muted)
                                    .lineLimit(1)
                                Rectangle()
                                    .fill(StudyPalette.actionFill.opacity(0.8))
                                    .frame(width: 26, height: 1)
                                    .accessibilityHidden(true)
                            }
                        }
                        Spacer(minLength: 0)
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted)
                            .frame(width: 12, height: 12)
                    }
                    .padding(.vertical, compact ? 9 : 12)
                    .contentShape(Rectangle())
                }
            }
            .buttonStyle(AstellaPressStyle())
            .padding(.horizontal, 22)
            .transition(.opacity.combined(with: .offset(y: 8)))
            .accessibilityLabel("继续读《\(readingTitle(latest.title))》")
        }
    }

    private func readingTitle(_ title: String) -> String {
        let firstPart = title.split(separator: "·", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? title
        return firstPart.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func readingMetadata(for noteId: String) -> String {
        let document = store.noteDocument?.id == noteId ? store.noteDocument : nil
        let version = document.map { "第 \($0.versionNumber) 版 · " } ?? ""
        if let block = store.savedNoteReadingBlock(noteId: noteId) {
            return version + "读到第 \(block) 段"
        }
        return version + (store.recentNoteId == noteId ? "上次停下的那一页" : "最近更新")
    }
}
