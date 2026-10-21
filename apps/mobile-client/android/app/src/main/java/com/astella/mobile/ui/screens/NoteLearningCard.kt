package com.astella.mobile.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
import com.astella.mobile.ui.design.AstellaOutlinedButton
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.MotionTokens
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.StudyRadius
import com.astella.mobile.ui.design.astellaGlass
import com.astella.mobile.ui.design.enabledMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * 学习卡：独立整页（不是底部抽屉）。一题一页、草稿自动保存、交卷后统一回看。
 * 视觉层级：卡面 hero → 一个主操作 → 次级记录；练习页题干优先、操作栏独立成面。
 */
@Composable
fun NoteLearningCardScreen(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onClose: () -> Unit,
    onAccount: () -> Unit,
) {
    var card by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var attempts by remember(noteId) { mutableStateOf(emptyList<JSONObject>()) }
    var activeAttempt by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var resultAttempt by remember(noteId) { mutableStateOf<JSONObject?>(null) }
    var answers by remember(noteId) { mutableStateOf(mapOf<String, Any>()) }
    var pendingAnswers by remember(noteId) { mutableStateOf(mapOf<String, Any>()) }
    var scene by remember(noteId) { mutableStateOf("front") }
    var index by remember(noteId) { mutableIntStateOf(0) }
    var questionCount by remember(noteId) { mutableIntStateOf(6) }
    var loading by remember(noteId) { mutableStateOf(true) }
    var generating by remember(noteId) { mutableStateOf(false) }
    var busy by remember(noteId) { mutableStateOf(false) }
    var saving by remember(noteId) { mutableStateOf(false) }
    var error by remember(noteId) { mutableStateOf<String?>(null) }
    var confirmSubmit by remember(noteId) { mutableStateOf(false) }
    val questions = card?.optJSONArray("questions").objects().orEmpty()
    val document = state.noteDocument?.takeIf { it.id == noteId }
    val title = document?.title ?: "手记"
    val scope = rememberCoroutineScope()
    var saveJob by remember(noteId) { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    // `card` 是随加载变化的 State；函数里必须现读，不能捕获组合时的快照。
    fun currentCardId(): String? = card?.optString("cardId")?.takeIf { it.isNotBlank() }

    suspend fun savePending() {
        val attemptId = activeAttempt?.optString("attemptId").orEmpty()
        val id = currentCardId() ?: return
        if (attemptId.isBlank()) return
        val snapshot = pendingAnswers
        for ((questionId, answer) in snapshot) {
            try {
                viewModel.requestApi("/v2/learning-cards/$id/attempts/$attemptId/answers", "POST", JSONObject()
                    .put("questionId", questionId)
                    .put("answer", answer))
                pendingAnswers = pendingAnswers - questionId
            } catch (cause: Throwable) {
                error = featureFailure(cause, "作答没有保存，请检查连接后重试。")
                saving = false
                return
            }
        }
        saving = false
    }

    fun changeAnswer(questionId: String, value: Any) {
        answers = answers + (questionId to value)
        pendingAnswers = pendingAnswers + (questionId to value)
        saving = true
        // 连续输入/连点时只保留最后一次保存，避免把半截草稿排队发上去。
        saveJob?.cancel()
        saveJob = scope.launch { delay(450); savePending() }
    }

    /** Returns true when a previous attempt is still being graded. */
    suspend fun loadAttempts(): Boolean {
        val id = currentCardId() ?: return false
        try {
            val page = viewModel.requestApi("/v2/learning-cards/$id/attempts")
            attempts = page.optJSONArray("items").objects()
            activeAttempt = attempts.firstOrNull { it.optString("status") in setOf("in_progress", "grading", "grading_failed") }
            activeAttempt?.let { attempt ->
                answers = attempt.optJSONArray("answers").objects().mapNotNull { row ->
                    val qid = row.optString("questionId")
                    if (qid.isBlank()) null else qid to (row.opt("answer") ?: JSONObject.NULL)
                }.toMap()
                if (attempt.optString("status") == "grading") { scene = "grading"; return true }
                else if (attempt.optString("status") == "in_progress") {
                    val loadedQuestions = card?.optJSONArray("questions").objects().orEmpty()
                    index = loadedQuestions.indexOfFirst { question ->
                        val qid = question.optString("questionId")
                        !hasAnswer(question, answers[qid]) && !isSkippedAnswer(answers[qid])
                    }.coerceAtLeast(0)
                }
            }
        } catch (cause: Throwable) { error = featureFailure(cause, "练习记录暂时无法读取。") }
        return false
    }

    suspend fun pollGrading() {
        val attemptId = activeAttempt?.optString("attemptId").orEmpty()
        val id = currentCardId() ?: return
        if (attemptId.isBlank()) return
        // 简答/操作题交给伴星批改，留足两分钟。
        repeat(60) {
            try {
                val page = viewModel.requestApi("/v2/learning-cards/$id/attempts")
                val value = page.optJSONArray("items").objects().firstOrNull { it.optString("attemptId") == attemptId }
                if (value == null) { scene = "front"; return }
                activeAttempt = value
                when (value.optString("status")) {
                    "completed" -> {
                        attempts = page.optJSONArray("items").objects()
                        resultAttempt = value
                        scene = "result"
                        // 交卷后最佳分数/星级会变化，回到卡面时要用最新值。
                        runCatching {
                            viewModel.requestApi("/v2/notes/$noteId/learning-card").optJSONObject("card")?.let { card = it }
                        }
                        return
                    }
                    "grading_failed" -> {
                        scene = "front"
                        error = "批改没有完成，作答已保存，可以重新批改。"
                        return
                    }
                }
                delay(2_000)
            } catch (cause: Throwable) {
                error = featureFailure(cause, "批改状态暂时无法读取。")
                return
            }
        }
        error = "批改仍在后台进行，稍后打开学习卡即可查看。"
    }

    suspend fun pollGeneration() {
        generating = true
        repeat(30) {
            try {
                val value = viewModel.requestApi("/v2/notes/$noteId/learning-card")
                value.optJSONObject("card")?.let { ready ->
                    card = ready; generating = false
                    if (loadAttempts()) scope.launch { pollGrading() }
                    return
                }
                if (!value.optBoolean("generating")) {
                    generating = false
                    error = value.optString("generationFailure").takeIf(String::isNotBlank)?.let(::failureMessage)
                        ?: "学习卡生成没有完成，可以重新尝试。"
                    return
                }
                delay(2_000)
            } catch (cause: Throwable) {
                generating = false
                error = featureFailure(cause, "生成状态暂时无法读取。")
                return
            }
        }
        generating = false
        error = "学习卡还在后台制作，稍后重新打开即可继续。"
    }

    suspend fun load() {
        loading = true; error = null
        try {
            val read = viewModel.requestApi("/v2/notes/$noteId/learning-card")
            card = read.optJSONObject("card")
            if (read.optBoolean("generating")) { generating = true; scope.launch { pollGeneration() } }
            if (loadAttempts()) scope.launch { pollGrading() }
            if (card == null) read.optString("generationFailure").takeIf(String::isNotBlank)?.let { error = failureMessage(it) }
        } catch (cause: Throwable) { error = featureFailure(cause, "学习卡暂时打不开，请检查连接后重试。") }
        loading = false
    }

    suspend fun generate() {
        if (state.aiSettings?.needsSigning != false) { error = "ai_consent_required"; return }
        if (state.aiSettings?.dataPolicy?.sendToExternal != true) { error = "当前 AI 数据设置不允许生成学习卡。"; return }
        val versionId = document?.versionId ?: run { error = "请先打开并保存这篇手记，再生成学习卡。"; return }
        busy = true; error = null
        try {
            val receipt = viewModel.requestApi("/v2/notes/$noteId/learning-card/generate", "POST", JSONObject()
                .put("noteVersionId", versionId)
                .put("options", JSONObject().put("questionCount", questionCount)))
            if (receipt.optBoolean("queued") || receipt.optString("reason") == "generating") pollGeneration() else load()
            scene = "front"
        } catch (cause: Throwable) { error = featureFailure(cause, "学习卡没有开始生成。") }
        busy = false
    }

    suspend fun startAttempt() {
        val id = currentCardId() ?: return
        busy = true; error = null
        try {
            val receipt = viewModel.requestApi("/v2/learning-cards/$id/attempts", "POST")
            activeAttempt = JSONObject()
                .put("attemptId", receipt.optString("attemptId"))
                .put("status", "in_progress")
                .put("answers", JSONArray())
            answers = emptyMap(); pendingAnswers = emptyMap(); index = 0
            loadAttempts()
            scene = "practice"
        } catch (cause: Throwable) { error = featureFailure(cause, "这次练习没有开始。") }
        busy = false
    }

    suspend fun submit(retry: Boolean = false) {
        val id = currentCardId() ?: return
        val attemptId = activeAttempt?.optString("attemptId").orEmpty()
        if (attemptId.isBlank()) return
        busy = true; error = null
        if (!retry) {
            val skipped = answers.toMutableMap()
            questions.forEach { question ->
                val qid = question.optString("questionId")
                if (!hasAnswer(question, skipped[qid]) && !isSkippedAnswer(skipped[qid])) {
                    skipped[qid] = JSONObject().put("skipped", true).put("draft", skipped[qid] ?: JSONObject.NULL)
                }
            }
            answers = skipped
            pendingAnswers = pendingAnswers + skipped
            savePending()
            if (error != null) { busy = false; return }
        }
        try {
            viewModel.requestApi("/v2/learning-cards/$id/attempts/$attemptId/complete", "POST", JSONObject())
            activeAttempt = JSONObject((activeAttempt ?: JSONObject()).toString()).put("status", "grading")
            scene = "grading"
            pollGrading()
        } catch (cause: Throwable) { error = featureFailure(cause, "交卷没有完成，作答仍然保留。") }
        busy = false
    }

    LaunchedEffect(noteId) {
        if (state.aiSettings == null) viewModel.loadAccountSettings()
        load()
    }

    Column(Modifier.fillMaxSize().background(StudyPalette.canvas)) {
        LearningCardHeader(
            card = card,
            questions = questions,
            saving = saving,
            onBack = { scope.launch { savePending(); onClose() } },
        )
        error?.takeIf { !requiresAiConsent(it) && !requiresAiDataPolicy(it) }?.let {
            FeatureFailure(it, retry = { scope.launch { load() } })
        }
        if (requiresAiConsent(error) || requiresAiDataPolicy(error)) {
            FeatureAuthorizationNotice(state, error, onAccount = onAccount, retry = { scope.launch { load() } })
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (scene) {
                "setup" -> LearningCardSetup(
                    title, questionCount, busy, canGenerate = document?.versionId != null,
                    aiBlocked = state.aiSettings?.needsSigning != false || state.aiSettings?.dataPolicy?.sendToExternal != true,
                    onCount = { questionCount = it },
                    onGenerate = { scope.launch { generate() } },
                    onBack = { scene = "front" },
                )
                "practice" -> LearningCardPractice(
                    state = state,
                    viewModel = viewModel,
                    title = title,
                    questions = questions,
                    index = index,
                    answers = answers,
                    busy = busy,
                    onIndex = { index = it },
                    onChange = ::changeAnswer,
                    onPrevious = { if (index > 0) index -= 1 },
                    onSkip = {
                        questions.getOrNull(index)?.let { question ->
                            val qid = question.optString("questionId")
                            changeAnswer(qid, JSONObject().put("skipped", true).put("draft", answers[qid] ?: JSONObject.NULL))
                            if (index < questions.size - 1) index += 1
                        }
                    },
                    onNext = {
                        if (index == questions.size - 1) confirmSubmit = true else index += 1
                    },
                    onSubmit = { confirmSubmit = true },
                    onLeave = { scope.launch { savePending(); onClose() } },
                )
                "grading" -> LearningCardGrading(onRefresh = { scope.launch { pollGrading() } })
                "result" -> LearningCardResult(
                    state = state,
                    viewModel = viewModel,
                    card = card,
                    result = resultAttempt,
                    onBack = { scene = "front" },
                    onRetry = { scope.launch { startAttempt() } },
                )
                else -> LearningCardFront(
                    loading = loading,
                    generating = generating,
                    card = card,
                    title = title,
                    document = document,
                    attempts = attempts,
                    questions = questions,
                    activeAttempt = activeAttempt,
                    busy = busy,
                    onStart = { scope.launch { startAttempt() } },
                    onContinue = { scene = "practice" },
                    onRetryGrading = { scope.launch { submit(retry = true) } },
                    onOpenLatest = { attempt -> resultAttempt = attempt; scene = "result" },
                    onSetup = { scene = "setup" },
                )
            }
        }
    }
    if (confirmSubmit) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmSubmit = false },
            title = { Text("交卷并批改？") },
            text = { Text("未完成的题目会记为跳过。交卷后才能查看答案、原文依据和批改结果。") },
            confirmButton = {
                AstellaButton(onClick = { confirmSubmit = false; scope.launch { submit() } }) { Text("交卷并批改") }
            },
            dismissButton = { AstellaTextButton(onClick = { confirmSubmit = false }) { Text("继续作答") } },
        )
    }
}

