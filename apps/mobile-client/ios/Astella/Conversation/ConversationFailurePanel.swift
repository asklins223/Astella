import SwiftUI

struct ConversationFailurePanel: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(StudyPalette.danger)
                .frame(width: 30, height: 30)
                .background(StudyPalette.danger.opacity(0.08), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("伴星暂时没有接回来")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button("重试", action: retry)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(StudyPalette.accent)
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.7), lineWidth: 1)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 5)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
