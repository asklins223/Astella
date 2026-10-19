package com.astella.mobile.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import com.astella.mobile.ui.design.CompanionPortrait
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.GlassIconTile
import com.astella.mobile.ui.design.GlassSegment
import com.astella.mobile.ui.design.NoticeSurface
import com.astella.mobile.ui.design.SectionLabel
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.astellaGlass
import com.astella.mobile.ui.design.rememberSystemReducedMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** 设计稿内页头：44dp 返回玻璃圆 + 31–34 大标题，右侧可带一个动作。 */
@Composable
fun SettingsPageHeader(
    title: String,
    onBack: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassCircleButton(
            onClick = onBack,
            size = 44.dp,
            modifier = Modifier.semantics { contentDescription = "返回" },
        ) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(20.dp), tint = StudyPalette.ink)
        }
        Spacer(Modifier.width(14.dp))
        Text(
            title,
            Modifier.weight(1f),
            color = StudyPalette.ink,
            fontSize = 32.sp,
            lineHeight = 38.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-1).sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        trailing?.invoke()
    }
}

@Composable
fun SettingsGroup(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(24.dp).padding(vertical = 4.dp),
        content = content,
    )
}

/** 设置行：36dp 圆角图标底 + 17/600 标题 + 11 说明 + 可选值 + chevron。 */
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
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (letter != null) {
            Box(
                Modifier.size(36.dp).background(StudyPalette.sky, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(letter, color = StudyPalette.accent, fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Serif)
            }
            Spacer(Modifier.width(13.dp))
        } else if (icon != null) {
            GlassIconTile(icon, size = 36.dp)
            Spacer(Modifier.width(13.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                title,
                color = StudyPalette.ink,
                fontSize = 16.sp,
                lineHeight = 21.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    color = StudyPalette.muted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (value != null) {
            Text(
                value,
                color = valueTint,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 168.dp),
            )
            Spacer(Modifier.width(4.dp))
        }
        if (trailing != null) trailing()
        if (showChevron && onClick != null) {
            AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(15.dp), tint = Color(0xFFA1B3CE))
        }
    }
}

@Composable
fun SettingsDivider() {
    HorizontalDivider(
        Modifier.padding(start = 63.dp, end = 14.dp),
        color = StudyPalette.paperEdge.copy(alpha = .60f),
    )
}

@Composable
fun SettingsFootnote(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(horizontal = 6.dp),
        color = StudyPalette.muted,
        fontSize = 11.sp,
        lineHeight = 17.sp,
    )
}

