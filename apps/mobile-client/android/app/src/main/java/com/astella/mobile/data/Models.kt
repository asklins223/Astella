package com.astella.mobile.data

import org.json.JSONArray
import org.json.JSONObject

const val AI_CONSENT_VERSION = "ai-consent-v1"

data class UserProfile(
    val userId: String,
    val displayName: String,
    val avatarUrl: String?,
    val email: String,
    val workspaceName: String,
    val workspaceId: String,
    val workspaceType: String,
    val isPersonalWorkspace: Boolean,
) {
    companion object {
        fun from(value: JSONObject) = UserProfile(
            value.optString("userId"),
            value.optNullableString("displayName").orEmpty(),
            value.optNullableString("avatarUrl"),
            value.optString("email"),
            value.optString("workspaceName", "我的书房"),
            value.optString("workspaceId"),
            value.optString("workspaceType", "personal"),
            value.optBoolean("isPersonal", true),
        )
    }
}

data class CompanionDiagramStep(val label: String, val detail: String?)
data class CompanionCitationTarget(val kind: String, val href: String?, val entityRef: String?)
data class CompanionQuoteSource(val kind: String, val noteId: String?, val noteVersionId: String?, val blockOrdinal: Int?, val sourceId: String?, val segmentOrdinal: Int?) {
    companion object { fun from(value: JSONObject?): CompanionQuoteSource? = value?.let {
        CompanionQuoteSource(it.optString("kind"), it.optNullableString("noteId"), it.optNullableString("noteVersionId"),
            if (it.has("blockOrdinal")) it.optInt("blockOrdinal") else null, it.optNullableString("sourceId"), if (it.has("segmentOrdinal")) it.optInt("segmentOrdinal") else null)
    } }
}
data class CompanionBlock(
    val type: String,
    val text: String? = null,
    val url: String? = null,
    val label: String? = null,
    val alt: String? = null,
    val name: String? = null,
    val proposalId: String? = null,
    val code: String? = null,
    val noteTarget: CompanionNoteTarget? = null,
    val title: String? = null,
    val steps: List<CompanionDiagramStep> = emptyList(),
    val front: String? = null,
    val summary: String? = null,
    val citation: CompanionCitationTarget? = null,
    val sourceRef: CompanionQuoteSource? = null,
)

data class CompanionMessage(
    val id: String,
    val seq: Int,
    val role: String,
    val blocks: List<CompanionBlock>,
    val createdAt: String,
    val runId: String? = null,
) {
    val displayText: String get() = blocks.filter { it.type != "file" }.mapNotNull { it.text ?: it.code }.joinToString("\n\n")

    companion object {
        fun from(value: JSONObject): CompanionMessage = CompanionMessage(
            id = value.optString("id"),
            seq = value.optInt("seq"),
            role = value.optString("role", "assistant"),
            blocks = value.optJSONArray("blocks").objects().map { block ->
                CompanionBlock(
                    type = block.optString("type", "text"),
                    text = block.optNullableString("text"),
                    url = block.optNullableString("url"),
                    label = block.optNullableString("label"),
                    alt = block.optNullableString("alt"),
                    name = block.optNullableString("name"),
                    proposalId = block.optNullableString("proposalId"),
                    code = block.optNullableString("code"),
                    noteTarget = CompanionNoteTarget.from(block.optJSONObject("route"), block.optNullableString("label")),
                    title = block.optNullableString("title"),
                    steps = block.optJSONArray("steps").objects().map { CompanionDiagramStep(it.optString("label"), it.optNullableString("detail")) },
                    front = block.optNullableString("front"), summary = block.optNullableString("summary"),
                    citation = block.optJSONObject("target")?.let { CompanionCitationTarget(it.optString("kind"), it.optNullableString("href"), it.optNullableString("entityRef")) },
                    sourceRef = CompanionQuoteSource.from(block.optJSONObject("sourceRef")),
                )
            },
            createdAt = value.optString("createdAt"),
            runId = value.optNullableString("runId"),
        )
    }
}

data class NoteSummary(
    val id: String,
    val title: String,
    val updatedAt: String,
    val snippet: String? = null,
) {
    companion object {
        fun from(value: JSONObject) = NoteSummary(
            id = value.optString("id").ifBlank { value.optString("objectId") },
            title = value.optString("title").ifBlank { "未命名手记" },
            updatedAt = value.optString("updatedAt").ifBlank { value.optString("indexedAt") },
            snippet = value.optNullableString("snippet"),
        )
    }
}

data class NoteBlock(val ordinal: Int, val type: String, val content: String)

