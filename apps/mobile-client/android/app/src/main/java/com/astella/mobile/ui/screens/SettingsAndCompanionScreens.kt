package com.astella.mobile.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.optNullableString
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaIconButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaOutlinedButton
import com.astella.mobile.ui.design.AstellaSwitch
import com.astella.mobile.ui.design.AstellaTap
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.GlassIconTile
import com.astella.mobile.ui.design.GlassSegment
import com.astella.mobile.ui.design.LocalReduceMotion
import com.astella.mobile.ui.design.MotionTokens
import com.astella.mobile.ui.design.NoticeSurface
import com.astella.mobile.ui.design.PageEyebrow
import com.astella.mobile.ui.design.SectionLabel
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.astellaGlass
import com.astella.mobile.ui.design.rememberSystemReducedMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 页内页头：返回玻璃圆 + 27/600 标题（可选 11/1.4 字距 eyebrow）。
 * 大标题退出争抢——页头只负责“我在哪”，内容区自己承担重心。
 */
@Composable
fun SettingsPageHeader(
    title: String,
    onBack: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    eyebrow: String? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 6.dp)
            .heightIn(min = 46.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassCircleButton(
            onClick = onBack,
            size = 42.dp,
            modifier = Modifier.semantics { contentDescription = "返回" },
        ) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(18.dp), tint = StudyPalette.ink)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            if (eyebrow != null) {
                Text(
                    eyebrow.uppercase(),
                    color = StudyPalette.muted,
                    fontSize = 10.5.sp,
                    lineHeight = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 1.3.sp,
                )
                Spacer(Modifier.height(3.dp))
            }
            Text(
                title,
                color = StudyPalette.ink,
                fontSize = 27.sp,
                lineHeight = 33.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.6).sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        trailing?.invoke()
    }
}

/* ─────────────────────────── 共享页面构件 ─────────────────────────── */

/** 发丝分隔线：比“卡片套卡片”更轻的层级手段。 */
@Composable
fun Hairline(startIndent: Dp = 0.dp, endIndent: Dp = 0.dp, alpha: Float = .55f) {
    Box(
        Modifier.fillMaxWidth().padding(start = startIndent, end = endIndent).height(.7.dp)
            .background(StudyPalette.paperEdge.copy(alpha = alpha)),
    )
}

/**
 * 分组标题行：16/600 标题 + 11.5 meta + 右侧安静动作。
 * 与正文 14–15、辅助 11–12 拉开一档，列表不再和标题同重。
 */
@Composable
fun ShellSectionHeader(
    title: String,
    meta: String? = null,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 30.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            color = StudyPalette.ink,
            fontSize = 16.sp,
            lineHeight = 21.sp,
            fontWeight = FontWeight.SemiBold,
        )
        if (meta != null) {
            Spacer(Modifier.width(8.dp))
            Text(meta, color = StudyPalette.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.weight(1f))
        action?.invoke()
    }
}

/** 安静的页内动作：glyph + 12.5/500 文字，保持 40dp 触控高度。 */
@Composable
fun QuietTextAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    glyph: AstellaGlyphKind? = null,
    enabled: Boolean = true,
) {
    AstellaTap(onClick, modifier.heightIn(min = 40.dp), enabled = enabled) {
        Row(
            Modifier.align(Alignment.Center).padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (glyph != null) {
                AstellaGlyph(
                    glyph, Modifier.size(14.dp),
                    tint = StudyPalette.accent.copy(alpha = if (enabled) 1f else .4f),
                )
            }
            Text(
                label,
                color = StudyPalette.accent.copy(alpha = if (enabled) 1f else .4f),
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

/** 稳定纸面说明（错误 / 提示）：图标 + 标题 + 说明 + 可选动作。 */
@Composable
fun ShellNotice(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    glyph: AstellaGlyphKind = AstellaGlyphKind.Info,
    tint: Color = StudyPalette.muted,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.lg))
            .background(StudyPalette.paper.copy(alpha = .82f))
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .5f), RoundedCornerShape(StudyRadius.lg))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        AstellaGlyph(glyph, Modifier.padding(top = 1.dp).size(16.dp), tint = tint)
        Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = StudyPalette.ink, fontSize = 13.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
            Text(message, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
        }
        if (actionLabel != null && onAction != null) {
            QuietTextAction(actionLabel, onAction, modifier = Modifier.padding(start = 4.dp), enabled = true)
        }
    }
}

/**
 * 逐项入场：40–55ms 间隔、300ms 上浮淡入，只做一次；减少动效时直接就位。
 * 仅消费 [LocalReduceMotion]（AstellaRoot 已把系统动画缩放合成进去），不重复注册观察者。
 */
@Composable
fun StaggerReveal(
    index: Int,
    modifier: Modifier = Modifier,
    key: Any? = Unit,
    content: @Composable () -> Unit,
) {
    val reduce = LocalReduceMotion.current
    var shown by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key) { shown = true }
    val spec = if (reduce) snap<Float>() else tween(
        durationMillis = 300,
        delayMillis = (index * 45).coerceAtMost(360),
        easing = CubicBezierEasing(.2f, .8f, .2f, 1f),
    )
    val alpha by animateFloatAsState(if (shown) 1f else 0f, spec, label = "stagger-alpha")
    val rise by animateFloatAsState(if (shown) 0f else 12f, spec, label = "stagger-rise")
    Box(
        modifier.graphicsLayer {
            this.alpha = alpha
            translationY = rise.dp.toPx()
        },
    ) { content() }
}

/** 一组设置/内容行的稳定纸面：不冒充玻璃，卡内用发丝分隔。 */
@Composable
fun SettingsGroup(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl)),
        content = content,
    )
}

/** 设置行：34dp 图标底 + 16/500 标题 + 12 说明 + 可选值 + chevron；按压有淡底反馈。 */
@Composable
fun SettingsRow(
    icon: AstellaGlyphKind?,
    title: String,
    subtitle: String? = null,
    letter: String? = null,
    value: String? = null,
    valueTint: Color = StudyPalette.muted,
    showChevron: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val tint by animateColorAsState(
        if (pressed) StudyPalette.inset.copy(alpha = .62f) else Color.Transparent,
        if (LocalReduceMotion.current) snap() else tween(110),
        label = "settings-row-press",
    )
    Row(
        Modifier.fillMaxWidth()
            .then(
                if (onClick != null) Modifier.clickable(
                    interactionSource = source,
                    indication = null,
                    onClick = onClick,
                ) else Modifier,
            )
            .background(tint)
            .heightIn(min = 56.dp)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (letter != null) {
            Box(
                Modifier.size(34.dp).background(StudyPalette.sky, RoundedCornerShape(11.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(letter, color = StudyPalette.accent, fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif)
            }
            Spacer(Modifier.width(12.dp))
        } else if (icon != null) {
            GlassIconTile(icon, size = 34.dp)
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                color = StudyPalette.ink,
                fontSize = 16.sp,
                lineHeight = 21.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    color = StudyPalette.muted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (value != null) {
            Text(
                value,
                color = valueTint,
                fontSize = 12.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 158.dp),
            )
            Spacer(Modifier.width(4.dp))
        }
        if (trailing != null) trailing()
        if (showChevron && onClick != null) {
            Spacer(Modifier.width(2.dp))
            AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(13.dp), tint = StudyPalette.muted.copy(alpha = .72f))
        }
    }
}

@Composable
fun SettingsDivider() {
    Hairline(startIndent = 60.dp, endIndent = 14.dp, alpha = .5f)
}

@Composable
fun SettingsFootnote(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(horizontal = 4.dp),
        color = StudyPalette.muted,
        fontSize = 12.sp,
        lineHeight = 18.sp,
    )
}

