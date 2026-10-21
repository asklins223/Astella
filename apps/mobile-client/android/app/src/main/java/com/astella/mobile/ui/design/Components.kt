package com.astella.mobile.ui.design

import android.os.Build
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.R
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazeSourceRetention
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.blur.HazeBlurStyle
import dev.chrisbanes.haze.blur.HazeColorEffect
import dev.chrisbanes.haze.blur.hazeBlur

/** 全屏画布底（= canvas）。 */
@Composable
fun DawnBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxSize(), content = content)
}

/**
 * 内容纸面：设计稿的稳定内容面（paper + 发丝描边），不冒充玻璃。
 * 玻璃只放在导航、输入、短交互与浮层上。
 */
@Composable
fun PaperSurface(
    modifier: Modifier = Modifier,
    padding: Dp = StudySpacing.xl,
    content: @Composable () -> Unit,
) = StudyPaperBase(modifier, padding, content)

/** 状态/说明纸面：与 PaperSurface 同底同描边，padding 14。 */
@Composable
fun NoticeSurface(
    modifier: Modifier = Modifier,
    padding: Dp = 14.dp,
    content: @Composable () -> Unit,
) = StudyPaperBase(modifier, padding, content)

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

/** 设计稿页眉（page-head）：11/600/1.6 字距的英文 eyebrow + 37px 主标题 + 12px 说明。 */
@Composable
fun PageEyebrow(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier,
        color = StudyPalette.muted,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.6.sp,
    )
}

/** 设计稿分节标签（settings-label）：12px 中等、次级色，无字距。 */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier,
        color = StudyPalette.muted,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = .6.sp,
    )
}

/** 页眉：eyebrow + 大标题 + 可选副题，trailing 与标题顶部对齐。 */
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
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(Modifier.weight(1f)) {
            PageEyebrow(eyebrow)
            Spacer(Modifier.height(10.dp))
            Text(
                title,
                color = StudyPalette.ink,
                fontSize = 36.sp,
                lineHeight = 42.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-1.4).sp,
            )
            if (subtitle != null) {
                Spacer(Modifier.height(9.dp))
                Text(
                    subtitle,
                    color = StudyPalette.muted,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                )
            }
        }
        trailing?.invoke()
    }
}

/** 兼容旧调用：节标签（无字距、非大写）。 */
@Composable
fun SectionEyebrow(text: String, modifier: Modifier = Modifier) = SectionLabel(text, modifier)

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
        AstellaGlyph(AstellaGlyphKind.Alert, Modifier.padding(top = 2.dp).size(18.dp), tint = StudyPalette.danger)
        Column(Modifier.weight(1f).padding(start = 10.dp, end = 4.dp)) {
            Text(title, color = StudyPalette.ink, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(message, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
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
            moveTo(x, y - ry); quadraticTo(x + rx * .18f, y - ry * .18f, x + rx, y)
            quadraticTo(x + rx * .18f, y + ry * .18f, x, y + ry)
            quadraticTo(x - rx * .18f, y + ry * .18f, x - rx, y)
            quadraticTo(x - rx * .18f, y - ry * .18f, x, y - ry); close()
        }; drawPath(p, color)
    }
}

@Composable
fun AstellaTap(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val reduced = LocalReduceMotion.current
    val scale by androidx.compose.animation.core.animateFloatAsState(
        if (pressed && !reduced) .97f else 1f,
        if (reduced) snap() else MotionTokens.press(),
        label = "astella-press",
    )
    Box(
        modifier.scale(scale).clickable(
            enabled = enabled,
            interactionSource = source,
            indication = null,
            role = Role.Button,
            onClick = onClick,
        ),
        content = content,
    )
}

/**
 * 分段控件（设计稿 segmented glass）：容器是玻璃，选中透镜是一片近白玻璃片，
 * 选中文字 12/600 ink，未选中 12 muted。透镜位移用弹簧，减少动效时直接就位。
 */