data class NoteDocument(val id: String, val versionId: String, val versionNumber: Int, val title: String, val blocks: List<NoteBlock>) {
    companion object {
        fun from(value: JSONObject): NoteDocument? {
            val noteId = value.optString("noteId").takeIf(String::isNotBlank) ?: return null
            val version = value.optJSONObject("currentVersion") ?: return null
            return NoteDocument(
                id = noteId,
                versionId = version.optString("versionId").ifBlank { value.optString("currentVersionId") },
                versionNumber = version.optInt("versionNo", 1),
                title = value.optString("title", "手记"),
                blocks = version.optJSONArray("blocks").objects().map { block ->
                    NoteBlock(block.optInt("ordinal"), block.optString("type", "paragraph"), block.optString("content"))
                },
            )
        }
    }
}

data class NoteAnnotationAnchor(
    val noteVersionId: String,
    val startBlockOrdinal: Int,
    val startOffset: Int,
    val endBlockOrdinal: Int,
    val endOffset: Int,
    val excerpt: String,
    val prefix: String,
    val suffix: String,
) {
    fun toJson() = JSONObject()
        .put("noteVersionId", noteVersionId)
        .put("startBlockOrdinal", startBlockOrdinal)
        .put("startOffset", startOffset)
        .put("endBlockOrdinal", endBlockOrdinal)
        .put("endOffset", endOffset)
        .put("excerpt", excerpt)
        .put("prefix", prefix)
        .put("suffix", suffix)

    companion object {
        fun wholeBlock(block: NoteBlock, versionId: String): NoteAnnotationAnchor? {
            val text = renderedNoteBlockText(block) ?: return null
            if (text.isBlank()) return null
            var end = text.length.coerceAtMost(2_000)
            if (end < text.length && end > 0 && text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end--
            if (end == 0) return null
            return NoteAnnotationAnchor(
                noteVersionId = versionId,
                startBlockOrdinal = block.ordinal,
                startOffset = 0,
                endBlockOrdinal = block.ordinal,
                endOffset = end,
                excerpt = text.substring(0, end),
                prefix = "",
                suffix = text.substring(end).take(120),
            )
        }

        private fun renderedNoteBlockText(block: NoteBlock): String? {
            var text = block.content
            when (block.type) {
                "image", "table" -> return null
                "heading" -> text = text.replace(Regex("^\\s*<h[1-6]\\b[^>]*>|</h[1-6]>\\s*$", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("^\\s*#{1,6}\\s+"), "")
                "quote" -> text = text.replace(Regex("(?m)^\\s*>\\s?"), "")
                "list" -> text = text.lineSequence().filter(String::isNotBlank)
                    .joinToString("\n") { it.replace(Regex("^\\s*(?:[-+*]|\\d+[.)])\\s+"), "") }
            }
            text = text.replace(Regex("!\\[[^\\]]*\\]\\([^)]+\\)"), "")
                .replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "\$1")
                .replace(Regex("<[^>]+>"), "")
                .replace(Regex("(?<!\\\\)(?:\\*{1,3}|_{1,3}|~~|`)"), "")
            return text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&nbsp;", " ").replace("&quot;", "\"").replace("&#39;", "'")
        }
    }
}

data class NoteAnnotation(
    val id: String,
    val anchor: NoteAnnotationAnchor,
    val explanation: String,
    val revision: Int,
    val versionState: String,
    val sourceMessageId: String?,
) {
    companion object {
        fun from(value: JSONObject): NoteAnnotation? {
            val raw = value.optJSONObject("anchor") ?: return null
            val anchor = NoteAnnotationAnchor(
                noteVersionId = raw.optString("noteVersionId"),
                startBlockOrdinal = raw.optInt("startBlockOrdinal"),
                startOffset = raw.optInt("startOffset"),
                endBlockOrdinal = raw.optInt("endBlockOrdinal"),
                endOffset = raw.optInt("endOffset"),
                excerpt = raw.optString("excerpt"),
                prefix = raw.optString("prefix"),
                suffix = raw.optString("suffix"),
            )
            return value.optString("annotationId").takeIf(String::isNotBlank)?.let { id ->
                NoteAnnotation(
                    id = id,
                    anchor = anchor,
                    explanation = value.optString("explanation"),
                    revision = value.optInt("revision", 1),
                    versionState = value.optString("versionState", "current"),
                    sourceMessageId = value.optNullableString("sourceMessageId"),
                )
            }
        }
    }
}

data class PendingNoteContext(val noteId: String, val versionId: String, val title: String)

data class PendingDiaryReference(val date: String, val version: Int)

data class WorkspaceSummary(
    val id: String,
    val name: String,
    val role: String,
    val type: String,
    val isPersonal: Boolean,
) {
    companion object {
        fun from(value: JSONObject) = WorkspaceSummary(
            id = value.optString("workspaceId"),
            name = value.optString("workspaceName", "书房"),
            role = value.optString("role", "member"),
            type = value.optString("workspaceType", "personal"),
            isPersonal = value.optBoolean("isPersonal"),
        )
    }
}

