@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private data class OrbitMemoryRecord(
    val id: String,
    val kind: String,
    val content: String,
    val appliesWhen: String?,
    val sourceSpeaker: String?,
    val sourceBasis: String?,
    val tier: String,
    val candidate: Boolean,
    val pinned: Boolean,
    val archived: Boolean,
    val revision: Int,
) {
    companion object {
        fun from(value: JSONObject): OrbitMemoryRecord? {
            val id = value.optString("memoryItemId").takeIf(String::isNotBlank) ?: return null
            val content = value.optString("content")
            return OrbitMemoryRecord(
                id = id,
                kind = value.optString("kind"),
                content = content,
                appliesWhen = value.stringOrNull("appliesWhen"),
                sourceSpeaker = value.stringOrNull("sourceSpeaker"),
                sourceBasis = value.stringOrNull("sourceBasis"),
                tier = value.optString("budgetTier"),
                candidate = value.optBoolean("candidate"),
                pinned = value.optBoolean("pinned"),
                archived = value.optBoolean("archived"),
                revision = value.optInt("revision", 1),
            )
        }
    }
}

private data class OrbitMemoryRevision(val id: String, val content: String, val author: String?, val createdAt: String?)

private data class RecycledMemory(val id: String, val kind: String, val content: String, val deletedAt: String, val purgeAfter: String) {
    companion object {
        fun from(value: JSONObject): RecycledMemory? {
            val id = value.optString("id").takeIf(String::isNotBlank) ?: return null
            return RecycledMemory(
                id, value.optString("kind"), value.optString("content"),
                value.optString("deletedAt"), value.optString("purgeAfter"),
            )
        }
    }
}

