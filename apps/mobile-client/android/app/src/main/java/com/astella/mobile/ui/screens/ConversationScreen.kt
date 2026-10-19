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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.*
import androidx.compose.ui.text.font.FontWeight
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
                    if (records) MessageHistory(state, viewModel, reduced)
                    else CompanionMeeting(state, viewModel, reduced, onOpenNote)
                }
            }
            state.error?.let { ConnectionFailureNotice("连接暂时中断", it, "重新连接", onRetry = { viewModel.loadConversation() }) }
            if (state.isRecording || state.isTranscribing) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (state.isTranscribing) "正在听清这句话…" else "伴星在听，点麦克风完成", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted)
                if (state.isRecording) AstellaTextButton(onClick = viewModel::cancelRecording) { Text("取消") }
            }
            if (state.isPlaying || state.isPaused || state.isVoiceLoading) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (state.isVoiceLoading) "正在接回声音…" else "伴星的声音", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted)
                if (!state.isVoiceLoading) AstellaIconButton(onClick = viewModel::toggleVoicePause) { AstellaGlyph(if (state.isPaused) AstellaGlyphKind.Play else AstellaGlyphKind.Pause, Modifier.size(17.dp), tint = StudyPalette.accent) }
                AstellaIconButton(onClick = viewModel::stopVoice) { AstellaGlyph(AstellaGlyphKind.Stop, Modifier.size(15.dp), tint = StudyPalette.muted) }
            }
            Column(Modifier.padding(start = 15.dp,end = 15.dp,top = 8.dp,bottom = 8.dp).astellaGlass(30.dp, interactive = true), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (state.selectedImage != null || state.selectedFile != null) Surface(shape = RoundedCornerShape(16.dp), color = StudyPalette.inset) {
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(40.dp).pointerInput(reduced) {
                            var delta = Offset.Zero
                            detectDragGestures(onDragStart = { delta = Offset.Zero }, onDrag = { change, amount -> change.consume(); delta += amount }, onDragEnd = {
                                if (delta.y < -40 && !reduced) scope.launch { flightOrigin = Offset(54.dp.toPx(), heightPx - 110.dp.toPx()) + delta; flight.snapTo(0f); flight.animateTo(1f, tween(520)) }
                            })
                        }, contentAlignment = Alignment.Center) {
                            if (state.selectedImage != null) LocalImage(state.selectedImage, Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)))
                            else AstellaGlyph(AstellaGlyphKind.Document, Modifier.size(20.dp), tint = StudyPalette.accent)
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            Text(state.selectedFile?.name ?: "已添加图片", style = MaterialTheme.typography.bodySmall, maxLines = 1)
                            Text("发送时交给伴星", style = MaterialTheme.typography.labelSmall, color = StudyPalette.muted)
                        }
                        if (state.selectedFile != null) AstellaTextButton(onClick = { viewModel.importPreparedFile() }, enabled = !state.isSending) { Text("存为手记", style = MaterialTheme.typography.labelMedium) }
                        AstellaIconButton(onClick = viewModel::clearAttachment) { AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(18.dp), tint = StudyPalette.muted) }
                    }
                }
                state.pendingNoteContext?.let { note ->
                    Surface(shape = RoundedCornerShape(14.dp), color = StudyPalette.sky) {
                        Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(16.dp), tint = StudyPalette.accent)
                            Text(note.title, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.labelMedium, maxLines = 1)
                            AstellaIconButton(onClick = viewModel::clearPendingNoteContext) { AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(16.dp), tint = StudyPalette.muted) }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 7.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
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
                            Modifier.weight(1f).padding(horizontal = 2.dp, vertical = 14.dp).onFocusChanged { composerFocused = it.isFocused },
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 23.sp, color = StudyPalette.ink), maxLines = 5,
                            cursorBrush = SolidColor(StudyPalette.accent),
                            decorationBox = { inner ->
                                if (state.draft.isEmpty()) Text("说给伴星听…", color = Color(0xFF9AA8BB), fontSize = 16.sp)
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
                                    !voiceAction && canSend -> Color.White
                                    else -> Color(0xFF7B91AE)
                                },
                            )
                        }
                    }
                if (!composerFocused) MainNavigationDock(
                    selectedTab = selectedTab,
                    onSelect = onSelectTab,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
        }
        if (menuOpen) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .08f)).clickable { menuOpen = false })
        AnimatedVisibility(visible = menuOpen, modifier = Modifier.align(Alignment.BottomStart).padding(start = 20.dp, bottom = 88.dp),
            enter = if (reduced) fadeIn(tween(120)) else fadeIn(spring()) + scaleIn(MotionTokens.segment(), initialScale = .94f, transformOrigin = TransformOrigin(0f, 1f)),
            exit = if (reduced) fadeOut(tween(120)) else fadeOut(spring()) + scaleOut(MotionTokens.press(), targetScale = .94f, transformOrigin = TransformOrigin(0f, 1f))) {
            Surface(modifier = Modifier.astellaGlass(24.dp,haze = menuHaze,interactive = true),color = Color.Transparent) {
                Column(Modifier.padding(8.dp)) {
            listOf("加图片" to AstellaGlyphKind.Companion, "加文件" to AstellaGlyphKind.Document, "引用手记" to AstellaGlyphKind.Book).forEachIndexed { index, (label, icon) ->
                        AstellaTextButton(onClick = {
                            menuOpen = false
                            when (index) {
                                0 -> photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                1 -> files.launch(arrayOf("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"))
                                else -> showNotes = true
                            }
                        }, modifier = Modifier.widthIn(min = 190.dp).heightIn(min = 48.dp)) {
                            AstellaGlyph(icon, Modifier.size(22.dp), tint = StudyPalette.accent); Spacer(Modifier.width(16.dp)); Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                        }
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
    if (showNotes) ModalBottomSheet(onDismissRequest = { showNotes = false }, containerColor = StudyPalette.canvas) {
        Text("引用手记", Modifier.padding(24.dp), style = MaterialTheme.typography.titleLarge)
        LaunchedEffect(Unit) { viewModel.loadNotes("") }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 500.dp)) {
            items(state.notes, key = { it.id }) { note ->
                ListItem(headlineContent = { Text(note.title) }, leadingContent = { AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(20.dp), tint = StudyPalette.accent) },
                    modifier = Modifier.clickable { viewModel.referenceNote(note.id); showNotes = false })
            }
        }
    }
}

