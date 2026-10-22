package com.astella.mobile.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.rotate
import dev.chrisbanes.haze.rememberHazeState
import dev.chrisbanes.haze.hazeSource
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.core.content.ContextCompat
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import kotlin.math.min
import com.astella.mobile.data.*
import com.astella.mobile.R
import com.astella.mobile.ui.design.*
import com.astella.mobile.ui.design.PageEyebrow
import com.astella.mobile.ui.MainNavigationDock
import com.astella.mobile.ui.launch.LocalLaunchLanding

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onAccount: () -> Unit,
    selectedTab: MainTab,
    onSelectTab: (MainTab) -> Unit,
    onOpenNote: (String) -> Unit,
    darkTheme: Boolean,
    onToggleTheme: () -> Unit,
) {
    val reduced = state.localReduceMotion || rememberSystemReducedMotion()
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val focus = LocalFocusManager.current
    var menuOpen by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }
    var composerFocused by remember { mutableStateOf(false) }
    val composerFocus = remember { FocusRequester() }
    LaunchedEffect(state.composerFocusRequest) {
        if (state.composerFocusRequest > 0) runCatching { composerFocus.requestFocus() }
    }
    var flightOrigin by remember { mutableStateOf<Offset?>(null) }
    val flight = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    val menuHaze = rememberHazeState()
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { it?.let(viewModel::selectImage) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(viewModel::selectFile) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        if (it) viewModel.startRecording() else viewModel.reportError("没有麦克风权限，可以在系统设置里允许后重试。")
    }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { viewModel.cancelRecording(); viewModel.stopVoice() } }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); viewModel.cancelRecording(); viewModel.stopVoice() }
    }
    LaunchedEffect(state.attachmentRevision) {
        if (state.attachmentRevision.isNotEmpty() && !reduced) { flight.snapTo(0f); flight.animateTo(1f, tween(520, easing = CubicBezierEasing(.2f, .7f, .15f, 1f))) }
    }
    LaunchedEffect(reduced) {
        if (reduced) flight.snapTo(1f)
    }
    state.resultPreview?.let { target -> key(target.identity) { CompanionResultPreviewSheet(target, viewModel, onOpenNote) } }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
        val height = maxHeight
        val density = LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }
        Column(Modifier.fillMaxSize().hazeSource(menuHaze)) {
            AstellaAppHeader(
                workspace = state.profile?.workspaceName ?: "随身书房",
                initial = state.profile?.displayName?.ifBlank { state.profile.email } ?: "我",
                onAccount = onAccount,
                records = state.chatShowsRecords,
                onRecords = viewModel::setChatShowsRecords,
                workspaces = state.workspaces,
                onWorkspace = viewModel::switchWorkspace,
                darkTheme = darkTheme,
                onThemeToggle = onToggleTheme,
            )
            Box(Modifier.weight(1f)) {
                AnimatedContent(targetState = state.chatShowsRecords,
                    transitionSpec = {
                        if (reduced) fadeIn(tween(120)) togetherWith fadeOut(tween(120))
                        else (fadeIn(spring()) + slideInHorizontally(MotionTokens.segment()) { if (targetState) it / 12 else -it / 12 }) togetherWith
                            (fadeOut(spring()) + slideOutHorizontally(MotionTokens.segment()) { if (targetState) -it / 12 else it / 12 })
                    }, label = "companion-records") { records ->
                    if (records) Column(Modifier.fillMaxSize()) {
                        RecordChatHeader(state, reduced) { viewModel.setChatShowsRecords(false) }
                        Box(Modifier.weight(1f)) { MessageHistory(state, viewModel, reduced) }
                    } else CompanionMeeting(state, viewModel, reduced, onOpenNote) {
                        viewModel.openOrbitSection("hand")
                        onSelectTab(MainTab.Orbit)
                    }
                }
            }
            state.error?.let {
                Box(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 2.dp)) {
                    ShellNotice(
                        "连接暂时中断",
                        it,
                        glyph = AstellaGlyphKind.Alert,
                        tint = StudyPalette.danger,
                        actionLabel = "重新连接",
                        onAction = { viewModel.loadConversation() },
                    )
                }
            }
            if (state.isRecording || state.isTranscribing) Row(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(6.dp).background(StudyPalette.danger, CircleShape))
                Text(
                    if (state.isTranscribing) "正在听清这句话…" else "伴星在听，点麦克风完成",
                    Modifier.weight(1f).padding(start = 8.dp),
                    color = StudyPalette.muted, fontSize = 12.sp,
                )
                if (state.isRecording) QuietTextAction("取消", onClick = viewModel::cancelRecording)
            }
            if (state.isPlaying || state.isPaused || state.isVoiceLoading) Row(
                Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 1.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AstellaGlyph(AstellaGlyphKind.Wave, Modifier.size(13.dp), tint = StudyPalette.accent)
                Text(
                    if (state.isVoiceLoading) "正在接回声音…" else "伴星的声音",
                    Modifier.weight(1f).padding(start = 7.dp),
                    color = StudyPalette.muted, fontSize = 12.sp,
                )
                if (!state.isVoiceLoading) AstellaIconButton(onClick = viewModel::toggleVoicePause) {
                    AstellaGlyph(if (state.isPaused) AstellaGlyphKind.Play else AstellaGlyphKind.Pause, Modifier.size(16.dp), tint = StudyPalette.accent)
                }
                AstellaIconButton(onClick = viewModel::stopVoice) {
                    AstellaGlyph(AstellaGlyphKind.Stop, Modifier.size(14.dp), tint = StudyPalette.muted)
                }
            }
            Column(
                Modifier.padding(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 8.dp)
                    .astellaGlass(26.dp, interactive = true),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (state.selectedImage != null || state.selectedFile != null) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, top = 6.dp)
                            .clip(RoundedCornerShape(StudyRadius.md))
                            .background(StudyPalette.inset.copy(alpha = .7f)),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.padding(6.dp).size(38.dp).pointerInput(reduced) {
                            var delta = Offset.Zero
                            detectDragGestures(onDragStart = { delta = Offset.Zero }, onDrag = { change, amount -> change.consume(); delta += amount }, onDragEnd = {
                                if (delta.y < -40 && !reduced) scope.launch { flightOrigin = Offset(54.dp.toPx(), heightPx - 110.dp.toPx()) + delta; flight.snapTo(0f); flight.animateTo(1f, tween(520)) }
                            })
                        }, contentAlignment = Alignment.Center) {
                            if (state.selectedImage != null) LocalImage(state.selectedImage, Modifier.size(38.dp).clip(RoundedCornerShape(9.dp)))
                            else AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(19.dp), tint = StudyPalette.accent)
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                            Text(state.selectedFile?.name ?: "已添加图片", color = StudyPalette.ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("发送时交给伴星", color = StudyPalette.muted, fontSize = 10.5.sp)
                        }
                        if (state.selectedFile != null) QuietTextAction(
                            "存为手记",
                            onClick = { viewModel.importPreparedFile() },
                            enabled = !state.isSending,
                        )
                        AstellaIconButton(onClick = viewModel::clearAttachment) {
                            AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(16.dp), tint = StudyPalette.muted)
                        }
                    }
                }
                state.pendingNoteContext?.let { note ->
                    Row(
                        Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, top = 6.dp)
                            .clip(RoundedCornerShape(StudyRadius.md))
                            .background(StudyPalette.sky.copy(alpha = .8f))
                            .padding(start = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(14.dp), tint = StudyPalette.accent)
                        Text(note.title, Modifier.weight(1f).padding(8.dp), color = StudyPalette.ink, fontSize = 12.5.sp, maxLines = 1)
                        AstellaIconButton(onClick = viewModel::clearPendingNoteContext) {
                            AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(15.dp), tint = StudyPalette.muted)
                        }
                    }
                }
                if (state.pendingNoteContext == null) state.pendingDiaryReference?.let { reference ->
                    Row(
                        Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, top = 6.dp)
                            .clip(RoundedCornerShape(StudyRadius.md))
                            .background(StudyPalette.sky.copy(alpha = .8f))
                            .padding(start = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AstellaGlyph(AstellaGlyphKind.Orbit, Modifier.size(14.dp), tint = StudyPalette.accent)
                        Text("日记 · ${reference.date} · 第 ${reference.version} 版", Modifier.weight(1f).padding(8.dp), color = StudyPalette.ink, fontSize = 12.5.sp, maxLines = 1)
                        AstellaIconButton(onClick = viewModel::clearPendingDiaryReference) {
                            AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(15.dp), tint = StudyPalette.muted)
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 5.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                        val rotation by animateFloatAsState(
                            targetValue = if (menuOpen) 45f else 0f,
                            animationSpec = if (reduced) snap() else MotionTokens.segment(),
                            label = "plus-menu",
                        )
                        AstellaTap(
                            { focus.clearFocus(); menuOpen = !menuOpen },
                            Modifier.size(44.dp),
                        ) { AstellaGlyph(AstellaGlyphKind.Add, Modifier.align(Alignment.Center).rotate(rotation).size(21.dp), tint = Color(0xFF7B91AE)) }
                        BasicTextField(
                            state.draft, viewModel::draftChanged,
                            Modifier.weight(1f).padding(horizontal = 3.dp, vertical = 15.dp)
                                .focusRequester(composerFocus)
                                .onFocusChanged { composerFocused = it.isFocused },
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 24.sp, color = StudyPalette.ink), maxLines = 5,
                            cursorBrush = SolidColor(StudyPalette.accent),
                            decorationBox = { inner ->
                                if (state.draft.isEmpty()) Text("说给伴星听…", color = StudyPalette.muted.copy(alpha = .75f), fontSize = 16.sp)
                                inner()
                            },
                        )
                        val canSend = state.conversationId != null && !state.isSending && !state.isRecording && !state.isTranscribing && (state.draft.isNotBlank() || state.selectedImage != null || state.selectedFile != null)
                        val voiceAction = state.draft.isBlank() && state.selectedImage == null && state.selectedFile == null
                        AstellaTap(
                            onClick = {
                                focus.clearFocus()
                                when {
                                    state.isRecording -> viewModel.stopAndTranscribe()
                                    voiceAction -> if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) viewModel.startRecording() else permission.launch(Manifest.permission.RECORD_AUDIO)
                                    else -> viewModel.submit(state.draft)
                                }
                            },
                            modifier = Modifier.size(44.dp).background(
                                if (!voiceAction && canSend) StudyPalette.accent
                                else if (state.isRecording) StudyPalette.danger.copy(alpha = .14f)
                                else Color.White.copy(alpha = .55f),
                                RoundedCornerShape(18.dp),
                            ),
                            enabled = if (voiceAction) !state.isTranscribing && !state.isSending else canSend,
                        ) {
                            val glyph = when {
                                state.isRecording -> AstellaGlyphKind.Stop
                                voiceAction -> AstellaGlyphKind.Mic
                                state.isSending -> AstellaGlyphKind.More
                                else -> AstellaGlyphKind.Send
                            }
                            AstellaGlyph(
                                glyph,
                                Modifier.align(Alignment.Center).size(21.dp),
                                tint = when {
                                    state.isRecording -> StudyPalette.danger
                                    !voiceAction && canSend -> MaterialTheme.colorScheme.onPrimary
                                    else -> Color(0xFF7B91AE)
                                },
                            )
                        }
                    }
                if (!composerFocused) {
                    Box(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 2.dp, bottom = 6.dp).height(.7.dp)
                            .background(
                                Brush.horizontalGradient(
                                    listOf(Color.Transparent, StudyPalette.paperEdge.copy(alpha = .7f), Color.Transparent),
                                ),
                            ),
                    )
                    MainNavigationDock(
                        selectedTab = selectedTab,
                        onSelect = onSelectTab,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 2.dp),
                    )
                }
            }
        }
        if (menuOpen) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .08f)).clickable { menuOpen = false })
        AnimatedVisibility(visible = menuOpen, modifier = Modifier.align(Alignment.BottomStart).padding(start = 20.dp, bottom = 88.dp),
            enter = if (reduced) fadeIn(tween(120)) else fadeIn(spring()) + scaleIn(MotionTokens.segment(), initialScale = .94f, transformOrigin = TransformOrigin(0f, 1f)),
            exit = if (reduced) fadeOut(tween(120)) else fadeOut(spring()) + scaleOut(MotionTokens.press(), targetScale = .94f, transformOrigin = TransformOrigin(0f, 1f))) {
            Surface(modifier = Modifier.astellaGlass(22.dp, haze = menuHaze, interactive = true), color = Color.Transparent) {
                Column(Modifier.padding(vertical = 6.dp)) {
                    listOf("加图片" to AstellaGlyphKind.Companion, "加文件" to AstellaGlyphKind.Document, "引用手记" to AstellaGlyphKind.Book)
                        .forEachIndexed { index, (label, icon) ->
                            Row(
                                Modifier.widthIn(min = 196.dp).heightIn(min = 52.dp)
                                    .clickable {
                                        menuOpen = false
                                        when (index) {
                                            0 -> photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                            1 -> files.launch(arrayOf("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"))
                                            else -> showNotes = true
                                        }
                                    }
                                    .padding(horizontal = 18.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                            ) {
                                AstellaGlyph(icon, Modifier.size(20.dp), tint = StudyPalette.accent)
                                Text(label, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 15.5.sp)
                            }
                            if (index < 2) Hairline(startIndent = 18.dp, endIndent = 18.dp, alpha = .4f)
                        }
                }
            }
        }
        if (flight.value < 1 && !reduced) {
            val t = flight.value; val u = 1 - t
            val from = flightOrigin ?: Offset(with(density) { 54.dp.toPx() }, heightPx - with(density) { 110.dp.toPx() })
            val target = Offset(widthPx / 2, heightPx * .3f)
            val control = Offset(target.x + with(density) { 90.dp.toPx() }, from.y - with(density) { 180.dp.toPx() })
            val position = from * (u * u) + control * (2 * u * t) + target * (t * t)
            Surface(Modifier.graphicsLayer { translationX = position.x - 28.dp.toPx(); translationY = position.y - 28.dp.toPx(); scaleX = 1 - t * .86f; scaleY = scaleX; rotationZ = -24 * t; alpha = min(1f, (1 - t) * 6) }.size(56.dp), shape = RoundedCornerShape(18.dp), color = StudyPalette.paper, shadowElevation = 8.dp) {
                Box(contentAlignment = Alignment.Center) { AstellaGlyph(if (state.selectedFile == null) AstellaGlyphKind.Companion else AstellaGlyphKind.Document, Modifier.size(20.dp), tint = StudyPalette.accent) }
            }
        }
    }
    if (showNotes) ModalBottomSheet(
        onDismissRequest = { showNotes = false },
        containerColor = StudyPalette.canvas,
    ) {
        LaunchedEffect(Unit) { viewModel.loadNotes("") }
        Row(
            Modifier.fillMaxWidth().padding(start = 22.dp, end = 16.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                PageEyebrow("引用")
                Text("选择一篇手记", color = StudyPalette.ink, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold)
            }
            QuietTextAction("关闭", onClick = { showNotes = false })
        }
        LazyColumn(
            Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(max = 520.dp),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(state.notes, key = { it.id }) { note ->
                Row(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(StudyRadius.lg))
                        .background(StudyPalette.paper)
                        .clickable { viewModel.referenceNote(note.id); showNotes = false }
                        .padding(horizontal = 14.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        Modifier.size(32.dp).background(StudyPalette.sky.copy(alpha = .8f), RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) { AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(16.dp), tint = StudyPalette.accent) }
                    Text(
                        note.title, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 15.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.muted.copy(alpha = .6f))
                }
            }
            if (state.notes.isEmpty()) item {
                Text("还没有可以引用的手记。", Modifier.padding(16.dp), color = StudyPalette.muted, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun CompanionMeeting(state: AppUiState, viewModel: AppViewModel, reduced: Boolean, onOpenNote: (String) -> Unit, onOpenOrbit: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = maxHeight
        val latest = state.messages.lastOrNull { it.role == "assistant" }
        val hasReply = latest != null || state.streamingText.isNotEmpty()
        val stageHeight = if (hasReply) 218.dp else minOf(308.dp, maxOf(248.dp, height * .43f))
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp),
        ) {
            StaggerReveal(0) {
                CompanionSpeechCard(
                    state = state,
                    hasReply = hasReply,
                    latest = latest,
                    onOpenRecords = { viewModel.setChatShowsRecords(true) },
                )
            }
            Spacer(Modifier.height(6.dp))
            BoxWithConstraints(Modifier.fillMaxWidth().height(stageHeight), contentAlignment = Alignment.Center) {
                val accent = StudyPalette.accent
                val ice = StudyPalette.pollen
                Canvas(Modifier.fillMaxSize()) {
                    drawCircle(
                        Brush.radialGradient(
                            listOf(
                                accent.copy(alpha = if (state.isRecording || state.isPlaying) .13f else .06f),
                                ice.copy(alpha = .10f),
                                Color.Transparent,
                            ),
                            center = center,
                            radius = size.width * .32f,
                        ),
                        radius = size.width * .34f,
                        center = center,
                    )
                }
                CompanionStage(state, reduced, Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 4.dp))
            }
            if (!hasReply) {
                val recentNoteId = viewModel.recentNoteId()
                (state.notes.firstOrNull { it.id == recentNoteId } ?: state.notes.firstOrNull())?.let { note ->
                    val hasReadingHistory = note.id == recentNoteId
                    Spacer(Modifier.height(10.dp))
                    StaggerReveal(1) {
                        AstellaTap(
                            { onOpenNote(note.id) },
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(StudyRadius.xl)),
                        ) {
                            Row(
                                Modifier.fillMaxWidth()
                                    .background(StudyPalette.paper.copy(alpha = .72f), RoundedCornerShape(StudyRadius.xl))
                                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .42f), RoundedCornerShape(StudyRadius.xl))
                                    .padding(horizontal = 16.dp, vertical = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                NoteCover(
                                    note.title,
                                    Modifier.size(42.dp, 58.dp),
                                    note.id,
                                    rotate = -6f,
                                    textSize = 14.sp,
                                )
                                Column(Modifier.weight(1f).padding(start = 15.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(
                                        if (hasReadingHistory) "继续一起读" else "最近留下的手记",
                                        fontSize = 9.5.sp, letterSpacing = .9.sp, color = StudyPalette.muted,
                                        fontWeight = FontWeight.Medium,
                                    )
                                    Text(
                                        note.title.substringBefore('·').trim(),
                                        fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold,
                                        color = StudyPalette.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        if (hasReadingHistory) "上次停下的那一页" else "最近更新 · 随时回来读",
                                        fontSize = 11.sp, color = StudyPalette.muted,
                                    )
                                }
                                AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.muted.copy(alpha = .6f))
                            }
                        }
                    }
                }
            }
            if (state.runs.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                Box(Modifier.fillMaxWidth()) { CompanionLiveProgress(state, viewModel) }
            }
            Spacer(Modifier.height(16.dp))
        }
        // 右下角两个轻入口合并成一枚竖胶囊，减少两个悬浮圆互抢。
        Column(
            Modifier.align(Alignment.BottomEnd).padding(end = 18.dp, bottom = 10.dp)
                .astellaGlass(22.dp, interactive = true),
            verticalArrangement = Arrangement.Center,
        ) {
            AstellaTap(
                { viewModel.setChatShowsRecords(true) },
                Modifier.size(44.dp).semantics { contentDescription = "回想练习" },
            ) {
                AstellaGlyph(AstellaGlyphKind.History, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
            }
            Box(Modifier.padding(horizontal = 13.dp).height(.7.dp).background(StudyPalette.paperEdge.copy(alpha = .5f)))
            AstellaTap(
                onOpenOrbit,
                Modifier.size(44.dp).semantics { contentDescription = "今日手边" },
            ) {
                AstellaGlyph(AstellaGlyphKind.Hand, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
            }
        }
    }
}

