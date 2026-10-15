package com.astella.mobile.ui.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.astella.mobile.R

/** 全屏画布底（= canvas）。 */
@Composable
fun DawnBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier.fillMaxSize().background(StudyPalette.canvas),
        content = content,
    )
}

/**
 * 玻璃材质口径（DESIGN_SPEC）：iOS 26 的 Liquid Glass（glassEffect / .glass 按钮样式）
 * 在 Android 没有对应物，也不这么叫；这里用 M3 Surface + tonal elevation 近似
 * “交互面浮起”的层级，分隔与对比仍靠 outline / 表面色表达。
 * iOS 18 的 .regularMaterial 回退同样由 tonal 表面承接。
 */
@Composable
fun TonalSurface(
    modifier: Modifier = Modifier,
    radius: Dp = StudyRadius.md,
    tonalElevation: Dp = 2.dp,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(radius),
        color = StudyPalette.paper,
        tonalElevation = tonalElevation,
        content = content,
    )
}

/** 纸面：与 iOS PaperSurface 同底同描边（paperEdge 52% / 0.7dp），默认 padding = xl、圆角 = lg。 */
@Composable
fun PaperSurface(
    modifier: Modifier = Modifier,
    padding: Dp = StudySpacing.xl,
    content: @Composable () -> Unit,
) {
    StudyPaperBase(modifier, padding, content)
}

/**
 * 状态/说明纸面：与 PaperSurface 同底同描边，padding 14（iOS NoticeSurface 同值，
 * 不在 spacing scale 上——照抄 iOS 组件参数）。保留两个名字以对齐 iOS 组件语义，内部共享实现。
 */
@Composable
fun NoticeSurface(
    modifier: Modifier = Modifier,
    padding: Dp = 14.dp,
    content: @Composable () -> Unit,
) {
    StudyPaperBase(modifier, padding, content)
}

@Composable
private fun StudyPaperBase(
    modifier: Modifier,
    padding: Dp,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(StudyRadius.lg),
        color = StudyPalette.paper,
        border = BorderStroke(0.7.dp, StudyPalette.paperEdge.copy(alpha = 0.52f)),
    ) {
        Box(Modifier.padding(padding), contentAlignment = Alignment.CenterStart) { content() }
    }
}

/** 页眉：eyebrow + 大标题 + 可选副题（对齐 iOS PageHeading 参数与节奏）。 */
@Composable
fun PageHeading(
    eyebrow: String,
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(StudySpacing.lg - 2.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            SectionEyebrow(eyebrow)
            Text(
                title,
                color = StudyPalette.ink,
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.SemiBold,
            )
            if (subtitle != null) {
                Text(subtitle, color = StudyPalette.muted, style = MaterialTheme.typography.bodyMedium)
            }
        }
        trailing?.invoke()
    }
}

/** 节标签（= iOS SectionEyebrow：caption semibold muted，无字距）。 */
@Composable
fun SectionEyebrow(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier,
        color = StudyPalette.muted,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
    )
}

/** 断线提示行：标题 + 说明 + 重试。 */
@Composable
fun ConnectionFailureNotice(
    title: String,
    message: String,
    retryLabel: String = "重试",
    onRetry: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Icons.Filled.WifiOff,
            contentDescription = null,
            tint = StudyPalette.danger,
            modifier = Modifier.padding(top = 2.dp).size(18.dp),
        )
        Column(Modifier.weight(1f).padding(start = 10.dp, end = 4.dp)) {
            Text(title, color = StudyPalette.ink, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(message, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = onRetry, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
            Text(retryLabel, color = StudyPalette.accent, maxLines = 1)
        }
    }
}

/** 静态伴星立绘——Live2D 运行时加载成功前的降级形态。 */
@Composable
fun CompanionPortrait(modifier: Modifier = Modifier, height: Dp = 248.dp, reduceMotion: Boolean = false) {
    Box(
        modifier.fillMaxWidth().height(height).semantics { contentDescription = "伴星在书桌前陪你学习" },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.companion),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.height(height),
        )
    }
}
