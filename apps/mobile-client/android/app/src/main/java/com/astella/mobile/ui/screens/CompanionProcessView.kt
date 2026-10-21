package com.astella.mobile.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.*
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.LocalReduceMotion
import com.astella.mobile.ui.design.MotionTokens
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

@Composable
fun CompanionRunClock(run: ActiveRun) {
    var now by remember(run.id) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(run.id, run.status) { while (run.isActive) { now = System.currentTimeMillis(); delay(1000) } }
    fun timestamp(value: String?) = value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val start = timestamp(run.createdAt)
    val end = if (run.isActive) now else timestamp(run.updatedAt) ?: now
    val elapsed = start?.let { ((end - it).coerceAtLeast(0)) / 1000 }
    val last = run.nodes.mapNotNull { timestamp(it.occurredAt) }.maxOrNull() ?: timestamp(run.updatedAt) ?: start
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            (elapsed?.let { "已用 ${it / 60}分${it % 60}秒 · " } ?: "") + "${run.nodes.count { it.note != null }} 份成果已保存",
            style = MaterialTheme.typography.labelSmall,
            color = StudyPalette.muted,
        )
        if (run.isActive && last != null && now - last >= 30_000) Text(
            "暂时没有新进展。已有成果可以先看，也可以停止等待。",
            style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted,
        )
    }
}

/**
 * 一次过程：收起时只占一行（状态点 + 标题 + 用时 + 展开箭头），
 * 展开后才出现时间线、思考摘录和失败说明——正文始终比过程重。
 */
