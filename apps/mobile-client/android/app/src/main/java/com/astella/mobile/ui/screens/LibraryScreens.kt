@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.astella.mobile.ui.screens

import com.astella.mobile.ui.design.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.autofill.ContentType
import com.astella.mobile.R
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.AIDataPolicy
import com.astella.mobile.data.NoteBlock
import com.astella.mobile.data.NoteDocument
import com.astella.mobile.data.NoteAnnotation
import com.astella.mobile.data.NoteAnnotationAnchor
import com.astella.mobile.data.NoteSummary
import com.astella.mobile.data.optNullableString
import com.astella.mobile.ui.design.ConnectionFailureNotice
import com.astella.mobile.ui.design.CompanionPortrait
import com.astella.mobile.ui.design.NoticeSurface
import com.astella.mobile.ui.design.PaperSurface
import com.astella.mobile.ui.design.PageHeading
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.SectionEyebrow
import androidx.compose.ui.draw.shadow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

@Composable
fun HandScreen(state: AppUiState, viewModel: AppViewModel, onAccount: () -> Unit, onConversation: () -> Unit) {
    LaunchedEffect(Unit) { viewModel.refreshRuns(); if (state.notes.isEmpty()) viewModel.loadNotes("") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
        item { AstellaAppHeader(
            workspace = state.profile?.workspaceName ?: "随身书房",
            initial = state.profile?.displayName?.ifBlank { state.profile.email } ?: "我",
            onAccount = onAccount,
            edge = 0.dp,
            workspaces = state.workspaces,
            onWorkspace = viewModel::switchWorkspace,
        ) }
        item { PageHeading("继续未完的想法","手边","交给伴星的事，在这里接续。") }
        item { Surface(modifier = Modifier.astellaGlass(24.dp),color = Color.Transparent) {
            Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                AstellaStar(Modifier.padding(horizontal = 5.dp).size(27.dp,36.dp))
                Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(if (state.runs.isEmpty()) "现在，可以慢一点。" else "伴星正在替你整理", style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
                    Text(if (state.realtimeStatus == "已连接") "和你的书房连在一起" else state.realtimeStatus, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, color = StudyPalette.muted)
                }
                AstellaIconButton(onClick = onConversation, modifier = Modifier.semantics { contentDescription = "回到伴星身边" }) {
                    AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(20.dp), tint = StudyPalette.accent)
                }
            }
        } }
        state.error?.let { error -> item { ConnectionFailureNotice("连接暂时中断", error, "重新连接") { viewModel.loadConversation() } } }
        if (state.runs.isEmpty()) item {
            Column(Modifier.padding(vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("暂时没有待接续的事", style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("一个问题、一段原文，或者一份刚收到的资料，都可以交给伴星一起想。", style = androidx.compose.material3.MaterialTheme.typography.bodyLarge, color = StudyPalette.muted, lineHeight = 26.sp)
                AstellaTextButton(onClick = onConversation) { Text("和伴星聊聊") }
            }
        }
        items(state.runs, key = { it.id }) { run ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(36.dp).background(StudyPalette.sky, CircleShape).padding(8.dp), tint = StudyPalette.accent)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(run.statusLabel, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                    Text(run.thinkingText?.takeIf { it.isNotBlank() } ?: if (run.status == "waiting_for_confirmation") "先看看伴星准备的建议，再决定怎样继续。" else "整理完成后，会递回你们的对话里。", color = StudyPalette.muted)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        AstellaTextButton(onClick = onConversation) { Text("查看对话") }
                        AstellaTextButton(onClick = { viewModel.cancelActiveRuns() }) { Text("停止") }
                    }
                }
            }
        }
        items(state.messages.flatMap { it.blocks }.mapNotNull { it.proposalId }.distinct(), key = { it }) { CompanionProposalCard(it, viewModel) }
        state.notes.firstOrNull()?.let { note -> item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionEyebrow("也可以，接着上次的思路")
                Text(note.title, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                note.snippet?.let { Text(it, color = StudyPalette.muted, maxLines = 3) }
                AstellaTextButton(onClick = { viewModel.referenceNote(note.id); onConversation() }) { Text("带着这篇手记继续聊") }
            }
        } }
    }
}

