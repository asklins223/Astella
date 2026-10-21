package com.astella.mobile.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTap
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private data class DiaryBlock(
    val type: String,
    val text: String?,
    val label: String?,
    val url: String?,
    val alt: String?,
)

private data class DiaryRecord(
    val date: String,
    val status: String,
    val generatedAt: String?,
    val revision: Int,
    val hidden: Boolean,
    val selectionReason: String?,
    val failureReason: String?,
    val blocks: List<DiaryBlock>,
    val memoryId: String?,
) {
    companion object {
        fun from(value: JSONObject): DiaryRecord? {
            val date = value.optString("date").takeIf(String::isNotBlank) ?: return null
            val blocks = value.optJSONArray("blocks")?.let { items ->
                (0 until items.length()).mapNotNull { index ->
                    val block = items.optJSONObject(index) ?: return@mapNotNull null
                    DiaryBlock(
                        type = block.optString("type", "text"),
                        text = block.stringOrNull("text"),
                        label = block.stringOrNull("label"),
                        url = block.stringOrNull("url"),
                        alt = block.stringOrNull("alt"),
                    )
                }
            }.orEmpty()
            return DiaryRecord(
                date = date,
                status = value.optString("status", "not_generated"),
                generatedAt = value.stringOrNull("generatedAt"),
                revision = value.optInt("revision", 1),
                hidden = value.optBoolean("hidden"),
                selectionReason = value.stringOrNull("selectionReason"),
                failureReason = value.stringOrNull("failureReason"),
                blocks = blocks,
                memoryId = value.optJSONObject("memory")?.stringOrNull("memoryItemId"),
            )
        }
    }
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

/** 星轨 · 某一天的日记：章节头、正文、前后篇、隐藏与删除。 */
@Composable
fun OrbitDiaryDetailScreen(
    date: String,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onContinue: (date: String, version: Int) -> Unit,
) {
    var activeDate by remember(date) { mutableStateOf(date) }
    var record by remember(date) { mutableStateOf<DiaryRecord?>(null) }
    var availableDates by remember(date) { mutableStateOf<List<String>>(emptyList()) }
    var isLoading by remember(date) { mutableStateOf(true) }
    var isWorking by remember(date) { mutableStateOf(false) }
    var error by remember(date) { mutableStateOf<String?>(null) }
    var notice by remember(date) { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var selectedMemoryId by remember { mutableStateOf<String?>(null) }
    var lightbox by remember { mutableStateOf<Pair<String, String>?>(null) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    suspend fun loadAvailableDates(base: String) {
        val parsed = runCatching { LocalDate.parse(base) }.getOrNull() ?: return
        val months = (-1..1).map { parsed.plusMonths(it.toLong()).format(DateTimeFormatter.ofPattern("yyyy-MM")) }
        val found = mutableSetOf<String>()
        months.forEach { month ->
            runCatching {
                val response = viewModel.requestApi("/companion/daily/month?month=$month")
                response.optJSONArray("days")?.let { items ->
                    (0 until items.length()).forEach { index ->
                        val day = items.optJSONObject(index) ?: return@forEach
                        if (day.optString("status") == "generated") day.optString("date").takeIf(String::isNotBlank)?.let(found::add)
                    }
                }
            }
        }
        availableDates = found.sorted()
    }

    LaunchedEffect(activeDate, reload) {
        isLoading = true
        error = null
        notice = null
        try {
            val value = viewModel.requestApi("/companion/daily?date=$activeDate")
            record = DiaryRecord.from(value) ?: error("日记格式无法读取。")
            loadAvailableDates(activeDate)
        } catch (cause: Throwable) {
            record = null
            error = cause.message ?: "日记没有加载成功，请稍后重试。"
        }
        isLoading = false
    }

    val previousDate = availableDates.filter { it < activeDate }.maxOrNull()
    val nextDate = availableDates.filter { it > activeDate }.minOrNull()

    suspend fun setHidden(hidden: Boolean) {
        if (isWorking || record == null) return
        isWorking = true
        error = null
        try {
            viewModel.requestApi("/companion/daily/$activeDate/${if (hidden) "hide" else "unhide"}", "POST", JSONObject())
            record = record?.copy(hidden = hidden)
            notice = if (hidden) "已隐藏。这篇日记仍然保留，可以随时恢复显示。" else "已恢复显示。"
        } catch (cause: Throwable) {
            error = cause.message ?: "日记状态没有更新，请重试。"
        }
        isWorking = false
    }

    suspend fun deleteDiary() {
        if (isWorking) return
        isWorking = true
        error = null
        try {
            viewModel.requestApi("/companion/daily/$activeDate/delete", "POST", JSONObject())
            onBack()
        } catch (cause: Throwable) {
            error = cause.message ?: "日记没有删除，请刷新后重试。"
            isWorking = false
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除这篇日记？") },
            text = { Text("这篇日记以及由它产生的摘录和记忆会一起删除；那天的对话仍会保留。此操作无法撤回。") },
            confirmButton = {
                AstellaTextButton(enabled = !isWorking, onClick = {
                    confirmDelete = false
                    scope.launch { deleteDiary() }
                }) { Text("删除日记", color = StudyPalette.danger) }
            },
            dismissButton = { AstellaTextButton(onClick = { confirmDelete = false }) { Text("取消") } },
        )
    }

    lightbox?.let { (url, label) ->
        Dialog(onDismissRequest = { lightbox = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                DiaryImage(url = url, label = label, viewModel = viewModel, fill = true)
                Box(
                    Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 12.dp, end = 14.dp)
                        .size(44.dp).background(Color.White.copy(alpha = .16f), CircleShape)
                        .clickable { lightbox = null },
                    contentAlignment = Alignment.Center,
                ) { AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(20.dp), tint = Color.White) }
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        SettingsPageHeader(diaryTitle(activeDate), onBack, eyebrow = "星轨 · 日记")
        if (isLoading && record == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
            }
        } else {
            val entry = record
            if (entry == null) {
                Box(Modifier.fillMaxSize().padding(20.dp)) {
                    OrbitDetailEmpty(
                        title = "这篇日记暂时没有打开",
                        detail = error ?: "返回星轨重新选择一天。",
                        glyph = AstellaGlyphKind.Orbit,
                    )
                }
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 110.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (entry.status == "generated") {
                        item { StaggerReveal(0) { DiaryChapter(entry) } }
                        if (entry.hidden) item {
                            Row(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(StudyRadius.lg))
                                    .background(StudyPalette.sky.copy(alpha = .7f))
                                    .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                AstellaGlyph(AstellaGlyphKind.Info, Modifier.size(15.dp), tint = StudyPalette.accent)
                                Text(
                                    "这一篇已隐藏，内容仍然保留。",
                                    Modifier.weight(1f).padding(start = 9.dp),
                                    color = StudyPalette.muted, fontSize = 12.5.sp,
                                )
                                QuietTextAction("恢复显示", onClick = { scope.launch { setHidden(false) } })
                            }
                        }
                        item {
                            StaggerReveal(1) {
                                DiaryArticle(entry, viewModel, onOpenImage = { url, label -> lightbox = url to label })
                            }
                        }
                        entry.selectionReason?.takeIf(String::isNotBlank)?.let { reason ->
                            item {
                                Row(
                                    Modifier.fillMaxWidth()
                                        .clip(RoundedCornerShape(StudyRadius.lg))
                                        .background(StudyPalette.paper.copy(alpha = .74f))
                                        .padding(horizontal = 14.dp, vertical = 12.dp),
                                    verticalAlignment = Alignment.Top,
                                ) {
                                    AstellaGlyph(AstellaGlyphKind.Quote, Modifier.padding(top = 1.dp).size(14.dp), tint = StudyPalette.muted)
                                    Text(
                                        "她选了这段：$reason",
                                        Modifier.padding(start = 9.dp),
                                        color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp,
                                    )
                                }
                            }
                        }
                        entry.memoryId?.let { memoryId ->
                            item {
                                SettingsGroup {
                                    SettingsRow(
                                        AstellaGlyphKind.Companion,
                                        "关联记忆",
                                        "查看伴星从这一天留下的记忆",
                                        onClick = { selectedMemoryId = memoryId },
                                    )
                                }
                            }
                        }
                        item {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                if (previousDate != null) DiaryPagerCell("前一天", back = true, Modifier.weight(1f)) { activeDate = previousDate }
                                else DiaryPagerPlaceholder("已经是最早的一篇", Modifier.weight(1f))
                                if (nextDate != null) DiaryPagerCell("后一天", back = false, Modifier.weight(1f)) { activeDate = nextDate }
                                else DiaryPagerPlaceholder("已经是最新的一篇", Modifier.weight(1f))
                            }
                        }
                        item {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                AstellaButton(
                                    onClick = { onContinue(entry.date, entry.revision) },
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
                                    shape = RoundedCornerShape(StudyRadius.lg),
                                ) {
                                    AstellaGlyph(AstellaGlyphKind.Chat, Modifier.size(16.dp), tint = Color.White)
                                    Text("聊聊这篇", Modifier.padding(start = 8.dp))
                                }
                                SettingsGroup {
                                    Row(
                                        Modifier.fillMaxWidth().heightIn(min = 52.dp)
                                            .clickable(enabled = !isWorking) { scope.launch { setHidden(!entry.hidden) } }
                                            .padding(horizontal = 16.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        AstellaGlyph(
                                            if (entry.hidden) AstellaGlyphKind.Eye else AstellaGlyphKind.EyeSlash,
                                            Modifier.size(16.dp), tint = StudyPalette.muted,
                                        )
                                        Text(
                                            if (entry.hidden) "恢复显示这篇" else "隐藏这篇",
                                            Modifier.weight(1f).padding(start = 11.dp),
                                            color = StudyPalette.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium,
                                        )
                                    }
                                    Hairline(startIndent = 16.dp, endIndent = 16.dp, alpha = .45f)
                                    Row(
                                        Modifier.fillMaxWidth().heightIn(min = 52.dp)
                                            .clickable(enabled = !isWorking) { confirmDelete = true }
                                            .padding(horizontal = 16.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        AstellaGlyph(AstellaGlyphKind.Close, Modifier.size(16.dp), tint = StudyPalette.danger)
                                        Text(
                                            "删除这篇日记",
                                            Modifier.weight(1f).padding(start = 11.dp),
                                            color = StudyPalette.danger, fontSize = 14.5.sp, fontWeight = FontWeight.Medium,
                                        )
                                    }
                                }
                                Text(
                                    "隐藏不会删除内容；删除会同时移除这篇日记派生的摘录和记忆。",
                                    color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 18.sp,
                                )
                            }
                        }
                    } else {
                        item {
                            OrbitDetailEmpty(
                                title = if (entry.status == "failed") "这一天她没能写下来" else "这一天还没有日记",
                                detail = if (entry.status == "failed") diaryFailureDetail(entry.failureReason)
                                else "有值得留下的片段时，她会写在这里。你可以从前后日期继续查看。",
                                glyph = if (entry.status == "failed") AstellaGlyphKind.Alert else AstellaGlyphKind.Orbit,
                            )
                        }
                        previousDate?.let { previous ->
                            item {
                                AstellaTextButton(onClick = { activeDate = previous }, modifier = Modifier.fillMaxWidth()) {
                                    Text("看前一天", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                    error?.let { message ->
                        item {
                            ShellNotice(
                                "这一篇没有读全",
                                message,
                                glyph = AstellaGlyphKind.Alert,
                                tint = StudyPalette.danger,
                                actionLabel = "重试",
                                onAction = { reload += 1 },
                            )
                        }
                    }
                    notice?.let { message ->
                        item {
                            ShellNotice("已更新", message, glyph = AstellaGlyphKind.Check, tint = StudyPalette.success)
                        }
                    }
                }
            }
        }
    }

    selectedMemoryId?.let { memoryId ->
        OrbitMemoryDetailSheet(
            memoryId = memoryId,
            viewModel = viewModel,
            onDismiss = { selectedMemoryId = null },
            onChanged = {},
        )
    }
}

/**
 * 详情章节头：大日号是这一页的焦点，月份/星期与版本降为辅助信息；
 * 和列表行区分开，进入详情像翻到一章，而不是又一张同重卡片。
 */
@Composable
private fun DiaryChapter(entry: DiaryRecord) {
    val date = diaryDate(entry.date)
    val dayNumber = date?.dayOfMonth?.toString() ?: "—"
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xxl))
            .background(Brush.linearGradient(listOf(Color(0xFF3E5B87), Color(0xFF2C4162))))
            .border(.8.dp, Color.White.copy(alpha = .16f), RoundedCornerShape(StudyRadius.xxl))
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "A DAY WITH ASTER",
                color = Color.White.copy(alpha = .62f), fontSize = 9.5.sp,
                fontWeight = FontWeight.SemiBold, letterSpacing = 1.6.sp,
                modifier = Modifier.weight(1f),
            )
            Text(
                "第 ${entry.revision} 版",
                Modifier.clip(CircleShape).background(Color.White.copy(alpha = .12f))
                    .padding(horizontal = 9.dp, vertical = 4.dp),
                color = Color.White.copy(alpha = .85f), fontSize = 9.5.sp, fontWeight = FontWeight.Medium,
            )
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                dayNumber,
                color = Color.White, fontSize = 46.sp, lineHeight = 48.sp,
                fontWeight = FontWeight.SemiBold, letterSpacing = (-1.2).sp,
            )
            Column(Modifier.padding(start = 10.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    date?.format(DateTimeFormatter.ofPattern("M 月")) ?: entry.date,
                    color = Color.White.copy(alpha = .92f), fontSize = 14.sp, fontWeight = FontWeight.Medium,
                )
                Text(
                    weekdayLabel(date),
                    color = Color.White.copy(alpha = .58f), fontSize = 11.sp,
                )
            }
        }
        Text(
            (entry.generatedAt?.let { "生成于 ${diaryTimestamp(it)}" } ?: "生成时间未提供"),
            color = Color.White.copy(alpha = .62f), fontSize = 10.5.sp,
        )
    }
}