@Composable
private fun ShellToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    enabled: Boolean = true,
    glyph: AstellaGlyphKind? = null,
    letter: String? = null,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (letter != null) {
            Box(
                Modifier.size(34.dp).background(StudyPalette.sky, RoundedCornerShape(11.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(letter, color = StudyPalette.accent, fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif)
            }
            Spacer(Modifier.width(12.dp))
        } else if (glyph != null) {
            GlassIconTile(glyph, size = 34.dp)
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = StudyPalette.ink, fontSize = 16.sp, lineHeight = 21.sp, fontWeight = FontWeight.Medium)
            Text(subtitle, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
        AstellaSwitch(checked = checked, enabled = enabled, onCheckedChange = onCheckedChange)
    }
}

/** 「设置」：外观与显示 / 伴星与隐私 / 资料与连接。 */
@Composable
fun SettingsScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    themeMode: String,
    onThemeMode: (String) -> Unit,
    onBack: () -> Unit,
    onReadSettings: () -> Unit,
    onPermissions: () -> Unit,
    onAiAuth: () -> Unit,
    onServerAddress: () -> Unit,
    onLibrary: () -> Unit,
) {
    val systemReduced = rememberSystemReducedMotion()
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("设置", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 10.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            StaggerReveal(0) {
                Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                    SectionLabel("外观与显示")
                    GlassSegment(
                        options = listOf("银白", "深空", "随日夜"),
                        selectedIndex = when (themeMode) { "dark" -> 1; "system" -> 2; else -> 0 },
                        modifier = Modifier.fillMaxWidth(),
                        height = 48.dp,
                        radius = 16.dp,
                        selectedFill = StudyPalette.sky,
                        onSelect = { onThemeMode(listOf("light", "dark", "system")[it]) },
                    )
                    SettingsGroup {
                        SettingsRow(null, "阅读设置", "字号、默认打开与动效", letter = "T", onClick = onReadSettings)
                        SettingsDivider()
                        ShellToggleRow(
                            title = "轻柔动效",
                            subtitle = if (systemReduced) "系统辅助功能已要求减少动效。" else "减少位移，留下安静的状态反馈",
                            checked = state.localReduceMotion || systemReduced,
                            enabled = !systemReduced,
                            glyph = AstellaGlyphKind.Companion,
                            onCheckedChange = viewModel::setLocalReduceMotion,
                        )
                    }
                }
            }
            StaggerReveal(1) {
                Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                    SectionLabel("伴星与隐私")
                    SettingsGroup {
                        SettingsRow(AstellaGlyphKind.Wave, "设备权限", "麦克风、相册、相机、文件与通知", onClick = onPermissions)
                        SettingsDivider()
                        SettingsRow(AstellaGlyphKind.Lock, "AI 授权与数据", "读取手记、上传材料与记录保存", onClick = onAiAuth)
                    }
                }
            }
            StaggerReveal(2) {
                Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                        SectionLabel("资料与连接")
                        SettingsGroup {
                            SettingsRow(AstellaGlyphKind.Library, "书房与手记", "手记、来源与导入进度", onClick = onLibrary)
                            SettingsDivider()
                            SettingsRow(AstellaGlyphKind.Document, "服务地址", "连接自建或私有部署", onClick = onServerAddress)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            "阅读字号、打开方式和动效偏好只保存在这台设备上。",
                            color = StudyPalette.muted,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                        )
                        Text(
                            "ASTELLA · 拾星笔记",
                            Modifier.fillMaxWidth().padding(top = 14.dp),
                            color = StudyPalette.muted.copy(alpha = .62f),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Medium,
                            letterSpacing = 2.4.sp,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

/** 「阅读与显示」：预览、字号滑杆、外观、默认打开、动效。 */
@Composable
fun ReadSettingsScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    themeMode: String,
    onThemeMode: (String) -> Unit,
    onBack: () -> Unit,
) {
    val sizeValue = (state.readingScale * 19f).coerceIn(15f, 25f)
    val sizeName = when {
        sizeValue <= 16f -> "小"
        sizeValue <= 18f -> "标准"
        sizeValue <= 21f -> "大"
        else -> "特大"
    }
    val systemReduced = rememberSystemReducedMotion()
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("阅读与显示", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 10.dp, bottom = 34.dp),
            verticalArrangement = Arrangement.spacedBy(26.dp),
        ) {
            StaggerReveal(0) {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text(
                        "这一页的改动保存在本机，不会同步到账号。",
                        color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
                    )
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(StudyRadius.xl))
                            .background(StudyPalette.paper)
                            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
                            .padding(horizontal = 22.dp, vertical = 28.dp),
                        verticalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        Text(
                            "清风徐来，水波不兴。举酒属客，诵明月之诗，歌窈窕之章。",
                            color = StudyPalette.readerInk,
                            fontFamily = FontFamily.Serif,
                            fontSize = sizeValue.sp,
                            lineHeight = (sizeValue * 1.9f).sp,
                            letterSpacing = .3.sp,
                        )
                        Hairline(alpha = .45f)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("A", color = StudyPalette.muted, fontSize = 13.sp, fontFamily = FontFamily.Serif)
                            ReadingSizeSlider(
                                value = sizeValue,
                                modifier = Modifier.weight(1f).padding(horizontal = 10.dp),
                                onValueChange = { value ->
                                    val scale = when {
                                        value <= 16.5f -> 1f
                                        value <= 21f -> 1.2f
                                        else -> 1.4f
                                    }
                                    viewModel.setReadingScale(scale)
                                },
                            )
                            Text("A", color = StudyPalette.muted, fontSize = 21.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.Serif)
                        }
                        Text(
                            "当前字号 · $sizeName（${sizeValue.toInt()}pt）",
                            Modifier.fillMaxWidth(),
                            color = StudyPalette.muted,
                            fontSize = 11.5.sp,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            StaggerReveal(1) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("外观")
                    GlassSegment(
                        options = listOf("银白", "深夜", "随系统"),
                        selectedIndex = when (themeMode) { "dark" -> 1; "system" -> 2; else -> 0 },
                        modifier = Modifier.fillMaxWidth(),
                        height = 48.dp,
                        radius = 16.dp,
                        selectedFill = StudyPalette.sky,
                        onSelect = { onThemeMode(listOf("light", "dark", "system")[it]) },
                    )
                    SettingsFootnote(
                        "当前：${
                            when (themeMode) { "dark" -> "深夜"; "system" -> "随系统"; else -> "银白" }
                        }。选择「随系统」时会跟随设备深浅色。",
                    )
                }
            }
            StaggerReveal(2) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("默认打开")
                    SettingsGroup {
                        SettingsRow(
                            AstellaGlyphKind.Eye,
                            "伴星场景",
                            "打开先见到她，安静陪伴",
                            showChevron = false,
                            onClick = { viewModel.setChatShowsRecords(false) },
                            trailing = {
                                if (!state.chatShowsRecords) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(17.dp), tint = StudyPalette.accent)
                            },
                        )
                        SettingsDivider()
                        SettingsRow(
                            null,
                            "记录场景",
                            "打开就到对话记录",
                            letter = "T",
                            showChevron = false,
                            onClick = { viewModel.setChatShowsRecords(true) },
                            trailing = {
                                if (state.chatShowsRecords) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(17.dp), tint = StudyPalette.accent)
                            },
                        )
                    }
                    SettingsFootnote("保存在本机，下次打开按这里的设置进入。")
                }
            }
            StaggerReveal(3) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("动效")
                    SettingsGroup {
                        ShellToggleRow(
                            title = "减少动效",
                            subtitle = "模型保持静止，粒子改为静态音量条",
                            checked = state.localReduceMotion || systemReduced,
                            enabled = !systemReduced,
                            onCheckedChange = viewModel::setLocalReduceMotion,
                        )
                    }
                    if (systemReduced) {
                        SettingsFootnote("系统已开启「减弱动态效果」，动效会被强制减少，与此处开关无关。")
                    }
                }
            }
        }
    }
}

