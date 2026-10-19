import Foundation

// MARK: - Notes（列表、详情与批注）

extension AppStore {
    func requestNoteReference(_ noteId: String) {
        let trimmed = noteId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != noteDocument?.id else { return }
        #if DEBUG
        if uiReviewMode == "read", trimmed == "e1199b07-2a56-44fc-bba2-ae8d66af33cf" {
            noteDocument = NoteDocument([
                "noteId": trimmed,
                "title": "无标题笔记",
                "currentVersion": [
                    "versionId": "open-design-linked-note-v1",
                    "versionNo": 1,
                    "blocks": [["ordinal": 1, "type": "paragraph", "content": "这篇手记通过正文中的引用链接打开。"]],
                ],
            ])
            noteAnnotations = []
        }
        #endif
        pendingNoteReferenceID = trimmed
    }

    func loadNotes(query: String = "") async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        notesRequestGeneration += 1
        let requestGeneration = notesRequestGeneration
        notesQuery = normalized
        notesNextCursor = nil
        isLoadingMoreNotes = false
        isLoading = true
        notesErrorMessage = nil
        defer {
            if requestGeneration == notesRequestGeneration { isLoading = false }
        }
        do {
            let path = normalized.isEmpty ? "/notes" : "/search"
            let params: [URLQueryItem] = normalized.isEmpty
                ? [URLQueryItem(name: "limit", value: "30")]
                : [
                    URLQueryItem(name: "q", value: normalized),
                    URLQueryItem(name: "type", value: "note"),
                    URLQueryItem(name: "limit", value: "30")
                ]
            let page = try await api.request(path, query: params) as? [String: Any]
            guard requestGeneration == notesRequestGeneration else { return }
            notes = (page?["items"] as? [[String: Any]] ?? []).compactMap(NoteSummary.init)
            notesNextCursor = page?["nextCursor"] as? String
        } catch {
            guard requestGeneration == notesRequestGeneration else { return }
            notesErrorMessage = mobilePageError(error, fallback: "手记暂时无法读取，请检查连接后重新加载。")
        }
    }

    func loadMoreNotes(query: String) async {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isLoading, !isLoadingMoreNotes, normalized == notesQuery, let cursor = notesNextCursor else { return }
        let requestGeneration = notesRequestGeneration
        isLoadingMoreNotes = true
        defer {
            if requestGeneration == notesRequestGeneration { isLoadingMoreNotes = false }
        }
        do {
            let path = normalized.isEmpty ? "/notes" : "/search"
            var params = [URLQueryItem(name: "limit", value: "30"), URLQueryItem(name: "cursor", value: cursor)]
            if !normalized.isEmpty {
                params.append(URLQueryItem(name: "q", value: normalized))
                params.append(URLQueryItem(name: "type", value: "note"))
            }
            let page = try await api.request(path, query: params) as? [String: Any]
            guard requestGeneration == notesRequestGeneration, normalized == notesQuery, notesNextCursor == cursor else { return }
            let next = (page?["items"] as? [[String: Any]] ?? []).compactMap(NoteSummary.init)
            var seen = Set(notes.map(\.id))
            notes.append(contentsOf: next.filter { seen.insert($0.id).inserted })
            notesNextCursor = page?["nextCursor"] as? String
        } catch {
            guard requestGeneration == notesRequestGeneration, normalized == notesQuery else { return }
            notesErrorMessage = mobilePageError(error, fallback: "下一页手记没有加载出来，请稍后重试。")
        }
    }

    func loadNote(_ id: String) async {
        noteRequestGeneration += 1
        let requestGeneration = noteRequestGeneration
        annotationRequestGeneration += 1
        annotationOperationGeneration += 1
        noteDocument = nil
        noteAnnotations = []
        isAnnotationBusy = false
        annotationErrorMessage = nil
        annotationStatus = nil
        noteErrorMessage = nil
        do {
            let value = try await api.request("/v2/notes/\(id)") as? [String: Any] ?? [:]
            guard requestGeneration == noteRequestGeneration else { return }
            guard let document = NoteDocument(value) else {
                throw MobileAPIError(status: 0, code: "invalid_note", message: "手记没有返回可阅读的版本内容。")
            }
            noteDocument = document
            await loadNoteAnnotations(id)
        } catch {
            guard requestGeneration == noteRequestGeneration else { return }
            noteErrorMessage = mobilePageError(error, fallback: "这篇手记暂时无法打开，请检查连接后重新加载。")
        }
    }

    func loadNoteAnnotations(_ noteId: String) async {
        guard noteDocument?.id == noteId else { return }
        annotationRequestGeneration += 1
        let requestGeneration = annotationRequestGeneration
        do {
            let page = try await api.request("/v2/notes/\(noteId)/annotations") as? [String: Any] ?? [:]
            guard requestGeneration == annotationRequestGeneration, noteDocument?.id == noteId else { return }
            noteAnnotations = (page["items"] as? [[String: Any]] ?? []).compactMap(NoteAnnotation.init)
            annotationErrorMessage = nil
        } catch {
            guard requestGeneration == annotationRequestGeneration, noteDocument?.id == noteId else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注暂时无法读取，请重新加载后再试。")
        }
    }

    func clearAnnotationNotice() {
        annotationErrorMessage = nil
        annotationStatus = nil
    }

    func saveNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor, explanation: String) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = nil
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            _ = try await api.request("/v2/notes/\(noteId)/annotations", method: "POST", body: [
                "anchor": anchor.requestBody,
                "explanation": explanation.trimmingCharacters(in: .whitespacesAndNewlines),
            ])
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            await loadNoteAnnotations(noteId)
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationStatus = "已把这条批注留在原文旁。"
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注没有保存，请检查连接后重试。")
        }
    }

    func explainNoteAnnotation(noteId: String, anchor: NoteAnnotationAnchor) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = "伴星正在读这段原文…"
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            let task = try await api.request("/v2/notes/\(noteId)/annotation-tasks", method: "POST", body: [
                "anchor": anchor.requestBody,
                "requestId": UUID().uuidString.lowercased(),
            ]) as? [String: Any] ?? [:]
            guard let taskId = task["taskId"] as? String, !taskId.isEmpty else {
                throw MobileAPIError(status: 0, code: "missing_task", message: "讲解任务没有返回编号。")
            }
            for _ in 0..<80 {
                guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                try await Task.sleep(for: .milliseconds(1_500))
                let status = try await api.request("/v2/notes/\(noteId)/annotation-tasks/\(taskId)") as? [String: Any] ?? [:]
                guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                switch status["status"] as? String {
                case "ready":
                    await loadNoteAnnotations(noteId)
                    guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
                    annotationStatus = "伴星已经把讲解贴回这段原文。"
                    return
                case "failed":
                    let reason = status["failureReason"] as? String
                    annotationErrorMessage = switch reason {
                    case "ai_consent_required": "请先到账户页签署 AI 使用协议。"
                    case "ai_data_policy_denied": "账户暂未允许此类 AI 处理，请先检查数据偏好。"
                    case "generation_incomplete": "这次讲解没有完成，原文还在，可以再试一次。"
                    default: "讲解暂时没有生成，原文还在，可以再试一次。"
                    }
                    annotationStatus = nil
                    return
                default: continue
                }
            }
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = "讲解还在后台整理，稍后重新打开这篇手记查看。"
            annotationStatus = nil
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "讲解没有开始，请检查连接后重试。")
            annotationStatus = nil
        }
    }

    func removeNoteAnnotation(noteId: String, annotation: NoteAnnotation) async {
        guard noteDocument?.id == noteId else { return }
        annotationOperationGeneration += 1
        let operationGeneration = annotationOperationGeneration
        isAnnotationBusy = true
        annotationErrorMessage = nil
        annotationStatus = nil
        defer { if operationGeneration == annotationOperationGeneration { isAnnotationBusy = false } }
        do {
            let result = try await api.request("/v2/notes/\(noteId)/annotations/\(annotation.id)", method: "DELETE", body: [
                "expectedRevision": annotation.revision,
            ]) as? [String: Any] ?? [:]
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            await loadNoteAnnotations(noteId)
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            let removedArtifacts = result["removedArtifacts"] as? Int ?? 0
            annotationStatus = removedArtifacts > 0
                ? "批注已撤下，连带移除了 \(removedArtifacts) 条讲解。"
                : "批注已撤下。"
        } catch {
            guard isCurrentNoteOperation(noteId, generation: operationGeneration) else { return }
            annotationErrorMessage = mobilePageError(error, fallback: "批注没有撤下，请刷新后再试。")
        }
    }

    private func isCurrentNoteOperation(_ noteId: String, generation: Int) -> Bool {
        generation == annotationOperationGeneration && noteDocument?.id == noteId
    }

    func continueWithNote(_ document: NoteDocument) {
        guard !document.versionId.isEmpty else {
            accountError = "没有取得这篇手记的版本信息，请重新打开后再试。"
            return
        }
        pendingNoteContext = PendingNoteContext(noteId: document.id, versionId: document.versionId, title: document.title)
        pendingDiaryReference = nil
        selectedTab = .conversation
    }

    func loadRecentNotePreference() {
        recentNoteId = notePreferenceKey("recentNoteId").flatMap { UserDefaults.standard.string(forKey: $0) }
    }

    func recordNoteOpened(_ noteId: String) {
        guard !noteId.isEmpty else { return }
        recentNoteId = noteId
        if let key = notePreferenceKey("recentNoteId") {
            UserDefaults.standard.set(noteId, forKey: key)
        }
    }

    func savedNoteReadingBlock(noteId: String) -> Int? {
        guard let key = notePreferenceKey("readingBlock.\(noteId)") else { return nil }
        return UserDefaults.standard.object(forKey: key) as? Int
    }

    func saveNoteReadingBlock(_ blockId: Int, noteId: String) {
        guard let key = notePreferenceKey("readingBlock.\(noteId)") else { return }
        UserDefaults.standard.set(blockId, forKey: key)
    }

    private func notePreferenceKey(_ name: String) -> String? {
        guard let profile, !profile.userId.isEmpty, !profile.workspaceId.isEmpty else { return nil }
        return mobilePreferenceKey(profile.userId, "workspace.\(profile.workspaceId).\(name)")
    }

    /// Opens the conversation with a stable diary reference attached; it never sends a turn.
    func continueWithDiary(date: String, version: Int) {
        guard version > 0 else { return }
        pendingNoteContext = nil
        pendingDiaryReference = PendingDiaryReference(date: date, version: version)
        selectedTab = .conversation
    }

    func clearPendingNoteContext() {
        pendingNoteContext = nil
    }

    func clearPendingDiaryReference() {
        pendingDiaryReference = nil
    }
}

