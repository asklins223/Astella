package com.astella.mobile.data

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import kotlin.math.sqrt

/** Decode actual PCM energy once; playback reads the envelope at its real position. */
object AudioEnvelope {
    fun decode(file: File): List<Float> {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            extractor.setDataSource(file.absolutePath)
            val track = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: return emptyList()
            extractor.selectTrack(track)
            val format = extractor.getTrackFormat(track)
            val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec = decoder
            decoder.configure(format, null, null, 0); decoder.start()
            var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            var sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val output = mutableListOf<Float>()
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var energy = 0.0; var samples = 0
            val deadline = android.os.SystemClock.elapsedRealtime() + 6000
            while (android.os.SystemClock.elapsedRealtime() < deadline) {
                if (!inputDone) {
                    val index = decoder.dequeueInputBuffer(1000)
                    if (index >= 0) {
                        val buffer = decoder.getInputBuffer(index)!!
                        val size = extractor.readSampleData(buffer, 0)
                        if (size < 0) {
                            decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true
                        } else {
                            decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0); extractor.advance()
                        }
                    }
                }
                val index = decoder.dequeueOutputBuffer(info, 1000)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    channels = decoder.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    sampleRate = decoder.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                } else if (index >= 0) {
                    val pcm = decoder.getOutputBuffer(index)!!
                    pcm.position(info.offset); pcm.limit(info.offset + info.size)
                    pcm.order(java.nio.ByteOrder.LITTLE_ENDIAN)
                    while (pcm.remaining() >= 2) {
                        val value = pcm.short.toDouble() / 32768
                        energy += value * value; samples++
                        if (samples >= sampleRate * channels * 40 / 1000) {
                            output += (sqrt(energy / samples) * 5).toFloat().coerceIn(0f, 1f)
                            energy = 0.0; samples = 0
                        }
                    }
                    decoder.releaseOutputBuffer(index, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
            return output
        } catch (_: Exception) { return emptyList() }
        finally { runCatching { codec?.stop() }; codec?.release(); extractor.release() }
    }
}