/** 伴星说明气泡：34dp 圆头像 + 纸片气泡，和 iOS CompanionBubbleRow 一致。 */
@Composable
private fun CompanionIntroBubble(text: String, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(18.dp)
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Image(
            painterResource(com.astella.mobile.R.drawable.companion_avatar),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(34.dp).clip(CircleShape)
                .border(.8.dp, Color.White.copy(alpha = .85f), CircleShape),
        )
        Text(
            text,
            Modifier.weight(1f).padding(start = 10.dp)
                .shadow(
                    3.dp, shape, clip = false,
                    ambientColor = StudyPalette.ink.copy(alpha = .04f),
                    spotColor = StudyPalette.ink.copy(alpha = .04f),
                )
                .background(StudyPalette.paper.copy(alpha = .86f), shape)
                .border(.8.dp, Color.White.copy(alpha = .85f), shape)
                .padding(horizontal = 15.dp, vertical = 12.dp),
            color = StudyPalette.ink,
            fontSize = 14.sp,
            lineHeight = 20.sp,
        )
    }
}

/** 纸片次级按钮，用于「恢复默认」「取消」这类不抢主按钮重心的动作。 */
@Composable
private fun PaperActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: RoundedCornerShape = RoundedCornerShape(15.dp),
    minHeight: Dp = 46.dp,
) {
    AstellaTap(
        onClick,
        modifier.heightIn(min = minHeight)
            .background(StudyPalette.paper.copy(alpha = .86f), shape)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .6f), shape),
        enabled,
    ) {
        Text(
            text, Modifier.align(Alignment.Center),
            color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium,
        )
    }
}

/** 「设备权限」：读取真实运行时权限状态；未接入的能力如实说明。 */
private enum class PermissionState(val label: String) {
    Granted("已允许"), Unasked("未请求"), Denied("已拒绝"), NotNeeded("系统按次授权"), Unused("未使用"),
}

