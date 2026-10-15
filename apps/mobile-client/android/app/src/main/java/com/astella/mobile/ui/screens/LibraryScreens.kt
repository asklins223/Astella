package com.astella.mobile.ui.screens

import com.astella.mobile.ui.design.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
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
import com.astella.mobile.ui.design.ConnectionFailureNotice
import com.astella.mobile.ui.design.CompanionPortrait
import com.astella.mobile.ui.design.NoticeSurface
import com.astella.mobile.ui.design.PaperSurface
import com.astella.mobile.ui.design.PageHeading
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.StudySpacing
import com.astella.mobile.ui.design.SectionEyebrow
import com.astella.mobile.ui.design.TonalSurface
import kotlinx.coroutines.delay

@Composable
fun HandScreen(state: AppUiState, viewModel: AppViewModel, onAccount: () -> Unit, onConversation: () -> Unit) {
    LaunchedEffect(Unit) { viewModel.refreshRuns(); if (state.notes.isEmpty()) viewModel.loadNotes("") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
        item { AstellaAppHeader(state.profile?.workspaceName ?: "随身书房",state.profile?.displayName?.ifBlank { state.profile.email } ?: "我",onAccount,edge = 0.dp) }
        item { PageHeading("继续未完的想法","手边","交给伴星的事，在这里接续。") }
        item { Surface(modifier = Modifier.astellaGlass(24.dp),color = Color.Transparent) {
            Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                AstellaStar(Modifier.padding(horizontal = 5.dp).size(27.dp,36.dp))
                Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(if (state.runs.isEmpty()) "现在，可以慢一点。" else "伴星正在替你整理", style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
                    Text(if (state.realtimeStatus == "已连接") "和你的书房连在一起" else state.realtimeStatus, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, color = StudyPalette.muted)
                }
                AstellaIconButton(onClick = onConversation) { Icon(Icons.Filled.AutoAwesome, "回到伴星身边", tint = StudyPalette.accent) }
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
                Icon(Icons.Filled.AutoAwesome, null, Modifier.size(36.dp).background(StudyPalette.sky, CircleShape).padding(8.dp), tint = StudyPalette.accent)
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
    onAccount: () -> Unit,
    onConversation: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(query) { delay(260); viewModel.loadNotes(query) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 22.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item { AstellaAppHeader(state.profile?.workspaceName ?: "随身书房",state.profile?.displayName?.ifBlank { state.profile.email } ?: "我",onAccount,edge = 0.dp) }
        item { PageHeading("留住你的思路","手记",if (state.notes.isEmpty()) "和伴星整理过的内容，都会留在这里。" else "${state.notes.size} 篇 · 最近更新在前") }
        item {
            Row(Modifier.padding(top = 22.dp).fillMaxWidth().background(StudyPalette.paper,RoundedCornerShape(14.dp)).padding(horizontal = 14.dp,vertical = 15.dp),verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Search,null,Modifier.size(18.dp),tint = StudyPalette.muted)
                BasicTextField(query,{ query = it },Modifier.weight(1f).padding(start = 10.dp),singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp,color = StudyPalette.ink),cursorBrush = SolidColor(StudyPalette.accent),decorationBox = { inner ->
                        if (query.isEmpty()) Text("搜索标题与正文",fontSize = 14.sp,color = StudyPalette.muted); inner()
                    })
                if (query.isNotEmpty()) AstellaIconButton({ query = "" },Modifier.size(22.dp)) { Icon(Icons.Filled.Close,"清除搜索",Modifier.size(16.dp),tint = StudyPalette.muted) }
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
            Column(Modifier.fillMaxWidth().padding(top = 34.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Filled.Book, null, Modifier.size(28.dp), tint = StudyPalette.accent)
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
            if (query.isBlank()) {
                item {
                    Text("继续阅读", Modifier.padding(top = 20.dp, bottom = 8.dp),
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold)
                    FeaturedNoteRow(state.notes.first(), onOpen = { onOpenNote(state.notes.first().id) })
                }
                if (state.notes.size > 1) item {
                    Text("其他手记", Modifier.padding(top = 22.dp, bottom = 4.dp),
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold)
                }
            } else item {
                Text("搜索结果", Modifier.padding(top = 18.dp, bottom = 4.dp),
                    color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold)
            }
            itemsIndexed(state.notes, key = { _, note -> note.id }) { index, note ->
            LaunchedEffect(note.id, state.notes.size, state.isLoading, state.isLoadingMoreNotes, state.notesNextCursor, query) {
                if (index >= state.notes.size - 3 && !state.isLoading && !state.isLoadingMoreNotes) {
                    viewModel.loadMoreNotes(query)
                }
            }
            if (query.isNotBlank() || index > 0) {
            Column(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(StudyRadius.sm)).clickable { onOpenNote(note.id) }.padding(vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(note.title, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        note.snippet?.takeIf(String::isNotBlank)?.let { snippet ->
                            Text(snippet, Modifier.padding(top = 5.dp), color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                                maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Text("最近更新 · ${formatDate(note.updatedAt)}", Modifier.padding(top = 5.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.Filled.ChevronRight, null, Modifier.padding(start = 12.dp).size(17.dp), tint = StudyPalette.muted)
                }
                if (index < state.notes.lastIndex) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .72f))
            }
            }
            }
        }
        if (state.isLoadingMoreNotes) item { CircularProgressIndicator(Modifier.fillMaxWidth().padding(12.dp).size(22.dp), color = StudyPalette.accent) }
    }
}

@Composable
private fun FeaturedNoteRow(note: NoteSummary,onOpen: () -> Unit) {
    AstellaTap(onOpen,Modifier.fillMaxWidth().astellaGlass(24.dp)) {
        Column(Modifier.fillMaxWidth().padding(24.dp),verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(Modifier.fillMaxWidth(),verticalAlignment = Alignment.CenterVertically) {
                Text("最近打开",Modifier.weight(1f),fontSize = 11.sp,color = StudyPalette.muted)
                AstellaStar(Modifier.size(12.dp,18.dp))
            }
            Text(note.title,fontSize = 22.sp,lineHeight = 32.sp,fontWeight = FontWeight.SemiBold,color = StudyPalette.ink,maxLines = 3)
            note.snippet?.takeIf { it.isNotBlank() }?.let { Text(it,fontSize = 13.sp,lineHeight = 23.sp,color = StudyPalette.muted,maxLines = 3) }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp),verticalAlignment = Alignment.CenterVertically) {
                Text(formatDate(note.updatedAt),Modifier.weight(1f),fontSize = 10.sp,color = StudyPalette.muted)
                Text("接着读  →",fontSize = 12.sp,fontWeight = FontWeight.Medium,color = StudyPalette.accent)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteDetailScreen(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onAccount: () -> Unit,
    onContinue: (NoteDocument) -> Unit,
    onOpenFeature: (String) -> Unit,
) {
    LaunchedEffect(noteId) { viewModel.loadNote(noteId) }
    val document = state.noteDocument?.takeIf { it.id == noteId }
    var annotationTarget by remember(document?.versionId) { mutableStateOf<NoteBlock?>(null) }
    var pendingRemoval by remember { mutableStateOf<NoteAnnotation?>(null) }
    var selectionOriginal by remember { mutableStateOf<String?>(null) }
    var selectionBaseline by remember { mutableStateOf<Set<String>>(emptySet()) }
    var actionsExpanded by rememberSaveable(noteId) { mutableStateOf(false) }
    val actionsSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(state.annotationStatus) {
        if (state.annotationStatus != null) annotationTarget = null
    }
    Column(Modifier.fillMaxSize().background(StudyPalette.paper)) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 25.dp, end = 25.dp, top = 3.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AstellaIconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回手记", tint = StudyPalette.ink) }
                    Text("手记", Modifier.weight(1f), color = StudyPalette.ink, fontWeight = FontWeight.Medium)
                    AstellaIconButton(onClick = { actionsExpanded = true }) {
                        Icon(Icons.Filled.MoreVert, "手记操作", tint = StudyPalette.ink)
                    }
                    AstellaIconButton(onClick = onAccount) { Icon(Icons.Filled.AccountCircle, "我的账户", tint = StudyPalette.muted) }
                }
            }
            if (document == null) item {
                Column(Modifier.fillMaxWidth().padding(top = 45.dp), horizontalAlignment = Alignment.CenterHorizontally) {
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
                    Column(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 25.dp)) {
                        SectionEyebrow("拾星笔记  ·  第 ${document.versionNumber} 版")
                        Text(document.title, Modifier.padding(top = 9.dp), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.SemiBold, lineHeight = 36.sp)
                        Text("选中文字，让伴星解释或一起改写。", Modifier.padding(top = 9.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        androidx.compose.material3.HorizontalDivider(Modifier.padding(top = 19.dp), color = StudyPalette.paperEdge)
                    }
                }
                items(document.blocks) { block ->
                    if (block.type in setOf("paragraph", "heading", "quote")) {
                        Column(Modifier.padding(vertical = 10.dp)) {
                            CompanionSelectableText(block.content, (if (block.type == "heading") 22f else 17f) * state.readingScale) { selected, rewrite ->
                                selectionOriginal = selected
                                selectionBaseline = state.messages.map { it.id }.toSet()
                                viewModel.askAboutSelection(selected, document, rewrite)
                            }
                        }
                    } else NoteBlockRow(
                        block = block,
                        readingScale = state.readingScale,
                        viewModel = viewModel,
                        onAnnotate = { viewModel.clearAnnotationNotice(); annotationTarget = block },
                        onExplain = {
                            NoteAnnotationAnchor.wholeBlock(block, document.versionId)?.let {
                                viewModel.explainNoteAnnotation(noteId, it)
                            } ?: run {
                                viewModel.clearAnnotationNotice()
                                viewModel.reportAnnotationError("这段内容暂时无法精确对应到手记原文。")
                            }
                        },
                    )
                }
                if (state.annotationError != null || state.annotationStatus != null) item {
                    Row(Modifier.fillMaxWidth().padding(top = 13.dp), verticalAlignment = Alignment.Top) {
                        Icon(
                            if (state.annotationError != null) Icons.Filled.WarningAmber else Icons.Filled.CheckCircle,
                            contentDescription = null,
                            tint = if (state.annotationError != null) StudyPalette.danger else StudyPalette.success,
                            modifier = Modifier.padding(top = 2.dp).size(18.dp),
                        )
                        Text(state.annotationError ?: state.annotationStatus.orEmpty(), Modifier.weight(1f).padding(start = 8.dp),
                            color = if (state.annotationError != null) StudyPalette.danger else StudyPalette.success,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    }
                }
                if (state.annotationError != null) item {
                    AstellaTextButton(onClick = { viewModel.retryNoteAnnotations(noteId) }) { Text("重新读取批注") }
                }
                if (state.noteAnnotations.isNotEmpty()) item {
                    Column(Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                        Text("留在原文旁", Modifier.padding(top = 9.dp), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text("${state.noteAnnotations.size} 条批注与讲解", color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        state.noteAnnotations.forEach { annotation ->
                            androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                            Text("“${annotation.anchor.excerpt}”", color = StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, maxLines = 5, overflow = TextOverflow.Ellipsis)
                            Text(annotation.explanation, color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            Text(if (annotation.versionState == "current") "对应当前版本" else "来自较早版本",
                                color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AstellaTextButton(
                                    enabled = !state.isAnnotationBusy && annotation.versionState == "current",
                                    onClick = { viewModel.explainNoteAnnotation(noteId, annotation.anchor) },
                                ) { Text("再讲一次") }
                                AstellaTextButton(
                                    enabled = !state.isAnnotationBusy,
                                    onClick = { pendingRemoval = annotation },
                                ) { Text("撤下", color = StudyPalette.muted) }
                            }
                        }
                    }
                }
            }
        }
        if (document != null) {
            AstellaButton(
                onClick = { onContinue(document) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 9.dp).height(50.dp),
                shape = RoundedCornerShape(StudyRadius.lg),
            ) { Text("在对话里继续提问") }
        }
    }
    if (selectionOriginal != null) ModalBottomSheet(onDismissRequest = { selectionOriginal = null; viewModel.loadNote(noteId) }, containerColor = StudyPalette.canvas) {
        LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(.9f), contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item { Text("一起读这一段", style = androidx.compose.material3.MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
            item { Text(selectionOriginal.orEmpty(), Modifier.fillMaxWidth().background(StudyPalette.inset, RoundedCornerShape(16.dp)).padding(16.dp), color = StudyPalette.muted) }
            items(state.messages.filter { it.id !in selectionBaseline && it.role == "assistant" && state.selectionRunId != null && it.runId == state.selectionRunId }, key = { it.id }) { MobileMessageRow(it, viewModel) }
            if (state.streamingText.isNotEmpty() && state.selectionRunId != null && state.streamingRunId == state.selectionRunId) item { Text(state.streamingText, lineHeight = 26.sp, color = StudyPalette.ink) }
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
                listOf("overview" to "速览", "mindmap" to "脑图", "explain" to "讲解", "versions" to "版本记录").forEachIndexed { index, (kind, label) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                            actionsExpanded = false
                            onOpenFeature(kind)
                        },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, Modifier.weight(1f), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge)
                        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = StudyPalette.muted)
                    }
                    if (index < 3) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                }
            }
        }
    }
    annotationTarget?.let { target ->
        val anchor = NoteAnnotationAnchor.wholeBlock(target, document?.versionId.orEmpty())
        if (anchor != null) NoteAnnotationComposer(
            block = target,
            busy = state.isAnnotationBusy,
            error = state.annotationError,
            onDismiss = { if (!state.isAnnotationBusy) annotationTarget = null },
            onSave = { explanation -> viewModel.saveNoteAnnotation(noteId, anchor, explanation) },
            onExplain = { viewModel.explainNoteAnnotation(noteId, anchor) },
        )
    }
    pendingRemoval?.let { annotation ->
        AlertDialog(
            onDismissRequest = { pendingRemoval = null },
            title = { Text("撤下这条批注？") },
            text = { Text("已生成的原文讲解也会一并移除；对话记录不会删除。") },
            confirmButton = {
                AstellaTextButton(onClick = {
                    pendingRemoval = null
                    viewModel.removeNoteAnnotation(noteId, annotation)
                }) { Text("撤下", color = StudyPalette.danger) }
            },
            dismissButton = { AstellaTextButton(onClick = { pendingRemoval = null }) { Text("保留") } },
        )
    }
}

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
private fun NoteBlockView(block: NoteBlock, readingScale: Float = 1f, viewModel: AppViewModel) {
    when (block.type) {
        "heading" -> Text(
            block.content.replace(Regex("^\\s*<h[1-6]\\b[^>]*>|</h[1-6]>\\s*$", RegexOption.IGNORE_CASE), "")
                .replace(Regex("^\\s*#{1,6}\\s+"), ""),
            color = StudyPalette.ink,
            style = androidx.compose.material3.MaterialTheme.typography.titleLarge.copy(
                fontSize = androidx.compose.material3.MaterialTheme.typography.titleLarge.fontSize * readingScale,
            ),
            fontWeight = FontWeight.SemiBold,
        )
        "quote" -> Row(verticalAlignment = Alignment.Top) {
            Spacer(Modifier.padding(end = 10.dp).size(width = 3.dp, height = 42.dp).background(StudyPalette.accent.copy(alpha = .65f), RoundedCornerShape(2.dp)))
            Text(
                block.content.replace(Regex("(?m)^\\s*>\\s?"), ""),
                color = StudyPalette.muted,
                style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale,
                    lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale,
                ),
            )
        }
        "code" -> Box(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(StudyRadius.md))
                .background(androidx.compose.material3.MaterialTheme.colorScheme.surfaceVariant)
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                block.content,
                Modifier.padding(13.dp),
                color = StudyPalette.ink,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium.copy(
                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodyMedium.fontSize * readingScale,
                ),
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                softWrap = false,
            )
        }
        "image" -> NoteImageBlock(block, viewModel)
        "list" -> {
            val lines = noteListLines(block.content)
            val ordered = Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(block.content.lineSequence().firstOrNull().orEmpty())
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                lines.forEachIndexed { index, line ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(if (ordered) "${index + 1}." else "•", Modifier.padding(end = 9.dp), color = StudyPalette.accent, fontWeight = FontWeight.SemiBold)
                        Text(line, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                            fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale,
                            lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale,
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
        else -> Text(block.content, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale, lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale))
    }
}

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
        TonalSurface(radius = StudyRadius.xxl, tonalElevation = 4.dp) {
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
fun AccountScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onSettings: () -> Unit, onCompanion: () -> Unit) {
    var address by rememberSaveable(state.serviceAddress) { mutableStateOf(state.serviceAddress) }
    var displayName by rememberSaveable(state.profile?.displayName) { mutableStateOf(state.profile?.displayName.orEmpty()) }
    var policy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: AIDataPolicy(false, false, true, true))
    }
    var savedPolicy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: AIDataPolicy(false, false, true, true))
    }
    var consentAccepted by rememberSaveable { mutableStateOf(false) }
    var workspaceMenuOpen by remember { mutableStateOf(false) }
    var showAdvancedService by rememberSaveable { mutableStateOf(false) }
    var avatarBitmap by remember(state.profile?.avatarUrl) { mutableStateOf<Bitmap?>(null) }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        uri?.let(viewModel::saveAvatar)
    }
    LaunchedEffect(Unit) { viewModel.loadAccountSettings() }
    LaunchedEffect(state.aiSettings?.dataPolicy) {
        state.aiSettings?.dataPolicy?.let {
            policy = it
            savedPolicy = it
        }
    }
    LaunchedEffect(state.profile?.avatarUrl) {
        val address = state.profile?.avatarUrl ?: return@LaunchedEffect
        avatarBitmap = runCatching {
            viewModel.imageBytes(address)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        }.getOrNull()
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AstellaIconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = StudyPalette.ink) }
                PageHeading("你的随身书房", "我的", state.profile?.workspaceName ?: "账户、设备与数据偏好。", modifier = Modifier.weight(1f))
            }
        }
        state.accountError?.let { error ->
            item { AccountMessage(error, isError = true) }
        }
        state.accountNotice?.let { notice ->
            item { AccountMessage(notice, isError = false) }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                Text("账号", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                PaperSurface(Modifier.fillMaxWidth(), padding = StudySpacing.lg) {
                    Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                Modifier.size(58.dp).clip(CircleShape).background(StudyPalette.sky)
                                    .clickable(enabled = !state.isAccountBusy) {
                                        avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (avatarBitmap != null) {
                                    Image(avatarBitmap!!.asImageBitmap(), "账户头像", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                                } else {
                                    Text(
                                        (state.profile?.displayName?.firstOrNull() ?: state.profile?.email?.firstOrNull() ?: '阅').uppercase(),
                                        color = StudyPalette.accent,
                                        style = androidx.compose.material3.MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                            }
                            Text(if (state.isAccountBusy) "上传中" else "更换头像", color = StudyPalette.accent,
                                style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                        }
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            val email = state.profile?.email.orEmpty()
                            Text(
                                email,
                                modifier = Modifier.fillMaxWidth().semantics { contentDescription = email },
                                color = StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(state.profile?.workspaceName ?: "我的书房", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                    }
                    androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                    SoftTextField(displayName, { displayName = it.take(32) }, "显示称呼")
                    Text("最多 32 个字符。清空后会使用邮箱前缀作为称呼。", color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    AstellaButton(
                        onClick = { viewModel.saveProfile(displayName) },
                        enabled = !state.isAccountBusy && displayName.trim() != state.profile?.displayName.orEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(StudyRadius.lg),
                    ) {
                        if (state.isAccountBusy) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp)
                        else Text(if (displayName.isBlank()) "清除称呼" else "保存称呼")
                    }
                    }
            }
        }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("书房与伴星", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                if (state.workspaces.size > 1) {
                    Box(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                        AstellaOutlinedButton(
                            onClick = { workspaceMenuOpen = true },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(StudyRadius.lg),
                        ) {
                            Icon(Icons.Filled.Book, contentDescription = null, tint = StudyPalette.accent)
                            Text(state.profile?.workspaceName ?: "选择书房", Modifier.weight(1f).padding(start = 8.dp))
                            Text("⌄", color = StudyPalette.muted)
                        }
                        androidx.compose.material3.DropdownMenu(
                            expanded = workspaceMenuOpen,
                            onDismissRequest = { workspaceMenuOpen = false },
                            shape = RoundedCornerShape(StudyRadius.lg),
                            containerColor = StudyPalette.paper,
                            tonalElevation = 0.dp,
                            shadowElevation = 3.dp,
                        ) {
                            state.workspaces.forEach { workspace ->
                                androidx.compose.material3.DropdownMenuItem(
                                    text = { Text(if (workspace.id == state.profile?.workspaceId) "✓  ${workspace.name}" else workspace.name) },
                                    onClick = { workspaceMenuOpen = false; viewModel.switchWorkspace(workspace) },
                                )
                            }
                        }
                    }
                    Text("切换书房会重新接回该空间的对话与手记。", Modifier.padding(start = 2.dp, top = 3.dp),
                        color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                }
                Row(Modifier.fillMaxWidth().padding(vertical = 13.dp), verticalAlignment = Alignment.Top) {
                    Icon(Icons.Filled.Inbox, null, Modifier.padding(top = 2.dp).size(19.dp), tint = StudyPalette.muted)
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("伴星操作权限", color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text(permissionDescription(state.companionPermissionLevel), Modifier.padding(top = 3.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 20.sp)
                        if (state.companionPermissionLevel == null) {
                            AstellaTextButton(onClick = { viewModel.loadAccountSettings() }, enabled = !state.isAccountBusy,
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) { Text("重新读取") }
                        }
                    }
                }
                androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                Column {
                    AccountSubpageRow("使用设置", "字号、对话显示与动效", onClick = onSettings)
                    androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                    AccountSubpageRow("伴星中心", "回到同一段交流，查看她的状态", onClick = onCompanion)
                }
            }
        }
        val settings = state.aiSettings
        if (settings != null) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("AI 与数据", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    Text("你可以控制哪些内容发送到外部服务。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (settings.requiresConsent && settings.consentVersion == null) {
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("阅读《AI 使用协议》", color = StudyPalette.ink, fontWeight = FontWeight.SemiBold)
                                    Text("使用外部 AI 时，完成任务所需的手记、回答、对话或图片可能发送到模型服务；语音讲解也会将讲解文字交给外部语音服务。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, lineHeight = 22.sp)
                                    Text("同意由你本人签署，对你的账号生效。签署前，需要授权的外部 AI 调用不会执行。生成内容可能有误，请结合原文核对。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 20.sp)
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        androidx.compose.material3.Checkbox(
                                            checked = consentAccepted,
                                            onCheckedChange = { consentAccepted = it },
                                            enabled = !state.isAccountBusy,
                                        )
                                        Text("我已阅读并同意《AI 使用协议》", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                                    }
                                    AstellaButton(
                                        onClick = viewModel::acceptAIConsent,
                                        enabled = !state.isAccountBusy && consentAccepted,
                                        modifier = Modifier.fillMaxWidth(),
                                        shape = RoundedCornerShape(StudyRadius.lg),
                                    ) {
                                        Text("同意并开启外部 AI")
                                    }
                            }
                        } else if (settings.consentVersion != null) {
                            Text("✓  已签署 ${settings.consentVersion}${settings.consentAt?.take(10)?.let { " · $it" }.orEmpty()}", color = StudyPalette.success, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                        } else {
                            Text("当前服务未启用外部 AI，无需签署。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                        PolicySwitch("允许使用外部 AI 服务", "允许将任务所需内容发送到模型服务。", policy.sendToExternal,
                            enabled = !state.isAccountBusy && (!settings.requiresConsent || settings.consentVersion != null)) { policy = policy.copy(sendToExternal = it) }
                        PolicySwitch("允许发送图片内容", "图片不会脱离这项设置单独授权。", policy.sendImageContent) { policy = policy.copy(sendImageContent = it) }
                        PolicySwitch("启用个人信息识别", "在请求处理中识别可能的个人信息。", policy.piiDetection) { policy = policy.copy(piiDetection = it) }
                        PolicySwitch("记录 AI 调用审计", "保留服务调用的审计记录。", policy.auditLogging) { policy = policy.copy(auditLogging = it) }
                        AstellaOutlinedButton(
                            onClick = { viewModel.saveAIDataPolicy(policy) },
                            enabled = !state.isAccountBusy && policy != savedPolicy,
                            modifier = Modifier.align(Alignment.End),
                            shape = RoundedCornerShape(StudyRadius.lg),
                        ) { Text("保存数据偏好", color = StudyPalette.accent) }
                    }
            }
            }
        } else if (state.isAccountBusy) {
            item { CircularProgressIndicator(Modifier.padding(22.dp).size(24.dp), color = StudyPalette.accent) }
        }
        item {
            Column {
                AstellaTextButton(
                    onClick = { showAdvancedService = !showAdvancedService },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                ) { Text(if (showAdvancedService) "收起开发与服务" else "开发与服务") }
                if (showAdvancedService) {
                    PaperSurface(Modifier.fillMaxWidth(), padding = StudySpacing.lg) {
                        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                            Text("服务地址", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text("仅在自建服务时修改。保存后会退出当前会话。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            SoftTextField(address, { address = it }, "https://study.example.com", keyboardType = KeyboardType.Uri)
                            AstellaOutlinedButton(onClick = { viewModel.updateServiceAddress(address) }, enabled = address.isNotBlank(), modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(StudyRadius.lg)) {
                                Text("保存并重新登录", color = StudyPalette.accent)
                            }
                        }
                    }
                    }
            }
        }
        item {
            AstellaTextButton(onClick = { viewModel.logout() }, modifier = Modifier.fillMaxWidth().padding(top = 0.dp)) {
                Text("退出登录", color = StudyPalette.danger)
            }
        }
    }
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