/**
 * 伴星此刻说的话：唯一的上下文焦点。
 * 欢迎态是引子（15/24），回应态才是内容（16/26）；“在记录里继续看”收成一行安静入口。
 */
@Composable
private fun CompanionSpeechCard(
    state: AppUiState,
    hasReply: Boolean,
    latest: CompanionMessage?,
    onOpenRecords: () -> Unit,
) {
    val shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 7.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 6.dp)
            .astellaGlass(20.dp)
            .clip(shape)
            .padding(horizontal = 18.dp, vertical = 15.dp),
        verticalArrangement = Arrangement.spacedBy(if (hasReply && latest != null && state.streamingText.isEmpty()) 7.dp else 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AstellaStar(Modifier.size(9.dp), color = StudyPalette.accent)
            Text(
                when {
                    state.streamingText.isNotEmpty() -> "正在回应"
                    hasReply -> "阿星轻轻说"
                    state.isRecording || state.isPlaying -> "此刻，听见彼此。"
                    else -> "阿星轻轻说"
                },
                fontSize = 10.sp, letterSpacing = .7.sp, fontWeight = FontWeight.SemiBold, color = StudyPalette.muted,
            )
        }
        if (state.streamingText.isNotEmpty()) {
            CompanionMarkdownText(state.streamingText, fontSize = 16.sp, lineHeight = 27.sp, color = StudyPalette.ink)
        } else if (latest != null) {
            CompanionMarkdownText(
                latest.displayText,
                fontSize = 16.sp,
                lineHeight = 27.sp,
                color = StudyPalette.ink,
                maxLines = hasReplyPreviewLines(latest),
                overflow = TextOverflow.Ellipsis,
            )
            QuietTextAction("在记录里继续看", onClick = onOpenRecords, glyph = AstellaGlyphKind.Chat)
        } else {
            Text(
                "我在这里。刚读到的、想到的，都可以慢慢说给我听。",
                fontSize = 15.sp, lineHeight = 25.sp, color = StudyPalette.ink,
            )
        }
    }
}