@Composable
fun PermissionsScreen(state: AppUiState, onBack: () -> Unit) {
    val context = LocalContext.current
    var micState by remember { mutableStateOf(permissionStateFor(context, Manifest.permission.RECORD_AUDIO)) }
    var notificationState by remember {
        mutableStateOf(
            if (android.os.Build.VERSION.SDK_INT >= 33) permissionStateFor(context, Manifest.permission.POST_NOTIFICATIONS)
            else PermissionState.Granted,
        )
    }
    val requestMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        micState = permissionStateFor(context, Manifest.permission.RECORD_AUDIO)
    }
    val requestNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationState = permissionStateFor(context, Manifest.permission.POST_NOTIFICATIONS)
    }
    fun openAppSettings() {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
    }
    val rows = listOf(
        Triple(AstellaGlyphKind.Wave, "麦克风", "语音随手记时录音") to micState,
        Triple(AstellaGlyphKind.Photo, "相册", "选择图片作为材料") to PermissionState.NotNeeded,
        Triple(AstellaGlyphKind.Camera, "相机", "当前版本没有拍摄入口") to PermissionState.Unused,
        Triple(AstellaGlyphKind.Book, "文件", "通过选择器导入 PDF 与文档") to PermissionState.NotNeeded,
        Triple(AstellaGlyphKind.Bell, "通知", "陪伴与学习提醒") to notificationState,
    )
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("设备权限", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 6.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Text(
                "系统权限只在对应功能需要时才会请求。照片和文件通过系统选择器按次授权，不会读取整个图库或文件夹。",
                color = StudyPalette.muted,
                fontSize = 13.sp,
                lineHeight = 20.sp,
            )
            CompanionIntroBubble("我需要其中几项才能陪你读书。关掉时，我会说明原因，也会给你别的办法。")
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("权限")
                SettingsGroup {
                    rows.forEachIndexed { index, pair ->
                        val (meta, status) = pair
                        if (index > 0) SettingsDivider()
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 58.dp)
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            GlassIconTile(meta.first, size = 34.dp)
                            Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(meta.second, color = StudyPalette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
                                Text(meta.third, color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 16.sp)
                            }
                            PermissionChip(status)
                            if (meta.first == AstellaGlyphKind.Wave || meta.first == AstellaGlyphKind.Bell) {
                                Spacer(Modifier.width(4.dp))
                                when {
                                    status == PermissionState.Granted -> QuietTextAction(
                                        "撤销", onClick = ::openAppSettings, modifier = Modifier.padding(start = 2.dp),
                                    )
                                    status == PermissionState.Denied -> QuietTextAction(
                                        "去设置", onClick = ::openAppSettings, modifier = Modifier.padding(start = 2.dp),
                                    )
                                    else -> QuietTextAction(
                                        if (meta.first == AstellaGlyphKind.Bell) "允许" else "请求",
                                        onClick = {
                                            if (meta.first == AstellaGlyphKind.Wave) requestMic.launch(Manifest.permission.RECORD_AUDIO)
                                            else requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                        },
                                        modifier = Modifier.padding(start = 2.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("被拒绝时怎么办")
                SettingsGroup {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("相机", color = StudyPalette.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                        Text("可以先用文件选择器选图片，之后再补拍。", color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
                    }
                    SettingsDivider()
                    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("通知", color = StudyPalette.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                        Text("仍会在应用内显示提醒，只是没有系统推送。", color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(StudyRadius.xl))
                    .background(StudyPalette.paper)
                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                PageEyebrow("伴星操作范围")
                Text("每次操作前说明并等待确认", color = StudyPalette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "伴星会说明下一步，再等你确认后执行；不可逆操作仍需单独确认。",
                    color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
                )
            }
        }
    }
}

@Composable
private fun PermissionChip(status: PermissionState) {
    val (fill, text) = when (status) {
        PermissionState.Granted -> StudyPalette.sky.copy(alpha = .72f) to StudyPalette.accent
        PermissionState.Denied -> StudyPalette.inset to Color(0xFFB76752)
        else -> StudyPalette.inset to StudyPalette.muted
    }
    Box(Modifier.background(fill, RoundedCornerShape(9.dp)).padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text(status.label, color = text, fontSize = 10.sp, fontWeight = FontWeight.Medium)
    }
}

private fun permissionStateFor(context: android.content.Context, permission: String): PermissionState = when {
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED -> PermissionState.Granted
    else -> PermissionState.Unasked
}

/** 「AI 使用授权与数据」：协议状态 + 四项数据偏好。 */
@Composable
fun AIAuthScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
    var policy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: com.astella.mobile.data.AIDataPolicy(false, false, true, true))
    }
    var savedPolicy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: com.astella.mobile.data.AIDataPolicy(false, false, true, true))
    }
    var consentAccepted by rememberSaveable { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings = state.aiSettings
    val signed = settings?.signed == true
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("AI 使用授权与数据", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 6.dp, bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            CompanionIntroBubble("你的手记只在你允许时才会交给我。下面每一项都可以单独关掉。")
            Column(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(StudyRadius.xl))
                    .background(if (signed) StudyPalette.sky.copy(alpha = .55f) else StudyPalette.paper)
                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = if (signed) .3f else .46f), RoundedCornerShape(StudyRadius.xl))
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (signed) "已签署 AI 使用授权" else "尚未签署 AI 使用授权",
                        Modifier.weight(1f),
                        color = StudyPalette.ink,
                        fontSize = 15.5.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (signed) {
                        Text(
                            "${settings?.consentVersion.orEmpty()}${settings?.consentAt?.take(10)?.let { " · $it" }.orEmpty()}",
                            color = StudyPalette.muted,
                            fontSize = 11.sp,
                            maxLines = 1,
                        )
                    }
                }
                Text(
                    if (signed) "读取你选择的手记，用于生成回应与摘要"
                    else "阅读与手记无需授权；开启后才会把内容交给伴星。",
                    color = if (signed) StudyPalette.ink else StudyPalette.muted,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                )
                if (!signed && settings?.requiresConsent == true) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                        androidx.compose.material3.Checkbox(
                            checked = consentAccepted,
                            onCheckedChange = { consentAccepted = it },
                            enabled = !state.isAccountBusy,
                        )
                        Text("我已阅读并同意《AI 使用协议》", color = StudyPalette.ink, fontSize = 12.5.sp)
                    }
                    AstellaButton(
                        onClick = viewModel::acceptAIConsent,
                        enabled = !state.isAccountBusy && consentAccepted,
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        shape = RoundedCornerShape(StudyRadius.lg),
                    ) { Text("同意并开启外部 AI") }
                }
            }
            state.accountError?.let {
                ShellNotice("没有保存成功", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
            }
            state.accountNotice?.let {
                ShellNotice("已更新", it, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success)
            }
            if (settings != null) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("授权项")
                    SettingsGroup {
                        PolicyRow(AstellaGlyphKind.Lock, "把选中的手记外发给模型", "关闭后伴星读不到手记内容；阅读与手记不受影响", policy.sendToExternal,
                            enabled = !state.isAccountBusy && (!settings.requiresConsent || signed)) { policy = policy.copy(sendToExternal = it) }
                        SettingsDivider()
                        PolicyRow(AstellaGlyphKind.Photo, "外发内容可包含图片", "关闭后图片只在本地处理，不进入模型", policy.sendImageContent) { policy = policy.copy(sendImageContent = it) }
                        SettingsDivider()
                        PolicyRow(AstellaGlyphKind.Shield, "外发前做个人信息检测", "命中时先提醒，可撤回再发送", policy.piiDetection) { policy = policy.copy(piiDetection = it) }
                        SettingsDivider()
                        PolicyRow(AstellaGlyphKind.Document, "记录 AI 调用审计日志", "供你自查调用记录", policy.auditLogging) { policy = policy.copy(auditLogging = it) }
                    }
                    AstellaButton(
                        onClick = { viewModel.saveAIDataPolicy(policy) },
                        enabled = !state.isAccountBusy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
                        shape = RoundedCornerShape(StudyRadius.lg),
                    ) { Text(if (state.isAccountBusy) "正在保存…" else "保存数据偏好") }
                }
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("数据与记录")
                    SettingsGroup {
                        SettingsRow(
                            AstellaGlyphKind.Book, "对话记录保存", "本地保留时长跟随服务策略",
                            value = "跟随服务", showChevron = false,
                        )
                        SettingsDivider()
                        SettingsRow(
                            AstellaGlyphKind.Document, "导出我的数据", "手记、批注与记忆导出为 JSON",
                            value = if (exporting) "正在整理…" else null,
                            onClick = {
                                if (!exporting) scope.launch {
                                    exporting = true
                                    try {
                                        shareExportedJson(context, viewModel.exportWorkspaceBackup("数据导出"))
                                    } catch (cause: Exception) {
                                        Toast.makeText(context, "数据导出没有完成：${cause.message ?: "请稍后重试。"}", Toast.LENGTH_LONG).show()
                                    } finally {
                                        exporting = false
                                    }
                                }
                            },
                        )
                    }
                }
                Text(
                    "以上为你的账号设置。阅读和手记不需要 AI 授权；关闭外发后，伴星回应会使用本地可用内容。",
                    color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
                )
            } else {
                SettingsFootnote("正在读取账号级 AI 设置…")
            }
        }
    }
}

@Composable
private fun PolicyRow(
    glyph: AstellaGlyphKind,
    title: String,
    detail: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 58.dp).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassIconTile(glyph, size = 34.dp)
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
            Text(detail, color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 17.sp)
        }
        AstellaSwitch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

/** 「服务地址」：自建服务的地址输入与保存（保存后重新登录）。 */
@Composable
fun ServerAddressScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
    var address by rememberSaveable(state.serviceAddress) { mutableStateOf(state.serviceAddress) }
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("服务地址", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                "仅用于连接自建或私有部署的服务。保存后会退出当前会话，需要重新登录。",
                color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 20.sp,
            )
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("服务地址", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                GlassInput(address, { address = it }, "https://", KeyboardType.Uri)
            }
            AstellaButton(
                onClick = { viewModel.updateServiceAddress(address) },
                enabled = address.isNotBlank() && address.trim().trimEnd('/') != state.serviceAddress,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(StudyRadius.lg),
            ) { Text("保存并重新登录") }
            Text(
                "当前生效：${if (state.serviceAddress.isBlank()) "默认（官方服务）" else state.serviceAddress}",
                color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
            )
            state.accountError?.let {
                ShellNotice("地址没有保存", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
            }
        }
    }
}

