import SwiftUI

/// A stable, quiet failure surface. It sits in the content layer (not glass) and
/// keeps the retry affordance next to the explanation, so the conversation can
/// continue around it without the panel shouting.
struct ConversationFailurePanel: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AstellaGlyph(kind: .alert, tint: StudyPalette.danger)
                .frame(width: 16, height: 16)
                .frame(width: 32, height: 32)
                .background(StudyPalette.danger.opacity(0.10), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text("伴星暂时没有接回来")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
                Text(message)
                    .font(.system(size: 11.5))
                    .lineSpacing(2)
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 6)

            Button("重试", action: retry)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(StudyPalette.accent)
                .padding(.horizontal, 12)
                .frame(minHeight: 30)
                .background(StudyPalette.sky, in: Capsule())
                .buttonStyle(AstellaPressStyle())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.8)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
