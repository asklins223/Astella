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
                                alt: block.alt
                            )
                        },
                        createdAt: item.createdAt
                    )
                }
                .sorted { $0.seq < $1.seq }
            streamingText = ""
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

    func submit(text rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let conversationId, !isSending,
              !text.isEmpty || selectedImage != nil else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            var blocks: [[String: Any]] = [[
                "type": "text",
                "text": text.isEmpty ? "看看这张图" : text
            ]]
            var inputKind = "text"
            var request: [String: Any] = [
                "version": 1,
                "clientMessageId": UUID().uuidString.lowercased(),
                "inputKind": inputKind,
                "sourceSurface": "main"
            ]
            if let image = selectedImage {
                let upload = try await api.uploadImage(image, fileName: selectedImageName, mimeType: "image/jpeg")
                guard let url = upload["url"] as? String,
                      let assetId = upload["assetId"] as? String else {
                    throw MobileAPIError(status: 0, code: "invalid_upload", message: "服务端没有返回可用的图片地址。")
                }
                blocks.append([
                    "type": "image",
                    "url": url,
                    "label": selectedImageName,
                    "alt": selectedImageName,
                    "assetId": assetId
                ])
            } else if let voiceArtifactId {
                inputKind = "voice_transcript"
                request["voiceArtifactId"] = voiceArtifactId
                request["inputKind"] = inputKind
            }
            request["blocks"] = blocks
            if let context = pendingNoteContext {
                request["context"] = [
                    "pageKind": "note",
                    "sharing": "page_registered",
                    "noteId": context.noteId,
                    "noteVersionId": context.versionId
                ]
            }
            if realtime.isReady {
                do {
                    try await realtime.submit(request)
                } catch {
                    let _: CompanionTurnSubmitResponseDTO = try await api.request(
                        "/companion/conversations/\(conversationId)/turns",
                        method: "POST",
                        body: request,
                        idempotencyKey: request["clientMessageId"] as? String
                    )
                }
            } else {
                let _: CompanionTurnSubmitResponseDTO = try await api.request(
                    "/companion/conversations/\(conversationId)/turns",
                    method: "POST",
                    body: request,
                    idempotencyKey: request["clientMessageId"] as? String
                )
            }
            selectedImage = nil
            voiceArtifactId = nil
            pendingNoteContext = nil
            await refreshMessages()
        } catch {
            errorMessage = mobilePageError(error, fallback: "这一轮还没有发出去，草稿已保留，请重试。")
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
            streamingText += payload["textDelta"] as? String ?? ""
        case "sync.required":
            Task { await loadConversation() }
        case "turn.completed", "assistant.final":
            Task {
                await refreshMessages()
                await refreshRuns()
            }
        case "turn.accepted", "assistant.status", "agent.tool":
            Task { await refreshRuns() }
        case "error":
            errorMessage = mobileServerMessage(payload["message"] as? String, fallback: "这一轮暂时没有完成，请保留草稿后重试。")
            Task { await refreshMessages() }
        default:
            break
        }
    }
}