@Composable
fun GlassSegment(
    options: List<String>,
    selectedIndex: Int,
    modifier: Modifier = Modifier,
    height: Dp = 38.dp,
    radius: Dp = height / 2,
    selectedFill: Color? = null,
    onSelect: (Int) -> Unit,
) {
    val reduce = LocalReduceMotion.current
    val dark = StudyPalette.paper.luminance() < .5f
    val lens = if (dark) StudyPalette.inset else Color.White
    BoxWithConstraints(modifier.height(height).astellaGlass(radius)) {
        val pad = 3.dp
        val itemWidth = (maxWidth - pad * 2) / options.size
        val target = pad + itemWidth * selectedIndex
        val offsetX by animateDpAsState(
            target,
            animationSpec = if (reduce) snap() else MotionTokens.segment(),
            label = "segment-lens",
        )
        val lensShape = RoundedCornerShape(radius - pad)
        Box(
            Modifier.offset(x = offsetX, y = pad).width(itemWidth).height(height - pad * 2)
                .shadow(
                    5.dp, lensShape, clip = false,
                    ambientColor = Color(0xFF314E78).copy(alpha = .10f),
                    spotColor = Color(0xFF314E78).copy(alpha = .12f),
                )
                .background(
                    if (selectedFill != null) SolidColor(selectedFill) else Brush.linearGradient(
                        if (dark) listOf(lens.copy(alpha = .98f), lens.copy(alpha = .94f), lens.copy(alpha = .88f))
                        else listOf(lens.copy(alpha = .98f), lens.copy(alpha = .55f), lens.copy(alpha = .32f)),
                        start = Offset(0f, 0f), end = Offset(0f, 600f),
                    ),
                    lensShape,
                )
                .border(.8.dp, Color.White.copy(alpha = if (dark) .16f else if (selectedFill != null) .62f else .95f), lensShape),
        )
        Row(Modifier.fillMaxSize().padding(horizontal = pad)) {
            options.forEachIndexed { index, label ->
                val selected = index == selectedIndex
                Box(
                    Modifier.weight(1f).fillMaxHeight()
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { onSelect(index) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (selected) StudyPalette.ink else StudyPalette.muted,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/** 玻璃圆形按钮（返回、外观、页头操作）。 */
@Composable
fun GlassCircleButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    content: @Composable BoxScope.() -> Unit,
) {
    AstellaTap(onClick, modifier.size(size).astellaGlass(size / 2, interactive = true)) {
        Box(Modifier.align(Alignment.Center), content = content)
    }
}

/** 设置行图标底：设计稿 36px 圆角方、浅蓝底、蓝色 glyph。 */
@Composable
fun GlassIconTile(
    icon: AstellaGlyphKind,
    size: Dp = 38.dp,
    tint: Color = StudyPalette.accent,
    background: Color = StudyPalette.sky,
) {
    Box(
        Modifier.size(size).background(background, RoundedCornerShape(size * .32f)),
        contentAlignment = Alignment.Center,
    ) {
        AstellaGlyph(icon, Modifier.size(size * .47f), tint = tint)
    }
}

@Composable
fun AstellaAppHeader(
    workspace: String,
    initial: String,
    onAccount: () -> Unit,
    records: Boolean? = null,
    onRecords: ((Boolean) -> Unit)? = null,
    modifier: Modifier = Modifier,
    edge: Dp = 20.dp,
    workspaces: List<com.astella.mobile.data.WorkspaceSummary> = emptyList(),
    onWorkspace: (com.astella.mobile.data.WorkspaceSummary) -> Unit = {},
    darkTheme: Boolean = false,
    onThemeToggle: (() -> Unit)? = null,
) {
    var workspaceMenu by remember { mutableStateOf(false) }
    Row(
        modifier.fillMaxWidth().padding(start = 21.dp, end = 18.dp, top = 6.dp, bottom = 4.dp).heightIn(min = 46.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AstellaTap(
            onClick = { if (workspaces.size > 1) workspaceMenu = true },
            modifier = Modifier.widthIn(max = 132.dp).heightIn(min = 44.dp),
            enabled = workspaces.size > 1,
        ) {
            Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).background(StudyPalette.accent, CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(
                    workspace,
                    color = StudyPalette.ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (workspaces.size > 1) {
                    Spacer(Modifier.width(4.dp))
                    AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(10.dp), tint = StudyPalette.muted)
                }
            }
        }
        DropdownMenu(
            expanded = workspaceMenu,
            onDismissRequest = { workspaceMenu = false },
            shape = RoundedCornerShape(18.dp),
            containerColor = StudyPalette.paper,
        ) {
            workspaces.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.name, color = StudyPalette.ink) },
                    leadingIcon = {
                        if (option.name == workspace) AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(17.dp), tint = StudyPalette.accent)
                    },
                    onClick = { workspaceMenu = false; onWorkspace(option) },
                )
            }
        }
        Spacer(Modifier.weight(1f))
        if (records != null && onRecords != null) {
            GlassSegment(
                options = listOf("伴星", "记录"),
                selectedIndex = if (records) 1 else 0,
                modifier = Modifier.width(142.dp),
                height = 38.dp,
                radius = 18.dp,
                onSelect = { onRecords(it == 1) },
            )
        }
        Spacer(Modifier.weight(1f))
        if (records != null && onThemeToggle != null) {
            GlassCircleButton(onClick = onThemeToggle, size = 40.dp) {
                AstellaGlyph(
                    if (darkTheme) AstellaGlyphKind.Sun else AstellaGlyphKind.Moon,
                    Modifier.size(19.dp),
                    tint = StudyPalette.ink,
                )
            }
        } else {
            GlassCircleButton(onClick = onAccount, size = 40.dp) {
                AstellaGlyph(AstellaGlyphKind.Person, Modifier.size(19.dp), tint = StudyPalette.ink)
            }
        }
    }
}

