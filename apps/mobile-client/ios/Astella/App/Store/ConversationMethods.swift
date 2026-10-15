import Foundation

// MARK: - Conversation（会话、消息、run 与 WS 事件）

extension AppStore {
    func loadConversation() async {
        errorMessage = nil
        do {
            let inbox: CompanionInboxDTO = try await api.request("/companion/inbox/ensure", method: "POST", body: [:])
            let id = inbox.id
            conversationId = id
            await refreshMessages()
            await refreshRuns()
            let snapshot: CompanionRunNodesSnapshotDTO = try await api.request("/companion/conversations/\(id)/run-nodes",
                                                 query: [URLQueryItem(name: "after", value: "0")])
            let cursor = snapshot.latestSeq
            realtime.start(api: api, conversationId: id, cursor: cursor)
        } catch {
            errorMessage = mobilePageError(error, fallback: "伴星暂时没有接回来，请检查连接后重试。")
        }
    }

    func refreshMessages() async {
        guard let conversationId else { return }
        do {
            let page: CompanionMessagePageDTO = try await api.request("/companion/conversations/\(conversationId)/messages",
                                             query: [URLQueryItem(name: "limit", value: "50")])
            messages = page.items
                .map { item in
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
                                code: block.code
                            )
                        },
                        createdAt: item.createdAt, runId: item.runId
                    )
                }
                .sorted { $0.seq < $1.seq }

        } catch {
            errorMessage = mobilePageError(error, fallback: "对话记录暂时无法读取，请重新连接后重试。")
        }
    }

    func refreshRuns() async {
        guard let conversationId else { return }
        do {
            let snapshot: CompanionRunNodesSnapshotDTO = try await api.request("/companion/conversations/\(conversationId)/run-nodes",
                                                 query: [URLQueryItem(name: "after", value: "0")])
            runs = snapshot.runs
                .map {
                    ActiveRun(id: $0.runId, status: $0.status, stepCount: $0.stepCount,
                              toolCallCount: $0.toolCallCount, thinkingText: $0.thinkingText)
                }
                .filter(\.isActive)
        } catch {
            runs = []
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
        let session = api.token
        let sendingContext = context ?? pendingNoteContext
        let sendingVoiceId = isSelection ? nil : voiceArtifactId
        let revision = attachmentRevision
        let signature = try? JSONSerialization.data(withJSONObject: [
            "conversation": conversationId, "text": text, "attachment": isSelection ? "" : revision.uuidString,
            "selection": selection ?? "", "note": sendingContext?.noteId ?? "",
            "version": sendingContext?.versionId ?? "", "voice": sendingVoiceId ?? ""
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
            guard session == api.token else { return nil }
            pendingTurnRequest = nil; pendingTurnSignature = nil
            if !isSelection {
                if attachmentRevision == revision { selectedImage = nil; selectedFile = nil }
                voiceArtifactId = nil
                if pendingNoteContext == sendingContext { pendingNoteContext = nil }
            }
            emitCompanion(.thinking)
            await refreshMessages()
            await refreshRuns()
            return response.runId
        } catch {
            guard session == api.token else { return nil }
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
        let type = event["type"] as? String ?? ""
        let payload = event["payload"] as? [String: Any] ?? [:]
        switch type {
        case "assistant.delta":
            let runId = event["runId"] as? String
            if streamingRunId != runId { streamingText = ""; streamingRunId = runId }
            streamingText += payload["textDelta"] as? String ?? ""
        case "sync.required":
            Task { await loadConversation() }
        case "turn.completed", "assistant.final":
            if streamingRunId == event["runId"] as? String { streamingText = ""; streamingRunId = nil }
            Task {
                await refreshMessages()
                await refreshRuns()
            }
        case "action.proposed":
            Task { await refreshMessages(); await refreshRuns() }
        case "turn.accepted", "assistant.status", "agent.tool":
            Task { await refreshRuns() }
        case "error":
            emitCompanion(.fail)
            errorMessage = mobileServerMessage(payload["message"] as? String, fallback: "这一轮暂时没有完成，请保留草稿后重试。")
            Task { await refreshMessages() }
        default:
            break
        }
    }
}

extension AppStore {
    func cancelActiveRuns() async {
        for run in runs {
            do { _ = try await api.request("/companion/runs/\(run.id)/cancel", method: "POST", body: [:]) }
            catch { errorMessage = mobilePageError(error, fallback: "暂时没有停下来，请重试。") }
        }
        voicePlayback.stop()
        await refreshRuns()
    }
}
