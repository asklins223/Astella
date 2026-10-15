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
/// 结构对齐 DESIGN_TOKENS.md §五。`expression` / `motion` 是 model3.json 内的 ID：
/// expressions 已确认存在（happy/starstruck/heart-eyes/surprised/blush/mischievous/question…）；
/// motions/ 目录存在但本阶段未接入 SDK，具体条目名待阶段 4b 加载 model3.json 后核对，
/// 因此 motion 暂多为 nil（目标动作已在注释标明）。
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
            // 呼吸默认循环；长时间无交互可微调视线（SDK 绑定 Idle motion）。
            return Entry(expression: nil, motion: "Idle", fallbackPulse: false)
        case .attention:
            // 眼神转向交互源：SDK 绑定 ParamAngleY / ParamEyeBallX 追踪，无独立 motion。
            return Entry(expression: nil, motion: nil, fallbackPulse: true)
        case .absorb(success: true):
            // 发现→前倾→光晕涟漪：表情 surprised，前倾类 motion 待 SDK 后绑定。
            return Entry(expression: "surprised", motion: nil, fallbackPulse: true)
        case .absorb(success: false):
            // 吸收失败与 fail 共用歪头路径。
            return Entry(expression: "question", motion: nil, fallbackPulse: true)
        case .thinking:
            // 思考循环：motions/ 内循环 motion 待 SDK 后绑定；不常驻「正在做事」。
            return Entry(expression: nil, motion: nil, fallbackPulse: true)
        case .speaking:
            // 口型走 ParamMouthOpenY（由 TTS 播放进度驱动 `mouthOpen`，无独立 expression/motion）。
            return Entry(expression: nil, motion: nil, fallbackPulse: true)
        case .fail:
            // 歪头/遗憾：表情 question，歪头 motion 待 SDK 后绑定。
            return Entry(expression: "question", motion: nil, fallbackPulse: true)
        }
    }
}
