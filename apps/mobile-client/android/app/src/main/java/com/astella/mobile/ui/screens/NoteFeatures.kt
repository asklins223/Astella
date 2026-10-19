package com.astella.mobile.ui.screens

import com.astella.mobile.ui.design.*

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.ApiFailure
import com.astella.mobile.data.NoteDocument
import com.astella.mobile.ui.design.NoticeSurface
import com.astella.mobile.ui.design.PaperSurface
import com.astella.mobile.ui.design.PageHeading
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

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
        if (kind != "versions" && state.aiSettings == null) viewModel.loadAccountSettings()
    }
    when (kind) {
        "versions" -> NoteVersionsScreen(noteId, state, viewModel, onBack, onAccount)
        "mindmap" -> NoteMindMapScreen(noteId, state, viewModel, onBack, onAccount)
        "explain" -> NoteExplainScreen(noteId, state, viewModel, onBack, onAccount)
        else -> NoteOverviewScreen(noteId, state, viewModel, onBack, onAccount)
    }
}

@Composable
private fun FeatureHeader(title: String, onBack: () -> Unit, onAccount: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        AstellaIconButton(onClick = onBack, modifier = Modifier.semantics { contentDescription = "返回$title" }) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(20.dp), tint = StudyPalette.ink)
        }
        Spacer(Modifier.weight(1f))
        AstellaIconButton(onClick = onAccount, modifier = Modifier.semantics { contentDescription = "我的账户" }) {
            AstellaGlyph(AstellaGlyphKind.Person, Modifier.size(19.dp), tint = StudyPalette.accent)
        }
    }
}

