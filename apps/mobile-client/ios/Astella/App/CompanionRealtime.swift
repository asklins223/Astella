import Foundation

@MainActor
final class CompanionRealtime {
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var stopped = true
    private var retry = 0
    private var token = ""
    private var conversationId = ""
    private var cursor = 0
    private var api: MobileAPI?
    private var pendingCommands: [String: CheckedContinuation<CompanionTurnSubmitResponseDTO, Error>] = [:]
    private(set) var isReady = false
    var onEvent: (@MainActor ([String: Any]) -> Void)?
    var onState: (@MainActor (String) -> Void)?

    func start(api: MobileAPI, conversationId: String, cursor: Int) {
        stop()
        guard let token = api.token, !token.isEmpty,
              let endpoint = try? api.url("/companion/realtime") else {
            onState?("离线")
            return
        }
        self.api = api
        self.token = token
        self.conversationId = conversationId
        self.cursor = cursor
        stopped = false
        retry = 0
        connect(endpoint)
    }

    func stop() {
        stopped = true
        isReady = false
        receiveTask?.cancel()
        receiveTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        for continuation in pendingCommands.values {
            continuation.resume(throwing: MobileAPIError(status: 503, code: "realtime_closed", message: "连接已关闭。"))
        }
        pendingCommands.removeAll()
    }

    func submit(_ body: [String: Any]) async throws -> CompanionTurnSubmitResponseDTO {
        guard isReady, let socket else {
            throw MobileAPIError(status: 503, code: "realtime_unavailable", message: "实时连接正在恢复。")
        }
        let requestId = body["clientMessageId"] as? String ?? UUID().uuidString.lowercased()
        let envelope: [String: Any] = [
            "version": 1,
            "type": "turn.submit",
            "requestId": requestId,
            "conversationId": conversationId,
            "body": body
        ]
        return try await withCheckedThrowingContinuation { continuation in
            pendingCommands[requestId] = continuation
            Task { @MainActor [weak self, weak socket] in
                guard let self, let socket else {
                    self?.finishCommand(requestId, result: .failure(MobileAPIError(status: 503, code: "realtime_closed", message: "连接已关闭。")))
                    return
                }
                do {
                    try await socket.send(.string(Self.encode(envelope)))
                } catch {
                    self.finishCommand(requestId, result: .failure(error))
                    return
                }
                try? await Task.sleep(for: .seconds(6))
                self.finishCommand(requestId, result: .failure(MobileAPIError(status: 503, code: "realtime_timeout", message: "实时连接没有确认发送结果。")))
            }
        }
    }

    private func connect(_ endpoint: URL) {
        guard !stopped else { return }
        isReady = false
        onState?(retry == 0 ? "正在连接" : "正在重连")
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        components?.scheme = endpoint.scheme == "https" ? "wss" : "ws"
        guard let url = components?.url else {
            scheduleReconnect(endpoint)
            return
        }
        let next = URLSession.shared.webSocketTask(with: url)
        socket = next
        next.resume()
        receiveTask = Task { [weak self, weak next] in
            guard let self, let next else { return }
            do {
                try await next.send(.string(Self.encode([
                    "version": 1,
                    "type": "auth",
                    "token": self.token
                ])))
                while !Task.isCancelled, self.socket === next {
                    let message = try await next.receive()
                    if case .string(let text) = message {
                        self.handle(text, socket: next, endpoint: endpoint)
                    }
                }
            } catch {
                guard self.socket === next, !self.stopped else { return }
                self.isReady = false
                self.onState?("连接中断")
                self.scheduleReconnect(endpoint)
            }
        }
    }

    private func handle(_ text: String, socket: URLSessionWebSocketTask, endpoint: URL) {
        guard let data = text.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = message["type"] as? String else { return }
        switch type {
        case "auth.ok":
            Task {
                try? await socket.send(.string(Self.encode([
                    "version": 1,
                    "type": "subscribe",
                    "conversationId": conversationId,
                    "after": cursor
                ])))
            }
        case "subscribed":
            isReady = true
            retry = 0
            onState?("已连接")
            if let value = message["cursor"] as? Int { cursor = max(cursor, value) }
        case "event":
            if let event = message["event"] as? [String: Any] {
                if let seq = event["seq"] as? Int { cursor = max(cursor, seq) }
                onEvent?(event)
            }
        case "turn.result":
            guard let requestId = message["requestId"] as? String else { return }
            if message["ok"] as? Bool == true {
                do {
                    let result = try JSONSerialization.data(withJSONObject: message["result"] ?? [:])
                    finishCommand(requestId, result: .success(try JSONDecoder().decode(CompanionTurnSubmitResponseDTO.self, from: result)))
                } catch { finishCommand(requestId, result: .failure(error)) }
            } else if let error = message["error"] as? [String: Any] {
                finishCommand(requestId, result: .failure(MobileAPIError(
                    status: error["statusCode"] as? Int ?? 400,
                    code: error["code"] as? String ?? "turn_failed",
                    message: error["message"] as? String ?? "发送没有完成。"
                )))
            }
        case "ping":
            Task { try? await socket.send(.string(Self.encode(["version": 1, "type": "pong"]))) }
        case "error":
            if let error = message["error"] as? [String: Any],
               let code = error["code"] as? String,
               code == "CURSOR_EXPIRED" || code == "INVALID_CURSOR" {
                onEvent?(["type": "sync.required"])
            } else if let error = message["error"] as? [String: Any] {
                onState?(error["message"] as? String ?? "实时连接遇到问题")
            }
        default:
            break
        }
    }

    private func scheduleReconnect(_ endpoint: URL) {
        guard !stopped, reconnectTask == nil else { return }
        let delay = min(20_000, 700 * (1 << min(retry, 5)))
        retry += 1
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard let self, !self.stopped else { return }
            self.reconnectTask = nil
            self.connect(endpoint)
        }
    }

    private static func encode(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func finishCommand(_ requestId: String, result: Result<CompanionTurnSubmitResponseDTO, Error>) {
        guard let continuation = pendingCommands.removeValue(forKey: requestId) else { return }
        continuation.resume(with: result)
    }
}
