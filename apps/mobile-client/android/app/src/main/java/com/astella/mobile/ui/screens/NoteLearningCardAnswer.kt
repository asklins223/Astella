package com.astella.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.astella.mobile.ui.design.AstellaButton
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaOutlinedButton
import com.astella.mobile.ui.design.AstellaTextButton
import com.astella.mobile.ui.design.StudyPalette
import org.json.JSONArray
import org.json.JSONObject

/** 单题作答编辑器：题型固定，答案形状与 shared grading 契约一一对应。 */
@Composable
fun LearningCardAnswerEditor(
    viewModel: com.astella.mobile.data.AppViewModel,
    question: JSONObject,
    value: Any?,
    readOnly: Boolean,
    onChange: (Any) -> Unit,
) {
    val type = question.optString("type")
    val draft = answerDraft(value)
    when (type) {
        "single_choice", "multi_choice", "true_false" -> ChoiceAnswer(question, draft, readOnly, onChange)
        "fill_blank" -> FillBlankAnswer(question, draft, readOnly, onChange)
        "short_answer" -> ShortAnswerEditor(draft, readOnly, onChange)
        "ordering" -> OrderingAnswer(question, draft, readOnly, onChange)
        "matching" -> MatchingAnswer(question, draft, readOnly, onChange)
        "operation" -> OperationAnswerEditor(viewModel, question, draft, readOnly, onChange)
        else -> Text("题目类型暂不可用，可以先跳过这题。", color = StudyPalette.muted, fontSize = 13.sp)
    }
}

