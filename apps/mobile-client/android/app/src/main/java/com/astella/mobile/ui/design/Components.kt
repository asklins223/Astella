package com.astella.mobile.ui.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.animation.core.*
import androidx.compose.runtime.*
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.isSystemInDarkTheme
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazeSourceRetention
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.blur.HazeBlurStyle
import dev.chrisbanes.haze.blur.HazeColorEffect
import dev.chrisbanes.haze.blur.hazeBlur
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.LocalContentColor
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ChatBubbleOutline
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
    Box(modifier.fillMaxSize(),content = content)
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
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 30.sp,lineHeight = 40.sp,fontFamily = FontFamily.Default),
                fontWeight = FontWeight.Medium,
            )
            if (subtitle != null) {
                Text(subtitle, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
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


@Composable
fun AstellaStar(modifier: Modifier = Modifier, color: Color = StudyPalette.accent) {
    Canvas(modifier) {
        val x = center.x; val y = center.y; val rx = size.width / 2; val ry = size.height / 2
        val p = Path().apply {
            moveTo(x,y-ry); quadraticTo(x+rx*.18f,y-ry*.18f,x+rx,y)
            quadraticTo(x+rx*.18f,y+ry*.18f,x,y+ry)
            quadraticTo(x-rx*.18f,y+ry*.18f,x-rx,y)
            quadraticTo(x-rx*.18f,y-ry*.18f,x,y-ry); close()
        }; drawPath(p,color)
    }
}

@Composable
fun AstellaTap(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val reduced = LocalReduceMotion.current
    val scale by animateFloatAsState(if (pressed && !reduced) .97f else 1f, tween(130), label = "astella-press")
    Box(modifier.scale(scale).clickable(enabled = enabled, interactionSource = source, indication = null, role = Role.Button, onClick = onClick), content = content)
}

@Composable
fun AstellaAppHeader(workspace: String, initial: String, onAccount: () -> Unit, records: Boolean? = null, onRecords: ((Boolean) -> Unit)? = null, modifier: Modifier = Modifier, edge: Dp = 24.dp) {
    Row(modifier.fillMaxWidth().padding(start = edge,end = edge,top = 6.dp,bottom = 14.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        if (records == true) {
            AstellaTap({ onRecords?.invoke(false) }, Modifier.size(42.dp,44.dp), content = { Icon(Icons.Default.ArrowBack,"回到伴星身边",Modifier.align(Alignment.Center).size(20.dp),tint = StudyPalette.ink) })
            Text("交流记录",fontSize = 20.sp,fontWeight = FontWeight.SemiBold,color = StudyPalette.ink)
        } else {
            Box(Modifier.size(38.dp),contentAlignment = Alignment.Center) {
                val accent = StudyPalette.accent
                Canvas(Modifier.size(32.dp,18.dp)) { rotate(-35f) { drawOval(accent.copy(alpha = .5f),style = Stroke(.8.dp.toPx())) } }
                AstellaStar(Modifier.size(19.dp,25.dp))
            }
            Column(Modifier.padding(start = 10.dp),verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("伴星",fontSize = 19.sp,fontWeight = FontWeight.SemiBold,color = StudyPalette.ink)
                Text(workspace,fontSize = 11.sp,color = StudyPalette.muted,maxLines = 1)
            }
        }
        Spacer(Modifier.weight(1f))
        if (records == false) AstellaTap({ onRecords?.invoke(true) }, Modifier.size(40.dp,44.dp),content = {
            Icon(Icons.Default.ChatBubbleOutline,"交流记录",Modifier.align(Alignment.Center).size(19.dp),tint = StudyPalette.ink)
        })
        AstellaTap(onAccount,Modifier.size(38.dp).astellaGlass(16.dp,interactive = true),content = {
            Text(initial.take(1).uppercase(),Modifier.align(Alignment.Center),fontSize = 13.sp,fontWeight = FontWeight.SemiBold,color = StudyPalette.ink)
        })
    }
}


@Composable
fun AstellaIconButton(onClick: () -> Unit,modifier: Modifier = Modifier,enabled: Boolean = true,content: @Composable () -> Unit) {
    AstellaTap(onClick,modifier.sizeIn(minWidth = 44.dp,minHeight = 44.dp),enabled) { Box(Modifier.align(Alignment.Center)) { content() } }
}
@Composable
fun AstellaTextButton(onClick: () -> Unit,modifier: Modifier = Modifier,enabled: Boolean = true,contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp,vertical = 8.dp),content: @Composable RowScope.() -> Unit) {
    AstellaTap(onClick,modifier.heightIn(min = 44.dp),enabled) {
        CompositionLocalProvider(LocalContentColor provides StudyPalette.accent.copy(alpha = if (enabled) 1f else .4f)) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.Center,content = content)
        }
    }
}
@Composable
fun AstellaButton(onClick: () -> Unit,modifier: Modifier = Modifier,enabled: Boolean = true,shape: Shape = RoundedCornerShape(16.dp),colors: ButtonColors? = null,contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp,vertical = 12.dp),content: @Composable RowScope.() -> Unit) {
    val fill = colors?.containerColor ?: StudyPalette.accent
    AstellaTap(onClick,modifier.heightIn(min = 48.dp).background(fill.copy(alpha = if (enabled) 1f else .4f),shape),enabled) {
        CompositionLocalProvider(LocalContentColor provides (colors?.contentColor ?: StudyPalette.paper)) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.Center,content = content)
        }
    }
}
@Composable
fun AstellaOutlinedButton(onClick: () -> Unit,modifier: Modifier = Modifier,enabled: Boolean = true,shape: Shape = RoundedCornerShape(16.dp),border: BorderStroke? = null,contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp,vertical = 12.dp),content: @Composable RowScope.() -> Unit) {
    AstellaTap(onClick,modifier.heightIn(min = 46.dp).background(StudyPalette.sky,shape),enabled) {
        CompositionLocalProvider(LocalContentColor provides StudyPalette.accent) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.Center,content = content)
        }
    }
}
@Composable
fun AstellaSwitch(checked: Boolean,onCheckedChange: (Boolean) -> Unit,modifier: Modifier = Modifier,enabled: Boolean = true) {
    val source = remember { MutableInteractionSource() }
    val offset by animateDpAsState(if (checked) 18.dp else 0.dp,if (LocalReduceMotion.current) snap() else MotionTokens.press(),label = "astella-toggle")
    Box(modifier.sizeIn(minWidth = 48.dp,minHeight = 44.dp).toggleable(value = checked,enabled = enabled,role = Role.Switch,interactionSource = source,indication = null,onValueChange = onCheckedChange),contentAlignment = Alignment.Center) {
        Box(Modifier.size(46.dp,28.dp).background(if (checked) StudyPalette.accent else StudyPalette.paperEdge,RoundedCornerShape(14.dp))) {
            Box(Modifier.padding(4.dp).offset(x = offset).size(20.dp).background(StudyPalette.paper,androidx.compose.foundation.shape.CircleShape))
        }
    }
}


