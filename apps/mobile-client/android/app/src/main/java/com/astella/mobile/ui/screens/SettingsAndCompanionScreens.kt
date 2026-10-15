package com.astella.mobile.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.CompanionPortrait
import com.astella.mobile.ui.PaperSurface
import com.astella.mobile.ui.PageHeading
import com.astella.mobile.ui.StudyPalette
import com.astella.mobile.ui.rememberSystemReducedMotion
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun AccountSubpageRow(title: String, subtitle: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 11.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (title == "使用设置") Icons.Filled.Settings else Icons.Filled.AutoAwesome,
            contentDescription = null, tint = StudyPalette.blueDeep, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = StudyPalette.ink, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
        }
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = StudyPalette.muted)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MobileSettingsScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(17.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = StudyPalette.ink) }
                PageHeading("设备偏好", "使用设置", "让阅读与交流更合你的习惯。", modifier = Modifier.weight(1f))
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("阅读", color = StudyPalette.muted, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text("正文大小", color = StudyPalette.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("字号仅影响手记正文，并保存在这台设备。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(1f to "标准", 1.2f to "较大", 1.4f to "大字").forEach { (value, label) ->
                        FilterChip(selected = state.readingScale == value, onClick = { viewModel.setReadingScale(value) }, label = { Text(label) })
                    }
                }
                Text("预览", color = StudyPalette.muted, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
                Text("先看一个例子，再用自己的话解释。", color = StudyPalette.ink,
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = MaterialTheme.typography.bodyLarge.fontSize * state.readingScale),
                    lineHeight = 28.sp)
                androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("打开时显示交流记录", color = StudyPalette.ink, fontWeight = FontWeight.SemiBold)
                        Text("伴星场景和记录共用同一段交流。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(checked = state.chatShowsRecords, onCheckedChange = viewModel::setChatShowsRecords)
                }
            }
        }
        item {
            val systemReducedMotion = rememberSystemReducedMotion()
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("我们怎样相处", color = StudyPalette.muted, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                ParticipationPreferencesCard(state, viewModel)
                androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).padding(end = 14.dp)) {
                        Text("减少动效", color = StudyPalette.ink, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text(
                            if (systemReducedMotion) "系统辅助功能已要求减少动画" else if (state.localReduceMotion) "此设备会减少页面过渡" else "保留轻柔的原生页面过渡",
                            color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(checked = state.localReduceMotion || systemReducedMotion,
                        enabled = !systemReducedMotion,
                        onCheckedChange = viewModel::setLocalReduceMotion)
                }
            }
        }
        item {
            Text("阅读字号、打开方式和动效偏好只保存在这台设备上。", Modifier.padding(horizontal = 2.dp),
                color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ParticipationPreferencesCard(state: AppUiState, viewModel: AppViewModel) {
    var revision by rememberSaveable(state.profile?.userId) { mutableStateOf(0) }
    var enabled by rememberSaveable(state.profile?.userId) { mutableStateOf(true) }
    var markdown by rememberSaveable(state.profile?.userId) { mutableStateOf("") }
    var savedMarkdown by rememberSaveable(state.profile?.userId) { mutableStateOf("") }
    var loaded by rememberSaveable(state.profile?.userId) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var conflictLatestMarkdown by remember { mutableStateOf<String?>(null) }
    var conflictPending by remember { mutableStateOf(false) }
    var showDefaults by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load(preservingDraft: Boolean = false) {
        val localDraft = markdown
        busy = true; error = null
        try {
            val value = viewModel.requestApi("/me/companion/participation")
            val serverMarkdown = value.optString("markdown")
            revision = value.optInt("revision")
            enabled = value.optBoolean("enabled", true)
            savedMarkdown = serverMarkdown
            markdown = if (preservingDraft) localDraft else serverMarkdown
            conflictLatestMarkdown = if (preservingDraft) serverMarkdown else null
            conflictPending = false
            loaded = true
        } catch (cause: Throwable) {
            error = "个人约定没有同步成功：${cause.message ?: "请检查连接后重试。"}"
        }
        busy = false
    }

    suspend fun save(nextEnabled: Boolean) {
        busy = true; error = null; notice = null
        try {
            val value = viewModel.requestApi("/me/companion/participation", "PUT",
                JSONObject().put("expectedRevision", revision).put("markdown", markdown).put("enabled", nextEnabled))
            revision = value.optInt("revision", revision + 1)
            enabled = value.optBoolean("enabled", nextEnabled)
            markdown = value.optString("markdown", markdown)
            savedMarkdown = markdown
            conflictLatestMarkdown = null
            conflictPending = false
            notice = if (enabled) "个人约定已保存并生效。" else "个人约定已暂停，默认陪伴方式仍会生效。"
        } catch (cause: Throwable) {
            conflictPending = (cause as? com.astella.mobile.data.ApiFailure)?.status == 409
            error = if (conflictPending)
                "另一台设备刚改过约定。读取最新版本时会保留你的草稿，核对并合并后再保存。"
            else "这次没有保存成功，编辑内容还在。${cause.message ?: "请检查连接后重试。"}"
        }
        busy = false
    }

    LaunchedEffect(state.profile?.userId) { load() }
    Column(Modifier.fillMaxWidth().padding(top = 5.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("个人约定", color = StudyPalette.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("默认陪伴能力一直生效；个人约定用来补充你希望她怎样陪你学习。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = { showDefaults = !showDefaults }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp)) {
                Text(if (showDefaults) "收起默认陪伴方式" else "查看默认陪伴方式")
            }
            if (showDefaults) {
                Text("页面帮助、自然分句、主动问候和久学休息会按实际上下文与偏好判断是否出现。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
            }
            if (!loaded && busy) Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(17.dp), color = StudyPalette.blueDeep, strokeWidth = 2.dp)
                Text("正在读取个人约定…", Modifier.padding(start = 8.dp), color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
            } else {
                OutlinedTextField(
                    value = markdown,
                    onValueChange = { if (it.length <= 16_000) { markdown = it; notice = null } },
                    modifier = Modifier.fillMaxWidth(), minLines = 3, maxLines = 5,
                    enabled = !busy, label = { Text("个人约定") },
                    placeholder = { Text("例如：遇到难懂的地方时，先举例，再让我试着解释。") },
                    shape = RoundedCornerShape(14.dp),
                    colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = StudyPalette.inset,
                        unfocusedContainerColor = StudyPalette.inset,
                        focusedBorderColor = StudyPalette.blueDeep,
                        unfocusedBorderColor = StudyPalette.paperEdge,
                    ),
                )
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Button(
                        enabled = !busy && loaded && markdown != savedMarkdown,
                        onClick = { scope.launch { save(enabled) } },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp)
                        Text("保存约定", Modifier.padding(start = 6.dp))
                    }
                    if (markdown.isNotBlank()) TextButton(enabled = !busy, onClick = { scope.launch { save(!enabled) } }) {
                        Text(if (enabled) "暂停" else "恢复")
                    }
                }
                Text(if (markdown.isBlank()) "尚未添加个人约定，默认陪伴方式会照常生效。" else if (enabled) "个人约定正在生效。" else "个人约定已暂停，默认陪伴方式仍会生效。",
                    color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
            }
            error?.let { message ->
                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(message, color = StudyPalette.danger, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { scope.launch { load(preservingDraft = conflictPending) } }, contentPadding = PaddingValues(0.dp)) {
                        Text(if (conflictPending) "读取最新版本并保留草稿" else "重新读取约定")
                    }
                }
            }
            conflictLatestMarkdown?.let { latest ->
                Column(
                    Modifier.fillMaxWidth().background(StudyPalette.inset, RoundedCornerShape(13.dp)).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text("另一台设备保存的版本", color = StudyPalette.muted, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    androidx.compose.foundation.text.selection.SelectionContainer {
                        Text(latest.ifEmpty { "（云端约定为空）" }, color = StudyPalette.ink, style = MaterialTheme.typography.bodySmall)
                    }
                    Text("上方输入框仍保留你的草稿。合并需要的内容后，保存会以草稿作为最新版本。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { markdown = latest; conflictLatestMarkdown = null }, contentPadding = PaddingValues(0.dp)) {
                        Text("用另一台设备的版本替换草稿")
                    }
                }
            }
            notice?.let { Text(it, color = StudyPalette.success, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
fun CompanionCenterScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onConversation: (records: Boolean) -> Unit) {
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    val latest = state.streamingText.ifEmpty { state.messages.lastOrNull { it.role == "assistant" }?.displayText.orEmpty() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = StudyPalette.ink) }
            Column(Modifier.weight(1f)) {
                Text("伴星中心", color = StudyPalette.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(state.profile?.workspaceName ?: "我的书房", color = StudyPalette.muted, style = MaterialTheme.typography.labelSmall)
            }
        }
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(rememberScrollState())
                    .padding(horizontal = 22.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    CompanionPortrait(Modifier.width(112.dp), height = 132.dp, reduceMotion = reduceMotion)
                    Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text("拾星 · ASTELLA", color = StudyPalette.muted, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
                        Text("伴星", color = StudyPalette.ink, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        Text("一直在同一段交流里陪你。", color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.foundation.layout.Box(Modifier.size(7.dp).background(if (state.realtimeStatus == "已连接") StudyPalette.success else StudyPalette.muted, androidx.compose.foundation.shape.CircleShape))
                            Text(state.realtimeStatus, Modifier.padding(start = 7.dp), color = StudyPalette.muted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("最近一次回应", color = StudyPalette.muted, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    Row(verticalAlignment = Alignment.Top) {
                        androidx.compose.foundation.layout.Box(Modifier.padding(top = 3.dp).width(2.dp).height(36.dp).background(StudyPalette.paperEdge))
                        Text(latest.ifBlank { "还没有新的回复，回去告诉她你想聊什么。" }, Modifier.padding(start = 13.dp), color = StudyPalette.ink,
                            style = MaterialTheme.typography.bodyMedium, lineHeight = 22.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Button(onClick = { onConversation(false) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(24.dp)) {
                        Text("回到对话")
                    }
                    TextButton(onClick = { onConversation(true) }, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)) { Text("查看完整记录") }
                }
            }
        }
    }
}
