import SwiftUI
import UIKit

/// Astella's mist / ice palette. Platform semantic colors are kept out of
/// the product chrome; both clients use these exact light and dark values.
enum StudyPalette {
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
    static let ink = adaptive(0x27334B, 0xEDF2FF)
    static let muted = adaptive(0x66758A, 0x9AA9C2)
    static let accent = adaptive(0x5A7CD1, 0xA9C2FF)
    static let actionFill = adaptive(0x8DB8F4, 0xA9C2FF)
    static let sky = adaptive(0xE5EEFF, 0x263B60)
    static let canvas = adaptive(0xFFFFFF, 0x101827)
    static let paper = adaptive(0xFFFFFF, 0x1C2B43)
    static let inset = adaptive(0xF3F5F8, 0x283A55)
    static let paperEdge = adaptive(0xDDE2E9, 0x3D5274)
    static let success = adaptive(0x6C9DAB, 0xA3CDD6)
    static let danger = adaptive(0xB76752, 0xE5A38D)
    static let night = Color(red: 0.15, green: 0.21, blue: 0.34)
    static let pollen = Color(red: 0.73, green: 0.85, blue: 1.0)
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
