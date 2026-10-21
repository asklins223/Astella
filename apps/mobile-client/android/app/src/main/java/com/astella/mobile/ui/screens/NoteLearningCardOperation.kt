package com.astella.mobile.ui.screens

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.StudyPalette
import org.json.JSONObject

/**
 * 操作题宿主。服务端返回的是固定模板 HTML，作答通过 `astella:artifact-frame`
 * 通道回传；这里只负责加载、答案恢复与只读回放，不执行任何外部脚本。
 */
@Composable
fun LearningCardOperationView(
    viewModel: AppViewModel,
    artifactId: String,
    initialAnswer: Any?,
    readOnly: Boolean,
    onAnswer: (Any) -> Unit,
) {
    var html by remember(artifactId) { mutableStateOf<String?>(null) }
    var failure by remember(artifactId) { mutableStateOf<String?>(null) }
    LaunchedEffect(artifactId) {
        try {
            val bytes = viewModel.imageBytes("/v2/note-learning-card-operation-artifacts/$artifactId")
            val text = bytes?.toString(Charsets.UTF_8)
            if (text.isNullOrBlank()) failure = "这道操作题的操作区域读不到。" else html = text
        } catch (cause: Throwable) {
            failure = featureFailure(cause, "操作区域暂时打不开，可以先跳过这题。")
        }
    }
    when {
        failure != null -> Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(failure!!, color = StudyPalette.muted, fontSize = 13.sp)
        }
        html == null -> Column(Modifier.fillMaxWidth().heightIn(min = 200.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(Modifier.size(18.dp), color = StudyPalette.accent, strokeWidth = 2.dp)
            Text("正在打开操作区域…", Modifier.padding(top = 8.dp), color = StudyPalette.muted, fontSize = 13.sp)
        }
        else -> AndroidView(
            factory = { context -> OperationWebView(context, html!!, initialAnswer, readOnly, onAnswer) },
            update = { web ->
                web.readOnly = readOnly
                web.restore(initialAnswer)
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 320.dp, max = 780.dp),
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
private class OperationWebView(
    context: android.content.Context,
    html: String,
    private val initialAnswer: Any?,
    readOnly: Boolean,
    onAnswer: (Any) -> Unit,
) : WebView(context) {
    var readOnly = readOnly
    private var restoredFingerprint: String? = null
    private var documentReady = false

    init {
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.allowContentAccess = false
        settings.allowFileAccess = false
        settings.blockNetworkLoads = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageFinished(view: WebView, url: String) {
                documentReady = true
                evaluateJavascript(BRIDGE_SCRIPT, null)
                restore(initialAnswer)
            }
        }
        addJavascriptInterface(Bridge { answer -> onAnswer(answer) }, "AstellaOperationBridge")
        loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    fun restore(answer: Any?) {
        if (!documentReady) return
        if (answer == null && !readOnly) return
        val script = restoreScript(answer, readOnly)
        if (restoredFingerprint == script) return
        evaluateJavascript(script) { restoredFingerprint = script }
    }

    private class Bridge(private val onAnswer: (Any) -> Unit) {
        private val main = android.os.Handler(android.os.Looper.getMainLooper())
        @JavascriptInterface
        fun postMessage(raw: String) {
            if (raw.length > 64_000) return
            val payload = runCatching { JSONObject(raw) }.getOrNull() ?: return
            if (payload.optString("phase") != "answer") return
            val answer = payload.opt("answer") ?: return
            main.post { onAnswer(answer) }
        }
    }

    private companion object {
        /** The frame posts to `parent`; forward only its answer phase to the host. */
        const val BRIDGE_SCRIPT = """
            (function(){
              if (window.__astellaBridge) return;
              window.__astellaBridge = true;
              window.addEventListener('message', function (event) {
                var data = event.data;
                if (!data || data.channel !== 'astella:artifact-frame' || data.direction !== 'frame->host') return;
                if (data.phase !== 'answer') return;
                window.AstellaOperationBridge.postMessage(JSON.stringify({ phase: 'answer', answer: data.answer }));
              }, false);
            })();
        """
    }
}

private fun restoreScript(answer: Any?, readOnly: Boolean): String {
    val envelope = JSONObject()
        .put("channel", "astella:artifact-frame")
        .put("direction", "host->frame")
        .put("command", "restore-answer")
        .put("answer", answer ?: JSONObject.NULL)
        .put("readOnly", readOnly)
        .toString()
    return "(function(){window.postMessage(JSON.parse(${JSONObject.quote(envelope)}),'*');})();"
}
