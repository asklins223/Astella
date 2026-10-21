package com.astella.mobile.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.astellaGlass
import com.astella.mobile.ui.design.enabledMotion
import org.json.JSONObject

/**
 * 练习报告：hero 分数/星级 → 筛选 → 可折叠逐题回看 → 本次点评 → 固定底部操作。
 * 原文依据只在交卷后出现，作答过程中不提前泄露。
 */
@Composable
fun LearningCardResult(
    state: AppUiState,
    viewModel: AppViewModel,
    card: JSONObject?,
    result: JSONObject?,
    onBack: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    val attempt = result ?: return
    val questions = card?.optJSONArray("questions").objects().orEmpty()
    val receipts = attempt.optJSONArray("answers").objects()
    var filter by remember(attempt.optString("attemptId")) { mutableStateOf("all") }
    var expanded by remember(attempt.optString("attemptId")) {
        mutableStateOf(questions.firstOrNull()?.optString("questionId")?.let { setOf(it) } ?: emptySet())
    }
    val rows = questions.map { question ->
        val receipt = receipts.firstOrNull { it.optString("questionId") == question.optString("questionId") }
        ResultRow(question, receipt)
    }
    val skippedCount = rows.count { it.skipped }
    val wrongCount = rows.count { !it.skipped && it.score < 100 }
    val shown = when (filter) {
        "wrong" -> rows.filter { !it.skipped && it.score < 100 }
        "skipped" -> rows.filter { it.skipped }
        else -> rows
    }
    val bestScore = card?.opt("bestScore")?.takeIf { it != JSONObject.NULL }?.toString()?.toIntOrNull()
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 4.dp, bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            item {
                ResultHero(score = attempt.optInt("score"), stars = attempt.optInt("stars"), bestScore = bestScore)
            }
            item {
                FilterRow(
                    selected = filter,
                    total = rows.size,
                    wrong = wrongCount,
                    skipped = skippedCount,
                    onSelect = { filter = it },
                )
            }
            items(shown, key = { it.question.optString("questionId") }) { row ->
                val qid = row.question.optString("questionId")
                val open = expanded.contains(qid)
                ReviewCard(
                    index = questions.indexOfFirst { it.optString("questionId") == qid },
                    row = row,
                    expanded = open,
                    onToggle = { expanded = if (open) expanded - qid else expanded + qid },
                    state = state,
                    viewModel = viewModel,
                )
            }
            resultSummary(attempt)?.let { summary ->
                item { SummarySection(summary) }
            }
        }
        Column(
            Modifier.fillMaxWidth().background(StudyPalette.paper)
                .padding(horizontal = 22.dp).padding(top = 14.dp, bottom = 14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .55f))
            Spacer(Modifier.height(8.dp))
            AstellaButton(
                onClick = onBack,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(StudyRadius.xl),
            ) {
                AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(15.dp), tint = androidx.compose.ui.graphics.Color.White)
                Text("回到学习卡", Modifier.padding(start = 8.dp))
            }
            if (onRetry != null) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    AstellaTextButton(onClick = onRetry, contentPadding = PaddingValues(vertical = 4.dp)) { Text("再练一次") }
                }
            }
        }
    }
}

private class ResultRow(val question: JSONObject, val receipt: JSONObject?) {
    val answer = receipt?.opt("answer")
    val skipped = isSkippedAnswer(answer)
    val score = receipt?.opt("score")?.takeIf { it != JSONObject.NULL }?.let { receipt.optInt("score") } ?: 0
}

@Composable
private fun ResultHero(score: Int, stars: Int, bestScore: Int?) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(StudyRadius.xxl).padding(22.dp),
    ) {
        Text("PRACTICE REPORT · 本次练习", color = StudyPalette.accent,
            fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
        Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.Bottom) {
            ScoreCountUp(score, Modifier.alignByBaseline())
            Text("分", Modifier.padding(start = 6.dp).alignByBaseline(), color = StudyPalette.muted, fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                Text("最佳 ${bestScore ?: score} 分", color = StudyPalette.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Text(
                    when {
                        stars >= 5 -> "五星全亮"
                        stars > 0 -> "点亮 $stars 星"
                        else -> "先留下一颗种子"
                    },
                    Modifier.padding(top = 3.dp), color = StudyPalette.muted, fontSize = 11.sp,
                )
            }
        }
        StarRow(stars = stars, modifier = Modifier.padding(top = 18.dp), starSize = 26.sp)
        Text("最佳成绩来自你完成过的每一次练习，0 星也会记在这张卡上。",
            Modifier.padding(top = 14.dp), color = StudyPalette.muted, fontSize = 11.5.sp, lineHeight = 18.sp)
    }
}

