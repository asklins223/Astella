package com.astella.mobile.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.R
import com.astella.mobile.data.ApiFailure
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.NoteDocument
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaOutlinedButton
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.astellaGlass
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max

@Composable
fun SessionRecoveryScreen(state: AppUiState, viewModel: AppViewModel) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AstellaGlyph(AstellaGlyphKind.Refresh, Modifier.size(36.dp), tint = StudyPalette.accent)
        Text("正在接回你的书房", Modifier.padding(top = 17.dp), color = StudyPalette.ink,
            fontSize = 25.sp, fontWeight = FontWeight.SemiBold)
        Text(state.error ?: "正在恢复登录状态与学习记录。", Modifier.padding(top = 8.dp),
            color = StudyPalette.muted, textAlign = TextAlign.Center)
        if (state.isLoading) CircularProgressIndicator(Modifier.padding(top = 22.dp).size(22.dp), color = StudyPalette.accent)
        else Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AstellaOutlinedButton(onClick = { viewModel.logout() }) { Text("返回登录") }
            AstellaButton(onClick = { viewModel.restoreSession() }) { Text("重新连接") }
        }
    }
}

@Composable
fun NoteFeatureScreen(
    noteId: String,
    kind: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onAccount: () -> Unit,
) {
    LaunchedEffect(noteId, kind) {
        if (state.aiSettings == null) viewModel.loadAccountSettings()
    }
    when (kind) {
        "mindmap" -> NoteMindMapScreen(noteId, state, viewModel, onBack, onAccount)
        else -> NoteOverviewScreen(noteId, state, viewModel, onBack, onAccount)
    }
}

/** 页眉：44 玻璃返回圆 + 32/600 大标题（对齐 iOS AstellaDetailHeader）。 */
@Composable
internal fun FeatureHeader(title: String, onBack: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassCircleButton(
            onClick = onBack,
            size = 44.dp,
            modifier = Modifier.semantics { contentDescription = "返回" },
        ) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(19.dp), tint = StudyPalette.ink)
        }
        Spacer(Modifier.width(15.dp))
        Text(
            title,
            color = StudyPalette.ink,
            fontSize = 32.sp,
            lineHeight = 38.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.9).sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 来源手记卡：图标 + 标题 + 版本/段数 + 「手记」胶囊。 */