@Composable
fun NotesScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onOpenNote: (String) -> Unit,
    onConversation: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var workspaceMenuOpen by remember { mutableStateOf(false) }
    var statusSheet by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val importPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(viewModel::selectFile)
    }
    LaunchedEffect(query) { delay(260); viewModel.loadNotes(query) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 21.dp, end = 21.dp, top = 14.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            PageHeading(
                eyebrow = "YOUR LITTLE UNIVERSE",
                title = "书房",
                subtitle = "已经留下的，随时回来读。",
                modifier = Modifier.padding(bottom = 18.dp),
                trailing = {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AstellaTap(
                            onClick = {
                                if (exporting) return@AstellaTap
                                val owner = state.profile?.isPersonalWorkspace == true ||
                                    state.workspaces.firstOrNull { it.id == state.profile?.workspaceId }?.role == "owner"
                                if (!owner) {
                                    Toast.makeText(context, "只有书房拥有者可以导出整间书房。", Toast.LENGTH_SHORT).show()
                                    return@AstellaTap
                                }
                                scope.launch {
                                    exporting = true
                                    try {
                                        shareExportedJson(context, viewModel.exportWorkspaceBackup())
                                    } catch (cause: Exception) {
                                        Toast.makeText(context, "书房备份没有生成：${cause.message ?: "请稍后重试。"}", Toast.LENGTH_LONG).show()
                                    } finally {
                                        exporting = false
                                    }
                                }
                            },
                            Modifier.size(40.dp).astellaGlass(20.dp, interactive = true),
                        ) {
                            if (exporting) CircularProgressIndicator(
                                Modifier.align(Alignment.Center).size(17.dp), strokeWidth = 2.dp, color = StudyPalette.accent,
                            )
                            else AstellaGlyph(AstellaGlyphKind.Download, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
                        }
                        AstellaTap(
                            onClick = { importPicker.launch(arrayOf("text/plain", "text/markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) },
                            Modifier.size(40.dp)
                                .background(
                                    Brush.linearGradient(listOf(StudyPalette.actionFill, StudyPalette.accent)),
                                    CircleShape,
                                )
                                .border(1.dp, Color.White.copy(alpha = .48f), CircleShape),
                        ) {
                            AstellaGlyph(AstellaGlyphKind.Add, Modifier.align(Alignment.Center).size(18.dp), tint = MaterialTheme.colorScheme.onPrimary)
                        }
                    }
                },
            )
        }
        item {
            Box(Modifier.fillMaxWidth().padding(bottom = 11.dp)) {
                AstellaTap(
                    onClick = { workspaceMenuOpen = true },
                    modifier = Modifier.fillMaxWidth().astellaGlass(18.dp, interactive = true),
                ) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 13.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        GlassIconTile(AstellaGlyphKind.Library, size = 34.dp)
                        Column(Modifier.weight(1f).padding(start = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(
                                state.profile?.workspaceName ?: "我的书房",
                                fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = StudyPalette.ink,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "${if (state.profile?.isPersonalWorkspace == true) "个人空间" else "协作空间"} · ${state.notes.size} 篇",
                                fontSize = 10.sp, color = StudyPalette.muted,
                            )
                        }
                        Text("切换", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = StudyPalette.accent)
                        Spacer(Modifier.width(3.dp))
                        AstellaGlyph(
                            AstellaGlyphKind.Chevron,
                            Modifier.size(10.dp).graphicsLayer { rotationZ = 90f },
                            tint = StudyPalette.accent,
                        )
                    }
                }
                androidx.compose.material3.DropdownMenu(
                    expanded = workspaceMenuOpen,
                    onDismissRequest = { workspaceMenuOpen = false },
                    shape = RoundedCornerShape(18.dp),
                    containerColor = StudyPalette.paper,
                ) {
                    state.workspaces.forEach { workspace ->
                        androidx.compose.material3.DropdownMenuItem(
                            text = { Text(if (workspace.id == state.profile?.workspaceId) "✓  ${workspace.name}" else workspace.name) },
                            onClick = { workspaceMenuOpen = false; viewModel.switchWorkspace(workspace) },
                        )
                    }
                }
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth().astellaGlass(22.dp, interactive = true)
                    .padding(horizontal = 16.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AstellaGlyph(AstellaGlyphKind.Search, Modifier.size(18.dp), tint = StudyPalette.muted)
                BasicTextField(
                    query, { query = it }, Modifier.weight(1f).padding(start = 10.dp), singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = StudyPalette.ink),
                    cursorBrush = SolidColor(StudyPalette.accent),
                    decorationBox = { inner ->
                        if (query.isEmpty()) Text("找手记、图片或一句话", fontSize = 15.sp, color = StudyPalette.muted)
                        inner()
                    },
                )
                if (query.isNotEmpty()) AstellaIconButton({ query = "" }, Modifier.size(22.dp)) {
                    AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(15.dp), tint = StudyPalette.muted)
                }
            }
        }
        state.selectedFile?.let { file ->
            item {
                Row(
                    Modifier.fillMaxWidth().padding(top = 12.dp).astellaGlass(18.dp, interactive = true).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(20.dp), tint = StudyPalette.accent)
                    Column(Modifier.weight(1f)) {
                        Text(file.name, color = StudyPalette.ink, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("导入到当前书房", color = StudyPalette.muted, fontSize = 10.sp)
                    }
                    AstellaTextButton(onClick = { viewModel.importPreparedFile() }, enabled = !state.isSending, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                        Text(if (state.isSending) "正在导入" else "存为手记", color = StudyPalette.accent, fontSize = 11.sp)
                    }
                    AstellaIconButton(onClick = viewModel::clearAttachment, modifier = Modifier.size(28.dp)) {
                        AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(14.dp), tint = StudyPalette.muted)
                    }
                }
            }
        }
        state.notesError?.let { error ->
            item {
                ConnectionFailureNotice(
                    title = "手记暂时没有接回来",
                    message = error,
                    retryLabel = "重新加载",
                    onRetry = { viewModel.loadNotes(query) },
                )
            }
        }
        if (state.isLoading && state.notes.isEmpty()) item {
            Row(Modifier.fillMaxWidth().padding(top = 68.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(22.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
                Text("正在找回手记", Modifier.padding(start = 10.dp), color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
            }
        } else if (state.notes.isEmpty() && state.notesError == null) item {
            Column(Modifier.fillMaxWidth().padding(top = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(28.dp), tint = StudyPalette.accent)
                Text(if (query.isEmpty()) "书架还空着" else "没有找到这篇手记", Modifier.padding(top = 16.dp), color = StudyPalette.ink,
                    fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                Text(if (query.isEmpty()) "和伴星聊出的学习成果，可以整理成手记，之后随时回来继续。" else "试试更短的关键词，或检查一下拼写。",
                    Modifier.padding(top = 6.dp, start = 18.dp, end = 18.dp), color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                if (query.isEmpty()) AstellaTextButton(onClick = onConversation, modifier = Modifier.padding(top = 8.dp)) {
                    Text("去对话里开始", color = StudyPalette.accent)
                }
            }
        } else {
            val recentNoteId = viewModel.recentNoteId()
            val visibleNotes = if (query.isBlank() && recentNoteId != null) {
                state.notes.sortedBy { if (it.id == recentNoteId) 0 else 1 }
            } else state.notes
            item {
                Row(
                    Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (query.isBlank()) state.profile?.workspaceName ?: "全部手记" else "搜索结果",
                        Modifier.weight(1f), color = StudyPalette.ink,
                        fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .6.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(if (query.isBlank()) "按最近更新" else "${visibleNotes.size} 篇",
                        color = StudyPalette.muted, fontSize = 10.5.sp)
                }
            }
            itemsIndexed(visibleNotes, key = { _, note -> note.id }) { index, note ->
                LaunchedEffect(note.id, state.notes.size, state.isLoading, state.isLoadingMoreNotes, state.notesNextCursor, query) {
                    if (index >= visibleNotes.size - 3 && !state.isLoading && !state.isLoadingMoreNotes) {
                        viewModel.loadMoreNotes(query)
                    }
                }
                Column(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpenNote(note.id) }
                            .padding(horizontal = 6.dp, vertical = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        NoteCover(note.title, Modifier.size(38.dp, 53.dp), note.id, rotate = 0f, textSize = 11.5.sp)
                        Column(Modifier.weight(1f).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text("手记", color = StudyPalette.muted, fontSize = 9.sp,
                                fontWeight = FontWeight.SemiBold, letterSpacing = 1.1.sp)
                            Text(note.title, color = StudyPalette.ink, fontSize = 17.sp, lineHeight = 23.sp,
                                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            note.snippet?.takeIf(String::isNotBlank)?.let { snippet ->
                                Text(snippet, color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                AstellaGlyph(AstellaGlyphKind.Clock, Modifier.size(11.dp), tint = StudyPalette.muted.copy(alpha = .8f))
                                Text(formatDate(note.updatedAt), color = StudyPalette.muted,
                                    fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        AstellaGlyph(
                            AstellaGlyphKind.Chevron,
                            Modifier.size(14.dp),
                            tint = StudyPalette.muted.copy(alpha = .7f),
                        )
                    }
                    if (index < visibleNotes.lastIndex) {
                        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .70f))
                    }
                }
            }
        }
        if (state.isLoadingMoreNotes) item { CircularProgressIndicator(Modifier.fillMaxWidth().padding(12.dp).size(22.dp), color = StudyPalette.accent) }
        item {
            AstellaTap(
                onClick = { statusSheet = true },
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp).height(54.dp)
                    .astellaGlass(20.dp, interactive = true),
            ) {
                Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                    AstellaGlyph(AstellaGlyphKind.Info, Modifier.size(15.dp), tint = StudyPalette.muted)
                    Text("资料与处理状态", Modifier.padding(start = 7.dp), color = StudyPalette.muted, fontSize = 12.5.sp)
                }
            }
        }
    }
    if (statusSheet) {
        androidx.compose.material3.ModalBottomSheet(
            onDismissRequest = { statusSheet = false },
            containerColor = StudyPalette.canvas,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("资料与处理状态", color = StudyPalette.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                StatusLine("书房", state.profile?.workspaceName ?: "我的书房")
                StatusLine("手记", "${state.notes.size} 篇 · ${if (query.isBlank()) "按最近更新" else "搜索结果"}")
                StatusLine("连接", state.realtimeStatus)
                StatusLine("本地导入", if (state.selectedFile == null) "没有待导入材料" else state.selectedFile?.name ?: "待导入")
                Text("文件与图片解析在本机完成；只有在你发送对话时才会上传原件。", color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 17.sp)
            }
        }
    }
}

internal fun shareExportedJson(context: Context, file: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "application/json"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "分享或存储文件"))
}

@Composable
private fun StatusLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(84.dp), color = StudyPalette.muted, fontSize = 12.sp)
        Text(value, color = StudyPalette.ink, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** 设计稿封面：竖排宋体书名、按手记稳定的纸色与细高光。 */
@Composable
fun NoteCover(
    title: String,
    modifier: Modifier = Modifier,
    seed: String = title,
    rotate: Float = -8f,
    textSize: androidx.compose.ui.unit.TextUnit = 12.sp,
) {
    val palette = listOf(
        StudyPalette.coverBlue, StudyPalette.coverSand, StudyPalette.coverOlive,
        StudyPalette.coverLilac, StudyPalette.coverSky,
    )
    val colors = palette[(seed.hashCode().ushr(1) % palette.size)]
    val shape = RoundedCornerShape(topStart = 3.dp, topEnd = 8.dp, bottomEnd = 8.dp, bottomStart = 3.dp)
    val innerShape = RoundedCornerShape(topStart = 1.dp, topEnd = 5.dp, bottomEnd = 5.dp, bottomStart = 1.dp)
    Box(
        modifier.graphicsLayer { rotationZ = rotate }
            .shadow(6.dp, shape, clip = false, ambientColor = Color(0xFF2A4062).copy(alpha = .14f), spotColor = Color(0xFF2A4062).copy(alpha = .16f))
            .clip(shape)
            .background(Brush.linearGradient(colors), shape)
            .border(.7.dp, Color.White.copy(alpha = .34f), shape),
    ) {
        Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(3.dp).background(Color.White.copy(alpha = .22f)))
        Box(Modifier.fillMaxSize().padding(4.dp).border(.6.dp, Color.White.copy(alpha = .20f), innerShape))
        Column(
            Modifier.fillMaxSize().padding(top = 7.dp, bottom = 7.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            val chars = title.filter { it.isLetterOrDigit() || it.code > 0x2E80 }.take(4)
            chars.forEach { ch ->
                Text(ch.toString(), color = Color.White.copy(alpha = .94f), fontFamily = FontFamily.Serif,
                    fontSize = textSize, lineHeight = textSize * 1.28f)
            }
        }
    }
}

@Composable
fun NoteDetailScreen(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onAccount: () -> Unit,
    onContinue: (NoteDocument) -> Unit,
    onOpenFeature: (String) -> Unit,
    onOpenNote: (String) -> Unit = {},
) {
    LaunchedEffect(noteId) { viewModel.loadNote(noteId) }
    val document = state.noteDocument?.takeIf { it.id == noteId }
    val summary = state.notes.firstOrNull { it.id == noteId }
    var drawerBlock by remember(document?.versionId) { mutableStateOf<NoteBlock?>(null) }
    var drawerAnnotation by remember { mutableStateOf<NoteAnnotation?>(null) }
    var editingNewAnnotation by remember { mutableStateOf(false) }
    var expandedAnnotations by rememberSaveable(noteId) { mutableStateOf<Int?>(null) }
    var drawerDetentExpanded by remember { mutableStateOf(false) }
    var selectionOriginal by remember { mutableStateOf<String?>(null) }
    var selectionBaseline by remember { mutableStateOf<Set<String>>(emptySet()) }
    var actionsExpanded by rememberSaveable(noteId) { mutableStateOf(false) }
    var readingScaleExpanded by rememberSaveable(noteId) { mutableStateOf(false) }
    var showVersions by rememberSaveable(noteId) { mutableStateOf(false) }
    var showExpansion by rememberSaveable(noteId) { mutableStateOf(false) }
    var showLearningCard by rememberSaveable(noteId) { mutableStateOf(false) }
    var didRestoreReadingPosition by remember(noteId) { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val actionsSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(document?.versionId) {
        val current = document ?: return@LaunchedEffect
        didRestoreReadingPosition = false
        val savedOrdinal = viewModel.savedNoteReadingBlock(noteId)
        val savedIndex = savedOrdinal?.let { ordinal -> current.blocks.indexOfFirst { it.ordinal == ordinal } }
            ?.takeIf { it >= 0 }
        if (savedIndex != null) listState.scrollToItem(savedIndex + 2)
        viewModel.recordNoteOpened(noteId)
        didRestoreReadingPosition = true
    }
    LaunchedEffect(document?.versionId, didRestoreReadingPosition) {
        val current = document ?: return@LaunchedEffect
        if (!didRestoreReadingPosition) return@LaunchedEffect
        snapshotFlow { listState.firstVisibleItemIndex }.distinctUntilChanged().collect { index ->
            current.blocks.getOrNull(index - 2)?.let { viewModel.saveNoteReadingBlock(noteId, it.ordinal) }
        }
    }
    LaunchedEffect(state.annotationStatus) {
        if (state.annotationStatus != null && drawerAnnotation == null) editingNewAnnotation = false
    }
    LaunchedEffect(document?.versionId, state.noteAnnotations) {
        val anchor = drawerAnnotation?.anchor ?: return@LaunchedEffect
        state.noteAnnotations.firstOrNull { it.anchor == anchor }?.let { drawerAnnotation = it }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 27.dp, end = 27.dp, top = 82.dp, bottom = 116.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            if (document == null) item {
                Column(Modifier.fillMaxWidth().padding(top = 35.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (state.noteError != null) {
                        ConnectionFailureNotice(
                            title = "这篇手记暂时打不开",
                            message = state.noteError,
                            retryLabel = "重新加载",
                            onRetry = { viewModel.loadNote(noteId) },
                        )
                    } else CircularProgressIndicator(Modifier.size(24.dp), color = StudyPalette.accent)
                }
            } else {
                item {
                    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 24.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(13.dp), tint = StudyPalette.accent)
                            val space = state.profile?.let { if (it.isPersonalWorkspace) "个人书房" else it.workspaceName } ?: "书房"
                            Text(
                                "手记 · 第 ${document.versionNumber} 版 · $space",
                                Modifier.padding(start = 7.dp),
                                color = StudyPalette.muted,
                                fontSize = 11.5.sp,
                                letterSpacing = .3.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            document.title,
                            Modifier.padding(top = 16.dp),
                            color = StudyPalette.ink,
                            fontFamily = FontFamily.Serif,
                            fontSize = 39.sp,
                            lineHeight = 48.sp,
                            letterSpacing = 3.sp,
                            fontWeight = FontWeight.Normal,
                        )
                        summary?.snippet?.trim()?.takeIf { it.isNotEmpty() }?.let { snippet ->
                            Text(
                                snippet,
                                Modifier.padding(top = 11.dp),
                                color = StudyPalette.muted,
                                fontSize = 13.sp,
                                lineHeight = 19.sp,
                            )
                        }
                    }
                }
                item(key = "current-version") {
                    ReaderVersionRow(document, summary, onClick = { showVersions = true })
                }
                items(document.blocks, key = { it.ordinal }) { block ->
                    val blockAnnotations = state.noteAnnotations
                        .filter {
                            it.versionState == "current" &&
                                it.anchor.noteVersionId == document.versionId &&
                                it.anchor.endBlockOrdinal == block.ordinal
                        }
                        .sortedWith(compareBy({ it.anchor.startOffset }, { it.id }))
                    val bottomPadding = when {
                        blockAnnotations.isNotEmpty() -> 8.dp
                        block.type == "heading" -> 14.dp
                        else -> 25.dp
                    }
                    Column {
                        val annotateBlock = {
                            viewModel.clearAnnotationNotice()
                            drawerBlock = block
                            drawerAnnotation = null
                            editingNewAnnotation = true
                            drawerDetentExpanded = true
                        }
                        val selectBlock: (String, Boolean) -> Unit = { selected, rewrite ->
                            selectionOriginal = selected
                            selectionBaseline = state.messages.map { it.id }.toSet()
                            viewModel.askAboutSelection(selected, document, rewrite)
                        }
                        if (block.type == "quote") {
                            Row(
                                Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(bottom = bottomPadding),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Box(
                                    Modifier.width(3.dp).fillMaxHeight()
                                        .background(StudyPalette.accent.copy(alpha = .6f), RoundedCornerShape(2.dp)),
                                )
                                CompanionSelectableText(
                                    block.content.replace(Regex("(?m)^\\s*>\\s?"), "").trim(),
                                    16f * state.readingScale,
                                    serif = true,
                                    italic = true,
                                    color = StudyPalette.muted,
                                    lineSpacingMultiplier = 1.58f,
                                    onOpenNote = onOpenNote,
                                    onAnnotate = annotateBlock,
                                    onSelection = selectBlock,
                                )
                            }
                        } else if (block.type in setOf("paragraph", "heading")) {
                            Column(Modifier.padding(bottom = bottomPadding)) {
                                val heading = block.type == "heading"
                                val body = if (heading) noteHeadingText(block.content) else block.content.trim()
                                CompanionSelectableText(
                                    if (heading) body else "　　$body",
                                    (if (heading) 22f else 16f) * state.readingScale,
                                    serif = true,
                                    color = StudyPalette.readerInk,
                                    lineSpacingMultiplier = if (heading) 1.32f else 1.58f,
                                    onOpenNote = onOpenNote,
                                    onAnnotate = annotateBlock,
                                    onSelection = selectBlock,
                                )
                            }
                        } else Box(Modifier.padding(bottom = bottomPadding)) {
                            NoteBlockRow(
                                block = block,
                                readingScale = state.readingScale,
                                viewModel = viewModel,
                                onAnnotate = {
                                    viewModel.clearAnnotationNotice()
                                    drawerBlock = block
                                    drawerAnnotation = null
                                    editingNewAnnotation = true
                                    drawerDetentExpanded = true
                                },
                                onExplain = {
                                    NoteAnnotationAnchor.wholeBlock(block, document.versionId)?.let { anchor ->
                                        viewModel.clearAnnotationNotice()
                                        drawerBlock = block
                                        drawerAnnotation = null
                                        editingNewAnnotation = false
                                        drawerDetentExpanded = true
                                        viewModel.explainNoteAnnotation(noteId, anchor)
                                    } ?: run {
                                        viewModel.clearAnnotationNotice()
                                        viewModel.reportAnnotationError("这段内容暂时无法精确对应到手记原文。")
                                    }
                                },
                            )
                        }
                        if (blockAnnotations.isNotEmpty()) {
                            AnnotationPlacement(
                                annotations = blockAnnotations,
                                expanded = expandedAnnotations == block.ordinal,
                                onToggleExpanded = {
                                    expandedAnnotations = if (expandedAnnotations == block.ordinal) null else block.ordinal
                                },
                                onOpen = { annotation ->
                                    viewModel.clearAnnotationNotice()
                                    drawerBlock = block
                                    drawerAnnotation = annotation
                                    editingNewAnnotation = false
                                    drawerDetentExpanded = true
                                },
                            )
                        }
                    }
                }
                if (state.annotationError != null && state.noteAnnotations.isEmpty()) item {
                    Row(Modifier.fillMaxWidth().padding(top = 13.dp), verticalAlignment = Alignment.Top) {
                        AstellaGlyph(AstellaGlyphKind.Alert, Modifier.padding(top = 2.dp).size(18.dp), tint = StudyPalette.danger)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(state.annotationError.orEmpty(), color = StudyPalette.danger,
                                style = MaterialTheme.typography.bodySmall)
                            AstellaTextButton(onClick = { viewModel.retryNoteAnnotations(noteId) }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text("重新读取批注")
                            }
                        }
                    }
                }
            }
        }
        Row(
            Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.resultReturnTo != null) AstellaTextButton(onClick = onBack) { Text("返回手记与预览", style = MaterialTheme.typography.labelMedium) }
            else AstellaTap(
                onClick = onBack,
                modifier = Modifier.size(44.dp).astellaGlass(22.dp, interactive = true)
                    .semantics { contentDescription = "返回书房" },
            ) {
                AstellaGlyph(AstellaGlyphKind.Back, Modifier.align(Alignment.Center).size(20.dp), tint = StudyPalette.ink)
            }
            Text(
                document?.let { "第 ${it.versionNumber} 版 · 一起读" } ?: "手记",
                Modifier.weight(1f), color = StudyPalette.muted, textAlign = TextAlign.Center,
                fontSize = 12.sp, letterSpacing = .2.sp, fontWeight = FontWeight.Medium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(
                Modifier.height(44.dp).astellaGlass(22.dp, interactive = true).padding(horizontal = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AstellaTap(onClick = { readingScaleExpanded = true }, modifier = Modifier.size(40.dp)) {
                    Text("T", Modifier.align(Alignment.Center), color = StudyPalette.ink,
                        fontSize = 17.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.Serif)
                }
                AstellaTap(
                    onClick = { actionsExpanded = true },
                    modifier = Modifier.size(40.dp).semantics { contentDescription = "手记操作" },
                ) {
                    AstellaGlyph(AstellaGlyphKind.Grid, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
                }
            }
        }
    }
    if (selectionOriginal != null) ModalBottomSheet(onDismissRequest = { selectionOriginal = null; viewModel.loadNote(noteId) }, containerColor = StudyPalette.canvas) {
        LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(.9f), contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item { Text("一起读这一段", style = androidx.compose.material3.MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
            item { Text(selectionOriginal.orEmpty(), Modifier.fillMaxWidth().background(StudyPalette.inset, RoundedCornerShape(16.dp)).padding(16.dp), color = StudyPalette.muted) }
            items(state.messages.filter { it.id !in selectionBaseline && it.role == "assistant" && state.selectionRunId != null && it.runId == state.selectionRunId }, key = { it.id }) { MobileMessageRow(it, viewModel) }
            if (state.streamingText.isNotEmpty() && state.selectionRunId != null && state.streamingRunId == state.selectionRunId) item { CompanionMarkdownText(state.streamingText, fontSize = 15.sp, lineHeight = 26.sp, color = StudyPalette.ink) }
            if (state.isSending || state.runs.isNotEmpty()) item { Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Text("伴星正在读原文…", Modifier.padding(start = 10.dp), color = StudyPalette.muted)
            } }
            state.error?.let { error -> item { Text(error, color = StudyPalette.danger) } }
        }
    }

    if (actionsExpanded) {
        ModalBottomSheet(
            onDismissRequest = { actionsExpanded = false },
            sheetState = actionsSheetState,
            containerColor = StudyPalette.paper,
            contentColor = StudyPalette.ink,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 24.dp)) {
                Text("这篇手记", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold)
                val tools = listOf(
                    Triple("overview", "速览", "doc.text.magnifyingglass"),
                    Triple("mindmap", "脑图", "point.3.connected.trianglepath.dotted"),
                    Triple("versions", "版本", "clock.arrow.circlepath"),
                    Triple("expansion", "拓展笔记", "sparkle.magnifyingglass"),
                    Triple("learning-card", "学习卡", "rectangle.on.rectangle.angled"),
                )
                tools.forEachIndexed { index, (kind, label, symbol) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                            actionsExpanded = false
                            when (kind) {
                                "versions" -> showVersions = true
                                "expansion" -> showExpansion = true
                                "learning-card" -> showLearningCard = true
                                else -> onOpenFeature(kind)
                            }
                        },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, Modifier.weight(1f), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge)
                        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(15.dp), tint = StudyPalette.muted)
                    }
                    if (index < tools.size - 1) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                }
                androidx.compose.material3.HorizontalDivider(Modifier.padding(top = 4.dp), color = StudyPalette.paperEdge)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                        actionsExpanded = false
                        document?.let(onContinue)
                    },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AstellaGlyph(AstellaGlyphKind.Chat, Modifier.padding(end = 12.dp).size(18.dp), tint = StudyPalette.accent)
                    Text("在对话里继续提问", Modifier.weight(1f), color = StudyPalette.ink,
                        style = androidx.compose.material3.MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }
    if (readingScaleExpanded) {
        ModalBottomSheet(
            onDismissRequest = { readingScaleExpanded = false },
            containerColor = StudyPalette.paper,
            contentColor = StudyPalette.ink,
        ) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 26.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("阅读字号", color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold)
                Text("只调整手记正文，偏好保存在这台设备。", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    listOf(1f to "标准", 1.2f to "较大", 1.4f to "大字").forEach { (scale, label) ->
                        val selected = state.readingScale == scale
                        Surface(
                            modifier = Modifier.weight(1f).clickable { viewModel.setReadingScale(scale) },
                            shape = RoundedCornerShape(15.dp),
                            color = if (selected) StudyPalette.sky else StudyPalette.inset.copy(alpha = .6f),
                            border = androidx.compose.foundation.BorderStroke(
                                .8.dp, if (selected) StudyPalette.accent.copy(alpha = .4f) else StudyPalette.paperEdge.copy(alpha = .55f),
                            ),
                        ) {
                            Text(label, Modifier.padding(horizontal = 10.dp, vertical = 12.dp),
                                textAlign = TextAlign.Center,
                                color = if (selected) StudyPalette.accent else StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                        }
                    }
                }
                Text("预览", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium)
                Text("苏轼夜游赤壁，在清风与明月间慢慢读到天地的变化。",
                    color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                        fontFamily = FontFamily.Serif,
                        fontSize = 17.sp * state.readingScale,
                        lineHeight = 29.sp * state.readingScale,
                    ))
            }
        }
    }
    NoteVersionsSheet(
        noteId = noteId,
        state = state,
        viewModel = viewModel,
        visible = showVersions,
        onDismiss = { showVersions = false },
    )
    NoteExpansionSheet(
        noteId = noteId,
        state = state,
        viewModel = viewModel,
        visible = showExpansion,
        onDismiss = { showExpansion = false },
        onAccount = onAccount,
        onOpenNote = onOpenNote,
    )
    // 学习卡是独立整页导航，不再用底部抽屉；进入时轻推入、返回时滑出。
    val motion = enabledMotion()
    androidx.compose.animation.AnimatedVisibility(
        visible = showLearningCard,
        enter = androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(if (motion) 180 else 0)) +
            androidx.compose.animation.slideInHorizontally(androidx.compose.animation.core.tween(if (motion) 280 else 0)) { it / 6 },
        exit = androidx.compose.animation.fadeOut(androidx.compose.animation.core.tween(if (motion) 150 else 0)) +
            androidx.compose.animation.slideOutHorizontally(androidx.compose.animation.core.tween(if (motion) 220 else 0)) { it / 8 },
    ) {
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().background(StudyPalette.canvas)) {
            NoteLearningCardScreen(
                noteId = noteId,
                state = state,
                viewModel = viewModel,
                onClose = { showLearningCard = false },
                onAccount = onAccount,
            )
        }
    }
    drawerBlock?.let { block ->
        val anchor = NoteAnnotationAnchor.wholeBlock(block, document?.versionId.orEmpty())
        if (anchor != null) NoteAnnotationsDrawer(
            noteId = noteId,
            block = block,
            anchor = anchor,
            annotation = drawerAnnotation,
            editingNew = editingNewAnnotation,
            state = state,
            viewModel = viewModel,
            onActiveAnnotation = { annotation ->
                drawerAnnotation = annotation
                editingNewAnnotation = false
            },
            onLocate = { ordinal ->
                drawerBlock = null
                drawerAnnotation = null
                val index = document?.blocks?.indexOfFirst { it.ordinal == ordinal } ?: -1
                if (index >= 0) scope.launch { listState.animateScrollToItem(index + 2) }
            },
            onDismiss = {
                if (!state.isAnnotationBusy) {
                    drawerBlock = null
                    drawerAnnotation = null
                    editingNewAnnotation = false
                }
            },
        )
    }
}