// MARK: - Notes · 版本记录（Screens 直调收口，返回形态与原 api.request 一致）

extension AppStore {
    func noteVersions(noteId: String) async throws -> [String: Any] {
        try await api.request("/notes/\(noteId)/versions",
                              query: [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "offset", value: "0")]) as? [String: Any] ?? [:]
    }

    func restoreNoteVersion(noteId: String, versionId: String, baseVersionId: String) async throws {
        _ = try await api.request("/notes/\(noteId)/versions/\(versionId)/restore",
                                  method: "POST", body: ["baseVersionId": baseVersionId])
    }
}

// MARK: - Notes · 速览（overview）

extension AppStore {
    func noteOverviews(noteId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/overviews") as? [String: Any] ?? [:]
    }

    func latestOverviewTask(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/overview-tasks/latest",
                              query: [URLQueryItem(name: "noteVersionId", value: noteVersionId)]) as? [String: Any] ?? [:]
    }

    func createOverviewTask(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/overview-tasks", method: "POST", body: [
            "noteVersionId": noteVersionId,
            "requestId": UUID().uuidString.lowercased(),
        ]) as? [String: Any] ?? [:]
    }

    func overviewTask(noteId: String, taskId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/overview-tasks/\(taskId)") as? [String: Any] ?? [:]
    }
}