/** 「设置」：外观与显示 / 伴星与隐私 / 资料与连接 / 关于。 */
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
    onProfile: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("设置", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 6.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("外观与显示")
                GlassSegment(
                    options = listOf("银白", "深空", "随日夜"),
                    selectedIndex = when (themeMode) { "dark" -> 1; "system" -> 2; else -> 0 },
                    modifier = Modifier.fillMaxWidth(),
                    height = 44.dp,
                    radius = 22.dp,
                    onSelect = { onThemeMode(listOf("light", "dark", "system")[it]) },
                )
                SettingsGroup {
                    SettingsRow(null, "阅读设置", "字号、默认打开与动效", letter = "T", onClick = onReadSettings)
                    SettingsDivider()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text("轻柔动效", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                            Text(
                                if (state.localReduceMotion) "页面位移已减少，保留状态反馈" else "减少位移，留下安静的状态反馈",
                                color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp,
                            )
                        }
                        AstellaSwitch(checked = state.localReduceMotion, onCheckedChange = viewModel::setLocalReduceMotion)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("伴星与隐私")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Wave, "设备权限", "麦克风、相册、相机、文件与通知", onClick = onPermissions)
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Lock, "AI 授权与数据", "读取手记、上传材料与记录保存", onClick = onAiAuth)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("资料与连接")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Person, "个人资料", "称呼、头像与邮箱", onClick = onProfile)
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Clock,
                        "服务地址",
                        if (state.serviceAddress.isBlank()) "默认（官方服务）" else state.serviceAddress,
                        onClick = onServerAddress,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("关于这一小片宇宙")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Info, "关于拾星", "版本 0.1.0 · 相伴与阅读", showChevron = false)
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Shield,
                        "连接状态",
                        if (state.realtimeStatus == "已连接") "实时通道已连接" else state.realtimeStatus,
                        showChevron = false,
                    )
                }
            }
            Text(
                "ASTELLA · 拾星笔记",
                Modifier.fillMaxWidth().padding(top = 12.dp),
                color = StudyPalette.muted,
                fontSize = 10.sp,
                letterSpacing = 2.sp,
                textAlign = TextAlign.Center,
            )
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
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            SettingsFootnote("这一页的改动保存在本机（这台设备），不会同步到账号。")
            Box(Modifier.fillMaxWidth().astellaGlass(24.dp).padding(horizontal = 18.dp, vertical = 20.dp)) {
                Text(
                    "清风徐来，水波不兴。举酒属客，诵明月之诗，歌窈窕之章。",
                    color = StudyPalette.ink,
                    fontFamily = FontFamily.Serif,
                    fontSize = sizeValue.sp,
                    lineHeight = (sizeValue * 2f).sp,
                    letterSpacing = .4.sp,
                )
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("A", color = StudyPalette.muted, fontSize = 13.sp)
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
                Text("A", color = StudyPalette.muted, fontSize = 20.sp)
            }
            Text(
                "当前：$sizeName（${sizeValue.toInt()}pt）",
                Modifier.fillMaxWidth(),
                color = StudyPalette.muted,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
            )
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("外观")
                GlassSegment(
                    options = listOf("银白", "深夜", "随系统"),
                    selectedIndex = when (themeMode) { "dark" -> 1; "system" -> 2; else -> 0 },
                    modifier = Modifier.fillMaxWidth(),
                    height = 44.dp,
                    radius = 22.dp,
                    onSelect = { onThemeMode(listOf("light", "dark", "system")[it]) },
                )
                SettingsFootnote(
                    "当前：${
                        when (themeMode) { "dark" -> "深夜"; "system" -> "随系统"; else -> "银白" }
                    }。选择「随系统」时会跟随设备深浅色。",
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
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
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("动效")
                SettingsGroup {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text("减少动效", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                            Text("模型保持静止，粒子改为静态音量条", color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp)
                        }
                        AstellaSwitch(
                            checked = state.localReduceMotion || systemReduced,
                            enabled = !systemReduced,
                            onCheckedChange = viewModel::setLocalReduceMotion,
                        )
                    }
                }
                if (systemReduced) {
                    SettingsFootnote("系统已开启「减弱动态效果」，动效会被强制减少，与此处开关无关。")
                }
            }
        }
    }
}

/** 「设备权限」：读取真实运行时权限状态；未接入的能力如实说明。 */
private enum class PermissionState(val label: String) {
    Granted("已允许"), Unasked("未请求"), Denied("已拒绝"), NotNeeded("无需授权"), Unused("未启用"),
}