/** 页眉：玻璃返回钮 + 页标题 + 版本/题量子行；右侧保存指示占固定宽度，避免跳动。 */
@Composable
private fun LearningCardHeader(
    card: JSONObject?,
    questions: List<JSONObject>,
    saving: Boolean,
    onBack: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 10.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        GlassCircleButton(onClick = onBack, size = 42.dp) {
            AstellaGlyph(AstellaGlyphKind.Back, Modifier.size(18.dp), tint = StudyPalette.ink)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("学习卡", color = StudyPalette.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            val version = card?.optInt("versionNo", 0)?.takeIf { it > 0 } ?: (card?.optString("noteVersionId")?.let { 1 } ?: 1)
            val subtitle = if (questions.isEmpty()) "围绕已保存的原文练习" else "第 $version 版 · ${questions.size} 道题"
            Text(subtitle, color = StudyPalette.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
            if (saving) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
        }
    }
}

@Composable
private fun LearningCardFront(
    loading: Boolean,
    generating: Boolean,
    card: JSONObject?,
    title: String,
    document: com.astella.mobile.data.NoteDocument?,
    attempts: List<JSONObject>,
    questions: List<JSONObject>,
    activeAttempt: JSONObject?,
    busy: Boolean,
    onStart: () -> Unit,
    onContinue: () -> Unit,
    onRetryGrading: () -> Unit,
    onOpenLatest: (JSONObject) -> Unit,
    onSetup: () -> Unit,
) {
    when {
        loading -> CenteredCardState("正在打开学习卡")
        generating -> CenteredCardState("正在制作你的学习卡", "题目会围着这版原文搭配，完成后自动出现。")
        card == null -> Column(Modifier.fillMaxSize().padding(22.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            FeatureGenerationPrimer("learning-card", document)
            Spacer(Modifier.weight(1f))
            AstellaButton(onClick = onSetup, enabled = document != null, modifier = Modifier.fillMaxWidth().height(54.dp)) {
                AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(16.dp), tint = Color.White)
                Text("准备学习卡", Modifier.padding(start = 8.dp))
            }
        }
        else -> {
            val bestScore = card.opt("bestScore")?.takeIf { it != JSONObject.NULL }?.toString()
            val bestStars = card.opt("bestStars")?.takeIf { it != JSONObject.NULL }?.let { card.optInt("bestStars") } ?: 0
            val completed = attempts.count { it.optString("status") == "completed" }
            val latest = attempts.firstOrNull { it.optString("status") == "completed" }
            val unresolved = activeAttempt?.takeIf { it.optString("status") in setOf("in_progress", "grading_failed") }
            val failedGrading = unresolved?.optString("status") == "grading_failed"
            val primaryLabel = when {
                failedGrading -> "重新批改"
                unresolved != null -> "继续作答"
                completed > 0 -> "再练一次"
                else -> "开始学习"
            }
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 4.dp, bottom = 36.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                item {
                    CardHero(title, card, questions.size, bestScore, bestStars, completed)
                }
                item {
                    AstellaButton(
                        onClick = when {
                            failedGrading -> onRetryGrading
                            unresolved != null -> onContinue
                            else -> onStart
                        },
                        enabled = !busy && questions.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                        shape = RoundedCornerShape(StudyRadius.xl),
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(17.dp), color = Color.White, strokeWidth = 2.dp)
                        else AstellaGlyph(
                            if (unresolved != null) AstellaGlyphKind.Play else AstellaGlyphKind.Companion,
                            Modifier.size(16.dp), tint = Color.White,
                        )
                        Text(primaryLabel, Modifier.padding(start = 9.dp))
                    }
                }
                if (unresolved != null && !failedGrading) {
                    item {
                        CardNotice(
                            "上次练习还留着草稿，已答 ${questions.count { hasAnswer(it, null) || isSkippedAnswer(null) }.let { 0 }} / ${questions.size} 题，交给伴星批改后会一起回看。",
                        )
                    }
                }
                if (latest != null) {
                    item {
                        SecondaryCardRow(
                            glyph = AstellaGlyphKind.History,
                            title = "最近一次 · ${latest.optInt("score")} 分",
                            subtitle = "查看逐题作答、原文依据与批改结果",
                            onClick = { onOpenLatest(latest) },
                        )
                    }
                }
                item {
                    SecondaryCardRow(
                        glyph = AstellaGlyphKind.Refresh,
                        title = "按当前笔记版本重新生成",
                        subtitle = "会替换这张卡的题目，已有练习记录保留",
                        onClick = onSetup,
                    )
                }
            }
        }
    }
}