private fun hasReplyPreviewLines(message: CompanionMessage): Int = 4

@Composable
private fun CompanionStage(state: AppUiState, reduced: Boolean, modifier: Modifier) {
    val landing = LocalLaunchLanding.current
    val stageModifier = modifier.onGloballyPositioned { landing.onBounds(it.boundsInWindow()) }
        .graphicsLayer { alpha = if (landing.hideCompanion) 0f else 1f }
    val pulse = remember { Animatable(1f) }
    LaunchedEffect(state.attachmentRevision) {
        if (state.attachmentRevision.isNotEmpty() && !reduced) { pulse.animateTo(.97f, spring()); pulse.animateTo(1.03f, spring(dampingRatio = .8f)); pulse.animateTo(1f, spring()) }
    }
    LaunchedEffect(reduced) {
        if (reduced) pulse.snapTo(1f)
    }
    var failed by remember(state.companionModel) { mutableStateOf(false) }
    val model = state.companionModel
    var surface by remember { mutableStateOf<com.astella.mobile.companion.CompanionSurface?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, surface) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) surface?.onPause()
            if (event == Lifecycle.Event.ON_RESUME) surface?.onResume()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(state.attachmentRevision, surface) {
        if (state.attachmentRevision.isNotEmpty()) { kotlinx.coroutines.delay(if (reduced) 0 else 450); surface?.event = 1; surface?.requestRender() }
    }
    LaunchedEffect(state.runs.size) { if (state.runs.isNotEmpty()) { surface?.event = 2; surface?.requestRender() } }
    LaunchedEffect(state.error) { if (state.error != null) { surface?.event = 3; surface?.requestRender() } }
    if (model != null && !failed) {
        androidx.compose.ui.viewinterop.AndroidView(
            factory = { context -> com.astella.mobile.companion.CompanionSurface(context, model) { failed = true }.also { surface = it } },
            modifier = stageModifier.clickable { surface?.event = 4; surface?.requestRender() },
            update = { view ->
                view.mouth = if (state.isPlaying) state.audioLevel else 0f
                view.reduced = reduced
                view.requestRender()
            },
            onRelease = { it.dispose(); it.onPause() },
        )
    } else Image(painterResource(R.drawable.companion_stage), "伴星在这里", stageModifier.graphicsLayer { scaleX = pulse.value; scaleY = pulse.value }, contentScale = androidx.compose.ui.layout.ContentScale.Fit)
}

