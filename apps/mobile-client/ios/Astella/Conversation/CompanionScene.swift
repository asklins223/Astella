import SwiftUI

struct CompanionScene: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var message: CompanionMessage?
    var streamingText: String
    var onPrompt: (String) -> Void

    var body: some View {
        GeometryReader { proxy in
            let isEmpty = message == nil && streamingText.isEmpty
            ScrollView {
                if isEmpty {
                    VStack(spacing: 0) {
                        CompanionPortrait()
                            .frame(height: min(max(proxy.size.height * 0.27, 154), 186))
                            .padding(.bottom, 6)
                        Text("今天，想学点什么？")
                            .font(.system(.title2, weight: .semibold))
                            .tracking(-0.4)
                            .foregroundStyle(StudyPalette.ink)
                        Text("正在读的内容、没想通的问题，都可以直接告诉伴星。")
                            .font(.subheadline)
                            .lineSpacing(2)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(StudyPalette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 6)
                            .padding(.horizontal, 14)
                        VStack(alignment: .leading, spacing: 9) {
                            SectionEyebrow(text: "试着问")
                            HStack(spacing: 7) {
                                ForEach([("梳理思路", "帮我梳理思路"), ("解释概念", "解释一个概念"), ("开始学习", "我今天想学……")], id: \.0) { title, prompt in
                                    Button { onPrompt(prompt) } label: {
                                        Text(title)
                                            .font(.footnote.weight(.medium))
                                            .foregroundStyle(StudyPalette.accent)
                                            .padding(.horizontal, 10)
                                            .frame(minHeight: 40)
                                            .modifier(StudyGlassSurfaceStyle(radius: StudyRadius.xl, interactive: true))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.top, 18)
                        if !store.runs.isEmpty {
                            Label("有 \(store.runs.count) 项学习工作正在进行", systemImage: "clock.arrow.circlepath")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 13)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                } else {
                    VStack(spacing: 0) {
                        CompanionPortrait()
                            .frame(height: min(max(proxy.size.height * 0.22, 132), 166))
                        Text(streamingText.isEmpty ? (message?.displayText ?? "") : streamingText)
                            .font(.system(size: bodyPointSize * store.readingScale))
                            .lineSpacing(4)
                            .multilineTextAlignment(.leading)
                            .foregroundStyle(StudyPalette.ink)
                            .frame(maxWidth: .infinity)
                            .textSelection(.enabled)
                            .padding(.horizontal, 24)
                            .padding(.top, 10)
                        if !streamingText.isEmpty {
                            Label("正在接着回答", systemImage: "ellipsis")
                                .font(.caption)
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 10)
                        }
                        if !store.runs.isEmpty {
                            Label("有 \(store.runs.count) 项学习工作正在进行", systemImage: "clock.arrow.circlepath")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(StudyPalette.muted)
                                .padding(.top, 12)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .top)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}
