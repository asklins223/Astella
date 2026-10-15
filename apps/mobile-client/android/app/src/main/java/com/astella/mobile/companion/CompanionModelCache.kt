package com.astella.mobile.companion

import android.content.Context
import com.astella.mobile.data.MobileApi
import com.astella.mobile.data.objects
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

data class CachedCompanionModel(val root: String, val entry: String)

class CompanionModelCache(private val context: Context, private val api: MobileApi) {
    private fun safePath(path: String): Boolean = path.isNotBlank() && !path.startsWith('/') && '\\' !in path && path.split('/').none { it == ".." || it == "." }
    fun load(): CachedCompanionModel? {
        val cache = File(context.filesDir, "companion-model")
        val complete = File(cache, "manifest.json")
        fun existing(): CachedCompanionModel? = runCatching {
            val manifest = JSONObject(complete.readText())
            val entry = manifest.getString("entry")
            if (!safePath(entry)) return@runCatching null
            for (file in manifest.getJSONArray("files").objects()) {
                val path = file.getString("path")
                if (!safePath(path)) return@runCatching null
                val local = File(cache, path)
                if (!local.isFile || local.length() != file.getLong("byteLength")) return@runCatching null
                val digest = local.inputStream().use { input -> val md = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(8192)
                    while (true) { val count = input.read(buffer); if (count < 0) break; md.update(buffer, 0, count) }; md.digest().joinToString("") { "%02x".format(it) } }
                if (digest != file.getString("sha256")) return@runCatching null
            }
            CachedCompanionModel(cache.absolutePath, entry)
        }.getOrNull()
        val old = existing()
        val manifest = runCatching { api.request("/companion/model/manifest") }.getOrElse { return old }
        if (old != null && runCatching { JSONObject(complete.readText()).optString("modelVersion") == manifest.getString("modelVersion") }.getOrDefault(false)) return old
        val entry = manifest.getString("entry")
        val files = manifest.getJSONArray("files").objects()
        if (!safePath(entry) || files.size !in 1..500 || files.sumOf { it.getLong("byteLength") } > 200L * 1024 * 1024) return old
        val staging = File(context.cacheDir, "companion-model-${java.util.UUID.randomUUID()}")
        try {
            staging.mkdirs()
            for (file in files) {
                val path = file.getString("path")
                val expected = file.getLong("byteLength")
                if (!safePath(path) || expected !in 1..64L * 1024 * 1024) throw IOException("模型文件清单无效。")
                val target = File(staging, path)
                target.parentFile?.mkdirs()
                // Presigned object URLs receive no API bearer credential.
                val download = file.getJSONObject("download")
                val address = download.getString("url")
                val url = if (address.startsWith("/")) api.url(address) else address
                val builder = Request.Builder().url(url)
                if (download.optString("authorization") == "session" && address.startsWith("/companion/model/files/")) {
                    api.token?.let { builder.header("Authorization", "Bearer $it") }
                }
                api.client.newCall(builder.build()).execute().use { response ->
                    if (!response.isSuccessful) throw IOException("模型下载没有完成。")
                    val digest = MessageDigest.getInstance("SHA-256")
                    var count = 0L
                    response.body.byteStream().use { input -> target.outputStream().use { output ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            val size = input.read(buffer); if (size < 0) break
                            count += size
                            if (count > expected) throw IOException("模型文件大小不符。")
                            digest.update(buffer, 0, size); output.write(buffer, 0, size)
                        }
                    } }
                    if (count != expected || digest.digest().joinToString("") { "%02x".format(it) } != file.getString("sha256")) throw IOException("模型校验未通过。")
                }
            }
            File(staging, "manifest.json").writeText(manifest.toString())
            // Keep the verified previous version until the new directory is complete.
            val backup = File(context.filesDir, "companion-model-previous")
            backup.deleteRecursively()
            if (cache.exists() && !cache.renameTo(backup)) throw IOException("模型缓存暂时无法更新。")
            if (!staging.renameTo(cache)) { backup.renameTo(cache); throw IOException("模型缓存暂时无法更新。") }
            backup.deleteRecursively()
            return CachedCompanionModel(cache.absolutePath, entry)
        } catch (_: Exception) { return old }
        finally { staging.deleteRecursively() }
    }
}