@Composable
fun PermissionsScreen(state: AppUiState, onBack: () -> Unit) {
    val context = LocalContext.current
    var micState by remember { mutableStateOf(permissionStateFor(context, Manifest.permission.RECORD_AUDIO)) }
    val requestMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        micState = permissionStateFor(context, Manifest.permission.RECORD_AUDIO)
    }
    val rows = listOf(
        Triple(AstellaGlyphKind.Wave, "麦克风", "语音随手记时录音") to micState,
        Triple(AstellaGlyphKind.Photo, "相册", "选择图片作为材料") to PermissionState.NotNeeded,
        Triple(AstellaGlyphKind.Camera, "相机", "拍摄板书与页面") to PermissionState.Unused,
        Triple(AstellaGlyphKind.Book, "文件", "导入 PDF 与文档") to PermissionState.NotNeeded,
        Triple(AstellaGlyphKind.Bell, "通知", "复习与陪伴提醒") to PermissionState.Unused,
    )
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("设备权限", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().astellaGlass(22.dp).padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                CompanionPortrait(Modifier.width(54.dp), height = 64.dp)
                Text(
                    "我需要其中几项才能陪你读书。关掉时，我会说明原因，也会给你别的办法。",
                    Modifier.weight(1f).padding(start = 12.dp, top = 2.dp),
                    color = StudyPalette.ink,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("权限")
                SettingsGroup {
                    rows.forEachIndexed { index, pair ->
                        val (meta, status) = pair
                        if (index > 0) SettingsDivider()
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            GlassIconTile(meta.first, size = 36.dp)
                            Column(Modifier.weight(1f).padding(start = 13.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(meta.second, color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                                Text(meta.third, color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp)
                            }
                            PermissionChip(status)
                            if (meta.first == AstellaGlyphKind.Wave) {
                                Spacer(Modifier.width(8.dp))
                                when (status) {
                                    PermissionState.Unasked, PermissionState.Denied -> AstellaTextButton(
                                        onClick = {
                                            if (status == PermissionState.Denied) {
                                                context.startActivity(
                                                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                                                )
                                            } else {
                                                requestMic.launch(Manifest.permission.RECORD_AUDIO)
                                            }
                                        },
                                        contentPadding = PaddingValues(horizontal = 4.dp),
                                    ) { Text(if (status == PermissionState.Denied) "去设置" else "请求", fontSize = 12.sp) }
                                    else -> Unit
                                }
                            }
                        }
                    }
                }
            }
            SettingsFootnote(
                "相册与文件通过系统选择器打开，应用不需要读取整个相册或存储；麦克风只在录音时使用，不会后台采集。",
            )
        }
    }
}

@Composable
private fun PermissionChip(status: PermissionState) {
    val (fill, text) = when (status) {
        PermissionState.Granted -> Color(0xFFD8F5E2) to Color(0xFF0A5B2E)
        PermissionState.Denied -> Color(0xFFF7E3DF) to Color(0xFFB76752)
        PermissionState.Unasked -> StudyPalette.sky to StudyPalette.accent
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
    val settings = state.aiSettings
    val signed = settings?.consentVersion != null
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("AI 使用授权与数据", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(Modifier.fillMaxWidth().astellaGlass(22.dp).padding(14.dp), verticalAlignment = Alignment.Top) {
                CompanionPortrait(Modifier.width(54.dp), height = 64.dp)
                Text(
                    "你的手记只在你允许时才会交给我。下面每一项都可以单独关掉。",
                    Modifier.weight(1f).padding(start = 12.dp, top = 2.dp),
                    color = StudyPalette.ink,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                )
            }
            Column(
                Modifier.fillMaxWidth().astellaGlass(22.dp).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (signed) "已签署 AI 使用授权" else "尚未签署 AI 使用授权",
                    color = StudyPalette.ink,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    if (signed) "${settings?.consentVersion.orEmpty()}${settings?.consentAt?.take(10)?.let { " · $it" }.orEmpty()}"
                    else "阅读与手记无需授权；开启后才会把内容交给伴星。",
                    color = StudyPalette.muted,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                )
                if (!signed && settings?.requiresConsent == true) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(
                            checked = consentAccepted,
                            onCheckedChange = { consentAccepted = it },
                            enabled = !state.isAccountBusy,
                        )
                        Text("我已阅读并同意《AI 使用协议》", color = StudyPalette.ink, fontSize = 12.sp)
                    }
                    AstellaButton(
                        onClick = viewModel::acceptAIConsent,
                        enabled = !state.isAccountBusy && consentAccepted,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                    ) { Text("同意并开启外部 AI") }
                }
            }
            state.accountError?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.danger, fontSize = 12.sp) } }
            state.accountNotice?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.success, fontSize = 12.sp) } }
            if (settings != null) {
                Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    SectionLabel("授权项")
                    SettingsGroup {
                        PolicyRow("把选中的手记外发给模型", "关闭后伴星读不到手记内容；阅读与手记不受影响", policy.sendToExternal,
                            enabled = !state.isAccountBusy && (!settings.requiresConsent || signed)) { policy = policy.copy(sendToExternal = it) }
                        SettingsDivider()
                        PolicyRow("外发内容可包含图片", "关闭后图片只在本地处理，不进入模型", policy.sendImageContent) { policy = policy.copy(sendImageContent = it) }
                        SettingsDivider()
                        PolicyRow("外发前做个人信息检测", "命中时先提醒，可撤回再发送", policy.piiDetection) { policy = policy.copy(piiDetection = it) }
                        SettingsDivider()
                        PolicyRow("记录 AI 调用审计日志", "供你自查调用记录", policy.auditLogging) { policy = policy.copy(auditLogging = it) }
                    }
                    AstellaOutlinedButton(
                        onClick = { viewModel.saveAIDataPolicy(policy) },
                        enabled = !state.isAccountBusy && policy != savedPolicy,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(17.dp),
                    ) { Text("保存数据偏好") }
                    if (policy != savedPolicy) SettingsFootnote("数据偏好还有未保存的改动。")
                }
            } else {
                SettingsFootnote("正在读取账号级 AI 设置…")
            }
        }
    }
}

