package com.astella.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.ApiFailure
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 拓展笔记：从当前手记长出可挑选的新手记。
 * 与 iOS `NoteExpansionDrawer` 同结构：已有拓展记录 + 草稿挑选 + 收下。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteExpansionSheet(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    visible: Boolean,
    onDismiss: () -> Unit,
    onAccount: () -> Unit,
    onOpenNote: (String) -> Unit,
) {
    if (!visible) return
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = StudyPalette.canvas,
        contentColor = StudyPalette.ink,
    ) {
        NoteExpansionContent(noteId, state, viewModel, onClose = onDismiss, onAccount = onAccount, onOpenNote = onOpenNote)
    }
}

@Composable
private fun NoteExpansionContent(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onClose: () -> Unit,
    onAccount: () -> Unit,
    onOpenNote: (String) -> Unit,
) {
    var task by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var drafts by remember(noteId) { mutableStateOf(emptyList<JSONObject>()) }
    var links by remember(noteId) { mutableStateOf(emptyList<JSONObject>()) }
    var loading by remember(noteId) { mutableStateOf(false) }
    var working by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    val status = task?.optString("status").orEmpty()
    val selectedIds = drafts.filter { it.optBoolean("selected") }.mapNotNull { it.optString("candidateId").takeIf(String::isNotBlank) }

    fun toggle(candidateId: String) {
        if (candidateId.isBlank()) return
        drafts = drafts.map { draft ->
            if (draft.optString("candidateId") == candidateId) JSONObject(draft.toString()).put("selected", !draft.optBoolean("selected"))
            else draft
        }
    }

    fun selectAll(selected: Boolean) {
        drafts = drafts.map { draft -> JSONObject(draft.toString()).put("selected", selected) }
    }

    suspend fun poll(taskId: String) {
        if (taskId.isBlank()) return
        working = true
        repeat(30) {
            try {
                val value = viewModel.requestApi("/v2/notes/$noteId/expansion-tasks/$taskId")
                task = value
                drafts = value.optJSONArray("drafts").objects()
                when (value.optString("status")) {
                    "ready", "confirmed" -> { working = false; return }
                    "failed" -> { error = failureMessage(value.optString("failureReason")); working = false; return }
                }
                delay(2_000)
            } catch (cause: Throwable) {
                error = featureFailure(cause, "拓展状态暂时无法读取，请检查连接后重试。")
                working = false
                return
            }
        }
        working = false
        error = "拓展仍在后台准备，稍后重新打开这里即可继续挑选。"
    }

    suspend fun load() {
        val versionId = document?.versionId ?: return
        loading = true; error = null
        try {
            val page = viewModel.requestApi("/v2/notes/$noteId/expansions")
            links = page.optJSONArray("items").objects()
            val receipt = viewModel.requestApi("/v2/notes/$noteId/expansion-tasks/latest?noteVersionId=$versionId")
            val latest = receipt.optJSONObject("task")
            task = latest
            drafts = latest?.optJSONArray("drafts").objects().orEmpty()
            if (latest != null && latest.optString("status") in setOf("queued", "running")) poll(latest.optString("taskId"))
        } catch (cause: Throwable) { error = featureFailure(cause, "拓展记录暂时无法读取，请检查连接后重试。") }
        loading = false
    }

    suspend fun generate() {
        val versionId = document?.versionId ?: return
        working = true; error = null
        try {
            val created = viewModel.requestApi("/v2/notes/$noteId/expansion-tasks", "POST", JSONObject()
                .put("noteVersionId", versionId)
                .put("requestId", UUID.randomUUID().toString()))
            task = created
            drafts = created.optJSONArray("drafts").objects()
            poll(created.optString("taskId"))
        } catch (cause: Throwable) {
            error = featureFailure(cause, "拓展没有开始，请检查连接后重试。")
            if (requiresAiConsent(error)) viewModel.markAiConsentRequired()
            if (requiresAiDataPolicy(error)) viewModel.loadAccountSettings()
            working = false
        }
    }

    suspend fun confirmSelected() {
        val taskId = task?.optString("taskId").orEmpty()
        if (taskId.isBlank() || selectedIds.isEmpty()) return
        working = true; error = null
        try {
            val review = JSONArray()
            drafts.forEach { draft ->
                review.put(JSONObject()
                    .put("candidateId", draft.optString("candidateId"))
                    .put("title", draft.optString("title"))
                    .put("blocks", draft.optJSONArray("blocks") ?: JSONArray())
                    .put("selected", draft.optBoolean("selected")))
            }
            val saved = viewModel.requestApi("/v2/notes/$noteId/expansion-tasks/$taskId/drafts", "PUT", JSONObject().put("drafts", review))
            task = saved
            drafts = saved.optJSONArray("drafts").objects()
            val stored = viewModel.requestApiArray("/v2/notes/$noteId/expansion-tasks/$taskId/confirm", "POST",
                JSONObject().put("candidateIds", JSONArray(selectedIds))).objects()
            links = stored + links
            task = JSONObject(saved.toString()).put("status", "confirmed")
        } catch (cause: Throwable) { error = featureFailure(cause, "这次拓展没有收下，请重试。") }
        working = false
    }

    LaunchedEffect(noteId, document?.versionId) {
        if (state.aiSettings == null) viewModel.loadAccountSettings()
        load()
    }
    LaunchedEffect(state.aiSettings?.needsSigning, state.aiSettings?.dataPolicy?.sendToExternal) {
        if (state.aiSettings?.needsSigning == false && state.aiSettings.dataPolicy.sendToExternal &&
            (requiresAiConsent(error) || requiresAiDataPolicy(error))) error = null
    }

    Column(Modifier.fillMaxWidth().fillMaxHeight(.92f)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 21.dp).padding(top = 8.dp, bottom = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("拓展笔记", color = StudyPalette.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                Text("从这篇手记长出可选择的新笔记", color = StudyPalette.muted, fontSize = 12.sp)
            }
            GlassCircleButton(onClick = onClose, size = 32.dp) {
                AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(12.dp), tint = StudyPalette.muted)
            }
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item { NoteFeatureSourceLine(document) }
            if (error != null && !requiresAiConsent(error) && !requiresAiDataPolicy(error)) {
                item { FeatureFailure(error!!, retry = { scope.launch { load() } }) }
            }
            if (requiresAiConsent(error) || requiresAiDataPolicy(error)) {
                item { FeatureAuthorizationNotice(state, error, onAccount = onAccount, retry = { scope.launch { load() } }) }
            }
            when {
                loading && task == null -> item { NoteFeatureLoadingState("正在读取拓展草稿") }
                working || status in setOf("queued", "running") -> item {
                    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        NoteFeatureLoadingState("正在围绕原文准备拓展")
                        Text("完成后会先给你草稿，由你挑选要收下的内容。", color = StudyPalette.muted, fontSize = 13.sp)
                    }
                }
                status == "ready" && drafts.isNotEmpty() -> {
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text("草稿 ${drafts.size} 篇", color = StudyPalette.ink, fontSize = 17.sp,
                                        fontWeight = FontWeight.SemiBold)
                                    Text("挑好后再收下，确认不动的草稿会留在原处。",
                                        color = StudyPalette.muted, fontSize = 11.5.sp)
                                }
                                AstellaTextButton(
                                    onClick = { selectAll(selectedIds.size != drafts.size) },
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                ) {
                                    Text(if (selectedIds.size == drafts.size && drafts.isNotEmpty()) "取消全选" else "全选")
                                }
                            }
                        }
                    }
                    itemsIndexed(drafts, key = { _, draft -> draft.optString("candidateId") }) { index, draft ->
                        val candidateId = draft.optString("candidateId")
                        ExpansionDraftCard(draft, index) { toggle(candidateId) }
                    }
                }
                else -> item { FeatureGenerationPrimer("expansion", document) }
            }
            if (links.isNotEmpty()) {
                item {
                    Text("已经从这篇手记拓展", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
                itemsIndexed(links, key = { _, link -> link.optString("expansionId") }) { _, link ->
                    ExpansionLinkRow(link) {
                        val target = if (link.optString("direction") == "source_note") link.optString("sourceNoteId") else link.optString("expandedNoteId")
                        if (target.isNotBlank()) { onClose(); onOpenNote(target) }
                    }
                }
            }
            if (status == "ready" && drafts.isNotEmpty() && links.isNotEmpty()) {
                item {
                    Text("收下后的新手记会接在上面的列表里，其余草稿仍可以继续挑选。",
                        color = StudyPalette.muted, fontSize = 13.sp)
                }
            } else if (status != "ready" && links.isNotEmpty()) {
                item { Text("还可以继续从当前版本生成新的拓展草稿。", color = StudyPalette.muted, fontSize = 13.sp) }
            }
        }
        NoteFeatureActionDock(
            actionTitle = if (status == "ready" && drafts.isNotEmpty()) "收下已选拓展 · ${selectedIds.size}"
            else if (task == null) "生成拓展草稿" else "再生成一组草稿",
            isWorking = working,
            isAvailable = if (status == "ready" && drafts.isNotEmpty()) selectedIds.isNotEmpty() else document != null,
            error = error,
            state = state,
            onAccount = onAccount,
            onReloadSettings = { viewModel.loadAccountSettings() },
            reserveOrb = true,
        ) {
            scope.launch {
                if (status == "ready" && drafts.isNotEmpty()) confirmSelected() else generate()
            }
        }
    }
}