@Composable
private fun DiaryArticle(
    entry: DiaryRecord,
    viewModel: AppViewModel,
    onOpenImage: (String, String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xxl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xxl))
            .padding(horizontal = 22.dp, vertical = 20.dp),
    ) {
        Row(
            Modifier.padding(bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            AstellaGlyph(AstellaGlyphKind.Book, Modifier.size(14.dp), tint = StudyPalette.accent)
            Text("每日手记", color = StudyPalette.accent, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .4.sp)
        }
        entry.blocks.forEach { block ->
            when (block.type) {
                "text" -> {
                    diaryParagraphs(block.text.orEmpty()).forEachIndexed { index, paragraph ->
                        Text(
                            paragraph,
                            Modifier.padding(bottom = if (index == 0) 18.dp else 16.dp),
                            color = if (index == 0) StudyPalette.ink else StudyPalette.readerInk,
                            fontSize = if (index == 0) 16.5.sp else 16.sp,
                            lineHeight = 28.sp,
                        )
                    }
                }
                "quote" -> Column(
                    Modifier.fillMaxWidth().padding(bottom = 16.dp)
                        .clip(RoundedCornerShape(StudyRadius.lg))
                        .background(StudyPalette.sky.copy(alpha = .6f))
                        .padding(15.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        AstellaGlyph(AstellaGlyphKind.Quote, Modifier.size(13.dp), tint = StudyPalette.accent)
                        Text(block.label ?: "那时说过的话", color = StudyPalette.muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                    }
                    Text(block.text.orEmpty(), color = StudyPalette.readerInk, fontSize = 14.5.sp, lineHeight = 23.sp)
                }
                "image" -> {
                    val url = block.url?.takeIf(String::isNotBlank)
                    if (url != null) {
                        val label = block.label ?: block.alt ?: "日记配图"
                        Row(
                            Modifier.fillMaxWidth().padding(bottom = 16.dp).heightIn(min = 120.dp)
                                .clip(RoundedCornerShape(StudyRadius.md)).clickable { onOpenImage(url, label) },
                        ) {
                            DiaryImage(url, label, viewModel)
                        }
                    }
                }
                else -> Unit
            }
        }
    }
}

@Composable
private fun DiaryImage(
    url: String,
    label: String,
    viewModel: AppViewModel,
    fill: Boolean = false,
) {
    var bitmap by remember(url) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(url) { mutableStateOf(false) }
    LaunchedEffect(url) {
        bitmap = runCatching {
            viewModel.imageBytes(url)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        }.getOrNull()
        failed = bitmap == null
    }
    Box(
        Modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxSize() else Modifier.heightIn(max = 380.dp)),
        contentAlignment = Alignment.Center,
    ) {
        val image = bitmap
        when {
            image != null -> Image(
                image.asImageBitmap(), label,
                Modifier.fillMaxWidth().then(if (fill) Modifier.fillMaxSize() else Modifier.heightIn(max = 380.dp)),
                contentScale = ContentScale.Fit,
            )
            failed -> Text(
                "图片暂时无法加载",
                color = if (fill) Color.White.copy(alpha = .78f) else StudyPalette.muted, fontSize = 12.5.sp,
            )
            else -> CircularProgressIndicator(
                Modifier.size(18.dp),
                color = if (fill) Color.White else StudyPalette.accent, strokeWidth = 2.dp,
            )
        }
    }
}