@Composable
fun CompanionRunProcessView(run: ActiveRun, state: AppUiState, viewModel: AppViewModel) {
    val expanded = run.id !in state.journalCollapsed
    val reduce = LocalReduceMotion.current
    val scope = rememberCoroutineScope()
    var recovering by remember(run.id) { mutableStateOf(false) }
    var recoveryNotice by remember(run.id) { mutableStateOf("") }
    fun recover(reconcileOnly: Boolean) {
        if (recovering) return
        recovering = true
        scope.launch { try { recoveryNotice = viewModel.recoverProcessRun(run, reconcileOnly) } finally { recovering = false } }
    }
    val chevron by animateFloatAsState(
        if (expanded) 90f else 0f,
        if (reduce) snap() else MotionTokens.press(),
        label = "process-chevron",
    )
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.lg))
            .background(StudyPalette.inset.copy(alpha = .45f))
            .animateContentSize(if (reduce) snap() else MotionTokens.routePush())
            .padding(horizontal = 13.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .clickable { viewModel.toggleProcessDisclosure(run.id) }
                .padding(vertical = 1.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(runStatusColor(run), CircleShape))
            Text(
                "这次过程",
                Modifier.padding(start = 7.dp),
                color = StudyPalette.ink, fontSize = 12.5.sp, fontWeight = FontWeight.Medium,
            )
            Text(
                " · ${run.statusLabel}",
                color = runStatusColor(run).copy(alpha = .9f), fontSize = 11.sp, maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (run.isActive) "进行中" else "已完成",
                color = StudyPalette.muted, fontSize = 10.5.sp,
            )
            AstellaGlyph(
                AstellaGlyphKind.Chevron,
                Modifier.padding(start = 5.dp).size(11.dp).rotate(chevron),
                tint = StudyPalette.muted,
            )
        }
        if (run.status == "failed") {
            Text(
                run.failureDescription,
                color = StudyPalette.danger, fontSize = 12.5.sp, lineHeight = 19.sp,
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter = if (reduce) fadeIn(snap()) else expandVertically(MotionTokens.routePush()) + fadeIn(MotionTokens.segment()),
            exit = if (reduce) fadeOut(snap()) else shrinkVertically(MotionTokens.routePush()) + fadeOut(MotionTokens.segment()),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                CompanionRunClock(run)
                run.thinkingText?.takeIf { it.isNotBlank() }?.let { thinking ->
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(2.dp).fillMaxHeight().background(StudyPalette.accent.copy(alpha = .35f), CircleShape))
                        SelectionContainer {
                            Text(
                                thinking,
                                Modifier.padding(start = 10.dp),
                                color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp,
                            )
                        }
                    }
                }
                run.nodes.forEach { node ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.Top) {
                            Box(
                                Modifier.padding(top = 5.dp).size(5.dp)
                                    .background(if (node.isRunning) StudyPalette.accent else StudyPalette.muted.copy(alpha = .6f), CircleShape),
                            )
                            Text(
                                node.label,
                                Modifier.weight(1f).padding(start = 8.dp),
                                color = StudyPalette.ink, fontSize = 12.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium,
                            )
                            if (node.id.startsWith("tool:")) Text(
                                if (node.isRunning && !run.isActive) "结果待核对" else node.statusLabel,
                                style = MaterialTheme.typography.labelSmall, color = StudyPalette.muted,
                            )
                        }
                        node.summary?.let {
                            SelectionContainer {
                                Text(
                                    it,
                                    Modifier.padding(start = 13.dp),
                                    color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 19.sp,
                                )
                            }
                        }
                        node.note?.let { note ->
                            QuietTextAction(
                                "预览《${note.title.take(14)}》",
                                onClick = { viewModel.setResultPreview(note) },
                                modifier = Modifier.padding(start = 11.dp),
                                glyph = AstellaGlyphKind.Document,
                            )
                        }
                        if (node.status == "waiting_confirmation") node.proposalId?.let {
                            Box(Modifier.padding(start = 13.dp, top = 2.dp)) { CompanionProposalCard(it, viewModel) }
                        }
                    }
                }
                if (run.nodes.isEmpty() && run.thinkingText.isNullOrBlank()) {
                    Text(
                        if (run.isActive) "已接下请求，等待第一段进展。" else "这次交流没有留下详细步骤。",
                        color = StudyPalette.muted, fontSize = 12.5.sp,
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            if (run.isActive) QuietTextAction(
                "停止这次任务",
                onClick = { viewModel.cancelProcessRun(run.id) },
                modifier = Modifier,
            )
            if (!run.isActive && run.nodes.any { it.status == "outcome_unknown" }) QuietTextAction(
                "核对保存结果",
                enabled = !recovering,
                onClick = { recover(true) },
            )
            if (run.canResume) QuietTextAction(
                "从中断处继续",
                enabled = !recovering,
                onClick = { recover(false) },
            )
        }
        if (recoveryNotice.isNotBlank()) {
            Text(recoveryNotice, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
        }
    }
}

@Composable
private fun runStatusColor(run: ActiveRun): Color = when {
    run.status == "failed" -> StudyPalette.danger
    run.isActive -> StudyPalette.accent
    else -> StudyPalette.success
}