@Composable
private fun ScoreCountUp(score: Int, modifier: Modifier = Modifier) {
    val motion = enabledMotion()
    var started by remember(score) { mutableStateOf(!motion) }
    androidx.compose.runtime.LaunchedEffect(score, motion) {
        if (!motion) { started = true; return@LaunchedEffect }
        kotlinx.coroutines.delay(140); started = true
    }
    val animated by androidx.compose.animation.core.animateIntAsState(
        targetValue = if (started) score else 0,
        animationSpec = tween(durationMillis = 640),
        label = "result-score",
    )
    Text(animated.toString(), modifier, color = StudyPalette.ink, fontSize = 54.sp, lineHeight = 58.sp,
        fontWeight = FontWeight.SemiBold)
}

@Composable
private fun FilterRow(selected: String, total: Int, wrong: Int, skipped: Int, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
        FilterPill("全部 $total", selected == "all") { onSelect("all") }
        FilterPill("错题 $wrong", selected == "wrong") { onSelect("wrong") }
        FilterPill("跳过 $skipped", selected == "skipped") { onSelect("skipped") }
    }
}

@Composable
private fun FilterPill(text: String, active: Boolean, onClick: () -> Unit) {
    Text(
        text,
        Modifier
            .background(if (active) StudyPalette.accent else StudyPalette.inset.copy(alpha = .7f), CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 15.dp, vertical = 8.dp),
        color = if (active) androidx.compose.ui.graphics.Color.White else StudyPalette.muted,
        fontSize = 12.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
    )
}

@Composable
private fun ReviewCard(
    index: Int,
    row: ResultRow,
    expanded: Boolean,
    onToggle: () -> Unit,
    state: AppUiState,
    viewModel: AppViewModel,
) {
    val question = row.question
    val type = question.optString("type")
    val receipt = row.receipt
    val grounding = receipt?.optJSONObject("grounding") ?: question.optJSONObject("grounding")
    val notes = grounding?.optJSONArray("note").objects().orEmpty()
    val extension = grounding?.optJSONObject("extension")
    val rubric = rubricText(receipt?.opt("rubric"))
    val feedback = feedbackText(receipt?.opt("feedback"))
    val motion = enabledMotion()
    val chevron by animateFloatAsState(if (expanded) 90f else 0f, tween(if (motion) 220 else 0), label = "chevron-$index")
    Column(
        Modifier.fillMaxWidth()
            .background(StudyPalette.paper, RoundedCornerShape(StudyRadius.xl))
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(StudyRadius.xl)),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                Modifier.size(28.dp).background(
                    if (row.skipped) StudyPalette.inset else if (row.score >= 60) StudyPalette.sky else StudyPalette.danger.copy(alpha = .16f),
                    CircleShape,
                ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (row.skipped) "跳" else row.score.toString(),
                    color = if (row.skipped) StudyPalette.muted else if (row.score >= 60) StudyPalette.accent else StudyPalette.danger,
                    fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("第 ${index + 1} 题 · ${questionTypeLabel(type)}", color = StudyPalette.accent,
                    fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .6.sp)
                Text(
                    question.optString("stem"),
                    color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp,
                    maxLines = if (expanded) 6 else 2, overflow = TextOverflow.Ellipsis,
                )
                if (!expanded) {
                    Text("展开看作答与原文依据", color = StudyPalette.muted, fontSize = 11.sp)
                }
            }
            AstellaGlyph(
                AstellaGlyphKind.Chevron, Modifier.size(13.dp).graphicsLayer { rotationZ = chevron },
                tint = StudyPalette.muted,
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter = if (motion) fadeIn(tween(200)) + expandVertically(tween(230)) else EnterNone,
            exit = if (motion) fadeOut(tween(140)) + shrinkVertically(tween(180)) else ExitNone,
        ) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp).padding(bottom = 18.dp)) {
                HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .55f))
                Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    LabeledValue("你的作答", answerDescription(row.answer, question))
                    feedback?.let { LabeledValue("伴星点评", it) }
                    if (!rubric.isNullOrBlank()) {
                        LabeledValue("评分要点", rubric)
                    } else {
                        receipt?.opt("referenceAnswer")?.takeIf { it != JSONObject.NULL }?.let { reference ->
                            LabeledValue("参考答案", answerDescription(reference, question))
                        }
                    }
                    if (notes.isNotEmpty()) {
                        LabeledValue("原文依据", notes.joinToString("\n\n") { "“${it.optString("quote")}”" })
                    }
                    extension?.let { evidence ->
                        val label = when (evidence.optString("kind")) {
                            "ai_generated" -> "AI 补充"
                            "web" -> "联网资料"
                            else -> "已有资料"
                        }
                        Column(
                            Modifier.fillMaxWidth()
                                .background(StudyPalette.sky.copy(alpha = .5f), RoundedCornerShape(StudyRadius.md))
                                .padding(13.dp),
                            verticalArrangement = Arrangement.spacedBy(7.dp),
                        ) {
                            Text("$label · ${evidence.optString("title")}", color = StudyPalette.accent,
                                fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold)
                            Text(evidence.optString("quote"), color = StudyPalette.ink, fontSize = 13.sp, lineHeight = 20.sp)
                            Text(evidence.optString("relation"), color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 18.sp)
                        }
                    }
                    if (type == "operation" && question.optString("operationArtifactId").isNotBlank()) {
                        OperationReplay(question, receipt, viewModel)
                    }
                }
            }
        }
    }
}

