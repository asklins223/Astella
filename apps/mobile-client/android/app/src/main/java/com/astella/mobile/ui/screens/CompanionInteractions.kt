package com.astella.mobile.ui.screens

import com.astella.mobile.ui.design.*

import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
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

@Composable
fun CompanionSelectableText(
    text: String,
    fontSize: Float,
    serif: Boolean = false,
    color: androidx.compose.ui.graphics.Color = StudyPalette.ink,
    lineSpacingMultiplier: Float = if (serif) 1.72f else 1.4f,
    letterSpacing: Float = if (serif) .02f else 0f,
    onSelection: (String, Boolean) -> Unit,
) {
    val ink = color
    val latestSelection by rememberUpdatedState(onSelection)
    AndroidView(
        factory = { context ->
            TextView(context).apply {
                setTextIsSelectable(true); setPadding(0, 0, 0, 0)
                includeFontPadding = false
                customSelectionActionModeCallback = object : ActionMode.Callback {
                    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                        menu.add(0, 701, 0, "伴星解释")
                        menu.add(0, 702, 1, "伴星改写")
                        return true
                    }
                    override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
                    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
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
            if (view.text.toString() != text) view.text = text
            view.textSize = fontSize
            view.setLineSpacing(0f, lineSpacingMultiplier)
            view.letterSpacing = letterSpacing
            view.typeface = if (serif) android.graphics.Typeface.create("serif", android.graphics.Typeface.NORMAL)
                else android.graphics.Typeface.DEFAULT
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
    Surface(shape = RoundedCornerShape(18.dp), color = StudyPalette.paper, border = androidx.compose.foundation.BorderStroke(.5.dp, StudyPalette.paperEdge)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val current = proposal
            if (current == null) AstellaTextButton(onClick = { reload++ }) { Text(if (error == null) "正在接回修改建议…" else "重新读取建议") }
            else {
                Text(current.optString("title", "伴星的修改建议"), style = MaterialTheme.typography.titleMedium)
                Text(current.optString("impactSummary"), style = MaterialTheme.typography.bodySmall, color = StudyPalette.muted)
                val preview = current.optJSONObject("payload")?.optJSONObject("preview")
                preview?.optString("beforeMarkdown")?.takeIf { it.isNotBlank() }?.let { before ->
                    Text("原文", style = MaterialTheme.typography.labelMedium, color = StudyPalette.muted)
                    SelectionContainer { Text(before, Modifier.fillMaxWidth().background(StudyPalette.inset, RoundedCornerShape(12.dp)).padding(12.dp), style = MaterialTheme.typography.bodyMedium) }
                }
                preview?.optString("markdown")?.takeIf { it.isNotBlank() }?.let { after ->
                    Text("改写后", style = MaterialTheme.typography.labelMedium, color = StudyPalette.accent)
                    SelectionContainer { Text(after, Modifier.fillMaxWidth().background(StudyPalette.sky, RoundedCornerShape(12.dp)).padding(12.dp), style = MaterialTheme.typography.bodyMedium) }
                }
                if (current.optString("status") == "pending") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    AstellaTextButton(onClick = { decision = "reject" }, enabled = !busy) { Text("保留原文") }
                    AstellaButton(onClick = { decision = "confirm" }, enabled = !busy) { Text("确认写回") }
                } else Text(when (current.optString("status")) {
                    "succeeded" -> "已经写回手记"
                    "rejected" -> "已保留原文"
                    "expired" -> "这份建议已过期，请重新生成"
                    "failed" -> "写回没有完成，请重新请伴星修改"
                    else -> "正在写回手记…"
                }, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall)
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let {
                Text(it, color = StudyPalette.danger, style = MaterialTheme.typography.bodySmall)
                if (current != null) AstellaTextButton(onClick = { reload++ }) { Text("重新读取建议") }
            }
        }
    }
}
