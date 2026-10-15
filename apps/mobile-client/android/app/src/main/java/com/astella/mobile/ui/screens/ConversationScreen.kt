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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.*
import androidx.core.content.ContextCompat
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import kotlin.math.min
import com.astella.mobile.data.*
import com.astella.mobile.R
import com.astella.mobile.ui.design.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(state: AppUiState, viewModel: AppViewModel, onAccount: () -> Unit) {
    val reduced = state.localReduceMotion || rememberSystemReducedMotion()
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val focus = LocalFocusManager.current
    var menuOpen by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }
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
    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
        val height = maxHeight
        val density = LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }
        Column(Modifier.fillMaxSize().hazeSource(menuHaze)) {
            AstellaAppHeader(state.profile?.workspaceName ?: "随身书房",state.profile?.displayName?.ifBlank { state.profile.email } ?: "我",onAccount,state.chatShowsRecords,viewModel::setChatShowsRecords)
            Box(Modifier.weight(1f)) {
                AnimatedContent(targetState = state.chatShowsRecords,
                    transitionSpec = {
                        if (reduced) fadeIn(tween(120)) togetherWith fadeOut(tween(120))
                        else (fadeIn(spring()) + slideInHorizontally(MotionTokens.segment()) { if (targetState) it / 12 else -it / 12 }) togetherWith
                            (fadeOut(spring()) + slideOutHorizontally(MotionTokens.segment()) { if (targetState) -it / 12 else it / 12 })
                    }, label = "companion-records") { records ->
                    if (records) MessageHistory(state, viewModel, reduced)
                    else CompanionMeeting(state, viewModel, reduced)
                }
            }
            state.error?.let { ConnectionFailureNotice("连接暂时中断", it, "重新连接", onRetry = { viewModel.loadConversation() }) }
            if (state.isRecording || state.isTranscribing) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (state.isTranscribing) "正在听清这句话…" else "伴星在听，点麦克风完成", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted)
                if (state.isRecording) AstellaTextButton(onClick = viewModel::cancelRecording) { Text("取消") }
            }
            if (state.isPlaying || state.isPaused || state.isVoiceLoading) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (state.isVoiceLoading) "正在接回声音…" else "伴星的声音", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted)
                if (!state.isVoiceLoading) AstellaIconButton(onClick = viewModel::toggleVoicePause) { Icon(if (state.isPaused) Icons.Default.PlayArrow else Icons.Default.Pause, "暂停或继续") }
                AstellaIconButton(onClick = viewModel::stopVoice) { Icon(Icons.Default.Stop, "停止朗读") }
            }
            Column(Modifier.padding(start = 22.dp,end = 22.dp,top = 10.dp,bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.selectedImage != null || state.selectedFile != null) Surface(shape = RoundedCornerShape(16.dp), color = StudyPalette.inset) {
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(40.dp).pointerInput(Unit) {
                            var delta = Offset.Zero
                            detectDragGestures(onDragStart = { delta = Offset.Zero }, onDrag = { change, amount -> change.consume(); delta += amount }, onDragEnd = {
                                if (delta.y < -40) scope.launch { flightOrigin = Offset(54.dp.toPx(), heightPx - 110.dp.toPx()) + delta; flight.snapTo(0f); flight.animateTo(1f, tween(520)) }
                            })
                        }, contentAlignment = Alignment.Center) {
                            if (state.selectedImage != null) LocalImage(state.selectedImage, Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)))
                            else Icon(Icons.Default.Description, null, tint = StudyPalette.accent)
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            Text(state.selectedFile?.name ?: "已添加图片", style = MaterialTheme.typography.bodySmall, maxLines = 1)
                            Text("发送时交给伴星", style = MaterialTheme.typography.labelSmall, color = StudyPalette.muted)
                        }
                        if (state.selectedFile != null) AstellaTextButton(onClick = { viewModel.importPreparedFile() }, enabled = !state.isSending) { Text("存为手记", style = MaterialTheme.typography.labelMedium) }
                        AstellaIconButton(onClick = viewModel::clearAttachment) { Icon(Icons.Default.Cancel, "移除附件", tint = StudyPalette.muted) }
                    }
                }
                state.pendingNoteContext?.let { note ->
                    Surface(shape = RoundedCornerShape(14.dp), color = StudyPalette.sky) {
                        Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Book, null, Modifier.size(16.dp), tint = StudyPalette.accent)
                            Text(note.title, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.labelMedium, maxLines = 1)
                            AstellaIconButton(onClick = viewModel::clearPendingNoteContext) { Icon(Icons.Default.Cancel, "移除引用", tint = StudyPalette.muted) }
                        }
                    }
                }
                Surface(modifier = Modifier.astellaGlass(22.dp,interactive = true),color = Color.Transparent) {
                    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                        val rotation by animateFloatAsState(if (menuOpen) 45f else 0f, MotionTokens.segment(), label = "plus-menu")
                        AstellaTap({ focus.clearFocus(); menuOpen = !menuOpen },Modifier.size(40.dp).background(StudyPalette.accent,RoundedCornerShape(14.dp))) { Icon(Icons.Default.Add,"添加图片或文件",Modifier.align(Alignment.Center).rotate(rotation).size(20.dp),tint = StudyPalette.paper) }
                        BasicTextField(state.draft, viewModel::draftChanged, Modifier.weight(1f).padding(horizontal = 6.dp, vertical = 13.dp),
                            textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp,color = StudyPalette.ink), maxLines = 5,
                            cursorBrush = SolidColor(StudyPalette.accent), decorationBox = { inner ->
                                if (state.draft.isEmpty()) Text("和伴星说说…", color = StudyPalette.muted,fontSize = 14.sp)
                                inner()
                            })
                        AstellaIconButton(onClick = {
                            focus.clearFocus()
                            if (state.isRecording) viewModel.stopAndTranscribe()
                            else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) viewModel.startRecording()
                            else permission.launch(Manifest.permission.RECORD_AUDIO)
                        }, enabled = !state.isTranscribing && !state.isSending) {
                            Icon(if (state.isRecording) Icons.Default.Stop else Icons.Default.Mic, if (state.isRecording) "完成录音" else "语音输入", tint = if (state.isRecording) StudyPalette.danger else StudyPalette.accent)
                        }
                        val canSend = state.conversationId != null && !state.isSending && !state.isRecording && !state.isTranscribing && (state.draft.isNotBlank() || state.selectedImage != null || state.selectedFile != null)
                        AstellaIconButton(onClick = { viewModel.submit(state.draft) }, enabled = canSend, modifier = Modifier.padding(3.dp).size(40.dp).background(if (canSend) StudyPalette.accent else StudyPalette.inset, RoundedCornerShape(13.dp))) {
                            Icon(if (state.isSending) Icons.Default.MoreHoriz else Icons.Default.ArrowUpward, "发送", tint = if (canSend) Color.White else StudyPalette.muted)
                        }
                    }
                }
            }
        }
        if (menuOpen) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .08f)).clickable { menuOpen = false })
        AnimatedVisibility(visible = menuOpen, modifier = Modifier.align(Alignment.BottomStart).padding(start = 20.dp, bottom = 88.dp),
            enter = if (reduced) fadeIn(tween(120)) else fadeIn(spring()) + scaleIn(MotionTokens.segment(), initialScale = .94f, transformOrigin = TransformOrigin(0f, 1f)),
            exit = if (reduced) fadeOut(tween(120)) else fadeOut(spring()) + scaleOut(MotionTokens.press(), targetScale = .94f, transformOrigin = TransformOrigin(0f, 1f))) {
            Surface(modifier = Modifier.astellaGlass(24.dp,haze = menuHaze,interactive = true),color = Color.Transparent) {
                Column(Modifier.padding(8.dp)) {
                    listOf("加图片" to Icons.Default.Photo, "加文件" to Icons.Default.NoteAdd, "引用手记" to Icons.Default.Book).forEachIndexed { index, (label, icon) ->
                        AstellaTextButton(onClick = {
                            menuOpen = false
                            when (index) {
                                0 -> photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                1 -> files.launch(arrayOf("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"))
                                else -> showNotes = true
                            }
                        }, modifier = Modifier.widthIn(min = 190.dp).heightIn(min = 48.dp)) {
                            Icon(icon, null, Modifier.size(22.dp)); Spacer(Modifier.width(16.dp)); Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
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
                Box(contentAlignment = Alignment.Center) { Icon(if (state.selectedFile == null) Icons.Default.Photo else Icons.Default.Description, null, tint = StudyPalette.accent) }
            }
        }
    }
    if (showNotes) ModalBottomSheet(onDismissRequest = { showNotes = false }, containerColor = StudyPalette.canvas) {
        Text("引用手记", Modifier.padding(24.dp), style = MaterialTheme.typography.titleLarge)
        LaunchedEffect(Unit) { viewModel.loadNotes("") }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 500.dp)) {
            items(state.notes, key = { it.id }) { note ->
                ListItem(headlineContent = { Text(note.title) }, leadingContent = { Icon(Icons.Default.Book, null, tint = StudyPalette.accent) },
                    modifier = Modifier.clickable { viewModel.referenceNote(note.id); showNotes = false })
            }
        }
    }
}