@Composable
private fun PolicyRow(title: String, detail: String, checked: Boolean, enabled: Boolean = true, onCheckedChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(detail, color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp)
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
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsFootnote("仅用于连接自建或私有部署的服务。保存后会退出当前会话，需要重新登录。")
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("服务地址", color = StudyPalette.muted, fontSize = 11.sp)
                GlassInput(address, { address = it }, "https://", KeyboardType.Uri)
            }
            AstellaButton(
                onClick = { viewModel.updateServiceAddress(address) },
                enabled = address.isNotBlank() && address.trim().trimEnd('/') != state.serviceAddress,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("保存并重新登录") }
            SettingsFootnote("当前生效：${if (state.serviceAddress.isBlank()) "默认（官方服务）" else state.serviceAddress}")
            state.accountError?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.danger, fontSize = 12.sp) } }
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
    val scope = rememberCoroutineScope()

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
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(Modifier.fillMaxWidth().astellaGlass(22.dp).padding(14.dp), verticalAlignment = Alignment.Top) {
                CompanionPortrait(Modifier.width(54.dp), height = 64.dp)
                Text(
                    "这是我们之间的约定，我会在每次对话里参考。${if (!enabled && loaded) "（当前已暂停：约定不会生效，但不会丢失。）" else ""}",
                    Modifier.weight(1f).padding(start = 12.dp, top = 2.dp),
                    color = StudyPalette.ink,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                )
            }
            SettingsGroup {
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("让约定生效", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text("暂停后这些约定不会影响伴星的回应", color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp)
                    }
                    AstellaSwitch(checked = enabled, enabled = loaded && !busy, onCheckedChange = { scope.launch { save(it) } })
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("我的约定")
                Column(Modifier.fillMaxWidth().astellaGlass(22.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    if (!loaded && busy) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(17.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
                            Text("正在读取个人约定…", Modifier.padding(start = 8.dp), color = StudyPalette.muted, fontSize = 11.sp)
                        }
                    } else {
                        BasicTextField(
                            value = markdown,
                            onValueChange = { if (it.length <= 16_000) { markdown = it; notice = null } },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
                            enabled = !busy,
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp, lineHeight = 22.sp, color = StudyPalette.ink),
                            cursorBrush = SolidColor(StudyPalette.accent),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                            decorationBox = { inner ->
                                if (markdown.isEmpty()) {
                                    Text("例如：遇到难懂的地方时，先举例，再让我试着解释。", color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 22.sp)
                                }
                                inner()
                            },
                        )
                    }
                }
            }
            AstellaButton(
                enabled = !busy && loaded && markdown != savedMarkdown,
                onClick = { scope.launch { save() } },
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp)
                Text(if (busy) "保存中…" else "保存约定", Modifier.padding(start = 6.dp))
            }
            error?.let { message ->
                Column(Modifier.fillMaxWidth().astellaGlass(20.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text(message, color = StudyPalette.danger, fontSize = 12.sp, lineHeight = 18.sp)
                    AstellaTextButton(onClick = { scope.launch { load(preservingDraft = conflictPending) } }, contentPadding = PaddingValues(0.dp)) {
                        Text(if (conflictPending) "读取最新版本并保留草稿" else "重新读取约定")
                    }
                }
            }
            conflictLatestMarkdown?.let { latest ->
                Column(Modifier.fillMaxWidth().astellaGlass(20.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text("另一台设备保存的版本", color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    SelectionContainer { Text(latest.ifEmpty { "（云端约定为空）" }, color = StudyPalette.ink, fontSize = 12.sp) }
                    Text("上方输入框仍保留你的草稿。合并需要的内容后，保存会以草稿作为最新版本。", color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 16.sp)
                    AstellaTextButton(onClick = { markdown = latest; conflictLatestMarkdown = null }, contentPadding = PaddingValues(0.dp)) {
                        Text("用另一台设备的版本替换草稿")
                    }
                }
            }
            notice?.let { Text(it, color = StudyPalette.success, fontSize = 12.sp) }
            SettingsFootnote("默认陪伴能力一直生效；个人约定用来补充你希望她怎样陪你学习。")
        }
    }
}