@Composable
private fun DiaryPagerCell(label: String, back: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.heightIn(min = 44.dp)
            .clip(RoundedCornerShape(StudyRadius.md))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .4f), RoundedCornerShape(StudyRadius.md))
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (back) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(12.dp), tint = StudyPalette.accent)
            Text(label, Modifier.padding(start = 5.dp), color = StudyPalette.accent, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
        } else {
            Text(label, Modifier.padding(end = 5.dp), color = StudyPalette.accent, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
            AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.accent)
        }
    }
}

@Composable
private fun DiaryPagerPlaceholder(label: String, modifier: Modifier) {
    Box(modifier.heightIn(min = 44.dp), contentAlignment = Alignment.Center) {
        Text(label, color = StudyPalette.muted, fontSize = 11.5.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun OrbitDetailEmpty(title: String, detail: String, glyph: AstellaGlyphKind) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
            .padding(horizontal = 18.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(36.dp).background(StudyPalette.sky.copy(alpha = .8f), RoundedCornerShape(11.dp)),
            contentAlignment = Alignment.Center,
        ) { AstellaGlyph(glyph, Modifier.size(18.dp), tint = StudyPalette.accent) }
        Text(title, color = StudyPalette.ink, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold)
        Text(detail, color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp)
    }
}

private fun diaryParagraphs(text: String): List<String> =
    text.split('\n').map(String::trim).filter(String::isNotEmpty)

private fun diaryDate(value: String): LocalDate? = runCatching { LocalDate.parse(value) }.getOrNull()

private fun weekdayLabel(date: LocalDate?): String = when (date?.dayOfWeek?.value) {
    1 -> "周一"; 2 -> "周二"; 3 -> "周三"; 4 -> "周四"; 5 -> "周五"; 6 -> "周六"; 7 -> "周日"; else -> ""
}

private fun diaryTitle(value: String): String {
    val date = diaryDate(value) ?: return "日记全文"
    return "${date.monthValue}月${date.dayOfMonth}日"
}

private fun diaryTimestamp(value: String): String = runCatching {
    Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("M月d日 HH:mm"))
}.getOrDefault(value.take(16).replace('T', ' '))

private fun diaryFailureDetail(reason: String?): String = when (reason) {
    "consent_required" -> "尚未同意使用外部 AI 服务，日记没有开始生成。"
    "model_unavailable" -> "日记生成服务暂时不可用，这一天没有生成日记。"
    "diary_output_invalid" -> "这次生成的内容没有通过保存检查，因此没有写入。"
    else -> "日记没有生成成功。你可以稍后重新读取，或查看其他日期。"
}
