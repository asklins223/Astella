import AVFoundation
import Foundation
import Observation

@Observable
@MainActor
final class VoiceCapture {
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startedAt = Date()
    private(set) var isRecording = false
    private(set) var isTranscribing = false
    private(set) var transcript = ""

    func start(store: AppStore) {
        guard !isRecording, !isTranscribing else { return }
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
            Task { @MainActor in
                guard let self else { return }
                guard allowed else {
                    store.errorMessage = "没有麦克风权限。请在系统设置里允许后再试。"
                    return
                }
                do {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.record, mode: .spokenAudio, options: [.duckOthers])
                    try session.setActive(true)
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent("astella-\(UUID().uuidString).wav")
                    let settings: [String: Any] = [
                        AVFormatIDKey: Int(kAudioFormatLinearPCM),
                        AVSampleRateKey: 16_000,
                        AVNumberOfChannelsKey: 1,
                        AVLinearPCMBitDepthKey: 16,
                        AVLinearPCMIsBigEndianKey: false,
                        AVLinearPCMIsFloatKey: false
                    ]
                    let recorder = try AVAudioRecorder(url: url, settings: settings)
                    recorder.isMeteringEnabled = true
                    guard recorder.record() else {
                        throw MobileAPIError(status: 0, code: "recording_failed", message: "无法开始录音。")
                    }
                    self.fileURL = url
                    self.recorder = recorder
                    self.startedAt = Date()
                    self.transcript = ""
                    self.isRecording = true
                    store.errorMessage = nil
                } catch {
                    store.errorMessage = error.localizedDescription
                }
            }
        }
    }

    func finish(store: AppStore) async -> String? {
        guard isRecording, let recorder, let fileURL else { return nil }
        isRecording = false
        recorder.stop()
        let duration = Int(Date().timeIntervalSince(startedAt) * 1_000)
        defer {
            self.recorder = nil
            self.fileURL = nil
            try? FileManager.default.removeItem(at: fileURL)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        guard duration >= 200 else {
            store.errorMessage = "这段录音太短了，再说一句试试。"
            return nil
        }
        isTranscribing = true
        defer { isTranscribing = false }
        do {
            let data = try Data(contentsOf: fileURL)
            let result = try await store.api.transcribeWAV(data, durationMilliseconds: min(duration, 60_000))
            guard let text = result["text"] as? String, !text.isEmpty else {
                store.errorMessage = "没有听清这句话，你可以重录或直接打字。"
                return nil
            }
            transcript = text
            store.acceptTranscription(result)
            store.errorMessage = nil
            return text
        } catch {
            store.errorMessage = error.localizedDescription
            return nil
        }
    }
}