@Composable
private fun CompanionMeeting(state: AppUiState, viewModel: AppViewModel, reduced: Boolean) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = maxHeight
        val latest = state.messages.lastOrNull { it.role == "assistant" }
        val hasReply = latest != null || state.streamingText.isNotEmpty()
        val stageHeight = if (hasReply) 190.dp else minOf(340.dp,maxOf(250.dp,height*.61f))
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp).padding(bottom = 18.dp)) {
            if (!hasReply) Column(Modifier.padding(top = 18.dp),verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text(if (state.isRecording || state.isPlaying) "此刻，听见彼此。" else "我在，慢慢说。",fontSize = 29.sp,fontWeight = FontWeight.SemiBold,color = StudyPalette.ink)
                Text("一点好奇，一个想法，都可以。",fontSize = 13.sp,color = StudyPalette.muted)
            }
            BoxWithConstraints(Modifier.fillMaxWidth().height(stageHeight),contentAlignment = Alignment.Center) {
                val accent = StudyPalette.accent; val ice = StudyPalette.pollen
                Canvas(Modifier.fillMaxSize()) {
                    drawCircle(Brush.radialGradient(listOf(accent.copy(alpha = if (state.isRecording || state.isPlaying) .18f else .09f),ice.copy(alpha = .16f),Color.Transparent),center = center,radius = size.width*.47f),radius = size.width*.49f,center = center)
                    rotate(-17f,pivot = Offset(size.width*.5f,size.height*.64f)) {
                        drawOval(accent.copy(alpha = .12f),topLeft = Offset(size.width*.04f,size.height*.45f),size = androidx.compose.ui.geometry.Size(size.width*.92f,size.height*.38f),style = androidx.compose.ui.graphics.drawscope.Stroke(.6.dp.toPx()))
                    }
                }
                CompanionParticles(state.audioLevel,state.isRecording || state.isPlaying,reduced,Modifier.fillMaxSize())
                CompanionStage(state,reduced,Modifier.fillMaxSize().padding(horizontal = 24.dp,vertical = 7.dp))
            }
            if (hasReply) {
                Column(Modifier.fillMaxWidth().astellaGlass(25.dp).padding(20.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AstellaStar(Modifier.size(10.dp,14.dp)); Text(if (state.streamingText.isEmpty()) "给你的回应" else "正在回应",Modifier.padding(start = 8.dp),fontSize = 11.sp,color = StudyPalette.accent)
                    }
                    if (state.streamingText.isNotEmpty()) Text(state.streamingText,fontSize = 16.sp,lineHeight = 26.sp,color = StudyPalette.ink)
                    else if (latest != null) MobileMessageRow(latest,viewModel)
                }
            } else {
                Row(Modifier.padding(top = 8.dp),horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CompanionPrompt(Icons.Default.Notes,"读懂一段",Modifier.weight(1f)) { viewModel.draftChanged("帮我一起读懂今天在学的内容") }
                    CompanionPrompt(Icons.Default.AutoAwesome,"展开想法",Modifier.weight(1f)) { viewModel.draftChanged("我有些思路想和你一起整理") }
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
private fun CompanionPrompt(icon: androidx.compose.ui.graphics.vector.ImageVector,title: String,modifier: Modifier,onClick: () -> Unit) {
    AstellaTap(onClick,modifier.astellaGlass(18.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 51.dp).padding(horizontal = 15.dp),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(icon,null,Modifier.size(15.dp),tint = StudyPalette.accent)
            Text(title,Modifier.weight(1f),fontSize = 13.sp,fontWeight = FontWeight.Medium,color = StudyPalette.ink)
            Icon(Icons.Default.NorthEast,null,Modifier.size(10.dp),tint = StudyPalette.muted)
        }
    }
}

@Composable
private fun CompanionStage(state: AppUiState, reduced: Boolean, modifier: Modifier) {
    val pulse = remember { Animatable(1f) }
    LaunchedEffect(state.attachmentRevision) {
        if (state.attachmentRevision.isNotEmpty() && !reduced) { pulse.animateTo(.97f, spring()); pulse.animateTo(1.03f, spring(dampingRatio = .8f)); pulse.animateTo(1f, spring()) }
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
            modifier = modifier.clickable { surface?.event = 4; surface?.requestRender() },
            update = { view ->
                view.mouth = if (state.isPlaying) state.audioLevel else 0f
                view.reduced = reduced
                view.requestRender()
            },
            onRelease = { it.dispose(); it.onPause() },
        )
    } else Image(painterResource(R.drawable.companion), "伴星在这里", modifier.graphicsLayer { scaleX = pulse.value; scaleY = pulse.value }, contentScale = androidx.compose.ui.layout.ContentScale.Fit)
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
                    Icon(Icons.Default.VolumeUp, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("朗读", style = MaterialTheme.typography.labelMedium)
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
