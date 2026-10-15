package com.astella.mobile.companion

import android.content.Context
import android.content.res.AssetManager
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.os.Handler
import android.os.HandlerThread
import android.view.Choreographer
import android.view.Surface
import android.view.TextureView
import java.util.concurrent.atomic.AtomicInteger

object NativeCompanion {
    init { System.loadLibrary("astella_companion") }
    external fun create(assets: AssetManager): Long
    external fun load(handle: Long, root: String, entry: String): Boolean
    external fun resize(handle: Long, width: Int, height: Int)
    external fun draw(handle: Long, delta: Float, mouth: Float, reduced: Boolean, event: Int)
    external fun destroy(handle: Long)
}

/** Cubism caches shader programs process-wide. One shared EGL context and render
 * looper keep those programs valid across tab/sheet replacement, including an
 * interrupted exit. Individual stages own only their window surface and model. */
private object CompanionRenderContext {
    val thread = HandlerThread("astella-companion-render").apply { start() }
    val handler = Handler(thread.looper)
    var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    var context: EGLContext = EGL14.EGL_NO_CONTEXT
    var config: EGLConfig? = null
    fun ensure() {
        if (context != EGL14.EGL_NO_CONTEXT) return
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(EGL14.eglInitialize(display, IntArray(2), 0, IntArray(2), 1))
        val choices = arrayOfNulls<EGLConfig>(1)
        check(EGL14.eglChooseConfig(display, intArrayOf(EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,EGL14.EGL_NONE),0,choices,0,1,IntArray(1),0))
        config = choices[0]
        context = EGL14.eglCreateContext(display,config,EGL14.EGL_NO_CONTEXT,intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE),0)
        check(context != EGL14.EGL_NO_CONTEXT)
    }
}

class CompanionSurface(context: Context, private val model: CachedCompanionModel, private val onFailure: () -> Unit) : TextureView(context), TextureView.SurfaceTextureListener {
    private val renderer = CompanionRenderContext
    private val handler = renderer.handler
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var surface: Surface? = null
    private var texture: SurfaceTexture? = null
    private var handle = 0L
    private var lastFrame = 0L
    private var clock: Choreographer? = null
    private var scheduled = false
    private var paused = false
    private var disposed = false
    @Volatile var mouth = 0f
    @Volatile var reduced = false
    private val pendingEvent = AtomicInteger(0)
    var event: Int
        get() = pendingEvent.get()
        set(value) { pendingEvent.set(value) }
    private fun makeCurrent(): Boolean = eglSurface != EGL14.EGL_NO_SURFACE &&
        EGL14.eglMakeCurrent(renderer.display,eglSurface,eglSurface,renderer.context)
    private val frame = Choreographer.FrameCallback { time ->
        scheduled = false
        if (!paused && !disposed && handle != 0L) {
            if (!makeCurrent()) fail()
            else {
                val delta = if (lastFrame == 0L) 0f else ((time - lastFrame) / 1_000_000_000f).coerceIn(0f, .05f)
                lastFrame = time
                NativeCompanion.draw(handle,delta,mouth,reduced,if (reduced) 0 else pendingEvent.getAndSet(0))
                if (!EGL14.eglSwapBuffers(renderer.display,eglSurface)) fail()
                else if (!reduced) schedule()
            }
        }
    }
    init { isOpaque = false; surfaceTextureListener = this }
    private fun schedule() {
        if (!scheduled && !paused && !disposed && handle != 0L) { scheduled = true; clock?.postFrameCallback(frame) }
    }
    fun requestRender() { handler.post { schedule() } }
    fun onPause() { handler.post { paused = true; scheduled = false; clock?.removeFrameCallback(frame); lastFrame = 0 } }
    fun onResume() { handler.post { paused = false; schedule() } }
    override fun onSurfaceTextureAvailable(value: SurfaceTexture, width: Int, height: Int) {
        handler.post {
            if (disposed) return@post
            try {
                renderer.ensure()
                texture = value; surface = Surface(value)
                eglSurface = EGL14.eglCreateWindowSurface(renderer.display,renderer.config,surface,intArrayOf(EGL14.EGL_NONE),0)
                check(makeCurrent())
                clock = Choreographer.getInstance()
                handle = NativeCompanion.create(context.assets)
                NativeCompanion.resize(handle,width,height)
                check(NativeCompanion.load(handle,model.root,model.entry))
                schedule()
            } catch (_: Exception) { fail() }
        }
    }
    override fun onSurfaceTextureSizeChanged(value: SurfaceTexture, width: Int, height: Int) {
        handler.post { if (texture === value && handle != 0L) { NativeCompanion.resize(handle,width,height); schedule() } }
    }
    override fun onSurfaceTextureUpdated(value: SurfaceTexture) = Unit
    override fun onSurfaceTextureDestroyed(value: SurfaceTexture): Boolean {
        // Return ownership synchronously; release on the render queue after the
        // last frame. No timer races with a later attachment or render task.
        handler.post { if (texture === value) { release(); texture = null }; value.release() }
        return false
    }
    private fun fail() { release(); post { if (!disposed) onFailure() } }
    private fun release() {
        clock?.removeFrameCallback(frame); scheduled = false
        if (handle != 0L) { makeCurrent(); NativeCompanion.destroy(handle); handle = 0 }
        EGL14.eglMakeCurrent(renderer.display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT)
        if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(renderer.display,eglSurface)
        surface?.release(); surface = null; eglSurface = EGL14.EGL_NO_SURFACE; lastFrame = 0
    }
    fun dispose() { handler.post { disposed = true; release() } }
}
