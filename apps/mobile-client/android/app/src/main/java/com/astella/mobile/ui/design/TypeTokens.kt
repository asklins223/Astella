package com.astella.mobile.ui.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp

/**
 * 字阶 token。按 DESIGN_TOKENS §四把 iOS 系统字阶映射到 M3 slot：
 * largeTitle→headlineLarge、title1→headlineMedium、title2→titleLarge、title3→titleMedium、
 * body→bodyLarge、subheadline→bodyMedium、footnote→bodySmall、caption→labelMedium、caption2→labelSmall。
 *
 * letterSpacing 一律 0：iOS 的负字距（largeTitle −0.45 / title −0.25）是 SF 的光学修正，
 * 抄到 Roboto/CJK 上会发糊——这是旧版观感发糊的根因，不再照抄（DESIGN_TOKENS §四）。
 * lineHeight 用 sp 显式值对齐 iOS 行距感觉（iOS 标称 +1 上下的 CJK 余量，观感为准）。
 */
val StudyTypography = Typography(
    // iOS largeTitle 34 —— PageHeading 主标题等
    headlineLarge = TextStyle(fontSize = 34.sp, lineHeight = 41.sp, letterSpacing = 0.sp),
    // iOS title1 28 —— 详情页大标题等
    headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, letterSpacing = 0.sp),
    // M3 默认保留 —— 紧凑页标题（“对话”/“伴星”）
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 32.sp, letterSpacing = 0.sp),
    // iOS title2 22 —— 问候句等
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = 0.sp),
    // iOS title3 20 —— 分节强标题、空态标题、列表条目标题
    titleMedium = TextStyle(fontSize = 20.sp, lineHeight = 25.sp, letterSpacing = 0.sp),
    // M3 默认保留 —— 小标题（chip、步骤题）
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.sp),
    // iOS body 17
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, letterSpacing = 0.sp),
    // iOS subheadline 15（PageHeading 副标题另含 lineSpacing 3 的余量）
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, letterSpacing = 0.sp),
    // iOS footnote 13
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = 0.sp),
    // M3 默认保留 —— 按钮文字与节标签
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.sp),
    // iOS caption 12 —— SectionEyebrow 等
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.sp),
    // iOS caption2 11
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.sp),
)
