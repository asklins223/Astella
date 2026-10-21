package com.astella.mobile.data

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class StartupLoadState { Idle, Loading, Ready, Failed }

data class AppUiState(
    val profile: UserProfile? = null,
    val chatShowsRecords: Boolean = false,
    val readingScale: Float = 1f,
    val localReduceMotion: Boolean = false,
    val conversationId: String? = null,
    val messages: List<CompanionMessage> = emptyList(),
    val notes: List<NoteSummary> = emptyList(),
    val notesNextCursor: String? = null,
    val isLoadingMoreNotes: Boolean = false,
    val noteDocument: NoteDocument? = null,
    val noteAnnotations: List<NoteAnnotation> = emptyList(),
    val isAnnotationBusy: Boolean = false,
    val annotationStatus: String? = null,
    val annotationError: String? = null,
    val pendingNoteContext: PendingNoteContext? = null,
    val pendingDiaryReference: PendingDiaryReference? = null,
    val processRuns: List<ActiveRun> = emptyList(),
    val processError: String? = null,
    val historyHasMore: Boolean = false,
    val historyLoadingOlder: Boolean = false,
    val journalFollowsLatest: Boolean = true,
    val journalTargetRunId: String? = null,
    val journalCollapsed: Set<String> = emptySet(),
    val orbitSectionRequest: String? = null,
    val composerFocusRequest: Int = 0,
    val diaryCaptureRequest: Int = 0,
    val resultPreview: CompanionNoteTarget? = null,
    val resultReturnTo: CompanionNoteTarget? = null,
    val workspaces: List<WorkspaceSummary> = emptyList(),
    val aiSettings: AISettings? = null,
    val companionPermissionLevel: String? = null,
    val streamingText: String = "",
    val streamingRunId: String? = null,
    val selectionRunId: String? = null,
    val realtimeStatus: String = "尚未连接",
    val isLoading: Boolean = false,
    val startupLoadState: StartupLoadState = StartupLoadState.Idle,
    val isSending: Boolean = false,
    val isRecording: Boolean = false,
    val isTranscribing: Boolean = false,
    val error: String? = null,
    val notesError: String? = null,
    val noteError: String? = null,
    val accountError: String? = null,
    val accountNotice: String? = null,
    val isAccountBusy: Boolean = false,
    val authError: String? = null,
    val authNotice: String? = null,
    val companionModel: com.astella.mobile.companion.CachedCompanionModel? = null,
    val draft: String = "",
    val selectedFile: CompanionFile? = null,
    val attachmentRevision: String = "",
    val audioLevel: Float = 0f,
    val isPlaying: Boolean = false,
    val isPaused: Boolean = false,
    val isVoiceLoading: Boolean = false,
    val selectedImage: Uri? = null,
    val voiceTranscript: String = "",
    val serviceAddress: String = "",
) {
    val isAuthenticated get() = profile != null
    val runs get() = processRuns.filter(ActiveRun::isActive)
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val api = MobileApi(application)
    private val devicePreferences = application.getSharedPreferences("astella.device-preferences", Application.MODE_PRIVATE)
    private val recorder = VoiceRecorder()
    private val _state = kotlinx.coroutines.flow.MutableStateFlow(
        AppUiState(serviceAddress = api.baseUrl, startupLoadState = if (api.token != null) StartupLoadState.Loading else StartupLoadState.Idle),
    )
    val state = _state
    private var realtime: CompanionRealtime? = null
    private var voiceArtifactId: String? = null
    private var notesQuery = ""
    private var notesRequestGeneration = 0
    private var activeNoteId: String? = null
    private var noteRequestGeneration = 0
    private var annotationRequestGeneration = 0
    private var annotationOperationGeneration = 0
    private val awarenessLaunchId = UUID.randomUUID().toString()
    private var lastInteraction = android.os.SystemClock.elapsedRealtime()
    private var lastObservation = android.os.SystemClock.elapsedRealtime()
    private var pendingTurnSignature: String? = null
    private var pendingTurnRequest: JSONObject? = null
    private var minimumStreamingGeneration = 0
    private var voiceJob: kotlinx.coroutines.Job? = null
    private var audioPlayer: android.media.MediaPlayer? = null
    private var audioFile: java.io.File? = null
    private var meterJob: kotlinx.coroutines.Job? = null
    private var intakeGeneration = 0
    private var processRequestGeneration = 0
    private var journalScope: String? = null
    private var journalReading = Triple<String?, Int, Int>(null, 0, 0)
    private val previewOffsets = mutableMapOf<String, Int>()

    fun hasStoredSession(): Boolean = api.token != null

    fun setResultPreview(target: CompanionNoteTarget?) { _state.value = _state.value.copy(resultPreview = target) }
    fun openResultPage(target: CompanionNoteTarget) { _state.value = _state.value.copy(resultPreview = null, resultReturnTo = target) }
    fun returnToResultJournal() {
        val target = _state.value.resultReturnTo ?: return
        _state.value = _state.value.copy(chatShowsRecords = true, resultReturnTo = null, resultPreview = target)
    }
    fun toggleProcessDisclosure(runId: String) {
        val collapsed = _state.value.journalCollapsed
        _state.value = _state.value.copy(journalCollapsed = if (runId in collapsed) collapsed - runId else collapsed + runId)
    }
    fun saveJournalReading(key: String?, index: Int, offset: Int, follows: Boolean) {
        journalScope = "${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}"
        journalReading = Triple(key, index, offset)
        if (_state.value.journalFollowsLatest != follows) _state.value = _state.value.copy(journalFollowsLatest = follows)
    }
    fun journalReadingPosition(): Triple<String?, Int, Int> = if (journalScope == "${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}") journalReading else Triple(null, 0, 0)
    fun previewOffset(target: CompanionNoteTarget): Int = previewOffsets["${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:${target.identity}"] ?: 0
    fun hasPreviewOffset(target: CompanionNoteTarget): Boolean = previewOffsets.containsKey("${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:${target.identity}")
    fun savePreviewOffset(target: CompanionNoteTarget, offset: Int) { previewOffsets["${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:${target.identity}"] = offset }
    fun contentPreviewOffset(identity: String): Int = previewOffsets["${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:content:$identity"] ?: 0
    fun hasContentPreviewOffset(identity: String): Boolean = previewOffsets.containsKey("${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:content:$identity")
    fun saveContentPreviewOffset(identity: String, offset: Int) { previewOffsets["${_state.value.profile?.userId}:${_state.value.profile?.workspaceId}:content:$identity"] = offset }

    suspend fun requestApi(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) { api.request(path, method, body) }

    suspend fun requestApiArray(path: String, method: String = "GET", body: JSONObject? = null): JSONArray =
        withContext(Dispatchers.IO) { api.requestArray(path, method, body) }

    init {
        if (api.token != null) restoreSession()
    }

    fun login(email: String, password: String) = viewModelScope.launch {
        patch(isLoading = true, error = null, authError = null, authNotice = null)
        try {
            val result = withContext(Dispatchers.IO) {
                api.request("/auth/login", "POST", JSONObject()
                    .put("email", normalizeEmail(email)).put("password", password)
                    .put("clientKind", "mobile").put("remember", true))
            }
            acceptSession(result)
        } catch (error: Throwable) {
            patch(isLoading = false, authError = authMessage(error, "请检查邮箱和密码后重试。"))
        }
    }

    fun sendEmailCode(email: String, purpose: String, onSent: (Int) -> Unit) = viewModelScope.launch {
        patch(isLoading = true, authError = null, authNotice = null)
        try {
            val result = withContext(Dispatchers.IO) {
                api.request("/auth/email-code", "POST", JSONObject()
                    .put("email", normalizeEmail(email)).put("purpose", purpose))
            }
            val seconds = result.optInt("resendInSeconds", 60).coerceAtLeast(1)
            patch(isLoading = false, authError = null,
                authNotice = "验证码已发送至 ${normalizeEmail(email)}，5 分钟内有效。没收到时可以看看垃圾邮件。")
            onSent(seconds)
        } catch (error: Throwable) {
            patch(isLoading = false, authError = authMessage(error, "验证码发送失败，请稍后重试。"))
        }
    }

    fun registerAccount(email: String, password: String, displayName: String, inviteToken: String, code: String) = viewModelScope.launch {
        patch(isLoading = true, authError = null, authNotice = null)
        try {
            val body = JSONObject()
                .put("email", normalizeEmail(email))
                .put("password", password)
                .put("emailCode", code)
                .put("clientKind", "mobile")
            displayName.trim().takeIf(String::isNotEmpty)?.let { body.put("displayName", it) }
            inviteToken.trim().takeIf(String::isNotEmpty)?.let { body.put("inviteToken", it) }
            val result = withContext(Dispatchers.IO) { api.request("/auth/register-v2", "POST", body) }
            acceptSession(result)
        } catch (error: Throwable) {
            patch(isLoading = false, authError = authMessage(error, "账号创建没有完成，请检查填写内容后重试。"))
        }
    }

    fun loginWithEmailCode(email: String, code: String) = viewModelScope.launch {
        patch(isLoading = true, authError = null, authNotice = null)
        try {
            val result = withContext(Dispatchers.IO) {
                api.request("/auth/login-with-code", "POST", JSONObject()
                    .put("email", normalizeEmail(email)).put("code", code)
                    .put("clientKind", "mobile").put("remember", true))
            }
            acceptSession(result)
        } catch (error: Throwable) {
            patch(isLoading = false, authError = authMessage(error, "验证码登录没有完成，请核对验证码后重试。"))
        }
    }

    fun resetPassword(email: String, code: String, newPassword: String, onSuccess: () -> Unit) = viewModelScope.launch {
        patch(isLoading = true, authError = null, authNotice = null)
        try {
            withContext(Dispatchers.IO) {
                api.request("/auth/reset-password", "POST", JSONObject()
                    .put("email", normalizeEmail(email)).put("code", code).put("newPassword", newPassword))
            }
            patch(isLoading = false, authError = null, authNotice = "密码已更新，请用新密码登录。")
            onSuccess()
        } catch (error: Throwable) {
            patch(isLoading = false, authError = authMessage(error, "密码重置没有完成，请检查验证码后重试。"))
        }
    }

    fun clearAuthFeedback() = patch(authError = null, authNotice = null)

    fun clearAuthError() = patch(authError = null)

    private suspend fun acceptSession(result: JSONObject) {
        val token = result.optString("token").takeIf(String::isNotBlank)
            ?: error("登录响应缺少有效凭据。")
        api.token = token
        TokenStore.save(getApplication(), token)
        patch(isLoading = false)
        restoreSession()
    }

    private fun normalizeEmail(email: String) = email.trim().lowercase()

    private fun authMessage(error: Throwable, fallback: String): String {
        val apiFailure = error as? ApiFailure ?: return when (error) {
            is java.io.IOException -> "暂时连接不上书房，请检查网络或服务地址后重试。"
            else -> fallback
        }
        val message = apiFailure.message.trim()
        return when {
            apiFailure.code == "invalid_credentials" -> "邮箱或密码不正确，请检查后重试。"
            apiFailure.code == "invalid_code" -> "验证码不正确，请核对邮件中的 6 位数字。"
            apiFailure.code == "expired_code" -> "验证码已过期，请重新发送。"
            apiFailure.code == "code_attempts_exhausted" -> "尝试次数已用完，请重新发送验证码。"
            apiFailure.code == "email_exists" -> "这个邮箱已经注册，请直接登录。"
            apiFailure.code in setOf("email_channel_unavailable", "email_send_failed") ->
                message.takeUnless(::isGenericAuthMessage) ?: fallback
            apiFailure.code in setOf("rate_limited", "resend_too_soon", "daily_limit_reached") ->
                message.takeUnless(::isGenericAuthMessage) ?: "操作太频繁了，请稍后再试。"
            apiFailure.status == 0 -> "暂时连接不上书房，请检查网络或服务地址后重试。"
            apiFailure.status == 401 -> fallback
            isGenericAuthMessage(message) -> fallback
            else -> message.ifBlank { fallback }
        }
    }

    private fun isGenericAuthMessage(message: String): Boolean = message.trim().lowercase() in setOf(
        "请求错误", "请求失败", "请求没有完成，请稍后重试。", "request failed", "internal server error",
    )

    internal fun pageMessage(error: Throwable, fallback: String): String {
        val apiFailure = error as? ApiFailure
        if (apiFailure != null) return when {
            apiFailure.status == 0 -> "暂时连接不上书房，请检查网络或服务地址后重试。"
            apiFailure.status == 401 -> "登录状态已过期，请重新登录。"
            apiFailure.status == 403 -> "当前账号没有权限查看这项内容。"
            apiFailure.status >= 500 -> "服务暂时忙不过来，请稍后重试。"
            else -> apiFailure.message.trim().takeUnless(::isGenericAuthMessage) ?: fallback
        }
        if (error is java.io.IOException) return "暂时连接不上书房，请检查网络或服务地址后重试。"
        return error.message?.trim()?.takeUnless { it.isEmpty() || isGenericAuthMessage(it) } ?: fallback
    }

    fun restoreSession() = viewModelScope.launch {
        val arriving = _state.value.profile == null
        if (arriving) _state.value = _state.value.copy(startupLoadState = StartupLoadState.Loading)
        patch(isLoading = true, error = null)
        try {
            val me = withContext(Dispatchers.IO) { api.request("/auth/me") }
            val profile = UserProfile.from(me)
            viewModelScope.launch {
                val model = withContext(Dispatchers.IO) { com.astella.mobile.companion.CompanionModelCache(getApplication(), api).load() }
                if (_state.value.profile?.userId == profile.userId) _state.value = _state.value.copy(companionModel = model)
            }
            val key = profile.userId
            _state.value = _state.value.copy(
                profile = profile,
                chatShowsRecords = devicePreferences.getBoolean(devicePreferenceKey(key, "showRecords"), false),
                readingScale = devicePreferences.getFloat(devicePreferenceKey(key, "readingScale"), 1f).coerceIn(1f, 1.4f),
                localReduceMotion = devicePreferences.getBoolean(devicePreferenceKey(key, "reduceMotion"), false),
                isLoading = false,
            )
            val conversation = loadConversation()
            val notes = loadNotes("")
            conversation.join()
            notes.join()
            if (arriving && _state.value.profile?.userId == profile.userId) {
                _state.value = _state.value.copy(startupLoadState = StartupLoadState.Ready)
            }
        } catch (error: Throwable) {
            if ((error as? ApiFailure)?.status == 401) logout()
            else {
                patch(isLoading = false, error = pageMessage(error, "暂时接不上你的书房，请检查网络后重试。"))
                if (arriving) _state.value = _state.value.copy(startupLoadState = StartupLoadState.Failed)
            }
        }
    }

    fun loadConversation() = viewModelScope.launch {
        patch(error = null)
        try {
            val inbox = withContext(Dispatchers.IO) { api.request("/companion/inbox/ensure", "POST", JSONObject()) }
            val id = inbox.optString("id").takeIf(String::isNotBlank) ?: error("没有找到伴星对话。")
            _state.value = _state.value.copy(conversationId = id)
            val messages = refreshMessages()
            val runs = refreshRuns()
            messages.join()
            runs.join()
            val snapshot = withContext(Dispatchers.IO) {
                api.request("/companion/conversations/$id/run-nodes?after=0")
            }
            val cursor = snapshot.optInt("latestSeq")
            realtime?.stop()
            realtime = CompanionRealtime(api, ::consumeEvent) { status ->
                viewModelScope.launch { _state.value = _state.value.copy(realtimeStatus = status) }
            }.also { it.start(id, cursor) }
        } catch (error: Throwable) {
            patch(error = pageMessage(error, "伴星暂时没有接回来，请检查连接后重试。"))
        }
    }

    fun refreshMessages() = viewModelScope.launch {
        val id = _state.value.conversationId ?: return@launch
        val session = api.token
        runCatching {
            withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/messages?limit=50") }
        }.onSuccess { page ->
            if (api.token != session || _state.value.conversationId != id) return@onSuccess
            val messages = page.optJSONArray("items").objects().map(CompanionMessage::from).sortedBy(CompanionMessage::seq)
            val ids = messages.map { it.id }.toSet()
            val older = _state.value.messages.filter { it.id !in ids }
            _state.value = _state.value.copy(messages = (older + messages).sortedBy { it.seq },
                historyHasMore = if (older.isEmpty()) page.optBoolean("hasMore") else _state.value.historyHasMore)
        }.onFailure { patch(error = pageMessage(it, "对话记录暂时无法读取，请重新连接后重试。")) }
    }

    fun refreshRuns(runIds: List<String> = emptyList(), includeThinking: Boolean = false) = viewModelScope.launch {
        val id = _state.value.conversationId ?: return@launch
        val session = api.token; val requestGeneration = ++processRequestGeneration
        val query = (if (includeThinking) "&includeThinking=true" else "") + if (runIds.isNotEmpty()) "&runIds=${runIds.joinToString(",")}" else ""
        runCatching { withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/run-nodes?after=0$query") } }
            .onSuccess { snapshot ->
                if (api.token != session || _state.value.conversationId != id || requestGeneration != processRequestGeneration) return@onSuccess
                _state.value = _state.value.copy(processRuns = mergeCompanionProcessSnapshot(_state.value.processRuns, snapshot), processError = null)
            }.onFailure { if (api.token == session && _state.value.conversationId == id) _state.value = _state.value.copy(processError = pageMessage(it, "过程记录暂时无法读取，已有成果仍然保留。")) }
    }

    fun loadNotes(query: String) = viewModelScope.launch {
        val normalized = query.trim()
        notesRequestGeneration += 1
        val requestGeneration = notesRequestGeneration
        notesQuery = normalized
        _state.value = _state.value.copy(isLoading = true, isLoadingMoreNotes = false, notesError = null)
        try {
            val path = if (normalized.isEmpty()) "/notes?limit=30" else
                "/search?q=${java.net.URLEncoder.encode(normalized, "UTF-8")}&type=note&limit=30"
            val page = withContext(Dispatchers.IO) { api.request(path) }
            val notes = page.optJSONArray("items").objects().map(NoteSummary::from)
            if (notesQuery == normalized && requestGeneration == notesRequestGeneration) {
                _state.value = _state.value.copy(
                    notes = notes,
                    notesNextCursor = page.optNullableString("nextCursor"),
                    isLoading = false,
                    isLoadingMoreNotes = false,
                    notesError = null,
                )
            }
        } catch (error: Throwable) {
            if (notesQuery == normalized && requestGeneration == notesRequestGeneration) {
                _state.value = _state.value.copy(isLoading = false, notesError = pageMessage(error, "手记暂时无法读取，请检查连接后重新加载。"))
            }
        }
    }

    fun loadMoreNotes(query: String) = viewModelScope.launch {
        val normalized = query.trim()
        val current = _state.value
        val cursor = current.notesNextCursor ?: return@launch
        if (current.isLoading || current.isLoadingMoreNotes || normalized != notesQuery) return@launch
        val requestGeneration = notesRequestGeneration
        _state.value = current.copy(isLoadingMoreNotes = true, notesError = null)
        try {
            val queryParams = buildList {
                add("limit=30")
                add("cursor=${java.net.URLEncoder.encode(cursor, "UTF-8")}")
                if (normalized.isNotEmpty()) {
                    add("q=${java.net.URLEncoder.encode(normalized, "UTF-8")}")
                    add("type=note")
                }
            }.joinToString("&")
            val path = (if (normalized.isEmpty()) "/notes" else "/search") + "?$queryParams"
            val page = withContext(Dispatchers.IO) { api.request(path) }
            if (notesQuery != normalized || requestGeneration != notesRequestGeneration || _state.value.notesNextCursor != cursor) return@launch
            val seen = _state.value.notes.mapTo(mutableSetOf()) { it.id }
            val nextNotes = page.optJSONArray("items").objects().map(NoteSummary::from).filter { seen.add(it.id) }
            _state.value = _state.value.copy(
                notes = _state.value.notes + nextNotes,
                notesNextCursor = page.optNullableString("nextCursor"),
                isLoadingMoreNotes = false,
            )
        } catch (error: Throwable) {
            if (notesQuery == normalized && requestGeneration == notesRequestGeneration) _state.value = _state.value.copy(
                isLoadingMoreNotes = false,
                notesError = pageMessage(error, "下一页手记没有加载出来，请稍后重试。"),
            )
        }
    }

    fun loadNote(noteId: String) = viewModelScope.launch {
        noteRequestGeneration += 1
        val requestGeneration = noteRequestGeneration
        activeNoteId = noteId
        annotationRequestGeneration += 1
        annotationOperationGeneration += 1
        _state.value = _state.value.copy(
            noteDocument = null,
            noteAnnotations = emptyList(),
            noteError = null,
            annotationError = null,
            annotationStatus = null,
            isAnnotationBusy = false,
        )
        try {
            val value = withContext(Dispatchers.IO) { api.request("/v2/notes/$noteId") }
            if (requestGeneration != noteRequestGeneration || activeNoteId != noteId) return@launch
            val document = NoteDocument.from(value) ?: error("手记没有返回可阅读的版本内容。")
            _state.value = _state.value.copy(noteDocument = document)
            refreshNoteAnnotations(noteId, requestGeneration)
        } catch (error: Throwable) {
            if (requestGeneration == noteRequestGeneration && activeNoteId == noteId) {
                _state.value = _state.value.copy(noteError = pageMessage(error, "这篇手记暂时无法打开，请检查连接后重新加载。"))
            }
        }
    }

    private suspend fun refreshNoteAnnotations(noteId: String, noteGeneration: Int? = null) {
        if (activeNoteId != noteId || _state.value.noteDocument?.id != noteId) return
        val requestGeneration = ++annotationRequestGeneration
        try {
            val page = withContext(Dispatchers.IO) { api.request("/v2/notes/$noteId/annotations") }
            val annotations = page.optJSONArray("items").objects().mapNotNull(NoteAnnotation::from)
            if (requestGeneration != annotationRequestGeneration || activeNoteId != noteId ||
                _state.value.noteDocument?.id != noteId || (noteGeneration != null && noteGeneration != noteRequestGeneration)) return
            _state.value = _state.value.copy(noteAnnotations = annotations, annotationError = null)
        } catch (error: Throwable) {
            if (requestGeneration == annotationRequestGeneration && activeNoteId == noteId &&
                _state.value.noteDocument?.id == noteId && (noteGeneration == null || noteGeneration == noteRequestGeneration)) {
                _state.value = _state.value.copy(annotationError = error.message ?: "批注暂时没有读取出来。")
            }
        }
    }

    fun retryNoteAnnotations(noteId: String) = viewModelScope.launch { refreshNoteAnnotations(noteId) }

    fun clearAnnotationNotice() {
        _state.value = _state.value.copy(annotationError = null, annotationStatus = null)
    }

    fun reportAnnotationError(message: String) {
        _state.value = _state.value.copy(annotationError = message, annotationStatus = null)
    }

    fun saveNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor, explanation: String) = viewModelScope.launch {
        if (!isCurrentNote(noteId)) return@launch
        val operationGeneration = ++annotationOperationGeneration
        _state.value = _state.value.copy(isAnnotationBusy = true, annotationError = null, annotationStatus = null)
        try {
            withContext(Dispatchers.IO) {
                api.request("/v2/notes/$noteId/annotations", "POST", JSONObject()
                    .put("anchor", anchor.toJson()).put("explanation", explanation.trim()))
            }
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            refreshNoteAnnotations(noteId)
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            _state.value = _state.value.copy(annotationStatus = "已把这条批注留在原文旁。", isAnnotationBusy = false)
        } catch (error: Throwable) {
            if (isCurrentNoteOperation(noteId, operationGeneration)) {
                _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = error.message ?: "批注没有保存，请重试。")
            }
        }
    }

    fun updateNoteAnnotation(noteId: String, annotation: NoteAnnotation, explanation: String) = viewModelScope.launch {
        if (!isCurrentNote(noteId)) return@launch
        val operationGeneration = ++annotationOperationGeneration
        _state.value = _state.value.copy(isAnnotationBusy = true, annotationError = null, annotationStatus = null)
        try {
            withContext(Dispatchers.IO) {
                api.request("/v2/notes/$noteId/annotations/${annotation.id}", "PATCH", JSONObject()
                    .put("expectedRevision", annotation.revision).put("explanation", explanation.trim()))
            }
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            refreshNoteAnnotations(noteId)
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            _state.value = _state.value.copy(annotationStatus = "批注已更新。", isAnnotationBusy = false)
        } catch (error: Throwable) {
            if (isCurrentNoteOperation(noteId, operationGeneration)) {
                _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = error.message ?: "批注没有更新，请重新读取后再试。")
            }
        }
    }

    fun explainNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor) = viewModelScope.launch {
        if (!isCurrentNote(noteId)) return@launch
        val operationGeneration = ++annotationOperationGeneration
        _state.value = _state.value.copy(isAnnotationBusy = true, annotationError = null, annotationStatus = "伴星正在读这段原文…")
        try {
            val created = withContext(Dispatchers.IO) {
                api.request("/v2/notes/$noteId/annotation-tasks", "POST", JSONObject()
                    .put("anchor", anchor.toJson()).put("requestId", UUID.randomUUID().toString()))
            }
            val taskId = created.optString("taskId").takeIf(String::isNotBlank) ?: error("讲解任务没有返回编号。")
            repeat(80) {
                if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
                delay(1_500)
                val task = withContext(Dispatchers.IO) { api.request("/v2/notes/$noteId/annotation-tasks/$taskId") }
                if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
                when (task.optString("status")) {
                    "ready" -> {
                        refreshNoteAnnotations(noteId)
                        if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
                        _state.value = _state.value.copy(isAnnotationBusy = false, annotationStatus = "伴星已经把讲解贴回这段原文。")
                        return@launch
                    }
                    "failed" -> {
                        val reason = when (task.optString("failureReason")) {
                            "ai_consent_required" -> "请先到账户页签署 AI 使用协议。"
                            "ai_data_policy_denied" -> "账户暂未允许此类 AI 处理，请先检查数据偏好。"
                            "generation_incomplete" -> "这次讲解没有完成，原文还在，可以再试一次。"
                            else -> "讲解暂时没有生成，原文还在，可以再试一次。"
                        }
                        _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = reason, annotationStatus = null)
                        return@launch
                    }
                }
            }
            if (isCurrentNoteOperation(noteId, operationGeneration)) {
                _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = "讲解还在后台整理，稍后重新打开这篇手记查看。", annotationStatus = null)
            }
        } catch (error: Throwable) {
            if (isCurrentNoteOperation(noteId, operationGeneration)) {
                _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = error.message ?: "讲解没有开始。", annotationStatus = null)
            }
        }
    }

    fun removeNoteAnnotation(noteId: String, annotation: NoteAnnotation) = viewModelScope.launch {
        if (!isCurrentNote(noteId)) return@launch
        val operationGeneration = ++annotationOperationGeneration
        _state.value = _state.value.copy(isAnnotationBusy = true, annotationError = null, annotationStatus = null)
        try {
            val result = withContext(Dispatchers.IO) {
                api.request("/v2/notes/$noteId/annotations/${annotation.id}", "DELETE", JSONObject().put("expectedRevision", annotation.revision))
            }
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            refreshNoteAnnotations(noteId)
            if (!isCurrentNoteOperation(noteId, operationGeneration)) return@launch
            val artifacts = result.optInt("removedArtifacts")
            _state.value = _state.value.copy(
                isAnnotationBusy = false,
                annotationStatus = if (artifacts > 0) "批注已撤下，连带移除了 $artifacts 条讲解。" else "批注已撤下。",
            )
        } catch (error: Throwable) {
            if (isCurrentNoteOperation(noteId, operationGeneration)) {
                _state.value = _state.value.copy(isAnnotationBusy = false, annotationError = error.message ?: "批注没有撤下。请刷新后再试。")
            }
        }
    }

    private fun isCurrentNote(noteId: String): Boolean =
        activeNoteId == noteId && _state.value.noteDocument?.id == noteId

    private fun isCurrentNoteOperation(noteId: String, generation: Int): Boolean =
        generation == annotationOperationGeneration && isCurrentNote(noteId)

    fun continueWithNote(document: NoteDocument) {
        if (document.versionId.isBlank()) {
            _state.value = _state.value.copy(accountError = "没有取得这篇手记的版本信息，请重新打开后再试。")
            return
        }
        _state.value = _state.value.copy(
            pendingNoteContext = PendingNoteContext(document.id, document.versionId, document.title),
            accountError = null,
        )
    }

    fun clearPendingNoteContext() {
        _state.value = _state.value.copy(pendingNoteContext = null)
    }

    suspend fun exportWorkspaceBackup(fileName: String = "书房备份"): java.io.File {
        val payload = requestApi("/export/workspace")
        val safeName = (_state.value.profile?.workspaceName ?: "Astella").replace(Regex("[/:]"), "-")
        val directory = java.io.File(getApplication<Application>().cacheDir, "exports").apply { mkdirs() }
        val file = java.io.File(directory, "$safeName-$fileName.json")
        withContext(Dispatchers.IO) { file.writeText(payload.toString(2)) }
        return file
    }

    fun continueWithDiary(date: String, version: Int) {
        if (version <= 0) return
        _state.value = _state.value.copy(
            pendingNoteContext = null,
            pendingDiaryReference = PendingDiaryReference(date, version),
            accountError = null,
        )
    }

    fun clearPendingDiaryReference() {
        _state.value = _state.value.copy(pendingDiaryReference = null)
    }

    fun setChatShowsRecords(value: Boolean) {
        _state.value.profile?.userId?.takeIf(String::isNotBlank)?.let {
            devicePreferences.edit().putBoolean(devicePreferenceKey(it, "showRecords"), value).apply()
        }
        _state.value = _state.value.copy(chatShowsRecords = value)
        if (value) refreshRuns(includeThinking = true)
    }

    fun setReadingScale(value: Float) {
        if (value !in listOf(1f, 1.2f, 1.4f)) return
        _state.value.profile?.userId?.takeIf(String::isNotBlank)?.let {
            devicePreferences.edit().putFloat(devicePreferenceKey(it, "readingScale"), value).apply()
        }
        _state.value = _state.value.copy(readingScale = value)
    }

    fun recentNoteId(): String? {
        val profile = _state.value.profile ?: return null
        return devicePreferences.getString(notePreferenceKey(profile.userId, profile.workspaceId, "recent"), null)
    }

    fun recordNoteOpened(noteId: String) {
        val profile = _state.value.profile ?: return
        devicePreferences.edit()
            .putString(notePreferenceKey(profile.userId, profile.workspaceId, "recent"), noteId)
            .apply()
    }

    fun savedNoteReadingBlock(noteId: String): Int? {
        val profile = _state.value.profile ?: return null
        val key = notePreferenceKey(profile.userId, profile.workspaceId, "block.$noteId")
        return devicePreferences.getInt(key, -1).takeIf { it >= 0 }
    }

    fun saveNoteReadingBlock(noteId: String, ordinal: Int) {
        val profile = _state.value.profile ?: return
        if (ordinal < 0) return
        devicePreferences.edit()
            .putInt(notePreferenceKey(profile.userId, profile.workspaceId, "block.$noteId"), ordinal)
            .apply()
    }

    fun setLocalReduceMotion(value: Boolean) {
        _state.value.profile?.userId?.takeIf(String::isNotBlank)?.let {
            devicePreferences.edit().putBoolean(devicePreferenceKey(it, "reduceMotion"), value).apply()
        }
        _state.value = _state.value.copy(localReduceMotion = value)
    }

    fun loadAccountSettings() = viewModelScope.launch {
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null)
        try {
            val workspaces = withContext(Dispatchers.IO) {
                api.request("/auth/workspaces").optJSONArray("workspaces").objects().map(WorkspaceSummary::from)
            }
            val settings = withContext(Dispatchers.IO) { AISettings.from(api.request("/me/ai-settings")) }
            val companion = withContext(Dispatchers.IO) { api.request("/me/companion") }
            val account = companion.optJSONObject("account") ?: companion
            val permissionLevel = account.optJSONObject("agentSettings")?.optString("permissionLevel")
                ?.takeIf(String::isNotBlank)
            _state.value = _state.value.copy(
                workspaces = workspaces,
                aiSettings = settings,
                companionPermissionLevel = permissionLevel,
                isAccountBusy = false,
            )
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "账户设置暂时无法读取，请稍后重新加载。"))
        }
    }

    fun markAiConsentRequired() {
        val settings = _state.value.aiSettings
        if (settings == null) {
            loadAccountSettings()
        } else if (!settings.requiresConsent) {
            _state.value = _state.value.copy(aiSettings = settings.copy(requiresConsent = true))
        }
    }

    fun saveProfile(displayName: String) = viewModelScope.launch {
        val normalized = displayName.trim()
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null, accountNotice = null)
        try {
            withContext(Dispatchers.IO) {
                api.request("/auth/profile", "PUT", JSONObject().put("displayName", normalized.takeIf(String::isNotEmpty) ?: JSONObject.NULL))
            }
            val profile = _state.value.profile?.copy(displayName = normalized)
            _state.value = _state.value.copy(
                profile = profile,
                isAccountBusy = false,
                accountNotice = if (normalized.isEmpty()) "已清除称呼，账户将显示邮箱前缀。" else "称呼已保存。",
            )
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "昵称没有保存，请检查连接后重试。"))
        }
    }

    fun saveAvatar(uri: Uri) = viewModelScope.launch {
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null, accountNotice = null)
        try {
            val upload = withContext(Dispatchers.IO) { api.uploadAvatar(uri) }
            val avatarUrl = upload.optString("url").takeIf(String::isNotBlank) ?: error("服务端没有返回头像地址。")
            val profile = _state.value.profile?.copy(avatarUrl = avatarUrl)
            _state.value = _state.value.copy(profile = profile, isAccountBusy = false, accountNotice = "头像已更新。")
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "头像没有更新，请检查连接后重试。"))
        }
    }

    fun switchWorkspace(workspace: WorkspaceSummary) = viewModelScope.launch {
        if (workspace.id == _state.value.profile?.workspaceId) return@launch
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null, accountNotice = null)
        try {
            val result = withContext(Dispatchers.IO) {
                api.request("/auth/switch-workspace", "POST", JSONObject().put("workspaceId", workspace.id))
            }
            val token = result.optString("token").takeIf(String::isNotBlank) ?: error("切换书房后没有收到新的登录凭据。")
            TokenStore.save(getApplication(), token)
            api.token = token
            realtime?.stop()
            realtime = null
            _state.value = AppUiState(serviceAddress = api.baseUrl, isLoading = true)
            restoreSession().join()
            loadAccountSettings().join()
            _state.value = _state.value.copy(accountNotice = "已切换到「${workspace.name}」。")
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "书房没有切换，请重试。"))
        }
    }

    fun saveAIDataPolicy(policy: AIDataPolicy) = viewModelScope.launch {
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null, accountNotice = null)
        try {
            withContext(Dispatchers.IO) { api.request("/me/ai-data-policy", "PUT", policy.toJson()) }
            val settings = _state.value.aiSettings?.copy(dataPolicy = policy)
            _state.value = _state.value.copy(aiSettings = settings, isAccountBusy = false, accountNotice = "数据使用偏好已保存。")
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "数据偏好没有保存，请重试。"))
        }
    }

    fun acceptAIConsent() = viewModelScope.launch {
        if (_state.value.aiSettings?.needsSigning != true) {
            _state.value = _state.value.copy(accountError = "当前没有可确认的授权版本。")
            return@launch
        }
        _state.value = _state.value.copy(isAccountBusy = true, accountError = null, accountNotice = null)
        try {
            withContext(Dispatchers.IO) {
                api.request("/me/ai-consent", "PUT", JSONObject().put("consentVersion", AI_CONSENT_VERSION))
            }
            val settings = _state.value.aiSettings?.let { current ->
                current.copy(
                    consentVersion = AI_CONSENT_VERSION,
                    consentAt = java.time.Instant.now().toString(),
                    dataPolicy = current.dataPolicy.copy(sendToExternal = true),
                )
            }
            _state.value = _state.value.copy(aiSettings = settings, isAccountBusy = false, accountNotice = "AI 使用授权已确认。")
        } catch (error: Throwable) {
            _state.value = _state.value.copy(isAccountBusy = false, accountError = pageMessage(error, "授权没有保存，请检查连接后重试。"))
        }
    }

    fun selectDroppedImage(uri: Uri) = viewModelScope.launch {
        try {
            val local = withContext(Dispatchers.IO) {
                val target = java.io.File.createTempFile("dropped-image-", ".jpg", getApplication<Application>().cacheDir)
                getApplication<Application>().contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input)
                    target.outputStream().use { output ->
                        val buffer = ByteArray(8192); var count = 0
                        while (true) { val size = input.read(buffer); if (size < 0) break; count += size
                            require(count <= 10 * 1024 * 1024) { "图片不能超过 10 MB。" }; output.write(buffer, 0, size) }
                    }
                }
                Uri.fromFile(target)
            }
            selectImage(local)
        } catch (error: Exception) { reportError(error.message ?: "图片没有读取完成。") }
    }

    fun selectImage(uri: Uri?) = viewModelScope.launch {
        if (uri == null) { clearAttachment(); return@launch }
        val generation = ++intakeGeneration
        val session = api.token
        try {
            val local = withContext(Dispatchers.IO) {
                val resolver = getApplication<Application>().contentResolver
                val bytes = resolver.openInputStream(uri)?.use { input ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val count = input.read(buffer); if (count < 0) break
                        require(output.size() + count <= 10 * 1024 * 1024) { "图片不能超过 10 MB。" }; output.write(buffer, 0, count) }
                    output.toByteArray()
                } ?: error("这张图片没有读取完成。")
                val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                require(options.outWidth > 0 && options.outHeight > 0) { "无法识别这张图片。" }
                var sample = 1
                while (maxOf(options.outWidth, options.outHeight) / sample > 4096) sample *= 2
                val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("无法识别这张图片。")
                val file = java.io.File.createTempFile("companion-image-", ".jpg", getApplication<Application>().cacheDir)
                try { file.outputStream().use { output -> require(bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output)) } }
                finally { bitmap.recycle() }
                require(file.length() <= 10 * 1024 * 1024) { "图片不能超过 10 MB。" }
                Uri.fromFile(file)
            }
            if (generation != intakeGeneration || session != api.token) return@launch
            _state.value = _state.value.copy(selectedImage = local, selectedFile = null, attachmentRevision = UUID.randomUUID().toString(), error = null)
        } catch (failure: Exception) {
            if (generation == intakeGeneration && session == api.token) reportError(failure.message ?: "图片没有读取完成。")
        }
    }

    suspend fun imageBytes(address: String): ByteArray? = withContext(Dispatchers.IO) { api.loadImage(address) }

    fun submit(text: String, selection: String? = null, noteContext: PendingNoteContext? = null) = viewModelScope.launch {
        val current = _state.value
        val id = current.conversationId ?: return@launch
        val content = text.trim()
        val isSelection = selection != null
        val image = if (isSelection) null else current.selectedImage
        val file = if (isSelection) null else current.selectedFile
        val context = noteContext ?: current.pendingNoteContext
        val diaryReference = current.pendingDiaryReference
        if (current.isSending || (content.isEmpty() && image == null && file == null)) return@launch
        minimumStreamingGeneration = (current.processRuns.maxOfOrNull { it.generation } ?: 0) + 1
        _state.value = _state.value.copy(streamingText = "", streamingRunId = null)
        patch(isSending = true, error = null)
        val session = api.token
        val signature = JSONObject().put("conversation", id).put("text", content).put("selection", selection)
            .put("attachment", if (isSelection) "" else current.attachmentRevision)
            .put("note", context?.noteId).put("version", context?.versionId)
            .put("diary", diaryReference?.date).put("diaryVersion", diaryReference?.version)
            .put("voice", if (isSelection) null else voiceArtifactId).toString()
        try {
            val body = if (signature == pendingTurnSignature && pendingTurnRequest != null) pendingTurnRequest!! else {
                pendingTurnSignature = signature; pendingTurnRequest = null
                val blocks = JSONArray()
                if (content.isNotEmpty()) blocks.put(JSONObject().put("type", "text").put("text", content))
                val request = JSONObject().put("version", 1).put("clientMessageId", UUID.randomUUID().toString())
                    .put("inputKind", "text").put("sourceSurface", "main").put("clientSurface", "mobile")
                if (image != null) {
                    val upload = withContext(Dispatchers.IO) { api.uploadImage(image, "手机照片.jpg") }
                    check(upload.optString("url").isNotBlank() && upload.optString("assetId").isNotBlank()) { "图片没有收到上传回执。" }
                    blocks.put(JSONObject().put("type", "image").put("url", upload.getString("url"))
                        .put("label", "手机照片.jpg").put("alt", "手机照片.jpg").put("assetId", upload.getString("assetId")))
                } else if (file != null) {
                    val upload = withContext(Dispatchers.IO) { api.uploadFile(file) }
                    val url = upload.optString("url").takeIf { it.isNotBlank() } ?: error("文件没有收到上传回执。")
                    blocks.put(JSONObject().put("type", "file").put("url", url).put("name", file.name)
                        .put("mime", file.mime).put("byteLength", file.bytes.size).put("text", file.text))
                } else if (!isSelection && voiceArtifactId != null && current.voiceTranscript == content) {
                    request.put("inputKind", "voice_transcript").put("voiceArtifactId", voiceArtifactId)
                }
                request.put("blocks", blocks)
                selection?.let { request.put("selection", JSONObject().put("text", it).put("sharing", "user_selected")) }
                context?.let { request.put("context", JSONObject().put("pageKind", "note").put("sharing", "page_registered").put("noteId", it.noteId).put("noteVersionId", it.versionId)) }
                diaryReference?.let { request.put("diaryReference", JSONObject().put("date", it.date).put("version", it.version)) }
                if (session != api.token || id != _state.value.conversationId) return@launch
                pendingTurnRequest = request
                request
            }
            if (session != api.token || id != _state.value.conversationId) return@launch
            val key = body.getString("clientMessageId")
            val response = try {
                val live = realtime
                if (live?.isReady == true) live.submit(body)
                else withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/turns", "POST", body, key) }
            } catch (failure: Exception) {
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/turns", "POST", body, key) }
            }
            if (session != api.token || _state.value.conversationId != id) return@launch
            minimumStreamingGeneration = maxOf(response.optInt("generation"), _state.value.processRuns.maxOfOrNull { it.generation } ?: 0)
            pendingTurnSignature = null; pendingTurnRequest = null
            if (isSelection) _state.value = _state.value.copy(isSending = false, selectionRunId = response.getString("runId"))
            else {
                voiceArtifactId = null
                val sameAttachment = current.attachmentRevision == _state.value.attachmentRevision
                _state.value = _state.value.copy(isSending = false,
                    selectedImage = if (sameAttachment) null else _state.value.selectedImage,
                    selectedFile = if (sameAttachment) null else _state.value.selectedFile,
                    draft = if (_state.value.draft == text) "" else _state.value.draft,
                    voiceTranscript = "", pendingNoteContext = if (_state.value.pendingNoteContext == context) null else _state.value.pendingNoteContext,
                    pendingDiaryReference = if (_state.value.pendingDiaryReference == diaryReference) null else _state.value.pendingDiaryReference)
            }
            refreshMessages(); refreshRuns()
        } catch (failure: Exception) {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if (session == api.token) patch(isSending = false, error = pageMessage(failure, "这一轮还没有发出去，草稿已保留，请重试。"))
        }
    }

    fun startRecording() {
        if (_state.value.isRecording || _state.value.isTranscribing) return
        stopVoice()
        runCatching { recorder.start() }
            .onSuccess {
                _state.value = _state.value.copy(isRecording = true, error = null)
                meterJob = viewModelScope.launch {
                    val start = android.os.SystemClock.elapsedRealtime()
                    while (_state.value.isRecording) {
                        _state.value = _state.value.copy(audioLevel = recorder.level)
                        if (android.os.SystemClock.elapsedRealtime() - start >= 59_000) { stopAndTranscribe(); break }
                        delay(40)
                    }
                }
            }
            .onFailure { patch(error = pageMessage(it, "无法开始录音，请检查麦克风权限后重试。")) }
    }

    fun stopAndTranscribe() = viewModelScope.launch {
        if (!_state.value.isRecording) return@launch
        meterJob?.cancel(); meterJob = null
        _state.value = _state.value.copy(audioLevel = 0f)
        patch(isRecording = false, isTranscribing = true, error = null)
        try {
            val recording = withContext(Dispatchers.IO) { recorder.finish() }
            if (recording.second < 200) error("录音太短了，再说一句试试。")
            val result = withContext(Dispatchers.IO) { api.transcribe(recording.first, recording.second) }
            val text = result.optString("text").trim().takeIf(String::isNotEmpty)
                ?: error("没有听清这句话，你可以重录或直接打字。")
            voiceArtifactId = result.optString("voiceArtifactId").takeIf(String::isNotBlank)
            _state.value = _state.value.copy(isTranscribing = false, voiceTranscript = text, draft = text, error = null)
        } catch (error: Throwable) {
            patch(isTranscribing = false, error = pageMessage(error, "语音识别没有完成，请稍后重试。"))
        }
    }

    fun draftChanged(value: String) {
        recordInteraction()
        _state.value = _state.value.copy(draft = value)
        if (value != _state.value.voiceTranscript) voiceArtifactId = null
    }

    fun updateServiceAddress(value: String) {
        val normalized = value.trim().trimEnd('/')
        if (normalized.isEmpty()) return
        api.baseUrl = normalized
        _state.value = _state.value.copy(serviceAddress = normalized)
        logout()
    }

    fun logout() {
        intakeGeneration++
        cancelRecording()
        stopVoice()
        realtime?.stop()
        realtime = null
        TokenStore.clear(getApplication())
        api.token = null
        voiceArtifactId = null
        pendingTurnSignature = null; pendingTurnRequest = null
        minimumStreamingGeneration = 0
        _state.value = AppUiState(serviceAddress = api.baseUrl)
    }

    private fun consumeEvent(event: JSONObject) {
        viewModelScope.launch {
            if (event.optNullableString("conversationId")?.let { it != _state.value.conversationId } == true) return@launch
            val processRunId = event.optNullableString("runId")
            if (processRunId != null) {
                val old = _state.value.processRuns.firstOrNull { it.id == processRunId }
                    ?: ActiveRun(processRunId, "running", 0, 0, null)
                val projected = projectCompanionProcessEvent(old, event)
                _state.value = _state.value.copy(processRuns = _state.value.processRuns.filterNot { it.id == processRunId } + projected)
            }
            val run = _state.value.processRuns.firstOrNull { it.id == processRunId }
            val generation = event.optInt("generation")
            val isCurrentOutput = !_state.value.isSending && generation >= minimumStreamingGeneration &&
                generation >= (_state.value.processRuns.maxOfOrNull { it.generation } ?: 0) && event.optLong("seq") >= (run?.eventCursor ?: 0)
            when (event.optString("type")) {
                "assistant.delta" -> {
                    if (!isCurrentOutput || run?.isActive == false) return@launch
                    val addition = event.optJSONObject("payload")?.optString("textDelta").orEmpty()
                    val runId = event.optNullableString("runId")
                    _state.value = _state.value.copy(streamingRunId = runId,
                        streamingText = (if (_state.value.streamingRunId == runId) _state.value.streamingText else "") + addition)
                }
                "sync.required" -> loadConversation()
                "turn.completed", "assistant.final", "turn.cancelled" -> {
                    if (_state.value.streamingRunId == event.optNullableString("runId")) _state.value = _state.value.copy(streamingText = "", streamingRunId = null)
                    refreshMessages()
                    refreshRuns()
                }
                "action.proposed" -> { refreshMessages(); refreshRuns() }
                "turn.accepted" -> refreshRuns()
                "error" -> {
                    if (!isCurrentOutput) return@launch
                    if (_state.value.streamingRunId == processRunId) _state.value = _state.value.copy(streamingText = "", streamingRunId = null)
                    _state.value = _state.value.copy(error = pageMessage(
                        IllegalStateException(event.optJSONObject("payload")?.optString("message").orEmpty()),
                        "这一轮暂时没有完成，请保留草稿后重试。",
                    ))
                    refreshMessages()
                }
            }
        }
    }

    fun recordInteraction() { lastInteraction = android.os.SystemClock.elapsedRealtime() }

    fun openOrbitSection(section: String) {
        _state.value = _state.value.copy(orbitSectionRequest = section)
    }

    fun beginDiaryCapture() {
        val current = _state.value
        _state.value = current.copy(
            draft = if (current.draft.isBlank()) "今天我想记下：" else current.draft,
            chatShowsRecords = false,
            composerFocusRequest = current.composerFocusRequest + 1,
            diaryCaptureRequest = current.diaryCaptureRequest + 1,
        )
    }

    fun consumeOrbitSectionRequest() {
        if (_state.value.orbitSectionRequest != null) _state.value = _state.value.copy(orbitSectionRequest = null)
    }

    suspend fun reportAwareness(topic: String, foreground: Boolean, page: String, noteId: String? = null) {
        val current = _state.value
        if (current.profile == null) return
        val now = android.os.SystemClock.elapsedRealtime()
        val elapsed = if (foreground) (now - lastObservation).coerceIn(0, 45_000) else 0
        lastObservation = now
        val quiet = (now - lastInteraction).coerceIn(0, 86_400_000)
        val typing = foreground && quiet < 3000 && current.draft.isNotEmpty()
        if (topic == "presence.quiet" && (quiet < 90_000 || typing)) return
        val context = JSONObject().put("foreground", foreground).put("unlocked", foreground)
            .put("typing", typing).put("learning", noteId != null).put("speaking", current.isPlaying)
            .put("participationAllowed", true).put("conversationId", current.conversationId ?: JSONObject.NULL)
            .put("page", JSONObject().put("key", noteId?.let { "note:$it" } ?: "mobile:$page")
                .put("label", page).put("revision", if (noteId != null) current.noteDocument?.versionId ?: JSONObject.NULL else JSONObject.NULL)
                .put("context", noteId?.let { JSONObject().put("noteId", it) } ?: JSONObject.NULL))
        if (topic == "presence.quiet") context.put("quietForMs", quiet)
        try {
            requestApi("/me/companion/awareness", "POST", JSONObject().put("version", 1).put("id", UUID.randomUUID().toString())
                .put("deviceSessionId", awarenessLaunchId).put("appLaunchId", awarenessLaunchId).put("host", "android")
                .put("topic", topic).put("occurredAt", java.time.Instant.now().toString()).put("elapsedMs", elapsed).put("context", context))
        } catch (_: Exception) { /* Passive presence does not replace an actionable error. */ }
    }

    fun isQuiet(): Boolean = android.os.SystemClock.elapsedRealtime() - lastInteraction >= 90_000

    fun reportError(message: String) = patch(error = message)

    suspend fun decideProposal(id: String, decision: String, hash: String, key: String): JSONObject = withContext(Dispatchers.IO) {
        api.request("/companion/proposals/$id/decision", "POST", JSONObject().put("version", 1).put("decision", decision)
            .put("expectedPayloadSha256", hash).put("idempotencyKey", key), key)
    }

    fun referenceNote(id: String) = viewModelScope.launch {
        try {
            val document = NoteDocument.from(requestApi("/v2/notes/$id")) ?: error("这篇手记暂时打不开。")
            continueWithNote(document)
        } catch (failure: Exception) { patch(error = failure.message) }
    }

    fun selectFile(uri: Uri) = viewModelScope.launch {
        val generation = ++intakeGeneration
        val session = api.token
        try {
            val file = withContext(Dispatchers.IO) { CompanionFile.read(getApplication(), uri) }
            if (generation != intakeGeneration || session != api.token) return@launch
            _state.value = _state.value.copy(selectedFile = file, selectedImage = null, attachmentRevision = file.id, error = null)
        } catch (error: Exception) { patch(error = error.message ?: "文件没有读取完成，请重试。") }
    }

    fun clearAttachment() { intakeGeneration++; _state.value = _state.value.copy(selectedFile = null, selectedImage = null) }

    fun importPreparedFile() = viewModelScope.launch {
        val file = _state.value.selectedFile ?: return@launch
        if (_state.value.isSending) return@launch
        val session = api.token
        patch(isSending = true, error = null)
        try {
            val response = requestApi("/import/markdown", "POST", JSONObject().put("importId", "mobile-${file.id}")
                .put("items", JSONArray().put(JSONObject().put("title", file.name.substringBeforeLast('.')).put("content", file.text))))
            if (session != api.token) return@launch
            check(response.optInt("imported") == 1) { "文件没有成功导入，请检查内容后重试。" }
            if (_state.value.selectedFile?.id == file.id) clearAttachment()
            loadNotes("")
        } catch (failure: Exception) {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if (session == api.token) patch(error = failure.message ?: "导入没有完成，文件已保留。")
        } finally { if (session == api.token) patch(isSending = false) }
    }

    fun askAboutSelection(text: String, document: NoteDocument, rewrite: Boolean) {
        if (_state.value.isSending) return
        _state.value = _state.value.copy(selectionRunId = null, streamingText = "")
        submit(if (rewrite) "请改写我选中的这段原文，保留原意，先给出修改对照，等我确认后再写回手记。" else "请结合这篇手记解释我选中的原文，讲清含义与关键关系。",
            selection = text.take(20_000), noteContext = PendingNoteContext(document.id, document.versionId, document.title))
    }

    fun cancelActiveRuns() = viewModelScope.launch {
        stopVoice()
        try { _state.value.runs.forEach { requestApi("/companion/runs/${it.id}/cancel", "POST", JSONObject().put("version", 1).put("generation", it.generation).put("reason", "user")) }; refreshRuns() }
        catch (error: Exception) { patch(error = error.message ?: "暂时没有停下来，请重试。") }
    }

    fun cancelRecording() {
        meterJob?.cancel(); meterJob = null
        if (_state.value.isRecording) runCatching { recorder.finish() }
        _state.value = _state.value.copy(isRecording = false, audioLevel = 0f)
    }

    fun playVoice(text: String) {
        stopVoice()
        if (text.isBlank()) return
        _state.value = _state.value.copy(isVoiceLoading = true, error = null)
        voiceJob = viewModelScope.launch {
            try {
                val chunks = text.chunked(1800)
                for (chunk in chunks) {
                    val bytes = withContext(Dispatchers.IO) { api.synthesize(chunk) }
                    kotlinx.coroutines.currentCoroutineContext().ensureActive()
                    val file = java.io.File.createTempFile("astella-voice-", ".mp3", getApplication<Application>().cacheDir)
                    audioFile = file
                    withContext(Dispatchers.IO) { file.writeBytes(bytes) }
                    val envelope = withContext(Dispatchers.IO) { AudioEnvelope.decode(file) }
                    val player = android.media.MediaPlayer()
                    audioPlayer = player
                    player.setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    player.setDataSource(file.absolutePath)
                    withContext(Dispatchers.IO) { player.prepare() }
                    var completed = false
                    player.setOnCompletionListener { completed = true }
                    player.setOnErrorListener { _, _, _ -> completed = true; patch(error = "这段声音播放失败，请重试。"); true }
                    player.start()
                    _state.value = _state.value.copy(isPlaying = true, isVoiceLoading = false)
                    while (!completed) {
                        val position = player.currentPosition
                        _state.value = _state.value.copy(audioLevel = if (_state.value.isPaused) 0f else envelope.getOrElse(position / 40) { 0f })
                        delay(40)
                    }
                    player.release(); audioPlayer = null
                    file.delete(); audioFile = null
                }
                _state.value = _state.value.copy(isPlaying = false, audioLevel = 0f, isVoiceLoading = false)
            } catch (cancel: kotlinx.coroutines.CancellationException) { throw cancel }
            catch (error: Exception) { stopVoice(); patch(error = pageMessage(error, "声音暂时没有接回来，可以重试朗读。")) }
        }
    }

    fun toggleVoicePause() {
        val player = audioPlayer ?: return
        if (_state.value.isPaused) player.start() else player.pause()
        _state.value = _state.value.copy(isPaused = !_state.value.isPaused, isPlaying = !_state.value.isPlaying, audioLevel = 0f)
    }

    fun stopVoice() {
        voiceJob?.cancel(); voiceJob = null
        audioPlayer?.release(); audioPlayer = null
        audioFile?.delete(); audioFile = null
        _state.value = _state.value.copy(isPlaying = false, isPaused = false, isVoiceLoading = false, audioLevel = 0f)
    }

    override fun onCleared() { cancelRecording(); stopVoice(); realtime?.stop(); super.onCleared() }

    private fun patch(
        isLoading: Boolean = _state.value.isLoading,
        isSending: Boolean = _state.value.isSending,
        isRecording: Boolean = _state.value.isRecording,
        isTranscribing: Boolean = _state.value.isTranscribing,
        error: String? = _state.value.error,
        authError: String? = _state.value.authError,
        authNotice: String? = _state.value.authNotice,
    ) {
        _state.value = _state.value.copy(
            isLoading = isLoading,
            isSending = isSending,
            isRecording = isRecording,
            isTranscribing = isTranscribing,
            error = error,
            authError = authError,
            authNotice = authNotice,
        )
    }
}

private fun devicePreferenceKey(userId: String, name: String): String = "astella.mobile.$userId.$name"

private fun notePreferenceKey(userId: String, workspaceId: String, name: String): String =
    "astella.mobile.note-location.$userId.$workspaceId.$name"