@Composable
private fun CardHero(
    title: String,
    card: JSONObject,
    questionCount: Int,
    bestScore: String?,
    bestStars: Int,
    completed: Int,
) {
    Column(
        Modifier.fillMaxWidth().astellaGlass(StudyRadius.xxl).padding(22.dp),
    ) {
        Text(
            "LEARNING CARD · 第 ${card.optInt("versionNo", 1).coerceAtLeast(1)} 版 · $questionCount 道题",
            color = StudyPalette.accent, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp,
        )
        Text(
            title, Modifier.padding(top = 12.dp), color = StudyPalette.ink,
            fontFamily = FontFamily.Serif, fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium,
            maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        StarRow(stars = bestStars, modifier = Modifier.padding(top = 20.dp), starSize = 26.sp)
        Row(Modifier.padding(top = 16.dp), verticalAlignment = Alignment.Bottom) {
            ScoreNumeral(score = bestScore, modifier = Modifier.alignByBaseline())
            Text("分", Modifier.padding(start = 6.dp).alignByBaseline(), color = StudyPalette.muted, fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                Text("最佳得分", color = StudyPalette.muted, fontSize = 11.sp)
                Text(
                    if (completed > 0) "已完成 $completed 次" else "还没有完成过",
                    Modifier.padding(top = 3.dp), color = StudyPalette.muted, fontSize = 11.sp,
                )
            }
        }
        HorizontalDivider(Modifier.padding(vertical = 18.dp), color = StudyPalette.paperEdge.copy(alpha = .7f))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            StatCell("练习次数", completed.toString(), Modifier.weight(1f))
            Box(Modifier.width(.7.dp).height(34.dp).background(StudyPalette.paperEdge.copy(alpha = .7f)))
            StatCell(
                "题目数量", questionCount.toString(),
                Modifier.weight(1f).padding(start = 20.dp),
            )
        }
    }
}

