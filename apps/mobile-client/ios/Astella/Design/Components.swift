import SwiftUI
import UIKit

struct PageHeading: View {
    let eyebrow: String
    let title: String
    var subtitle: String? = nil
    var trailing: AnyView? = nil

    var body: some View {
        HStack(alignment: .top, spacing: StudySpacing.lg - 2) {
            VStack(alignment: .leading, spacing: 5) {
                SectionEyebrow(text: eyebrow)
                Text(title)
                    .font(.system(.largeTitle, weight: .semibold))
                    .tracking(StudyTracking.largeTitle)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
    }
}

struct SectionEyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(StudyPalette.muted)
    }
}

/// 静态伴星立绘——Live2D 运行时（阶段 4）加载成功前的降级形态。
struct CompanionPortrait: View {
    var body: some View {
        Image("Companion")
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 190)
        .frame(maxWidth: .infinity, minHeight: 140, maxHeight: 210)
        .accessibilityLabel("伴星在书桌前陪你学习")
    }
}
