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
    private(set) var level: Double = 0
    private var meterTask: Task<Void, Never>?
    private var activation = UUID()
    private var isRequestingPermission = false
    func cancel() {
        activation = UUID()
        isRequestingPermission = false
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func start(store: AppStore) {
        guard !isRecording, !isTranscribing, !isRequestingPermission else { return }
        isRequestingPermission = true
        activation = UUID()
        let request = activation
        store.voicePlayback.stop()
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
            Task { @MainActor in
                guard let self, self.activation == request else { return }
                self.isRequestingPermission = false
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
                    self.meterTask = Task { [weak self] in
                        while !Task.isCancelled {
                            guard let self, self.isRecording else { return }
                            recorder.updateMeters()
                            let target = min(1, pow(10, Double(recorder.averagePower(forChannel: 0)) / 30))
                            self.level = self.level * 0.65 + target * 0.35
                            if Date().timeIntervalSince(self.startedAt) >= 59 {
                                Task { if let text = await self.finish(store: store) { store.draft = text } }
                                return
                            }
                            try? await Task.sleep(for: .milliseconds(40))
                        }
                    }
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
        meterTask?.cancel()
        meterTask = nil
        level = 0
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