data class AIDataPolicy(
    val sendToExternal: Boolean,
    val sendImageContent: Boolean,
    val piiDetection: Boolean,
    val auditLogging: Boolean,
) {
    fun toJson() = JSONObject()
        .put("sendToExternal", sendToExternal)
        .put("sendImageContent", sendImageContent)
        .put("piiDetection", piiDetection)
        .put("auditLogging", auditLogging)

    companion object {
        fun from(value: JSONObject?) = AIDataPolicy(
            sendToExternal = value?.optBoolean("sendToExternal") ?: false,
            sendImageContent = value?.optBoolean("sendImageContent") ?: false,
            piiDetection = value?.optBoolean("piiDetection", true) ?: true,
            auditLogging = value?.optBoolean("auditLogging", true) ?: true,
        )
    }
}

data class AISettings(
    val requiresConsent: Boolean,
    val consentVersion: String?,
    val consentAt: String?,
    val dataPolicy: AIDataPolicy,
) {
    /** 服务端 `requiresConsent` 表示系统启用了外部 AI；真正代表用户签署的是同意版本与时间。 */
    val signed: Boolean get() = consentVersion != null && consentAt != null

    /** 只有「系统要求授权但用户尚未签署」才需要先去签协议。 */
    val needsSigning: Boolean get() = requiresConsent && !signed

    companion object {
        fun from(value: JSONObject) = AISettings(
            requiresConsent = value.optBoolean("requiresConsent"),
            consentVersion = value.optNullableString("consentVersion"),
            consentAt = value.optNullableString("consentAt"),
            dataPolicy = AIDataPolicy.from(value.optJSONObject("dataPolicy")),
        )
    }
}

data class ActiveRun(
    val id: String,
    val status: String,
    val stepCount: Int,
    val toolCallCount: Int,
    val thinkingText: String?,
    val generation: Int = 0,
    val userMessageId: String? = null,
    val assistantMessageId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val nodes: List<CompanionProcessNode> = emptyList(),
    val errorCode: String? = null,
    val eventCursor: Long = 0,
) {
    val isActive get() = status.lowercase() in setOf("running", "accepted", "waiting_for_confirmation", "cancel_requested")
    val canResume get() = status == "failed" && errorCode in setOf("PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_FIRST_OUTPUT_TIMEOUT", "PROVIDER_IDLE_TIMEOUT", "RATE_LIMITED", "JOB_DEAD", "JOB_MISSING")
    val progressLabel get() = if (isActive) nodes.maxByOrNull { it.seq }?.label ?: statusLabel else statusLabel
    val failureDescription get() = when (errorCode) {
        "PROVIDER_FIRST_OUTPUT_TIMEOUT" -> "模型尚未返回首段输出，等待已超时。已保存的成果仍然保留。"
        "PROVIDER_IDLE_TIMEOUT" -> "模型输出中断，等待新的进展已超时。已有内容仍然保留。"
        "RATE_LIMITED" -> "当前服务繁忙，请稍后从中断处继续。"
        "CONTEXT_STALE" -> "资料或授权已经变化，请核对当前内容后重新发起请求。"
        else -> "这次任务未能完成，原记录和已保存的成果仍然保留。"
    }

    val statusLabel get() = when (status.lowercase()) {
        "accepted" -> "准备开始"
        "waiting_for_confirmation" -> "等你确认"
        "cancel_requested" -> "正在收尾"
        "succeeded", "completed" -> "已完成"
        "failed" -> "未完成"
        "cancelled" -> "已停止"
        else -> "进行中"
    }

    companion object {
        fun from(value: JSONObject) = ActiveRun(
            id = value.optString("runId"),
            status = value.optString("status", "running"),
            stepCount = value.optInt("stepCount"),
            toolCallCount = value.optInt("toolCallCount"),
            thinkingText = value.optNullableString("thinkingText"),
            generation = value.optInt("generation"),
            userMessageId = value.optNullableString("userMessageId"),
            assistantMessageId = value.optNullableString("assistantMessageId"),
            createdAt = value.optNullableString("createdAt"),
            updatedAt = value.optNullableString("updatedAt"),
            errorCode = value.optNullableString("errorCode"),
            eventCursor = value.optLong("eventCursor"),
        )
    }
}

enum class MainTab(val label: String, val icon: String) {
    Conversation("相伴", "companion"),
    Library("书房", "library"),
    Orbit("星轨", "orbit"),
    Me("我的", "person"),
}

internal fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.optNullableString(key: String): String? = if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

