package com.astella.mobile.ui.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * 间距 scale（dp，与 iOS `StudySpacing` 同值，见 DESIGN_TOKENS §四）。
 * 调用点的组件级 padding 用这套档位表达；纯布局微调（1/2/3dp 等）留在原地。
 */
object StudySpacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
}

/**
 * 圆角 scale（与 iOS `StudyRadius` 同值，见 DESIGN_TOKENS §四）。
 * 原调用点的 15/17/18/21 等魔法值已归一到最近档（平手取大档；0/2dp 的直角与发丝圆角除外）。
 * 纸面默认 lg、按钮胶囊用 xl/xxl 或 CircleShape。
 */
object StudyRadius {
    val sm = 10.dp
    val md = 14.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
}

/** M3 默认组件（TextField、Menu、Dialog 等）的形状也从同一套圆角取值。 */
val StudyShapes = Shapes(
    extraSmall = RoundedCornerShape(StudyRadius.sm),
    small = RoundedCornerShape(StudyRadius.md),
    medium = RoundedCornerShape(StudyRadius.lg),
    large = RoundedCornerShape(StudyRadius.xl),
    extraLarge = RoundedCornerShape(StudyRadius.xxl),
)
