import SwiftUI
import UIKit

struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\EnvironmentValues.launchHidesCompanion) private var launchHidesCompanion: Bool
    var message: CompanionMessage?
    var streamingText: String
    var audioActive = false
    var onOpenNote: ((String) -> Void)? = nil

    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }
    private var modelFailed: Bool {
        if case .failed = store.companionModel.state { return true }
        return false
    }
    private var replyText: String {
        if !streamingText.isEmpty { return streamingText }
        if let message, !message.displayText.isEmpty { return message.displayText }
        return "你来啦。今天想先从哪一句聊起？"
    }
    private var replyHeight: CGFloat {
        let estimatedLines = min(3, max(1, (replyText.count + 21) / 22))
        return min(128, max(97, CGFloat(51.2 + Double(estimatedLines) * 25.6)))
    }

    var body: some View {
        GeometryReader { proxy in
            let screenHeight = UIScreen.main.bounds.height
            let sceneOriginY = proxy.frame(in: .global).minY
            let designToNativeOffset: CGFloat = 0
            let designY: (CGFloat) -> CGFloat = { y in y + designToNativeOffset - sceneOriginY }
            let compact = screenHeight <= 780
            let replyTop = designY(compact ? 108 : 114)
            let readingHeight: CGFloat = compact ? 53 : 64
            let readingTop = screenHeight - (compact ? 184 + readingHeight : 196 + readingHeight) + designToNativeOffset - sceneOriginY
            let shellGroundTop: CGFloat = 48 + (compact ? 432 : 492)
            let groundHeight: CGFloat = compact ? 28 : 28
            let groundWidth = max(0, proxy.size.width - 116)
            let rotatedGroundHeight = groundWidth * sin(.pi / 180 * 8) + groundHeight * cos(.pi / 180 * 8)
            let groundBoundsTop = shellGroundTop + designToNativeOffset - (rotatedGroundHeight - groundHeight) / 2
            let floorLimit = groundBoundsTop + 8 - sceneOriginY
            let stageTop = replyTop + replyHeight + 12
            let stageBottom = min(floorLimit, readingTop - 22, screenHeight - 196 + designToNativeOffset - sceneOriginY)
            let stageHeight = min(compact ? 306 : 360, max(96, stageBottom - stageTop))
            let stageWidth = min(compact ? 252 : 330, max(180, stageHeight * 0.92))
            let failureCardWidth = min(170, proxy.size.width - 36)
            let failureCardCenterX = proxy.size.width - min(99, proxy.size.width * 0.26)
            let readingCopyWidth = max(92, failureCardCenterX - failureCardWidth / 2 - 29 - 46 - 16 - 8)

            ZStack(alignment: .topLeading) {
                Ellipse()
                    .fill(RadialGradient(
                        colors: [StudyPalette.muted.opacity(0.10), StudyPalette.sky.opacity(0.11), .clear],
                        center: .center,
                        startRadius: 4,
                        endRadius: stageWidth * 0.58
                    ))
                    .frame(width: groundWidth, height: groundHeight)
                    .blur(radius: 15)
                    .rotationEffect(.degrees(-8))
                    .position(x: (proxy.size.width + 24) / 2, y: floorLimit + groundHeight / 2)
                    .accessibilityHidden(true)

                CompanionStageView(mouthOpen: .constant(store.voicePlayback.isPlaying ? store.voicePlayback.level : 0))
                    .frame(width: stageWidth, height: stageHeight)
                    .background {
                        GeometryReader { stage in
                            Color.clear.preference(key: LaunchCompanionFrameKey.self, value: stage.frame(in: .global))
                        }
                    }
                    .opacity(launchHidesCompanion ? 0 : 1)
                    .contentShape(Rectangle())
                    .onTapGesture { store.emitCompanion(.attention) }
                    .position(x: proxy.size.width / 2, y: stageTop + stageHeight / 2)
                    .accessibilityLabel(audioActive ? "伴星正在听你说话或朗读" : "伴星在这里")

                replySurface
                    .frame(width: max(0, proxy.size.width - 56), height: replyHeight, alignment: .leading)
                    .position(x: proxy.size.width / 2, y: replyTop + replyHeight / 2)
                    .accessibilityAddTraits(.updatesFrequently)

                if let latest = store.notes.first(where: { $0.id == store.recentNoteId }) ?? store.notes.first,
                   let onOpenNote {
                    Button { onOpenNote(latest.id) } label: {
                        HStack(spacing: 16) {
                            NoteCover(title: latest.title, seed: latest.id, paletteIndex: 0, rotation: -8)
                                .frame(width: compact ? 38 : 46, height: compact ? 53 : 64)
                            VStack(alignment: .leading, spacing: 0) {
                                Text("继续一起读")
                                    .font(.system(size: 10, weight: .medium))
                                    .tracking(1)
                                    .foregroundStyle(StudyPalette.muted)
                                Text(readingTitle(latest.title))
                                    .font(.system(size: 20, weight: .medium))
                                    .tracking(-0.5)
                                    .foregroundStyle(StudyPalette.ink)
                                    .lineLimit(1)
                                    .padding(.top, 4)
                                    .padding(.bottom, 5)
                                HStack(spacing: 8) {
                                    Text(readingMetadata(for: latest.id))
                                        .font(.system(size: 12))
                                        .foregroundStyle(StudyPalette.muted)
                                        .lineLimit(1)
                                    Rectangle()
                                        .fill(StudyPalette.actionFill.opacity(0.8))
                                        .frame(width: 28, height: 1)
                                        .accessibilityHidden(true)
                                }
                            }
                            .frame(maxWidth: modelFailed ? readingCopyWidth : .infinity, alignment: .leading)
                            Spacer(minLength: 0)
                        }
                        .frame(width: max(0, proxy.size.width - (compact ? 98 : 116)), height: readingHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(AstellaPressStyle())
                    .position(x: 29 + max(0, proxy.size.width - (compact ? 98 : 116)) / 2, y: readingTop + readingHeight / 2)
                    .transition(.opacity.combined(with: .offset(y: 8)))
                }

                VStack(spacing: 12) {
                    Button { store.chatShowsRecords = true } label: {
                        AstellaGlyph(kind: .recall, tint: StudyPalette.ink)
                            .frame(width: 17, height: 17)
                            .frame(width: 38, height: 38)
                            .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityLabel("回想练习")

                    Button {
                        store.orbitRootSection = "hand"
                        store.selectedTab = .orbit
                    } label: {
                        AstellaGlyph(kind: .tasks, tint: StudyPalette.ink)
                            .frame(width: 17, height: 17)
                            .frame(width: 38, height: 38)
                            .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityLabel("今日手边")
                }
                .position(x: proxy.size.width - 44, y: screenHeight - 244 + designToNativeOffset - sceneOriginY)

                if modelFailed {
                    modelFailureCard
                        .frame(width: failureCardWidth)
                        .position(x: failureCardCenterX, y: screenHeight - 241 + designToNativeOffset - sceneOriginY)
                        .transition(.scale(scale: 0.96, anchor: .bottomTrailing).combined(with: .opacity))
                }

                if !store.runs.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini).tint(StudyPalette.accent)
                        Text("伴星正在整理思路").font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
                        Spacer()
                        Button("停止") { Task { await store.cancelActiveRuns() } }
                            .font(.system(size: 12, weight: .medium))
                    }
                    .padding(.horizontal, 12)
                    .position(x: proxy.size.width / 2, y: proxy.size.height - 8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(AstellaPressStyle())
        .animation(Motion.gated(reduced, Motion.segment), value: replyText)
        .animation(Motion.gated(reduced, Motion.segment), value: store.notes.first?.id)
    }

    private var replySurface: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(streamingText.isEmpty ? (audioActive ? "此刻，听见彼此。" : "阿星轻轻说") : "正在回应")
                .font(.system(size: 10, weight: .medium))
                .tracking(0.5)
                .foregroundStyle(StudyPalette.muted)

            Text(replyText)
                .font(.system(size: 14, weight: .regular))
                .lineSpacing(5)
                .lineLimit(3)
                .foregroundStyle(StudyPalette.ink)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
        .modifier(StudyGlassSurfaceStyle(radius: 24))
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 24,
            bottomLeadingRadius: 7,
            bottomTrailingRadius: 24,
            topTrailingRadius: 24,
            style: .continuous
        ))
    }

    private var modelFailureCard: some View {
        VStack(spacing: 8) {
            Text("伴星模型没能加载出来")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(red: 0.72, green: 0.40, blue: 0.33))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
            Text("Texture loading error")
                .font(.system(size: 11))
                .foregroundStyle(StudyPalette.muted)
            Button {
                store.startCompanionModelDownload()
            } label: {
                Text("重试加载")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 80, height: 38)
                    .background(LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(AstellaPressStyle())
            Button {
                store.chatShowsRecords = true
            } label: {
                Text("用文字模式继续")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(StudyPalette.muted)
                    .frame(width: 124, height: 38)
                    .background(.white.opacity(0.52), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.46), lineWidth: 0.8))
            }
            .buttonStyle(AstellaPressStyle())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 20.5)
        .frame(width: 170)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.86), lineWidth: 0.9))
        .shadow(color: StudyPalette.ink.opacity(0.08), radius: 14, x: 0, y: 6)
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
