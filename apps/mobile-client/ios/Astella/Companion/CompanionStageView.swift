import SwiftUI
import Observation

/// 伴星舞台：对话页在场形态 + 未来召唤形态共用的单一容器。
///
/// 本阶段（4a，SDK 无关）：
/// - 模型 `ready` 时把渲染交给 `Live2DSlotView`（占位，内容仍是降级 PNG）；
/// - `idle / downloading / failed` 直接渲染 `CompanionPortrait` 降级；
/// - `react(to:)` 对外部事件做 PNG 降级微反应（reduceMotion 统一门控）。
///
/// 阶段 4b 接入 Cubism SDK Native 后：ready 状态的事件改走
/// `CompanionEventMap.binding(for:)` 驱动 motion/expression，降级微反应仅保留在
/// PNG 路径与 reduceMotion 下。
///
/// 尺寸/构图与 `CompanionPortrait` 兼容，可直接放 `CompanionScene` 顶部替换现用法。
struct CompanionStageView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    /// 口型预留：本阶段恒 0。Phase 5 由 TTS 播放进度驱动（Live2D ParamMouthOpenY）。
    @Binding var mouthOpen: Double
    @State private var reaction = CompanionReactionState()

    init(mouthOpen: Binding<Double> = .constant(0)) {
        self._mouthOpen = mouthOpen
    }

    /// reduceMotion 判定：系统「减少动态」或 App 内「手动减弱」任一开启即关微反应。
    private var motionDisabled: Bool {
        systemReduceMotion || store.localReduceMotion
    }

    var body: some View {
        Group {
            if case .ready(let version, let root, let entry) = store.companionModel.state {
                Live2DSlotView(modelRoot: root, entry: entry, version: version, mouthOpen: mouthOpen)
            } else {
                // idle / downloading / failed 一视同仁：PNG 降级（不打扰地等待或失败）。
                CompanionPortrait()
            }
        }
        .scaleEffect(reaction.scale)
        .rotationEffect(.degrees(reaction.tilt))
        .opacity(reaction.opacity)
    }

    /// 外部事件入口（回合状态、文件吸收、TTS 播放等）。
    /// 可从任意持有本视图值的调用方触发：反应状态由引用类型承载，跨视图副本共享。
    func react(to event: CompanionEvent) {
        let entry = CompanionEventMap.binding(for: event)

        // ready（未来 Live2D）：事件走 EventMap → motion/expression，不做 PNG 微反应。
        // 阶段 4b 接入 Cubism SDK 后在此把 entry.expression / entry.motion 交给渲染层。
        if case .ready = store.companionModel.state, !motionDisabled {
            return
        }

        // PNG 降级微反应：reduceMotion 时全部关掉（直接就位，不留残余动画）。
        guard !motionDisabled, entry.fallbackPulse else { return }

        switch event {
        case .absorb(success: true):
            // 轻 scale 脉冲 0.97 → 1.03 → 1（Motion token 弹性）。
            withAnimation(Motion.gated(false, .spring(duration: 0.16, bounce: 0.08))) {
                reaction.scale = 0.97
            }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(170))
                withAnimation(Motion.gated(false, .spring(duration: 0.34, bounce: 0.32))) {
                    reaction.scale = 1.03
                }
                try? await Task.sleep(for: .milliseconds(120))
                withAnimation(Motion.gated(false, .spring(duration: 0.3, bounce: 0.2))) {
                    reaction.scale = 1
                }
            }
        case .absorb(success: false), .fail:
            // 轻微歪头 rotation(-2° → 0)。
            withAnimation(Motion.gated(false, .spring(duration: 0.2, bounce: 0.14))) {
                reaction.tilt = -2
            }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(260))
                withAnimation(Motion.gated(false, .spring(duration: 0.3, bounce: 0.18))) {
                    reaction.tilt = 0
                }
            }
        case .thinking:
            // 透明度 1 → 0.85 → 1，单次。
            withAnimation(.easeInOut(duration: 0.22)) { reaction.opacity = 0.85 }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(240))
                withAnimation(.easeInOut(duration: 0.26)) { reaction.opacity = 1 }
            }
        case .speaking(let start):
            // 0.6s 呼吸节奏开关（降级下近似「在说话」的生命感；真口型在 mouthOpen / Live2D）。
            if start {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    reaction.breathing = 1.015
                }
            } else {
                withAnimation(.easeOut(duration: 0.24)) { reaction.breathing = 1 }
            }
        case .idle, .attention:
            // 降级形态下无独立微反应；attention 的视线跟随属 Live2D 层（阶段 4b）。
            break
        }
    }
}

/// 舞台内部反应状态：引用类型，保证 `react(to:)` 在视图值副本间共享同一份动画状态。
@Observable
private final class CompanionReactionState {
    var scale: CGFloat = 1
    var tilt: Double = 0
    var opacity: Double = 1
    var breathing: CGFloat = 1
}

/// Live2D 渲染槽位（阶段 4a 占位）。
///
/// 阶段 4b 接入 Cubism SDK Native 后在此用 `modelRoot` + `entry`（model3.json）
/// 实例化 CubismUserModel 并渲染；事件经 `CompanionEventMap` 驱动 motion/expression，
/// 口型由 `mouthOpen`（0…1）驱动 ParamMouthOpenY。本阶段内容仍是降级 PNG。
struct Live2DSlotView: View {
    let modelRoot: URL
    let entry: String
    let version: String
    var mouthOpen: Double

    var body: some View {
        // TODO(阶段 4b): 接入 Cubism SDK Native —— 此处替换为 Live2D 渲染层。
        CompanionPortrait()
            .accessibilityLabel("伴星模型已就绪（版本 \(version)），Live2D 渲染将在阶段 4b 接入")
    }
}
