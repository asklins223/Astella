import Foundation

/// Read-only projection of the shared run events. Execution stays on the server.
struct CompanionNoteTarget: Identifiable, Hashable, Decodable {
    var noteId: String
    var noteVersionId: String?
    var title: String
    var runId: String?
    var blockOrdinal: Int? = nil
    var id: String { "\(noteId):\(noteVersionId ?? "current"):\(blockOrdinal.map(String.init) ?? "body")" }

    init(noteId: String, noteVersionId: String? = nil, title: String, runId: String? = nil, blockOrdinal: Int? = nil) {
        self.noteId = noteId; self.noteVersionId = noteVersionId; self.title = title; self.runId = runId; self.blockOrdinal = blockOrdinal
    }
    init?(route: [String: Any]?, title: String?) {
        guard let route, route["kind"] as? String == "note", let id = route["noteId"] as? String else { return nil }
        self.init(noteId: id, noteVersionId: route["noteVersionId"] as? String, title: title ?? "笔记")
    }
}

struct CompanionNoteRouteDTO: Decodable {
    let kind: String?
    let noteId: String?
    let noteVersionId: String?
    func target(title: String?) -> CompanionNoteTarget? {
        guard kind == "note", let noteId else { return nil }
        return CompanionNoteTarget(noteId: noteId, noteVersionId: noteVersionId, title: title ?? "笔记")
    }
}

struct CompanionProcessEventDTO: Decodable {
    let seq: Int
    let type: String
    let runId: String?
    let payload: Payload
    struct Payload: Decodable {
        let safeLabel: String?
        let text: String?
        let tool: Tool?
    }
    struct Tool: Decodable {
        let toolCallId: String
        let preparationToolCallId: String?
        let status: String
        let safeLabel: String
        let safeSummary: String?
        let occurredAt: String?
        let proposalId: String?
        let noteCreated: CompanionNoteTarget?
        let noteEdit: EditedNote?
    }
    struct EditedNote: Decodable {
        let noteId: String
        let noteVersionId: String
        var target: CompanionNoteTarget { CompanionNoteTarget(noteId: noteId, noteVersionId: noteVersionId, title: "修改后的笔记") }
    }
}

struct CompanionProcessNode: Identifiable, Hashable {
    var id: String
    var seq: Int
    var label: String
    var status: String
    var summary: String?
    var occurredAt: String?
    var proposalId: String?
    var note: CompanionNoteTarget?
    var isRunning: Bool { ["requested", "executing"].contains(status) }
    var statusLabel: String {
        switch status {
        case "requested": "准备中"
        case "executing": "进行中"
        case "succeeded": "已完成"
        case "waiting_confirmation": "等你确认"
        case "outcome_unknown": "结果待核对"
        case "not_executed": "未执行"
        case "unavailable": "暂不可用"
        case "cancelled", "expired": "已停止"
        default: "未完成"
        }
    }
}

extension AppStore {
    func resetProcessPresentation() {
        processRequestGeneration += 1
        processRuns = []; processError = nil
        minimumStreamingGeneration = 0; streamingText = ""; streamingRunId = nil
        journalOffset = 0; journalFollowsLatest = true; journalTargetRunId = nil; journalCollapsed = []
        historyHasMore = false; historyLoadingOlder = false
        resultPreview = nil; resultReturnTo = nil; resultPreviewOffsets = [:]
    }

