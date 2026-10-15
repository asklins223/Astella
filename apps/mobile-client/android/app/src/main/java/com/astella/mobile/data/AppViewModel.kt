package com.astella.mobile.data

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

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
    val runs: List<ActiveRun> = emptyList(),
    val workspaces: List<WorkspaceSummary> = emptyList(),
    val aiSettings: AISettings? = null,
    val companionPermissionLevel: String? = null,
    val streamingText: String = "",
    val realtimeStatus: String = "尚未连接",
    val isLoading: Boolean = false,
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
    val selectedImage: Uri? = null,
    val voiceTranscript: String = "",
    val serviceAddress: String = "",
) {
    val isAuthenticated get() = profile != null
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val api = MobileApi(application)
    private val devicePreferences = application.getSharedPreferences("astella.device-preferences", Application.MODE_PRIVATE)
    private val recorder = VoiceRecorder()
    private val _state = kotlinx.coroutines.flow.MutableStateFlow(
        AppUiState(serviceAddress = api.baseUrl),
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

    fun hasStoredSession(): Boolean = api.token != null

    suspend fun requestApi(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) { api.request(path, method, body) }

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

    private fun pageMessage(error: Throwable, fallback: String): String {
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
        patch(isLoading = true, error = null)
        try {
            val me = withContext(Dispatchers.IO) { api.request("/auth/me") }
            val profile = UserProfile.from(me)
            val key = profile.userId
            _state.value = _state.value.copy(
                profile = profile,
                chatShowsRecords = devicePreferences.getBoolean(devicePreferenceKey(key, "showRecords"), false),
                readingScale = devicePreferences.getFloat(devicePreferenceKey(key, "readingScale"), 1f).coerceIn(1f, 1.4f),
                localReduceMotion = devicePreferences.getBoolean(devicePreferenceKey(key, "reduceMotion"), false),
                isLoading = false,
            )
            loadConversation()
            loadNotes("")
        } catch (error: Throwable) {
            if ((error as? ApiFailure)?.status == 401) logout()
            else patch(isLoading = false, error = pageMessage(error, "暂时接不上你的书房，请检查网络后重试。"))
        }
    }

    fun loadConversation() = viewModelScope.launch {
        patch(error = null)
        try {
            val inbox = withContext(Dispatchers.IO) { api.request("/companion/inbox/ensure", "POST", JSONObject()) }
            val id = inbox.optString("id").takeIf(String::isNotBlank) ?: error("没有找到伴星对话。")
            _state.value = _state.value.copy(conversationId = id)
            refreshMessages()
            refreshRuns()
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
        runCatching {
            withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/messages?limit=50") }
        }.onSuccess { page ->
            val messages = page.optJSONArray("items").objects().map(CompanionMessage::from).sortedBy(CompanionMessage::seq)
            _state.value = _state.value.copy(messages = messages, streamingText = "")
        }.onFailure { patch(error = pageMessage(it, "对话记录暂时无法读取，请重新连接后重试。")) }
    }

    fun refreshRuns() = viewModelScope.launch {
        val id = _state.value.conversationId ?: return@launch
        runCatching { withContext(Dispatchers.IO) { api.request("/companion/conversations/$id/run-nodes?after=0") } }
            .onSuccess { snapshot ->
                val runs = snapshot.optJSONArray("runs").objects().map(ActiveRun::from).filter(ActiveRun::isActive)
                _state.value = _state.value.copy(runs = runs)
            }.onFailure { _state.value = _state.value.copy(runs = emptyList()) }
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

    fun setChatShowsRecords(value: Boolean) {
        _state.value.profile?.userId?.takeIf(String::isNotBlank)?.let {
            devicePreferences.edit().putBoolean(devicePreferenceKey(it, "showRecords"), value).apply()
        }
        _state.value = _state.value.copy(chatShowsRecords = value)
    }

    fun setReadingScale(value: Float) {
        if (value !in listOf(1f, 1.2f, 1.4f)) return
        _state.value.profile?.userId?.takeIf(String::isNotBlank)?.let {
            devicePreferences.edit().putFloat(devicePreferenceKey(it, "readingScale"), value).apply()
        }
        _state.value = _state.value.copy(readingScale = value)
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
        if (_state.value.aiSettings?.requiresConsent != true) {
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
                    requiresConsent = false,
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

    fun selectImage(uri: Uri?) {
        _state.value = _state.value.copy(selectedImage = uri, error = null)
    }

    suspend fun imageBytes(address: String): ByteArray? = withContext(Dispatchers.IO) { api.loadImage(address) }

    fun submit(text: String) = viewModelScope.launch {
        val current = _state.value
        val id = current.conversationId ?: return@launch
        val content = text.trim()
        if (current.isSending || (content.isEmpty() && current.selectedImage == null)) return@launch
        patch(isSending = true, error = null)
        val clientMessageId = UUID.randomUUID().toString()
        try {
            val blocks = JSONArray().put(JSONObject().put("type", "text").put("text", content.ifEmpty { "看看这张图" }))
            var inputKind = "text"
            var body = JSONObject()
                .put("version", 1)
                .put("clientMessageId", clientMessageId)
                .put("inputKind", inputKind)
                .put("sourceSurface", "main")
            if (current.selectedImage != null) {
                val upload = withContext(Dispatchers.IO) {
                    api.uploadImage(current.selectedImage, "手机照片.jpg")
                }
                blocks.put(JSONObject().put("type", "image")
                    .put("url", upload.optString("url"))
                    .put("label", "手机照片.jpg")
                    .put("alt", "手机照片.jpg")
                    .put("assetId", upload.optString("assetId")))
            } else if (voiceArtifactId != null && current.voiceTranscript == content) {
                inputKind = "voice_transcript"
                body.put("voiceArtifactId", voiceArtifactId)
            }
            body.put("inputKind", inputKind).put("blocks", blocks)
            current.pendingNoteContext?.let { context ->
                body.put("context", JSONObject()
                    .put("pageKind", "note")
                    .put("sharing", "page_registered")
                    .put("noteId", context.noteId)
                    .put("noteVersionId", context.versionId))
            }
            try {
                if (realtime?.isReady == true) realtime?.submit(body)
                else withContext(Dispatchers.IO) {
                    api.request("/companion/conversations/$id/turns", "POST", body, clientMessageId)
                }
            } catch (_: Throwable) {
                // The HTTP write uses the same idempotency key, so a lost WS ack
                // cannot create a second turn if the first submit was accepted.
                withContext(Dispatchers.IO) {
                    api.request("/companion/conversations/$id/turns", "POST", body, clientMessageId)
                }
            }
            voiceArtifactId = null
            _state.value = _state.value.copy(isSending = false, selectedImage = null, voiceTranscript = "", pendingNoteContext = null)
            refreshMessages()
        } catch (error: Throwable) {
            patch(isSending = false, error = pageMessage(error, "这一轮还没有发出去，草稿已保留，请重试。"))
        }
    }

    fun startRecording() {
        runCatching { recorder.start() }
            .onSuccess { _state.value = _state.value.copy(isRecording = true, error = null) }
            .onFailure { patch(error = pageMessage(it, "无法开始录音，请检查麦克风权限后重试。")) }
    }

    fun stopAndTranscribe() = viewModelScope.launch {
        patch(isRecording = false, isTranscribing = true, error = null)
        try {
            val recording = withContext(Dispatchers.IO) { recorder.finish() }
            if (recording.second < 200) error("录音太短了，再说一句试试。")
            val result = withContext(Dispatchers.IO) { api.transcribe(recording.first, recording.second) }
            val text = result.optString("text").trim().takeIf(String::isNotEmpty)
                ?: error("没有听清这句话，你可以重录或直接打字。")
            voiceArtifactId = result.optString("voiceArtifactId").takeIf(String::isNotBlank)
            _state.value = _state.value.copy(isTranscribing = false, voiceTranscript = text, error = null)
        } catch (error: Throwable) {
            patch(isTranscribing = false, error = pageMessage(error, "语音识别没有完成，请稍后重试。"))
        }
    }

    fun draftChanged(value: String) {
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
        realtime?.stop()
        realtime = null
        TokenStore.clear(getApplication())
        api.token = null
        voiceArtifactId = null
        _state.value = AppUiState(serviceAddress = api.baseUrl)
    }

    private fun consumeEvent(event: JSONObject) {
        viewModelScope.launch {
            when (event.optString("type")) {
                "assistant.delta" -> {
                    val addition = event.optJSONObject("payload")?.optString("textDelta").orEmpty()
                    _state.value = _state.value.copy(streamingText = _state.value.streamingText + addition)
                }
                "sync.required" -> loadConversation()
                "turn.completed", "assistant.final" -> {
                    refreshMessages()
                    refreshRuns()
                }
                "turn.accepted", "assistant.status", "agent.tool" -> refreshRuns()
                "error" -> {
                    _state.value = _state.value.copy(error = pageMessage(
                        IllegalStateException(event.optJSONObject("payload")?.optString("message").orEmpty()),
                        "这一轮暂时没有完成，请保留草稿后重试。",
                    ))
                    refreshMessages()
                }
            }
        }
    }

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
