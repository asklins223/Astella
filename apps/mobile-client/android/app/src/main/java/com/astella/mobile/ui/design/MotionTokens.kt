package com.astella.mobile.ui.design

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext

/**
 * 动效 token（DESIGN_TOKENS §三）。一切状态变化默认弹性、可中断、可反转。
 *
 * iOS `spring(duration:bounce:)` → Android `spring(dampingRatio, stiffness)` 换算：
 * dampingRatio = 1 − bounce；ω0 ≈ 3.5 / duration_seconds；stiffness = ω0² 取整到 5 的倍数。
 * | token | iOS | Android |
 * | press | 0.22s bounce .06 | damping .94 / stiffness 255 |
 * | pressSoft | 0.2s bounce .04 | damping .96 / stiffness 305 |
 * | routePush | 0.32s bounce .06 | damping .94 / stiffness 120 |
 * | segment | 0.38s bounce .08 | damping .92 / stiffness 85 |
 */
object MotionTokens {
    /** 主按钮按压缩放（scale 0.985，见 [pressScale]）。 */
    fun <T> press(): SpringSpec<T> = spring(dampingRatio = 0.94f, stiffness = 255f)

    /** 次级按钮按压缩放（scale 0.99，更收敛）。 */
    fun <T> pressSoft(): SpringSpec<T> = spring(dampingRatio = 0.96f, stiffness = 305f)

    /** 页面路由推入/退出（阶段 9 替换现有 tween 转场时接入）。 */
    fun <T> routePush(): SpringSpec<T> = spring(dampingRatio = 0.94f, stiffness = 120f)

    /** 分段/页签切换。 */
    fun <T> segment(): SpringSpec<T> = spring(dampingRatio = 0.92f, stiffness = 85f)

    /** 「+」二级菜单逐项散开间隔（reduceMotion 时 0ms，整组淡入）。 */
    const val menuStaggerMillis: Int = 24
}

/**
 * 本机「手动减弱动效」偏好（App 设置写入，不跨设备同步）。
 * 由 AstellaRoot 从 state.localReduceMotion 提供；系统侧由 [rememberSystemReducedMotion] 另行合成。
 */
val LocalReduceMotion = compositionLocalOf { false }

/** 系统「动画时长缩放」关闭（Android 对应 iOS 系统减少动态），值变化实时生效。 */
@Composable
fun rememberSystemReducedMotion(): Boolean {
    val context = LocalContext.current
    fun systemAnimationsDisabled(): Boolean = runCatching {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) <= 0f
    }.getOrDefault(false)

    var reduced by remember(context) { mutableStateOf(systemAnimationsDisabled()) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduced = systemAnimationsDisabled()
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        context.contentResolver.registerContentObserver(uri, false, observer)
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return reduced
}

/**
 * reduceMotion 门控：系统减少动态 **或** 本机手动减弱时为 false。
 * 装饰性动效在 false 时直接就位（对应 iOS `Motion.gated` 返回 nil 的语义），不残留动画。
 */
@Composable
fun enabledMotion(): Boolean = !LocalReduceMotion.current && !rememberSystemReducedMotion()

/**
 * 按压缩放反馈：按压 0.985（[soft] 次级 0.99）× 对应 spring，松手弹回。
 * reduceMotion（[enabledMotion] 为 false）或 [enabled] 为 false 时无缩放，仅保留原交互。
 * 阶段 9 把它接到主/次级按钮上；此处只提供 token 化工具。
 */
@Composable
fun Modifier.pressScale(soft: Boolean = false, enabled: Boolean = true): Modifier {
    val motionOn = enabled && enabledMotion()
    // AwaitPointerEventScope 是受限挂起作用域，不能在其中调 InteractionSource.emit；
    // 用本地按压状态驱动缩放，效果等价。
    var pressed by remember { mutableStateOf(false) }
    val target = when {
        !motionOn || !pressed -> 1f
        soft -> 0.99f
        else -> 0.985f
    }
    val scale by animateFloatAsState(
        targetValue = target,
        animationSpec = if (soft) MotionTokens.pressSoft() else MotionTokens.press(),
        label = "pressScale",
    )
    return this
        .pointerInput(enabled) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false)
                pressed = true
                waitForUpOrCancellation()
                pressed = false
            }
        }
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
}
