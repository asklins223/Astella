import SwiftUI
import UIKit

struct MessageRow: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 15
    var message: CompanionMessage
    var maxBubbleWidth: CGFloat = 320
    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if !isUser {
                Image("CompanionAvatar")
                    .resizable()
                    .scaledToFill()
                    .frame(width: 23, height: 23)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
            } else {
                Spacer(minLength: 34)
            }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 0) {
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    if block.type == "image", let url = block.url {
                        AuthenticatedCompanionImage(url: url, label: block.alt ?? block.label ?? "对话图片")
                    }
                    if block.type == "file" {
                        astellaLabel(block.name ?? "文件附件", glyph: .document)
                            .font(.subheadline.weight(.medium)).padding(12)
                            .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if let proposalId = block.proposalId { CompanionProposalCard(proposalId: proposalId) }
                    if let code = block.code {
                        ScrollView(.horizontal) { Text(code).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(12) }
                    }
                    if block.type != "file", let text = block.text, !text.isEmpty {
                        Text(isUser ? AttributedString(text) : companionMarkdown(text))
                            .font(.system(size: bodyPointSize))
                            .lineSpacing(8)
                            .foregroundStyle(isUser ? .white : StudyPalette.ink)
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal, 17)
                .padding(.vertical, isUser ? 17.5 : 17)
                .frame(maxWidth: maxBubbleWidth, alignment: .leading)
                .background {
                    if isUser {
                        UnevenRoundedRectangle(
                            topLeadingRadius: 22,
                            bottomLeadingRadius: 22,
                            bottomTrailingRadius: 6,
                            topTrailingRadius: 22,
                            style: .continuous
                        )
                        .fill(LinearGradient(
                            colors: [Color(red: 0.42, green: 0.59, blue: 0.93), Color(red: 0.25, green: 0.45, blue: 0.86)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ))
                        .shadow(color: StudyPalette.accent.opacity(0.12), radius: 10, x: 0, y: 4)
                    } else {
                        RoundedRectangle(cornerRadius: 21, style: .continuous)
                            .fill(StudyPalette.paper.opacity(0.72))
                            .overlay(RoundedRectangle(cornerRadius: 21, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 0.8))
                            .shadow(color: StudyPalette.ink.opacity(0.035), radius: 8, x: 0, y: 3)
                    }
                }
                Text(messageTimeLabel)
                    .font(.system(size: 8))
                    .tracking(0.5)
                    .foregroundStyle(StudyPalette.muted.opacity(0.78))
                    .frame(maxWidth: maxBubbleWidth, alignment: isUser ? .trailing : .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 6)
            }
            if !isUser { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .contextMenu {
            Button { UIPasteboard.general.string = message.displayText } label: { astellaLabel("复制", glyph: .copy) }
            if message.role == "assistant" {
                Button { store.voicePlayback.play(message.displayText, store: store) } label: { astellaLabel("朗读", glyph: .speaker) }
            }
        }
    }

    private var messageTimeLabel: String {
        guard let date = messageDate else { return "" }
        if abs(Date().timeIntervalSince(date)) < 90 { return "刚刚" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M月d日 HH:mm"
        return formatter.string(from: date)
    }

    var messageDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: message.createdAt) ?? ISO8601DateFormatter().date(from: message.createdAt)
    }
}

private struct AuthenticatedCompanionImage: View {
    @Environment(AppStore.self) private var store
    let url: String
    let label: String
    @State private var data: Data?

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                astellaLabel(label, glyph: .photo)
                    .font(.footnote)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.vertical, 8)
            }
        }
        .task(id: url) { data = try? await store.api.imageData(url) }
        .accessibilityLabel(label)
    }
}

private func astellaLabel(_ title: String, glyph: AstellaGlyphKind) -> some View {
    Label {
        Text(title)
    } icon: {
        AstellaGlyph(kind: glyph, tint: StudyPalette.muted).frame(width: 16, height: 16)
    }
}