/** 首页顶部的实时进度：一行状态 + 可横向浏览的成果，不再是一整块等重面板。 */
@Composable
fun CompanionLiveProgress(state: AppUiState, viewModel: AppViewModel) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper.copy(alpha = .82f))
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
            .padding(horizontal = 15.dp, vertical = 13.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        state.runs.forEach { run ->
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(runStatusColor(run), CircleShape))
                        Text(
                            run.progressLabel,
                            Modifier.weight(1f).padding(start = 7.dp),
                            color = StudyPalette.ink, fontSize = 13.5.sp, fontWeight = FontWeight.Medium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    CompanionRunClock(run)
                }
                QuietTextAction("查看过程", onClick = { viewModel.showRunInJournal(run.id) })
            }
            val results = run.nodes.mapNotNull { it.note }
            if (results.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                results.forEach { note ->
                    Row(
                        Modifier.clip(CircleShape).background(StudyPalette.sky.copy(alpha = .8f))
                            .clickable { viewModel.setResultPreview(note) }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(12.dp), tint = StudyPalette.accent)
                        Text(
                            note.title,
                            color = StudyPalette.accent, fontSize = 11.5.sp, fontWeight = FontWeight.Medium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        state.processError?.let { Text(it, color = StudyPalette.danger, fontSize = 12.sp, lineHeight = 18.sp) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionResultPreviewSheet(target: CompanionNoteTarget, viewModel: AppViewModel, onOpenNote: (String) -> Unit) {
    var document by remember(target.identity) { mutableStateOf<NoteDocument?>(null) }
    var failure by remember(target.identity) { mutableStateOf<String?>(null) }
    var attempt by remember(target.identity) { mutableIntStateOf(0) }
    val scroll = rememberScrollState(viewModel.previewOffset(target))
    var anchor by remember(target.identity) { mutableStateOf<Int?>(null) }
    var restored by remember(target.identity) { mutableStateOf(false) }
    LaunchedEffect(document?.versionId, anchor) {
        val missingAnchor = target.blockOrdinal != null && document?.blocks?.none { it.ordinal == target.blockOrdinal } == true
        if (!restored && document != null && (target.blockOrdinal == null || anchor != null || missingAnchor)) {
            withFrameNanos { }
            scroll.scrollTo(if (viewModel.hasPreviewOffset(target)) viewModel.previewOffset(target) else anchor ?: 0)
            restored = true
        }
    }
    LaunchedEffect(target.identity, attempt) {
        document = null; failure = null
        try { document = viewModel.loadResultPreview(target) }
        catch (error: Throwable) {
            if (error is CancellationException) throw error
            failure = viewModel.pageMessage(error, "内容可能已删除、权限变化或连接中断。原记录仍在，可以重试读取。")
        }
    }
    DisposableEffect(target.identity) { onDispose { if (document != null) viewModel.savePreviewOffset(target, scroll.value) } }
    ModalBottomSheet(
        onDismissRequest = { viewModel.setResultPreview(null) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = StudyPalette.canvas,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.92f).navigationBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 22.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "成果预览",
                    Modifier.weight(1f),
                    color = StudyPalette.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                )
                QuietTextAction("关闭", onClick = { viewModel.setResultPreview(null) })
            }
            Hairline(startIndent = 22.dp, endIndent = 22.dp, alpha = .45f)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val note = document
                if (note != null) SelectionContainer {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 22.dp, vertical = 18.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text(note.title, color = StudyPalette.ink, fontSize = 25.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "保存的第 ${note.versionNumber} 版",
                            color = StudyPalette.muted, fontSize = 11.5.sp,
                        )
                        if (target.blockOrdinal != null && note.blocks.none { it.ordinal == target.blockOrdinal }) {
                            Text(
                                "原段落已不在这份版本中，以下保留完整正文。",
                                color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 19.sp,
                            )
                        }
                        note.blocks.forEach { block ->
                            Box(Modifier.onGloballyPositioned { coordinates ->
                                if (block.ordinal == target.blockOrdinal) anchor = coordinates.positionInParent().y.toInt()
                            }) { NoteBlockView(block, viewModel = viewModel) }
                        }
                    }
                } else if (failure != null) {
                    Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        ShellNotice(
                            "成果没有打开",
                            failure.orEmpty(),
                            glyph = AstellaGlyphKind.Alert,
                            tint = StudyPalette.danger,
                            actionLabel = "重试",
                            onAction = { attempt++ },
                        )
                    }
                } else Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
                    Text("正在读取已保存的内容…", Modifier.padding(top = 12.dp), color = StudyPalette.muted, fontSize = 12.5.sp)
                }
            }
            Hairline(alpha = .45f)
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                target.runId?.let { runId ->
                    QuietTextAction(
                        "查看这次完整记录",
                        onClick = { viewModel.setResultPreview(null); viewModel.showRunInJournal(runId) },
                        glyph = AstellaGlyphKind.Chat,
                    )
                }
                AstellaButton(
                    onClick = { viewModel.openResultPage(target); onOpenNote(target.noteId) },
                    enabled = document != null,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(StudyRadius.lg),
                ) { Text("打开当前笔记") }
            }
        }
    }
}
