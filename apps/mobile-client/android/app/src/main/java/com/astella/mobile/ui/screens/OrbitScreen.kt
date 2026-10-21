package com.astella.mobile.ui.screens

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.astella.mobile.ui.design.LocalReduceMotion
import com.astella.mobile.ui.design.MotionTokens
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.sin

private enum class OrbitSection(val label: String) {
    Diary("日记"), Memory("伴星记忆"), Hand("手边")
}

private enum class OrbitMemoryGroup(val label: String, val kinds: Set<String>) {
    AboutYou("关于你的", setOf("preference", "learning_context", "judgment", "interaction_note")),
    HerNotes("她的记事", setOf("episodic", "")),
    Goals("目标与方法", setOf("goal")),
}

private enum class OrbitMemoryFilter(val label: String) {
    Active("正在使用"), Candidate("待确认"), Resident("固定"), Disputed("有争议"), Archived("已归档"),
}

private data class OrbitDay(val date: String, val status: String)
private data class OrbitMemory(val id: String, val content: String, val kind: String, val tier: String, val candidate: Boolean)

/** 星轨页骨架：深色星图头 → 分段透镜 → 分节标题 → 稳定纸面分组，一个重心逐级下沉。 */
@Composable
fun OrbitScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onConversation: () -> Unit,
    onDiaryDay: (String) -> Unit,
) {
    var section by rememberSaveable { mutableStateOf(OrbitSection.Diary) }
    LaunchedEffect(state.orbitSectionRequest) {
        when (state.orbitSectionRequest) {
            "hand" -> section = OrbitSection.Hand
            "memory" -> section = OrbitSection.Memory
            "diary" -> section = OrbitSection.Diary
            null -> return@LaunchedEffect
        }
        viewModel.consumeOrbitSectionRequest()
    }
    var days by remember { mutableStateOf<List<OrbitDay>>(emptyList()) }
    var firstGeneratedDate by remember { mutableStateOf<LocalDate?>(null) }
    var memories by remember { mutableStateOf<List<OrbitMemory>>(emptyList()) }
    var summaries by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(true) }
    var diaryError by remember { mutableStateOf<String?>(null) }
    var memoryError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var memoryGroup by rememberSaveable { mutableStateOf(OrbitMemoryGroup.AboutYou) }
    var memoryStatusFilter by rememberSaveable { mutableStateOf(OrbitMemoryFilter.Active) }
    var selectedMemoryId by remember { mutableStateOf<String?>(null) }
    var showRecycleBin by remember { mutableStateOf(false) }
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
                if (text.isNotBlank()) summaries = summaries + (day.date to text.take(140))
            } catch (_: Throwable) {
                // 单天失败不阻断整页。
            }
        }
    }

    val generatedDays = recentDays.filter { it.status == "generated" }.sortedByDescending { it.date }
    val visibleMemories = memories.filter { memoryGroupMatches(it, memoryGroup) && memoryFilterMatches(it, memoryStatusFilter) }
    val proposals = state.messages.flatMap { it.blocks }.mapNotNull { it.proposalId }.distinct()

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(key = "hero") {
            StaggerReveal(0) {
                OrbitHero(recentDays = recentDays, writtenDates = writtenDates, companionDays = companionDays)
            }
        }
        item(key = "lens") {
            StaggerReveal(1) {
                GlassSegment(
                    options = OrbitSection.entries.map { it.label },
                    selectedIndex = OrbitSection.entries.indexOf(section),
                    modifier = Modifier.fillMaxWidth(),
                    height = 44.dp,
                    radius = 22.dp,
                    onSelect = { section = OrbitSection.entries[it] },
                )
            }
        }
        when (section) {
            OrbitSection.Diary -> {
                item(key = "diary-head") {
                    StaggerReveal(2) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            ShellSectionHeader(
                                "星迹 · 日记",
                                meta = if (generatedDays.isEmpty()) null else "共 ${generatedDays.size} 篇",
                                action = {
                                    QuietTextAction(
                                        "写今天",
                                        onClick = { viewModel.beginDiaryCapture() },
                                        glyph = AstellaGlyphKind.Edit,
                                    )
                                },
                            )
                            when {
                                loading -> OrbitDiarySkeleton()
                                diaryError != null -> OrbitEmptyCard("暂时看不到星迹", diaryError.orEmpty(), AstellaGlyphKind.Orbit)
                                generatedDays.isEmpty() -> OrbitEmptyCard(
                                    "星轨还很安静",
                                    "等伴星写下第一篇日记，这里就会亮起一颗星。",
                                    AstellaGlyphKind.Orbit,
                                )
                                else -> SettingsGroup {
                                    generatedDays.forEachIndexed { index, day ->
                                        if (index > 0) SettingsDivider()
                                        OrbitDiaryRow(
                                            day = day,
                                            summary = summaries[day.date],
                                            onClick = { onDiaryDay(day.date) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            OrbitSection.Memory -> {
                item(key = "memory-controls") {
                    StaggerReveal(2) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            UnderlineTabs(
                                options = OrbitMemoryGroup.entries.map { it.label },
                                selectedIndex = OrbitMemoryGroup.entries.indexOf(memoryGroup),
                                onSelect = {
                                    memoryGroup = OrbitMemoryGroup.entries[it]
                                    memoryStatusFilter = OrbitMemoryFilter.Active
                                },
                            )
                            Row(
                                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                OrbitMemoryFilter.entries.forEach { filter ->
                                    OrbitFilterChip(
                                        label = filter.label,
                                        selected = filter == memoryStatusFilter,
                                        onClick = { memoryStatusFilter = filter },
                                    )
                                }
                            }
                        }
                    }
                }
                item(key = "memory-list") {
                    StaggerReveal(3) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            ShellSectionHeader(
                                "伴星记忆",
                                meta = if (visibleMemories.isEmpty()) null else "${visibleMemories.size} 条 · 可核对与修订",
                                action = {
                                    QuietTextAction(
                                        "回收站",
                                        onClick = { showRecycleBin = true },
                                        glyph = AstellaGlyphKind.History,
                                    )
                                },
                            )
                            when {
                                loading -> OrbitDiarySkeleton()
                                memoryError != null -> OrbitEmptyCard("记忆暂时不可用", memoryError.orEmpty(), AstellaGlyphKind.Companion)
                                visibleMemories.isEmpty() -> OrbitEmptyCard(
                                    memoryEmptyTitle(memoryStatusFilter),
                                    memoryEmptyDetail(memoryStatusFilter),
                                    AstellaGlyphKind.Companion,
                                )
                                else -> SettingsGroup {
                                    visibleMemories.forEachIndexed { index, memory ->
                                        if (index > 0) SettingsDivider()
                                        OrbitMemoryRow(memory, onClick = { selectedMemoryId = memory.id })
                                    }
                                }
                            }
                        }
                    }
                }
            }
            OrbitSection.Hand -> {
                item(key = "hand-head") {
                    StaggerReveal(2) {
                        ShellSectionHeader(
                            "手边",
                            meta = when {
                                state.runs.isNotEmpty() -> "${state.runs.size} 项正在进行"
                                proposals.isNotEmpty() -> "${proposals.size} 条待确认"
                                else -> "交给伴星的事"
                            },
                        )
                    }
                }
                if (state.runs.isEmpty() && proposals.isEmpty()) item(key = "hand-empty") {
                    StaggerReveal(3) {
                        OrbitEmptyCard(
                            "没有等待处理的事",
                            "你可以安心读一会儿；需要继续时，再从相伴页把内容交给伴星。",
                            AstellaGlyphKind.Hand,
                        )
                    }
                }
                items(state.runs.size, key = { "run-${state.runs[it].id}" }) { index ->
                    StaggerReveal(3 + index) {
                        OrbitRunCard(state.runs[index], onConversation, viewModel)
                    }
                }
                items(proposals.size, key = { "proposal-${proposals[it]}" }) { index ->
                    StaggerReveal(3 + state.runs.size + index) {
                        CompanionProposalCard(proposals[index], viewModel)
                    }
                }
                item(key = "hand-note") {
                    state.notes.firstOrNull()?.let { note ->
                        StaggerReveal(3) {
                            Column(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(StudyRadius.xl))
                                    .background(StudyPalette.sky.copy(alpha = .55f))
                                    .padding(horizontal = 17.dp, vertical = 16.dp),
                                verticalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                Text("继续上次的思路", color = StudyPalette.accent, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                                Text(
                                    note.title,
                                    color = StudyPalette.ink,
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 17.sp,
                                    lineHeight = 23.sp,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                note.snippet?.takeIf(String::isNotBlank)?.let {
                                    Text(
                                        it,
                                        color = StudyPalette.muted,
                                        fontSize = 12.5.sp,
                                        lineHeight = 19.sp,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                QuietTextAction(
                                    "带着这篇手记继续聊",
                                    onClick = { viewModel.referenceNote(note.id); onConversation() },
                                    glyph = AstellaGlyphKind.Chat,
                                )
                            }
                        }
                    }
                }
                if (state.runs.isNotEmpty() || proposals.isNotEmpty()) item(key = "hand-conversation") {
                    StaggerReveal(9) {
                        AstellaTextButton(
                            onClick = onConversation,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("回到对话看完整过程", fontSize = 13.sp) }
                    }
                }
            }
        }
    }
    selectedMemoryId?.let { id ->
        OrbitMemoryDetailSheet(
            memoryId = id,
            viewModel = viewModel,
            onDismiss = { selectedMemoryId = null },
            onChanged = { reload += 1 },
        )
    }
    if (showRecycleBin) OrbitMemoryRecycleSheet(
        viewModel = viewModel,
        onDismiss = { showRecycleBin = false },
        onChanged = { reload += 1 },
    )
}

/** 星图头：页眉 + 相伴天数（焦点）+ 14 天星点；高度收敛到 200dp 以内。 */
@Composable
private fun OrbitHero(recentDays: List<OrbitDay>, writtenDates: Set<String>, companionDays: Long) {
    val active = recentDays.count { it.status == "generated" }
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xxl))
            .background(Brush.linearGradient(listOf(Color(0xFF2B4064), Color(0xFF3B577F), Color(0xFF47699A))))
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text(
                    "OUR CONSTELLATION",
                    color = Color.White.copy(alpha = .58f), fontSize = 9.5.sp,
                    letterSpacing = 1.7.sp, fontWeight = FontWeight.SemiBold,
                )
                Text(
                    if (companionDays > 0) "相伴 $companionDays 天" else "从第一颗星开始",
                    color = Color.White, fontSize = 25.sp, lineHeight = 31.sp,
                    fontWeight = FontWeight.SemiBold, letterSpacing = (-.4).sp,
                )
            }
            Image(
                painter = painterResource(R.drawable.companion_avatar),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(42.dp).clip(CircleShape)
                    .background(Color.White.copy(alpha = .10f), CircleShape)
                    .border(1.dp, Color.White.copy(alpha = .18f), CircleShape),
            )
        }
        Text("我们一起走过的日子，都成了星光。", color = Color.White.copy(alpha = .70f), fontSize = 11.5.sp)
        Canvas(Modifier.fillMaxWidth().height(52.dp).padding(top = 8.dp)) {
            val points = (0 until 14).map { i ->
                val x = size.width * (i / 13f)
                val y = size.height * (.66f - .30f * sin(i * .52f).toFloat() - i * .006f)
                Offset(x, y)
            }
            val path = Path().apply {
                points.forEachIndexed { index, p -> if (index == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) }
            }
            drawPath(path, Color.White.copy(alpha = .20f), style = Stroke(1.2.dp.toPx(), cap = StrokeCap.Round))
            val today = LocalDate.now()
            points.forEachIndexed { index, p ->
                val date = today.minusDays((13 - index).toLong()).toString()
                val lit = date in writtenDates
                if (lit) {
                    drawCircle(Color(0xFFBBD9FF).copy(alpha = .18f), radius = 7.5.dp.toPx(), center = p)
                    drawCircle(Color(0xFFBBD9FF), radius = 4.2.dp.toPx(), center = p)
                } else {
                    drawCircle(Color.White.copy(alpha = .34f), radius = 2.dp.toPx(), center = p)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("最近 14 天", color = Color.White.copy(alpha = .55f), fontSize = 10.sp, modifier = Modifier.weight(1f))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                AstellaGlyph(AstellaGlyphKind.Orbit, Modifier.size(12.dp), tint = Color.White.copy(alpha = .9f))
                Text("点亮 $active 颗星", color = Color.White, fontSize = 10.5.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

/** 分组内切换：文字标签 + 滑动短横，比第二层玻璃分段更安静。 */
@Composable
private fun UnderlineTabs(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    val reduce = LocalReduceMotion.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val tabWidth = maxWidth / options.size
        val underline = tabWidth * .32f
        val offsetX by animateDpAsState(
            tabWidth * selectedIndex + (tabWidth - underline) / 2,
            if (reduce) snap() else MotionTokens.segment(),
            label = "orbit-group-tab",
        )
        Column {
            Row(Modifier.fillMaxWidth().height(34.dp)) {
                options.forEachIndexed { index, label ->
                    val selected = index == selectedIndex
                    Box(
                        Modifier.weight(1f).fillMaxHeight()
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                            ) { onSelect(index) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label,
                            color = if (selected) StudyPalette.ink else StudyPalette.muted,
                            fontSize = 13.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(2.dp)) {
                Box(
                    Modifier.fillMaxWidth().height(.7.dp).align(Alignment.TopCenter)
                        .background(StudyPalette.paperEdge.copy(alpha = .5f)),
                )
                Box(
                    Modifier.offset(x = offsetX).width(underline).height(2.dp)
                        .clip(CircleShape).background(StudyPalette.accent),
                )
            }
        }
    }
}

/** 状态筛选：选中给浅蓝底，未选中只留文字，横向可滚动。 */
@Composable
private fun OrbitFilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    AstellaTap(
        onClick = onClick,
        modifier = Modifier.height(32.dp)
            .clip(CircleShape)
            .background(if (selected) StudyPalette.sky.copy(alpha = .85f) else Color.Transparent)
            .then(
                if (selected) Modifier
                else Modifier.border(.7.dp, StudyPalette.paperEdge.copy(alpha = .42f), CircleShape),
            )
            .padding(horizontal = 13.dp),
    ) {
        Text(
            label,
            Modifier.align(Alignment.Center),
            color = if (selected) StudyPalette.accent else StudyPalette.muted,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

/** 日记行：日期栏（日 / 月）+ 摘要两级；点整行读全文。 */
@Composable
private fun OrbitDiaryRow(day: OrbitDay, summary: String?, onClick: () -> Unit) {
    val date = runCatching { LocalDate.parse(day.date) }.getOrNull()
    val dayNumber = date?.dayOfMonth?.toString() ?: "—"
    val monthLabel = date?.format(DateTimeFormatter.ofPattern("M 月")) ?: day.date
    val isToday = date == LocalDate.now()
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 16.dp, end = 13.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            Modifier.width(42.dp).padding(top = 1.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Text(
                dayNumber,
                color = if (isToday) StudyPalette.accent else StudyPalette.ink,
                fontSize = 21.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(
                monthLabel,
                color = StudyPalette.muted.copy(alpha = .85f),
                fontSize = 9.sp, lineHeight = 12.sp, fontWeight = FontWeight.Medium, letterSpacing = .3.sp,
            )
        }
        Spacer(Modifier.width(13.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (isToday) {
                Text(
                    "今天",
                    Modifier.clip(RoundedCornerShape(6.dp)).background(StudyPalette.sky)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                    color = StudyPalette.accent, fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold,
                )
            }
            Text(
                summary ?: "日记已写下。点开查看那一天的完整记录。",
                color = StudyPalette.ink,
                fontSize = 14.5.sp,
                lineHeight = 22.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("读全文", color = StudyPalette.accent, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
                AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(10.dp), tint = StudyPalette.accent)
            }
        }
    }
}

/** 记忆行：类型 + 状态一行讲完，正文是唯一重心，不再重复来源。 */
@Composable
private fun OrbitMemoryRow(memory: OrbitMemory, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 16.dp, end = 13.dp, top = 13.dp, bottom = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    memoryKindLabel(memory.kind),
                    Modifier.clip(RoundedCornerShape(6.dp)).background(StudyPalette.sky.copy(alpha = .8f))
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                    color = StudyPalette.accent, fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.weight(1f))
                Text(memoryStatusLabel(memory), color = StudyPalette.muted, fontSize = 10.5.sp, maxLines = 1)
            }
            Text(
                memory.content,
                color = StudyPalette.ink,
                fontSize = 14.5.sp,
                lineHeight = 22.sp,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.muted.copy(alpha = .6f))
    }
}

private fun memoryGroupMatches(memory: OrbitMemory, group: OrbitMemoryGroup): Boolean =
    memory.kind in group.kinds

private fun memoryFilterMatches(memory: OrbitMemory, filter: OrbitMemoryFilter): Boolean = when (filter) {
    OrbitMemoryFilter.Active -> !memory.candidate && memory.tier != "resident" && memory.tier != "archived"
    OrbitMemoryFilter.Candidate -> memory.candidate
    OrbitMemoryFilter.Resident -> memory.tier == "resident"
    OrbitMemoryFilter.Disputed -> false
    OrbitMemoryFilter.Archived -> memory.tier == "archived"
}

private fun memoryStatusLabel(memory: OrbitMemory): String = when {
    memory.candidate -> "待确认"
    memory.tier == "resident" -> "固定 · 长期保留"
    memory.tier == "archived" -> "已归档"
    else -> "已确认"
}

private fun memoryEmptyTitle(filter: OrbitMemoryFilter): String = when (filter) {
    OrbitMemoryFilter.Disputed -> "还没有有争议的记忆"
    OrbitMemoryFilter.Archived -> "没有归档的记忆"
    OrbitMemoryFilter.Candidate -> "没有待确认的记忆"
    else -> "这部分还没有记忆"
}

private fun memoryEmptyDetail(filter: OrbitMemoryFilter): String = when (filter) {
    OrbitMemoryFilter.Disputed -> "如果某条记忆与你的理解不同，可以在详情里提出异议。"
    OrbitMemoryFilter.Archived -> "收回的记忆会先放进回收站，再从这里彻底归档。"
    OrbitMemoryFilter.Candidate -> "伴星刚记下的事会先等你确认，再进入长期记忆。"
    else -> "等你和伴星相处得更久，这里会慢慢记下与你有关的事。"
}

@Composable
private fun OrbitRunCard(run: ActiveRun, onConversation: () -> Unit, viewModel: AppViewModel) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .46f), RoundedCornerShape(StudyRadius.xl))
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(if (run.isActive) StudyPalette.accent else StudyPalette.muted, CircleShape))
            Text(
                run.statusLabel,
                Modifier.weight(1f).padding(start = 8.dp),
                color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(if (run.isActive) "进行中" else "已结束", color = StudyPalette.muted, fontSize = 10.5.sp)
        }
        Text(
            run.thinkingText?.takeIf(String::isNotBlank) ?: "整理完成后，会回到你们的对话里。",
            color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 20.sp, maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            QuietTextAction("查看对话", onClick = onConversation, glyph = AstellaGlyphKind.Chat)
            if (run.isActive) QuietTextAction("停止", onClick = { viewModel.cancelActiveRuns() })
        }
    }
}

@Composable
private fun OrbitEmptyCard(title: String, detail: String, glyph: AstellaGlyphKind) {
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

/** 载入骨架：三行占位，避免整页只剩一个转圈。 */
@Composable
private fun OrbitDiarySkeleton() {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .4f), RoundedCornerShape(StudyRadius.xl)),
    ) {
        repeat(3) { index ->
            if (index > 0) SettingsDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 15.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.size(width = 34.dp, height = 38.dp).clip(RoundedCornerShape(9.dp)).background(StudyPalette.inset))
                Spacer(Modifier.width(13.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.fillMaxWidth(.92f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(StudyPalette.inset))
                    Box(Modifier.fillMaxWidth(.7f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(StudyPalette.inset.copy(alpha = .7f)))
                }
            }
        }
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
