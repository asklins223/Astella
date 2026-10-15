import SwiftUI
import UIKit

struct MessageRow: View {
    @Environment(AppStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var bodyPointSize: CGFloat = 17
    var message: CompanionMessage

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if message.role == "assistant" {
                Image("BrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 23, height: 23)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .accessibilityHidden(true)
            } else {
                Spacer(minLength: 34)
            }
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    if block.type == "image", let url = block.url {
                        AuthenticatedCompanionImage(url: url, label: block.alt ?? block.label ?? "对话图片")
                    }
                    if let text = block.text, !text.isEmpty {
                        Text(text)
                            .font(.system(size: bodyPointSize * store.readingScale))
                            .lineSpacing(4)
                            .foregroundStyle(StudyPalette.ink)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(message.role == "user" ? 13 : 0)
            .frame(maxWidth: message.role == "user" ? 310 : .infinity, alignment: .leading)
            .background(message.role == "user" ? StudyPalette.sky.opacity(0.68) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            if message.role == "user" {
                Spacer(minLength: 0)
            }
        }
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
                Label(label, systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.vertical, 8)
            }
        }
        .task(id: url) { data = try? await store.api.imageData(url) }
        .accessibilityLabel(label)
    }
}