@Composable
private fun FeatureFailure(message: String, retry: () -> Unit, onAccount: (() -> Unit)? = null) {
    val consentRequired = message.contains("AI 使用协议", ignoreCase = true) ||
        message.contains("ai_consent_required", ignoreCase = true)
    val policyDisabled = requiresAiDataPolicy(message)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        AstellaGlyph(
            if (consentRequired) AstellaGlyphKind.Lock else AstellaGlyphKind.Alert,
            modifier = Modifier.padding(top = 2.dp).size(19.dp),
            tint = if (consentRequired) StudyPalette.accent else StudyPalette.danger,
        )
        Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                if (consentRequired) "这项整理需要你的授权" else if (policyDisabled) "外部 AI 已关闭" else "这次整理没有完成",
                color = StudyPalette.ink,
                fontWeight = FontWeight.SemiBold,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
            )
            Text(
                if (consentRequired) "请先在「我的 → AI 与数据」阅读协议，再由你决定是否同意。确认前不会发送这篇手记。"
                else if (policyDisabled) "账号的数据偏好已关闭外部 AI。你可以在设置中了解并自行调整；重新开启前不会提交这篇手记。"
                else message,
                color = StudyPalette.muted,
                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
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
private fun FeatureAuthorizationNotice(state: AppUiState, error: String?, onAccount: () -> Unit, retry: () -> Unit) {
    when {
        state.aiSettings?.requiresConsent == true || requiresAiConsent(error) ->
            FeatureFailure("ai_consent_required", retry = retry, onAccount = onAccount)
        state.aiSettings?.dataPolicy?.sendToExternal == false || requiresAiDataPolicy(error) ->
            FeatureFailure("ai_data_policy_denied", retry = retry, onAccount = onAccount)
        state.aiSettings == null && state.accountError != null ->
            FeatureFailure(state.accountError, retry = retry, onAccount = onAccount)
        state.aiSettings == null -> FeatureLoading("正在确认 AI 使用授权…")
    }
}

private fun featureFailure(cause: Throwable, fallback: String): String {
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

@Composable
private fun FeatureLoading(label: String) {
    Row(Modifier.fillMaxWidth().padding(25.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(19.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
        Text(label, Modifier.padding(start = 10.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
    }
}

private fun NoteDocument.firstReadableExcerpt(): String? {
    val candidates = blocks.asSequence()
        .filter { it.content.isNotBlank() && it.type !in setOf("image", "divider") }
        .map { it.content.trim().replace('\n', ' ').replace(Regex("\\s+"), " ") }
        .toList()
    return (candidates.firstOrNull { it.length >= 30 } ?: candidates.firstOrNull())
    ?.take(240)
}

@Composable
private fun FeatureGenerationPrimer(kind: String, document: NoteDocument?, modifier: Modifier = Modifier) {
    val title = when (kind) {
        "overview" -> "速览整理后会包含"
        "mindmap" -> "脑图会按层级展开"
        else -> "讲解会围绕原文推进"
    }
    val description = when (kind) {
        "overview" -> "提炼主线和要点，并保留可回看的原文出处。"
        "mindmap" -> "从这份手记提取主题、分支关系和原文出处。"
        else -> "按理解步骤展开，每一步都能对照对应段落。"
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("尚未生成 · 第 ${document?.versionNumber ?: 1} 版", color = StudyPalette.accent,
                style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(title, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(description, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, lineHeight = 24.sp)
        }
        if (document != null) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("原文节选 · 第 ${document.versionNumber} 版 · ${document.blocks.size} 个内容块", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                document.firstReadableExcerpt()?.let { excerpt ->
                    Row(verticalAlignment = Alignment.Top) {
                        androidx.compose.foundation.layout.Box(Modifier.padding(top = 2.dp).width(2.dp).height(50.dp).background(StudyPalette.accent.copy(alpha = .62f)))
                        Text("“$excerpt”", Modifier.padding(start = 10.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 21.sp, maxLines = 4, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                }
            }
        }
        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
        Column(Modifier.fillMaxWidth().padding(top = 3.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
        Text("内容结构 · 预览，不是生成结果", color = StudyPalette.muted,
            style = androidx.compose.material3.MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        when (kind) {
            "overview" -> {
                Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        listOf("主线", "关键点", "原文依据").forEachIndexed { index, label ->
                            Text(label, color = if (index == 0) StudyPalette.accent else StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.SemiBold, maxLines = 1)
                            if (index < 2) {
                                Text("/", color = StudyPalette.muted,
                                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    Text("图片覆盖情况会单独说明。", color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                }
            }
            "mindmap" -> {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("主题", Modifier.clip(RoundedCornerShape(StudyRadius.sm)).background(StudyPalette.sky)
                        .padding(horizontal = 11.dp, vertical = 7.dp), color = StudyPalette.accent,
                        style = androidx.compose.material3.MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Row(Modifier.padding(start = 16.dp), verticalAlignment = Alignment.Top) {
                        Column(Modifier.padding(end = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.width(1.dp).height(17.dp).background(StudyPalette.paperEdge))
                            Box(Modifier.width(1.dp).height(53.dp).background(StudyPalette.paperEdge))
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                            listOf("概念分支", "对应原文段落").forEach { label ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(Modifier.width(12.dp).height(1.dp).background(StudyPalette.paperEdge))
                                    Text(label, Modifier.padding(start = 9.dp), color = StudyPalette.ink,
                                        style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
            }
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    listOf("先说明主题", "再结合原文解释", "留下可回看的依据").forEachIndexed { index, label ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("%02d".format(index + 1), color = StudyPalette.accent,
                                style = androidx.compose.material3.MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                            Text(label, Modifier.padding(start = 12.dp), color = StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        }
        }
        Text("生成内容会另存为一份整理，不会改动原文。", color = StudyPalette.muted,
            style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun FeatureGenerateButton(label: String, busy: Boolean, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    AstellaButton(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().height(52.dp),
        shape = RoundedCornerShape(StudyRadius.xxl),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = StudyPalette.accent,
            contentColor = androidx.compose.ui.graphics.Color.White,
            disabledContainerColor = StudyPalette.inset,
            disabledContentColor = StudyPalette.muted,
        ),
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(17.dp), color = androidx.compose.ui.graphics.Color.White, strokeWidth = 2.dp)
        else AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(17.dp))
        Text(label, Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun NoteVersionsScreen(noteId: String, state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onAccount: () -> Unit) {
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
            text = { Text("当前内容会作为新版本保存，原来的记录仍会保留。") },
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
                }) { Text("恢复版本") }
            },
            dismissButton = { AstellaTextButton(onClick = { selected = null }) { Text("取消") } },
        )
    }

    Box(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { FeatureHeader("版本记录", onBack, onAccount) }
        item { PageHeading("保存轨迹", "版本记录", "恢复会另存为新版本，原来的内容仍会保留。") }
        if (error != null) item { FeatureFailure(error!!, retry = { scope.launch { load() } }, onAccount = onAccount) }
        if (loading && versions.isEmpty()) item { FeatureLoading("正在读取版本…") }
        if (!loading && versions.isEmpty() && error == null) item {
            PaperSurface(Modifier.fillMaxWidth(), padding = StudySpacing.xl) {
                Text("目前只有当前版本，还没有可回看的旧记录。", color = StudyPalette.muted, textAlign = TextAlign.Center)
            }
        }
        items(versions, key = { it.optString("id") }) { version ->
            val isCurrent = version.optString("id") == state.noteDocument?.versionId
            if (isCurrent) {
                PaperSurface(Modifier.fillMaxWidth(), padding = StudySpacing.lg) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.foundation.layout.Box(
                                Modifier.size(38.dp).background(StudyPalette.sky, androidx.compose.foundation.shape.CircleShape),
                                contentAlignment = Alignment.Center,
                            ) { AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(21.dp), tint = StudyPalette.accent) }
                            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                Text("第 ${version.optInt("versionNo", 1)} 版", color = StudyPalette.ink,
                                    style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text(formatFeatureDate(version.optString("createdAt")), Modifier.padding(top = 3.dp), color = StudyPalette.muted,
                                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            }
                            Text("当前", color = StudyPalette.accent, style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.SemiBold)
                        }
                        state.noteDocument.takeIf { it.id == noteId }?.firstReadableExcerpt()?.let { excerpt ->
                            androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                            Text(excerpt, color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                                lineHeight = 22.sp, maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        }
                    }
                }
            } else {
                Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.foundation.layout.Box(
                        Modifier.size(32.dp).background(StudyPalette.inset, androidx.compose.foundation.shape.CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { AstellaGlyph(AstellaGlyphKind.History, Modifier.size(16.dp), tint = StudyPalette.muted) }
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("第 ${version.optInt("versionNo", 1)} 版", color = StudyPalette.ink, fontWeight = FontWeight.SemiBold)
                        Text(formatFeatureDate(version.optString("createdAt")), Modifier.padding(top = 4.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    }
                    AstellaTextButton(onClick = { selected = version }) { Text("恢复") }
                }
                androidx.compose.material3.HorizontalDivider(Modifier.padding(start = 44.dp), color = StudyPalette.paperEdge)
            }
        }
        if (!loading && error == null && versions.size == 1) item {
            Column(Modifier.fillMaxWidth().padding(start = 44.dp, top = 10.dp, bottom = 18.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("目前只有这一版", color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold)
                Text("后续保存会继续接在这条轨迹里。", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                state.noteDocument?.takeIf { it.id == noteId }?.firstReadableExcerpt()?.let { excerpt ->
                    Text("“$excerpt”", Modifier.padding(top = 6.dp), color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                        lineHeight = 20.sp, maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                }
            }
        }
    }
}
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
    LaunchedEffect(state.aiSettings?.requiresConsent, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal &&
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
        if (state.aiSettings?.requiresConsent != false || !state.aiSettings.dataPolicy.sendToExternal) return
        val versionId = document?.versionId ?: return
        busy = true; error = null
        try {
            val created = viewModel.requestApi("/v2/notes/$noteId/overview-tasks", "POST",
                JSONObject().put("noteVersionId", versionId).put("requestId", java.util.UUID.randomUUID().toString()))
            task = created
            created.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) }
        } catch (cause: Throwable) {
            error = featureFailure(cause, "速览没有开始，请检查连接后重试。")
            if (requiresAiConsent(error)) viewModel.markAiConsentRequired()
            if (requiresAiDataPolicy(error)) viewModel.loadAccountSettings()
            busy = false
        }
    }

    LaunchedEffect(noteId, document?.versionId) { load() }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FeatureHeader("速览", onBack, onAccount)
            PageHeading("围绕当前手记", "速览", document?.title ?: "当前手记")
        }
        when {
            overview == null && (loading || busy) -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                FeatureLoading(if (busy) "正在整理这篇手记…" else "正在读取速览…")
            }
            overview == null -> Box(
                Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center,
            ) {
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() }
                    error?.takeUnless { requiresAiConsent(it) || requiresAiDataPolicy(it) }?.let { FeatureFailure(it, retry = { scope.launch { load() } }, onAccount = onAccount) }
                    FeatureGenerationPrimer(kind = "overview", document = document)
                }
            }
            else -> LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item { FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() } }
                if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) item { FeatureFailure(error!!, retry = { scope.launch { load() } }, onAccount = onAccount) }
                if (busy) item { FeatureLoading("正在整理这篇手记…") }
                val value = overview!!
                if (value.optString("versionState") == "older") item { FeatureNotice("这份速览基于第 ${value.optInt("noteVersionNumber")} 版，正文已更新。") }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(15.dp)) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("核心脉络", color = StudyPalette.accent, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                            Text(value.optString("body"), color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge, lineHeight = 28.sp)
                        }
                        val coverage = value.optJSONObject("coverage")
                        if ((coverage?.optInt("imageBlocksNotRead") ?: 0) > 0) {
                            androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                            Text("有图片内容没有纳入这次速览，请结合原文查看。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                        value.optJSONArray("points").objects().forEachIndexed { index, point ->
                            androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                            Row(verticalAlignment = Alignment.Top) {
                                Text("%02d".format(index + 1), color = StudyPalette.accent, fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                                Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                                    Text(point.optString("explanation"), color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, lineHeight = 25.sp)
                                    Text("“${point.optString("quote")}”", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 22.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
        FeatureGenerateButton(
            if (overview == null) "生成速览" else "按当前版本重新整理",
            busy,
            enabled = document != null && state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal && !requiresAiConsent(error) && !requiresAiDataPolicy(error),
            modifier = Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
        ) { scope.launch { generate() } }
    }
}

@Composable
private fun NoteMindMapScreen(noteId: String, state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onAccount: () -> Unit) {
    var map by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    LaunchedEffect(state.aiSettings?.requiresConsent, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal &&
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
        if (state.aiSettings?.requiresConsent != false || !state.aiSettings.dataPolicy.sendToExternal) return
        val versionId = document?.versionId ?: return
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
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FeatureHeader("脑图", onBack, onAccount)
            PageHeading("从主题看见关系", "脑图", document?.title ?: "当前手记")
        }
        when {
            map == null && (loading || busy) -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                FeatureLoading(if (busy) "正在整理思路…" else "正在读取脑图…")
            }
            map == null -> Box(
                Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center,
            ) {
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() }
                    error?.takeUnless { requiresAiConsent(it) || requiresAiDataPolicy(it) }?.let { FeatureFailure(it, retry = { scope.launch { load() } }, onAccount = onAccount) }
                    FeatureGenerationPrimer(kind = "mindmap", document = document)
                }
            }
            else -> LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() } }
                if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) item { FeatureFailure(error!!, retry = { scope.launch { load() } }, onAccount = onAccount) }
                if (busy) item { FeatureLoading("正在整理思路…") }
                val value = map!!
                if (value.optString("versionState") == "older") item { FeatureNotice("这张图基于第 ${value.optInt("noteVersionNumber")} 版。") }
                val content = value.optJSONObject("content")
                val nodes = content?.optJSONArray("nodes").objects()
                val root = content?.optString("rootId").orEmpty()
                val flattened = flattenNodes(nodes, root)
                items(flattened, key = { it.first.optString("id") }) { (node, depth) ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                        Row(verticalAlignment = Alignment.Top) {
                            Spacer(Modifier.width((depth * 15).dp))
                            androidx.compose.foundation.layout.Box(Modifier.padding(top = 5.dp).size(if (depth == 0) 10.dp else 7.dp).background(if (depth == 0) StudyPalette.accent else StudyPalette.muted.copy(alpha = .65f), androidx.compose.foundation.shape.CircleShape))
                            Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(node.optString("label"), color = StudyPalette.ink, fontWeight = FontWeight.SemiBold,
                                    style = if (node.optString("kind") == "root") androidx.compose.material3.MaterialTheme.typography.titleMedium else androidx.compose.material3.MaterialTheme.typography.bodyLarge)
                                node.optString("explanation").takeIf(String::isNotBlank)?.let { Text(it, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall) }
                                node.optJSONArray("references").objects().forEach { ref ->
                                    Text("“${ref.optString("quote")}”", color = StudyPalette.accent, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            }
        }
        FeatureGenerateButton(
            if (map == null) "生成脑图" else "按当前版本重新整理",
            busy,
            enabled = document != null && state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal && !requiresAiConsent(error) && !requiresAiDataPolicy(error),
            modifier = Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
        ) { scope.launch { generate() } }
    }
}

@Composable
private fun NoteExplainScreen(noteId: String, state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onAccount: () -> Unit) {
    var artifact by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var task by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    LaunchedEffect(state.aiSettings?.requiresConsent, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal &&
            (requiresAiConsent(error) || requiresAiDataPolicy(error))) error = null
    }

    suspend fun poll(taskId: String) {
        busy = true
        repeat(30) {
            try {
                val value = viewModel.requestApi("/v2/notes/$noteId/learning-artifact-tasks/$taskId")
                task = value
                value.optJSONObject("artifact")?.let { artifact = it }
                when (value.optString("status")) {
                    "ready" -> { busy = false; return }
                    "failed" -> { error = failureMessage(value.optString("failureReason")); busy = false; return }
                }
                delay(2_000)
            } catch (cause: Throwable) { error = featureFailure(cause, "讲解状态暂时无法读取，请检查连接后重试。"); busy = false; return }
        }
        busy = false; error = "讲解仍在后台准备。稍后重新打开此页即可接着查看。"
    }

    suspend fun load() {
        val versionId = document?.versionId ?: return
        loading = true; error = null
        try {
            val page = viewModel.requestApi("/v2/notes/$noteId/learning-artifact-tasks?noteVersionId=$versionId")
            val tasks = page.optJSONArray("items").objects().filter { it.optString("sourceKind") == "overview" }
            val latest = tasks.firstOrNull()
            task = latest
            artifact = latest?.optJSONObject("artifact")
            if (latest != null && latest.optString("status") in setOf("queued", "running")) latest.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) }
        } catch (cause: Throwable) { error = featureFailure(cause, "讲解暂时无法读取，请检查连接后重试。") }
        loading = false
    }

    suspend fun generate() {
        if (state.aiSettings?.requiresConsent != false || !state.aiSettings.dataPolicy.sendToExternal) return
        val versionId = document?.versionId ?: return
        busy = true; error = null
        try {
            val created = viewModel.requestApi("/v2/notes/$noteId/learning-artifact-tasks", "POST",
                JSONObject().put("noteVersionId", versionId).put("requestId", java.util.UUID.randomUUID().toString()).put("sourceKind", "overview"))
            task = created
            created.optString("taskId").takeIf(String::isNotBlank)?.let { poll(it) } ?: run { busy = false }
        } catch (cause: Throwable) {
            error = featureFailure(cause, "讲解没有开始，请检查连接后重试。")
            if (requiresAiConsent(error)) viewModel.markAiConsentRequired()
            if (requiresAiDataPolicy(error)) viewModel.loadAccountSettings()
            busy = false
        }
    }

    LaunchedEffect(noteId, document?.versionId) { load() }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FeatureHeader("讲解", onBack, onAccount)
            PageHeading("围绕原文逐步展开", "讲解", document?.title ?: "当前手记")
        }
        when {
            artifact == null && (loading || busy) -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                FeatureLoading(if (busy) "正在准备讲解…" else "正在读取讲解…")
            }
            artifact == null -> Box(
                Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center,
            ) {
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() }
                    error?.takeUnless { requiresAiConsent(it) || requiresAiDataPolicy(it) }?.let { FeatureFailure(it, retry = { scope.launch { load() } }, onAccount = onAccount) }
                    FeatureGenerationPrimer(kind = "explain", document = document)
                }
            }
            else -> LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { FeatureAuthorizationNotice(state, error, onAccount) { viewModel.loadAccountSettings() } }
                if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) item { FeatureFailure(error!!, retry = { scope.launch { load() } }, onAccount = onAccount) }
                if (busy) item { FeatureLoading("正在准备讲解…") }
                val value = artifact!!
                item {
                    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(value.optString("subject"), color = StudyPalette.ink, fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                        Text(value.optString("caution"), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        if (value.optString("versionState") == "older") Text("基于第 ${value.optInt("noteVersionNumber")} 版手记", color = StudyPalette.accent, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                    }
                }
                val outline = value.optJSONArray("outline").objects().sortedBy { it.optInt("index") }
                items(outline, key = { it.optInt("index") }) { step ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.foundation.layout.Box(Modifier.size(28.dp).background(StudyPalette.sky, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
                                Text("%02d".format(step.optInt("index") + 1), color = StudyPalette.accent, fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                            }
                            Text(step.optString("title"), Modifier.padding(start = 10.dp), color = StudyPalette.ink, fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
                        }
                        Text(step.optString("narration"), color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, lineHeight = 25.sp)
                        Text("“${step.optString("quote")}”", Modifier.padding(start = 38.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 22.sp)
                        androidx.compose.material3.HorizontalDivider(Modifier.padding(start = 38.dp), color = StudyPalette.paperEdge)
                    }
                }
            }
        }
        FeatureGenerateButton(
            if (artifact == null) "生成讲解" else "重新生成讲解",
            busy,
            enabled = document != null && state.aiSettings?.requiresConsent == false && state.aiSettings.dataPolicy.sendToExternal && !requiresAiConsent(error) && !requiresAiDataPolicy(error),
            modifier = Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
        ) { scope.launch { generate() } }
    }
}

@Composable
private fun FeatureNotice(text: String) {
    NoticeSurface(Modifier.fillMaxWidth(), padding = StudySpacing.md) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AstellaGlyph(AstellaGlyphKind.History, Modifier.size(16.dp), tint = StudyPalette.muted)
            Text(text, Modifier.padding(start = 8.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
        }
    }
}

private fun requiresAiConsent(message: String?): Boolean =
    message?.contains("ai_consent_required", ignoreCase = true) == true ||
        message?.contains("AI 使用协议", ignoreCase = true) == true ||
        message?.contains("AI 使用说明", ignoreCase = true) == true

private fun requiresAiDataPolicy(message: String?): Boolean =
    message?.contains("ai_data_policy_denied", ignoreCase = true) == true ||
        message?.contains("AI 数据设置不允许", ignoreCase = true) == true ||
        message?.contains("AI 数据策略不允许", ignoreCase = true) == true

private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else List(length()) { optJSONObject(it) ?: JSONObject() }

private fun flattenNodes(nodes: List<JSONObject>, rootId: String): List<Pair<JSONObject, Int>> {
    val result = mutableListOf<Pair<JSONObject, Int>>()
    val seen = mutableSetOf<String>()
    fun add(id: String, depth: Int) {
        if (!seen.add(id)) return
        val node = nodes.firstOrNull { it.optString("id") == id } ?: return
        result += node to depth
        nodes.filter { it.optString("parentId") == id }.forEach { add(it.optString("id"), depth + 1) }
    }
    add(rootId, 0)
    return result
}

private fun failureMessage(reason: String): String = when (reason) {
    "ai_consent_required" -> "请先在账户页阅读并确认 AI 使用协议。确认前不会发送这篇手记。"
    "ai_data_policy_denied" -> "当前 AI 数据策略不允许这项整理，请到账户页核对设置。"
    "generation_incomplete" -> "这次整理没有完整完成，可以稍后重试。"
    else -> "这次整理没有完成，可以检查连接后重试。"
}

private fun formatFeatureDate(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("yyyy年M月d日 · HH:mm"))
}.getOrDefault("保存时间未提供")