/** 「个人约定」：读写 /me/companion/participation，并用 revision 处理多端冲突。 */
@Composable
fun ConventionsScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
    var revision by rememberSaveable(state.profile?.userId) { mutableStateOf(0) }
    var enabled by rememberSaveable(state.profile?.userId) { mutableStateOf(true) }
    var markdown by rememberSaveable(state.profile?.userId) { mutableStateOf("") }
    var savedMarkdown by rememberSaveable(state.profile?.userId) { mutableStateOf("") }
    var loaded by rememberSaveable(state.profile?.userId) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var conflictLatestMarkdown by remember { mutableStateOf<String?>(null) }
    var conflictPending by remember { mutableStateOf(false) }
    var isAdding by remember { mutableStateOf(false) }
    var newConvention by remember { mutableStateOf("") }
    var showDefaults by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val conventions = markdown.split('\n').map(String::trim).filter(String::isNotEmpty)

    suspend fun load(preservingDraft: Boolean = false) {
        val localDraft = markdown
        busy = true; error = null
        try {
            val value = viewModel.requestApi("/me/companion/participation")
            val serverMarkdown = value.optString("markdown")
            revision = value.optInt("revision")
            enabled = value.optBoolean("enabled", true)
            savedMarkdown = serverMarkdown
            markdown = if (preservingDraft) localDraft else serverMarkdown
            conflictLatestMarkdown = if (preservingDraft) serverMarkdown else null
            conflictPending = false
            loaded = true
        } catch (cause: Throwable) {
            error = "个人约定没有同步成功：${cause.message ?: "请检查连接后重试。"}"
        }
        busy = false
    }

    suspend fun save(nextEnabled: Boolean = enabled) {
        busy = true; error = null; notice = null
        try {
            val value = viewModel.requestApi(
                "/me/companion/participation", "PUT",
                JSONObject().put("expectedRevision", revision).put("markdown", markdown).put("enabled", nextEnabled),
            )
            revision = value.optInt("revision", revision + 1)
            enabled = value.optBoolean("enabled", nextEnabled)
            markdown = value.optString("markdown", markdown)
            savedMarkdown = markdown
            conflictLatestMarkdown = null
            conflictPending = false
            notice = if (enabled) "个人约定已保存并生效。" else "个人约定已暂停，默认陪伴方式仍会生效。"
        } catch (cause: Throwable) {
            conflictPending = (cause as? com.astella.mobile.data.ApiFailure)?.status == 409
            error = if (conflictPending) "另一台设备刚改过约定。读取最新版本时会保留你的草稿，核对并合并后再保存。"
            else "这次没有保存成功，编辑内容还在。${cause.message ?: "请检查连接后重试。"}"
        }
        busy = false
    }

    LaunchedEffect(state.profile?.userId) { load() }
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("个人约定", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            CompanionIntroBubble(
                "这是我们之间的约定，我会在每次对话做记录。" +
                    if (!enabled && loaded) "（当前已暂停：约定不会生效，但不会丢失。）" else "",
            )
            if (!loaded && busy) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
                    Text("正在读取个人约定…", Modifier.padding(start = 8.dp), color = StudyPalette.muted, fontSize = 12.5.sp)
                }
            } else {
                SettingsGroup {
                    ShellToggleRow(
                        title = "让约定生效",
                        subtitle = "暂停后这些约定不会影响伴星的回应",
                        checked = enabled,
                        enabled = !busy,
                        onCheckedChange = { scope.launch { save(it) } },
                    )
                }
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("我的约定")
                    SettingsGroup {
                        if (conventions.isEmpty()) {
                            Text(
                                "还没有个人约定。添加一条，或继续使用默认陪伴方式。",
                                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 18.dp),
                                color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 20.sp,
                            )
                        } else {
                            conventions.forEachIndexed { index, convention ->
                                Row(
                                    Modifier.fillMaxWidth().padding(start = 14.dp, end = 10.dp, top = 13.dp, bottom = 13.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(convention, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 23.sp)
                                    if (index >= 0) Spacer(Modifier.width(8.dp))
                                    AstellaTap(
                                        onClick = {
                                            val next = conventions.toMutableList().also { it.removeAt(index) }
                                            markdown = next.joinToString("\n")
                                            notice = null
                                            scope.launch { save() }
                                        },
                                        modifier = Modifier.size(30.dp)
                                            .background(StudyPalette.inset.copy(alpha = .9f), CircleShape),
                                        enabled = !busy && enabled,
                                    ) {
                                        AstellaGlyph(
                                            AstellaGlyphKind.Close,
                                            Modifier.align(Alignment.Center).size(12.dp),
                                            tint = StudyPalette.muted,
                                        )
                                    }
                                }
                                if (index < conventions.lastIndex) SettingsDivider()
                            }
                        }
                    }
                }
                AnimatedVisibility(
                    visible = isAdding,
                    enter = if (LocalReduceMotion.current) fadeIn(tween(1)) else expandVertically(MotionTokens.routePush()) + fadeIn(tween(160)),
                    exit = if (LocalReduceMotion.current) fadeOut(tween(1)) else shrinkVertically(MotionTokens.routePush()) + fadeOut(tween(120)),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(StudyRadius.lg))
                                .background(StudyPalette.paper)
                                .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(StudyRadius.lg))
                                .padding(14.dp),
                        ) {
                            BasicTextField(
                                value = newConvention,
                                onValueChange = { newConvention = it },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                                enabled = !busy,
                                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, lineHeight = 22.sp, color = StudyPalette.ink),
                                cursorBrush = SolidColor(StudyPalette.accent),
                                decorationBox = { inner ->
                                    if (newConvention.isEmpty()) Text(
                                        "写下你希望她怎样陪你学习", color = StudyPalette.muted, fontSize = 15.sp,
                                    )
                                    inner()
                                },
                            )
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            PaperActionButton(
                                "取消",
                                onClick = { isAdding = false; newConvention = "" },
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(StudyRadius.md),
                                minHeight = 46.dp,
                            )
                            AstellaButton(
                                onClick = {
                                    val text = newConvention.trim()
                                    if (text.isNotEmpty()) {
                                        markdown = (conventions + text).joinToString("\n")
                                        newConvention = ""
                                        isAdding = false
                                        scope.launch { save() }
                                    }
                                },
                                enabled = !busy && newConvention.trim().isNotEmpty(),
                                modifier = Modifier.weight(1f).heightIn(min = 46.dp),
                                shape = RoundedCornerShape(StudyRadius.md),
                            ) { Text("保存这条约定", fontSize = 14.sp) }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PaperActionButton(
                        "恢复默认",
                        onClick = {
                            markdown = ""
                            notice = null
                            scope.launch { save() }
                        },
                        enabled = !busy && loaded,
                        modifier = Modifier.weight(1f),
                    )
                    AstellaButton(
                        onClick = { isAdding = true },
                        enabled = !busy && loaded && enabled,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        shape = RoundedCornerShape(StudyRadius.lg),
                    ) { Text("添加约定", fontSize = 14.sp) }
                }
                Text(
                    when {
                        conventions.isEmpty() -> "尚未添加个人约定，默认陪伴方式会照常生效。"
                        enabled -> "个人约定正在生效。"
                        else -> "个人约定已暂停，默认陪伴方式仍会生效。"
                    },
                    color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
                )
                val defaultsRotation by animateFloatAsState(
                    if (showDefaults) 90f else 0f,
                    if (LocalReduceMotion.current) snap() else MotionTokens.press(),
                    label = "defaults-chevron",
                )
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 40.dp)
                        .clickable { showDefaults = !showDefaults }
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("默认陪伴方式", Modifier.weight(1f), color = StudyPalette.accent, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    AstellaGlyph(
                        AstellaGlyphKind.Chevron,
                        Modifier.size(14.dp).graphicsLayer { rotationZ = defaultsRotation },
                        tint = StudyPalette.accent,
                    )
                }
                AnimatedVisibility(
                    visible = showDefaults,
                    enter = if (LocalReduceMotion.current) fadeIn(tween(1)) else expandVertically(MotionTokens.routePush()) + fadeIn(tween(140)),
                    exit = if (LocalReduceMotion.current) fadeOut(tween(1)) else shrinkVertically(MotionTokens.routePush()) + fadeOut(tween(100)),
                ) {
                    Text(
                        "页面帮助、自然分句、主动问候与久学休息会根据你实际在看的内容和相处偏好判断是否出现。",
                        color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp,
                    )
                }
            }
            error?.let { message ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ShellNotice(
                        if (conflictPending) "约定已在别处更新" else "没有保存成功",
                        message,
                        glyph = AstellaGlyphKind.Alert,
                        tint = StudyPalette.danger,
                        actionLabel = if (conflictPending) "读取新版" else "重试",
                        onAction = { scope.launch { load(preservingDraft = conflictPending) } },
                    )
                }
            }
            conflictLatestMarkdown?.let { latest ->
                Column(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(StudyRadius.lg))
                        .background(StudyPalette.inset.copy(alpha = .62f))
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text("另一台设备保存的版本", color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    SelectionContainer { Text(latest.ifEmpty { "（云端约定为空）" }, color = StudyPalette.ink, fontSize = 12.5.sp, lineHeight = 19.sp) }
                    Text("上方输入框仍保留你的草稿。合并需要的内容后，保存会以草稿作为最新版本。", color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 17.sp)
                    QuietTextAction(
                        "用另一台设备的版本替换草稿",
                        onClick = { markdown = latest; conflictLatestMarkdown = null },
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
            notice?.let {
                ShellNotice("个人约定", it, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success)
            }
        }
    }
}

