package com.astella.mobile.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.foundation.Image
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
import androidx.compose.ui.res.painterResource
import com.astella.mobile.R
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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

/** 一轮回答的开头：谁在说、用什么方式、花了多久；过程与正文都归在这条线下面。 */
@Composable
fun AssistantTurnHead(run: ActiveRun) {
    Row(
        Modifier.fillMaxWidth().padding(start = 2.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Image(
            painterResource(R.drawable.companion_avatar), null,
            Modifier.size(22.dp).clip(CircleShape)
                .border(.7.dp, Color.White.copy(alpha = .85f), CircleShape),
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
        )
        Text("阿星", color = StudyPalette.ink, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        if (run.thinkingText?.isNotBlank() == true) Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(StudyPalette.accent.copy(alpha = .10f))
                .padding(horizontal = 7.dp)
                .height(21.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(10.dp), tint = StudyPalette.accent)
            Text("深想", color = StudyPalette.accent, fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.weight(1f))
        processElapsedLabel(run).takeIf { it.isNotEmpty() }?.let {
            Text(it, color = StudyPalette.muted.copy(alpha = .66f), fontSize = 9.sp, fontFamily = FontFamily.Monospace)
        }
    }
}

/**
 * 一次过程：收起时只有一行（图标 + 标题 + 用时 + 展开箭头），
 * 展开后节点内部才出现轨道、步骤卡片与思考摘录——正文始终比过程重。
 */
@Composable
fun CompanionRunProcessView(run: ActiveRun, state: AppUiState, viewModel: AppViewModel) {
    val expanded = run.id !in state.journalCollapsed
    val reduce = LocalReduceMotion.current
    val scope = rememberCoroutineScope()
    var recovering by remember(run.id) { mutableStateOf(false) }
    var recoveryNotice by remember(run.id) { mutableStateOf("") }
    var openNodes by remember(run.id) { mutableStateOf(emptySet<String>()) }
    fun recover(reconcileOnly: Boolean) {
        if (recovering) return
        recovering = true
        scope.launch { try { recoveryNotice = viewModel.recoverProcessRun(run, reconcileOnly) } finally { recovering = false } }
    }
    fun toggleNode(id: String) {
        openNodes = if (id in openNodes) openNodes - id else openNodes + id
    }
    val chevron by animateFloatAsState(
        if (expanded) 90f else -90f,
        if (reduce) snap() else MotionTokens.press(),
        label = "process-chevron",
    )
    val faint = StudyPalette.muted.copy(alpha = .66f)
    val rail = StudyPalette.muted.copy(alpha = .28f)
    val cardFill = StudyPalette.paper.copy(alpha = .68f)
    val thinking = run.thinkingText?.takeIf { it.isNotBlank() }
    val visibleNodes = run.nodes.filterNot { it.id.startsWith("status:") }
    val visibleCount = visibleNodes.size + if (thinking != null) 1 else 0
    val toolsLabel = if (visibleNodes.isEmpty()) "思考" else "${visibleNodes.size} 个工具"
    val headerSubtitle = when {
        run.isActive -> run.progressLabel
        expanded -> "$toolsLabel · 可收起"
        else -> "$toolsLabel · 已收起，可展开回看"
    }

    Column(
        Modifier.fillMaxWidth()
            .animateContentSize(if (reduce) snap() else MotionTokens.routePush()),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .clickable { viewModel.toggleProcessDisclosure(run.id) }
                .padding(vertical = 1.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ProcessIconTile(AstellaGlyphKind.Companion, 27.dp, 13.dp)
            Column(
                Modifier.weight(1f).padding(start = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    "思考与工具",
                    color = StudyPalette.ink, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
                )
                Text(
                    headerSubtitle,
                    color = faint, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            processElapsedLabel(run).let {
                if (it.isNotEmpty()) Text(
                    it,
                    Modifier.padding(start = 6.dp),
                    color = faint, fontSize = 9.sp, fontFamily = FontFamily.Monospace, maxLines = 1,
                )
            }
            AstellaGlyph(
                AstellaGlyphKind.Chevron,
                Modifier.padding(start = 6.dp).size(15.dp).rotate(chevron),
                tint = faint,
            )
        }
        if (expanded) {
            Column(
                Modifier.padding(top = 2.dp, start = 2.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (run.status == "failed") {
                    Text(
                        run.failureDescription,
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(StudyPalette.danger.copy(alpha = .07f))
                            .padding(11.dp),
                        color = StudyPalette.danger, fontSize = 12.sp, lineHeight = 19.sp,
                    )
                }
                if (visibleCount == 0) {
                    Text(
                        if (run.isActive) "已接下请求，等待第一段进展。" else "这次交流没有留下详细步骤。",
                        color = StudyPalette.muted, fontSize = 12.5.sp,
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        if (thinking != null) {
                            ProcessTimelineRow(
                                id = "thinking",
                                label = "想了想",
                                code = "thought",
                                icon = AstellaGlyphKind.Companion,
                                stateText = if (run.isActive) "整理中" else "已想",
                                stateTint = if (run.isActive) StudyPalette.accent else StudyPalette.success,
                                dotTint = if (run.isActive) StudyPalette.accent else StudyPalette.success,
                                pulsing = run.isActive,
                                isLast = visibleNodes.isEmpty(),
                                hasBody = true,
                                showsCheck = !run.isActive,
                                open = "thinking" in openNodes,
                                onToggle = { toggleNode("thinking") },
                                rail = rail,
                                cardFill = cardFill,
                                faint = faint,
                            ) {
                                SelectionContainer {
                                    Text(
                                        thinking,
                                        color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 20.sp,
                                    )
                                }
                            }
                        }
                        visibleNodes.forEachIndexed { index, node ->
                            val succeeded = node.status == "succeeded"
                            ProcessTimelineRow(
                                id = node.id,
                                label = node.label,
                                code = node.id.removePrefix("tool:").takeIf { node.id.startsWith("tool:") },
                                icon = processNodeIcon(node),
                                stateText = if (succeeded) "完成" else if (node.isRunning && !run.isActive) "结果待核对" else node.statusLabel,
                                stateTint = processNodeStateTint(node, faint),
                                dotTint = when {
                                    node.isRunning -> StudyPalette.accent
                                    succeeded -> StudyPalette.success
                                    else -> StudyPalette.muted.copy(alpha = .55f)
                                },
                                pulsing = node.isRunning && run.isActive,
                                isLast = index == visibleNodes.lastIndex,
                                hasBody = node.summary?.isNotBlank() == true || node.note != null || (node.proposalId != null && node.status == "waiting_confirmation"),
                                showsCheck = succeeded,
                                open = node.id in openNodes || (node.isRunning && run.isActive),
                                onToggle = { toggleNode(node.id) },
                                rail = rail,
                                cardFill = cardFill,
                                faint = faint,
                            ) {
                                node.summary?.takeIf { it.isNotBlank() }?.let {
                                    SelectionContainer {
                                        Text(it, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 20.sp)
                                    }
                                }
                                node.note?.let { note ->
                                    QuietTextAction(
                                        "预览《${note.title.take(14)}》",
                                        onClick = { viewModel.setResultPreview(note) },
                                        glyph = AstellaGlyphKind.Document,
                                    )
                                }
                                if (node.status == "waiting_confirmation") node.proposalId?.let {
                                    CompanionProposalCard(it, viewModel)
                                }
                            }
                        }
                    }
                }
            }
        }
        val hasActions = run.isActive || run.canResume || (!run.isActive && visibleNodes.any { it.status == "outcome_unknown" })
        if (hasActions) Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (run.isActive) QuietTextAction(
                "停止这次任务",
                onClick = { viewModel.cancelProcessRun(run.id) },
                modifier = Modifier,
            )
            if (!run.isActive && visibleNodes.any { it.status == "outcome_unknown" }) QuietTextAction(
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

private fun processElapsedLabel(run: ActiveRun): String {
    fun timestamp(value: String?) = value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val start = timestamp(run.createdAt) ?: return ""
    val end = if (run.isActive) System.currentTimeMillis() else timestamp(run.updatedAt) ?: System.currentTimeMillis()
    val seconds = ((end - start).coerceAtLeast(0)) / 1000f
    return if (seconds < 60f) String.format(java.util.Locale.US, "%.1fs", seconds)
    else "${(seconds / 60).toInt()}m${(seconds % 60).toInt()}s"
}

private fun processNodeIcon(node: CompanionProcessNode): AstellaGlyphKind {
    val key = "${node.id} ${node.label}".lowercase()
    return when {
        listOf("read", "note", "book", "读").any(key::contains) -> AstellaGlyphKind.Book
        listOf("search", "lookup", "查").any(key::contains) -> AstellaGlyphKind.Search
        listOf("write", "edit", "save", "写").any(key::contains) -> AstellaGlyphKind.Edit
        listOf("quote", "注").any(key::contains) -> AstellaGlyphKind.Quote
        node.note != null -> AstellaGlyphKind.Book
        else -> AstellaGlyphKind.Companion
    }
}

@Composable
private fun processNodeStateTint(node: CompanionProcessNode, faint: Color): Color = when {
    node.isRunning -> StudyPalette.accent
    node.status == "succeeded" -> StudyPalette.success
    node.status == "waiting_confirmation" -> StudyPalette.accent
    node.status in setOf("failed", "outcome_unknown") -> StudyPalette.danger
    else -> faint
}

@Composable
private fun ProcessIconTile(icon: AstellaGlyphKind, size: Dp = 22.dp, iconSize: Dp = 12.dp) {
    Box(
        Modifier.size(size)
            .clip(RoundedCornerShape(size * .34f))
            .background(StudyPalette.paper.copy(alpha = .78f))
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .5f), RoundedCornerShape(size * .34f)),
        contentAlignment = Alignment.Center,
    ) {
        AstellaGlyph(icon, Modifier.size(iconSize), tint = StudyPalette.muted)
    }
}

@Composable
private fun ProcessTimelineRow(
    id: String,
    label: String,
    code: String?,
    icon: AstellaGlyphKind,
    stateText: String?,
    stateTint: Color,
    dotTint: Color,
    pulsing: Boolean,
    isLast: Boolean,
    hasBody: Boolean,
    showsCheck: Boolean = false,
    open: Boolean,
    onToggle: () -> Unit,
    rail: Color,
    cardFill: Color,
    faint: Color,
    content: @Composable ColumnScope.() -> Unit,
) {
    val isOpen = hasBody && open
    val chevron by animateFloatAsState(
        if (isOpen) 90f else 0f,
        label = "node-chevron-$id",
    )
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Column(Modifier.width(14.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.padding(top = 15.dp).size(13.dp), contentAlignment = Alignment.Center) {
                if (pulsing) Box(Modifier.fillMaxSize().background(dotTint.copy(alpha = .16f), CircleShape))
                Box(Modifier.size(7.dp).background(dotTint, CircleShape))
            }
            if (!isLast) Box(
                Modifier.padding(top = 4.dp).width(1.dp).weight(1f).background(rail),
            )
        }
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Row(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(11.dp))
                    .clickable(enabled = hasBody, onClick = onToggle)
                    .padding(vertical = 2.dp)
                    .heightIn(min = 40.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ProcessIconTile(icon)
                Row(
                    Modifier.weight(1f).padding(start = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        label,
                        color = StudyPalette.ink, fontSize = 11.5.sp, fontWeight = FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    if (!code.isNullOrEmpty()) Text(
                        code,
                        Modifier.padding(start = 7.dp),
                        color = faint, fontSize = 8.5.sp, fontFamily = FontFamily.Monospace,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                if (showsCheck) AstellaGlyph(
                    AstellaGlyphKind.Check,
                    Modifier.padding(start = 6.dp).size(9.dp),
                    tint = stateTint,
                )
                stateText?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it,
                        Modifier.padding(start = if (showsCheck) 3.dp else 6.dp),
                        color = stateTint, fontSize = 9.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                    )
                }
                if (hasBody) AstellaGlyph(
                    AstellaGlyphKind.Chevron,
                    Modifier.padding(start = 5.dp).size(15.dp).rotate(chevron),
                    tint = faint,
                ) else Spacer(Modifier.width(20.dp))
            }
            if (isOpen) {
                Column(
                    Modifier.fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .clip(RoundedCornerShape(13.dp))
                        .background(cardFill)
                        .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .4f), RoundedCornerShape(13.dp))
                        .padding(11.dp),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                    content = content,
                )
            }
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