@Composable
private fun RecordChatHeader(state: AppUiState, reduced: Boolean, onBackToCompanion: () -> Unit) {
    Column {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 6.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                painterResource(R.drawable.companion_avatar), null,
                Modifier.size(36.dp).clip(CircleShape)
                    .border(.8.dp, Color.White.copy(alpha = .8f), CircleShape),
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            )
            Column(Modifier.weight(1f).padding(start = 11.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("阿星", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.2).sp)
                    Text("· 记录", color = StudyPalette.muted, fontSize = 11.sp)
                }
                Text("同一段相伴，慢慢聊下去。", color = StudyPalette.muted, fontSize = 11.sp)
            }
            QuietTextAction(
                "回到伴星",
                onClick = onBackToCompanion,
                glyph = AstellaGlyphKind.Companion,
            )
        }
        Hairline(startIndent = 20.dp, endIndent = 20.dp, alpha = .42f)
    }
}

@Composable
private fun MessageHistory(state: AppUiState, viewModel: AppViewModel, reduceMotion: Boolean) {
    val saved = remember { viewModel.journalReadingPosition() }
    val savedIndex = state.messages.indexOfFirst { it.id == saved.first }.takeIf { it >= 0 }?.plus(1) ?: saved.second
    val listState = rememberLazyListState(savedIndex, saved.third)
    var didInitialPosition by remember { mutableStateOf(!state.journalFollowsLatest) }
    val current by rememberUpdatedState(state)
    val itemCount = state.messages.size + 1 + if (state.streamingText.isNotEmpty()) 1 else 0
    LaunchedEffect(itemCount, state.journalTargetRunId, state.processRuns) {
        val target = state.journalTargetRunId
        val run = state.processRuns.firstOrNull { it.id == target }
        val targetIndex = state.messages.indexOfFirst { it.id == run?.userMessageId || (run?.userMessageId == null && it.id == run?.assistantMessageId) }
        if (target != null && targetIndex >= 0) {
            listState.scrollToItem(targetIndex + 1)
            didInitialPosition = true
            viewModel.state.value = viewModel.state.value.copy(journalTargetRunId = null, journalFollowsLatest = false)
        } else if (itemCount > 1 && !didInitialPosition && target == null) {
            listState.scrollToItem(itemCount - 1)
            didInitialPosition = true
        } else if (state.journalFollowsLatest && itemCount > 1 && target == null) {
            if (reduceMotion) listState.scrollToItem(itemCount - 1) else listState.animateScrollToItem(itemCount - 1)
        }
    }
    LaunchedEffect(state.streamingText) {
        if (state.streamingText.isNotEmpty() && state.journalFollowsLatest) {
            val count = listState.layoutInfo.totalItemsCount
            if (count > 0) listState.scrollToItem(count - 1)
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { Triple(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset, listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) }
            .collect { (index, offset, last) ->
                if (didInitialPosition && listState.layoutInfo.totalItemsCount > 0) {
                    val key = listState.layoutInfo.visibleItemsInfo.firstOrNull()?.key as? String
                    viewModel.saveJournalReading(key, index, offset, last >= listState.layoutInfo.totalItemsCount - 2)
                }
            }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item(key = "history-start") {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (state.historyHasMore) {
                        AstellaTextButton(
                            onClick = { viewModel.loadOlderConversationMessages() },
                            enabled = !state.historyLoadingOlder,
                        ) {
                            Text(
                                if (state.historyLoadingOlder) "正在读取更早记录…" else "查看更早的记录",
                                fontSize = 12.5.sp,
                            )
                        }
                    }
                    state.processError?.let {
                        ShellNotice("过程状态没有同步", it, glyph = AstellaGlyphKind.Alert, tint = StudyPalette.danger)
                    }
                }
            }
            itemsIndexed(state.messages, key = { _, message -> message.id }) { index, message ->
                Column(
                    Modifier.then(if (reduceMotion) Modifier else Modifier.animateItem()),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    val turnRun = if (message.role == "assistant") state.processRuns.firstOrNull { it.assistantMessageId == message.id } else null
                    MobileMessageRow(
                        message, viewModel, reduceMotion,
                        showsAvatar = turnRun == null,
                        showsBodyLabel = turnRun != null,
                    )
                    state.processRuns.filter { it.userMessageId == message.id || (it.userMessageId == null && it.assistantMessageId == message.id) }
                        .forEach { run ->
                            AssistantTurnHead(run)
                            CompanionRunProcessView(run, state, viewModel)
                        }
                }
            }
            if (state.streamingText.isNotEmpty()) item(key = "streaming") {
                Column(Modifier.then(if (reduceMotion) Modifier else Modifier.animateItem()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                        Image(
                            painterResource(R.drawable.brand_mark), null,
                            Modifier.padding(top = 3.dp, end = 10.dp).size(26.dp).clip(CircleShape),
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        )
                        Column(Modifier.weight(1f)) {
                            Text("阿星", color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .4.sp)
                            Spacer(Modifier.height(5.dp))
                            CompanionMarkdownText(state.streamingText, color = StudyPalette.ink, fontSize = 16.sp, lineHeight = 26.sp)
                        }
                    }
                }
            }
        }
        AnimatedVisibility(
            visible = !state.journalFollowsLatest,
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 18.dp, bottom = 14.dp),
            enter = if (reduceMotion) fadeIn(tween(1)) else fadeIn(spring()) + slideInVertically(MotionTokens.segment()) { it / 3 },
            exit = if (reduceMotion) fadeOut(tween(1)) else fadeOut(tween(120)),
        ) {
            AstellaTap(
                onClick = {
                    viewModel.state.value = current.copy(journalFollowsLatest = true)
                    viewModel.saveJournalReading(null, (itemCount - 1).coerceAtLeast(0), 0, true)
                },
                Modifier.astellaGlass(22.dp, interactive = true),
            ) {
                Row(
                    Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(11.dp).rotate(90f), tint = StudyPalette.accent)
                    Text("回到最新", color = StudyPalette.accent, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
        if (state.messages.isEmpty() && state.streamingText.isEmpty()) {
            Column(
                Modifier.align(Alignment.Center).padding(horizontal = 28.dp).fillMaxWidth()
                    .clip(RoundedCornerShape(StudyRadius.xl))
                    .background(StudyPalette.paper.copy(alpha = .7f))
                    .padding(horizontal = 20.dp, vertical = 22.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                AstellaStar(Modifier.size(18.dp), color = StudyPalette.accent.copy(alpha = .8f))
                Text("还没有交流记录", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "在下方输入，和伴星开始一段交流。",
                    color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp, textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
fun MobileMessageRow(
    message: CompanionMessage,
    viewModel: AppViewModel,
    reduceMotion: Boolean = false,
    showsAvatar: Boolean = true,
    showsBodyLabel: Boolean = false,
) {
    val user = message.role == "user"
    if (user) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                modifier = Modifier.fillMaxWidth(.86f),
                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 6.dp),
                color = StudyPalette.sky.copy(alpha = .78f),
            ) {
                Column(Modifier.padding(horizontal = 15.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    message.blocks.forEachIndexed { index, block ->
                        when {
                            block.type == "image" && !block.url.isNullOrBlank() -> AuthenticatedImage(block.url, block.alt ?: block.label ?: "对话图片", viewModel)
                            block.type == "image" -> Text(block.label ?: "图片", color = StudyPalette.muted, fontSize = 13.sp)
                            block.type == "file" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(14.dp), tint = StudyPalette.accent)
                                Text(block.name ?: "文件附件", color = StudyPalette.accent, fontSize = 13.sp)
                            }
                            block.proposalId != null -> CompanionProposalCard(block.proposalId, viewModel)
                            block.noteTarget != null -> OutlinedButton(onClick = { viewModel.setResultPreview(block.noteTarget.copy(runId = message.runId)) }) {
                                Text("预览《${block.noteTarget.title}》", fontSize = 13.sp)
                            }
                            block.type in setOf("diagram", "card", "citation", "code", "quote") -> CompanionRichBlock(block, "${message.id}:$index:${block.type}", message.runId, viewModel)
                            !block.text.isNullOrBlank() -> CompanionMarkdownText(
                                block.text,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                                fontSize = 15.5.sp,
                                lineHeight = 24.sp,
                            )
                        }
                    }
                }
            }
        }
        return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        if (showsAvatar) Image(
            painterResource(R.drawable.brand_mark), null,
            Modifier.padding(top = 3.dp, end = 10.dp).size(26.dp).clip(CircleShape),
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (showsBodyLabel) Row(
                Modifier.padding(start = 2.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text("正文", color = StudyPalette.muted, fontSize = 9.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .9.sp)
                AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(10.dp), tint = StudyPalette.success)
                Text("已写完", color = StudyPalette.success, fontSize = 9.sp)
                Spacer(Modifier.weight(1f))
            }
            if (!showsBodyLabel) Text("阿星", color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .4.sp)
            message.blocks.forEachIndexed { index, block ->
                when {
                    block.type == "image" && !block.url.isNullOrBlank() -> AuthenticatedImage(block.url, block.alt ?: block.label ?: "对话图片", viewModel)
                    block.type == "image" -> Text(block.label ?: "图片", color = StudyPalette.muted, fontSize = 13.sp)
                    block.type == "file" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(14.dp), tint = StudyPalette.accent)
                        Text(block.name ?: "文件附件", color = StudyPalette.accent, fontSize = 13.sp)
                    }
                    block.proposalId != null -> CompanionProposalCard(block.proposalId, viewModel)
                    block.noteTarget != null -> AstellaOutlinedButton(onClick = { viewModel.setResultPreview(block.noteTarget.copy(runId = message.runId)) }) {
                        Text("预览《${block.noteTarget.title}》", fontSize = 13.sp)
                    }
                    block.type in setOf("diagram", "card", "citation", "code", "quote") -> CompanionRichBlock(block, "${message.id}:$index:${block.type}", message.runId, viewModel)
                    !block.text.isNullOrBlank() -> CompanionMarkdownText(
                        block.text,
                        color = StudyPalette.ink,
                        fontSize = 16.sp,
                        lineHeight = 26.sp,
                    )
                }
            }
            if (message.displayText.isNotBlank()) {
                QuietTextAction("朗读", onClick = { viewModel.playVoice(message.displayText) }, glyph = AstellaGlyphKind.Wave)
            }
        }
    }
}