val LocalAstellaHaze = staticCompositionLocalOf<HazeState?> { null }

@Composable
fun AstellaAtmosphere(modifier: Modifier = Modifier) {
    val base = StudyPalette.canvas
    Canvas(modifier) { drawRect(base) }
}

@Composable
fun Modifier.astellaGlass(radius: Dp,haze: HazeState? = LocalAstellaHaze.current,interactive: Boolean = false,tint: Color = Color.Transparent): Modifier {
    val shape = RoundedCornerShape(radius)
    val paper = StudyPalette.paper
    val dark = paper.luminance() < .5f
    val edge = StudyPalette.paperEdge
    val style = remember(paper,dark) {
        HazeBlurStyle {
            blurRadius(22.dp); noiseFactor(0f)
            colorEffects(listOf(HazeColorEffect.tint(paper.copy(alpha = if (dark) .42f else .40f))))
        }
    }
    val effect = if (haze != null && android.os.Build.VERSION.SDK_INT >= 31)
        Modifier.hazeBlur(input = HazeInput.Sources(haze,retention = HazeSourceRetention.ClearWhenUnavailable),style = style)
    else Modifier.background(paper.copy(alpha = .88f))
    return this.shadow(if (interactive) 6.dp else 3.dp,shape,ambientColor = Color.Black.copy(alpha = .035f),spotColor = Color.Black.copy(alpha = .035f))
        .clip(shape).then(effect)
        .background(tint)
        .border(.8.dp,if (tint.alpha > 0f) Color.White.copy(alpha = .2f) else edge.copy(alpha = .75f),shape)
}