@Composable
private fun ChoiceAnswer(question: JSONObject, draft: Any?, readOnly: Boolean, onChange: (Any) -> Unit) {
    val type = question.optString("type")
    val options = question.optJSONArray("options").strings()
    val choices = if (type == "true_false") listOf("正确", "错误") else options
    val selected: List<String> = when (type) {
        "multi_choice" -> answerMap(draft).optJSONArray("optionIds").strings()
        "true_false" -> (draft as? Boolean)?.let { listOf(if (it) "0" else "1") } ?: emptyList()
        else -> answerMap(draft).optString("optionId").takeIf(String::isNotEmpty)?.let(::listOf) ?: emptyList()
    }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        choices.forEachIndexed { index, text ->
            val key = index.toString()
            val active = selected.contains(key)
            Row(
                Modifier.fillMaxWidth()
                    .background(if (active) StudyPalette.sky else StudyPalette.paper, RoundedCornerShape(15.dp))
                    .border(.8.dp, if (active) StudyPalette.accent.copy(alpha = .45f) else StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(15.dp))
                    .clickable(enabled = !readOnly) {
                        when (type) {
                            "true_false" -> onChange(index == 0)
                            "multi_choice" -> {
                                val next = if (active) selected - key else (selected + key).sortedBy { it.toIntOrNull() ?: 0 }
                                onChange(JSONObject().put("optionIds", JSONArray(next)))
                            }
                            else -> onChange(JSONObject().put("optionId", key))
                        }
                    }
                    .heightIn(min = 52.dp)
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(11.dp),
            ) {
                Box(
                    Modifier.size(30.dp).background(if (active) StudyPalette.accent else StudyPalette.sky, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (type == "multi_choice" && active) "✓" else ('A' + index).toString(),
                        color = if (active) StudyPalette.canvas else StudyPalette.accent,
                        fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(text, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 15.sp, lineHeight = 22.sp)
                if (active) AstellaGlyph(AstellaGlyphKind.Check, Modifier.size(14.dp), tint = StudyPalette.accent)
            }
        }
    }
}

@Composable
private fun FillBlankAnswer(question: JSONObject, draft: Any?, readOnly: Boolean, onChange: (Any) -> Unit) {
    val count = question.optInt("blankCount", 1).coerceIn(1, 12)
    val values = answerMap(draft).optJSONArray("values").strings().let { list ->
        List(count) { index -> list.getOrElse(index) { "" } }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(count) { blank ->
            var text by remember(question.optString("questionId"), blank, values[blank]) { mutableStateOf(values[blank]) }
            OutlinedTextField(
                value = text,
                onValueChange = { next ->
                    text = next
                    val list = MutableList(count) { slot -> if (slot == blank) next else values[slot] }
                    onChange(JSONObject().put("values", JSONArray(list)))
                },
                enabled = !readOnly,
                label = { Text("第 ${blank + 1} 空") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ShortAnswerEditor(draft: Any?, readOnly: Boolean, onChange: (Any) -> Unit) {
    var text by remember { mutableStateOf(answerMap(draft).optString("text")) }
    OutlinedTextField(
        value = text,
        onValueChange = { next -> text = next.take(4000); onChange(JSONObject().put("text", text)) },
        enabled = !readOnly,
        label = { Text("你的回答") },
        placeholder = { Text("按你的理解写下来，不用急着组织成标准答案。") },
        minLines = 5,
        modifier = Modifier.fillMaxWidth(),
    )
    Text("${text.length} / 4000", Modifier.fillMaxWidth().padding(top = 4.dp), color = StudyPalette.muted,
        fontSize = 11.sp, textAlign = TextAlign.End)
}

@Composable
private fun OrderingAnswer(question: JSONObject, draft: Any?, readOnly: Boolean, onChange: (Any) -> Unit) {
    val options = question.optJSONArray("options").strings()
    val order = answerMap(draft).optJSONArray("order").strings()
    fun move(index: Int, delta: Int) {
        val target = index + delta
        if (index !in order.indices || target !in order.indices) return
        val next = order.toMutableList()
        val item = next[index]; next[index] = next[target]; next[target] = item
        onChange(JSONObject().put("order", JSONArray(next)))
    }
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Text("依次加入项目，再用箭头调整顺序。", color = StudyPalette.muted, fontSize = 12.sp)
        order.forEachIndexed { position, id ->
            Row(
                Modifier.fillMaxWidth().background(StudyPalette.paper, RoundedCornerShape(14.dp))
                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(14.dp)).padding(11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Text("${position + 1}", color = StudyPalette.accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Text(options.getOrNull(id.toIntOrNull() ?: -1) ?: "未识别项目", Modifier.weight(1f),
                    color = StudyPalette.ink, fontSize = 13.sp)
                if (!readOnly) {
                    AstellaTextButton(onClick = { move(position, -1) }, enabled = position > 0,
                        contentPadding = PaddingValues(horizontal = 4.dp)) { Text("上移") }
                    AstellaTextButton(onClick = { move(position, 1) }, enabled = position < order.size - 1,
                        contentPadding = PaddingValues(horizontal = 4.dp)) { Text("下移") }
                }
            }
        }
        options.forEachIndexed { index, label ->
            if (order.contains(index.toString())) return@forEachIndexed
            Row(
                Modifier.fillMaxWidth().background(StudyPalette.sky.copy(alpha = .55f), RoundedCornerShape(13.dp))
                    .clickable(enabled = !readOnly) { onChange(JSONObject().put("order", JSONArray(order + index.toString()))) }
                    .padding(11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AstellaGlyph(AstellaGlyphKind.Add, Modifier.size(13.dp), tint = StudyPalette.accent)
                Text(label, Modifier.padding(start = 9.dp), color = StudyPalette.ink, fontSize = 13.sp)
            }
        }
        if (order.isNotEmpty() && !readOnly) {
            AstellaTextButton(onClick = { onChange(JSONObject().put("order", JSONArray())) },
                contentPadding = PaddingValues(horizontal = 0.dp)) { Text("重新排列") }
        }
    }
}

@Composable
private fun MatchingAnswer(question: JSONObject, draft: Any?, readOnly: Boolean, onChange: (Any) -> Unit) {
    val options = question.optJSONArray("options").strings()
    val right = question.optJSONArray("rightOptions").strings()
    val pairs = answerMap(draft).optJSONObject("pairs") ?: JSONObject()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        options.forEachIndexed { index, left ->
            var expanded by remember(question.optString("questionId"), index) { mutableStateOf(false) }
            val chosen = pairs.optString(index.toString())
            Column(
                Modifier.fillMaxWidth().background(StudyPalette.paper, RoundedCornerShape(15.dp))
                    .border(.7.dp, StudyPalette.paperEdge.copy(alpha = .55f), RoundedCornerShape(15.dp)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Text("${('A' + index)} · $left", color = StudyPalette.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                if (!readOnly) {
                    Row(
                        Modifier.fillMaxWidth().background(StudyPalette.inset.copy(alpha = .6f), RoundedCornerShape(12.dp))
                            .clickable { expanded = !expanded }.padding(11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(chosen.ifEmpty { "选择对应项" }, Modifier.weight(1f),
                            color = if (chosen.isEmpty()) StudyPalette.muted else StudyPalette.accent, fontSize = 13.sp)
                        AstellaGlyph(AstellaGlyphKind.Chevron, Modifier.size(12.dp), tint = StudyPalette.muted)
                    }
                    if (expanded) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            right.forEach { option ->
                                Text(option, Modifier.fillMaxWidth()
                                    .clickable {
                                        expanded = false
                                        val next = JSONObject(pairs.toString()).put(index.toString(), option)
                                        onChange(JSONObject().put("pairs", next))
                                    }
                                    .padding(vertical = 9.dp, horizontal = 5.dp),
                                    color = StudyPalette.ink, fontSize = 13.sp)
                            }
                        }
                    }
                } else {
                    Text(chosen.ifEmpty { "未作答" }, color = StudyPalette.muted, fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun OperationAnswerEditor(
    viewModel: com.astella.mobile.data.AppViewModel,
    question: JSONObject,
    draft: Any?,
    readOnly: Boolean,
    onChange: (Any) -> Unit,
) {
    val artifactId = question.optString("operationArtifactId")
    if (artifactId.isBlank()) {
        Text("这道操作题缺少可用的操作区域，可以先跳过。", color = StudyPalette.muted, fontSize = 13.sp)
        return
    }
    LearningCardOperationView(viewModel, artifactId, draft, readOnly, onChange)
}

internal fun answerDraft(value: Any?): Any? {
    val payload = value as? JSONObject ?: return value
    return if (payload.optBoolean("skipped")) payload.opt("draft") else value
}

internal fun answerMap(value: Any?): JSONObject {
    val draft = answerDraft(value)
    return draft as? JSONObject ?: JSONObject()
}

internal fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else List(length()) { index -> optString(index) }

internal fun hasAnswer(question: JSONObject, value: Any?): Boolean {
    val draft = answerDraft(value) ?: return false
    if (draft is JSONObject && draft.optBoolean("skipped")) return false
    return when (question.optString("type")) {
        "single_choice" -> answerMap(draft).optString("optionId").isNotEmpty()
        "multi_choice" -> answerMap(draft).optJSONArray("optionIds").strings().isNotEmpty()
        "true_false" -> draft is Boolean
        "fill_blank" -> {
            val values = answerMap(draft).optJSONArray("values").strings()
            val count = question.optInt("blankCount", 1)
            values.size == count && values.all { it.isNotBlank() }
        }
        "short_answer" -> answerMap(draft).optString("text").isNotBlank()
        "ordering" -> {
            val order = answerMap(draft).optJSONArray("order").strings()
            val options = question.optJSONArray("options").strings()
            order.size == options.size && order.toSet().size == options.size &&
                order.all { it.toIntOrNull()?.let { index -> index in options.indices } == true }
        }
        "matching" -> {
            val pairs = answerMap(draft).optJSONObject("pairs") ?: return false
            val options = question.optJSONArray("options").strings()
            options.indices.all { pairs.optString(it.toString()).isNotBlank() }
        }
        "operation" -> {
            val answer = answerMap(draft)
            (answer.optString("kind") == "controls" && (answer.optJSONObject("values")?.length() ?: 0) > 0) ||
                (answer.optString("kind") == "steps" && answer.optJSONArray("steps").strings().isNotEmpty())
        }
        else -> false
    }
}

internal fun isSkippedAnswer(value: Any?): Boolean =
    (value as? JSONObject)?.optBoolean("skipped") == true

internal fun questionTypeLabel(type: String): String = when (type) {
    "single_choice" -> "单选"
    "multi_choice" -> "多选"
    "true_false" -> "判断"
    "fill_blank" -> "填空"
    "short_answer" -> "简答"
    "ordering" -> "排序"
    "matching" -> "配对"
    "operation" -> "操作"
    else -> "练习"
}

/** 把作答渲染成人话；服务端参考答与用户作答复用同一套映射。 */
internal fun answerDescription(value: Any?, question: JSONObject? = null): String {
    if (value == null || value == JSONObject.NULL) return "本题已跳过"
    if (value is Boolean) return if (value) "正确" else "错误"
    val options = question?.optJSONArray("options").strings().orEmpty()
    fun optionLabel(id: String): String = id.toIntOrNull()?.let { options.getOrNull(it) } ?: id
    if (value is JSONObject) {
        if (value.optBoolean("skipped")) return "本题已跳过"
        val data = value.optJSONObject("draft") ?: value
        if (data.has("correct")) return if (data.optBoolean("correct")) "正确" else "错误"
        data.optString("correctOptionId").takeIf(String::isNotEmpty)?.let { return optionLabel(it) }
        data.optJSONArray("correctOptionIds").strings().takeIf(List<String>::isNotEmpty)?.let { ids ->
            return ids.joinToString("、") { optionLabel(it) }
        }
        data.optString("optionId").takeIf(String::isNotEmpty)?.let { return optionLabel(it) }
        data.optJSONArray("optionIds").strings().takeIf(List<String>::isNotEmpty)?.let { ids ->
            return ids.joinToString("、") { optionLabel(it) }
        }
        data.optJSONArray("values").strings().takeIf(List<String>::isNotEmpty)?.let { return it.joinToString(" / ") }
        data.optJSONArray("blanks")?.let { blanks ->
            if (blanks.length() > 0 && blanks.opt(0) is JSONArray) {
                return List(blanks.length()) { index -> blanks.optJSONArray(index).strings().joinToString(" / ") }.joinToString("；")
            }
            blanks.strings().takeIf(List<String>::isNotEmpty)?.let { return it.joinToString(" / ") }
        }
        data.optString("text").takeIf(String::isNotBlank)?.let { return it }
        data.optJSONArray("order").strings().takeIf(List<String>::isNotEmpty)?.let { order ->
            return order.joinToString(" → ") { optionLabel(it) }
        }
        data.optJSONObject("pairs")?.let { pairs ->
            return pairs.keys().asSequence().sortedBy { it.toIntOrNull() ?: 0 }.map { key ->
                "${optionLabel(key)} → ${pairs.optString(key)}"
            }.joinToString("；")
        }
        data.optJSONObject("values")?.let { values ->
            return values.keys().asSequence().sorted().map { "${it}：${values.opt(it)}" }.joinToString("；")
        }
        data.optJSONArray("steps").strings().takeIf(List<String>::isNotEmpty)?.let { return it.joinToString(" → ") }
        data.optJSONObject("target")?.let { target ->
            return target.keys().asSequence().sorted().map { "${it}：${target.opt(it)}" }.joinToString("；")
        }
    }
    return value.toString()
}
