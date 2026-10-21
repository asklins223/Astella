package com.astella.mobile.data

import org.json.JSONObject

data class CompanionNoteTarget(val noteId: String, val noteVersionId: String?, val title: String, val runId: String? = null, val blockOrdinal: Int? = null) {
    val identity get() = "$noteId:${noteVersionId ?: "current"}:${blockOrdinal ?: "body"}"
    companion object {
        fun from(value: JSONObject?, title: String? = null): CompanionNoteTarget? {
            if (value == null || value.optString("kind") !in setOf("note", "created_note", "edited_note")) return null
            val id = value.optNullableString("noteId") ?: return null
            return CompanionNoteTarget(id, value.optNullableString("noteVersionId"), title ?: value.optString("title", if (value.optString("kind") == "edited_note") "修改后的笔记" else "笔记"))
        }
    }
}

data class CompanionProcessNode(
    val id: String, val seq: Int, val label: String, val status: String,
    val summary: String? = null, val occurredAt: String? = null,
    val proposalId: String? = null, val note: CompanionNoteTarget? = null,
) {
    val isRunning get() = status in setOf("requested", "executing")
    val statusLabel get() = when (status) {
        "requested" -> "准备中"
        "executing" -> "进行中"
        "succeeded" -> "已完成"
        "waiting_confirmation" -> "等你确认"
        "outcome_unknown" -> "结果待核对"
        "not_executed" -> "未执行"
        "unavailable" -> "暂不可用"
        "cancelled", "expired" -> "已停止"
        else -> "未完成"
    }
}

/** The server owns execution and recovery. These functions only fold shared events. */
fun projectCompanionProcessEvent(previous: ActiveRun, event: JSONObject): ActiveRun {
    val generation = event.optInt("generation", previous.generation)
    if (generation < previous.generation) return previous
    val newest = event.optLong("seq") >= previous.eventCursor
    val run = previous.copy(eventCursor = maxOf(previous.eventCursor, event.optLong("seq")), generation = generation)
    val payload = event.optJSONObject("payload") ?: return run
    val tool = payload.optJSONObject("tool")
    if (tool != null) {
        val callId = tool.optString("toolCallId").takeIf(String::isNotBlank) ?: return run
        val known = setOf("requested", "executing", "succeeded", "waiting_confirmation", "outcome_unknown", "failed", "blocked", "expired", "not_executed", "unavailable", "cancelled")
        val status = tool.optString("status").takeIf { it in known } ?: "outcome_unknown"
        val id = "tool:$callId"
        val node = CompanionProcessNode(id, event.optInt("seq"), tool.optString("safeLabel", "操作记录"), status,
            tool.optNullableString("safeSummary"), tool.optNullableString("occurredAt"), tool.optNullableString("proposalId"),
            if (status == "succeeded") CompanionNoteTarget.from(tool.optJSONObject("noteCreated") ?: tool.optJSONObject("noteEdit"))?.copy(runId = run.id) else null)
        val old = run.nodes.firstOrNull { it.id == id }
        if (old != null && (old.seq > node.seq || (!old.isRunning && old.status != "waiting_confirmation" && node.isRunning))) return run
        val preparation = tool.optNullableString("preparationToolCallId")?.let { "tool:$it" }
        val nodes = run.nodes.filterNot { it.id == preparation && it.id != id }.toMutableList()
        val index = nodes.indexOfFirst { it.id == id }
        if (index >= 0) nodes[index] = node else nodes.add(node)
        return run.copy(nodes = nodes)
    }
    if (event.optString("type") == "assistant.status") {
        val label = payload.optNullableString("safeLabel") ?: return run
        val id = "status:${event.optInt("seq")}"; if (run.nodes.any { it.id == id }) return run
        return run.copy(nodes = run.nodes + CompanionProcessNode(id, event.optInt("seq"), label, "executing"))
    }
    return when (if (newest) event.optString("type") else "") {
        "turn.accepted" -> run.copy(status = "accepted", errorCode = null, eventCursor = maxOf(run.eventCursor, event.optLong("seq")))
        "turn.completed", "assistant.final" -> run.copy(status = "succeeded")
        "turn.cancelled" -> run.copy(status = "cancelled")
        "error" -> run.copy(status = "failed", errorCode = payload.optNullableString("code"), eventCursor = maxOf(run.eventCursor, event.optLong("seq")))
        else -> run
    }
}

fun mergeCompanionProcessSnapshot(current: List<ActiveRun>, snapshot: JSONObject): List<ActiveRun> {
    val result = current.toMutableList()
    snapshot.optJSONArray("runs").objects().forEach { raw ->
        var run = ActiveRun.from(raw)
        val old = result.firstOrNull { it.id == run.id }
        if (old != null) run = run.copy(
            status = if (run.eventCursor < old.eventCursor || (!old.isActive && run.isActive && run.eventCursor == old.eventCursor)) old.status else run.status,
            errorCode = if (run.eventCursor < old.eventCursor || (!old.isActive && run.isActive && run.eventCursor == old.eventCursor)) old.errorCode else run.errorCode,
            eventCursor = maxOf(old.eventCursor, run.eventCursor),
            thinkingText = run.thinkingText ?: old.thinkingText,
            nodes = old.nodes,
        )
        (raw.optJSONArray("processTimeline").objects() + snapshot.optJSONArray("items").objects().filter { it.optString("runId") == run.id })
            .sortedBy { it.optInt("seq") }.forEach { run = projectCompanionProcessEvent(run, it) }
        val index = result.indexOfFirst { it.id == run.id }
        if (index >= 0) result[index] = run else result.add(run)
    }
    return result
}
