package com.astella.mobile.data

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException

/** Short, mono 16 kHz PCM capture; the raw recording is deleted after MiMo transcription. */
class VoiceRecorder {
    private var audioRecord: AudioRecord? = null
    @Volatile private var recording = false
    private var worker: Thread? = null
    private val output = ByteArrayOutputStream()
    private val sampleRate = 16_000
    @Volatile var level: Float = 0f
        private set

    @Synchronized
    fun start() {
        if (recording) return
        val minimum = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) throw IOException("设备不支持录音。")
        val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, sampleRate / 2))
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IOException("无法初始化麦克风。")
        }
        output.reset()
        recorder.startRecording()
        audioRecord = recorder
        recording = true
        worker = Thread {
            val chunk = ByteArray(3_200)
            while (recording) {
                val count = recorder.read(chunk, 0, chunk.size)
                if (count > 0) {
                    var sum = 0.0
                    for (index in 0 until count - 1 step 2) {
                        val sample = ((chunk[index].toInt() and 255) or (chunk[index + 1].toInt() shl 8)).toShort().toDouble() / 32768
                        sum += sample * sample
                    }
                    level = level * .65f + (kotlin.math.sqrt(sum / maxOf(1, count / 2)) * 5).toFloat().coerceIn(0f, 1f) * .35f
                    synchronized(output) {
                        // Hard cap prevents a background recorder from growing without bound.
                        if (output.size() < sampleRate * 2 * 60) output.write(chunk, 0, minOf(count, sampleRate * 2 * 60 - output.size()))
                    }
                }
            }
        }.apply { name = "astella-audio-capture"; start() }
    }

    @Synchronized
    fun finish(): Pair<ByteArray, Int> {
        val recorder = audioRecord ?: throw IOException("当前没有录音。")
        recording = false
        level = 0f
        worker?.join(500)
        recorder.stop()
        recorder.release()
        audioRecord = null
        worker = null
        val pcm = synchronized(output) { output.toByteArray() }
        val duration = pcm.size * 1_000 / (sampleRate * 2)
        return wav(pcm, sampleRate) to duration
    }

    private fun wav(pcm: ByteArray, rate: Int): ByteArray {
        val output = ByteArrayOutputStream(pcm.size + 44)
        val data = DataOutputStream(output)
        fun ascii(value: String) = data.writeBytes(value)
        fun little(value: Int) {
            data.writeByte(value and 0xff)
            data.writeByte((value shr 8) and 0xff)
            data.writeByte((value shr 16) and 0xff)
            data.writeByte((value shr 24) and 0xff)
        }
        fun littleShort(value: Int) {
            data.writeByte(value and 0xff)
            data.writeByte((value shr 8) and 0xff)
        }
        ascii("RIFF"); little(pcm.size + 36); ascii("WAVE")
        ascii("fmt "); little(16); littleShort(1)
        littleShort(1); little(rate); little(rate * 2)
        littleShort(2); littleShort(16)
        ascii("data"); little(pcm.size); data.write(pcm)
        data.flush()
        return output.toByteArray()
    }
}
