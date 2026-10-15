package com.astella.mobile.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.CompanionBlock
import com.astella.mobile.data.CompanionMessage
import com.astella.mobile.R
import com.astella.mobile.ui.design.CompanionPortrait
import com.astella.mobile.ui.design.ConnectionFailureNotice
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.rememberSystemReducedMotion

@Composable
fun ConversationScreen(state: AppUiState, viewModel: AppViewModel, onAccount: () -> Unit) {
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    var draft by rememberSaveable { mutableStateOf("") }
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> viewModel.selectImage(uri) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.startRecording()
    }
    LaunchedEffect(state.voiceTranscript) {
        if (state.voiceTranscript.isNotEmpty()) draft = state.voiceTranscript
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, top = 10.dp, end = 12.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(state.profile?.workspaceName ?: "拾星书房", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium, maxLines = 1)
                Text("对话", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold)
            }
            Row(Modifier.padding(end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(if (state.realtimeStatus == "已连接") StudyPalette.success else StudyPalette.muted.copy(alpha = .55f), CircleShape))
                Text(state.realtimeStatus, Modifier.padding(start = 6.dp), color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                IconButton(onClick = onAccount) {
                    Icon(Icons.Filled.AccountCircle, contentDescription = "我的账户", tint = StudyPalette.muted)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(StudyRadius.xl)).background(StudyPalette.inset.copy(alpha = .9f)).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            SegmentButton("伴星", selected = !state.chatShowsRecords, reduceMotion = reduceMotion, modifier = Modifier.weight(1f)) { viewModel.setChatShowsRecords(false) }
            SegmentButton("记录", selected = state.chatShowsRecords, reduceMotion = reduceMotion, modifier = Modifier.weight(1f)) { viewModel.setChatShowsRecords(true) }
        }

        AnimatedContent(
            targetState = state.chatShowsRecords,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            label = "conversation-view",
            transitionSpec = {
                if (reduceMotion) androidx.compose.animation.fadeIn(tween(1)) togetherWith androidx.compose.animation.fadeOut(tween(1))
                else androidx.compose.animation.fadeIn(tween(180)) togetherWith androidx.compose.animation.fadeOut(tween(120))
            },
        ) { records ->
            if (records) MessageHistory(state, viewModel, reduceMotion) else CompanionScene(state, reduceMotion) { prompt ->
                draft = prompt
                viewModel.draftChanged(prompt)
            }
        }

        state.error?.let { error ->
            ConnectionFailureNotice(
                title = "伴星暂时没有接回来",
                message = error,
                onRetry = { viewModel.loadConversation() },
            )
        }

        state.pendingNoteContext?.let { note ->
            Surface(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                shape = RoundedCornerShape(StudyRadius.md),
                color = StudyPalette.accent.copy(alpha = .08f),
            ) {
                Row(
                    Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Book, contentDescription = null, tint = StudyPalette.accent, modifier = Modifier.size(18.dp))
                    Column(Modifier.weight(1f).padding(start = 9.dp)) {
                        Text("正在围绕手记交流", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        Text(note.title, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                    IconButton(onClick = viewModel::clearPendingNoteContext, modifier = Modifier.size(40.dp)) {
                        Icon(Icons.Filled.Close, contentDescription = "移除手记上下文", tint = StudyPalette.muted)
                    }
                }
            }
        }

        Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp)) {
            state.selectedImage?.let { uri ->
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 7.dp).clip(RoundedCornerShape(StudyRadius.md)).background(StudyPalette.inset).padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LocalImage(uri, Modifier.size(42.dp).clip(RoundedCornerShape(StudyRadius.sm)))
                    Text("图片将在发送时上传", Modifier.weight(1f).padding(start = 10.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                    IconButton(onClick = { viewModel.selectImage(null) }) { Icon(Icons.Filled.Close, contentDescription = "移除图片", tint = StudyPalette.muted) }
                }
            }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(StudyRadius.xxl),
                color = StudyPalette.paper.copy(alpha = .96f),
                border = androidx.compose.foundation.BorderStroke(.6.dp, StudyPalette.paperEdge.copy(alpha = .62f)),
            ) {
                Row(Modifier.padding(horizontal = 5.dp, vertical = 5.dp), verticalAlignment = Alignment.Bottom) {
                    IconButton(onClick = { photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                        Icon(Icons.Filled.Photo, contentDescription = "选择图片", tint = StudyPalette.accent)
                    }
                    IconButton(onClick = {
                        if (state.isRecording) viewModel.stopAndTranscribe()
                        else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) viewModel.startRecording()
                        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }) {
                        if (state.isTranscribing) CircularProgressIndicator(Modifier.size(21.dp), strokeWidth = 2.dp)
                        else Icon(if (state.isRecording) Icons.Filled.StopCircle else Icons.Filled.Mic,
                            contentDescription = if (state.isRecording) "结束录音并识别" else "语音输入",
                            tint = if (state.isRecording) StudyPalette.danger else StudyPalette.accent)
                    }
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it; viewModel.draftChanged(it) },
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 13.dp),
                        textStyle = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(color = StudyPalette.ink),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(StudyPalette.accent),
                        minLines = 1,
                        maxLines = 5,
                        decorationBox = { inner ->
                            Box {
                                if (draft.isEmpty()) Text(
                                    when { state.isRecording -> "正在录音，点红色按钮结束"; state.isTranscribing -> "正在识别…"; else -> "和伴星说说你在想什么…" },
                                    color = StudyPalette.muted.copy(alpha = .8f),
                                    style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                                )
                                inner()
                            }
                        },
                    )
                    IconButton(
                        onClick = {
                            val value = draft
                            scope.launch {
                                viewModel.submit(value).join()
                                if (viewModel.state.value.error == null) {
                                    draft = ""
                                    focusManager.clearFocus()
                                }
                            }
                        },
                        enabled = !state.isSending && (draft.isNotBlank() || state.selectedImage != null),
                        modifier = Modifier.padding(bottom = 1.dp).size(40.dp).clip(CircleShape)
                            .background(if (draft.isNotBlank() || state.selectedImage != null) StudyPalette.accent else StudyPalette.inset),
                    ) {
                        if (state.isSending) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                        else Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = "发送",
                            tint = if (draft.isNotBlank() || state.selectedImage != null) Color.White else StudyPalette.muted,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SegmentButton(label: String, selected: Boolean, reduceMotion: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val background by animateColorAsState(
        if (selected) StudyPalette.paper else Color.Transparent,
        tween(if (reduceMotion) 1 else 180),
        label = "segment-color",
    )
    Surface(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(StudyRadius.lg), color = background,
        border = if (selected) androidx.compose.foundation.BorderStroke(.6.dp, StudyPalette.paperEdge.copy(alpha = .7f)) else null,
        shadowElevation = if (selected) 1.dp else 0.dp) {
        Text(label, Modifier.fillMaxWidth().padding(vertical = 9.dp), textAlign = TextAlign.Center,
            color = if (selected) StudyPalette.ink else StudyPalette.muted,
            style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun CompanionScene(state: AppUiState, reduceMotion: Boolean, onPrompt: (String) -> Unit) {
    val latest = state.messages.lastOrNull { it.role == "assistant" }
    val empty = latest == null && state.streamingText.isEmpty()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val availableHeight = maxHeight
        if (empty) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CompanionPortrait(Modifier.width(158.dp), height = 178.dp, reduceMotion = reduceMotion)
                Text("今天，想学点什么？", color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold)
                Text("正在读的内容，或没想通的问题，都可以直接告诉伴星。", Modifier.padding(top = 6.dp).padding(horizontal = 14.dp),
                    color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                    lineHeight = 21.sp, textAlign = TextAlign.Center)
                Column(Modifier.fillMaxWidth().padding(top = 17.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("试着问", color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf("帮我梳理思路" to "帮我梳理思路", "解释一个概念" to "解释一个概念", "我今天想学……" to "我今天想学……").forEach { (label, prompt) ->
                            Surface(
                                onClick = { onPrompt(prompt) },
                                modifier = Modifier.heightIn(min = 42.dp),
                                shape = CircleShape,
                                color = StudyPalette.paper,
                                border = androidx.compose.foundation.BorderStroke(.7.dp, StudyPalette.paperEdge.copy(alpha = .8f)),
                                shadowElevation = 0.dp,
                            ) {
                                Text(label, Modifier.padding(horizontal = 13.dp, vertical = 10.dp), color = StudyPalette.accent,
                                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
                if (state.runs.isNotEmpty()) {
                    Text("${state.runs.size} 项学习工作正在进行", color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = 12.dp))
                }
            }
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(
                    modifier = Modifier.fillMaxWidth().heightIn(max = availableHeight)
                        .verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    CompanionPortrait(
                        height = (availableHeight * .26f).coerceIn(150.dp, 190.dp),
                        reduceMotion = reduceMotion,
                    )
                    Text(
                        state.streamingText.ifEmpty { latest?.displayText.orEmpty() },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp).padding(top = 5.dp),
                        color = StudyPalette.ink,
                        textAlign = TextAlign.Center,
                        style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                        lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.3f,
                    )
                    if (state.streamingText.isNotEmpty()) Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
                        Text("正在接着回答", Modifier.padding(start = 7.dp), color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                    }
                    if (state.runs.isNotEmpty()) {
                        Text("${state.runs.size} 项学习工作正在进行", Modifier.padding(top = 9.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
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
            items(state.messages, key = { it.id }) { message -> MessageRow(message, viewModel) }
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
private fun MessageRow(message: CompanionMessage, viewModel: AppViewModel) {
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
                        !block.text.isNullOrBlank() -> Text(block.text, color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                            lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyMedium.lineHeight * 1.22f)
                    }
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