/** 「个人资料」：称呼、头像、邮箱。 */
@Composable
fun ProfileScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
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
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                AstellaTap(
                    { avatarPicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    Modifier.size(72.dp).astellaGlass(36.dp, interactive = true),
                ) {
                    Box(Modifier.align(Alignment.Center).fillMaxSize().padding(4.dp).clip(CircleShape).background(StudyPalette.sky)) {
                        if (avatarBitmap != null) {
                            androidx.compose.foundation.Image(
                                avatarBitmap!!.asImageBitmap(),
                                "账户头像",
                                Modifier.fillMaxSize(),
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                            )
                        } else {
                            Text(
                                (state.profile?.displayName?.firstOrNull() ?: state.profile?.email?.firstOrNull() ?: '阅').uppercase(),
                                Modifier.align(Alignment.Center),
                                color = StudyPalette.accent,
                                fontSize = 24.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
                Column(Modifier.weight(1f).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        state.profile?.displayName?.ifBlank { state.profile?.email?.substringBefore('@').orEmpty() } ?: "拾星同学",
                        color = StudyPalette.ink,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("我们的小宇宙 · 一起读过的日子", color = StudyPalette.muted, fontSize = 11.sp)
                }
            }
            SettingsFootnote("点头像可以更换，改好名字点保存。")
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("称呼", color = StudyPalette.muted, fontSize = 11.sp)
                GlassInput(displayName, { displayName = it.take(32) }, "你的昵称")
            }
            AstellaButton(
                onClick = { viewModel.saveProfile(displayName) },
                enabled = !state.isAccountBusy && displayName.trim() != state.profile?.displayName.orEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.isAccountBusy) CircularProgressIndicator(Modifier.size(17.dp), color = Color.White, strokeWidth = 2.dp)
                else Text(if (displayName.isBlank()) "清除称呼" else "保存称呼")
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("账号")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Mail, "邮箱", "用于登录与找回密码", value = state.profile?.email.orEmpty(), showChevron = false)
                }
            }
            state.accountError?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.danger, fontSize = 12.sp) } }
            state.accountNotice?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.success, fontSize = 12.sp) } }
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
        modifier.fillMaxWidth().heightIn(min = 52.dp).astellaGlass(20.dp).padding(horizontal = 16.dp, vertical = 15.dp),
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = StudyPalette.ink),
        cursorBrush = SolidColor(StudyPalette.accent),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, color = StudyPalette.muted, fontSize = 15.sp)
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
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsFootnote("通过登录邮箱验证码确认身份。密码内容仅在提交时发送。")
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("登录邮箱", color = StudyPalette.muted, fontSize = 11.sp)
                Box(Modifier.fillMaxWidth().astellaGlass(20.dp).padding(horizontal = 16.dp, vertical = 15.dp)) {
                    Text(email, color = StudyPalette.ink, fontSize = 15.sp)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("邮箱验证码", color = StudyPalette.muted, fontSize = 11.sp)
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
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("新密码", color = StudyPalette.muted, fontSize = 11.sp)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        GlassInput(password, { password = it.take(200) }, "8–200 位", KeyboardType.Password, visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation())
                    }
                    AstellaIconButton(onClick = { passwordVisible = !passwordVisible }, modifier = Modifier.size(44.dp)) {
                        AstellaGlyph(if (passwordVisible) AstellaGlyphKind.EyeSlash else AstellaGlyphKind.Eye, Modifier.size(18.dp), tint = StudyPalette.muted)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("确认新密码", color = StudyPalette.muted, fontSize = 11.sp)
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
            state.authError?.let { NoticeSurface(Modifier.fillMaxWidth()) { Text(it, color = StudyPalette.danger, fontSize = 12.sp) } }
            if (completed) {
                NoticeSurface(Modifier.fillMaxWidth()) {
                    Text("密码已更新。你可以继续使用新密码登录其他设备。", color = StudyPalette.success, fontSize = 13.sp)
                }
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

/** 「伴星配置」：名字、相处偏好、她记得的事、语音与朗读的真实状态。 */
@Composable
fun CompanionCenterScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onConversation: (records: Boolean) -> Unit,
    onConventions: () -> Unit = {},
    onProfile: () -> Unit = {},
    onMemory: () -> Unit = {},
) {
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    val latest = state.streamingText.ifEmpty { state.messages.lastOrNull { it.role == "assistant" }?.displayText.orEmpty() }
    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader("伴星配置", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 2.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                CompanionPortrait(Modifier.width(96.dp), height = 116.dp, reduceMotion = reduceMotion)
                Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("拾星 · ASTELLA", color = StudyPalette.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium, letterSpacing = 1.sp)
                    Text("伴星", color = StudyPalette.ink, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                    Text("一直在同一段交流里陪你。", color = StudyPalette.muted, fontSize = 12.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).background(if (state.realtimeStatus == "已连接") StudyPalette.success else StudyPalette.muted, CircleShape))
                        Text(state.realtimeStatus, Modifier.padding(start = 7.dp), color = StudyPalette.muted, fontSize = 10.sp)
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("表达设定")
                SettingsGroup {
                    SettingsRow(
                        AstellaGlyphKind.Person,
                        "名字",
                        "她这样称呼你",
                        value = state.profile?.displayName?.ifBlank { state.profile?.email?.substringBefore('@').orEmpty() } ?: "拾星同学",
                        onClick = onProfile,
                    )
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Quote, "说话风格", "语气与用词由伴星随相处调整", value = "自然", showChevron = false)
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Number, "讲解分量", "决定解释给到多细", value = "适中", showChevron = false)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("相处方式")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Check, "相处偏好", "你写下的个人约定", onClick = onConventions)
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Book, "她记得的事", "可以随时核对与收回", onClick = onMemory)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("声音与语音")
                SettingsGroup {
                    SettingsRow(
                        AstellaGlyphKind.Wave,
                        "实时语音交流",
                        "在相伴页轻点话筒直接说，整段识别",
                        showChevron = false,
                    )
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Speaker,
                        "朗读回复",
                        "由服务端开关与账号授权决定",
                        value = if (state.isPlaying) "播放中" else "未启用",
                        showChevron = false,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("最近一次回应")
                SettingsGroup {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.Top) {
                        Box(Modifier.padding(top = 3.dp).width(2.dp).height(40.dp).background(StudyPalette.paperEdge))
                        Text(
                            latest.ifBlank { "还没有新的回复，回去告诉她你想聊什么。" },
                            Modifier.padding(start = 13.dp),
                            color = StudyPalette.ink,
                            fontSize = 13.sp,
                            lineHeight = 21.sp,
                            maxLines = 4,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            AstellaButton(onClick = { onConversation(false) }, modifier = Modifier.fillMaxWidth()) { Text("回到对话") }
            AstellaTextButton(onClick = { onConversation(true) }, modifier = Modifier.fillMaxWidth()) { Text("查看完整记录") }
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