@Composable
fun AstellaIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable () -> Unit) {
    AstellaTap(onClick, modifier.sizeIn(minWidth = 44.dp, minHeight = 44.dp), enabled) { Box(Modifier.align(Alignment.Center)) { content() } }
}

@Composable
fun AstellaTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    content: @Composable RowScope.() -> Unit,
) {
    AstellaTap(onClick, modifier.heightIn(min = 40.dp), enabled) {
        CompositionLocalProvider(LocalContentColor provides StudyPalette.accent.copy(alpha = if (enabled) 1f else .4f)) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, content = content)
        }
    }
}

/** 主按钮（设计稿 primary / glass-blue）：蓝色渐变、白色高光边与柔和蓝色投影。 */
@Composable
fun AstellaButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(18.dp),
    colors: ButtonColors? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = 20.dp, vertical = 13.dp),
    content: @Composable RowScope.() -> Unit,
) {
    val fill = colors?.containerColor ?: StudyPalette.accent
    val fillBrush = Brush.verticalGradient(
        listOf(fill.copy(alpha = .96f), fill.copy(alpha = .92f)),
    )
    AstellaTap(
        onClick,
        modifier.heightIn(min = 50.dp)
            .shadow(
                9.dp, shape, clip = false,
                ambientColor = fill.copy(alpha = .18f),
                spotColor = fill.copy(alpha = .22f),
            )
            .clip(shape)
            .background(fillBrush, shape)
            .border(.8.dp, Color.White.copy(alpha = .28f), shape),
        enabled,
    ) {
        CompositionLocalProvider(LocalContentColor provides (colors?.contentColor ?: Color.White)) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, content = content)
        }
    }
}

/** 次级按钮（设计稿 soft-button）：近白玻璃片、白色描边、轻投影。 */
@Composable
fun AstellaOutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(17.dp),
    border: BorderStroke? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
    content: @Composable RowScope.() -> Unit,
) {
    AstellaTap(
        onClick,
        modifier.heightIn(min = 48.dp).astellaGlass(17.dp).clip(shape),
        enabled,
    ) {
        CompositionLocalProvider(LocalContentColor provides StudyPalette.accent) {
            Row(Modifier.align(Alignment.Center).padding(contentPadding), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, content = content)
        }
    }
}

/** 自定开关（设计稿 toggle）：白色圆钮、浅灰轨道。 */
@Composable
fun AstellaSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val source = remember { MutableInteractionSource() }
    val offset by animateDpAsState(
        if (checked) 18.dp else 0.dp,
        if (LocalReduceMotion.current) snap() else MotionTokens.press(),
        label = "astella-toggle",
    )
    val dark = StudyPalette.paper.luminance() < .5f
    Box(
        modifier.sizeIn(minWidth = 48.dp, minHeight = 44.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, interactionSource = source, indication = null, onValueChange = onCheckedChange),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(46.dp, 28.dp)
                .background(
                    if (checked) StudyPalette.accent else if (dark) Color(0xFF394B65) else Color(0xFFE2E8F1),
                    RoundedCornerShape(14.dp),
                ),
        ) {
            Box(
                Modifier.padding(4.dp).offset(x = offset).size(20.dp)
                    .shadow(2.dp, CircleShape, ambientColor = Color.Black.copy(alpha = .12f), spotColor = Color.Black.copy(alpha = .16f))
                    .background(Color.White, CircleShape)
                    .semantics {
                        toggleableState = if (checked) ToggleableState.On else ToggleableState.Off
                    },
            )
        }
    }
}

val LocalAstellaHaze = staticCompositionLocalOf<HazeState?> { null }