private val EnterNone = androidx.compose.animation.EnterTransition.None
private val ExitNone = androidx.compose.animation.ExitTransition.None

@Composable
private fun OperationReplay(question: JSONObject, receipt: JSONObject?, viewModel: AppViewModel) {
    var replaying by remember(question.optString("questionId")) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        AstellaTextButton(
            onClick = { replaying = !replaying },
            contentPadding = PaddingValues(horizontal = 0.dp),
        ) { Text(if (replaying) "收起操作回看" else "回看当时的操作（只读）", fontSize = 12.sp) }
        if (replaying) {
            LearningCardOperationView(
                viewModel = viewModel,
                artifactId = question.optString("operationArtifactId"),
                initialAnswer = answerDraft(receipt?.opt("answer")),
                readOnly = true,
                onAnswer = {},
            )
        }
    }
}

@Composable
private fun LabeledValue(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.Medium, letterSpacing = .5.sp)
        Text(value, color = StudyPalette.ink, fontSize = 14.sp, lineHeight = 22.sp)
    }
}

@Composable
private fun SummarySection(summary: String) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(StudyRadius.xl).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AstellaGlyph(AstellaGlyphKind.Quote, Modifier.size(13.dp), tint = StudyPalette.accent)
            Text("本次点评", color = StudyPalette.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
        Text(summary, color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 26.sp)
    }
}

private fun resultSummary(attempt: JSONObject): String? {
    val summary = attempt.opt("summary") ?: return null
    if (summary == JSONObject.NULL) return null
    if (summary is String) return summary.takeIf(String::isNotBlank)
    if (summary is JSONObject) {
        summary.optString("text").takeIf(String::isNotBlank)?.let { return it }
        if (summary.optString("status") == "failed") return "这次总评没能生成，分数和星级已经保留，可以逐题回看。"
    }
    return null
}

/** `rubric` is a string, a string array, or keyword objects on the wire. */
private fun rubricText(value: Any?): String? {
    if (value == null || value == JSONObject.NULL) return null
    if (value is String) return value.takeIf(String::isNotBlank)
    if (value is org.json.JSONArray) {
        val parts = List(value.length()) { index ->
            when (val item = value.opt(index)) {
                is String -> item
                is JSONObject -> item.optString("keyword").ifBlank { item.optString("description") }
                else -> ""
            }
        }.filter(String::isNotBlank)
        return parts.takeIf(List<String>::isNotEmpty)?.joinToString("；")
    }
    if (value is JSONObject) {
        val criteria = value.optJSONArray("criteria") ?: return null
        return rubricText(criteria)
    }
    return null
}

/** `feedback` is `{ kind, text? }`; the companion only fills text for subjective items. */
private fun feedbackText(value: Any?): String? {
    if (value == null || value == JSONObject.NULL) return null
    if (value is String) return value.takeIf(String::isNotBlank)
    if (value is JSONObject) {
        value.optString("text").takeIf(String::isNotBlank)?.let { return it }
        if (value.optString("kind") == "skipped") return "本题已跳过。"
    }
    return null
}
