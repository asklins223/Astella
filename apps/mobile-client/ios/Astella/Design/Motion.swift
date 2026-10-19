import SwiftUI

/// SwiftUI motion tokens. Platform behavior stays native and interruptible;
/// `gated` removes movement when the system or local Reduce Motion setting is on.
enum Motion {
    /// 主按钮按压缩放。
    static let press = Animation.spring(duration: 0.22, bounce: 0.06)
    /// 次级按钮按压缩放（更收敛）。
    static let pressSoft = Animation.spring(duration: 0.2, bounce: 0.04)
    /// 页面路由推入/退出。
    static let routePush = Animation.spring(duration: 0.32, bounce: 0.06)
    static let authRoute = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.26)
    static let authFade = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.16)
    /// Selection and segmented-control movement. Use SwiftUI's native snappy
    /// spring so the indicator can be retargeted when the user taps again.
    static let segment = Animation.snappy(duration: 0.32, extraBounce: 0.03)
    /// The companion dock makes room for its lightweight shortcut.
    static let companionDock = Animation.spring(duration: 0.34, bounce: 0.04)
    /// 菜单项散开间隔（Telegram 式 + 菜单）。
    static let messageSend = Animation.spring(duration: 0.32, bounce: 0.12)
    static let sheetRise = Animation.spring(duration: 0.38, bounce: 0.08)
    static let menuStagger: TimeInterval = 0.024

    /// reduceMotion 门控入口：替代散落的 `reduceMotion ? nil : .spring(...)`。
    static func gated(_ reduceMotion: Bool, _ animation: Animation) -> Animation? {
        reduceMotion ? nil : animation
    }
}