@Composable
fun OrbitMemoryDetailSheet(
    memoryId: String,
    viewModel: AppViewModel,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    var record by remember(memoryId) { mutableStateOf<OrbitMemoryRecord?>(null) }
    var revisions by remember(memoryId) { mutableStateOf<List<OrbitMemoryRevision>>(emptyList()) }
    var loading by remember(memoryId) { mutableStateOf(true) }
    var working by remember(memoryId) { mutableStateOf(false) }
    var error by remember(memoryId) { mutableStateOf<String?>(null) }
    var notice by remember(memoryId) { mutableStateOf<String?>(null) }
    var editing by remember(memoryId) { mutableStateOf(false) }
    var contentDraft by remember(memoryId) { mutableStateOf("") }
    var appliesWhenDraft by remember(memoryId) { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        loading = true; error = null
        try {
            val response = viewModel.requestApi("/companion/memory?focusMemoryId=$memoryId&includeCandidates=true&includeArchived=true")
            val items = response.optJSONArray("items")
            record = if (items == null) null else (0 until items.length())
                .mapNotNull { items.optJSONObject(it)?.let(OrbitMemoryRecord::from) }
                .firstOrNull { it.id == memoryId }
            record?.let { contentDraft = it.content; appliesWhenDraft = it.appliesWhen.orEmpty() }
            revisions = try {
                val rev = viewModel.requestApi("/companion/memory/$memoryId/revisions")
                val arr = rev.optJSONArray("items")
                if (arr == null) emptyList() else (0 until arr.length()).mapNotNull { index ->
                    arr.optJSONObject(index)?.let {
                        OrbitMemoryRevision(
                            id = it.optString("revisionId", it.optString("id")),
                            content = it.optString("content"),
                            author = it.optString("author").takeIf(String::isNotBlank),
                            createdAt = it.optString("createdAt").takeIf(String::isNotBlank),
                        )
                    }
                }
            } catch (_: Exception) { emptyList() }
        } catch (cause: Exception) { error = cause.message ?: "记忆没有加载成功，请稍后重试。" }
        loading = false
    }

    suspend fun action(name: String) {
        if (working) return
        working = true; error = null
        try {
            withContext(Dispatchers.IO) { viewModel.requestApi("/companion/memory/$memoryId/$name", "POST", JSONObject()) }
            notice = when (name) {
                "pin" -> "已固定。"
                "unpin" -> "已取消固定。"
                "archive" -> "已暂时停用这条记忆。"
                "restore" -> "已恢复使用。"
                else -> "已更新。"
            }
            load(); onChanged()
        } catch (cause: Exception) { error = cause.message ?: "记忆状态没有更新，请重试。" }
        working = false
    }

    LaunchedEffect(memoryId) { load() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = StudyPalette.canvas,
        contentColor = StudyPalette.ink,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.94f)) {
            SheetHeader("记忆详情", onDismiss)
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp).padding(top = 16.dp, bottom = 36.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                val item = record
                if (loading && item == null) {
                    Row(Modifier.fillMaxWidth().padding(28.dp), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                    }
                } else if (item == null) {
                    ShellNotice("找不到这条记忆", error ?: "它可能已被收回或超出当前工作区。", glyph = AstellaGlyphKind.Info)
                } else {
                    // 焦点头：类型 + 状态一次给全，内容 21/31 是唯一重心。
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(StudyRadius.xxl))
                            .background(StudyPalette.paper)
                            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xxl))
                            .padding(horizontal = 19.dp, vertical = 18.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            InlinePill(memoryKindLabel(item.kind), StudyPalette.sky, StudyPalette.accent)
                            Spacer(Modifier.weight(1f))
                            if (item.pinned) {
                                AstellaGlyph(AstellaGlyphKind.History, Modifier.padding(end = 5.dp).size(13.dp), tint = StudyPalette.accent)
                            }
                            Text(memoryStateShort(item), color = StudyPalette.muted, fontSize = 10.5.sp, maxLines = 1)
                        }
                        Text(
                            item.content,
                            color = StudyPalette.ink,
                            fontSize = 21.sp,
                            lineHeight = 31.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        if (item.sourceBasis == "inferred_from_statement" || item.sourceSpeaker == "companion") {
                            Row(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(StudyRadius.md))
                                    .background(StudyPalette.sky.copy(alpha = .62f))
                                    .padding(12.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                AstellaGlyph(AstellaGlyphKind.Info, Modifier.size(14.dp), tint = StudyPalette.accent)
                                Text(
                                    "这是她根据已有记录整理的理解，不是你亲口说的话。你可以先核对，再决定是否采用。",
                                    Modifier.padding(start = 8.dp),
                                    color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
                                )
                            }
                        }
                    }

                    // 依据：标签列 + 值列，不再用第二张等重卡片。
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(StudyRadius.xl))
                            .background(StudyPalette.paper.copy(alpha = .72f))
                            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .4f), RoundedCornerShape(StudyRadius.xl))
                            .padding(horizontal = 15.dp, vertical = 13.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("这条记忆的依据", color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .4.sp)
                        InfoLine("来源", when {
                            item.sourceSpeaker == "companion" -> "伴星整理"
                            item.sourceSpeaker == "user" -> "你的原话"
                            else -> item.sourceBasis ?: "相处里记下"
                        })
                        item.appliesWhen?.let { InfoLine("适用条件", it) }
                        InfoLine("状态", memoryStateLabel(item))
                    }

                    if (editing) {
                        Column(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(StudyRadius.lg))
                                .background(StudyPalette.paper)
                                .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .5f), RoundedCornerShape(StudyRadius.lg))
                                .padding(15.dp),
                            verticalArrangement = Arrangement.spacedBy(11.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("修订内容", color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .4.sp)
                                Spacer(Modifier.weight(1f))
                                Text("${contentDraft.length} / 200", color = StudyPalette.muted, fontSize = 10.5.sp)
                            }
                            Box(
                                Modifier.fillMaxWidth().heightIn(min = 108.dp)
                                    .clip(RoundedCornerShape(StudyRadius.md))
                                    .background(StudyPalette.inset.copy(alpha = .65f)).padding(13.dp),
                            ) {
                                BasicTextField(
                                    contentDraft,
                                    { if (it.length <= 200) contentDraft = it },
                                    textStyle = TextStyle(color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 23.sp),
                                    cursorBrush = SolidColor(StudyPalette.accent),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            Box(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(StudyRadius.md))
                                    .background(StudyPalette.inset.copy(alpha = .65f)).padding(13.dp),
                            ) {
                                if (appliesWhenDraft.isEmpty()) {
                                    Text("适用条件（选填）", color = StudyPalette.muted, fontSize = 13.sp)
                                }
                                BasicTextField(
                                    appliesWhenDraft,
                                    { appliesWhenDraft = it },
                                    textStyle = TextStyle(color = StudyPalette.ink, fontSize = 14.sp),
                                    cursorBrush = SolidColor(StudyPalette.accent),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                QuietTextAction("取消", onClick = { editing = false })
                                AstellaButton(
                                    onClick = {
                                        scope.launch {
                                            working = true; error = null
                                            try {
                                                withContext(Dispatchers.IO) {
                                                    viewModel.requestApi("/companion/memory/$memoryId/correct", "POST", JSONObject()
                                                        .put("content", contentDraft.trim())
                                                        .put("expectedRevision", item.revision)
                                                        .put("appliesWhen", appliesWhenDraft.trim().ifBlank { JSONObject.NULL }))
                                                }
                                                notice = "已保存修订，原始来源与旧版本仍保留。"
                                                editing = false
                                                load(); onChanged()
                                            } catch (cause: Exception) { error = cause.message ?: "记忆没有修订，请重试。" }
                                            working = false
                                        }
                                    },
                                    enabled = !working && contentDraft.trim().isNotEmpty() && contentDraft.trim() != item.content,
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(StudyRadius.md),
                                ) { Text(if (working) "正在保存…" else "保存修订") }
                            }
                        }
                    } else {
                        AstellaButton(
                            onClick = { editing = true },
                            enabled = !item.archived,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
                            shape = RoundedCornerShape(StudyRadius.lg),
                        ) {
                            AstellaGlyph(AstellaGlyphKind.Edit, Modifier.size(15.dp), tint = Color.White)
                            Text("修订这条记忆", Modifier.padding(start = 8.dp))
                        }
                    }

                    // 记忆操作排成一组行：先看内容再决定，危险操作永远在最后。
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            if (!item.archived) MemoryActionCell(
                                if (item.pinned) "取消固定" else "固定",
                                Modifier.weight(1f), !working,
                            ) { scope.launch { action(if (item.pinned) "unpin" else "pin") } }
                            MemoryActionCell(
                                if (item.archived) "恢复使用" else "暂时不用",
                                Modifier.weight(1f), !working,
                            ) { scope.launch { action(if (item.archived) "restore" else "archive") } }
                        }
                        SettingsGroup {
                            MemoryActionRow("标记有争议", glyph = AstellaGlyphKind.Alert, enabled = !working) {
                                scope.launch {
                                    working = true; error = null
                                    try {
                                        withContext(Dispatchers.IO) {
                                            viewModel.requestApi("/companion/memory/$memoryId/dispute", "POST", JSONObject().put("expectedRevision", item.revision))
                                        }
                                        notice = "已标记为有争议。"; load(); onChanged()
                                    } catch (cause: Exception) { error = cause.message ?: "争议状态没有更新，请重试。" }
                                    working = false
                                }
                            }
                            Hairline(startIndent = 16.dp, endIndent = 16.dp, alpha = .45f)
                            MemoryActionRow("删除到回收站", glyph = AstellaGlyphKind.Close, danger = true, enabled = !working) {
                                confirmDelete = true
                            }
                        }
                    }

                    if (revisions.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            ShellSectionHeader("修订记录", meta = "${revisions.size} 个版本")
                            SettingsGroup {
                                revisions.forEachIndexed { index, revision ->
                                    if (index > 0) SettingsDivider()
                                    Column(
                                        Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 12.dp),
                                        verticalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        Text(revision.content, color = StudyPalette.ink, fontSize = 13.5.sp, lineHeight = 21.sp)
                                        Text(
                                            listOfNotNull(revision.author, revision.createdAt?.let(::memoryDateLabel)).joinToString(" · ")
                                                .ifBlank { "此前的版本" },
                                            color = StudyPalette.muted, fontSize = 10.5.sp,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                error?.let {
                    if (item != null) ShellNotice("操作没有完成", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
                }
                notice?.let { ShellNotice("已更新", it, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success) }
            }
        }
    }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("将这条记忆移入回收站？") },
        text = { Text("移入回收站后仍可恢复，回收区内容之后可以永久清除。") },
        confirmButton = {
            AstellaTextButton(onClick = {
                confirmDelete = false
                scope.launch {
                    working = true
                    try {
                        withContext(Dispatchers.IO) { viewModel.requestApi("/companion/memory/$memoryId", "DELETE") }
                        onChanged(); onDismiss()
                    } catch (cause: Exception) { error = cause.message ?: "记忆没有移入回收站，请重试。" }
                    working = false
                }
            }) { Text("移入回收站", color = StudyPalette.danger) }
        },
        dismissButton = { AstellaTextButton(onClick = { confirmDelete = false }) { Text("取消") } },
    )
}

