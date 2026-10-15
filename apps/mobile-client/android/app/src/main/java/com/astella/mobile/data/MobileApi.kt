package com.astella.mobile.data

import android.content.Context
import android.net.Uri
import com.astella.mobile.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.io.IOException
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

class ApiFailure(val status: Int, val code: String, override val message: String) : IOException(message)

class MobileApi(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("astella.settings", Context.MODE_PRIVATE)
    var baseUrl: String
        get() = prefs.getString("api.baseUrl", null) ?: BuildConfig.API_ORIGIN
        set(value) { prefs.edit().putString("api.baseUrl", value.trimEnd('/')).apply() }
    var token: String? = TokenStore.read(appContext)

    val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    fun url(path: String): String = baseUrl.trimEnd('/') + "/" + (if (path.startsWith("/api/uploads/")) path.removePrefix("/api") else path).trimStart('/')

    fun request(path: String, method: String = "GET", body: JSONObject? = null, idempotencyKey: String? = null): JSONObject {
        val builder = Request.Builder().url(url(path)).header("Accept", "application/json")
        token?.let { builder.header("Authorization", "Bearer $it") }
        idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        val payload = body?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaType())
        builder.method(method, if (method == "GET" || method == "HEAD") null else payload ?: ByteArray(0).toRequestBody(null))
        return execute(builder.build())
    }

    fun uploadImage(uri: Uri, fileName: String): JSONObject {
        val bytes = appContext.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (output.size() + read > 10 * 1024 * 1024) throw IOException("图片不能超过 10 MB。")
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        } ?: throw IOException("无法读取这张图片。")
        val type = appContext.contentResolver.getType(uri)?.toMediaType() ?: "image/jpeg".toMediaType()
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(type))
            .build()
        val request = Request.Builder().url(url("/uploads/companion-images"))
            .post(body).authenticated().build()
        return execute(request)
    }

    fun uploadAvatar(uri: Uri): JSONObject {
        val mime = appContext.contentResolver.getType(uri)?.lowercase()
            ?: throw IOException("无法识别这张图片的格式。")
        if (mime !in setOf("image/png", "image/jpeg", "image/gif", "image/webp")) {
            throw IOException("头像支持 PNG、JPEG、GIF 或 WebP 图片。")
        }
        val bytes = appContext.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (output.size() + read > 10 * 1024 * 1024) throw IOException("头像不能超过 10 MB。")
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        }
            ?: throw IOException("无法读取这张图片。")
        if (bytes.isEmpty()) throw IOException("这张图片是空文件，请换一张再试。")
        val extension = when (mime) {
            "image/png" -> "png"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            else -> "jpg"
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "avatar.$extension", bytes.toRequestBody(mime.toMediaType()))
            .build()
        return execute(Request.Builder().url(url("/uploads/avatars")).post(body).authenticated().build())
    }

    fun uploadFile(file: CompanionFile): JSONObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name.replace("\r", "").replace("\n", "").replace("\"", ""), file.bytes.toRequestBody(file.mime.toMediaType())).build()
        return execute(Request.Builder().url(url("/uploads/companion-files")).post(body).authenticated().build())
    }

    fun synthesize(text: String): ByteArray {
        val body = JSONObject().put("text", text).toString().toRequestBody("application/json".toMediaType())
        return client.newCall(Request.Builder().url(url("/voice/tts")).post(body).authenticated().build()).execute().use { response ->
            if (!response.isSuccessful) throw failure(response.code, response.body.string())
            response.body.bytes()
        }
    }

    fun transcribe(wav: ByteArray, durationMs: Int): JSONObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("purpose", "companion_dialogue")
            .addFormDataPart("language", "zh-CN")
            .addFormDataPart("durationMs", durationMs.coerceIn(200, 60_000).toString())
            .addFormDataPart("file", "mobile-voice.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        return execute(Request.Builder().url(url("/voice/transcribe")).post(body).authenticated().build())
    }

    fun loadImage(address: String): ByteArray? {
        val target = if (address.startsWith("http")) address else url(address)
        val builder = Request.Builder().url(target).get()
        val targetUrl = target.toHttpUrl()
        val origin = baseUrl.toHttpUrl()
        if (targetUrl.host == origin.host && targetUrl.port == origin.port && targetUrl.scheme == origin.scheme) builder.authenticated()
        val request = builder.build()
        return client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw failure(response.code, response.body.string())
            response.body.bytes()
        }
    }

    private fun Request.Builder.authenticated(): Request.Builder {
        token?.let { header("Authorization", "Bearer $it") }
        return header("Accept", "application/json")
    }

    private fun execute(request: Request): JSONObject = client.newCall(request).execute().use { response ->
        val raw = response.body.string()
        if (!response.isSuccessful) throw failure(response.code, raw)
        if (raw.isBlank()) JSONObject() else JSONObject(raw)
    }

    private fun failure(status: Int, raw: String): ApiFailure {
        val body = runCatching { JSONObject(raw) }.getOrNull()
        val code = body?.optString("error")?.takeIf(String::isNotBlank) ?: "http_$status"
        val message = body?.optString("message")?.takeIf(String::isNotBlank) ?: "请求没有完成，请稍后重试。"
        return ApiFailure(status, code, message)
    }
}
