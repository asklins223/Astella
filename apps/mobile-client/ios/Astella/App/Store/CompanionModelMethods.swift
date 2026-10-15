import Foundation

// MARK: - CompanionModel（伴星 Live2D 模型缓存）

extension AppStore {
    /// 会话恢复成功后触发模型下载/校验。
    /// fire-and-forget：失败由 `ModelDownloadManager` 落 `failed` 或退回旧版本，
    /// 页面继续用 PNG 降级，不影响会话流程。
    func startCompanionModelDownload() {
        Task { await companionModel.ensureModel() }
    }
}
