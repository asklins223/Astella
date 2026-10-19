package com.astella.mobile.ui.launch

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.webkit.*
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.ByteArrayInputStream
import com.astella.mobile.BuildConfig
import com.astella.mobile.R

data class LaunchLanding(val hideCompanion: Boolean = false, val onBounds: (Rect) -> Unit = {})
val LocalLaunchLanding = staticCompositionLocalOf { LaunchLanding() }

private data class LaunchConfiguration(
    val dark: Boolean, val reduced: Boolean, val active: Boolean, val ready: Boolean, val target: Rect?,
)

@Composable
fun LaunchMotion(dark: Boolean, reduced: Boolean, ready: Boolean, target: Rect?, onFinished: () -> Unit) {
    val owner = LocalLifecycleOwner.current
    var active by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var rendered by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<OfflineLaunchWebView?>(null) }
    val finish by rememberUpdatedState(onFinished)

    DisposableEffect(owner, webView) {
        val view = webView
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> { active = true; view?.onResume() }
                Lifecycle.Event.ON_PAUSE -> { active = false; view?.pauseScene() }
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(active, preparing) {
        if (active) {
            delay(8_000)
            if (!rendered) finish()
        }
    }

    val foreground = if (dark) Color.White.copy(alpha = .8f) else Color(0xff5d6e9c)
    Box(Modifier.fillMaxSize()) {
        if (!rendered) {
            Box(Modifier.fillMaxSize().background(if (dark) Color(0xff101c36) else Color(0xfff3f6fe)))
            Image(painterResource(if (dark) R.drawable.launch_night else R.drawable.launch_day), null,
                Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        }
        AndroidView(
            factory = { context ->
                OfflineLaunchWebView(context) { type ->
                    when (type) {
                        "bridgeReady" -> preparing = true
                        "rendered" -> rendered = true
                        "landed", "failed" -> finish()
                    }
                }.also { webView = it }
            },
            modifier = Modifier.fillMaxSize(),
            update = { view ->
                view.configuration = LaunchConfiguration(dark, reduced, active, ready, target)
                if (active) view.onResume()
                view.sendConfiguration()
            },
            onRelease = { it.dispose() },
        )
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { finish() }, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text("跳过动画", fontSize = 12.sp, color = foreground)
                }
            }
            Spacer(Modifier.weight(1f))
            if (!ready) Text("正在接回你的书房", color = foreground.copy(alpha = .65f), fontSize = 11.sp,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 14.dp))
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private class OfflineLaunchWebView(context: Context, private val onMessage: (String) -> Unit) : WebView(context) {
    var configuration = LaunchConfiguration(false, false, true, false, null)
    private var bridgeReady = false
    private var disposed = false
    private var rendererGone = false
    private var lastPayload: String? = null
    private val createdAt = android.os.SystemClock.uptimeMillis()

    init {
        setBackgroundColor(AndroidColor.TRANSPARENT)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        isFocusable = false
        settings.apply {
            javaScriptEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            domStorageEnabled = false
            allowContentAccess = false
            allowFileAccess = true
            blockNetworkLoads = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 100
        }
        addJavascriptInterface(object {
            @JavascriptInterface
            fun postMessage(message: String) {
                if (message.length > 128) return
                val type = runCatching { JSONObject(message).optString("type") }.getOrNull() ?: return
                post {
                    if (!disposed) {
                        if (BuildConfig.DEBUG) android.util.Log.d("AstellaLaunch", type)
                        if (type == "bridgeReady") { bridgeReady = true; onMessage(type); sendConfiguration() }
                        else if (type in setOf("rendered", "landed", "failed")) onMessage(type)
                    }
                }
            }
        }, "AstellaMotionBridge")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !isPackaged(request.url)
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (isPackaged(request.url)) null else WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
            override fun onPageFinished(view: WebView, url: String) { sendConfiguration() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !disposed) onMessage("failed")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone = true
                if (!disposed) onMessage("failed")
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG && message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.e("AstellaLaunch", message.message().take(256))
                }
                return true
            }
        }
        // Packaged, offline artwork only. No account data is given to this bridge.
        loadUrl("file:///android_asset/launch-motion/index.html")
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        post { if (!disposed) sendConfiguration() }
    }

    fun sendConfiguration() {
        if (!bridgeReady || disposed) return
        val config = configuration
        val payload = JSONObject().put("dark", config.dark).put("reduced", config.reduced)
            .put("active", config.active).put("ready", config.ready)
        if (lastPayload == null) payload.put("elapsed", (android.os.SystemClock.uptimeMillis()-createdAt)/1000.0)
        val frame = config.target
        if (frame != null && frame.width > 0 && frame.height > 0) {
            val origin = IntArray(2)
            getLocationInWindow(origin)
            val density = resources.displayMetrics.density
            payload.put("target", JSONObject().put("x", (frame.left-origin[0])/density)
                .put("y", (frame.top-origin[1])/density).put("width", frame.width/density)
                .put("height", frame.height/density))
        } else payload.put("target", JSONObject.NULL)
        val json = payload.toString()
        if (json == lastPayload) return
        lastPayload = json
        if (BuildConfig.DEBUG) android.util.Log.d("AstellaLaunch", "configure dark=${config.dark} ready=${config.ready} target=${frame != null}")
        evaluateJavascript("window.AstellaLaunch?.update($json)", null)
    }

    fun pauseScene() {
        configuration = configuration.copy(active = false)
        sendConfiguration()
        onPause()
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        if (!rendererGone) evaluateJavascript("window.AstellaLaunch?.destroy()", null)
        stopLoading()
        removeJavascriptInterface("AstellaMotionBridge")
        onPause()
        destroy()
    }

    private fun isPackaged(url: Uri): Boolean = url.scheme == "file" &&
        url.path.orEmpty().startsWith("/android_asset/launch-motion/") && !url.path.orEmpty().contains("/../")
}
