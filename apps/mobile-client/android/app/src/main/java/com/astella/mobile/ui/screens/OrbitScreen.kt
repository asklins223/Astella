package com.astella.mobile.ui.screens

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.R
import com.astella.mobile.data.ActiveRun
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.optNullableString
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTap
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassSegment
import com.astella.mobile.ui.design.SectionLabel
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.astellaGlass
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

private enum class OrbitSection(val label: String) {
    Diary("日记"), Memory("伴星记忆"), Hand("手边")
}

private data class OrbitDay(val date: String, val status: String)
private data class OrbitMemory(val id: String, val content: String, val kind: String, val tier: String, val candidate: Boolean)

@Composable
fun OrbitScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onConversation: () -> Unit,
) {
    var section by rememberSaveable { mutableStateOf(OrbitSection.Diary) }
    var days by remember { mutableStateOf<List<OrbitDay>>(emptyList()) }
    var firstGeneratedDate by remember { mutableStateOf<LocalDate?>(null) }
    var memories by remember { mutableStateOf<List<OrbitMemory>>(emptyList()) }
    var summaries by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(true) }
    var diaryError by remember { mutableStateOf<String?>(null) }
    var memoryError by remember { mutableStateOf<String?>(null) }
    var selectedDate by rememberSaveable { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var memoryFilter by rememberSaveable { mutableStateOf(0) }
    val month = remember { LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM")) }
    val recentDays = remember(days) {
        val cutoff = LocalDate.now().minusDays(13)
        days.filter { runCatching { LocalDate.parse(it.date) >= cutoff }.getOrDefault(false) }
    }
    val writtenDates = remember(recentDays) { recentDays.filter { it.status == "generated" }.map { it.date }.toSet() }
    val companionDays = remember(firstGeneratedDate) {
        firstGeneratedDate?.let { (ChronoUnit.DAYS.between(it, LocalDate.now()) + 1).coerceAtLeast(1) } ?: 0L
    }

    LaunchedEffect(reload) {
        viewModel.refreshRuns()
        if (state.notes.isEmpty()) viewModel.loadNotes("")
        loading = true
        try {
            val monthResponse = withContext(Dispatchers.IO) { viewModel.requestApi("/companion/daily/month?month=$month") }
            firstGeneratedDate = monthResponse.optNullableString("firstGeneratedDate")
                ?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
            days = monthResponse.optJSONArray("days")?.let { values ->
                (0 until values.length()).mapNotNull { index ->
                    values.optJSONObject(index)?.let { OrbitDay(it.optString("date"), it.optString("status")) }
                }
            }.orEmpty()
            diaryError = null
        } catch (_: Throwable) {
            diaryError = "日记暂时没有连上，稍后再试。"
        }
        try {
            val response = withContext(Dispatchers.IO) { viewModel.requestApi("/companion/memory?includeCandidates=true&includeArchived=false") }
            memories = response.optJSONArray("items")?.let { values ->
                (0 until values.length()).mapNotNull { index ->
                    values.optJSONObject(index)?.let { item ->
                        OrbitMemory(
                            id = item.optString("memoryItemId"),
                            content = item.optString("content"),
                            kind = item.optString("kind"),
                            tier = item.optString("budgetTier"),
                            candidate = item.optBoolean("candidate"),
                        )
                    }
                }
            }.orEmpty()
            memoryError = null
        } catch (_: Throwable) {
            memoryError = "伴星记忆暂时不可用。"
        }
        loading = false
    }

    // 只为最近已生成的日记补摘要；失败就保留「点开回看」，不伪造文字。
    LaunchedEffect(days) {
        val generated = recentDays.filter { it.status == "generated" }.sortedByDescending { it.date }.take(6)
        generated.forEach { day ->
            if (summaries.containsKey(day.date)) return@forEach
            try {
                val response = withContext(Dispatchers.IO) { viewModel.requestApi("/companion/daily?date=${day.date}") }
                val text = response.optJSONArray("blocks")?.let { blocks ->
                    (0 until blocks.length()).mapNotNull { index -> blocks.optJSONObject(index)?.optString("text") }
                        .filter(String::isNotBlank).joinToString(" ")
                }.orEmpty()
                if (text.isNotBlank()) summaries = summaries + (day.date to text)
            } catch (_: Throwable) {
                // 单天失败不阻断整页。
            }
        }
    }

    LaunchedEffect(selectedDate) {
        val date = selectedDate ?: return@LaunchedEffect
        if (summaries[date] != null) return@LaunchedEffect
        try {
            val response = withContext(Dispatchers.IO) { viewModel.requestApi("/companion/daily?date=$date") }
            val text = response.optJSONArray("blocks")?.let { blocks ->
                (0 until blocks.length()).mapNotNull { index -> blocks.optJSONObject(index)?.optString("text") }
                    .filter(String::isNotBlank).joinToString("\n\n")
            }.orEmpty().ifBlank { if (response.optString("status") == "generated") "这一天的日记暂时没有正文。" else "这一天还没有生成日记。" }
            summaries = summaries + (date to text)
        } catch (_: Throwable) {
            summaries = summaries + (date to "这篇日记暂时没有打开，请稍后重试。")
        }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item { OrbitHero(recentDays = recentDays, writtenDates = writtenDates, companionDays = companionDays) }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                GlassSegment(
                    options = OrbitSection.entries.map { it.label },
                    selectedIndex = OrbitSection.entries.indexOf(section),
                    modifier = Modifier.weight(1f),
                    height = 44.dp,
                    radius = 22.dp,
                    onSelect = { section = OrbitSection.entries[it] },
                )
                Spacer(Modifier.width(10.dp))
                AstellaTap(
                    onClick = { reload += 1 },
                    modifier = Modifier.size(44.dp).astellaGlass(22.dp, interactive = true),
                ) {
                    AstellaGlyph(AstellaGlyphKind.Refresh, Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
                }
            }
        }
        when (section) {
            OrbitSection.Diary -> {
                item {
                    Text(
                        "这是她替你写下的一天。列表只给摘要，点开看当日全文。",
                        color = StudyPalette.muted, fontSize = 11.sp, lineHeight = 18.sp,
                    )
                }
                if (loading) item { OrbitLoadingRow() }
                else if (diaryError != null) item { OrbitEmptyCard("暂时看不到星迹", diaryError.orEmpty(), AstellaGlyphKind.Orbit) }
                else if (recentDays.isEmpty()) item { OrbitEmptyCard("星轨还很安静", "等伴星写下第一篇日记，这里就会亮起一颗星。", AstellaGlyphKind.Orbit) }
                else {
                    items(recentDays.sortedByDescending { it.date }, key = { it.date }) { day ->
                        OrbitDiaryCard(
                            day = day,
                            summary = summaries[day.date],
                            selected = selectedDate == day.date,
                            onClick = { selectedDate = if (selectedDate == day.date) null else day.date },
                        )
                    }
                }
            }
            OrbitSection.Memory -> {
                item {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("全部", "待确认", "常驻记忆").forEachIndexed { index, label ->
                            val selected = memoryFilter == index
                            AstellaTap(
                                onClick = { memoryFilter = index },
                                modifier = Modifier.height(32.dp)
                                    .background(
                                        if (selected) StudyPalette.accent else Color.White.copy(alpha = .55f),
                                        RoundedCornerShape(16.dp),
                                    )
                                    .then(
                                        if (!selected) Modifier.border(.8.dp, Color.White.copy(alpha = .8f), RoundedCornerShape(16.dp))
                                        else Modifier,
                                    )
                                    .padding(horizontal = 13.dp),
                            ) {
                                Text(
                                    label,
                                    Modifier.align(Alignment.Center),
                                    color = if (selected) Color.White else StudyPalette.muted,
                                    fontSize = 11.sp,
                                    fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                                )
                            }
                        }
                    }
                }
                val visible = memories.filter {
                    when (memoryFilter) {
                        1 -> it.candidate
                        2 -> it.tier == "resident"
                        else -> true
                    }
                }
                if (loading) item { OrbitLoadingRow() }
                else if (memoryError != null) item { OrbitEmptyCard("记忆暂时不可用", memoryError.orEmpty(), AstellaGlyphKind.Companion) }
                else if (visible.isEmpty()) item { OrbitEmptyCard("这个分组还没有记忆", "等你和伴星相处得更久，这里会慢慢记下与你有关的事。", AstellaGlyphKind.Companion) }
                else items(visible, key = { it.id }) { memory -> OrbitMemoryCard(memory) }
            }
            OrbitSection.Hand -> {
                item { SectionLabel("现在交给伴星的") }
                if (state.runs.isEmpty()) item { OrbitEmptyCard("没有等待处理的事", "你可以安心读一会儿；需要继续时，再从相伴页把内容交给伴星。", AstellaGlyphKind.Hand) }
                items(state.runs, key = { it.id }) { run -> OrbitRunCard(run, onConversation, viewModel) }
                val proposals = state.messages.flatMap { it.blocks }.mapNotNull { it.proposalId }.distinct()
                items(proposals, key = { it }) { id -> CompanionProposalCard(id, viewModel) }
                state.notes.firstOrNull()?.let { note ->
                    item {
                        Column(
                            Modifier.fillMaxWidth().astellaGlass(22.dp).padding(17.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("继续上次的思路", color = StudyPalette.muted, fontSize = 11.sp)
                            Text(note.title, color = StudyPalette.ink, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            note.snippet?.takeIf(String::isNotBlank)?.let {
                                Text(it, color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 19.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            AstellaTextButton(
                                onClick = { viewModel.referenceNote(note.id); onConversation() },
                                contentPadding = PaddingValues(horizontal = 0.dp),
                            ) { Text("带着这篇手记继续聊") }
                        }
                    }
                }
                item {
                    AstellaTextButton(onClick = onConversation, modifier = Modifier.fillMaxWidth()) { Text("回到对话看完整过程") }
                }
            }
        }
    }
}

@Composable
private fun OrbitHero(recentDays: List<OrbitDay>, writtenDates: Set<String>, companionDays: Long) {
    val active = recentDays.count { it.status == "generated" }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF2C4266), Color(0xFF3B577F), Color(0xFF456899))))
            .padding(horizontal = 22.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(end = 68.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("OUR CONSTELLATION", color = Color.White.copy(alpha = .62f), fontSize = 10.sp, letterSpacing = 1.6.sp, fontWeight = FontWeight.Medium)
                Text(
                    if (companionDays > 0) "相伴 $companionDays 天" else "从第一颗星开始",
                    color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.4).sp,
                )
                Text("我们一起走过的日子，都成了星光。", color = Color.White.copy(alpha = .78f), fontSize = 12.sp)
            }
            Image(
                painter = painterResource(R.drawable.companion_avatar),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.align(Alignment.TopEnd).size(58.dp).clip(CircleShape)
                    .background(Color.White.copy(alpha = .12f), CircleShape)
                    .border(1.dp, Color.White.copy(alpha = .20f), CircleShape),
            )
        }
        Canvas(Modifier.fillMaxWidth().height(78.dp).padding(top = 6.dp)) {
            val points = (0 until 14).map { i ->
                val x = size.width * (.04f + i * .071f)
                val y = size.height * (.55f - .3f * kotlin.math.sin(i * .52f) - i * .008f)
                Offset(x, y)
            }
            val path = Path().apply { points.forEachIndexed { index, p -> if (index == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) } }
            drawPath(path, Color.White.copy(alpha = .25f), style = Stroke(1.4.dp.toPx(), cap = StrokeCap.Round))
            val today = LocalDate.now()
            points.forEachIndexed { index, p ->
                val date = today.minusDays((13 - index).toLong()).toString()
                val lit = date in writtenDates
                drawCircle(if (lit) Color(0xFFB8D7FF) else Color.White.copy(alpha = .42f), radius = if (lit) 4.8.dp.toPx() else 2.4.dp.toPx(), center = p)
                if (lit) drawCircle(Color(0xFFB8D7FF).copy(alpha = .2f), radius = 8.dp.toPx(), center = p)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("最近 14 天", color = Color.White.copy(alpha = .66f), fontSize = 11.sp, modifier = Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                AstellaGlyph(AstellaGlyphKind.Orbit, Modifier.size(13.dp), tint = Color.White)
                Text("点亮 $active 颗星", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun OrbitDiaryCard(day: OrbitDay, summary: String?, selected: Boolean, onClick: () -> Unit) {
    val date = runCatching { LocalDate.parse(day.date) }.getOrNull()
    val dayNumber = date?.dayOfMonth?.toString() ?: "—"
    val monthLabel = date?.format(DateTimeFormatter.ofPattern("M 月")) ?: day.date
    val generated = day.status == "generated"
    Column(
        Modifier.fillMaxWidth().astellaGlass(22.dp).clickable(onClick = onClick).padding(15.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Column(
                Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(StudyPalette.sky.copy(alpha = .72f)),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(dayNumber, color = StudyPalette.accent, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp)
                Text(monthLabel, color = StudyPalette.muted, fontSize = 9.sp)
            }
            Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    when {
                        summary != null -> summary
                        generated -> "这一天的日记已经写下，点开看看她记了什么。"
                        else -> "这一天没有生成日记"
                    },
                    color = if (generated) StudyPalette.ink else StudyPalette.muted,
                    fontSize = 14.sp,
                    lineHeight = 24.sp,
                    maxLines = if (selected) 30 else 2,
                    overflow = TextOverflow.Ellipsis,
                    fontFamily = if (generated) FontFamily.Serif else FontFamily.Default,
                )
                if (selected && summary != null) {
                    Box(Modifier.padding(top = 2.dp).width(38.dp).height(1.dp).background(StudyPalette.paperEdge))
                }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (generated) {
                Row(
                    Modifier.height(24.dp).background(StudyPalette.inset, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AstellaGlyph(AstellaGlyphKind.Photo, Modifier.size(12.dp), tint = StudyPalette.muted)
                    Spacer(Modifier.width(4.dp))
                    Text("日记", color = StudyPalette.muted, fontSize = 9.sp)
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                if (selected) "收起" else if (generated) "看全文" else "查看",
                color = if (generated) StudyPalette.accent else StudyPalette.muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
            )
            AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.padding(start = 4.dp).size(11.dp), tint = if (generated) StudyPalette.accent else StudyPalette.muted)
        }
    }
}

@Composable
private fun OrbitMemoryCard(memory: OrbitMemory) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(22.dp).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.height(22.dp).background(StudyPalette.sky, RoundedCornerShape(7.dp)).padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(memoryKindLabel(memory.kind), color = StudyPalette.accent, fontSize = 9.sp, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.weight(1f))
            Text(
                if (memory.candidate) "待确认 · 新记住" else if (memory.tier == "resident") "已确认 · 常驻" else "已确认",
                color = StudyPalette.muted, fontSize = 9.sp,
            )
        }
        Text(memory.content, color = StudyPalette.ink, fontSize = 16.sp, lineHeight = 25.sp, fontWeight = FontWeight.Medium)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            AstellaGlyph(AstellaGlyphKind.Library, Modifier.size(11.dp), tint = StudyPalette.muted)
            Spacer(Modifier.width(5.dp))
            Text("所有书房", color = StudyPalette.muted, fontSize = 10.sp)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.height(22.dp).background(
                    if (memory.candidate) Color(0xFFF7E3DF) else Color(0xFFD8F5E2),
                    RoundedCornerShape(8.dp),
                ).padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (memory.candidate) "有依据 · 待确认" else "有依据",
                    color = if (memory.candidate) Color(0xFFB76752) else Color(0xFF0A5B2E),
                    fontSize = 9.sp, fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun OrbitRunCard(run: ActiveRun, onConversation: () -> Unit, viewModel: AppViewModel) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(22.dp).padding(17.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AstellaGlyph(AstellaGlyphKind.Hand, Modifier.size(19.dp), tint = StudyPalette.accent)
            Text(run.statusLabel, Modifier.weight(1f).padding(start = 9.dp), color = StudyPalette.ink, fontWeight = FontWeight.SemiBold)
            Box(Modifier.size(7.dp).background(if (run.isActive) StudyPalette.accent else StudyPalette.muted, CircleShape))
        }
        Text(run.thinkingText?.takeIf(String::isNotBlank) ?: "整理完成后，会回到你们的对话里。", color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 21.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            AstellaTextButton(onClick = onConversation, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("查看对话") }
            if (run.isActive) AstellaTextButton(onClick = { viewModel.cancelActiveRuns() }, contentPadding = PaddingValues(horizontal = 0.dp)) { Text("停止") }
        }
    }
}

@Composable
private fun OrbitEmptyCard(title: String, detail: String, glyph: AstellaGlyphKind) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(22.dp).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        AstellaGlyph(glyph, Modifier.size(25.dp), tint = StudyPalette.accent)
        Text(title, color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Text(detail, color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 21.sp)
    }
}

@Composable
private fun OrbitLoadingRow() {
    Row(Modifier.fillMaxWidth().padding(vertical = 20.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(20.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
        Text("正在接回你的星轨…", Modifier.padding(start = 10.dp), color = StudyPalette.muted, fontSize = 12.sp)
    }
}

private fun memoryKindLabel(kind: String) = when (kind) {
    "preference" -> "相处偏好"
    "goal" -> "正在努力的事"
    "learning_context" -> "学习背景"
    "interaction_note" -> "相处记录"
    "episodic" -> "共同经历"
    "judgment" -> "伴星的理解"
    else -> "伴星记忆"
}