@Composable
private fun StatCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(value, color = StudyPalette.ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Text(label, Modifier.padding(top = 3.dp), color = StudyPalette.muted, fontSize = 11.sp)
    }
}

/** 星级：进入页面时按 60ms 错峰弹起；减弱动效时直接落位。 */
@Composable
internal fun StarRow(stars: Int, modifier: Modifier = Modifier, starSize: androidx.compose.ui.unit.TextUnit = 24.sp) {
    val motion = enabledMotion()
    var revealed by remember(stars) { mutableStateOf(!motion) }
    LaunchedEffect(stars, motion) {
        if (!motion) { revealed = true; return@LaunchedEffect }
        delay(160); revealed = true
    }
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(5) { i ->
            val filled = i < stars
            val scale by animateFloatAsState(
                targetValue = when {
                    !filled -> 1f
                    !revealed -> .55f
                    else -> 1f
                },
                animationSpec = spring(dampingRatio = .55f, stiffness = 420f),
                label = "star-pop-$i",
            )
            Text(
                "★",
                Modifier.graphicsLayer { scaleX = scale; scaleY = scale },
                color = if (filled) StudyPalette.accent else StudyPalette.muted.copy(alpha = .24f),
                fontSize = starSize,
            )
        }
    }
}

/** 最佳得分：进入时从 0 数到目标值；减弱动效时直接显示。 */
@Composable
private fun ScoreNumeral(score: String?, modifier: Modifier = Modifier) {
    val target = score?.toIntOrNull()
    val motion = enabledMotion()
    var started by remember(target) { mutableStateOf(!motion) }
    LaunchedEffect(target, motion) {
        if (!motion) { started = true; return@LaunchedEffect }
        delay(120); started = true
    }
    val animated by animateIntAsState(
        targetValue = if (started) target ?: 0 else 0,
        animationSpec = tween(durationMillis = 620),
        label = "score-count",
    )
    Text(
        if (target != null) animated.toString() else "—",
        modifier,
        color = StudyPalette.ink, fontSize = 54.sp, lineHeight = 58.sp, fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun SecondaryCardRow(
    glyph: AstellaGlyphKind,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().astellaGlass(StudyRadius.xl).clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Box(
            Modifier.size(38.dp).background(StudyPalette.sky, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center,
        ) { AstellaGlyph(glyph, Modifier.size(18.dp), tint = StudyPalette.accent) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = StudyPalette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = StudyPalette.muted, fontSize = 11.5.sp)
        }
        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(14.dp), tint = StudyPalette.muted)
    }
}