@Composable
private fun AuthenticatedImage(url: String, description: String, viewModel: AppViewModel) {
    var bytes by remember(url) { mutableStateOf<ByteArray?>(null) }
    var failure by remember(url) { mutableStateOf(false) }
    var attempt by remember(url) { mutableIntStateOf(0) }
    var opened by rememberSaveable(url) { mutableStateOf(false) }
    LaunchedEffect(url, attempt) { failure = false; try { bytes = viewModel.imageBytes(url) }
        catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { failure = true } }
    val bitmap = remember(bytes) { bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    if (bitmap != null) Image(bitmap, description, Modifier.fillMaxWidth().heightIn(max = 320.dp).clip(RoundedCornerShape(StudyRadius.md)).clickable { opened = true }, contentScale = androidx.compose.ui.layout.ContentScale.Fit)
    else if (failure || bytes != null) Column { Text("图片暂时无法读取，请检查连接后重试。"); OutlinedButton(onClick = { attempt++ }) { Text("重新读取图片") } }
    else Box(Modifier.fillMaxWidth().height(72.dp).clip(RoundedCornerShape(StudyRadius.md)).background(StudyPalette.sky.copy(alpha = .4f)), contentAlignment = Alignment.Center) {
        Text("正在载入图片…", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
    if (opened && bitmap != null) Dialog(onDismissRequest = { opened = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var pan by remember { mutableStateOf(Offset.Zero) }
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { opened = false }) { Text("关闭") }; TextButton(onClick = { scale = 1f; pan = Offset.Zero }) { Text("还原") }
            }
                Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().pointerInput(url) { detectTransformGestures { _, delta, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f); pan = if (scale == 1f) Offset.Zero else pan + delta
                } }, contentAlignment = Alignment.Center) {
                    Image(bitmap, description, Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = pan.x; translationY = pan.y }, contentScale = androidx.compose.ui.layout.ContentScale.Fit)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionRichBlock(block: com.astella.mobile.data.CompanionBlock, identity: String, runId: String?, viewModel: AppViewModel) {
    var opened by rememberSaveable(identity) { mutableStateOf(false) }
    var snapshot by remember(identity) { mutableStateOf(block) }
    var readSource by remember(identity) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        CompanionRichContent(block)
        Row(verticalAlignment = Alignment.CenterVertically) {
            block.sourceRef?.let { source ->
                if (source.kind == "note" && source.noteId != null) QuietTextAction(
                    "笔记原文",
                    glyph = AstellaGlyphKind.Book,
                    onClick = {
                        viewModel.setResultPreview(CompanionNoteTarget(source.noteId, source.noteVersionId, block.label ?: "引用原文", runId, source.blockOrdinal))
                    },
                ) else if (source.kind == "source" && source.sourceId != null) QuietTextAction(
                    "来源全文",
                    glyph = AstellaGlyphKind.Document,
                    onClick = { snapshot = block; readSource = true; opened = true },
                )
            }
            if (block.type != "citation") QuietTextAction(
                "展开",
                glyph = AstellaGlyphKind.Eye,
                onClick = { snapshot = block; readSource = false; opened = true },
            )
        }
    }
    if (opened) {
        val readerIdentity = "$identity:${if (readSource) "source" else "content"}"
        val scroll = rememberScrollState()
        var sourceSegments by remember(readerIdentity) { mutableStateOf<List<Pair<Int, String>>?>(null) }
        var failure by remember(readerIdentity) { mutableStateOf<String?>(null) }
        var attempt by remember(readerIdentity) { mutableIntStateOf(0) }
        var anchor by remember(readerIdentity) { mutableStateOf<Int?>(null) }
        var restored by remember(readerIdentity) { mutableStateOf(false) }
        LaunchedEffect(readerIdentity, attempt) {
            if (!readSource) return@LaunchedEffect
            val sourceId = snapshot.sourceRef?.sourceId ?: return@LaunchedEffect
            val scope = viewModel.state.value.profile
            failure = null
            try {
                val response = viewModel.requestApi("/sources/$sourceId")
                if (viewModel.state.value.profile !== scope) return@LaunchedEffect
                val segments = response.optJSONArray("segments") ?: error("source body unavailable")
                sourceSegments = List(segments.length()) { index -> segments.getJSONObject(index).let { it.optInt("ordinal") to it.optString("text") } }
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (_: Exception) { if (viewModel.state.value.profile === scope) failure = "来源暂时无法读取，可能已删除、权限变化或连接中断。" }
        }
        LaunchedEffect(readerIdentity, sourceSegments, anchor) {
            if (restored || (readSource && sourceSegments == null)) return@LaunchedEffect
            val ordinal = snapshot.sourceRef?.segmentOrdinal
            if (readSource && ordinal != null && sourceSegments?.any { it.first == ordinal } == true && anchor == null) return@LaunchedEffect
            androidx.compose.runtime.withFrameNanos { }
            scroll.scrollTo(if (viewModel.hasContentPreviewOffset(readerIdentity)) viewModel.contentPreviewOffset(readerIdentity) else anchor ?: 0)
            restored = true
        }
        DisposableEffect(readerIdentity) { onDispose { if (!readSource || sourceSegments != null) viewModel.saveContentPreviewOffset(readerIdentity, scroll.value) } }
        ModalBottomSheet(
            onDismissRequest = { opened = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = StudyPalette.canvas,
        ) {
            Column(Modifier.fillMaxHeight(.95f)) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 22.dp, end = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        snapshot.title ?: snapshot.label ?: "内容预览",
                        Modifier.weight(1f),
                        color = StudyPalette.ink,
                        fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    QuietTextAction("关闭", onClick = { opened = false })
                }
                Hairline(startIndent = 22.dp, endIndent = 22.dp, alpha = .45f)
                Column(
                    Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 22.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (!readSource) CompanionRichContent(snapshot)
                    else if (failure != null) {
                        ShellNotice(
                            "来源没有打开",
                            failure.orEmpty(),
                            glyph = AstellaGlyphKind.Alert,
                            tint = StudyPalette.danger,
                            actionLabel = "重试",
                            onAction = { attempt++ },
                        )
                    } else if (sourceSegments == null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(16.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
                            Text("正在读取来源全文…", Modifier.padding(start = 8.dp), color = StudyPalette.muted, fontSize = 12.5.sp)
                        }
                    } else {
                        if (sourceSegments?.isEmpty() == true) {
                            Text("这份来源暂时没有可阅读的正文，原摘录仍在手记中。", color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 21.sp)
                        }
                        sourceSegments?.forEach { (ordinal, text) ->
                            SelectionContainer {
                                Text(
                                    text,
                                    Modifier.onGloballyPositioned { coordinates ->
                                        if (ordinal == snapshot.sourceRef?.segmentOrdinal) anchor = coordinates.positionInParent().y.toInt()
                                    },
                                    color = StudyPalette.readerInk, fontSize = 16.sp, lineHeight = 27.sp,
                                )
                            }
                        }
                    }
                }
                if (runId != null) {
                    Hairline(startIndent = 22.dp, endIndent = 22.dp, alpha = .45f)
                    QuietTextAction(
                        "查看这次完整记录",
                        onClick = { opened = false; viewModel.showRunInJournal(runId) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        glyph = AstellaGlyphKind.Chat,
                    )
                }
            }
        }
    }
}

@Composable
private fun CompanionRichContent(block: com.astella.mobile.data.CompanionBlock) {
    val uriHandler = LocalUriHandler.current
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (block.type) {
                "diagram" -> {
                    Text(
                        block.title ?: "步骤流程",
                        color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                    )
                    block.steps.forEachIndexed { index, step ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                            Box(
                                Modifier.padding(top = 1.dp).size(20.dp).background(StudyPalette.sky, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text("${index + 1}", color = StudyPalette.accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            }
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(step.label, color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                step.detail?.let { Text(it, color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp) }
                            }
                        }
                    }
                }
                "card" -> {
                    Text("保存的题面", color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                    Text(block.front ?: "这份记录没有保留题面。", color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 24.sp)
                    block.summary?.let { Text(it, color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp) }
                }
                "quote" -> {
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(2.5.dp).fillMaxHeight().background(StudyPalette.accent.copy(alpha = .5f), CircleShape))
                        Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(block.label ?: "引用原文", color = StudyPalette.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                            Text(block.text.orEmpty(), color = StudyPalette.readerInk, fontSize = 15.sp, lineHeight = 24.sp)
                        }
                    }
                }
                "citation" -> {
                    val target = block.citation
                    val href = target?.href
                    if (target?.kind == "external_https" && href != null && Uri.parse(href).scheme == "https") {
                        QuietTextAction(
                            block.label ?: "查看来源",
                            onClick = { uriHandler.openUri(href) },
                            glyph = AstellaGlyphKind.Document,
                        )
                    } else {
                        Text(block.label ?: "来源", color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                        Text(
                            "这份来源需要在书房中定位：${target?.entityRef ?: "标识暂缺"}",
                            color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp,
                        )
                    }
                }
                "code" -> Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(StudyRadius.md))
                        .background(StudyPalette.inset.copy(alpha = .7f)).padding(12.dp),
                ) {
                    Text(
                        block.code.orEmpty(),
                        Modifier.horizontalScroll(rememberScrollState()),
                        color = StudyPalette.ink, fontSize = 13.sp, lineHeight = 20.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

@Composable
private fun LocalImage(uri: Uri, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val bitmap = remember(uri) { runCatching { context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream) }.getOrNull() }
    if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "待发送图片", modifier = modifier, contentScale = androidx.compose.ui.layout.ContentScale.Crop)
    else Box(modifier.background(StudyPalette.sky, RoundedCornerShape(StudyRadius.sm)))
}
