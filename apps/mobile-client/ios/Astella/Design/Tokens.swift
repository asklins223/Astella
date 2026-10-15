import SwiftUI
import UIKit

/// 语义色。iOS 用系统动态语义色（深浅色自适应）；Android 端按 DESIGN_TOKENS.md §四
/// 映射 Material 3 角色。业务代码只用这里的语义名，不直接写平台颜色。
enum StudyPalette {
    static let ink = Color(uiColor: .label)
    static let muted = Color(uiColor: .secondaryLabel)
    /// 单一强调色（2026-10-15 合并原 blue/blueDeep，两者本同为 systemBlue）。
    static let accent = Color(uiColor: .systemBlue)
    static let sky = Color(uiColor: UIColor.systemBlue.withAlphaComponent(0.09))
    static let canvas = Color(uiColor: .systemBackground)
    static let paper = Color(uiColor: .secondarySystemBackground)
    static let inset = Color(uiColor: .tertiarySystemBackground)
    static let paperEdge = Color(uiColor: .separator)
    static let success = Color(uiColor: .systemGreen)
    static let danger = Color(uiColor: .systemRed)
}

/// 间距 scale（pt/dp 同值，见 DESIGN_TOKENS.md §四）。
enum StudySpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
}

/// 圆角 scale（连续圆角，见 DESIGN_TOKENS.md §四）。
enum StudyRadius {
    static let sm: CGFloat = 10
    static let md: CGFloat = 14
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
}

/// 字距 token（iOS 实测值；Android 不照抄负字距，见 DESIGN_TOKENS.md §四）。
enum StudyTracking {
    static let largeTitle: CGFloat = -0.45
    static let title: CGFloat = -0.25
}