// MARK: - Notes · 脑图（mind map）

extension AppStore {
    func noteMindMaps(noteId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/mind-maps") as? [String: Any] ?? [:]
    }

    func latestMindMapTask(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/mind-map-tasks/latest",
                              query: [URLQueryItem(name: "noteVersionId", value: noteVersionId)]) as? [String: Any] ?? [:]
    }

    func createMindMapTask(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/mind-map-tasks", method: "POST", body: [
            "noteVersionId": noteVersionId,
            "requestId": UUID().uuidString.lowercased(),
        ]) as? [String: Any] ?? [:]
    }

    func mindMapTask(noteId: String, taskId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/mind-map-tasks/\(taskId)") as? [String: Any] ?? [:]
    }
}

// MARK: - Notes · 讲解（learning artifact）

extension AppStore {
    func learningArtifactTasks(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/learning-artifact-tasks",
                              query: [URLQueryItem(name: "noteVersionId", value: noteVersionId)]) as? [String: Any] ?? [:]
    }

    func createLearningArtifactTask(noteId: String, noteVersionId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/learning-artifact-tasks", method: "POST", body: [
            "noteVersionId": noteVersionId,
            "requestId": UUID().uuidString.lowercased(),
            "sourceKind": "overview",
        ]) as? [String: Any] ?? [:]
    }

    func learningArtifactTask(noteId: String, taskId: String) async throws -> [String: Any] {
        try await api.request("/v2/notes/\(noteId)/learning-artifact-tasks/\(taskId)") as? [String: Any] ?? [:]
    }
}
