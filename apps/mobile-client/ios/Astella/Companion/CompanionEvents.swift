import Foundation

/// 伴星事件语义（与 DESIGN_TOKENS.md §五 同步：事件词两端共用，映射细节随阶段 4/9 回填）。
enum CompanionEvent: Equatable {
    /// 无交互的常驻状态（呼吸默认循环）。
    case idle
    /// 注意力转向交互源（拖拽悬停 / 选区工具条出现）。
    case attention
    /// 文件 / 图片吸收；`success == false` 视同失败（歪头）。
    case absorb(success: Bool)
    /// 回合运行中的思考循环。
    case thinking
    /// TTS 播放：`start == true` 开口型，`false` 收口。
    case speaking(start: Bool)
    /// 回合失败（与错误面板同时）。
    case fail
}

/// 事件 → Live2D 动作/表情映射表（whale 模型，`c_0120.model3.json`）。
///
/// 结构对齐 DESIGN_TOKENS.md §五。`expression` / `motion` 是 model3.json 内的 ID，
/// 阶段 4b 已按真实条目回填：
/// - Motions 分组（5 组，各 1 条）：`Idle`（motion3.json Meta.Loop=true，桥内预载时
///   显式 SetLoop 常驻循环）、`Bubble`、`Spray`、`Selfie`、`SelfieQuick`
///   （后两者为展示类动作，暂无事件位，未绑定）；
/// - Expressions（30 条）：happy / starstruck / heart-eyes / surprised / blush /
///   mischievous / question / sweat / dizzy / angry / sad / cry / dazed / drool /
///   gloomy / tongue / glasses-round / glasses-square / glasses-oval / sunglasses /
///   cat-sticker / rabbit-sticker / bow-sticker / flowers / heartbeat / soul / hearts /
///   cat-paw / peace / whale-on-head。
enum CompanionEventMap {
    struct Entry: Equatable {
        /// model3.json expressions 条目名；nil = 无表情切换。
        let expression: String?
        /// model3.json motions 条目名；nil = 待 SDK 接入后绑定。
        let motion: String?
        /// PNG 降级（或 reduceMotion 下的替代微反应）是否做微反应；见 `CompanionStageView.react`。
        let fallbackPulse: Bool
    }

    static func binding(for event: CompanionEvent) -> Entry {
        switch event {
        case .idle:
            // 呼吸默认循环：Idle 组常驻循环（桥内低优先级，事件 motion 可抢占、
            // 结束后自动恢复；重复 .idle 在播放中会被优先级门控直接丢弃）。
            return Entry(expression: nil, motion: "Idle", fallbackPulse: false)
        case .attention:
            // 眼神转向交互源：不走 motion/表情，由 Live2DStageController 直接调
            // 桥的 pulseAttention（ParamAngleY / ParamEyeBallX 短暂偏移后回中）。
            return Entry(expression: nil, motion: nil, fallbackPulse: true)
        case .absorb(success: true):
            // 发现→前倾→光晕涟漪：表情 surprised + 动作 Spray（短促光点，0.47s，播完回 Idle）。
            return Entry(expression: "surprised", motion: "Spray", fallbackPulse: true)
        case .absorb(success: false):
            // 吸收失败与 fail 共用歪头路径（无专用 motion，表情承载）。
            return Entry(expression: "question", motion: nil, fallbackPulse: true)
        case .thinking:
            // 思考：Bubble 动作（5s 单次，播完自动回 Idle 循环；连发事件被 Normal
            // 优先级门控丢弃，不会叠加）。
            return Entry(expression: nil, motion: "Bubble", fallbackPulse: true)
        case .speaking:
            // 口型走 ParamMouthOpenY（由 TTS 播放进度驱动 `mouthOpen`，无独立 expression/motion）。
            return Entry(expression: nil, motion: nil, fallbackPulse: true)
        case .fail:
            // 歪头/遗憾：表情 question（whale 无专用歪头 motion，Selfie* 未绑定）。
            return Entry(expression: "question", motion: nil, fallbackPulse: true)
        }
    }
}