/**
 * 画布氛围（设计稿 ambient）：左上乳白光、右下淡蓝光、右侧与左下的大银白球，
 * 都是低透明度径向渐变，不参与交互也不制造噪点。
 */
@Composable
fun AstellaAtmosphere(modifier: Modifier = Modifier) {
    val base = StudyPalette.canvas
    val accent = StudyPalette.accent
    val pollen = StudyPalette.pollen
    val dark = base.luminance() < .5f
    Canvas(modifier) {
        drawRect(base)
        val w = size.width
        val h = size.height
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) listOf(accent.copy(alpha = .10f), Color.Transparent)
                else listOf(Color.White.copy(alpha = .98f), Color.Transparent),
                center = Offset(w * .10f, h * .14f),
                radius = w * .95f,
            ),
            radius = w * .95f,
            center = Offset(w * .10f, h * .14f),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) listOf(accent.copy(alpha = .09f), Color.Transparent)
                else listOf(pollen.copy(alpha = .34f), Color.Transparent),
                center = Offset(w * .92f, h * .80f),
                radius = w * .70f,
            ),
            radius = w * .70f,
            center = Offset(w * .92f, h * .80f),
        )
        // 设计稿里右侧一颗大银白球与左下很淡的第二颗。
        drawCircle(
            brush = Brush.radialGradient(
                colors = if (dark) listOf(Color.White.copy(alpha = .05f), Color.Transparent)
                else listOf(Color.White.copy(alpha = .85f), Color.Transparent),
                center = Offset(w * 1.02f, h * .50f),
                radius = w * .48f,
            ),
            radius = w * .48f,
            center = Offset(w * 1.02f, h * .50f),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color.White.copy(alpha = if (dark) .03f else .38f), Color.Transparent),
                center = Offset(w * -.08f, h * .84f),
                radius = w * .42f,
            ),
            radius = w * .42f,
            center = Offset(w * -.08f, h * .84f),
        )
    }
}

/**
 * 玻璃材质（设计稿 .glass）：
 * 背景采样模糊 + 142° 白色/淡蓝高光渐变 + 0.8dp 白色到灰蓝的细边 + 柔和外投影。
 * 31 以下的系统用半透明纸色降级。
 */
@Composable
fun Modifier.astellaGlass(
    radius: Dp,
    haze: HazeState? = LocalAstellaHaze.current,
    interactive: Boolean = false,
    tint: Color = Color.Transparent,
): Modifier {
    val shape = RoundedCornerShape(radius)
    val paper = StudyPalette.paper
    val dark = paper.luminance() < .5f
    val style = remember(paper, dark) {
        HazeBlurStyle {
            blurRadius(24.dp); noiseFactor(0f)
            colorEffects(listOf(HazeColorEffect.tint(paper.copy(alpha = if (dark) .40f else .30f))))
        }
    }
    val blur = if (haze != null && Build.VERSION.SDK_INT >= 31)
        Modifier.hazeBlur(input = HazeInput.Sources(haze, retention = HazeSourceRetention.ClearWhenUnavailable), style = style)
    else Modifier.background(paper.copy(alpha = if (dark) .92f else .88f))
    val sheenTop = if (dark) Color(0x40AEC8EE) else Color.White.copy(alpha = .62f)
    val sheenMid = if (dark) Color(0x0DFFFFFF) else Color.White.copy(alpha = .06f)
    val sheenEnd = if (dark) Color(0x2E86ADE6) else Color(0xFFC9DBF5).copy(alpha = .16f)
    return this
        .shadow(
            if (interactive) 11.dp else 8.dp,
            shape,
            clip = false,
            ambientColor = Color(0xFF314E78).copy(alpha = if (dark) .18f else .09f),
            spotColor = Color(0xFF314E78).copy(alpha = if (dark) .22f else .11f),
        )
        .clip(shape)
        .then(blur)
        .drawBehind {
            drawRect(
                brush = Brush.linearGradient(
                    colors = listOf(sheenTop, sheenMid, sheenEnd),
                    start = Offset(0f, 0f),
                    end = Offset(size.width * 1.1f, size.height * 1.25f),
                ),
            )
        }
        .background(tint)
        .border(
            width = .8.dp,
            brush = Brush.verticalGradient(
                listOf(
                    Color.White.copy(alpha = if (dark) .34f else .96f),
                    Color.White.copy(alpha = if (dark) .10f else .40f),
                    if (dark) Color(0xFF7896C8).copy(alpha = .20f) else Color(0xFFB4C8E8).copy(alpha = .40f),
                ),
            ),
            shape = shape,
        )
}