@Composable
private fun AnnotationPlacement(
    annotations: List<NoteAnnotation>,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onOpen: (NoteAnnotation) -> Unit,
) {
    fun kindLabel(annotation: NoteAnnotation): String =
        if (annotation.sourceMessageId != null) "伴星讲解" else "我的批注"
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 18.dp)) {
        Row(
            Modifier.clip(CircleShape)
                .background(StudyPalette.sky.copy(alpha = .5f))
                .clickable { if (annotations.size == 1) onOpen(annotations[0]) else onToggleExpanded() }
                .padding(horizontal = 11.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            AstellaGlyph(AstellaGlyphKind.Quote, Modifier.size(11.dp), tint = StudyPalette.accent)
            Text(
                if (annotations.size == 1) kindLabel(annotations[0]) else "${annotations.size} 条批注",
                color = StudyPalette.accent,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (annotations.size > 1) {
                AstellaGlyph(
                    if (expanded) AstellaGlyphKind.Chevron else AstellaGlyphKind.Chevron,
                    Modifier.size(9.dp).graphicsLayer { if (expanded) rotationZ = -90f else rotationZ = 0f },
                    tint = StudyPalette.accent,
                )
            }
        }
        if (annotations.size > 1 && expanded) {
            Column(Modifier.padding(start = 8.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                annotations.forEach { annotation ->
                    Row(
                        Modifier.fillMaxWidth()
                            .background(StudyPalette.paper.copy(alpha = .66f), RoundedCornerShape(13.dp))
                            .border(0.7.dp, StudyPalette.paperEdge.copy(alpha = .52f), RoundedCornerShape(13.dp))
                            .clickable { onOpen(annotation) }
                            .padding(horizontal = 11.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier.padding(top = 5.dp).size(6.dp).background(StudyPalette.accent.copy(alpha = .78f), CircleShape),
                        )
                        Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(kindLabel(annotation), color = StudyPalette.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            Text(annotation.anchor.excerpt.replace('\n', ' '), color = StudyPalette.muted,
                                fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            if (annotation.explanation.isNotBlank()) {
                                Text(annotation.explanation.replace('\n', ' '), color = StudyPalette.muted.copy(alpha = .88f),
                                    fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.padding(top = 3.dp).size(11.dp), tint = StudyPalette.muted.copy(alpha = .7f))
                    }
                }
            }
        }
    }
}

@Composable
private fun NoteAnnotationsDrawer(
    noteId: String,
    block: NoteBlock,
    anchor: NoteAnnotationAnchor,
    annotation: NoteAnnotation?,
    editingNew: Boolean,
    state: AppUiState,
    viewModel: AppViewModel,
    onActiveAnnotation: (NoteAnnotation) -> Unit,
    onLocate: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    var editing by remember(annotation?.id, editingNew) { mutableStateOf(editingNew || annotation == null) }
    var draft by remember(annotation?.id, editingNew) { mutableStateOf(annotation?.explanation.orEmpty()) }
    var confirmRemoval by remember { mutableStateOf(false) }
    val busy = state.isAnnotationBusy
    val isCompanionExplanation = annotation?.sourceMessageId != null
    val title = when {
        annotation == null -> "给这段原文留批注"
        isCompanionExplanation -> "伴星讲解"
        else -> "我的批注"
    }

    LaunchedEffect(annotation?.id) {
        if (annotation != null && !editingNew) {
            draft = annotation.explanation
            editing = false
        }
    }
    LaunchedEffect(state.annotationStatus) {
        val status = state.annotationStatus ?: return@LaunchedEffect
        if (status.contains("伴星已经把讲解贴回") || (editingNew && status.contains("批注"))) {
            state.noteAnnotations.filter { it.anchor == anchor }.maxByOrNull { it.id }?.let {
                onActiveAnnotation(it)
                draft = it.explanation
                editing = false
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = StudyPalette.canvas,
        contentColor = StudyPalette.ink,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.92f)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 21.dp).padding(top = 17.dp, bottom = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(title, color = StudyPalette.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                    Text("第 ${anchor.startBlockOrdinal} 段 · 与原文相连", color = StudyPalette.muted, fontSize = 11.sp)
                }
                GlassCircleButton(onClick = onDismiss, size = 32.dp) {
                    AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(11.dp), tint = StudyPalette.muted)
                }
            }
            HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .7f))
            Column(
                Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp).padding(top = 17.dp, bottom = 30.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (state.annotationError != null) {
                    Row(
                        Modifier.fillMaxWidth()
                            .background(StudyPalette.paper.copy(alpha = .82f), RoundedCornerShape(15.dp))
                            .padding(13.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        AstellaGlyph(AstellaGlyphKind.Alert, Modifier.size(16.dp), tint = StudyPalette.danger)
                        Column(Modifier.padding(start = 9.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(state.annotationError.orEmpty(), color = StudyPalette.danger, fontSize = 13.sp)
                            AstellaTextButton(onClick = { viewModel.retryNoteAnnotations(noteId) }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text("重新读取批注", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                } else if (busy && state.annotationStatus != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                        Text(state.annotationStatus.orEmpty(), Modifier.padding(start = 8.dp), color = StudyPalette.muted, fontSize = 13.sp)
                    }
                } else if (state.annotationStatus != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(14.dp), tint = StudyPalette.success)
                        Text(state.annotationStatus.orEmpty(), Modifier.padding(start = 8.dp), color = StudyPalette.muted, fontSize = 13.sp)
                    }
                }

                Column(
                    Modifier.fillMaxWidth()
                        .background(StudyPalette.paper.copy(alpha = .83f), RoundedCornerShape(17.dp))
                        .border(0.7.dp, StudyPalette.paperEdge.copy(alpha = .65f), RoundedCornerShape(17.dp))
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text("对应原文", color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Text(anchor.excerpt, color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 23.sp, fontFamily = FontFamily.Serif)
                }

                if (annotation != null && !editing) {
                    Column(
                        Modifier.fillMaxWidth().astellaGlass(20.dp).padding(15.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Text(
                            annotation.explanation.ifBlank { "这条批注还没有正文。" },
                            color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 24.sp,
                        )
                        HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .7f))
                        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                            Row(
                                Modifier.weight(1f).heightIn(min = 42.dp)
                                    .background(StudyPalette.inset.copy(alpha = .82f), RoundedCornerShape(13.dp))
                                    .clickable { draft = annotation.explanation; editing = true },
                                horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                            ) {
                                AstellaGlyph(AstellaGlyphKind.Edit, Modifier.size(14.dp), tint = StudyPalette.ink)
                                Text("编辑", Modifier.padding(start = 6.dp), color = StudyPalette.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                            Row(
                                Modifier.weight(1f).heightIn(min = 42.dp)
                                    .background(StudyPalette.sky.copy(alpha = .7f), RoundedCornerShape(13.dp))
                                    .clickable(enabled = !busy && annotation.versionState == "current") {
                                        viewModel.clearAnnotationNotice()
                                        viewModel.explainNoteAnnotation(noteId, anchor)
                                    },
                                horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                            ) {
                                AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(14.dp), tint = StudyPalette.accent)
                                Text("再请伴星讲解", Modifier.padding(start = 6.dp), color = StudyPalette.accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AstellaTextButton(onClick = { onLocate(annotation.anchor.startBlockOrdinal) }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text("回到原文", color = StudyPalette.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }
                            Spacer(Modifier.weight(1f))
                            AstellaTextButton(enabled = !busy, onClick = { confirmRemoval = true }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text("撤下", color = StudyPalette.danger, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                } else {
                    Column(
                        Modifier.fillMaxWidth().astellaGlass(20.dp).padding(15.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (annotation == null) "记下你的理解、疑问或提醒" else "编辑这条内容",
                                Modifier.weight(1f), color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                            if (annotation != null) {
                                AstellaTextButton(enabled = !busy, onClick = { editing = false; draft = annotation.explanation }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                    Text("取消", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                        Box(
                            Modifier.fillMaxWidth().heightIn(min = 118.dp, max = 175.dp)
                                .background(StudyPalette.inset, RoundedCornerShape(15.dp))
                                .padding(13.dp),
                        ) {
                            if (draft.isEmpty()) {
                                Text("写下这段话让你想到的内容", color = StudyPalette.muted.copy(alpha = .75f), fontSize = 14.sp)
                            }
                            BasicTextField(
                                value = draft,
                                onValueChange = { draft = it },
                                textStyle = TextStyle(color = StudyPalette.ink, fontSize = 14.sp, lineHeight = 22.sp),
                                cursorBrush = SolidColor(StudyPalette.accent),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            AstellaOutlinedButton(
                                onClick = {
                                    viewModel.clearAnnotationNotice()
                                    viewModel.explainNoteAnnotation(noteId, anchor)
                                },
                                modifier = Modifier.weight(1f),
                                enabled = !busy && anchor.noteVersionId == state.noteDocument?.versionId,
                            ) {
                                AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(15.dp), tint = StudyPalette.accent)
                                Text("请伴星讲解", Modifier.padding(start = 7.dp))
                            }
                            AstellaButton(
                                onClick = {
                                    if (annotation != null) viewModel.updateNoteAnnotation(noteId, annotation, draft)
                                    else viewModel.saveNoteAnnotation(noteId, anchor, draft)
                                },
                                modifier = Modifier.weight(1f),
                                enabled = !busy && draft.isNotBlank(),
                                shape = RoundedCornerShape(17.dp),
                            ) { Text(if (annotation == null) "留下批注" else "保存修改") }
                        }
                        Text("批注和讲解会留在这段原文旁，不会改动手记正文。", color = StudyPalette.muted, fontSize = 11.sp)
                    }
                }
            }
        }
    }
    if (confirmRemoval && annotation != null) {
        AlertDialog(
            onDismissRequest = { confirmRemoval = false },
            title = { Text("撤下这条批注？") },
            text = { Text("这条批注和关联讲解会一并移除，手记原文与对话仍会保留。") },
            confirmButton = {
                AstellaTextButton(onClick = {
                    confirmRemoval = false
                    viewModel.removeNoteAnnotation(noteId, annotation)
                    onDismiss()
                }) { Text("撤下批注与讲解", color = StudyPalette.danger) }
            },
            dismissButton = { AstellaTextButton(onClick = { confirmRemoval = false }) { Text("保留") } },
        )
    }
}

@Composable
private fun ReaderVersionRow(document: NoteDocument, summary: NoteSummary?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 26.dp)
            .astellaGlass(20.dp, interactive = true)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp)
            .heightIn(min = 68.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(37.dp).clip(CircleShape).background(StudyPalette.sky.copy(alpha = .72f)),
            contentAlignment = Alignment.Center,
        ) { AstellaGlyph(AstellaGlyphKind.Refresh, Modifier.size(17.dp), tint = StudyPalette.accent) }
        Column(Modifier.weight(1f).padding(start = 13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("第 ${document.versionNumber} 版", color = StudyPalette.ink,
                fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Text(
                summary?.updatedAt?.takeIf { it.isNotBlank() }?.let { "最近更新 · ${formatMonthDay(it)}" }
                    ?: "${document.blocks.size} 段 · 一起读",
                color = StudyPalette.muted,
                fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.padding(start = 6.dp).size(15.dp), tint = StudyPalette.muted.copy(alpha = .8f))
    }
}

private fun formatMonthDay(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault())
        .format(DateTimeFormatter.ofPattern("M 月 d 日"))
}.getOrDefault(value)

@Composable
private fun NoteBlockRow(
    block: NoteBlock,
    readingScale: Float,
    viewModel: AppViewModel,
    onAnnotate: () -> Unit,
    onExplain: () -> Unit,
) {
    var menuExpanded by rememberSaveable(block.ordinal) { mutableStateOf(false) }
    val actionable = block.type in setOf("paragraph", "heading", "quote", "code", "list")
    Box(Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().then(
                if (actionable) Modifier.combinedClickable(
                    onClick = {},
                    onLongClickLabel = "段落操作",
                    onLongClick = { menuExpanded = true },
                ) else Modifier,
            ),
        ) { NoteBlockView(block, readingScale, viewModel) }
        if (actionable) androidx.compose.material3.DropdownMenu(
            expanded = menuExpanded,
            onDismissRequest = { menuExpanded = false },
            shape = RoundedCornerShape(StudyRadius.lg),
            containerColor = StudyPalette.paper,
            tonalElevation = 0.dp,
            shadowElevation = 3.dp,
        ) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("给这一段留批注") },
                onClick = { menuExpanded = false; onAnnotate() },
            )
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("请伴星讲解") },
                onClick = { menuExpanded = false; onExplain() },
            )
        }
    }
}

@Composable
internal fun NoteBlockView(block: NoteBlock, readingScale: Float = 1f, viewModel: AppViewModel) {
    when (block.type) {
        "heading" -> Text(
            noteHeadingText(block.content),
            Modifier.padding(bottom = 8.dp),
            color = StudyPalette.ink,
            style = androidx.compose.material3.MaterialTheme.typography.titleLarge.copy(
                fontSize = 22.sp * readingScale,
                lineHeight = 31.sp * readingScale,
                letterSpacing = 1.sp,
                fontFamily = FontFamily.Serif,
            ),
            fontWeight = FontWeight.Medium,
        )
        "quote" -> Row(verticalAlignment = Alignment.Top) {
            Spacer(Modifier.padding(end = 10.dp).size(width = 3.dp, height = 42.dp).background(StudyPalette.accent.copy(alpha = .65f), RoundedCornerShape(2.dp)))
            Text(
                block.content.replace(Regex("(?m)^\\s*>\\s?"), ""),
                color = StudyPalette.muted,
                style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                    fontSize = 16.sp * readingScale,
                    lineHeight = 26.sp * readingScale,
                    fontFamily = FontFamily.Serif,
                    fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                ),
            )
        }
        "code" -> Box(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(13.dp))
                .background(Color.Black.copy(alpha = .045f))
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                block.content,
                Modifier.padding(14.dp),
                color = StudyPalette.ink,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium.copy(
                    fontSize = 16.sp * .82f * readingScale,
                ),
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                softWrap = false,
            )
        }
        "image" -> NoteImageBlock(block, viewModel)
        "list" -> {
            val lines = noteListLines(block.content)
            val ordered = Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(block.content.lineSequence().firstOrNull().orEmpty())
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                lines.forEachIndexed { index, line ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(if (ordered) "${index + 1}." else "•", Modifier.padding(end = 9.dp), color = StudyPalette.accent, fontWeight = FontWeight.SemiBold)
                        Text(line, color = StudyPalette.readerInk, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                            fontSize = 16.sp * readingScale,
                            lineHeight = 26.sp * readingScale,
                            fontFamily = FontFamily.Serif,
                        ))
                    }
                }
            }
        }
        "table" -> {
            val rows = noteTableRows(block.content)
            Column(Modifier.fillMaxWidth().background(StudyPalette.inset.copy(alpha = .72f), RoundedCornerShape(StudyRadius.md)).padding(horizontal = 10.dp)) {
                rows.forEachIndexed { rowIndex, cells ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        cells.forEach { cell ->
                            Text(
                                cell,
                                Modifier.weight(1f),
                                color = if (rowIndex == 0) StudyPalette.ink else StudyPalette.muted,
                                fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall.copy(
                                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodySmall.fontSize * readingScale,
                                ),
                            )
                        }
                    }
                    if (rowIndex < rows.lastIndex) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                }
            }
        }
        else -> Text(block.content, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
            fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale,
            lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale,
            fontFamily = FontFamily.Serif,
        ))
    }
}