@Composable
private fun CardNotice(text: String) {
    Text(
        text,
        Modifier.fillMaxWidth().background(StudyPalette.sky.copy(alpha = .55f), RoundedCornerShape(StudyRadius.lg))
            .padding(horizontal = 15.dp, vertical = 13.dp),
        color = StudyPalette.muted, fontSize = 12.sp, lineHeight = 19.sp,
    )
}

@Composable
private fun CenteredCardState(title: String, detail: String? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
        Text(title, Modifier.padding(top = 18.dp), color = StudyPalette.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        detail?.let {
            Text(it, Modifier.padding(top = 8.dp), color = StudyPalette.muted, fontSize = 13.sp,
                lineHeight = 20.sp, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun LearningCardGrading(onRefresh: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp, color = StudyPalette.accent)
        Text("正在批改这次练习", Modifier.padding(top = 20.dp), color = StudyPalette.ink,
            fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text("客观题自动核对，简答按原文依据逐题评分。答案不会丢失。",
            Modifier.padding(top = 10.dp), color = StudyPalette.muted, fontSize = 13.sp,
            lineHeight = 21.sp, textAlign = TextAlign.Center)
        AstellaTextButton(onClick = onRefresh, contentPadding = PaddingValues(top = 14.dp, bottom = 4.dp)) {
            Text("刷新状态")
        }
    }
}

@Composable
private fun LearningCardSetup(
    title: String,
    count: Int,
    busy: Boolean,
    canGenerate: Boolean,
    aiBlocked: Boolean,
    onCount: (Int) -> Unit,
    onGenerate: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 22.dp).padding(top = 8.dp, bottom = 26.dp)) {
        Text("准备一张新的学习卡", color = StudyPalette.ink, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text("题目会根据已保存的笔记版本搭配，每道题都能回到原文核对。",
            Modifier.padding(top = 10.dp), color = StudyPalette.muted, fontSize = 13.sp, lineHeight = 21.sp)
        Text(title, Modifier.padding(top = 16.dp), color = StudyPalette.muted, fontSize = 12.sp)
        Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf(4, 6, 8).forEach { value ->
                val selected = count == value
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (selected) StudyPalette.sky else StudyPalette.paper, RoundedCornerShape(StudyRadius.lg))
                        .border(.8.dp, if (selected) StudyPalette.accent.copy(alpha = .45f) else StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(StudyRadius.lg))
                        .clickable { onCount(value) }
                        .padding(horizontal = 16.dp, vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("$value 道题", color = StudyPalette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (value == 4) "轻轻试一试" else if (value == 6) "刚刚好" else "多想深一点",
                            color = StudyPalette.muted, fontSize = 11.sp,
                        )
                    }
                    if (selected) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(18.dp), tint = StudyPalette.accent)
                }
            }
        }
        Spacer(Modifier.weight(1f))
        if (aiBlocked) {
            CardNotice("生成学习卡需要外部 AI 授权，请先在「我的 → AI 与数据」确认。")
            Spacer(Modifier.height(12.dp))
        }
        AstellaButton(onClick = onGenerate, enabled = !busy && canGenerate && !aiBlocked,
            modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(StudyRadius.xl)) {
            if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
            else AstellaGlyph(AstellaGlyphKind.Companion, Modifier.size(16.dp), tint = Color.White)
            Text(if (busy) "正在创建…" else "生成学习卡", Modifier.padding(start = 8.dp))
        }
        AstellaTextButton(onClick = onBack, contentPadding = PaddingValues(top = 8.dp)) { Text("先看已有学习卡") }
    }
}

