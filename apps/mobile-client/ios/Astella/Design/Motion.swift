import SwiftUI

/// 动效 token。与 DESIGN_TOKENS.md §三 同步——改动先改参数表，再改两端代码。
/// 一切状态变化默认弹性、可中断、可反转；`gated` 统一做 reduceMotion 门控
/// （返回 nil = 直接就位，不残留动画）。
enum Motion {
    /// 主按钮按压缩放。
    static let press = Animation.spring(duration: 0.22, bounce: 0.06)
    /// 次级按钮按压缩放（更收敛）。
    static let pressSoft = Animation.spring(duration: 0.2, bounce: 0.04)
    /// 页面路由推入/退出。
    static let routePush = Animation.spring(duration: 0.32, bounce: 0.06)
    static let authRoute = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.26)
    static let authFade = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.16)
    /// 分段/页签切换。
    static let segment = Animation.spring(duration: 0.38, bounce: 0.08)
    /// 菜单项散开间隔（Telegram 式 + 菜单）。
    static let messageSend = Animation.spring(duration: 0.32, bounce: 0.12)
    static let sheetRise = Animation.spring(duration: 0.38, bounce: 0.08)
    static let menuStagger: TimeInterval = 0.024

    /// reduceMotion 门控入口：替代散落的 `reduceMotion ? nil : .spring(...)`。
    static func gated(_ reduceMotion: Bool, _ animation: Animation) -> Animation? {
        reduceMotion ? nil : animation
    }
}
