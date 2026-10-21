package com.astella.mobile.ui.screens

import com.astella.mobile.ui.design.*

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.TextView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.astella.mobile.R
import com.astella.mobile.data.*
import com.astella.mobile.ui.design.StudyPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID
import kotlin.math.*

@Composable
fun CompanionParticles(level: Float, active: Boolean, reduced: Boolean, modifier: Modifier = Modifier) {
    val color = StudyPalette.accent
    var time by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(active, reduced) {
        if (!active || reduced) { time = 0f; return@LaunchedEffect }
        val start = withFrameNanos { it }
        while (true) { withFrameNanos { time = (it - start) / 1_000_000_000f } }
    }
    Canvas(modifier) {
        if (reduced) {
            if (!active) return@Canvas
            repeat(17) { index ->
                val height = (5 + index % 4 * 3).dp.toPx()
                drawLine(color.copy(alpha = .5f), Offset(center.x + (index - 8) * 6.dp.toPx(), center.y - height / 2),
                    Offset(center.x + (index - 8) * 6.dp.toPx(), center.y + height / 2), 2.dp.toPx())
            }
        } else {
            val energy = if (active) max(.05f, level) else 0f
            repeat(144) { index ->
                val angle = index * 2.399963f + time * if (index % 2 == 0) .13f else -.09f
                val shell = .62f + (index % 7) / 18f
                val radius = size.minDimension * .37f * shell + sin(angle * 5 + time * 2.2f) * energy * 19.dp.toPx() + energy * 16.dp.toPx()
                val point = Offset(center.x + cos(angle) * radius, center.y + sin(angle) * radius * .52f)
                drawCircle(color.copy(alpha = (.12f + energy * .45f) * (.45f + shell / 2)),
                    (1.4f + index % 3 * .6f + energy * 1.1f).dp.toPx() / 2, point)
            }
        }
    }
}

private val noteLinkPattern = Regex("\\[([^\\]]+)]\\(astella-note:([^\\s)]+)\\)")