@Composable
internal fun NoteFeatureSourceLine(document: NoteDocument?) {
    Row(
        Modifier.fillMaxWidth().astellaGlass(18.dp).padding(horizontal = 13.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(38.dp).background(StudyPalette.sky, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center,
        ) { AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(19.dp), tint = StudyPalette.accent) }
        Column(Modifier.weight(1f).padding(start = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                document?.title ?: "当前手记",
                color = StudyPalette.ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "第 ${document?.versionNumber ?: 1} 版 · ${document?.blocks?.size ?: 0} 段正文",
                color = StudyPalette.muted,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }
        Text(
            "手记",
            Modifier.background(StudyPalette.inset.copy(alpha = 0.7f), CircleShape)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            color = StudyPalette.muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
internal fun NoteFeatureLoadingState(title: String) {
    Row(
        Modifier.fillMaxWidth().astellaGlass(18.dp).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
        Text(title, Modifier.padding(start = 11.dp), color = StudyPalette.muted, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
internal fun FeatureFailure(message: String, retry: () -> Unit, onAccount: (() -> Unit)? = null) {
    val consentRequired = message.contains("AI 使用协议", ignoreCase = true) ||
        message.contains("ai_consent_required", ignoreCase = true)
    val policyDisabled = requiresAiDataPolicy(message)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        AstellaGlyph(
            if (consentRequired || policyDisabled) AstellaGlyphKind.Info else AstellaGlyphKind.Alert,
            modifier = Modifier.padding(top = 2.dp).size(20.dp),
            tint = if (consentRequired || policyDisabled) StudyPalette.accent else StudyPalette.danger,
        )
        Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (consentRequired) "这项整理需要你的授权" else if (policyDisabled) "外部 AI 已关闭" else "这次整理没有完成",
                color = StudyPalette.ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                if (consentRequired) "请先在「我的 → AI 与数据」阅读协议，再由你决定是否同意。确认前不会发送这篇手记。"
                else if (policyDisabled) "账号的数据偏好已关闭外部 AI。你可以在设置中了解并自行调整；重新开启前不会提交这篇手记。"
                else message,
                color = StudyPalette.muted,
                fontSize = 13.sp,
                lineHeight = 19.sp,
            )
            if ((consentRequired || policyDisabled) && onAccount != null) {
                AstellaTextButton(onClick = onAccount, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("查看 AI 使用设置") }
            } else {
                AstellaTextButton(onClick = retry, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("重新读取") }
            }
        }
    }
}

@Composable
internal fun FeatureAuthorizationNotice(state: AppUiState, error: String?, onAccount: () -> Unit, retry: () -> Unit) {
    when {
        state.aiSettings?.needsSigning == true || requiresAiConsent(error) ->
            FeatureFailure("ai_consent_required", retry = retry, onAccount = onAccount)
        state.aiSettings?.dataPolicy?.sendToExternal == false || requiresAiDataPolicy(error) ->
            FeatureFailure("ai_data_policy_denied", retry = retry, onAccount = onAccount)
        state.aiSettings == null && state.accountError != null ->
            FeatureFailure(state.accountError!!, retry = retry)
        state.aiSettings == null ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                Text("正在确认 AI 使用授权…", Modifier.padding(start = 9.dp), color = StudyPalette.muted, fontSize = 13.sp)
            }
    }
}

/** 底部操作区：授权提示 / 主操作按钮；有伴星圆形入口时右侧留出 74。 */
@Composable
internal fun NoteFeatureActionDock(
    actionTitle: String,
    isWorking: Boolean,
    isAvailable: Boolean,
    error: String?,
    state: AppUiState,
    onAccount: () -> Unit,
    onReloadSettings: () -> Unit,
    reserveOrb: Boolean,
    action: () -> Unit,
) {
    val needsSigning = state.aiSettings?.needsSigning == true || requiresAiConsent(error)
    val externalBlocked = state.aiSettings?.dataPolicy?.sendToExternal == false || requiresAiDataPolicy(error)
    Column(
        Modifier.fillMaxWidth().navigationBarsPadding()
            .padding(start = 20.dp, end = if (reserveOrb) 74.dp else 20.dp)
            .padding(top = 12.dp, bottom = 7.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (needsSigning || externalBlocked) {
            Row(
                Modifier.fillMaxWidth().background(StudyPalette.paper, RoundedCornerShape(17.dp))
                    .border(0.7.dp, StudyPalette.paperEdge.copy(alpha = 0.62f), RoundedCornerShape(17.dp))
                    .padding(12.dp),
                verticalAlignment = Alignment.Top,
            ) {
                AstellaGlyph(AstellaGlyphKind.Info, Modifier.size(19.dp), tint = StudyPalette.accent)
                Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(if (needsSigning) "这项整理需要你的授权" else "外部 AI 已关闭",
                        color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (needsSigning) "先在「我的 → AI 与数据」阅读协议，再由你决定是否授权。确认前不会发送这篇手记。"
                        else "当前数据偏好不允许外部 AI 处理这篇手记。",
                        color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
                    )
                }
            }
            AstellaButton(onClick = onAccount, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                AstellaGlyph(AstellaGlyphKind.Settings, Modifier.size(16.dp), tint = Color.White)
                Text("查看 AI 使用设置", Modifier.padding(start = 8.dp))
            }
        } else if (state.aiSettings == null) {
            if (state.isAccountBusy) {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                    Text("正在确认使用设置…", Modifier.padding(start = 9.dp), color = StudyPalette.muted, fontSize = 13.sp)
                }
            } else {
                AstellaOutlinedButton(onClick = onReloadSettings, modifier = Modifier.fillMaxWidth()) { Text("重新读取使用设置") }
            }
        } else {
            AstellaButton(
                onClick = action,
                enabled = !isWorking && isAvailable,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(StudyRadius.xxl),
            ) {
                if (isWorking) CircularProgressIndicator(Modifier.size(17.dp), color = Color.White, strokeWidth = 2.dp)
                else AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(17.dp), tint = Color.White)
                Text(if (isWorking) "正在整理…" else actionTitle, Modifier.padding(start = 8.dp))
            }
        }
    }
}

private fun NoteDocument.readableExcerpt(maxLength: Int = 112): String? {
    val candidates = blocks.asSequence()
        .filter { it.content.isNotBlank() && !it.type.contains("image", ignoreCase = true) }
        .map { it.content.trim().replace('\n', ' ').replace(Regex("\\s+"), " ") }
        .toList()
    val value = candidates.firstOrNull { it.length >= 30 } ?: candidates.firstOrNull()
    return value?.let { it.take(maxLength) + if (it.length > maxLength) "…" else "" }
}

/** 未生成时的说明卡：图标 + 标题 + 会包含什么 + 原文起点 + 说明。 */
@Composable
internal fun FeatureGenerationPrimer(kind: String, document: NoteDocument?) {
    val title = when (kind) {
        "overview" -> "先抓住整篇主线，再回看关键原句"
        "mindmap" -> "脑图会按层级展开"
        "expansion" -> "从原文生长出下一篇手记"
        "learning-card" -> "一题一页，按这版笔记练习"
        else -> "跟着原文一步一步读懂"
    }
    val description = when (kind) {
        "overview" -> "把一篇长手记整理成主线、关键点和对应的原文依据。"
        "mindmap" -> "从这份手记提取主题、分支关系和原文出处。"
        "expansion" -> "围绕当前版本准备几份拓展草稿，你可以挑选要收下的笔记。"
        "learning-card" -> "题型随笔记内容搭配，每题都有原文依据，完成后再一起核对。"
        else -> "从主题开始逐步解释，每一步都能对照到这篇手记里的段落。"
    }
    val sectionLabel = when (kind) {
        "overview" -> "整理后会看到"
        "mindmap" -> "从正文长出"
        "expansion" -> "你可以这样使用"
        "learning-card" -> "答题会这样进行"
        else -> "讲解会这样展开"
    }
    val rows = when (kind) {
        "overview" -> listOf(
            Triple("01", "主线", "一段话看清整篇在说什么"),
            Triple("02", "关键点", "把重要的转折和关系分开"),
            Triple("03", "原文依据", "每个要点都能回到对应原句"),
        )
        "mindmap" -> listOf(
            Triple("01", "主题与分支", "从中心向外展开，不挤在一屏里"),
            Triple("02", "原文出处", "节点保留对应的笔记段落"),
        )
        "expansion" -> listOf(
            Triple("01", "先看草稿", "每篇都展示它和原文的关系"),
            Triple("02", "自己挑选", "确认后另存为新手记"),
            Triple("03", "保留关系", "新旧手记之间可以互相找到"),
        )
        "learning-card" -> listOf(
            Triple("01", "一题一页", "在手机上逐题作答"),
            Triple("02", "草稿自动保存", "可以跳题，之后继续"),
            Triple("03", "交卷后回看", "答案、批改和原文依据一起显示"),
        )
        else -> listOf(
            Triple("01", "先看主题", "先说明这部分在讲什么"),
            Triple("02", "结合原文解释", "沿着段落次序逐步展开"),
            Triple("03", "留下出处", "每一步都能对照原文"),
        )
    }
    Column(
        Modifier.fillMaxWidth().astellaGlass(22.dp).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(17.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(44.dp).background(StudyPalette.sky, RoundedCornerShape(15.dp)),
                contentAlignment = Alignment.Center,
            ) {
                AstellaGlyph(
                    when (kind) { "overview" -> AstellaGlyphKind.Document; "mindmap" -> AstellaGlyphKind.Orbit; else -> AstellaGlyphKind.Book },
                    Modifier.size(21.dp), tint = StudyPalette.accent,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("尚未生成 · 第 ${document?.versionNumber ?: 1} 版",
                    color = StudyPalette.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(title, color = StudyPalette.ink, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
                Text(description, color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 21.sp)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(sectionLabel, color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            rows.forEachIndexed { index, (number, rowTitle, detail) ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                    Text(
                        number,
                        Modifier.width(27.dp).padding(top = 2.dp),
                        color = if (index == 0) StudyPalette.accent else StudyPalette.muted,
                        fontSize = 11.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(rowTitle, color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(detail, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 17.sp)
                    }
                }
            }
        }
        document?.readableExcerpt()?.let { excerpt ->
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("从这段原文开始", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                    Box(Modifier.width(2.dp).heightIn(min = 42.dp).background(StudyPalette.accent.copy(alpha = 0.58f), RoundedCornerShape(2.dp)))
                    Text("“$excerpt”", color = StudyPalette.ink.copy(alpha = 0.78f), fontSize = 14.sp, lineHeight = 21.sp)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            AstellaGlyph(AstellaGlyphKind.Info, Modifier.size(13.dp), tint = StudyPalette.muted)
            Text("这份整理会单独保存，不会改动原文。", color = StudyPalette.muted, fontSize = 12.sp)
        }
    }
}

@Composable
internal fun FeatureNotice(text: String) {
    Text(
        text,
        Modifier.fillMaxWidth().background(StudyPalette.paper, RoundedCornerShape(15.dp))
            .border(0.7.dp, StudyPalette.paperEdge.copy(alpha = 0.52f), RoundedCornerShape(15.dp))
            .padding(13.dp),
        color = StudyPalette.muted,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    )
}

@Composable
private fun NoteOverviewScreen(noteId: String, state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onAccount: () -> Unit) {
    var overview by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var task by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    LaunchedEffect(state.aiSettings?.needsSigning, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.needsSigning == false && state.aiSettings.dataPolicy.sendToExternal &&
            (requiresAiConsent(error) || requiresAiDataPolicy(error))) error = null
    }

    suspend fun poll(taskId: String) {
        busy = true
        repeat(30) {
            try {
                val value = viewModel.requestApi("/v2/notes/$noteId/overview-tasks/$taskId")
                task = value
                value.optJSONObject("overview")?.let { overview = it }
                when (value.optString("status")) {
                    "ready" -> { busy = false; return }
                    "failed" -> { error = failureMessage(value.optString("failureReason")); busy = false; return }
                }
                delay(2_000)
            } catch (cause: Throwable) { error = featureFailure(cause, "整理状态暂时无法读取，请检查连接后重试。"); busy = false; return }
        }
        busy = false
        error = "整理仍在后台进行。稍后重新打开此页即可接着查看。"
    }

    suspend fun load() {
        val versionId = document?.versionId ?: return
        loading = true; error = null
        try {
            val page = viewModel.requestApi("/v2/notes/$noteId/overviews")
            val items = page.optJSONArray("items").objects()
            overview = items.firstOrNull { it.optString("noteVersionId") == versionId } ?: items.firstOrNull()
            val latest = viewModel.requestApi("/v2/notes/$noteId/overview-tasks/latest?noteVersionId=$versionId")
            task = latest.optJSONObject("task")
            task?.takeIf { it.optString("status") in setOf("queued", "running") }?.optString("taskId")?.let { poll(it) }
        } catch (cause: Throwable) { error = featureFailure(cause, "速览暂时无法读取，请检查连接后重试。") }
        loading = false
    }

    suspend fun generate() {
        val settings = state.aiSettings ?: return
        if (settings.needsSigning || !settings.dataPolicy.sendToExternal) return
        val versionId = document?.versionId ?: return
        busy = true; error = null
        try {
            val created = viewModel.requestApi("/v2/notes/$noteId/overview-tasks", "POST",
                JSONObject().put("noteVersionId", versionId).put("requestId", java.util.UUID.randomUUID().toString()))
            task = created
            created.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) } ?: run { busy = false }
        } catch (cause: Throwable) {
            error = featureFailure(cause, "速览没有开始，请检查连接后重试。")
            if (requiresAiConsent(error)) viewModel.markAiConsentRequired()
            if (requiresAiDataPolicy(error)) viewModel.loadAccountSettings()
            busy = false
        }
    }

    LaunchedEffect(noteId, document?.versionId) { load() }
    Column(Modifier.fillMaxSize()) {
        FeatureHeader("速览", onBack)
        Box(Modifier.padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 4.dp)) {
            NoteFeatureSourceLine(document)
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) {
                FeatureFailure(error!!, retry = { scope.launch { load() } })
            }
            if (loading && overview == null) NoteFeatureLoadingState("正在读取速览")
            if (busy) NoteFeatureLoadingState(if (task?.optString("status") == "queued") "已排入整理" else "正在整理这篇手记…")
            val value = overview
            if (value != null) {
                if (value.optString("versionState") == "older") {
                    FeatureNotice("这份速览基于第 ${value.optInt("noteVersionNumber", 1)} 版，当前正文可能已经变化。")
                }
                val body = value.optString("body")
                Column(
                    Modifier.fillMaxWidth().astellaGlass(22.dp).padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AstellaGlyph(AstellaGlyphKind.Quote, Modifier.size(17.dp), tint = StudyPalette.accent)
                        Text("核心脉络", Modifier.weight(1f).padding(start = 8.dp),
                            color = StudyPalette.accent, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text("第 ${value.optInt("noteVersionNumber", document?.versionNumber ?: 1)} 版",
                            color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                    Text(body, color = StudyPalette.ink, fontSize = 17.sp, lineHeight = 27.sp)
                }
                val points = value.optJSONArray("points").objects()
                if (points.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                        Text("要点与原文", color = StudyPalette.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        points.forEachIndexed { index, point ->
                            Column(
                                Modifier.fillMaxWidth().astellaGlass(19.dp).padding(15.dp),
                                verticalArrangement = Arrangement.spacedBy(11.dp),
                            ) {
                                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                                    Box(
                                        Modifier.size(31.dp).background(StudyPalette.sky, CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text("%02d".format(index + 1), color = StudyPalette.accent, fontSize = 12.sp,
                                            fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                                    }
                                    Text(point.optString("explanation"), Modifier.weight(1f).padding(top = 3.dp),
                                        color = StudyPalette.ink, fontSize = 15.5.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
                                }
                                val quote = point.optString("quote")
                                if (quote.isNotBlank()) Row(
                                    Modifier.padding(start = 41.dp),
                                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                                    verticalAlignment = Alignment.Top,
                                ) {
                                    Box(Modifier.width(2.dp).heightIn(min = 20.dp).background(StudyPalette.accent.copy(alpha = 0.55f), RoundedCornerShape(2.dp)))
                                    Text("“$quote”", color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 21.sp)
                                }
                            }
                        }
                    }
                }
                val coverage = value.optJSONObject("coverage")
                if ((coverage?.optInt("imageBlocksNotRead") ?: 0) > 0) {
                    FeatureNotice("有图片内容没有纳入这次速览，请结合原文查看。")
                }
            } else if (!loading && !busy) {
                FeatureGenerationPrimer("overview", document)
            }
        }
        NoteFeatureActionDock(
            actionTitle = if (overview == null) "生成速览" else "按当前版本重新整理",
            isWorking = busy,
            isAvailable = document != null,
            error = error,
            state = state,
            onAccount = onAccount,
            onReloadSettings = { viewModel.loadAccountSettings() },
            reserveOrb = true,
        ) { scope.launch { generate() } }
    }
}

@Composable
private fun NoteMindMapScreen(noteId: String, state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onAccount: () -> Unit) {
    var map by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    var zoom by remember(noteId) { mutableFloatStateOf(0.85f) }
    var panX by remember(noteId) { mutableFloatStateOf(0f) }
    var panY by remember(noteId) { mutableFloatStateOf(0f) }
    val scope = rememberCoroutineScope()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    LaunchedEffect(state.aiSettings?.needsSigning, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.needsSigning == false && state.aiSettings.dataPolicy.sendToExternal &&
            (requiresAiConsent(error) || requiresAiDataPolicy(error))) error = null
    }

    suspend fun poll(taskId: String) {
        busy = true
        repeat(30) {
            try {
                val value = viewModel.requestApi("/v2/notes/$noteId/mind-map-tasks/$taskId")
                value.optJSONObject("mindMap")?.let { map = it }
                when (value.optString("status")) {
                    "ready" -> { busy = false; return }
                    "failed" -> { error = failureMessage(value.optString("failureReason")); busy = false; return }
                }
                delay(2_000)
            } catch (cause: Throwable) { error = featureFailure(cause, "脑图状态暂时无法读取，请检查连接后重试。"); busy = false; return }
        }
        busy = false; error = "脑图仍在后台整理。稍后重新打开此页即可接着查看。"
    }

    suspend fun load() {
        val versionId = document?.versionId ?: return
        loading = true; error = null
        try {
            val page = viewModel.requestApi("/v2/notes/$noteId/mind-maps")
            val maps = page.optJSONArray("items").objects()
            map = maps.firstOrNull { it.optString("noteVersionId") == versionId } ?: maps.firstOrNull()
            val latest = viewModel.requestApi("/v2/notes/$noteId/mind-map-tasks/latest?noteVersionId=$versionId")
            val task = latest.optJSONObject("task")
            if (task != null && task.optString("status") in setOf("queued", "running")) task.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) }
        } catch (cause: Throwable) { error = featureFailure(cause, "脑图暂时无法读取，请检查连接后重试。") }
        loading = false
    }

    suspend fun generate() {
        val settings = state.aiSettings ?: return
        if (settings.needsSigning || !settings.dataPolicy.sendToExternal) return
        val versionId = document?.versionId ?: return
        panX = 0f; panY = 0f; zoom = 0.85f
        busy = true; error = null
        try {
            val created = viewModel.requestApi("/v2/notes/$noteId/mind-map-tasks", "POST",
                JSONObject().put("noteVersionId", versionId).put("requestId", java.util.UUID.randomUUID().toString()))
            created.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) } ?: run { busy = false }
        } catch (cause: Throwable) {
            error = featureFailure(cause, "脑图没有开始，请检查连接后重试。")
            if (requiresAiConsent(error)) viewModel.markAiConsentRequired()
            if (requiresAiDataPolicy(error)) viewModel.loadAccountSettings()
            busy = false
        }
    }

    LaunchedEffect(noteId, document?.versionId) { load() }
    val nodes = remember(map) {
        MapNode.parse(map?.optJSONObject("content")?.optJSONArray("nodes").objects().orEmpty())
    }
    Column(Modifier.fillMaxSize()) {
        MindMapToolbar(onBack)
        Column(Modifier.weight(1f).fillMaxWidth()) {
            if (state.aiSettings?.needsSigning == true || requiresAiConsent(error) ||
                state.aiSettings?.dataPolicy?.sendToExternal == false || requiresAiDataPolicy(error) || state.aiSettings == null) {
                Box(Modifier.padding(horizontal = 22.dp).padding(top = 8.dp)) {
                    FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() }
                }
            }
            if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) {
                Box(Modifier.padding(horizontal = 22.dp).padding(top = 8.dp)) {
                    FeatureFailure(error!!, retry = { scope.launch { load() } })
                }
            }
            if (map?.optString("versionState") == "older") {
                Box(Modifier.padding(horizontal = 22.dp).padding(top = 8.dp)) {
                    FeatureNotice("这张图基于第 ${map?.optInt("noteVersionNumber", 1) ?: 1} 版。")
                }
            }
            when {
                (loading && map == null) || (busy && map == null) -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                        Text(if (busy) "正在整理思路…" else "正在读取脑图…", Modifier.padding(top = 10.dp),
                            color = StudyPalette.muted, fontSize = 13.sp)
                    }
                }
                nodes.isEmpty() -> Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                        .padding(horizontal = 24.dp).padding(vertical = 18.dp),
                ) { FeatureGenerationPrimer("mindmap", document) }
                else -> MindMapCanvas(
                    nodes = nodes,
                    zoom = zoom,
                    onZoom = { zoom = it },
                    panX = panX,
                    panY = panY,
                    onPan = { x, y -> panX = x; panY = y },
                )
            }
        }
        AstellaButton(
            onClick = { scope.launch { generate() } },
            enabled = !loading && !busy && document != null &&
                state.aiSettings?.needsSigning == false && state.aiSettings.dataPolicy.sendToExternal &&
                !requiresAiConsent(error) && !requiresAiDataPolicy(error),
            modifier = Modifier.fillMaxWidth().navigationBarsPadding()
                .padding(horizontal = 20.dp).padding(top = 11.dp, bottom = 11.dp),
            shape = RoundedCornerShape(StudyRadius.xxl),
        ) {
            AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(17.dp), tint = Color.White)
            Text(
                when {
                    loading || busy -> if (nodes.isEmpty()) "正在读取脑图…" else "正在重新生成…"
                    nodes.isEmpty() && map == null -> "生成脑图"
                    else -> "重新生成脑图"
                },
                Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun MindMapToolbar(onBack: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.fillMaxWidth().astellaGlass(24.dp).padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(38.dp).clip(RoundedCornerShape(14.dp))
                    .background(StudyPalette.paper.copy(alpha = 0.68f))
                    .clickable(onClick = onBack)
                    .semantics { contentDescription = "返回阅读" },
                contentAlignment = Alignment.Center,
            ) { AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(18.dp), tint = StudyPalette.ink) }
            Box(
                Modifier.size(34.dp).clip(CircleShape).background(StudyPalette.sky.copy(alpha = 0.68f)),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.foundation.Image(
                    painterResource(R.drawable.companion_avatar), null,
                    Modifier.fillMaxSize().clip(CircleShape), contentScale = ContentScale.Crop,
                )
            }
            Text("脑图", color = StudyPalette.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private data class MapNode(
    val id: String,
    val parentId: String?,
    val kind: String,
    val label: String,
) {
    companion object {
        fun parse(values: List<JSONObject>): List<MapNode> = values.mapNotNull { value ->
            val id = value.optString("id").takeIf(String::isNotBlank) ?: return@mapNotNull null
            val label = value.optString("label").takeIf(String::isNotBlank) ?: return@mapNotNull null
            MapNode(id, value.optString("parentId").takeIf(String::isNotBlank), value.optString("kind", "concept"), label)
        }
    }
}

private data class MapPosition(val node: MapNode, val depth: Int, val centerY: Float, val width: Float) {
    val x: Float get() = 22f + depth * 170f
}

private data class MapLayout(
    val positions: List<MapPosition>,
    val byId: Map<String, MapPosition>,
    val width: Float,
    val height: Float,
)

private fun layoutMap(nodes: List<MapNode>): MapLayout {
    val nodeById = nodes.associateBy { it.id }
    val children = nodes.filter { it.parentId != null }.groupBy { it.parentId!! }
    val rootId = nodes.firstOrNull { it.kind == "root" }?.id ?: nodes.firstOrNull()?.id
    val output = mutableListOf<MapPosition>()
    var row = 0
    val rowSpacing = 100f
    val topInset = 58f
    val seen = mutableSetOf<String>()

    fun place(nodeId: String, depth: Int): Float {
        if (!seen.add(nodeId)) return topInset
        val node = nodeById[nodeId] ?: return topInset
        val visibleChildren = (children[nodeId] ?: emptyList()).filter { it.id !in seen }
        val centerY: Float
        if (visibleChildren.isEmpty()) {
            centerY = topInset + row * rowSpacing
            row += 1
        } else {
            val centers = visibleChildren.map { place(it.id, depth + 1) }
            centerY = (centers.first() + centers.last()) / 2f
        }
        val width = when (node.kind) {
            "root" -> 108f
            "group" -> 122f
            else -> 132f
        }
        output += MapPosition(node, depth, centerY, width)
        return centerY
    }
    if (rootId != null) place(rootId, 0)
    val maxDepth = output.maxOfOrNull { it.depth } ?: 0
    return MapLayout(
        positions = output,
        byId = output.associateBy { it.node.id },
        width = max(512f, 22f + maxDepth * 170f + 132f + 18f),
        height = max(676f, topInset * 2 + max(1, row - 1) * rowSpacing + 60f),
    )
}

@Composable
private fun MindMapCanvas(
    nodes: List<MapNode>,
    zoom: Float,
    onZoom: (Float) -> Unit,
    panX: Float,
    panY: Float,
    onPan: (Float, Float) -> Unit,
) {
    val layout = remember(nodes) { layoutMap(nodes) }
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val viewportWidth = constraints.maxWidth.toFloat()
        val viewportHeight = constraints.maxHeight.toFloat()
        val layoutWidthPx = with(density) { layout.width.dp.toPx() }
        val layoutHeightPx = with(density) { layout.height.dp.toPx() }
        val scale = zoom.coerceIn(0.4f, 2.5f)
        val originX = (viewportWidth - layoutWidthPx * scale) / 2f + panX
        val originY = (viewportHeight - layoutHeightPx * scale) / 2f + panY
        Box(
            Modifier.fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, gesture, _ ->
                        onZoom((zoom * gesture).coerceIn(0.4f, 2.5f))
                        onPan(panX + pan.x, panY + pan.y)
                    }
                }
                .semantics { contentDescription = "无限画布脑图，可拖动平移并双指缩放" },
        ) {
            Box(
                Modifier.offset { IntOffset(originX.toInt(), originY.toInt()) }
                    .size(layout.width.dp, layout.height.dp)
                    .graphicsLayer { scaleX = scale; scaleY = scale; transformOrigin = TransformOrigin(0f, 0f) },
            ) {
                val connectorColor = StudyPalette.accent.copy(alpha = 0.42f)
                val strokeWidth = with(density) { 1.5.dp.toPx() }
                Canvas(Modifier.fillMaxSize()) {
                    layout.positions.forEach { position ->
                        val parentId = position.node.parentId ?: return@forEach
                        val parent = layout.byId[parentId] ?: return@forEach
                        val startX = parent.x + parent.width
                        val startY = parent.centerY
                        val endX = position.x
                        val endY = position.centerY
                        val reach = max(18f, (endX - startX) * 0.46f)
                        val path = Path().apply {
                            moveTo(startX.dp.toPx(), startY.dp.toPx())
                            cubicTo(
                                (startX + reach).dp.toPx(), startY.dp.toPx(),
                                (endX - reach).dp.toPx(), endY.dp.toPx(),
                                endX.dp.toPx(), endY.dp.toPx(),
                            )
                        }
                        drawPath(path, connectorColor, style = androidx.compose.ui.graphics.drawscope.Stroke(width = strokeWidth))
                    }
                }
                layout.positions.forEach { position ->
                    val node = position.node
                    val isRoot = node.kind == "root"
                    Box(
                        Modifier.offset(x = position.x.dp, y = (position.centerY - 26f).dp)
                            .width(position.width.dp)
                            .heightIn(min = 52.dp)
                            .shadow(7.dp, RoundedCornerShape(16.dp), clip = false,
                                ambientColor = StudyPalette.ink.copy(alpha = 0.05f),
                                spotColor = StudyPalette.ink.copy(alpha = 0.05f))
                            .clip(RoundedCornerShape(16.dp))
                            .background(
                                Brush.linearGradient(
                                    listOf(StudyPalette.paper.copy(alpha = 0.94f), StudyPalette.paper.copy(alpha = 0.78f)),
                                ),
                            )
                            .border(0.9.dp, Color.White.copy(alpha = 0.88f), RoundedCornerShape(16.dp))
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            node.label,
                            color = if (isRoot) StudyPalette.accent else StudyPalette.ink,
                            fontSize = if (isRoot) 14.sp else 12.sp,
                            lineHeight = 18.sp,
                            letterSpacing = if (isRoot) 1.sp else 0.sp,
                            fontWeight = if (isRoot) FontWeight.SemiBold else FontWeight.Medium,
                            fontFamily = if (isRoot) FontFamily.Serif else null,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteVersionsSheet(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    visible: Boolean,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = StudyPalette.canvas,
        contentColor = StudyPalette.ink,
    ) {
        NoteVersionsContent(
            noteId, state, viewModel, onClose = onDismiss,
            modifier = Modifier.fillMaxWidth().fillMaxHeight(.9f),
        )
    }
}

@Composable
private fun NoteVersionsContent(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var versions by remember(noteId) { mutableStateOf(emptyList<JSONObject>()) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    var selected by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        loading = true; error = null
        try {
            val page = viewModel.requestApi("/notes/$noteId/versions?limit=50&offset=0")
            versions = page.optJSONArray("items").objects()
        } catch (cause: Throwable) { error = featureFailure(cause, "版本记录暂时无法读取，请检查连接后重试。") }
        loading = false
    }

    LaunchedEffect(noteId) { load() }
    selected?.let { version ->
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text("恢复到第 ${version.optInt("versionNo", 1)} 版？") },
            text = { Text("当前内容会作为新版本保存，之后仍可切回其他记录。") },
            confirmButton = {
                AstellaTextButton(enabled = !busy, onClick = {
                    scope.launch {
                        val base = state.noteDocument?.versionId ?: return@launch
                        busy = true; error = null
                        try {
                            val id = version.optString("id")
                            viewModel.requestApi("/notes/$noteId/versions/$id/restore", "POST", JSONObject().put("baseVersionId", base))
                            viewModel.loadNote(noteId)
                            selected = null
                            load()
                        } catch (cause: Throwable) { error = featureFailure(cause, "版本没有恢复，请刷新后重试。") }
                        busy = false
                    }
                }) { Text("恢复这一版") }
            },
            dismissButton = { AstellaTextButton(onClick = { selected = null }) { Text("取消") } },
        )
    }

    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(top = 19.dp, bottom = 15.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("版本记录", color = StudyPalette.ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text("恢复会另存为新版本，原来的内容仍会保留。", color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 19.sp)
            }
            GlassCircleButton(onClick = onClose, size = 32.dp) {
                AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(12.dp), tint = StudyPalette.muted)
            }
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (error != null) item { FeatureFailure(error!!, retry = { scope.launch { load() } }) }
            if (loading && versions.isEmpty()) item { NoteFeatureLoadingState("正在读取版本…") }
            if (!loading && versions.isEmpty() && error == null) item {
                Column(Modifier.fillMaxWidth().padding(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    AstellaGlyph(AstellaGlyphKind.Refresh, Modifier.size(23.dp), tint = StudyPalette.accent)
                    Text("还没有版本记录", color = StudyPalette.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text("这篇手记目前只有当前版本。", color = StudyPalette.muted, fontSize = 15.sp)
                }
            }
            items(versions, key = { it.optString("id") }) { version ->
                val isCurrent = version.optString("id") == state.noteDocument?.versionId
                if (isCurrent) {
                    Column(
                        Modifier.fillMaxWidth().background(StudyPalette.paper, RoundedCornerShape(StudyRadius.xl))
                            .border(0.7.dp, StudyPalette.paperEdge.copy(alpha = 0.52f), RoundedCornerShape(StudyRadius.xl))
                            .padding(StudySpacing.lg),
                        verticalArrangement = Arrangement.spacedBy(11.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(22.dp), tint = StudyPalette.accent)
                            Column(Modifier.weight(1f).padding(start = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("第 ${version.optInt("versionNo", 1)} 版", color = StudyPalette.ink,
                                    fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                                Text(versionDate(version.optString("createdAt")), color = StudyPalette.muted, fontSize = 12.sp)
                            }
                            Text("当前", color = StudyPalette.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                        state.noteDocument.takeIf { it.id == noteId }?.readableExcerpt(600)?.let { excerpt ->
                            HorizontalDivider(color = StudyPalette.paperEdge)
                            Text(excerpt, color = StudyPalette.muted, fontSize = 15.sp, lineHeight = 22.sp,
                                maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } else {
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(32.dp).background(StudyPalette.inset, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { AstellaGlyph(AstellaGlyphKind.Refresh, Modifier.size(16.dp), tint = StudyPalette.muted) }
                        Column(Modifier.weight(1f).padding(start = 13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("第 ${version.optInt("versionNo", 1)} 版", color = StudyPalette.ink,
                                fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                            Text(versionDate(version.optString("createdAt")), color = StudyPalette.muted, fontSize = 12.sp)
                        }
                        AstellaTextButton(onClick = { selected = version }) { Text("恢复", fontWeight = FontWeight.SemiBold) }
                    }
                }
            }
            if (!loading && error == null && versions.size == 1) item {
                Text("当前只有这一版。后续保存会继续显示在这里。",
                    Modifier.padding(start = 12.dp, top = 1.dp), color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 19.sp)
            }
        }
    }
}

private fun versionDate(value: String?): String {
    if (value.isNullOrBlank()) return "保存时间未提供"
    return runCatching {
        java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("M 月 d 日 HH:mm"))
    }.getOrDefault("保存时间未提供")
}

internal fun featureFailure(cause: Throwable, fallback: String): String {
    val apiFailure = cause as? ApiFailure
    return when {
        apiFailure?.code == "ai_consent_required" -> "ai_consent_required"
        apiFailure?.code == "ai_data_policy_denied" -> "当前 AI 数据设置不允许这项整理，请在「我的 → AI 与数据」核对。"
        apiFailure?.status == 0 -> "暂时连接不上书房，请检查网络后重试。"
        apiFailure?.status == 401 -> "登录状态已过期，请重新登录。"
        apiFailure?.status == 403 -> "当前账号没有权限查看这项内容。"
        apiFailure?.status != null && apiFailure.status >= 500 -> "服务暂时忙不过来，请稍后重试。"
        apiFailure != null && apiFailure.message.any { it in '\u4e00'..'\u9fff' } -> apiFailure.message
        cause.message?.any { it in '\u4e00'..'\u9fff' } == true -> cause.message!!
        else -> fallback
    }
}

internal fun requiresAiConsent(message: String?): Boolean =
    message?.contains("ai_consent_required", ignoreCase = true) == true ||
        message?.contains("AI 使用协议", ignoreCase = true) == true ||
        message?.contains("AI 使用说明", ignoreCase = true) == true

internal fun requiresAiDataPolicy(message: String?): Boolean =
    message?.contains("ai_data_policy_denied", ignoreCase = true) == true ||
        message?.contains("AI 数据设置不允许", ignoreCase = true) == true ||
        message?.contains("AI 数据策略不允许", ignoreCase = true) == true

internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else List(length()) { optJSONObject(it) ?: JSONObject() }

internal fun failureMessage(reason: String): String = when (reason) {
    "ai_consent_required" -> "请先在账户页阅读并确认 AI 使用协议。确认前不会发送这篇手记。"
    "ai_data_policy_denied" -> "当前 AI 数据策略不允许这项整理，请到账户页核对设置。"
    "generation_incomplete" -> "这次整理没有完整完成，可以稍后重试。"
    else -> "这次整理没有完成，可以检查连接后重试。"
}