@Composable
private fun CompanionMeeting(state: AppUiState, viewModel: AppViewModel, reduced: Boolean, onOpenNote: (String) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = maxHeight
        val latest = state.messages.lastOrNull { it.role == "assistant" }
        val hasReply = latest != null || state.streamingText.isNotEmpty()
        val stageHeight = if (hasReply) 230.dp else minOf(300.dp,maxOf(240.dp,height*.46f))
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 18.dp)) {
            if (!hasReply) Column(
                Modifier.fillMaxWidth().padding(top = 12.dp)
                    .astellaGlass(24.dp)
                    .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomEnd = 24.dp, bottomStart = 7.dp))
                    .padding(horizontal = 18.dp, vertical = 15.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (state.isRecording || state.isPlaying) "此刻，听见彼此。" else "阿星轻轻说",
                    fontSize = 10.sp, letterSpacing = 0.7.sp, fontWeight = FontWeight.Medium, color = StudyPalette.muted,
                )
                Text(
                    "我在这里。刚读到的、想到的，都可以慢慢说给我听。",
                    fontSize = 14.sp, lineHeight = 25.sp, color = StudyPalette.ink,
                )
            }
            if (hasReply) {
                Column(
                    Modifier.fillMaxWidth().padding(top = 8.dp)
                        .astellaGlass(24.dp)
                        .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomEnd = 24.dp, bottomStart = 7.dp))
                        .padding(horizontal = 18.dp, vertical = 15.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        if (state.streamingText.isEmpty()) "阿星轻轻说" else "正在回应",
                        fontSize = 10.sp, letterSpacing = 0.7.sp, color = StudyPalette.muted, fontWeight = FontWeight.Medium,
                    )
                    if (state.streamingText.isNotEmpty()) {
                        Text(state.streamingText, fontSize = 14.sp, lineHeight = 25.sp, color = StudyPalette.ink)
                    } else if (latest != null) {
                        Text(
                            latest.displayText,
                            fontSize = 14.sp,
                            lineHeight = 25.sp,
                            color = StudyPalette.ink,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                        AstellaTextButton(
                            onClick = { viewModel.setChatShowsRecords(true) },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                        ) { Text("在记录里继续看", fontSize = 11.sp) }
                    }
                }
            }
            BoxWithConstraints(Modifier.fillMaxWidth().height(stageHeight),contentAlignment = Alignment.Center) {
                val accent = StudyPalette.accent; val ice = StudyPalette.pollen
                Canvas(Modifier.fillMaxSize()) {
                    drawCircle(
                        Brush.radialGradient(
                            listOf(accent.copy(alpha = if (state.isRecording || state.isPlaying) .12f else .055f), ice.copy(alpha = .10f), Color.Transparent),
                            center = center,
                            radius = size.width * .32f,
                        ),
                        radius = size.width * .34f,
                        center = center,
                    )
                }
                CompanionStage(state,reduced,Modifier.fillMaxSize().padding(horizontal = 12.dp,vertical = 5.dp))
            }
            if (!hasReply) {
                Spacer(Modifier.height((height * .16f).coerceIn(40.dp, 110.dp)))
                val recentNoteId = viewModel.recentNoteId()
                (state.notes.firstOrNull { it.id == recentNoteId } ?: state.notes.firstOrNull())?.let { note ->
                    val hasReadingHistory = note.id == recentNoteId
                    AstellaTap(
                        { onOpenNote(note.id) },
                        Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
                    ) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 72.dp), verticalAlignment = Alignment.CenterVertically) {
                            NoteCover(
                                note.title,
                                Modifier.padding(start = 3.dp).size(46.dp, 64.dp),
                                note.id,
                                rotate = -8f,
                                textSize = 15.sp,
                            )
                            Column(Modifier.weight(1f).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    if (hasReadingHistory) "继续一起读" else "最近留下的手记",
                                    fontSize = 9.sp, letterSpacing = 1.sp, color = StudyPalette.muted,
                                )
                                Text(
                                    note.title.substringBefore('·').trim(),
                                    fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium,
                                    color = StudyPalette.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        if (hasReadingHistory) "上次停下的那一页" else "最近更新 · 随时回来读",
                                        fontSize = 11.sp, color = StudyPalette.muted,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Box(Modifier.width(28.dp).height(1.dp).background(Color(0xFFA8BDEA)))
                                }
                            }
                        }
                    }
                }
            }
            if (state.runs.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(top = 14.dp),verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp),strokeWidth = 1.5.dp,color = StudyPalette.accent)
                Text("伴星正在整理思路",Modifier.weight(1f).padding(start = 8.dp),fontSize = 11.sp,color = StudyPalette.muted)
                AstellaTextButton(onClick = { viewModel.cancelActiveRuns() }) { Text("停止") }
            }
        }
    }
}

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
private fun MessageHistory(state: AppUiState, viewModel: AppViewModel, reduceMotion: Boolean) {
    val listState = rememberLazyListState()
    var didInitialPosition by remember { mutableStateOf(false) }
    val itemCount = state.messages.size + if (state.streamingText.isNotEmpty()) 1 else 0
    LaunchedEffect(itemCount) {
        if (itemCount > 0 && !didInitialPosition) {
            listState.scrollToItem(itemCount - 1)
            didInitialPosition = true
            return@LaunchedEffect
        }
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        if (itemCount > 0 && lastVisible >= itemCount - 2) {
            if (reduceMotion) listState.scrollToItem(itemCount - 1) else listState.animateScrollToItem(itemCount - 1)
        }
    }
    LaunchedEffect(state.streamingText) {
        if (state.streamingText.isNotEmpty()) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val currentCount = listState.layoutInfo.totalItemsCount
            if (currentCount > 0 && lastVisible >= currentCount - 2) {
                if (reduceMotion) listState.scrollToItem(currentCount - 1) else listState.animateScrollToItem(currentCount - 1)
            }
        }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 15.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(state.messages, key = { it.id }) { message ->
                Box(Modifier.animateItem(fadeInSpec = if (reduceMotion) snap() else spring(), placementSpec = if (reduceMotion) snap() else MotionTokens.routePush())) { MobileMessageRow(message, viewModel) }
            }
            if (state.streamingText.isNotEmpty()) item(key = "streaming") {
                Row(Modifier.fillMaxWidth().padding(end = 34.dp), verticalAlignment = Alignment.Top) {
                    Image(painterResource(R.drawable.brand_mark), null, Modifier.padding(top = 4.dp, end = 8.dp).size(24.dp).clip(CircleShape), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
                    Text(state.streamingText, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                        lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyMedium.lineHeight * 1.22f)
                }
            }
        }
        if (state.messages.isEmpty() && state.streamingText.isEmpty()) {
            Column(
                Modifier.align(Alignment.Center).padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Text("还没有交流记录", color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("在下方输入，和伴星开始一段交流。", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
fun MobileMessageRow(message: CompanionMessage, viewModel: AppViewModel) {
    val user = message.role == "user"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
        if (!user) Image(painterResource(R.drawable.brand_mark), null,
            Modifier.padding(top = 7.dp, end = 8.dp).size(24.dp).clip(CircleShape),
            contentScale = androidx.compose.ui.layout.ContentScale.Crop)
        Surface(
            modifier = Modifier.fillMaxWidth(if (user) .88f else 1f),
            shape = RoundedCornerShape(if (user) StudyRadius.xl else 0.dp),
            color = if (user) StudyPalette.sky.copy(alpha = .72f) else Color.Transparent,
        ) {
            Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                message.blocks.forEach { block ->
                    when {
                        block.type == "image" && !block.url.isNullOrBlank() -> AuthenticatedImage(block.url, block.alt ?: block.label ?: "对话图片", viewModel)
                        block.type == "image" -> Text(block.label ?: "图片", color = StudyPalette.muted)
                        block.type == "file" -> Text("▤  ${block.name ?: "文件附件"}", Modifier.padding(12.dp), color = StudyPalette.accent)
                        block.proposalId != null -> CompanionProposalCard(block.proposalId, viewModel)
                        !block.code.isNullOrBlank() -> SelectionContainer { Text(block.code, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace) }
                        !block.text.isNullOrBlank() -> Text(block.text, color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                            lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyMedium.lineHeight * 1.22f)
                    }
                }
                if (!user && message.displayText.isNotBlank()) AstellaTextButton(onClick = { viewModel.playVoice(message.displayText) }) {
                    AstellaGlyph(AstellaGlyphKind.Wave, Modifier.size(16.dp), tint = StudyPalette.accent); Spacer(Modifier.width(6.dp)); Text("朗读", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

@Composable
private fun AuthenticatedImage(url: String, description: String, viewModel: AppViewModel) {
    var bytes by remember(url) { mutableStateOf<ByteArray?>(null) }
    LaunchedEffect(url) { bytes = runCatching { viewModel.imageBytes(url) }.getOrNull() }
    val bitmap = remember(bytes) { bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
    if (bitmap != null) Image(bitmap, description, Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(StudyRadius.md)))
    else Box(Modifier.fillMaxWidth().height(72.dp).clip(RoundedCornerShape(StudyRadius.md)).background(StudyPalette.sky.copy(alpha = .4f)), contentAlignment = Alignment.Center) {
        Text("正在载入图片…", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun LocalImage(uri: Uri, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val bitmap = remember(uri) { runCatching { context.contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream) }.getOrNull() }
    if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "待发送图片", modifier = modifier, contentScale = androidx.compose.ui.layout.ContentScale.Crop)
    else Box(modifier.background(StudyPalette.sky, RoundedCornerShape(StudyRadius.sm)))
}