@Composable
fun CompanionSelectableText(
    text: String,
    fontSize: Float,
    serif: Boolean = false,
    color: androidx.compose.ui.graphics.Color = StudyPalette.ink,
    lineSpacingMultiplier: Float = if (serif) 1.72f else 1.4f,
    letterSpacing: Float = if (serif) .02f else 0f,
    italic: Boolean = false,
    onOpenNote: ((String) -> Unit)? = null,
    onSelection: (String, Boolean) -> Unit,
    onAnnotate: (() -> Unit)? = null,
) {
    val ink = color
    val accent = StudyPalette.accent
    val latestSelection by rememberUpdatedState(onSelection)
    val latestAnnotate by rememberUpdatedState(onAnnotate)
    val latestOpenNote by rememberUpdatedState(onOpenNote)
    AndroidView(
        factory = { context ->
            TextView(context).apply {
                setTextIsSelectable(true); setPadding(0, 0, 0, 0)
                includeFontPadding = false
                customSelectionActionModeCallback = object : ActionMode.Callback {
                    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                        menu.add(0, 701, 0, "伴星解释")
                        menu.add(0, 702, 1, "伴星改写")
                        if (latestAnnotate != null) menu.add(0, 703, 2, "留批注")
                        return true
                    }
                    override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
                    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                        if (item.itemId == 703) {
                            latestAnnotate?.invoke()
                            mode.finish(); return true
                        }
                        if (item.itemId !in listOf(701, 702)) return false
                        val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
                        val end = maxOf(selectionStart, selectionEnd).coerceAtMost(text.length)
                        if (end > start) latestSelection(text.substring(start, end), item.itemId == 702)
                        mode.finish(); return true
                    }
                    override fun onDestroyActionMode(mode: ActionMode) = Unit
                }
            }
        },
        update = { view ->
            if (view.tag != text) {
                view.tag = text
                val matches = noteLinkPattern.findAll(text).toList()
                if (matches.isEmpty()) {
                    view.text = text
                } else {
                    val builder = SpannableStringBuilder()
                    var cursor = 0
                    matches.forEach { match ->
                        builder.append(text.substring(cursor, match.range.first))
                        val start = builder.length
                        val label = match.groupValues[1]
                        val noteId = match.groupValues[2]
                        builder.append(label)
                        val end = builder.length
                        builder.setSpan(object : ClickableSpan() {
                            override fun onClick(widget: View) { latestOpenNote?.invoke(noteId) }
                            override fun updateDrawState(ds: TextPaint) {
                                ds.color = android.graphics.Color.argb(
                                    (accent.alpha * 255).toInt(), (accent.red * 255).toInt(),
                                    (accent.green * 255).toInt(), (accent.blue * 255).toInt(),
                                )
                                ds.isUnderlineText = false
                            }
                        }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        cursor = match.range.last + 1
                    }
                    builder.append(text.substring(cursor))
                    view.text = builder
                    view.movementMethod = LinkMovementMethod.getInstance()
                }
            }
            view.textSize = fontSize
            view.setLineSpacing(0f, lineSpacingMultiplier)
            view.letterSpacing = letterSpacing
            view.typeface = when {
                serif -> android.graphics.Typeface.create("serif", if (italic) android.graphics.Typeface.ITALIC else android.graphics.Typeface.NORMAL)
                italic -> android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.ITALIC)
                else -> android.graphics.Typeface.DEFAULT
            }
            view.setTextColor(android.graphics.Color.argb((ink.alpha * 255).toInt(), (ink.red * 255).toInt(), (ink.green * 255).toInt(), (ink.blue * 255).toInt()))
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun CompanionProposalCard(proposalId: String, viewModel: AppViewModel) {
    var proposal by remember(proposalId) { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember(proposalId) { mutableIntStateOf(0) }
    var decision by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val keys = remember(proposalId) { mutableMapOf<String, String>() }
    suspend fun load() {
        try { proposal = viewModel.requestApi("/companion/proposals/$proposalId").optJSONObject("proposal"); error = null }
        catch (failure: Exception) { kotlinx.coroutines.currentCoroutineContext().ensureActive(); error = failure.message ?: "建议暂时没有加载出来。" }
    }
    LaunchedEffect(proposalId, reload) { load() }
    LaunchedEffect(proposal?.optString("status")) {
        while (proposal?.optString("status") in setOf("accepted", "executing")) { delay(2000); load() }
    }
    LaunchedEffect(decision) {
        val value = decision ?: return@LaunchedEffect
        busy = true
        try {
            val key = keys.getOrPut(value) { UUID.randomUUID().toString() }
            viewModel.decideProposal(proposalId, value, proposal!!.getString("payloadSha256"), key)
            load(); viewModel.refreshMessages()
        } catch (failure: Exception) { kotlinx.coroutines.currentCoroutineContext().ensureActive(); error = failure.message ?: "决定没有送达，请重试。" }
        finally { busy = false; decision = null }
    }
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(StudyRadius.xl))
            .background(StudyPalette.paper)
            .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .5f), RoundedCornerShape(StudyRadius.xl))
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val current = proposal
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AstellaGlyph(AstellaGlyphKind.Edit, Modifier.size(13.dp), tint = StudyPalette.accent)
            Text(
                "伴星的修改建议",
                color = StudyPalette.accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .3.sp,
            )
        }
        if (current == null) {
            QuietTextAction(
                if (error == null) "正在接回修改建议…" else "重新读取建议",
                onClick = { reload++ },
            )
        } else {
            Text(
                current.optString("title", "伴星的修改建议"),
                color = StudyPalette.ink, fontSize = 16.5.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(
                current.optString("impactSummary"),
                color = StudyPalette.muted, fontSize = 12.5.sp, lineHeight = 19.sp,
            )
            val preview = current.optJSONObject("payload")?.optJSONObject("preview")
            preview?.optString("beforeMarkdown")?.takeIf { it.isNotBlank() }?.let { before ->
                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("原文", color = StudyPalette.muted, fontSize = 10.5.sp, fontWeight = FontWeight.Medium)
                    SelectionContainer {
                        Text(
                            before,
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(StudyRadius.md))
                                .background(StudyPalette.inset.copy(alpha = .7f))
                                .padding(12.dp),
                            color = StudyPalette.ink, fontSize = 13.5.sp, lineHeight = 21.sp,
                        )
                    }
                }
            }
            preview?.optString("markdown")?.takeIf { it.isNotBlank() }?.let { after ->
                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("改写后", color = StudyPalette.accent, fontSize = 10.5.sp, fontWeight = FontWeight.Medium)
                    SelectionContainer {
                        Text(
                            after,
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(StudyRadius.md))
                                .background(StudyPalette.sky.copy(alpha = .7f))
                                .padding(12.dp),
                            color = StudyPalette.ink, fontSize = 13.5.sp, lineHeight = 21.sp,
                        )
                    }
                }
            }
            if (current.optString("status") == "pending") {
                Row(
                    Modifier.fillMaxWidth().padding(top = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    QuietTextAction("保留原文", onClick = { decision = "reject" }, enabled = !busy)
                    AstellaButton(
                        onClick = { decision = "confirm" },
                        enabled = !busy,
                        shape = RoundedCornerShape(StudyRadius.lg),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 18.dp, vertical = 10.dp),
                    ) { Text("确认写回", fontSize = 14.sp) }
                }
            } else {
                Text(
                    when (current.optString("status")) {
                        "succeeded" -> "已经写回手记"
                        "rejected" -> "已保留原文"
                        "expired" -> "这份建议已过期，请重新生成"
                        "failed" -> "写回没有完成，请重新请伴星修改"
                        else -> "正在写回手记…"
                    },
                    color = StudyPalette.muted, fontSize = 12.sp,
                )
            }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = StudyPalette.accent)
        error?.let {
            ShellNotice(
                "建议没有读出来",
                it,
                glyph = AstellaGlyphKind.Alert,
                tint = StudyPalette.danger,
                actionLabel = "重试",
                onAction = { reload++ },
            )
        }
    }
}
