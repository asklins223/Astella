import Foundation

// MARK: - Conversation（会话、消息、run 与 WS 事件）

extension AppStore {
    /// Opens the conversation with a reviewable prompt for a diary moment.
    /// The user decides whether to send it; opening this action never saves a diary.
    func beginDiaryCapture() {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draft = "今天我想记下："
        }
        setChatShowsRecords(false)
        composerFocusRequestID &+= 1
        selectedTab = .conversation
    }

    func loadConversation() async {
        guard let session = api.token else { return }
        conversationLoadGeneration += 1
        let loadGeneration = conversationLoadGeneration
        errorMessage = nil
        do {
            let inbox: CompanionInboxDTO = try await api.request("/companion/inbox/ensure", method: "POST", body: [:])
            let id = inbox.id
            guard loadGeneration == conversationLoadGeneration, session == api.token else { return }
            if conversationId != id {
                realtime.stop()
                messages = []
                resetProcessPresentation()
            }
            conversationId = id
            await refreshMessages()
            guard loadGeneration == conversationLoadGeneration, session == api.token, conversationId == id else { return }
            let cursor = await refreshRuns() ?? 0
            guard loadGeneration == conversationLoadGeneration, session == api.token, conversationId == id else { return }
            realtime.start(api: api, conversationId: id, cursor: cursor)
        } catch {
            guard loadGeneration == conversationLoadGeneration, session == api.token else { return }
            errorMessage = mobilePageError(error, fallback: "伴星暂时没有接回来，请检查连接后重试。")
        }
    }

    func refreshMessages() async {
        guard let conversationId else { return }
        let session = api.token
        messageRequestGeneration += 1
        let requestGeneration = messageRequestGeneration
        do {
            let page: CompanionMessagePageDTO = try await api.request("/companion/conversations/\(conversationId)/messages",
                                             query: [URLQueryItem(name: "limit", value: "50")])
            guard self.conversationId == conversationId, api.token == session,
                  requestGeneration == messageRequestGeneration else { return }
            if (messages.first?.seq ?? Int.max) >= (page.items.first?.seq ?? Int.max) { historyHasMore = page.hasMore == true }
            let incoming = page.items.map(companionMessage(from:)).sorted { $0.seq < $1.seq }
            let ids = Set(incoming.map(\.id))
            messages = (messages.filter { !ids.contains($0.id) } + incoming).sorted { $0.seq < $1.seq }

        } catch {
            guard self.conversationId == conversationId, api.token == session,
                  requestGeneration == messageRequestGeneration else { return }
            errorMessage = mobilePageError(error, fallback: "对话记录暂时无法读取，请重新连接后重试。")
        }
    }

    @discardableResult
    func refreshRuns(runIds: [String] = [], includeThinking: Bool = false) async -> Int? {
        guard let conversationId else { return nil }
        let session = api.token
        processRequestGeneration += 1
        let requestGeneration = processRequestGeneration
        do {
            var query = [URLQueryItem(name: "after", value: "0")]
            if includeThinking { query.append(URLQueryItem(name: "includeThinking", value: "true")) }
            if !runIds.isEmpty { query.append(URLQueryItem(name: "runIds", value: runIds.joined(separator: ","))) }
            let snapshot: CompanionRunNodesSnapshotDTO = try await api.request("/companion/conversations/\(conversationId)/run-nodes",
                                                 query: query)
            guard self.conversationId == conversationId, api.token == session, requestGeneration == processRequestGeneration else { return nil }
            mergeProcessSnapshot(snapshot)
            processError = nil
            return snapshot.latestSeq
        } catch {
            guard self.conversationId == conversationId, api.token == session,
                  requestGeneration == processRequestGeneration else { return nil }
            processError = mobilePageError(error, fallback: "过程记录暂时无法读取，已显示的成果仍可打开。")
            return nil
        }
    }

    @discardableResult
    func submit(text rawText: String, selection: String? = nil, context: PendingNoteContext? = nil) async -> String? {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        let isSelection = selection != nil
        let image = isSelection ? nil : selectedImage
        let imageName = selectedImageName
        let file = isSelection ? nil : selectedFile
        guard let conversationId, !isSending, !text.isEmpty || image != nil || file != nil else { return nil }
        minimumStreamingGeneration = (processRuns.map(\.generation).max() ?? 0) + 1
        streamingText = ""; streamingRunId = nil
        let session = api.token
        let sendingContext = context ?? pendingNoteContext
        let sendingDiaryReference = pendingDiaryReference
        let sendingVoiceId = isSelection ? nil : voiceArtifactId
        let revision = attachmentRevision
        let signature = try? JSONSerialization.data(withJSONObject: [
            "conversation": conversationId, "text": text, "attachment": isSelection ? "" : revision.uuidString,
            "selection": selection ?? "", "note": sendingContext?.noteId ?? "",
            "version": sendingContext?.versionId ?? "",
            "diaryDate": sendingDiaryReference?.date ?? "",
            "diaryVersion": sendingDiaryReference?.version ?? 0,
            "voice": sendingVoiceId ?? ""
        ], options: .sortedKeys)
        isSending = true
        errorMessage = nil
        defer { if session == api.token { isSending = false } }
        do {
            var request: [String: Any]
            if signature == pendingTurnSignature, let cached = pendingTurnRequest {
                request = cached
            } else {
                pendingTurnSignature = signature; pendingTurnRequest = nil
                var blocks: [[String: Any]] = text.isEmpty ? [] : [["type": "text", "text": text]]
                request = ["version": 1, "clientMessageId": UUID().uuidString.lowercased(),
                           "inputKind": "text", "sourceSurface": "main", "clientSurface": "mobile"]
                if let image {
                    let upload = try await api.uploadImage(image, fileName: imageName, mimeType: "image/jpeg")
                    guard let url = upload["url"] as? String, let assetId = upload["assetId"] as? String else {
                        throw MobileAPIError(status: 502, code: "invalid_upload", message: "图片没有收到上传回执，请重试。")
                    }
                    blocks.append(["type": "image", "url": url, "label": imageName, "alt": imageName, "assetId": assetId])
                } else if let file {
                    let upload = try await api.uploadImage(file.data, fileName: file.name, mimeType: file.mime, endpoint: "/uploads/companion-files")
                    guard let url = upload["url"] as? String else {
                        throw MobileAPIError(status: 502, code: "invalid_upload", message: "文件没有收到上传回执，请重试。")
                    }
                    blocks.append(["type": "file", "url": url, "name": file.name, "mime": file.mime, "byteLength": file.data.count, "text": file.text])
                } else if let sendingVoiceId {
                    request["voiceArtifactId"] = sendingVoiceId; request["inputKind"] = "voice_transcript"
                }
                request["blocks"] = blocks
                if let selection { request["selection"] = ["text": selection, "sharing": "user_selected"] }
                if let context = sendingContext {
                    request["context"] = ["pageKind": "note", "sharing": "page_registered", "noteId": context.noteId, "noteVersionId": context.versionId]
                }
                if let reference = sendingDiaryReference {
                    request["diaryReference"] = ["date": reference.date, "version": reference.version]
                }
                guard session == api.token, self.conversationId == conversationId else { return nil }
                pendingTurnRequest = request
            }
            guard session == api.token, self.conversationId == conversationId else { return nil }
            let response: CompanionTurnSubmitResponseDTO
            if realtime.isReady {
                do { response = try await realtime.submit(request) }
                catch {
                    response = try await api.request("/companion/conversations/\(conversationId)/turns", method: "POST", body: request, idempotencyKey: request["clientMessageId"] as? String)
                }
            } else {
                response = try await api.request("/companion/conversations/\(conversationId)/turns", method: "POST", body: request, idempotencyKey: request["clientMessageId"] as? String)
            }
            guard session == api.token, self.conversationId == conversationId else { return nil }
            minimumStreamingGeneration = max(response.generation, processRuns.map(\.generation).max() ?? 0)
            pendingTurnRequest = nil; pendingTurnSignature = nil
            if !isSelection {
                if attachmentRevision == revision { selectedImage = nil; selectedFile = nil }
                voiceArtifactId = nil
                if pendingNoteContext == sendingContext { pendingNoteContext = nil }
                if pendingDiaryReference == sendingDiaryReference { pendingDiaryReference = nil }
            }
            emitCompanion(.thinking)
            await refreshMessages()
            await refreshRuns()
            return response.runId
        } catch {
            guard session == api.token, self.conversationId == conversationId else { return nil }
            errorMessage = mobilePageError(error, fallback: "这一轮还没有发出去，草稿已保留，请重试。")
            return nil
        }
    }

    func acceptTranscription(_ value: [String: Any]) {
        voiceArtifactId = value["voiceArtifactId"] as? String
    }

    func setChatShowsRecords(_ value: Bool) {
        chatShowsRecords = value
        guard let userId = profile?.userId, !userId.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "showRecords"))
    }

    func returnToConversation(records: Bool) {
        setChatShowsRecords(records)
        selectedTab = .conversation
        conversationRootRevision &+= 1
    }

    func consume(_ event: [String: Any]) {
        if let scope = event["conversationId"] as? String, scope != conversationId { return }
        let type = event["type"] as? String ?? ""
        let payload = event["payload"] as? [String: Any] ?? [:]
        projectProcessEvent(event)
        let runId = event["runId"] as? String
        let run = processRuns.first { $0.id == runId }
        let generation = event["generation"] as? Int ?? 0
        let isCurrentOutput = !isSending && generation >= minimumStreamingGeneration
            && generation >= (processRuns.map(\.generation).max() ?? 0)
            && (event["seq"] as? Int ?? 0) >= (run?.eventCursor ?? 0)
        switch type {
        case "assistant.delta":
            guard isCurrentOutput, run?.isActive != false else { return }
            if streamingRunId != runId { streamingText = ""; streamingRunId = runId }
            streamingText += payload["textDelta"] as? String ?? ""
        case "sync.required":
            Task { await loadConversation() }
        case "turn.completed", "assistant.final", "turn.cancelled":
            if streamingRunId == event["runId"] as? String { streamingText = ""; streamingRunId = nil }
            Task {
                await refreshMessages()
                await refreshRuns()
            }
        case "action.proposed":
            Task { await refreshMessages(); await refreshRuns() }
        case "turn.accepted":
            Task { await refreshRuns() }
        case "error":
            guard isCurrentOutput else { return }
            if streamingRunId == runId { streamingText = ""; streamingRunId = nil }
            emitCompanion(.fail)
            errorMessage = mobileServerMessage(payload["message"] as? String, fallback: "这一轮暂时没有完成，请保留草稿后重试。")
            Task { await refreshMessages() }
        default:
            break
        }
    }
}

func companionMessage(from item: CompanionMessageDTO) -> CompanionMessage {
    CompanionMessage(
        id: item.id,
        seq: item.seq,
        role: item.role,
        blocks: item.blocks.map { block in
            CompanionBlock(
                type: block.type ?? "text",
                text: block.text,
                url: block.url,
                label: block.label,
                alt: block.alt,
                name: block.name,
                proposalId: block.proposalId,
                code: block.code,
                noteTarget: block.route?.target(title: block.label),
                title: block.title,
                steps: block.steps ?? [],
                front: block.front,
                summary: block.summary,
                citation: block.target,
                sourceRef: block.sourceRef
            )
        },
        createdAt: item.createdAt,
        runId: item.runId
    )
}

extension AppStore {
    func cancelActiveRuns() async {
        for run in runs {
            do { _ = try await api.request("/companion/runs/\(run.id)/cancel", method: "POST", body: ["version": 1, "generation": run.generation, "reason": "user"]) }
            catch { errorMessage = mobilePageError(error, fallback: "暂时没有停下来，请重试。") }
        }
        voicePlayback.stop()
        await refreshRuns()
    }
}