@Composable
fun OrbitMemoryRecycleSheet(
    viewModel: AppViewModel,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    var items by remember { mutableStateOf<List<RecycledMemory>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var confirmErase by remember { mutableStateOf<RecycledMemory?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        loading = true; error = null
        try {
            val response = viewModel.requestApi("/companion/memory/recycle")
            val arr = response.optJSONArray("items")
            items = if (arr == null) emptyList() else (0 until arr.length())
                .mapNotNull { arr.optJSONObject(it)?.let(RecycledMemory::from) }
        } catch (cause: Exception) { error = cause.message ?: "回收站暂时无法读取。" }
        loading = false
    }
    LaunchedEffect(Unit) { load() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = StudyPalette.canvas,
        contentColor = StudyPalette.ink,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.9f)) {
            SheetHeader("记忆回收站", onDismiss)
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp).padding(top = 16.dp, bottom = 36.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    "普通删除会把记忆放进回收站。恢复后会重新参与伴星的记忆检索；彻底清除后无法恢复。",
                    color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
                )
                if (loading) {
                    Row(Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                    }
                } else if (error != null) {
                    ShellNotice("回收站没有打开", error.orEmpty(), glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
                } else if (items.isEmpty()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(StudyRadius.xl))
                            .background(StudyPalette.paper)
                            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
                            .padding(horizontal = 18.dp, vertical = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(9.dp),
                    ) {
                        Box(
                            Modifier.size(36.dp).background(StudyPalette.sky.copy(alpha = .8f), RoundedCornerShape(11.dp)),
                            contentAlignment = Alignment.Center,
                        ) { AstellaGlyph(AstellaGlyphKind.History, Modifier.size(17.dp), tint = StudyPalette.accent) }
                        Text("回收站是空的", color = StudyPalette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold)
                        Text("移入回收站的记忆会显示在这里。", color = StudyPalette.muted, fontSize = 12.5.sp)
                    }
                } else items.forEach { memory ->
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(StudyRadius.lg))
                            .background(StudyPalette.paper)
                            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.lg))
                            .padding(horizontal = 15.dp, vertical = 13.dp),
                        verticalArrangement = Arrangement.spacedBy(9.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(memoryKindLabel(memory.kind), color = StudyPalette.accent, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.weight(1f))
                            Text("删除于 ${memoryDateLabel(memory.deletedAt)}", color = StudyPalette.muted, fontSize = 10.5.sp)
                        }
                        Text(memory.content, color = StudyPalette.ink, fontSize = 14.5.sp, lineHeight = 22.sp)
                        Text("预计清理：${memoryDateLabel(memory.purgeAfter)}", color = StudyPalette.muted, fontSize = 10.5.sp)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            AstellaButton(
                                onClick = {
                                    scope.launch {
                                        working = true
                                        try {
                                            withContext(Dispatchers.IO) { viewModel.requestApi("/companion/memory/${memory.id}/restore-deleted", "POST", JSONObject()) }
                                            notice = "已恢复记忆。"; load(); onChanged()
                                        } catch (cause: Exception) { error = cause.message ?: "记忆没有恢复，请重试。" }
                                        working = false
                                    }
                                },
                                enabled = !working,
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(StudyRadius.md),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                            ) { Text("恢复", fontSize = 13.5.sp) }
                            QuietTextAction(
                                "彻底清除",
                                onClick = { confirmErase = memory },
                                enabled = !working,
                            )
                        }
                    }
                }
                notice?.let { ShellNotice("已更新", it, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success) }
            }
        }
    }

    confirmErase?.let { memory ->
        AlertDialog(
            onDismissRequest = { confirmErase = null },
            title = { Text("彻底清除这条记忆？") },
            text = { Text("内容和修订历史都会被永久清除，无法恢复。") },
            confirmButton = {
                AstellaTextButton(onClick = {
                    confirmErase = null
                    scope.launch {
                        working = true
                        try {
                            withContext(Dispatchers.IO) { viewModel.requestApi("/companion/memory/${memory.id}/erase", "DELETE") }
                            notice = "已彻底清除。"; load(); onChanged()
                        } catch (cause: Exception) { error = cause.message ?: "记忆没有清除，请重试。" }
                        working = false
                    }
                }) { Text("彻底清除", color = StudyPalette.danger) }
            },
            dismissButton = { AstellaTextButton(onClick = { confirmErase = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun SheetHeader(title: String, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp).padding(top = 4.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
        GlassCircleButton(onClick = onDismiss, size = 34.dp) {
            AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(11.dp), tint = StudyPalette.muted)
        }
    }
    HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .55f))
}

@Composable
private fun InlinePill(text: String, background: Color, color: Color) {
    Box(
        Modifier.heightIn(min = 23.dp).clip(CircleShape).background(background)
            .padding(horizontal = 9.dp, vertical = 3.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, color = color, fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(label, Modifier.width(70.dp), color = StudyPalette.muted, fontSize = 11.5.sp)
        Text(value, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 12.5.sp, lineHeight = 19.sp)
    }
}

@Composable
private fun MemoryActionCell(label: String, modifier: Modifier = Modifier, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier.heightIn(min = 42.dp)
            .clip(RoundedCornerShape(StudyRadius.md))
            .background(StudyPalette.inset.copy(alpha = .62f))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = StudyPalette.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
}

@Composable
private fun MemoryActionRow(
    label: String,
    glyph: AstellaGlyphKind,
    danger: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 50.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AstellaGlyph(glyph, Modifier.size(15.dp), tint = if (danger) StudyPalette.danger else StudyPalette.muted)
        Text(
            label,
            Modifier.weight(1f).padding(start = 11.dp),
            color = if (danger) StudyPalette.danger else StudyPalette.ink,
            fontSize = 13.5.sp, fontWeight = FontWeight.Medium,
        )
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.muted.copy(alpha = .55f))
    }
}

private fun memoryKindLabel(kind: String): String = when (kind) {
    "preference" -> "相处偏好"
    "learning_context" -> "学习上下文"
    "judgment" -> "判断与看法"
    "interaction_note" -> "相处记录"
    "episodic" -> "相处插曲"
    "goal" -> "目标与方法"
    else -> "记忆"
}

private fun memoryStateShort(memory: OrbitMemoryRecord): String = when {
    memory.candidate -> "待确认"
    memory.archived -> "已归档"
    memory.tier == "resident" -> "固定 · 长期保留"
    else -> "已确认"
}

private fun memoryStateLabel(memory: OrbitMemoryRecord): String = when {
    memory.candidate -> "待确认 · 相处里记下"
    memory.archived -> "已归档"
    memory.tier == "resident" -> "固定 · 长期保留"
    else -> "已确认 · 相处里记下"
}

private fun memoryDateLabel(value: String): String {
    if (value.isBlank()) return "时间未提供"
    return runCatching {
        java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("M 月 d 日 HH:mm"))
    }.getOrDefault(value)
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)
