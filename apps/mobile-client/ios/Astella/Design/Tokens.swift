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
    static let ink = adaptive(0x23334B, 0xEAF0F9)
    static let muted = adaptive(0x8192AA, 0x9AA9BE)
    static let accent = adaptive(0x3D70E5, 0xA9C2FF)
    static let actionFill = adaptive(0x8DB8F4, 0xA9C2FF)
    static let sky = adaptive(0xE6EEFC, 0x263B60)
    static let canvas = adaptive(0xEDF1F6, 0x111827)
    static let paper = adaptive(0xFBFCFE, 0x1C2739)
    static let inset = adaptive(0xEEF2F8, 0x26344A)
    static let paperEdge = adaptive(0xDCE4F0, 0x394B65)
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

/// Serif reading face. The mockup sets reader titles and body in Songti; iOS
/// ships Songti SC, with the system serif design as a fallback so the reader
/// still reads as a printed page on runtimes that omit the face.
enum StudySerif {
    static let familyName = "Songti SC"

    static func uiFont(size: CGFloat, weight: UIFont.Weight = .regular, serif: Bool = true) -> UIFont {
        guard serif else { return .systemFont(ofSize: size, weight: weight) }
        let name = weight >= .semibold ? "STSongti-SC-Bold" : "STSongti-SC-Regular"
        if let font = UIFont(name: name, size: size) { return font }
        if let font = UIFont(name: weight >= .semibold ? "Songti SC Bold" : "Songti SC", size: size) { return font }
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        if let descriptor = base.fontDescriptor.withDesign(.serif) { return UIFont(descriptor: descriptor, size: size) }
        return base
    }

    static func font(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(familyName, size: size).weight(weight)
    }
}
