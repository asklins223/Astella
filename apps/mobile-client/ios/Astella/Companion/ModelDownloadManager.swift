import Foundation
import Observation
import CryptoKit

// MARK: - 清单 DTO（服务端 GET /companion/model/manifest 响应）

/// 服务端 manifest 响应（`version:1` 信封）。`files[].download` 是对象存储预签名
/// 下载信息（~300s 过期），直传对象存储、**不再套 Bearer**；这里只取 `url`。
struct CompanionModelManifest: Decodable {
    struct Download: Decodable {
        let url: String
        let authorization: String?
    }
    struct File: Decodable {
        let path: String
        let contentType: String
        let byteLength: Int
        let sha256: String
        let download: Download
    }

    let version: Int
    let modelId: String
    let modelVersion: String
    let entry: String
    let files: [File]
}

/// 本地缓存清单：全部文件下载校验完成后原子写入版本目录。
struct CompanionLocalManifest: Codable {
    struct File: Codable {
        let path: String
        let byteLength: Int
        let sha256: String
    }

    let modelId: String
    let version: String
    let entry: String
    let files: [File]
    let completedAt: Date
}

// MARK: - ModelDownloadManager

/// 伴星 Live2D 模型下载与本地缓存（阶段 4a，SDK 无关）。
///
/// 目录结构：`Application Support/companion-model/<modelId>/<modelVersion>/<path>`，
/// 版本目录内全部就绪后原子写 `local-manifest.json` 作为「完整」标记。
///
/// 状态机：
/// - `idle` → 调用 `ensureModel()`；
/// - `downloading(0…1)` → 按已完成字节 / 总字节推进（并发上限 3，单文件重试 1 次）；
/// - `ready(version:root:entry:)` → 本次 manifest 与本地版本一致、或离线时命中任一完整缓存；
/// - `failed` → manifest 请求失败且本地无任何完整版本，或首次下载最终失败 → 上层走 PNG 降级。
///
/// 新版本下载失败时**保留旧版本可用**（失败只清理本次写入的不完整目录）。
@Observable
@MainActor
final class ModelDownloadManager {
    enum State: Equatable {
        case idle
        /// 0…1，按已完成字节 / 总字节。
        case downloading(Double)
        case ready(version: String, root: URL, entry: String)
        case failed
    }

    var state: State = .idle

    private let api: MobileAPI
    private var isEnsuring = false

    init(api: MobileAPI) {
        self.api = api
    }