private fun noteHeadingText(content: String): String = content
    .replace(Regex("^\\s*<h[1-6]\\b[^>]*>|</h[1-6]>\\s*$", RegexOption.IGNORE_CASE), "")
    .replace(Regex("^\\s*#{1,6}\\s+"), "")

private fun noteListLines(content: String): List<String> = content.lineSequence().filter(String::isNotBlank).map {
    it.replace(Regex("^\\s*(?:[-+*]|\\d+[.)])\\s+"), "")
}.toList()

private fun noteTableRows(content: String): List<List<String>> = content.lineSequence().mapNotNull { line ->
    val cells = line.split('|').map(String::trim).let { row ->
        row.dropWhile(String::isEmpty).dropLastWhile(String::isEmpty)
    }
    if (cells.isEmpty() || cells.all { Regex("^:?-{2,}:?$").matches(it) }) null else cells
}.toList()

@Composable
private fun NoteAnnotationComposer(
    block: NoteBlock,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
    onExplain: () -> Unit,
) {
    var draft by rememberSaveable(block.ordinal) { mutableStateOf("") }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(StudyRadius.xxl), color = StudyPalette.paper) {
            Column(
                Modifier.fillMaxWidth().widthIn(max = 440.dp).imePadding().padding(21.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                SectionEyebrow("这段原文")
                Text(block.content.take(500), color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, maxLines = 8, overflow = TextOverflow.Ellipsis)
                Text("操作会绑定整段原文和当前手记版本。", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("记下你的理解、疑问或提醒") },
                    minLines = 3,
                    maxLines = 6,
                    shape = RoundedCornerShape(StudyRadius.lg),
                    enabled = !busy,
                )
                if (error != null) Text(error, color = StudyPalette.danger,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                if (busy) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                    Text("正在保存或生成…", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    AstellaTextButton(onClick = onDismiss, enabled = !busy) { Text("取消") }
                    AstellaTextButton(onClick = onExplain, enabled = !busy) { Text("请伴星讲解") }
                    AstellaButton(onClick = { onSave(draft) }, enabled = !busy && draft.isNotBlank()) { Text("留下批注") }
                }
            }
        }
    }
}