    func mergeProcessSnapshot(_ snapshot: CompanionRunNodesSnapshotDTO) {
        for summary in snapshot.runs {
            let old = processRuns.first { $0.id == summary.runId }
            var run = old ?? ActiveRun(id: summary.runId, status: summary.status, stepCount: 0, toolCallCount: 0, thinkingText: nil)
            // An older poll cannot revive a finished operation received over WS.
            let incomingCursor = summary.eventCursor ?? 0
            if old == nil || incomingCursor > run.eventCursor || (incomingCursor == run.eventCursor && (run.isActive || !["running", "accepted", "cancel_requested"].contains(summary.status))) {
                run.status = summary.status; run.errorCode = summary.errorCode
            }
            run.eventCursor = max(run.eventCursor, summary.eventCursor ?? 0)
            run.generation = summary.generation ?? run.generation
            run.stepCount = max(run.stepCount, summary.stepCount)
            run.toolCallCount = max(run.toolCallCount, summary.toolCallCount)
            run.nodeCount = max(run.nodeCount, summary.nodeCount)
            run.userMessageId = summary.userMessageId ?? run.userMessageId
            run.assistantMessageId = summary.assistantMessageId ?? run.assistantMessageId
            run.createdAt = summary.createdAt ?? run.createdAt; run.updatedAt = summary.updatedAt ?? run.updatedAt
            if let text = summary.thinkingText, text.count >= (run.thinkingText?.count ?? 0) { run.thinkingText = text }
            for event in (summary.processTimeline ?? []) + (snapshot.items ?? []).filter({ $0.runId == run.id }) { project(event, into: &run) }
            if let index = processRuns.firstIndex(where: { $0.id == run.id }) { processRuns[index] = run } else { processRuns.append(run) }
        }
    }

    func projectProcessEvent(_ raw: [String: Any]) {
        guard let runId = raw["runId"] as? String, let type = raw["type"] as? String else { return }
        var run = processRuns.first { $0.id == runId } ?? ActiveRun(id: runId, status: "running", stepCount: 0, toolCallCount: 0, thinkingText: nil)
        let generation = raw["generation"] as? Int ?? run.generation
        guard generation >= run.generation else { return }
        let newest = (raw["seq"] as? Int ?? 0) >= run.eventCursor
        if let data = try? JSONSerialization.data(withJSONObject: raw), let event = try? JSONDecoder().decode(CompanionProcessEventDTO.self, from: data) {
            project(event, into: &run)
        }
        switch newest ? type : "" {
        case "turn.accepted": run.status = "accepted"; run.errorCode = nil
        case "turn.completed", "assistant.final": run.status = "succeeded"
        case "turn.cancelled": run.status = "cancelled"
        case "error": run.status = "failed"; run.errorCode = (raw["payload"] as? [String: Any])?["code"] as? String
        default: break
        }
        run.eventCursor = max(run.eventCursor, raw["seq"] as? Int ?? 0)
        run.nodeCount = max(run.nodeCount, run.nodes.count)
        run.generation = raw["generation"] as? Int ?? run.generation
        if let index = processRuns.firstIndex(where: { $0.id == runId }) { processRuns[index] = run } else { processRuns.append(run) }
    }

    private func project(_ event: CompanionProcessEventDTO, into run: inout ActiveRun) {
        if let tool = event.payload.tool {
            let known = ["requested", "executing", "succeeded", "waiting_confirmation", "outcome_unknown", "failed", "blocked", "expired", "not_executed", "unavailable", "cancelled"]
            let status = known.contains(tool.status) ? tool.status : "outcome_unknown"
            let id = "tool:\(tool.toolCallId)"
            if let previewId = tool.preparationToolCallId, previewId != tool.toolCallId { run.nodes.removeAll { $0.id == "tool:\(previewId)" } }
            var note = status == "succeeded" ? (tool.noteCreated ?? tool.noteEdit?.target) : nil; note?.runId = run.id
            let node = CompanionProcessNode(id: id, seq: event.seq, label: tool.safeLabel, status: status,
                summary: tool.safeSummary, occurredAt: tool.occurredAt, proposalId: tool.proposalId, note: note)
            if let index = run.nodes.firstIndex(where: { $0.id == id }) {
                let old = run.nodes[index]
                guard event.seq >= old.seq, old.isRunning || !node.isRunning || old.status == "waiting_confirmation" else { return }
                run.nodes[index] = node
            } else { run.nodes.append(node) }
        } else if event.type == "assistant.status", let label = event.payload.safeLabel {
            let node = CompanionProcessNode(id: "status:\(event.seq)", seq: event.seq, label: label, status: "executing")
            if !run.nodes.contains(where: { $0.id == node.id }) { run.nodes.append(node) }
        }
    }