@Composable
private fun LearningCardPractice(
    state: AppUiState,
    viewModel: AppViewModel,
    title: String,
    questions: List<JSONObject>,
    index: Int,
    answers: Map<String, Any>,
    busy: Boolean,
    onIndex: (Int) -> Unit,
    onChange: (String, Any) -> Unit,
    onPrevious: () -> Unit,
    onSkip: () -> Unit,
    onNext: () -> Unit,
    onSubmit: () -> Unit,
    onLeave: () -> Unit,
) {
    if (questions.isEmpty()) return
    val motion = enabledMotion()
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(top = 4.dp, bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("第 ${index + 1} / ${questions.size} 题", color = StudyPalette.accent,
                    fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .8.sp)
                Spacer(Modifier.weight(1f))
                Text(
                    questionTypeLabel(questions.getOrNull(index)?.optString("type").orEmpty()),
                    Modifier.background(StudyPalette.inset.copy(alpha = .8f), CircleShape)
                        .padding(horizontal = 11.dp, vertical = 5.dp),
                    color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.Medium,
                )
            }
            LinearProgressIndicator(
                progress = { (index + 1).toFloat() / questions.size.coerceAtLeast(1) },
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp).height(5.dp).clip(CircleShape),
                color = StudyPalette.accent,
                trackColor = StudyPalette.inset,
            )
        }
        AnimatedContent(
            targetState = index,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            transitionSpec = {
                if (!motion) EnterTransition.None togetherWith ExitTransition.None
                else {
                    val forward = targetState > initialState
                    (slideInHorizontally(tween(230)) { width -> if (forward) width / 7 else -width / 7 } +
                        fadeIn(tween(190))) togetherWith
                        (slideOutHorizontally(tween(180)) { width -> if (forward) -width / 9 else width / 9 } +
                            fadeOut(tween(140)))
                }
            },
            label = "question-change",
        ) { position ->
            val question = questions.getOrNull(position) ?: return@AnimatedContent
            val questionId = question.optString("questionId")
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 22.dp, end = 22.dp, top = 4.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item {
                    Text(title, color = StudyPalette.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        question.optString("stem"),
                        Modifier.padding(top = 9.dp),
                        color = StudyPalette.ink, fontSize = 18.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium,
                    )
                }
                if (isSkippedAnswer(answers[questionId])) {
                    item { CardNotice("这题暂时跳过了，原有草稿仍为你保留。") }
                }
                item {
                    LearningCardAnswerEditor(
                        viewModel = viewModel,
                        question = question,
                        value = answers[questionId],
                        readOnly = false,
                        onChange = { value -> onChange(questionId, value) },
                    )
                }
                item {
                    Text("答案与原文依据会在交卷后一起显示。", color = StudyPalette.muted, fontSize = 11.5.sp)
                }
            }
        }
        Column(
            Modifier.fillMaxWidth()
                .background(StudyPalette.paper)
                .padding(horizontal = 18.dp).padding(top = 14.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .55f))
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                AstellaOutlinedButton(onClick = onPrevious, enabled = index > 0 && !busy) { Text("上一题") }
                AstellaTextButton(onClick = onSkip, enabled = !busy) { Text("跳过") }
                Spacer(Modifier.weight(1f))
                AstellaButton(onClick = onNext, enabled = !busy) {
                    Text(if (index == questions.size - 1) "检查并交卷" else "下一题")
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                questions.forEachIndexed { item, q ->
                    val answered = hasAnswer(q, answers[q.optString("questionId")]) ||
                        isSkippedAnswer(answers[q.optString("questionId")])
                    val active = index == item
                    Box(
                        Modifier.size(30.dp)
                            .background(
                                when {
                                    active -> StudyPalette.accent
                                    answered -> StudyPalette.sky
                                    else -> StudyPalette.inset.copy(alpha = .6f)
                                },
                                CircleShape,
                            )
                            .clickable { onIndex(item) }
                            .semantics { contentDescription = "第 ${item + 1} 题" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("${item + 1}", color = if (active) Color.White else StudyPalette.ink, fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold)
                    }
                }
                Spacer(Modifier.weight(1f))
                // 返回键已经会保存并离开，这里只留交卷，避免与右下伴星浮钮重叠。
                AstellaTextButton(onClick = onSubmit) { Text("交卷") }
            }
        }
    }
}
