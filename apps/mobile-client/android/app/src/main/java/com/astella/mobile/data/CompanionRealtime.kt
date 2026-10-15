package com.astella.mobile.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class CompanionRealtime(
    private val api: MobileApi,
    private val onEvent: (JSONObject) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private var socket: WebSocket? = null
    private var conversationId = ""
    @Volatile private var cursor = 0
    @Volatile var isReady = false
        private set
    @Volatile private var stopped = true
    private var retry = 0

    fun start(id: String, cursor: Int) {
        stop()
        conversationId = id
        this.cursor = cursor
        stopped = false
        retry = 0
        connect()
    }

    fun stop() {
        stopped = true
        isReady = false
        socket?.close(1000, "client closed")
        socket = null
        pending.values.forEach { it.completeExceptionally(IllegalStateException("连接已关闭")) }
        pending.clear()
    }

    suspend fun submit(body: JSONObject): JSONObject {
        check(isReady) { "实时连接正在恢复。" }
        val requestId = body.optString("clientMessageId").ifBlank { UUID.randomUUID().toString() }
        val response = CompletableDeferred<JSONObject>()
        pending[requestId] = response
        val sent = socket?.send(JSONObject()
            .put("version", 1).put("type", "turn.submit").put("requestId", requestId)
            .put("conversationId", conversationId).put("body", body).toString()) == true
        if (!sent) {
            pending.remove(requestId)
            throw IllegalStateException("实时连接暂不可用。")
        }
        return try {
            withTimeout(6_000) { response.await() }
        } finally {
            pending.remove(requestId)
        }
    }

    private fun connect() {
        if (stopped) return
        isReady = false
        onState(if (retry == 0) "正在连接" else "正在重连")
        val target = api.url("/companion/realtime")
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
        socket = api.client.newWebSocket(Request.Builder().url(target).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val token = api.token
                if (token.isNullOrBlank()) {
                    webSocket.close(4401, "missing session")
                    return
                }
                webSocket.send(JSONObject().put("version", 1).put("type", "auth").put("token", token).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (socket !== webSocket || stopped) return
                val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (message.optString("type")) {
                    "auth.ok" -> webSocket.send(JSONObject().put("version", 1).put("type", "subscribe")
                        .put("conversationId", conversationId).put("after", cursor).toString())
                    "subscribed" -> {
                        if (message.optString("conversationId") == conversationId) {
                            cursor = maxOf(cursor, message.optInt("cursor"))
                            retry = 0
                            isReady = true
                            onState("已连接")
                        }
                    }
                    "event" -> message.optJSONObject("event")?.let { event ->
                        cursor = maxOf(cursor, event.optInt("seq"))
                        onEvent(event)
                    }
                    "turn.result" -> {
                        val id = message.optString("requestId")
                        val deferred = pending[id] ?: return
                        if (message.optBoolean("ok")) deferred.complete(message.optJSONObject("result") ?: JSONObject())
                        else deferred.completeExceptionally(IllegalStateException(message.optJSONObject("error")?.optString("message") ?: "发送没有完成"))
                    }
                    "ping" -> webSocket.send(JSONObject().put("version", 1).put("type", "pong").toString())
                    "error" -> {
                        val error = message.optJSONObject("error")
                        val code = error?.optString("code")
                        if (code == "CURSOR_EXPIRED" || code == "INVALID_CURSOR") {
                            onEvent(JSONObject().put("type", "sync.required"))
                            webSocket.send(JSONObject().put("version", 1).put("type", "subscribe")
                                .put("conversationId", conversationId).put("after", cursor).toString())
                        } else onState(error?.optString("message") ?: "连接遇到问题")
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket !== webSocket || stopped) return
                isReady = false
                onState("连接中断")
                reconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket !== webSocket || stopped) return
                isReady = false
                reconnect()
            }
        })
    }

    private fun reconnect() {
        if (stopped) return
        val wait = minOf(20_000L, 700L * (1L shl retry.coerceAtMost(5)))
        retry += 1
        onState("正在重连")
        scope.launch {
            delay(wait)
            if (!stopped) connect()
        }
    }
}
