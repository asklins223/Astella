import SwiftUI
import MetalKit

// MARK: - Live2DStageController

/// 事件 → Cubism 渲染桥的控制通道。
///
/// `CompanionStageView.react(to:)` 与 `mouthOpen` 变化经它转发到桥；representable
/// 在 attach 后回填 `bridge`。引用类型：跨视图副本共享同一通道（与
/// `CompanionReactionState` 同一理由）。
@MainActor
final class Live2DStageController {
    /// 由 Live2DRenderView 持有桥的 Coordinator 回填；视图拆除后置 nil。
    weak var bridge: CubismBridge?

    /// 按 `CompanionEventMap` 驱动桥：expression 直接 set，motion 播放
    /// （Idle 恢复循环；motion 抑制与静帧在桥内按 reduceMotion 处理），
    /// attention 走视线脉冲。
    func apply(event: CompanionEvent) {
        guard let bridge else { return }
        if event == .attention {
            bridge.pulseAttention()
        }
        let entry = CompanionEventMap.binding(for: event)
        if let expression = entry.expression {
            bridge.setExpression(expression)
        }
        if let motion = entry.motion {
            bridge.startMotionGroup(motion)
        }
    }

    /// 口型（0…1）→ ParamMouthOpenY。
    func setMouthOpen(_ value: Double) {
        bridge?.mouthOpen = value
    }
}

// MARK: - Live2DRenderView

/// `MTKView` 的 SwiftUI 包装：Coordinator 持有 `CubismBridge`，
/// make 时绑定视图并发起模型加载，update 同步口型/动效门控/模型版本，
/// dismantle 释放全部 Cubism 资源。
struct Live2DRenderView: UIViewRepresentable {
    let modelRoot: URL
    let entry: String
    var mouthOpen: Double
    var reduceMotion: Bool
    let controller: Live2DStageController
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())

        let bridge = CubismBridge()
        // 失败异步回调：避免在视图更新期间改 store 状态；manager 置 .failed 走 PNG 降级。
        bridge.onFailure = { message in
            DispatchQueue.main.async { onFailure(message) }
        }
        context.coordinator.bridge = bridge
        controller.bridge = bridge

        // 先设门控再 attach（attach 按 reduceMotion 决定渲染循环起停）。
        bridge.mouthOpen = mouthOpen
        bridge.reduceMotion = reduceMotion
        bridge.attach(view)

        context.coordinator.loadedRoot = modelRoot.path
        context.coordinator.loadedEntry = entry
        bridge.loadModel(atRoot: modelRoot.path, entry: entry)
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        guard let bridge = context.coordinator.bridge else { return }
        controller.bridge = bridge

        if bridge.mouthOpen != mouthOpen {
            bridge.mouthOpen = mouthOpen
        }
        if bridge.reduceMotion != reduceMotion {
            bridge.reduceMotion = reduceMotion
        }
        if context.coordinator.loadedRoot != modelRoot.path
            || context.coordinator.loadedEntry != entry {
            context.coordinator.loadedRoot = modelRoot.path
            context.coordinator.loadedEntry = entry
            bridge.loadModel(atRoot: modelRoot.path, entry: entry)
        }
    }

    static func dismantleUIView(_ view: MTKView, coordinator: Coordinator) {
        coordinator.teardown()
    }

    final class Coordinator {
        var bridge: CubismBridge?
        var loadedRoot: String?
        var loadedEntry: String?

        func teardown() {
            bridge?.onFailure = nil
            bridge?.detach()
            bridge = nil
        }
    }
}
