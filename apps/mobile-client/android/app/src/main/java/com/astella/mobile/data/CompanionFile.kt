package com.astella.mobile.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.UUID
import java.util.zip.ZipInputStream

data class CompanionFile(val name: String, val mime: String, val bytes: ByteArray, val text: String, val id: String = UUID.randomUUID().toString()) {
    companion object {
        fun read(context: Context, uri: Uri): CompanionFile {
            val resolver = context.contentResolver
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            } ?: uri.lastPathSegment ?: "文件"
            val bytes = resolver.openInputStream(uri)?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 20 * 1024 * 1024) throw IOException("文件不能超过 20 MB。")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }?.takeIf { it.isNotEmpty() } ?: throw IOException("这个文件是空的或无法读取。")
            val extension = name.substringAfterLast('.').lowercase()
            val mime: String
            val text: String
            when (extension) {
                "pdf" -> {
                    mime = "application/pdf"
                    PDFBoxResourceLoader.init(context)
                    text = PDDocument.load(bytes).use { document ->
                        if (document.isEncrypted) throw IOException("PDF 已加密，请先解锁。")
                        val stripper = PDFTextStripper()
                        val output = StringBuilder()
                        for (page in 1..document.numberOfPages) {
                            stripper.startPage = page; stripper.endPage = page
                            output.append(stripper.getText(document)).append("\n\n")
                            if (output.length > 100_000) throw IOException("正文超过 10 万字，请拆成几份。")
                        }
                        output.toString()
                    }
                }
                "docx" -> {
                    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    text = ZipInputStream(bytes.inputStream()).use { zip ->
                        var xml: ByteArray? = null
                        while (true) {
                            val entry = zip.nextEntry ?: break
                            if (entry.name == "word/document.xml") {
                                xml = zip.readNBytes(8_000_001)
                                if (xml.size > 8_000_000) throw IOException("Word 内容太大，请拆成几份。")
                                break
                            }
                        }
                        val data = xml ?: throw IOException("Word 文件损坏或缺少正文。")
                        val parser = XmlPullParserFactory.newInstance().newPullParser()
                        parser.setInput(data.inputStream(), "UTF-8")
                        val output = StringBuilder()
                        var inText = false
                        while (parser.eventType != XmlPullParser.END_DOCUMENT) {
                            when (parser.eventType) {
                                XmlPullParser.START_TAG -> when (parser.name.substringAfter(':')) {
                                    "t" -> inText = true
                                    "tab" -> output.append('\t')
                                    "br" -> output.append('\n')
                                }
                                XmlPullParser.TEXT -> if (inText) output.append(parser.text)
                                XmlPullParser.END_TAG -> when (parser.name.substringAfter(':')) {
                                    "t" -> inText = false
                                    "p" -> output.append('\n')
                                }
                            }
                            if (output.length > 100_000) throw IOException("正文超过 10 万字，请拆成几份。")
                            parser.next()
                        }
                        output.toString()
                    }
                }
                "txt", "md" -> {
                    mime = if (extension == "md") "text/markdown" else "text/plain"
                    text = if (bytes.size >= 2 && (bytes[0] == 0xff.toByte() && bytes[1] == 0xfe.toByte() || bytes[0] == 0xfe.toByte() && bytes[1] == 0xff.toByte()))
                        bytes.toString(Charsets.UTF_16) else Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                }
                else -> throw IOException("支持 PDF、Word（.docx）、TXT 和 Markdown。")
            }
            val clean = text.trim()
            if (clean.isEmpty()) throw IOException("文件里没有可读取的文字。扫描件可以作为图片交给伴星。")
            if (clean.length > 100_000) throw IOException("正文超过 10 万字，请拆成几份再发送。")
            return CompanionFile(name.take(200), mime, bytes, clean)
        }
    }
}
