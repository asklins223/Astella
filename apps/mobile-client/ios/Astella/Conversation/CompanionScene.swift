import SwiftUI

struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    var message: CompanionMessage?
    var streamingText: String
    var audioLevel: Double = 0
    var audioActive = false
    var onPrompt: (String) -> Void
    private var reduced: Bool { systemReduceMotion || store.localReduceMotion }
    private var hasReply: Bool { message?.blocks.isEmpty == false || !streamingText.isEmpty }
    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !hasReply {
                        VStack(alignment: .leading, spacing: 9) {
                            Text(audioActive ? "此刻，听见彼此。" : "我在，慢慢说。")
                                .font(.system(size: 29, weight: .semibold)).tracking(-0.7)
                                .foregroundStyle(StudyPalette.ink)
                            Text("一点好奇，一个想法，都可以。")
                                .font(.system(size: 13)).foregroundStyle(StudyPalette.muted)
                        }.padding(.top, 18)
                    }
                    ZStack {
                        GeometryReader { stage in
                            let width = stage.size.width
                            Circle().fill(RadialGradient(colors: [StudyPalette.accent.opacity(audioActive ? 0.18 : 0.09), StudyPalette.pollen.opacity(0.16), .clear], center: .center, startRadius: 5, endRadius: width * 0.47))
                                .frame(width: width * 0.98, height: width * 0.98)
                                .position(x: width * 0.5, y: stage.size.height * 0.52)
                            Ellipse().stroke(StudyPalette.accent.opacity(0.12), lineWidth: 0.6)
                                .frame(width: width * 0.92, height: stage.size.height * 0.38)
                                .rotationEffect(.degrees(-17)).position(x: width * 0.5, y: stage.size.height * 0.64)
                        }.accessibilityHidden(true)
                        CompanionParticleField(level: audioLevel, active: audioActive, reduceMotion: reduced)
                        CompanionStageView(mouthOpen: .constant(store.voicePlayback.isPlaying ? store.voicePlayback.level : 0))
                            .padding(.horizontal, 24).padding(.vertical, 7)
                            .onTapGesture { store.emitCompanion(.attention) }
                    }.frame(height: hasReply ? 190 : min(340, max(250, proxy.size.height * 0.61)))
                        .accessibilityLabel(audioActive ? "伴星正在听你说话或朗读" : "伴星在这里")
                    if hasReply {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                AstellaStar().fill(StudyPalette.accent).frame(width: 10, height: 14)
                                Text(streamingText.isEmpty ? "给你的回应" : "正在回应").font(.system(size: 11, weight: .medium)).tracking(1)
                                Spacer()
                                if streamingText.isEmpty, let message {
                                    Button { store.voicePlayback.play(message.displayText, store: store) } label: {
                                        Image(systemName: "waveform").font(.system(size: 16)).frame(width: 40, height: 32)
                                    }.accessibilityLabel("朗读回复")
                                }
                            }.foregroundStyle(StudyPalette.accent)
                            if !streamingText.isEmpty { Text(streamingText).font(.system(size: 16)).lineSpacing(6).textSelection(.enabled) }
                            else if let message { MessageRow(message: message) }
                        }.padding(20).modifier(StudyGlassSurfaceStyle(radius: 25))
                    } else {
                        HStack(spacing: 12) {
                            prompt("text.alignleft", title: "读懂一段", text: "帮我一起读懂今天在学的内容")
                            prompt("sparkles", title: "展开想法", text: "我有些思路想和你一起整理")
                        }.padding(.top, 8)
                    }
                    if !store.runs.isEmpty {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.mini).tint(StudyPalette.accent)
                            Text("伴星正在整理思路").font(.system(size: 11)).foregroundStyle(StudyPalette.muted)
                            Spacer()
                            Button("停止") { Task { await store.cancelActiveRuns() } }.font(.system(size: 12, weight: .medium))
                        }.padding(.top, 14)
                    }
                }.padding(.horizontal, 28).padding(.bottom, 18)
                    .frame(minHeight: proxy.size.height, alignment: .top)
            }.scrollIndicators(.hidden)
        }.buttonStyle(AstellaPressStyle())
    }
    private func prompt(_ icon: String, title: String, text: String) -> some View {
        Button { onPrompt(text) } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 15, weight: .light)).foregroundStyle(StudyPalette.accent)
                Text(title).font(.system(size: 13, weight: .medium))
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .light)).foregroundStyle(StudyPalette.muted)
            }.foregroundStyle(StudyPalette.ink).padding(.horizontal, 15).frame(maxWidth: .infinity, minHeight: 51)
                .modifier(StudyGlassSurfaceStyle(radius: 18))
        }
    }
}