    func showRunInJournal(_ runId: String) {
        journalTargetRunId = runId; journalFollowsLatest = false
        setChatShowsRecords(true)
        Task {
            await refreshRuns(runIds: [runId], includeThinking: true)
            while journalTargetRunId == runId, !Task.isCancelled, historyHasMore {
                let run = processRuns.first { $0.id == runId }
                if messages.contains(where: { $0.id == run?.userMessageId || $0.runId == runId }) { break }
                let oldest = messages.first?.seq
                await loadOlderConversationMessages()
                if oldest == messages.first?.seq { break }
            }
        }
    }

    func cancelProcessRun(_ runId: String) async {
        guard let run = processRuns.first(where: { $0.id == runId }), run.generation > 0 else { await refreshRuns(); return }
        do { _ = try await api.request("/companion/runs/\(runId)/cancel", method: "POST", body: ["version": 1, "generation": run.generation, "reason": "user"]); await refreshRuns() }
        catch { processError = mobilePageError(error, fallback: "停止请求尚未确认，请重试。") }
    }

    func recoverProcessRun(_ run: ActiveRun, reconcileOnly: Bool = false) async -> String {
        let session = api.token, conversation = conversationId
        do {
            let result = try await api.request("/companion/runs/\(run.id)/resume", method: "POST", body: [
                "version": 1, "generation": run.generation, "expectedEventCursor": run.eventCursor, "reconcileOnly": reconcileOnly
            ]) as? [String: Any] ?? [:]
            guard api.token == session, conversationId == conversation else { return "记录已更新。" }
            await refreshRuns(runIds: [run.id], includeThinking: true)
            if !reconcileOnly { showRunInJournal(run.id); return "正在从中断处继续，已保存的成果仍然保留。" }
            return (result["unresolvedCount"] as? Int ?? 0) > 0 ? "仍有操作无法取得确定回执，未重新执行。" : "保存结果已核对，可直接预览。"
        } catch { return mobilePageError(error, fallback: "请求未确认，原记录和成果仍保留，请重试。") }
    }

    func loadOlderConversationMessages() async {
        guard !historyLoadingOlder, let conversationId, let oldest = messages.first?.seq else { return }
        let session = api.token
        historyLoadingOlder = true
        defer { if self.conversationId == conversationId, api.token == session { historyLoadingOlder = false } }
        do {
            let page: CompanionMessagePageDTO = try await api.request("/companion/conversations/\(conversationId)/messages", query: [
                URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "beforeSeq", value: String(oldest))])
            guard self.conversationId == conversationId, api.token == session else { return }
            let incoming = page.items.map(companionMessage(from:))
            let ids = Set(messages.map(\.id)); messages = (incoming.filter { !ids.contains($0.id) } + messages).sorted { $0.seq < $1.seq }
            historyHasMore = page.hasMore == true && messages.first?.seq != oldest
            let runIds = Array(Set(incoming.compactMap(\.runId)))
            if !runIds.isEmpty { await refreshRuns(runIds: runIds, includeThinking: true) }
        } catch {
            guard self.conversationId == conversationId, api.token == session else { return }
            processError = mobilePageError(error, fallback: "更早的手记没有加载出来，可以重试。")
        }
    }

    func loadResultPreview(_ target: CompanionNoteTarget) async throws -> NoteDocument {
        let session = api.token, workspaceId = profile?.workspaceId
        var query: [URLQueryItem] = []
        if let version = target.noteVersionId { query.append(URLQueryItem(name: "noteVersionId", value: version)) }
        var value = try await api.request("/v2/notes/\(target.noteId)", query: query) as? [String: Any] ?? [:]
        try Task.checkCancellation()
        guard session == api.token, workspaceId == profile?.workspaceId else { throw CancellationError() }
        if let version = target.noteVersionId {
            guard let requested = value["requestedVersion"] as? [String: Any], requested["versionId"] as? String == version else {
                throw MobileAPIError(status: 404, code: "version_unavailable", message: "保存时的版本已不可用，原记录仍然保留。")
            }
            value["currentVersion"] = requested
        }
        guard let note = NoteDocument(value) else { throw MobileAPIError(status: 0, code: "invalid_note", message: "未取得可阅读的正文，请重试读取。") }
        return note
    }
}
