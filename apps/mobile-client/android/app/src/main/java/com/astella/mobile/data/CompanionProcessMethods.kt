package com.astella.mobile.data

import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

fun AppViewModel.showRunInJournal(runId: String) = viewModelScope.launch {
    state.value = state.value.copy(chatShowsRecords = true, journalTargetRunId = runId, journalFollowsLatest = false)
    refreshRuns(listOf(runId), includeThinking = true).join()
    while (state.value.journalTargetRunId == runId && state.value.historyHasMore) {
        coroutineContext.ensureActive()
        val run = state.value.processRuns.firstOrNull { it.id == runId }
        if (state.value.messages.any { it.id == run?.userMessageId || it.runId == runId }) break
        val oldest = state.value.messages.firstOrNull()?.seq
        loadOlderConversationMessages().join()
        if (oldest == state.value.messages.firstOrNull()?.seq) break
    }
}

fun AppViewModel.loadOlderConversationMessages() = viewModelScope.launch {
    val current = state.value
    val id = current.conversationId ?: return@launch
    val oldest = current.messages.firstOrNull()?.seq ?: return@launch
    if (current.historyLoadingOlder) return@launch
    state.value = current.copy(historyLoadingOlder = true)
    try {
        val page = requestApi("/companion/conversations/$id/messages?limit=50&beforeSeq=$oldest")
        if (state.value.profile !== current.profile || state.value.conversationId != id) return@launch
        val incoming = page.optJSONArray("items").objects().map(CompanionMessage::from)
        val ids = state.value.messages.map { it.id }.toSet()
        val merged = (incoming.filterNot { it.id in ids } + state.value.messages).sortedBy { it.seq }
        state.value = state.value.copy(messages = merged, historyHasMore = page.optBoolean("hasMore") && merged.firstOrNull()?.seq != oldest)
        incoming.mapNotNull { it.runId }.distinct().chunked(20).forEach { refreshRuns(it, includeThinking = true).join() }
    } catch (error: Throwable) {
        if (error is CancellationException) throw error
        if (state.value.profile === current.profile) state.value = state.value.copy(processError = pageMessage(error, "更早的手记没有加载出来，可以重试。"))
    } finally {
        if (state.value.profile === current.profile) state.value = state.value.copy(historyLoadingOlder = false)
    }
}

suspend fun AppViewModel.loadResultPreview(target: CompanionNoteTarget): NoteDocument {
    val profile = state.value.profile
    val query = target.noteVersionId?.let { "?noteVersionId=$it" }.orEmpty()
    val value = requestApi("/v2/notes/${target.noteId}$query")
    coroutineContext.ensureActive()
    if (state.value.profile !== profile) throw CancellationException("workspace changed")
    if (target.noteVersionId != null) {
        val requested = value.optJSONObject("requestedVersion")
        check(requested?.optString("versionId") == target.noteVersionId) { "保存时的版本已不可用。原记录仍然保留，不会以最新内容代替。" }
        value.put("currentVersion", requested)
    }
    return NoteDocument.from(value) ?: error("没有取得可阅读的正文，请重试读取。")
}

fun AppViewModel.cancelProcessRun(runId: String) = viewModelScope.launch {
    val run = state.value.processRuns.firstOrNull { it.id == runId && it.generation > 0 } ?: return@launch
    try { requestApi("/companion/runs/$runId/cancel", "POST", org.json.JSONObject().put("version", 1).put("generation", run.generation).put("reason", "user")); refreshRuns() }
    catch (error: Throwable) {
        if (error is CancellationException) throw error
        state.value = state.value.copy(processError = pageMessage(error, "停止请求尚未确认，请重试。"))
    }
}

suspend fun AppViewModel.recoverProcessRun(run: ActiveRun, reconcileOnly: Boolean = false): String {
    val profile = state.value.profile
    val conversation = state.value.conversationId
    return try {
        val result = requestApi("/companion/runs/${run.id}/resume", "POST", org.json.JSONObject()
            .put("version", 1).put("generation", run.generation).put("expectedEventCursor", run.eventCursor).put("reconcileOnly", reconcileOnly)) as? org.json.JSONObject
        if (state.value.profile !== profile || state.value.conversationId != conversation) return "记录已更新。"
        refreshRuns(listOf(run.id), includeThinking = true).join()
        if (!reconcileOnly) { showRunInJournal(run.id); "正在从中断处继续，已保存的成果仍然保留。" }
        else if ((result?.optInt("unresolvedCount") ?: 0) > 0) "仍有操作无法取得确定回执，未重新执行。"
        else "保存结果已核对，可直接预览。"
    } catch (error: Throwable) {
        if (error is CancellationException) throw error
        pageMessage(error, "请求未确认，原记录和成果仍保留，请重试。")
    }
}