/** 「个人资料」：称呼、头像、邮箱。 */
@Composable
fun ProfileScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onLibrary: () -> Unit = {},
) {
    var displayName by rememberSaveable(state.profile?.displayName) { mutableStateOf(state.profile?.displayName.orEmpty()) }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let(viewModel::saveAvatar)
    }
    var avatarBitmap by remember(state.profile?.avatarUrl) { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(state.profile?.avatarUrl) {
        val address = state.profile?.avatarUrl ?: return@LaunchedEffect
        avatarBitmap = runCatching {
            viewModel.imageBytes(address)?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) }
        }.getOrNull()
    }
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("个人资料", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(21.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                AstellaTap(
                    { avatarPicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    Modifier.size(74.dp),
                    enabled = !state.isAccountBusy,
                ) {
                    Box(Modifier.align(Alignment.Center).fillMaxSize().clip(CircleShape)) {
                        if (avatarBitmap != null) {
                            androidx.compose.foundation.Image(
                                avatarBitmap!!.asImageBitmap(),
                                "账户头像",
                                Modifier.fillMaxSize(),
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                            )
                        } else {
                            androidx.compose.foundation.Image(
                                androidx.compose.ui.res.painterResource(com.astella.mobile.R.drawable.companion_avatar),
                                null,
                                Modifier.fillMaxSize(),
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                            )
                        }
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(26.dp)
                                .background(StudyPalette.accent, CircleShape)
                                .border(2.dp, StudyPalette.canvas, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            AstellaGlyph(AstellaGlyphKind.Camera, Modifier.size(13.dp), tint = Color.White)
                        }
                    }
                }
                Row(
                    Modifier.weight(1f).padding(start = 17.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        BasicTextField(
                            value = displayName,
                            onValueChange = { displayName = it.take(12) },
                            modifier = Modifier.fillMaxWidth(),
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 20.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = StudyPalette.ink,
                            ),
                            singleLine = true,
                            cursorBrush = SolidColor(StudyPalette.accent),
                            decorationBox = { inner ->
                                Box {
                                    if (displayName.isEmpty()) Text(
                                        "你的昵称", color = StudyPalette.muted,
                                        fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                                    )
                                    inner()
                                }
                            },
                        )
                        Text(
                            "相伴 · ${state.profile?.workspaceName ?: "我的书房"}",
                            color = StudyPalette.muted, fontSize = 12.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    AstellaTap(
                        onClick = { viewModel.saveProfile(displayName) },
                        modifier = Modifier.padding(start = 8.dp).size(width = 54.dp, height = 38.dp)
                            .background(
                                if (!state.isAccountBusy && displayName.trim() != state.profile?.displayName.orEmpty())
                                    StudyPalette.accent else StudyPalette.accent.copy(alpha = .42f),
                                RoundedCornerShape(14.dp),
                            ),
                        enabled = !state.isAccountBusy && displayName.trim() != state.profile?.displayName.orEmpty(),
                    ) {
                        if (state.isAccountBusy) CircularProgressIndicator(
                            Modifier.align(Alignment.Center).size(15.dp), color = Color.White, strokeWidth = 2.dp,
                        ) else Text(
                            "保存",
                            Modifier.align(Alignment.Center),
                            color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
            Text("点头像可以更换，改好名字点保存。", color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
            state.accountError?.let {
                ShellNotice("没有保存成功", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
            }
            state.accountNotice?.let {
                ShellNotice("已更新", it, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success)
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("账号")
                SettingsGroup {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 14.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("邮箱", color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            Text("用于登录与找回密码", color = StudyPalette.muted, fontSize = 11.5.sp)
                        }
                        Text(
                            state.profile?.email.orEmpty(),
                            color = StudyPalette.muted, fontSize = 12.5.sp,
                            textAlign = TextAlign.End,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 190.dp),
                        )
                    }
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Library, "我的书房", "${state.notes.size} 份手记",
                        onClick = onLibrary,
                    )
                }
            }
            val logoutSource = remember { MutableInteractionSource() }
            val logoutPressed by logoutSource.collectIsPressedAsState()
            val logoutTint by animateColorAsState(
                if (logoutPressed) StudyPalette.danger.copy(alpha = .08f) else Color.Transparent,
                if (LocalReduceMotion.current) snap() else tween(110),
                label = "logout-press",
            )
            Row(
                Modifier.fillMaxWidth().heightIn(min = 54.dp)
                    .clip(RoundedCornerShape(StudyRadius.xl))
                    .background(logoutTint)
                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(StudyRadius.xl))
                    .clickable(interactionSource = logoutSource, indication = null) { viewModel.logout() },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                AstellaGlyph(AstellaGlyphKind.Logout, Modifier.size(16.dp), tint = StudyPalette.danger)
                Text("退出登录", Modifier.padding(start = 8.dp), color = StudyPalette.danger, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
            Text(
                "ASTELLA · 拾星笔记",
                Modifier.fillMaxWidth().padding(top = 8.dp),
                color = StudyPalette.muted.copy(alpha = .6f), fontSize = 9.5.sp, fontWeight = FontWeight.Medium,
                letterSpacing = 2.2.sp, textAlign = TextAlign.Center,
            )
        }
    }
}

/** 玻璃输入框（设计稿 field）：白色近玻璃底、聚焦蓝色细边。 */
@Composable
fun GlassInput(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    modifier: Modifier = Modifier,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    BasicTextField(
        value,
        onValueChange,
        modifier.fillMaxWidth().heightIn(min = 52.dp).astellaGlass(StudyRadius.lg).padding(horizontal = 16.dp, vertical = 15.dp),
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.5.sp, color = StudyPalette.ink),
        cursorBrush = SolidColor(StudyPalette.accent),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, color = StudyPalette.muted, fontSize = 15.5.sp)
                inner()
            }
        },
    )
}