@Composable
private fun ExpansionDraftCard(draft: JSONObject, index: Int, onToggle: () -> Unit) {
    val selected = draft.optBoolean("selected")
    val references = draft.optJSONArray("sourceReferences").objects()
    val blocks = draft.optJSONArray("blocks").objects()
    Column(
        Modifier.fillMaxWidth().astellaGlassCard(radius = 22)
            .clickable(onClick = onToggle)
            .padding(18.dp)
            .semantics {
                contentDescription = "${if (selected) "已选择" else "未选择"}拓展：${draft.optString("title", "草稿 ${index + 1}")}"
            },
        verticalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(13.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(26.dp)
                    .background(if (selected) StudyPalette.accent else StudyPalette.inset, CircleShape)
                    .border(
                        .8.dp,
                        if (selected) StudyPalette.accent else StudyPalette.paperEdge.copy(alpha = .8f),
                        CircleShape,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (selected) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(13.dp), tint = StudyPalette.canvas)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("草稿 ${index + 1}", color = StudyPalette.accent, fontSize = 10.5.sp,
                    fontWeight = FontWeight.SemiBold, letterSpacing = .8.sp)
                Text(draft.optString("title", "未命名拓展"), color = StudyPalette.ink,
                    fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
                Text(draft.optString("relationship"), color = StudyPalette.muted,
                    fontSize = 12.5.sp, lineHeight = 19.sp)
            }
        }
        if (references.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("原文依据", color = StudyPalette.muted, fontSize = 10.5.sp,
                    fontWeight = FontWeight.Medium, letterSpacing = .5.sp)
                references.forEach { reference ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                        Box(Modifier.width(2.dp).heightIn(min = 18.dp)
                            .background(StudyPalette.accent.copy(alpha = .5f), RoundedCornerShape(2.dp)))
                        Text("“${reference.optString("quote")}”", color = StudyPalette.muted,
                            fontSize = 12.5.sp, lineHeight = 19.sp)
                    }
                }
            }
        }
        if (blocks.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("草稿内容", color = StudyPalette.muted, fontSize = 10.5.sp,
                    fontWeight = FontWeight.Medium, letterSpacing = .5.sp)
                Text(
                    blocks.take(9).joinToString("\n\n") { it.optString("content") },
                    color = StudyPalette.ink.copy(alpha = .94f),
                    fontSize = 13.5.sp, lineHeight = 21.sp,
                    maxLines = 12, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ExpansionLinkRow(link: JSONObject, onOpen: () -> Unit) {
    val fromOther = link.optString("direction") == "source_note"
    Row(
        Modifier.fillMaxWidth().astellaGlassCard().clickable(onClick = onOpen).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Box(
            Modifier.size(38.dp).background(StudyPalette.sky, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) { AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(18.dp), tint = StudyPalette.accent) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(link.optString("otherNoteTitle", "拓展手记"), color = StudyPalette.ink,
                fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (fromOther) "从另一篇手记拓展而来" else "由这篇手记拓展",
                color = StudyPalette.muted, fontSize = 11.sp)
        }
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(14.dp), tint = StudyPalette.muted)
    }
}

/** 纸面：页面内的可点卡片，实色 + 发丝边，不仿苹果玻璃折射。 */
@Composable
internal fun Modifier.astellaGlassCard(radius: Int = 19) = this
    .background(StudyPalette.paper, RoundedCornerShape(radius.dp))
    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(radius.dp))