private data class NoteImageReference(val source: String, val alt: String)

private fun noteImageReference(content: String): NoteImageReference? {
    val markdown = Regex("!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)").find(content)
    if (markdown != null) return NoteImageReference(markdown.groupValues[2], markdown.groupValues[1])
    val tag = Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE).find(content)?.value ?: return null
    fun attribute(name: String): String? = Regex("\\b$name\\s*=\\s*(['\"])(.*?)\\1", RegexOption.IGNORE_CASE)
        .find(tag)?.groupValues?.get(2)
    val source = attribute("src")?.takeIf(String::isNotBlank) ?: return null
    return NoteImageReference(source, attribute("alt").orEmpty())
}

@Composable
private fun NoteImageBlock(block: NoteBlock, viewModel: AppViewModel) {
    val reference = remember(block.content) { noteImageReference(block.content) }
    var bitmap by remember(reference?.source) { mutableStateOf<Bitmap?>(null) }
    var loading by remember(reference?.source) { mutableStateOf(false) }
    var failed by remember(reference?.source) { mutableStateOf(false) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(reference?.source, retry) {
        val source = reference?.source ?: return@LaunchedEffect
        loading = true
        failed = false
        try {
            val bytes = viewModel.imageBytes(source)
            bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            failed = bitmap == null
        } catch (_: Throwable) {
            bitmap = null
            failed = true
        } finally {
            loading = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 100.dp, max = 420.dp)
                .clip(RoundedCornerShape(StudyRadius.lg)).background(StudyPalette.inset),
            contentAlignment = Alignment.Center,
        ) {
            when {
                bitmap != null -> Image(
                    bitmap!!.asImageBitmap(),
                    contentDescription = reference?.alt?.ifBlank { "手记中的图片" } ?: "手记中的图片",
                    modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
                    contentScale = ContentScale.Fit,
                )
                loading -> CircularProgressIndicator(Modifier.size(22.dp), color = StudyPalette.accent)
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        if (reference == null) "图片地址无法读取" else if (failed) "图片暂时无法打开" else "手记配图",
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                    )
                    if (reference != null && failed) {
                        AstellaTextButton(onClick = { retry += 1 }) { Text("重新加载") }
                    }
                }
            }
        }
        reference?.alt?.takeIf(String::isNotBlank)?.let {
            Text(it, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
        }
    }
}