/** 「修改密码」：邮箱验证码 + 新密码，保持真实重置链路。 */
@Composable
fun PasswordChangeScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
    val email = state.profile?.email.orEmpty()
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    var confirmationVisible by remember { mutableStateOf(false) }
    var resendSeconds by rememberSaveable { mutableStateOf(0) }
    var codeRequested by rememberSaveable { mutableStateOf(false) }
    var completed by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.clearAuthFeedback() }
    LaunchedEffect(resendSeconds) {
        if (resendSeconds > 0) {
            delay(1_000)
            resendSeconds -= 1
        }
    }

    val canSave = code.length == 6 && password.length in 8..200 && confirmation == password && !state.isLoading
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("修改密码", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                "通过登录邮箱验证码确认身份。密码内容仅在提交时发送。",
                color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
            )
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("登录邮箱", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Box(Modifier.fillMaxWidth().astellaGlass(StudyRadius.lg).padding(horizontal = 16.dp, vertical = 15.dp)) {
                    Text(email, color = StudyPalette.ink, fontSize = 15.5.sp)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("邮箱验证码", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        GlassInput(code, { code = it.filter(Char::isDigit).take(6) }, "输入 6 位验证码", KeyboardType.Number)
                    }
                    Spacer(Modifier.width(10.dp))
                    AstellaOutlinedButton(
                        onClick = {
                            viewModel.sendEmailCode(email, "reset_password") { seconds ->
                                codeRequested = true
                                resendSeconds = seconds
                            }
                        },
                        enabled = email.isNotBlank() && resendSeconds == 0 && !state.isLoading,
                        modifier = Modifier.height(52.dp),
                    ) {
                        Text(if (resendSeconds > 0) "${resendSeconds}s" else if (codeRequested) "重新发送" else "发送验证码", fontSize = 12.sp)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("新密码", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        GlassInput(password, { password = it.take(200) }, "8–200 位", KeyboardType.Password, visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation())
                    }
                    AstellaIconButton(onClick = { passwordVisible = !passwordVisible }, modifier = Modifier.size(44.dp)) {
                        AstellaGlyph(if (passwordVisible) AstellaGlyphKind.EyeSlash else AstellaGlyphKind.Eye, Modifier.size(18.dp), tint = StudyPalette.muted)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("确认新密码", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        GlassInput(confirmation, { confirmation = it.take(200) }, "再输入一次", KeyboardType.Password, visualTransformation = if (confirmationVisible) VisualTransformation.None else PasswordVisualTransformation())
                    }
                    AstellaIconButton(onClick = { confirmationVisible = !confirmationVisible }, modifier = Modifier.size(44.dp)) {
                        AstellaGlyph(if (confirmationVisible) AstellaGlyphKind.EyeSlash else AstellaGlyphKind.Eye, Modifier.size(18.dp), tint = StudyPalette.muted)
                    }
                }
            }
            if (password.isNotEmpty() && password.length < 8) {
                Text("新密码至少需要 8 位。", color = StudyPalette.danger, fontSize = 11.sp)
            }
            if (confirmation.isNotEmpty() && confirmation != password) {
                Text("两次输入的密码不一致。", color = StudyPalette.danger, fontSize = 11.sp)
            }
            state.authError?.let {
                ShellNotice("没有修改成功", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
            }
            if (completed) {
                ShellNotice("密码已更新", "你可以继续使用新密码登录其他设备。", glyph = AstellaGlyphKind.Check, tint = StudyPalette.success)
            } else {
                AstellaButton(
                    enabled = canSave,
                    onClick = { viewModel.resetPassword(email, code, password) { completed = true } },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.isLoading) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                    Text("保存新密码", Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

/** 「伴星中心」：英雄卡、最近交流、记忆与日记入口，再进伴星配置。 */
@Composable
fun CompanionCenterScreen(
    state: AppUiState,
    onBack: () -> Unit,
    onConversation: (records: Boolean) -> Unit,
    onConfig: () -> Unit,
    onMemory: () -> Unit,
    onDiary: () -> Unit,
) {
    val isResponding = state.streamingText.isNotEmpty() || state.isSending
    val latest = state.streamingText.ifEmpty { state.messages.lastOrNull { it.role == "assistant" }?.displayText.orEmpty() }
    val heroShape = RoundedCornerShape(StudyRadius.xxl)
    val statusText = if (isResponding) "正在回应" else if (state.realtimeStatus == "已连接") "语音交流已连接" else "随时可以继续交流"
    val statusColor = if (isResponding) StudyPalette.accent else if (state.realtimeStatus == "已连接") StudyPalette.success else StudyPalette.muted
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("伴星中心", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            StaggerReveal(0) {
                Box(
                    Modifier.fillMaxWidth().height(148.dp)
                        .shadow(
                            7.dp, heroShape, clip = false,
                            ambientColor = StudyPalette.ink.copy(alpha = .05f),
                            spotColor = StudyPalette.ink.copy(alpha = .05f),
                        )
                        .clip(heroShape)
                        .background(
                            Brush.linearGradient(
                                listOf(
                                    StudyPalette.sky.copy(alpha = .95f),
                                    StudyPalette.paper.copy(alpha = .9f),
                                ),
                            ),
                            heroShape,
                        )
                        .border(.8.dp, Color.White.copy(alpha = .8f), heroShape),
                ) {
                    Box(
                        Modifier.align(Alignment.CenterEnd).offset(x = 34.dp, y = 46.dp).size(150.dp)
                            .background(StudyPalette.accent.copy(alpha = .07f), CircleShape),
                    )
                    Image(
                        painterResource(com.astella.mobile.R.drawable.companion_stage),
                        contentDescription = null,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(end = 4.dp)
                            .offset(y = (-2).dp).width(128.dp).height(142.dp),
                    )
                    Column(
                        Modifier.fillMaxWidth().padding(start = 20.dp, top = 17.dp, end = 126.dp, bottom = 17.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        PageEyebrow("拾星 · ASTELLA")
                        Text(
                            "伴星", color = StudyPalette.ink, fontSize = 27.sp, lineHeight = 32.sp,
                            fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                            Box(Modifier.size(6.dp).background(statusColor, CircleShape))
                            Text(
                                statusText, Modifier.padding(start = 6.dp),
                                color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 16.sp,
                                fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            state.profile?.workspaceName ?: "和你一起读，也一起想",
                            color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 16.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            StaggerReveal(1) {
                Column(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(StudyRadius.xl))
                        .background(StudyPalette.paper)
                        .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (isResponding) "此刻的交流" else "最近一次交流",
                            Modifier.weight(1f),
                            color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                            letterSpacing = .4.sp,
                        )
                        if (isResponding) CircularProgressIndicator(Modifier.size(14.dp), color = StudyPalette.accent, strokeWidth = 1.8.dp)
                    }
                    if (latest.isNotBlank()) {
                        CompanionMarkdownText(
                            latest, Modifier.fillMaxWidth(),
                            color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 24.sp,
                            maxLines = 4, overflow = TextOverflow.Ellipsis,
                        )
                    } else {
                        Text(
                            "还没有新的交流。想读什么、想到什么，都可以从这里继续。",
                            color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 22.sp,
                        )
                    }
                    Hairline(alpha = .5f)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AstellaTap(
                            onClick = { onConversation(false) },
                            modifier = Modifier.weight(1f).heightIn(min = 44.dp)
                                .background(StudyPalette.actionFill, CircleShape),
                        ) {
                            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                AstellaGlyph(AstellaGlyphKind.Chat, Modifier.size(15.dp), tint = Color.White)
                                Text("继续对话", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        AstellaTap(
                            onClick = { onConversation(true) },
                            modifier = Modifier.heightIn(min = 44.dp)
                                .background(StudyPalette.sky.copy(alpha = .82f), CircleShape)
                                .padding(horizontal = 13.dp),
                        ) {
                            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(14.dp), tint = StudyPalette.accent)
                                Text("完整记录", color = StudyPalette.accent, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            }
                        }
                    }
                }
            }
            StaggerReveal(2) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ShellSectionHeader("记忆与日记", meta = "相伴留下的记录")
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CompanionShortcutCard(
                            AstellaGlyphKind.Companion, "她记得的事", "查看与修正",
                            Modifier.weight(1f), onMemory,
                        )
                        CompanionShortcutCard(
                            AstellaGlyphKind.Orbit, "我们的日记", "回看相伴片段",
                            Modifier.weight(1f), onDiary,
                        )
                    }
                }
            }
            StaggerReveal(3) {
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Companion, "伴星配置", "相处偏好与交流方式", onClick = onConfig)
                }
            }
        }
    }
}

@Composable
private fun CompanionShortcutCard(
    kind: AstellaGlyphKind,
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    AstellaTap(
        onClick,
        modifier.heightIn(min = 104.dp)
            .clip(RoundedCornerShape(StudyRadius.lg))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.lg))
            .padding(horizontal = 14.dp),
    ) {
        Column(Modifier.align(Alignment.CenterStart), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Box(
                Modifier.size(36.dp).background(StudyPalette.sky.copy(alpha = .82f), RoundedCornerShape(11.dp)),
                contentAlignment = Alignment.Center,
            ) {
                AstellaGlyph(kind, Modifier.size(18.dp), tint = StudyPalette.accent)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, color = StudyPalette.ink, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(detail, color = StudyPalette.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
fun CompanionSettingsScreen(
    state: AppUiState,
    onBack: () -> Unit,
    onConventions: () -> Unit = {},
    onProfile: () -> Unit = {},
    onMemory: () -> Unit = {},
) {
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("伴星配置", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 10.dp, bottom = 36.dp),
            verticalArrangement = Arrangement.spacedBy(26.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("表达设定")
                SettingsGroup {
                    SettingsRow(
                        null,
                        "名字",
                        "她这样称呼你",
                        value = state.profile?.displayName?.ifBlank { state.profile?.email?.substringBefore('@').orEmpty() } ?: "拾星同学",
                        onClick = onProfile,
                    )
                    SettingsDivider()
                    SettingsRow(null, "说话风格", "会参考个人约定与当前语境", value = "随对话调整", showChevron = false)
                    SettingsDivider()
                    SettingsRow(null, "讲解分量", "结合问题和阅读内容调整深浅", value = "自动", showChevron = false)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("相处方式")
                SettingsGroup {
                    SettingsRow(null, "相处偏好", "补充相处节奏和表达方式", onClick = onConventions)
                    SettingsDivider()
                    SettingsRow(null, "她记得的事", "查看、核对与修正伴星记忆", onClick = onMemory)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("声音与语音")
                SettingsGroup {
                    SettingsRow(
                        null,
                        "实时语音交流",
                        "从相伴页的麦克风开始，不转写文字",
                        showChevron = false,
                    )
                    SettingsDivider()
                    SettingsRow(
                        null,
                        "朗读回复",
                        "移动端当前尚未接入播放",
                        value = if (state.isPlaying) "播放中" else "未启用",
                        showChevron = false,
                    )
                }
            }
        }
    }
}

/** 设计稿字号滑杆：细轨 + 白色圆钮，不使用 M3 的刻度点与竖条拇指。 */
@Composable
private fun ReadingSizeSlider(value: Float, modifier: Modifier = Modifier, onValueChange: (Float) -> Unit) {
    val min = 15f
    val max = 25f
    BoxWithConstraints(modifier.height(40.dp)) {
        val inset = 12.dp
        val density = LocalDensity.current
        val insetPx = with(density) { inset.toPx() }
        val usablePx = with(density) { (maxWidth - inset * 2).toPx() }
        val fraction = ((value - min) / (max - min)).coerceIn(0f, 1f)
        val edgeColor = StudyPalette.paperEdge
        val accentColor = StudyPalette.accent
        val update: (Float) -> Unit = { x ->
            val ratio = ((x - insetPx) / usablePx.coerceAtLeast(1f)).coerceIn(0f, 1f)
            onValueChange(min + ratio * (max - min))
        }
        Canvas(
            Modifier.fillMaxSize()
                .pointerInput(usablePx) {
                    detectTapGestures { offset -> update(offset.x) }
                }
                .pointerInput(usablePx) {
                    detectHorizontalDragGestures { change, _ -> update(change.position.x); change.consume() }
                },
        ) {
            val centerY = size.height / 2f
            val stroke = 4.dp.toPx()
            val start = insetPx
            val end = size.width - insetPx
            drawLine(edgeColor, androidx.compose.ui.geometry.Offset(start, centerY), androidx.compose.ui.geometry.Offset(end, centerY), stroke, StrokeCap.Round)
            val activeEnd = start + (end - start) * fraction
            drawLine(accentColor.copy(alpha = .72f), androidx.compose.ui.geometry.Offset(start, centerY), androidx.compose.ui.geometry.Offset(activeEnd, centerY), stroke, StrokeCap.Round)
            drawCircle(Color.White, radius = 10.dp.toPx(), center = androidx.compose.ui.geometry.Offset(activeEnd, centerY))
            drawCircle(Color.White.copy(alpha = .9f), radius = 10.dp.toPx(), center = androidx.compose.ui.geometry.Offset(activeEnd, centerY), style = Stroke(1.dp.toPx()))
        }
    }
}
