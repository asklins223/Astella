import Foundation

struct MobileAPIError: LocalizedError {
    var status: Int
    var code: String
    var message: String
    var errorDescription: String? { message }
}

@MainActor
final class MobileAPI {
    var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: "api.baseURL") }
    }
    var defaultBaseURL: String {
        #if DEBUG
        let debugOrigin = ProcessInfo.processInfo.environment["ASTELLA_API_ORIGIN"]
        #else
        let debugOrigin: String? = nil
        #endif
        let configured = debugOrigin
            ?? Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
            ?? "http://127.0.0.1:4000"
        return configured.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    var token: String?

    init() {
        #if DEBUG
        let debugOrigin = ProcessInfo.processInfo.environment["ASTELLA_API_ORIGIN"]
        #else
        let debugOrigin: String? = nil
        #endif
        let configured = debugOrigin ?? UserDefaults.standard.string(forKey: "api.baseURL")
            ?? Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
            ?? "http://127.0.0.1:4000"
        baseURL = configured.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        token = KeychainTokenStore.read()
    }

    func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(string: baseURL) else {
            throw MobileAPIError(status: 0, code: "invalid_origin", message: "服务地址格式不正确。")
        }
        components.path = path.hasPrefix("/api/uploads/") ? String(path.dropFirst(4)) : path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw MobileAPIError(status: 0, code: "invalid_url", message: "无法生成请求地址。")
        }
        return url
    }

    /// 传输层共用出口：组请求 → 发送 → HTTP 状态/错误信封判定，返回成功响应体。
    /// 两个 `request` 重载（[String:Any] 与泛型 Decodable）的错误形态都由这里决定。
    private func perform(_ path: String, method: String, body: Any?,
                         query: [URLQueryItem], idempotencyKey: String?) async throws -> Data {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw error
        }
        guard let response = response as? HTTPURLResponse else {
            throw MobileAPIError(status: 0, code: "network", message: "没有收到服务端响应。")
        }
        guard (200..<300).contains(response.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw MobileAPIError(
                status: response.statusCode,
                code: payload?["error"] as? String ?? "http_\(response.statusCode)",
                message: payload?["message"] as? String ?? "请求没有完成，请稍后重试。"
            )
        }
        return data
    }

    func request(_ path: String, method: String = "GET", body: Any? = nil,
                 query: [URLQueryItem] = [], idempotencyKey: String? = nil) async throws -> Any {
        let data = try await perform(path, method: method, body: body, query: query, idempotencyKey: idempotencyKey)
        if data.isEmpty { return NSNull() }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    /// 泛型 Decodable 出口：与 `[String:Any]` 出口共用 `perform`（HTTP 状态与错误信封
    /// 处理完全一致），仅把响应体交给 JSONDecoder。空响应按错误抛出（解码无从谈起）。
    func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                               query: [URLQueryItem] = [], idempotencyKey: String? = nil) async throws -> T {
        let data = try await perform(path, method: method, body: body, query: query, idempotencyKey: idempotencyKey)
        guard !data.isEmpty else {
            throw MobileAPIError(status: 200, code: "empty_response", message: "服务端返回了空响应。")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func imageData(_ address: String) async throws -> Data {
        let imageURL: URL
        if let absolute = URL(string: address), absolute.scheme != nil {
            imageURL = absolute
        } else {
            imageURL = try url(address)
        }
        var request = URLRequest(url: imageURL)
        request.timeoutInterval = 30
        if let token, let origin = URL(string: baseURL), imageURL.scheme == origin.scheme,
           imageURL.host == origin.host, imageURL.port == origin.port {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw MobileAPIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                                 code: "image_load_failed", message: "这张图片暂时无法打开。")
        }
        return data
    }

    func uploadImage(_ data: Data, fileName: String, mimeType: String, endpoint: String = "/uploads/companion-images") async throws -> [String: Any] {
        let boundary = "Astella-\(UUID().uuidString)"
        var request = URLRequest(url: try url(endpoint))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: ""))\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileAPIError(status: 0, code: "network", message: "图片上传没有收到服务端响应。")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any]
            throw MobileAPIError(status: http.statusCode, code: payload?["error"] as? String ?? "upload_failed",
                                 message: payload?["message"] as? String ?? "图片上传失败。")
        }
        return try JSONSerialization.jsonObject(with: responseData) as? [String: Any] ?? [:]
    }

    func uploadAvatar(_ data: Data, fileName: String, mimeType: String) async throws -> [String: Any] {
        guard data.count <= 10 * 1024 * 1024 else {
            throw MobileAPIError(status: 413, code: "avatar_too_large", message: "头像不能超过 10 MB。")
        }
        guard ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mimeType.lowercased()) else {
            throw MobileAPIError(status: 415, code: "avatar_type_not_supported", message: "请选择 PNG、JPG、GIF 或 WebP 图片。")
        }
        let boundary = "Astella-\(UUID().uuidString)"
        var request = URLRequest(url: try url("/uploads/avatars"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: ""))\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileAPIError(status: 0, code: "network", message: "头像上传没有收到服务端响应。")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any]
            throw MobileAPIError(status: http.statusCode, code: payload?["error"] as? String ?? "avatar_upload_failed",
                                 message: payload?["message"] as? String ?? "头像上传失败。")
        }
        return try JSONSerialization.jsonObject(with: responseData) as? [String: Any] ?? [:]
    }

    func synthesizeSpeech(_ text: String) async throws -> Data {
        try await perform("/voice/tts", method: "POST", body: ["text": text], query: [], idempotencyKey: nil)
    }

    func transcribeWAV(_ data: Data, durationMilliseconds: Int) async throws -> [String: Any] {
        let boundary = "Astella-\(UUID().uuidString)"
        var request = URLRequest(url: try url("/voice/transcribe"))
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("purpose", "companion_dialogue")
        field("language", "zh-CN")
        field("durationMs", String(durationMilliseconds))
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"mobile-voice.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MobileAPIError(status: 0, code: "network", message: "语音识别没有收到服务端响应。")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any]
            throw MobileAPIError(status: http.statusCode, code: payload?["error"] as? String ?? "transcription_failed",
                                 message: payload?["message"] as? String ?? "语音识别失败。")
        }
        return try JSONSerialization.jsonObject(with: responseData) as? [String: Any] ?? [:]
    }
}