@Composable
fun AccountScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onLibrary: () -> Unit,
    onCompanion: () -> Unit,
    onSubpage: (String) -> Unit,
) {
    var firstDiaryDate by remember(state.profile?.workspaceId) { mutableStateOf<java.time.LocalDate?>(null) }
    var todayDiaryCount by remember(state.profile?.workspaceId) { mutableStateOf(0) }
    var diaryStatsLoaded by remember(state.profile?.workspaceId) { mutableStateOf(false) }
    var diaryStatsUnavailable by remember(state.profile?.workspaceId) { mutableStateOf(false) }
    var avatarBitmap by remember(state.profile?.avatarUrl) { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(Unit) { viewModel.loadAccountSettings() }
    LaunchedEffect(state.profile?.workspaceId) {
        if (state.profile?.workspaceId == null) return@LaunchedEffect
        diaryStatsLoaded = false
        diaryStatsUnavailable = false
        try {
            val today = java.time.LocalDate.now()
            val month = today.format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM"))
            val monthResponse = withContext(Dispatchers.IO) {
                viewModel.requestApi("/companion/daily/month?month=$month")
            }
            firstDiaryDate = monthResponse.optNullableString("firstGeneratedDate")
                ?.let { runCatching { java.time.LocalDate.parse(it) }.getOrNull() }
                ?: monthResponse.optJSONArray("days")?.let { values ->
                    (0 until values.length()).mapNotNull { index ->
                        val day = values.optJSONObject(index) ?: return@mapNotNull null
                        if (day.optString("status") != "generated") return@mapNotNull null
                        runCatching { java.time.LocalDate.parse(day.optString("date")) }.getOrNull()
                    }.minOrNull()
                }
            val todayResponse = withContext(Dispatchers.IO) {
                viewModel.requestApi("/companion/daily?date=$today")
            }
            todayDiaryCount = if (todayResponse.optString("status") == "generated") {
                val blocks = todayResponse.optJSONArray("blocks")
                (blocks?.let { values ->
                    (0 until values.length()).count { index ->
                        values.optJSONObject(index)?.optString("text")?.isNotBlank() == true
                    }
                } ?: 0).coerceAtLeast(1)
            } else 0
            diaryStatsUnavailable = false
        } catch (_: Throwable) {
            diaryStatsUnavailable = true
        }
        diaryStatsLoaded = true
    }
    LaunchedEffect(state.profile?.avatarUrl) {
        val address = state.profile?.avatarUrl ?: return@LaunchedEffect
        avatarBitmap = runCatching {
            viewModel.imageBytes(address)?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) }
        }.getOrNull()
    }
    val displayName = state.profile?.displayName?.ifBlank { state.profile?.email?.substringBefore('@').orEmpty() } ?: "拾星同学"
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 22.dp, top = 16.dp, end = 22.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp).padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                AstellaTap(
                    onClick = { onSubpage("profile") },
                    modifier = Modifier.size(64.dp).clip(CircleShape).background(StudyPalette.sky)
                        .border(1.dp, Color.White.copy(alpha = .88f), CircleShape),
                ) {
                    if (avatarBitmap != null) {
                        Image(avatarBitmap!!.asImageBitmap(), "账户头像", Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
                    } else {
                        Image(
                            painterResource(R.drawable.companion_avatar), "伴星头像",
                            Modifier.fillMaxSize(),
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        )
                    }
                }
                Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(displayName, color = StudyPalette.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(state.profile?.email.orEmpty(), color = StudyPalette.muted, fontSize = 12.5.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                AstellaTap(
                    onClick = { onSubpage("settings") },
                    modifier = Modifier.size(34.dp).astellaGlass(12.dp, interactive = true)
                        .semantics { contentDescription = "设置" },
                ) {
                    AstellaGlyph(AstellaGlyphKind.Grid, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
                }
                Spacer(Modifier.width(8.dp))
                AstellaTap(
                    onClick = { onSubpage("profile") },
                    modifier = Modifier.height(34.dp).background(StudyPalette.sky.copy(alpha = .68f), RoundedCornerShape(12.dp))
                        .padding(horizontal = 12.dp),
                ) {
                    Text("编辑", Modifier.align(Alignment.Center), color = StudyPalette.ink, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
        state.accountError?.let { error ->
            item { NoticeSurface(Modifier.fillMaxWidth()) { Text(error, color = StudyPalette.danger, fontSize = 12.sp) } }
        }
        state.accountNotice?.let { notice ->
            item { NoticeSurface(Modifier.fillMaxWidth()) { Text(notice, color = StudyPalette.success, fontSize = 12.sp) } }
        }
        item {
            Box(
                Modifier.fillMaxWidth().height(132.dp).clip(RoundedCornerShape(22.dp))
                    .background(Brush.linearGradient(listOf(Color(0xFFD9E8FC), Color(0xFFC7DEF9)))),
            ) {
                Image(
                    painterResource(R.drawable.companion_avatar), null,
                    Modifier.align(Alignment.BottomEnd).offset(x = (-8).dp, y = 24.dp).size(124.dp).graphicsLayer { alpha = .92f },
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                )
                Column(
                    Modifier.fillMaxWidth().padding(start = 20.dp, top = 18.dp, end = 72.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val elapsedDays = firstDiaryDate?.let { (java.time.temporal.ChronoUnit.DAYS.between(it, java.time.LocalDate.now()) + 1).coerceAtLeast(1) }
                    Text(
                        when {
                            !diaryStatsLoaded -> "伴星 · 正在接回日记"
                            diaryStatsUnavailable -> "伴星 · 日记暂时不可用"
                            elapsedDays != null -> "伴星 · 陪你读书的第 ${elapsedDays} 天"
                            else -> "伴星 · 还没开始记录"
                        },
                        color = Color(0xFF5978A8), fontSize = 12.sp, fontWeight = FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        when {
                            !diaryStatsLoaded -> "正在接回今天的记录"
                            diaryStatsUnavailable -> "今天的日记暂时没有读到"
                            todayDiaryCount > 0 -> "今天一起留下了 ${todayDiaryCount} 段记录"
                            else -> "今天还没一起读"
                        },
                        color = Color(0xFF19283D), fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.5).sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    AstellaTap(
                        onClick = onCompanion,
                        modifier = Modifier.height(36.dp)
                            .background(
                                Brush.linearGradient(listOf(StudyPalette.actionFill, StudyPalette.accent)),
                                RoundedCornerShape(12.dp),
                            )
                            .padding(horizontal = 16.dp),
                    ) {
                        Text("进入伴星中心", Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.onPrimary, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("和伴星相处")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Shield, "伴星权限", "麦克风、照片、文件与通知", onClick = { onSubpage("permissions") })
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Check, "个人约定", "把你的节奏告诉她", onClick = { onSubpage("conventions") })
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Library, "书房",
                        state.profile?.workspaceName ?: "当前学习空间",
                        onClick = onLibrary,
                    )
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("阅读")
                SettingsGroup {
                    SettingsRow(AstellaGlyphKind.Document, "阅读字号", "字号、默认打开与动效", onClick = { onSubpage("readSettings") })
                    SettingsDivider()
                    var showDefaultOpen by remember { mutableStateOf(false) }
                    Box(Modifier.fillMaxWidth()) {
                        SettingsRow(
                            AstellaGlyphKind.Eye, "默认打开",
                            if (state.chatShowsRecords) "记录场景" else "伴星场景",
                            onClick = { showDefaultOpen = true },
                        )
                        DropdownMenu(expanded = showDefaultOpen, onDismissRequest = { showDefaultOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("伴星场景", fontSize = 14.sp) },
                                leadingIcon = { if (!state.chatShowsRecords) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(16.dp), tint = StudyPalette.accent) },
                                onClick = {
                                    viewModel.setChatShowsRecords(false)
                                    showDefaultOpen = false
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("记录场景", fontSize = 14.sp) },
                                leadingIcon = { if (state.chatShowsRecords) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(16.dp), tint = StudyPalette.accent) },
                                onClick = {
                                    viewModel.setChatShowsRecords(true)
                                    showDefaultOpen = false
                                },
                            )
                        }
                    }
                    SettingsDivider()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        GlassIconTile(AstellaGlyphKind.Companion, size = 36.dp)
                        Column(Modifier.weight(1f).padding(start = 13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("轻柔动效", color = StudyPalette.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                            Text("减少位移，留下安静的状态反馈", color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 15.sp)
                        }
                        AstellaSwitch(checked = state.localReduceMotion, onCheckedChange = viewModel::setLocalReduceMotion)
                    }
                }
            }
        }
        item {
            val settings = state.aiSettings
            val authSummary = when {
                settings == null -> "正在读取授权状态…"
                settings.needsSigning -> "尚未签署 · AI 外发调用已关闭"
                settings.consentVersion != null -> "已授权 · ${settings.consentVersion}"
                else -> "已授权 · 可在本页调整"
            }
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("隐私与高级")
                SettingsGroup {
                    SettingsRow(
                        AstellaGlyphKind.Lock,
                        "AI 使用授权与数据偏好",
                        authSummary,
                        onClick = { onSubpage("aiAuth") },
                    )
                    SettingsDivider()
                    SettingsRow(AstellaGlyphKind.Key, "修改密码", "更换登录密码", onClick = { onSubpage("password") })
                    SettingsDivider()
                    SettingsRow(
                        AstellaGlyphKind.Document,
                        "服务地址",
                        state.serviceAddress.ifBlank { "默认" },
                        onClick = { onSubpage("serverAddr") },
                    )
                }
            }
        }
        item {
            AstellaTap(
                onClick = { viewModel.logout() },
                modifier = Modifier.fillMaxWidth().height(54.dp)
                    .background(StudyPalette.paper.copy(alpha = .52f), RoundedCornerShape(18.dp))
                    .border(.8.dp, Color.White.copy(alpha = .78f), RoundedCornerShape(18.dp)),
            ) {
                Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    AstellaGlyph(AstellaGlyphKind.Logout, Modifier.size(18.dp), tint = StudyPalette.danger)
                    Text("退出登录", color = StudyPalette.danger, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
        item {
            Text(
                "ASTELLA · 拾星笔记",
                Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 14.dp),
                color = StudyPalette.muted.copy(alpha = .72f),
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 2.4.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}


@Composable
private fun AccountSettingsSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, color = StudyPalette.muted, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        content()
    }
}

@Composable
private fun AccountSettingsGroup(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    PaperSurface(Modifier.fillMaxWidth(), padding = 4.dp) {
        Column(content = content)
    }
}

@Composable
private fun AccountSettingRow(
    icon: AstellaGlyphKind,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 9.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(38.dp).background(StudyPalette.sky, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (icon == AstellaGlyphKind.Number) {
                Text("T", color = StudyPalette.accent, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, fontFamily = androidx.compose.ui.text.font.FontFamily.Serif)
            } else {
                AstellaGlyph(icon, Modifier.size(18.dp), tint = StudyPalette.accent)
            }
        }
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = StudyPalette.ink, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall,
                maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 17.sp)
        }
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(16.dp), tint = StudyPalette.muted)
    }
}

@Composable
private fun AccountSettingDivider() {
    androidx.compose.material3.HorizontalDivider(
        Modifier.padding(horizontal = 8.dp),
        color = StudyPalette.paperEdge.copy(alpha = .72f),
    )
}

@Composable
private fun PolicySwitch(title: String, detail: String, checked: Boolean, enabled: Boolean = true, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 10.dp)) {
            Text(title, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(detail, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
        }
        AstellaSwitch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
private fun AccountMessage(message: String, isError: Boolean) {
    NoticeSurface(Modifier.fillMaxWidth()) {
        Text(
            (if (isError) "!  " else "✓  ") + message,
            color = if (isError) StudyPalette.danger else StudyPalette.success,
            style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun SoftTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
) {
    Column(Modifier.fillMaxWidth(),verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label,fontSize = 11.sp,color = StudyPalette.muted)
        BasicTextField(value,onValueChange,Modifier.fillMaxWidth().background(StudyPalette.inset,RoundedCornerShape(14.dp)).padding(14.dp),
            singleLine = true,textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp,color = StudyPalette.ink),
            cursorBrush = SolidColor(StudyPalette.accent),keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            visualTransformation = if (password) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None)
    }
}

private fun formatDate(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()
}.getOrDefault("最近更新")

private fun permissionDescription(level: String?): String = when (level) {
    "read_only" -> "需要写入或执行操作时，伴星会先给你预览并征求确认。"
    "full" -> "已授权范围内的可逆操作可以直接执行；不可逆操作仍需你确认。"
    "guided" -> "伴星会先说明下一步，再等你确认后执行。"
    else -> "暂时没有读取到权限信息。"
}