    /// 模型缓存根目录：`Application Support/companion-model/`。
    nonisolated static var cacheRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("companion-model", isDirectory: true)
    }

    /// 调试用：清空全部本地模型缓存（下次 `ensureModel()` 重新下载）。
    nonisolated static func resetCache() {
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    /// 请求 manifest → 校验/下载本地版本 → ready 或降级。
    /// 与上层并发安全：重复调用在进行中直接返回。
    func ensureModel() async {
        guard !isEnsuring else { return }
        isEnsuring = true
        defer { isEnsuring = false }

        // Manifest 通过 MobileAPI 泛型出口请求（自动带 Bearer 与 api.baseURL 覆盖）。
        let manifest: CompanionModelManifest
        do {
            manifest = try await api.request("/companion/model/manifest")
        } catch {
            // 离线 / 请求失败：任一完整本地版本可用则缓存 ready，否则 failed（PNG 降级）。
            if let cached = bestLocalVersion() {
                state = .ready(version: cached.version, root: cached.root, entry: cached.entry)
            } else {
                state = .failed
            }
            return
        }

        let versionRoot = versionDirectory(modelId: manifest.modelId, version: manifest.modelVersion)
        if isVersionComplete(at: versionRoot, manifest: manifest) {
            state = .ready(version: manifest.modelVersion, root: versionRoot, entry: manifest.entry)
            return
        }

        await downloadAndInstall(manifest, into: versionRoot)
    }

    // MARK: 下载与安装

    private func downloadAndInstall(_ manifest: CompanionModelManifest, into versionRoot: URL) async {
        let fileManager = FileManager.default
        // 重新下载：清掉同版本的不完整残留，从干净目录开始。
        try? fileManager.removeItem(at: versionRoot)
        do {
            try fileManager.createDirectory(at: versionRoot, withIntermediateDirectories: true)
        } catch {
            failKeepingOldVersion()
            return
        }

        let totalBytes = Int64(manifest.files.reduce(0) { $0 + $1.byteLength })
        state = .downloading(0)

        // 并发下载上限 3：按批分组，每批内并行、批间串行（简单可预期，进度单调）。
        var completedBytes: Int64 = 0
        do {
            for batch in manifest.files.chunked(into: 3) {
                try await withThrowingTaskGroup(of: Int64.self) { group in
                    for file in batch {
                        group.addTask { [self] in
                            let data = try await fetchWithRetry(file)
                            try Self.write(data, at: versionRoot.appendingPathComponent(file.path))
                            return Int64(data.count)
                        }
                    }
                    for try await bytes in group {
                        completedBytes += bytes
                        if totalBytes > 0 {
                            state = .downloading(min(1, Double(completedBytes) / Double(totalBytes)))
                        }
                    }
                }
            }
        } catch {
            // 单文件重试后仍失败：只清本次不完整目录，旧版本保持可用。
            try? fileManager.removeItem(at: versionRoot)
            failKeepingOldVersion()
            return
        }

        let local = CompanionLocalManifest(
            modelId: manifest.modelId,
            version: manifest.modelVersion,
            entry: manifest.entry,
            files: manifest.files.map {
                .init(path: $0.path, byteLength: $0.byteLength, sha256: $0.sha256)
            },
            completedAt: Date()
        )
        do {
            try writeLocalManifest(local, at: versionRoot)
        } catch {
            try? fileManager.removeItem(at: versionRoot)
            failKeepingOldVersion()
            return
        }

        // 完成：切换到新版本，删除同模型的其他旧版本目录。
        removeOtherVersions(keeping: versionRoot, modelId: manifest.modelId)
        state = .ready(version: manifest.modelVersion, root: versionRoot, entry: manifest.entry)
    }

    /// 下载单文件并重试 1 次。预签名 URL 直传对象存储，不套 Bearer。
    private func fetchWithRetry(_ file: CompanionModelManifest.File) async throws -> Data {
        do {
            return try await fetchAndValidate(file)
        } catch {
            return try await fetchAndValidate(file)
        }
    }

    private func fetchAndValidate(_ file: CompanionModelManifest.File) async throws -> Data {
        let downloadURL = file.download.url.hasPrefix("/") ? try api.url(file.download.url) : URL(string: file.download.url)
        guard let url = downloadURL else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        if file.download.authorization == "session", let token = api.token,
           let origin = URL(string: api.baseURL), url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        guard data.count == file.byteLength else {
            throw URLError(.cannotDecodeContentData)
        }
        let digest = SHA256.hash(data: data)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        guard hex == file.sha256.lowercased() else {
            throw URLError(.cannotDecodeContentData)
        }
        return data
    }

    // MARK: 本地缓存查询

    private func versionDirectory(modelId: String, version: String) -> URL {
        Self.cacheRoot
            .appendingPathComponent(modelId, isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
    }

    /// 版本目录完整 = 本地清单可解码、且清单列出的每个文件都在、字节数一致
    /// （sha256 已在下载时校验，此处不重复散列）。
    private func isVersionComplete(at root: URL, manifest: CompanionModelManifest) -> Bool {
        guard let local = readLocalManifest(at: root) else { return false }
        guard local.version == manifest.modelVersion,
              local.entry == manifest.entry,
              local.files.count == manifest.files.count else { return false }
        let expected = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0.byteLength) })
        let fileManager = FileManager.default
        for file in local.files {
            guard expected[file.path] == file.byteLength else { return false }
            let url = root.appendingPathComponent(file.path)
            guard let attrs = try? fileManager.attributesOfItem(atPath: url.path),
                  let size = attrs[.size] as? Int, size == file.byteLength else { return false }
        }
        return true
    }

    /// 扫描全部本地版本，取完成时间最近的完整版本（离线兜底用）。
    private func bestLocalVersion() -> (version: String, root: URL, entry: String)? {
        let fileManager = FileManager.default
        guard let modelDirs = try? fileManager.contentsOfDirectory(
            at: Self.cacheRoot, includingPropertiesForKeys: nil
        ) else { return nil }
        var best: (completedAt: Date, version: String, root: URL, entry: String)?
        for modelDir in modelDirs {
            guard let versionDirs = try? fileManager.contentsOfDirectory(
                at: modelDir, includingPropertiesForKeys: nil
            ) else { continue }
            for versionDir in versionDirs {
                guard let local = readLocalManifest(at: versionDir),
                      isLocalVersionSelfConsistent(local, root: versionDir) else { continue }
                if best == nil || local.completedAt > best!.completedAt {
                    best = (local.completedAt, local.version, versionDir, local.entry)
                }
            }
        }
        return best.map { (version: $0.version, root: $0.root, entry: $0.entry) }
    }

    private func isLocalVersionSelfConsistent(_ local: CompanionLocalManifest, root: URL) -> Bool {
        let fileManager = FileManager.default
        return local.files.allSatisfy { file in
            let url = root.appendingPathComponent(file.path)
            guard let attrs = try? fileManager.attributesOfItem(atPath: url.path),
                  let size = attrs[.size] as? Int else { return false }
            return size == file.byteLength
        }
    }

    private func readLocalManifest(at root: URL) -> CompanionLocalManifest? {
        let url = root.appendingPathComponent("local-manifest.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CompanionLocalManifest.self, from: data)
    }

    /// 原子写本地清单：写临时文件后替换，`local-manifest.json` 出现即视为版本完整。
    private func writeLocalManifest(_ local: CompanionLocalManifest, at root: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        var data = try encoder.encode(local)
        data.append(0x0A)
        try data.write(to: root.appendingPathComponent("local-manifest.json"), options: .atomic)
    }

    nonisolated private static func write(_ data: Data, at url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: url, options: .atomic)
    }

    /// 失败收尾：有完整旧版本就保持 ready，否则 failed（PNG 降级）。
    private func failKeepingOldVersion() {
        if let cached = bestLocalVersion() {
            state = .ready(version: cached.version, root: cached.root, entry: cached.entry)
        } else {
            state = .failed
        }
    }

    private func removeOtherVersions(keeping current: URL, modelId: String) {
        let modelDir = current.deletingLastPathComponent()
        guard let siblings = try? FileManager.default.contentsOfDirectory(
            at: modelDir, includingPropertiesForKeys: nil
        ) else { return }
        for sibling in siblings where sibling.standardizedFileURL != current.standardizedFileURL {
            try? FileManager.default.removeItem(at: sibling)
        }
    }
}

private extension Array {
    /// 按批切分（并发上限：批大小 3）。
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0, !isEmpty else { return [] }
        var chunks: [[Element]] = []
        var current: [Element] = []
        for element in self {
            current.append(element)
            if current.count == size {
                chunks.append(current)
                current = []
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}
