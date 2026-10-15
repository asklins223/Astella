import Foundation

// MARK: - Hand（手边 · 个人陪伴约定）

extension AppStore {
    func loadParticipation() async throws -> [String: Any] {
        try await api.request("/me/companion/participation") as? [String: Any] ?? [:]
    }

    func saveParticipation(expectedRevision: Int, markdown: String, enabled: Bool) async throws -> [String: Any] {
        try await api.request("/me/companion/participation", method: "PUT", body: [
            "expectedRevision": expectedRevision, "markdown": markdown, "enabled": enabled,
        ]) as? [String: Any] ?? [:]
    }
}
