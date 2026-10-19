import SwiftUI
import UIKit

private struct OrbitDiaryBlock: Identifiable {
    var id: Int
    var type: String
    var text: String?
    var label: String?
    var url: String?
    var alt: String?
}

private struct OrbitDiaryRecord {
    var date: String
    var status: String
    var generatedAt: String?
    var revision: Int
    var hidden: Bool
    var selectionReason: String?
    var failureReason: String?
    var blocks: [OrbitDiaryBlock]
    var memoryId: String?

    init?(_ value: [String: Any]) {
        guard let date = value["date"] as? String else { return nil }
        self.date = date
        status = value["status"] as? String ?? "not_generated"
        generatedAt = value["generatedAt"] as? String
        revision = value["revision"] as? Int ?? 1
        hidden = value["hidden"] as? Bool ?? false
        selectionReason = value["selectionReason"] as? String
        failureReason = value["failureReason"] as? String
        blocks = (value["blocks"] as? [[String: Any]] ?? []).enumerated().map { index, block in
            OrbitDiaryBlock(
                id: index,
                type: block["type"] as? String ?? "text",
                text: block["text"] as? String,
                label: block["label"] as? String,
                url: block["url"] as? String,
                alt: block["alt"] as? String
            )
        }
        memoryId = (value["memory"] as? [String: Any])?["memoryItemId"] as? String
    }
}

struct OrbitDiaryDetailScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let date: String

    @State private var record: OrbitDiaryRecord?
    @State private var availableDates: [String] = []
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var error: String?
    @State private var notice: String?
    @State private var confirmDelete = false
    @State private var lightbox: OrbitDiaryImageReference?

    private var previousDate: String? { availableDates.filter { $0 < date }.max() }
    private var nextDate: String? { availableDates.filter { $0 > date }.min() }

    var body: some View {
        Group {
            if let record {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if record.status == "generated" {
                            diaryHero(record)
                            if record.hidden { hiddenNotice }
                            diaryArticle(record)
                            if let reason = record.selectionReason, !reason.isEmpty {
                                PaperSurface(padding: 15, radius: 17) {
                                    HStack(alignment: .top, spacing: 9) {
                                        AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent).frame(width: 16, height: 16)
                                        Text("她选了这段：\(reason)").font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                                    }
                                }
                            }
                            if let memoryId = record.memoryId {
                                NavigationLink(value: OrbitNavigationRoute.memory(memoryId)) {
                                    settingDestinationRow(title: "关联记忆", detail: "查看伴星从这一天留下的记忆", glyph: .sparkle)
                                }
                                .buttonStyle(.plain)
                            }
                            diaryPager
                            diaryActions(record)
                        } else {
                            unavailableState(record)
                        }
                        if let error { OrbitDetailFeedback(text: error, isError: true, retry: { Task { await load() } }) }
                        else if let notice { OrbitDetailFeedback(text: notice, isError: false, retry: nil) }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 20)
                    .padding(.bottom, 34)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                }
            } else if isLoading {
                OrbitLoadingRow().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                OrbitEmptyCard(title: "这篇日记暂时没有打开", detail: error ?? "返回星轨重新选择一天。", glyph: .orbit)
                    .padding(22)
            }
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: diaryTitle(date)) }
        .task(id: date) { await load() }
        .alert("删除这篇日记？", isPresented: $confirmDelete) {
            Button("删除日记", role: .destructive) { Task { await deleteDiary() } }
            Button("取消", role: .cancel) { }
        } message: {
            Text("这篇日记以及由它产生的摘录和记忆会一起删除；那天的对话仍会保留。此操作无法撤回。")
        }
        .fullScreenCover(item: $lightbox) { image in OrbitDiaryImageLightbox(reference: image) }
    }

    private func diaryHero(_ entry: OrbitDiaryRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                AstellaGlyph(kind: .orbit, tint: .white.opacity(0.86)).frame(width: 13, height: 13)
                Text("A DAY WITH ASTER").font(.system(size: 9, weight: .semibold)).tracking(1.4).foregroundStyle(.white.opacity(0.78))
            }
            Text(diaryLongDate(entry.date))
                .font(.system(size: 29, weight: .medium)).tracking(-0.55).foregroundStyle(.white)
            HStack(spacing: 8) {
                Text(entry.generatedAt.map { "生成于 \(diaryTimestamp($0))" } ?? "生成时间未提供")
                Text("·")
                Text("第 \(entry.revision) 版")
            }
            .font(.system(size: 11)).foregroundStyle(.white.opacity(0.76))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22)
        .padding(.vertical, 22)
        .background {
            RoundedRectangle(cornerRadius: 23, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.30, green: 0.43, blue: 0.62), Color(red: 0.19, green: 0.28, blue: 0.42)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(RoundedRectangle(cornerRadius: 23, style: .continuous).stroke(.white.opacity(0.20), lineWidth: 0.8))
                .shadow(color: StudyPalette.ink.opacity(0.12), radius: 15, x: 0, y: 8)
        }
    }

    private var hiddenNotice: some View {
        HStack(spacing: 10) {
            AstellaGlyph(kind: .info, tint: StudyPalette.accent).frame(width: 17, height: 17)
            Text("这一篇已隐藏，内容仍然保留。")
                .font(.footnote).foregroundStyle(StudyPalette.muted)
            Spacer(minLength: 0)
            Button("恢复显示") { Task { await setHidden(false) } }
                .font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent).disabled(isWorking)
        }
        .padding(13)
        .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private func diaryArticle(_ entry: OrbitDiaryRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                AstellaGlyph(kind: .book, tint: StudyPalette.accent).frame(width: 15, height: 15)
                Text("每日手记").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.accent)
            }
            .padding(.bottom, 17)

            ForEach(entry.blocks) { block in
                switch block.type {
                case "text":
                    ForEach(Array(diaryParagraphs(block.text ?? "").enumerated()), id: \.offset) { _, paragraph in
                        Text(paragraph)
                            .font(.system(size: 16)).lineSpacing(8).foregroundStyle(StudyPalette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 16)
                    }
                case "quote":
                    VStack(alignment: .leading, spacing: 9) {
                        HStack(spacing: 6) {
                            AstellaGlyph(kind: .quote, tint: StudyPalette.accent).frame(width: 14, height: 14)
                            Text(block.label ?? "那时说过的话").font(.system(size: 10, weight: .medium)).foregroundStyle(StudyPalette.muted)
                        }
                        Text(block.text ?? "").font(.system(size: 14)).lineSpacing(6).foregroundStyle(StudyPalette.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(StudyPalette.sky.opacity(0.70), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .padding(.bottom, 17)
                case "image":
                    if let url = block.url, !url.isEmpty {
                        OrbitDiaryImageButton(url: url, label: block.label ?? block.alt ?? "日记配图") {
                            lightbox = OrbitDiaryImageReference(url: url, label: block.label ?? block.alt ?? "日记配图")
                        }
                        .padding(.bottom, 17)
                    }
                default:
                    EmptyView()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(21)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.64), lineWidth: 0.8))
    }

    private var diaryPager: some View {
        HStack(spacing: 12) {
            if let previousDate {
                NavigationLink(value: OrbitNavigationRoute.diaryDay(previousDate)) {
                    HStack(spacing: 6) { AstellaGlyph(kind: .back, tint: StudyPalette.accent).frame(width: 13, height: 13); Text("前一天") }
                        .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.accent)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }.buttonStyle(AstellaPressStyle())
            } else {
                Text("已经是最早的一篇").font(.caption).foregroundStyle(StudyPalette.muted).frame(maxWidth: .infinity, minHeight: 44)
            }
            if let nextDate {
                NavigationLink(value: OrbitNavigationRoute.diaryDay(nextDate)) {
                    HStack(spacing: 6) { Text("后一天"); AstellaGlyph(kind: .chevron, tint: StudyPalette.accent).frame(width: 13, height: 13) }
                        .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.accent)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }.buttonStyle(AstellaPressStyle())
            } else {
                Text("已经是最新的一篇").font(.caption).foregroundStyle(StudyPalette.muted).frame(maxWidth: .infinity, minHeight: 44)
            }
        }
    }

    private func diaryActions(_ entry: OrbitDiaryRecord) -> some View {
        VStack(spacing: 11) {
            Button {
                store.continueWithDiary(date: entry.date, version: entry.revision)
            } label: {
                HStack(spacing: 8) {
                    AstellaGlyph(kind: .chat, tint: .white).frame(width: 17, height: 17)
                    Text("聊聊这篇")
                }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(AstellaPressStyle())
            HStack(spacing: 10) {
                Button(entry.hidden ? "恢复显示" : "隐藏这篇") { Task { await setHidden(!entry.hidden) } }
                    .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.ink)
                    .frame(maxWidth: .infinity, minHeight: 43)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .disabled(isWorking)
                Button("删除") { confirmDelete = true }
                    .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.danger)
                    .frame(maxWidth: .infinity, minHeight: 43)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .disabled(isWorking)
            }
            Text("隐藏不会删除内容；删除会同时移除这篇日记派生的摘录和记忆。")
                .font(.caption2).lineSpacing(3).foregroundStyle(StudyPalette.muted).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func unavailableState(_ entry: OrbitDiaryRecord) -> some View {
        let failed = entry.status == "failed"
        OrbitEmptyCard(
            title: failed ? "这一天她没能写下来" : "这一天还没有日记",
            detail: failed ? diaryFailureDetail(entry.failureReason) : "有值得留下的片段时，她会写在这里。你可以从前后日期继续查看。",
            glyph: failed ? .alert : .orbit
        )
        if let previousDate {
            NavigationLink(value: OrbitNavigationRoute.diaryDay(previousDate)) {
                Text("看前一天").font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }.buttonStyle(.plain)
        }
    }

    private func load() async {
        isLoading = true
        error = nil
        do {
            let value = try await store.api.request("/companion/daily", query: [URLQueryItem(name: "date", value: date)]) as? [String: Any] ?? [:]
            record = OrbitDiaryRecord(value)
            guard record != nil else { throw MobileAPIError(status: 502, code: "invalid_daily", message: "日记格式无法读取。") }
            await loadAvailableDates()
        } catch {
            guard !Task.isCancelled else { isLoading = false; return }
            self.error = mobilePageError(error, fallback: "日记没有加载成功，请稍后重试。")
        }
        isLoading = false
    }

    private func loadAvailableDates() async {
        var found = Set<String>()
        for month in diaryMonthWindow(around: date) {
            guard !Task.isCancelled else { return }
            do {
                let result = try await store.api.request("/companion/daily/month", query: [URLQueryItem(name: "month", value: month)]) as? [String: Any] ?? [:]
                for item in result["days"] as? [[String: Any]] ?? [] where item["status"] as? String == "generated" {
                    if let day = item["date"] as? String { found.insert(day) }
                }
            } catch {
                // The page remains readable; date navigation is simply unavailable.
            }
        }
        availableDates = found.sorted()
    }

    private func setHidden(_ hidden: Bool) async {
        guard !isWorking, record != nil else { return }
        isWorking = true
        error = nil
        do {
            _ = try await store.api.request("/companion/daily/\(date)/\(hidden ? "hide" : "unhide")", method: "POST", body: [:])
            record?.hidden = hidden
            notice = hidden ? "已隐藏。这篇日记仍然保留，可以随时恢复显示。" : "已恢复显示。"
        } catch { self.error = mobilePageError(error, fallback: "日记状态没有更新，请重试。") }
        isWorking = false
    }

    private func deleteDiary() async {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        do {
            _ = try await store.api.request("/companion/daily/\(date)/delete", method: "POST", body: [:])
            dismiss()
        } catch {
            self.error = mobilePageError(error, fallback: "日记没有删除，请刷新后重试。")
            isWorking = false
        }
    }
}

private struct OrbitDiaryImageReference: Identifiable {
    var url: String
    var label: String
    var id: String { url }
}

private struct OrbitDiaryImageButton: View {
    @Environment(AppStore.self) private var store
    let url: String
    let label: String
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Button(action: onOpen) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity).frame(maxHeight: 390)
                } else if failed {
                    HStack(spacing: 8) { AstellaGlyph(kind: .photo, tint: StudyPalette.muted).frame(width: 18, height: 18); Text("图片暂时无法加载") }
                        .font(.footnote).foregroundStyle(StudyPalette.muted).frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 150)
                }
            }
            .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                Text(label).font(.caption).foregroundStyle(StudyPalette.ink).padding(9)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous)).padding(8)
            }
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityLabel("打开日记图片：\(label)")
        .task(id: url) {
            do {
                image = UIImage(data: try await store.api.imageData(url))
                failed = image == nil
            } catch { failed = true }
        }
    }
}

private struct OrbitDiaryImageLightbox: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let reference: OrbitDiaryImageReference
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let image {
                Image(uiImage: image).resizable().scaledToFit().padding(18)
            } else if failed {
                Text("图片暂时无法加载").font(.footnote).foregroundStyle(.white.opacity(0.78))
            } else {
                ProgressView().tint(.white)
            }
            Button { dismiss() } label: {
                AstellaGlyph(kind: .close, tint: .white).frame(width: 20, height: 20).frame(width: 44, height: 44)
                    .background(.white.opacity(0.16), in: Circle())
            }
            .padding(.top, 12).padding(.trailing, 14)
            .accessibilityLabel("关闭图片")
        }
        .task(id: reference.url) {
            do { image = UIImage(data: try await store.api.imageData(reference.url)); failed = image == nil }
            catch { failed = true }
        }
    }
}

private struct OrbitMemoryRecord {
    var id: String
    var kind: String
    var content: String
    var appliesWhen: String?
    var sourceEventId: String?
    var sourceEventIds: [String]
    var sourceSpeaker: String?
    var sourceBasis: String?
    var sourceType: String
    var authorType: String
    var epistemicStatus: String
    var scope: String
    var budgetTier: String
    var candidate: Bool
    var pinned: Bool
    var archived: Bool
    var userConfirmed: Bool
    var confidence: Double
    var revision: Int
    var createdAt: String?
    var confirmedAt: String?
    var validFrom: String?
    var validUntil: String?
    var supersededById: String?

    init?(_ value: [String: Any]) {
        guard let id = value["memoryItemId"] as? String,
              let content = value["content"] as? String else { return nil }
        self.id = id
        kind = value["kind"] as? String ?? ""
        self.content = content
        appliesWhen = value["appliesWhen"] as? String
        sourceEventId = value["sourceEventId"] as? String
        sourceEventIds = value["sourceEventIds"] as? [String] ?? []
        sourceSpeaker = value["sourceSpeaker"] as? String
        sourceBasis = value["sourceBasis"] as? String
        sourceType = value["sourceType"] as? String ?? ""
        authorType = value["authorType"] as? String ?? ""
        epistemicStatus = value["epistemicStatus"] as? String ?? ""
        scope = value["scope"] as? String ?? "workspace"
        budgetTier = value["budgetTier"] as? String ?? "active"
        candidate = value["candidate"] as? Bool ?? false
        pinned = value["pinned"] as? Bool ?? false
        archived = value["archived"] as? Bool ?? false
        userConfirmed = value["userConfirmed"] as? Bool ?? false
        confidence = value["confidence"] as? Double ?? 0
        revision = value["revision"] as? Int ?? 1
        createdAt = value["createdAt"] as? String
        confirmedAt = value["confirmedAt"] as? String
        validFrom = value["validFrom"] as? String
        validUntil = value["validUntil"] as? String
        supersededById = value["supersededById"] as? String
    }
}

private struct OrbitMemoryRevision: Identifiable {
    var revision: Int
    var content: String
    var sourceType: String
    var authorType: String
    var epistemicStatus: String
    var scope: String
    var appliesWhen: String?
    var supersededAt: String?
    var id: Int { revision }

    init?(_ value: [String: Any]) {
        guard let revision = value["revision"] as? Int,
              let content = value["content"] as? String else { return nil }
        self.revision = revision
        self.content = content
        sourceType = value["sourceType"] as? String ?? ""
        authorType = value["authorType"] as? String ?? ""
        epistemicStatus = value["epistemicStatus"] as? String ?? ""
        scope = value["scope"] as? String ?? "workspace"
        appliesWhen = value["appliesWhen"] as? String
        supersededAt = value["supersededAt"] as? String
    }
}

struct OrbitMemoryDetailScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let memoryId: String

    @State private var memory: OrbitMemoryRecord?
    @State private var revisions: [OrbitMemoryRevision] = []
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var isEditing = false
    @State private var confirmDelete = false
    @State private var contentDraft = ""
    @State private var appliesWhenDraft = ""
    @State private var error: String?
    @State private var revisionError: String?
    @State private var notice: String?

    var body: some View {
        Group {
            if let memory {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        memorySummary(memory)
                        sourceFacts(memory)
                        if isEditing { correctionForm(memory) }
                        else {
                            Button { beginEditing(memory) } label: {
                                HStack(spacing: 8) { AstellaGlyph(kind: .edit, tint: .white).frame(width: 16, height: 16); Text("修订这条记忆") }
                                    .font(.footnote.weight(.semibold)).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 45)
                                    .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                            }.buttonStyle(AstellaPressStyle()).disabled(memory.archived)
                        }
                        memoryActions(memory)
                        revisionHistory
                        if let error { OrbitDetailFeedback(text: error, isError: true, retry: { Task { await load() } }) }
                        else if let notice { OrbitDetailFeedback(text: notice, isError: false, retry: nil) }
                    }
                    .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 34)
                    .frame(maxWidth: 620).frame(maxWidth: .infinity)
                }
            } else if isLoading {
                OrbitLoadingRow().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                OrbitEmptyCard(title: "这条记忆暂时没有打开", detail: error ?? "返回星轨重新选择。", glyph: .companion).padding(22)
            }
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "记忆详情") }
        .task(id: memoryId) { await load() }
        .alert("将这条记忆移入回收站？", isPresented: $confirmDelete) {
            Button("移入回收站", role: .destructive) { Task { await deleteMemory() } }
            Button("取消", role: .cancel) { }
        } message: { Text("移入回收站后仍可恢复，回收区内容之后可以永久清除。") }
    }

    private func memorySummary(_ item: OrbitMemoryRecord) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 7) {
                Text(memoryKindLabel(item.kind)).font(.system(size: 10, weight: .semibold)).foregroundStyle(StudyPalette.accent)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(StudyPalette.sky, in: Capsule())
                Text(memoryStateLabel(item)).font(.system(size: 10, weight: .medium)).foregroundStyle(item.candidate ? StudyPalette.danger : StudyPalette.muted)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(StudyPalette.inset, in: Capsule())
                Spacer()
                if item.pinned { AstellaGlyph(kind: .history, tint: StudyPalette.accent).frame(width: 16, height: 16).accessibilityLabel("已固定") }
            }
            Text(item.content)
                .font(.system(size: 22, weight: .medium)).tracking(-0.3).lineSpacing(5)
                .foregroundStyle(StudyPalette.ink).fixedSize(horizontal: false, vertical: true)
            if item.sourceBasis == "inferred_from_statement" || item.sourceSpeaker == "companion" {
                HStack(alignment: .top, spacing: 8) {
                    AstellaGlyph(kind: .info, tint: StudyPalette.accent).frame(width: 15, height: 15)
                    Text("这是她根据已有记录整理的理解，不是你亲口说的话。你可以先核对，再决定是否采用。")
                        .font(.caption).lineSpacing(4).foregroundStyle(StudyPalette.muted)
                }.padding(12).background(StudyPalette.sky.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(19)
        .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 21, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.66), lineWidth: 0.8))
    }

    private func sourceFacts(_ item: OrbitMemoryRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("来源与范围").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted).padding(.bottom, 9)
            memoryFact("来源性质", memorySourceLabel(item.sourceType))
            memoryFact("说话者", memorySpeakerLabel(item.sourceSpeaker, author: item.authorType))
            memoryFact("适用范围", memoryScopeLabel(item.scope))
            memoryFact("适用条件", item.appliesWhen?.isEmpty == false ? item.appliesWhen! : "未限定")
            memoryFact("依据", item.sourceEventId == nil && item.sourceEventIds.isEmpty ? "来源未记录" : "已保留来源引用；移动端暂不支持定位到原始对话")
            memoryFact("确认状态", item.candidate ? "等待你确认" : item.userConfirmed ? "已由你确认" : memoryEpistemicLabel(item.epistemicStatus))
            memoryFact("有效期", "\(memoryDateLabel(item.validFrom ?? item.createdAt)) 至 \(item.validUntil.map(memoryDateLabel) ?? "无截止时间")")
            memoryFact("修订", "第 \(item.revision) 版 · 可信度 \(Int(item.confidence * 100))%")
            if let confirmedAt = item.confirmedAt { memoryFact("确认于", memoryDateLabel(confirmedAt)) }
            if let supersededById = item.supersededById {
                NavigationLink(value: OrbitNavigationRoute.memory(supersededById)) {
                    settingDestinationRow(title: "查看替代它的记忆", detail: "这条内容已经被另一条记忆更新", glyph: .chevron)
                }.buttonStyle(.plain).padding(.top, 5)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
    }

    private func memoryFact(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(.system(size: 11)).foregroundStyle(StudyPalette.muted).frame(width: 64, alignment: .leading)
            Text(value).font(.system(size: 12)).lineSpacing(3).foregroundStyle(StudyPalette.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }.padding(.vertical, 9)
        .overlay(alignment: .bottom) { Rectangle().fill(StudyPalette.paperEdge.opacity(0.48)).frame(height: 0.6) }
    }

    private func correctionForm(_ item: OrbitMemoryRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("修订内容").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
                Spacer()
                Text("\(contentDraft.count) / 200").font(.caption2).foregroundStyle(StudyPalette.muted)
            }
            TextEditor(text: $contentDraft)
                .font(.system(size: 15)).lineSpacing(4).frame(minHeight: 110).padding(7)
                .scrollContentBackground(.hidden).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .onChange(of: contentDraft) { _, value in if value.count > 200 { contentDraft = String(value.prefix(200)) } }
            TextField("适用条件（选填）", text: $appliesWhenDraft)
                .font(.system(size: 14)).padding(13).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .onChange(of: appliesWhenDraft) { _, value in if value.count > 200 { appliesWhenDraft = String(value.prefix(200)) } }
            Text("保存后会保留原始来源与旧版本。")
                .font(.caption).foregroundStyle(StudyPalette.muted)
            HStack(spacing: 10) {
                Button("取消") { isEditing = false }
                    .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.ink).frame(maxWidth: .infinity, minHeight: 43)
                    .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                Button(isWorking ? "正在保存…" : "保存修订") { Task { await correctMemory(item) } }
                    .font(.footnote.weight(.semibold)).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 43)
                    .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .disabled(isWorking || contentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || contentDraft == item.content && (appliesWhenDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : appliesWhenDraft.trimmingCharacters(in: .whitespacesAndNewlines)) == item.appliesWhen)
            }
        }
        .padding(16)
        .background(StudyPalette.paper.opacity(0.85), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
    }

    private func memoryActions(_ item: OrbitMemoryRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if item.candidate {
                Button { Task { await performMemoryAction("confirm") } } label: { actionRow("确认采用这条记忆", glyph: .check, tint: StudyPalette.accent) }
                    .disabled(isWorking)
                Button { Task { await performMemoryAction("dismiss") } } label: { actionRow("暂不采用", glyph: .close, tint: StudyPalette.muted) }
                    .disabled(isWorking)
            } else {
                HStack(spacing: 10) {
                    if !item.archived {
                        Button { Task { await performMemoryAction(item.pinned ? "unpin" : "pin") } } label: {
                            actionChip(item.pinned ? "取消固定" : "固定", glyph: .history)
                        }.disabled(isWorking)
                    }
                    Button { Task { await performMemoryAction(item.archived ? "restore" : "archive") } } label: {
                        actionChip(item.archived ? "恢复使用" : "暂时不用", glyph: item.archived ? .refresh : .download)
                    }.disabled(isWorking)
                }
                if item.epistemicStatus != "disputed" && item.epistemicStatus != "superseded" {
                    Button { Task { await disputeMemory(item) } } label: {
                        actionRow("标记有争议", glyph: .alert, tint: StudyPalette.muted)
                    }.disabled(isWorking)
                }
            }
            Button("删除到回收站") { confirmDelete = true }
                .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.danger)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .disabled(isWorking)
            Text("普通删除会进入可恢复回收站；彻底清除需要在回收站再次确认。")
                .font(.caption2).foregroundStyle(StudyPalette.muted)
        }
    }

    private func actionRow(_ title: String, glyph: AstellaGlyphKind, tint: Color) -> some View {
        HStack(spacing: 9) {
            AstellaGlyph(kind: glyph, tint: tint).frame(width: 16, height: 16)
            Text(title).font(.footnote.weight(.medium)).foregroundStyle(tint)
            Spacer()
            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 14, height: 14)
        }.padding(.horizontal, 13).frame(minHeight: 46).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func actionChip(_ title: String, glyph: AstellaGlyphKind) -> some View {
        HStack(spacing: 7) { AstellaGlyph(kind: glyph, tint: StudyPalette.accent).frame(width: 14, height: 14); Text(title).font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.ink) }
            .frame(maxWidth: .infinity, minHeight: 42).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    @ViewBuilder private var revisionHistory: some View {
        if revisionError != nil || !revisions.isEmpty {
            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Text("修订历史").font(.system(size: 11, weight: .semibold)).foregroundStyle(StudyPalette.muted)
                    Spacer()
                    Button("重新读取") { Task { await loadRevisions() } }.font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                }
                if let revisionError { Text(revisionError).font(.footnote).foregroundStyle(StudyPalette.danger) }
                ForEach(revisions) { revision in
                    VStack(alignment: .leading, spacing: 7) {
                        Text("第 \(revision.revision) 版 · \(memorySourceLabel(revision.sourceType)) · \(memoryDateLabel(revision.supersededAt))")
                            .font(.caption2).foregroundStyle(StudyPalette.muted)
                        Text(revision.content).font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.ink)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
            }
            .padding(15).background(StudyPalette.paper.opacity(0.68), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        }
    }

    private func beginEditing(_ item: OrbitMemoryRecord) {
        contentDraft = item.content
        appliesWhenDraft = item.appliesWhen ?? ""
        isEditing = true
        error = nil
    }

    private func load() async {
        isLoading = true
        error = nil
        do {
            let response = try await store.api.request("/companion/memory", query: [
                URLQueryItem(name: "focusMemoryId", value: memoryId),
                URLQueryItem(name: "includeCandidates", value: "true"),
                URLQueryItem(name: "includeArchived", value: "true"),
            ]) as? [String: Any] ?? [:]
            let raw = response["items"] as? [[String: Any]] ?? []
            memory = raw.compactMap(OrbitMemoryRecord.init).first(where: { $0.id == memoryId })
            guard memory != nil else { throw MobileAPIError(status: 404, code: "memory_not_found", message: "找不到这条记忆。") }
            await loadRevisions()
        } catch {
            guard !Task.isCancelled else { isLoading = false; return }
            self.error = mobilePageError(error, fallback: "记忆没有加载成功，请稍后重试。")
        }
        isLoading = false
    }

    private func loadRevisions() async {
        do {
            let result = try await store.api.request("/companion/memory/\(memoryId)/revisions") as? [String: Any] ?? [:]
            revisions = (result["items"] as? [[String: Any]] ?? []).compactMap(OrbitMemoryRevision.init)
            revisionError = nil
        } catch { revisionError = mobilePageError(error, fallback: "旧版本暂时读不到。") }
    }

    private func correctMemory(_ item: OrbitMemoryRecord) async {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        let appliesWhen = appliesWhenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let body: [String: Any] = [
                "content": contentDraft.trimmingCharacters(in: .whitespacesAndNewlines),
                "expectedRevision": item.revision,
                "appliesWhen": appliesWhen.isEmpty ? NSNull() : appliesWhen as Any,
            ]
            _ = try await store.api.request("/companion/memory/\(memoryId)/correct", method: "POST", body: body)
            notice = "已保存修订，原始来源与旧版本仍保留。"
            isEditing = false
            await load()
        } catch { self.error = mobilePageError(error, fallback: "记忆没有修订，请重新读取后再试。") }
        isWorking = false
    }

    private func performMemoryAction(_ action: String) async {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        do {
            _ = try await store.api.request("/companion/memory/\(memoryId)/\(action)", method: "POST", body: [:])
            if action == "dismiss" { dismiss(); return }
            notice = action == "confirm" ? "已确认这条记忆。" : action == "archive" ? "已暂时停用这条记忆。" : action == "restore" ? "已恢复使用。" : action == "pin" ? "已固定。" : "已更新。"
            await load()
        } catch { self.error = mobilePageError(error, fallback: "记忆状态没有更新，请重试。") }
        isWorking = false
    }

    private func disputeMemory(_ item: OrbitMemoryRecord) async {
        guard !isWorking else { return }
        isWorking = true
        do {
            _ = try await store.api.request("/companion/memory/\(memoryId)/dispute", method: "POST", body: ["expectedRevision": item.revision])
            notice = "已标记为有争议。"
            await load()
        } catch { self.error = mobilePageError(error, fallback: "争议状态没有更新，请重新读取后再试。") }
        isWorking = false
    }

    private func deleteMemory() async {
        guard !isWorking else { return }
        isWorking = true
        do {
            _ = try await store.api.request("/companion/memory/\(memoryId)", method: "DELETE")
            dismiss()
        } catch { self.error = mobilePageError(error, fallback: "记忆没有移入回收站，请重试。") }
        isWorking = false
    }
}

private struct RecycledOrbitMemory: Identifiable {
    var id: String
    var kind: String
    var content: String
    var deletedAt: String
    var purgeAfter: String

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let content = value["content"] as? String else { return nil }
        self.id = id
        kind = value["kind"] as? String ?? ""
        self.content = content
        deletedAt = value["deletedAt"] as? String ?? ""
        purgeAfter = value["purgeAfter"] as? String ?? ""
    }
}

struct OrbitMemoryRecycleScreen: View {
    @Environment(AppStore.self) private var store
    @State private var memories: [RecycledOrbitMemory] = []
    @State private var selectedForErase: RecycledOrbitMemory?
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var error: String?
    @State private var notice: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                Text("普通删除会把记忆放进回收站。恢复后会重新参与伴星的记忆检索；彻底清除后无法恢复。")
                    .font(.footnote).lineSpacing(4).foregroundStyle(StudyPalette.muted).padding(.horizontal, 3)
                if isLoading { OrbitLoadingRow() }
                else if let error { OrbitDetailFeedback(text: error, isError: true, retry: { Task { await load() } }) }
                else if memories.isEmpty { OrbitEmptyCard(title: "回收站是空的", detail: "移入回收站的记忆会显示在这里。", glyph: .history) }
                else {
                    ForEach(memories) { memory in
                        PaperSurface(padding: 16, radius: 17) {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text(memoryKindLabel(memory.kind)).font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                                    Spacer()
                                    Text("删除于 \(memoryDateLabel(memory.deletedAt))").font(.caption2).foregroundStyle(StudyPalette.muted)
                                }
                                Text(memory.content).font(.subheadline).lineSpacing(4).foregroundStyle(StudyPalette.ink)
                                Text("预计清理：\(memoryDateLabel(memory.purgeAfter))")
                                    .font(.caption2).foregroundStyle(StudyPalette.muted)
                                HStack(spacing: 10) {
                                    Button("恢复") { Task { await restore(memory) } }
                                        .font(.footnote.weight(.semibold)).foregroundStyle(StudyPalette.accent).frame(maxWidth: .infinity, minHeight: 39)
                                        .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    Button("彻底清除") { selectedForErase = memory }
                                        .font(.footnote.weight(.medium)).foregroundStyle(StudyPalette.danger).frame(maxWidth: .infinity, minHeight: 39)
                                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                                .disabled(isWorking)
                            }
                        }
                    }
                }
                if let notice { OrbitDetailFeedback(text: notice, isError: false, retry: nil) }
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 34)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden).background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "记忆回收站") }
        .task { await load() }
        .alert("彻底清除这条记忆？", isPresented: Binding(get: { selectedForErase != nil }, set: { if !$0 { selectedForErase = nil } })) {
            Button("彻底清除", role: .destructive) { if let item = selectedForErase { Task { await erase(item) } } }
            Button("取消", role: .cancel) { selectedForErase = nil }
        } message: { Text("内容和修订历史都会被永久清除，无法恢复。") }
    }

    private func load() async {
        isLoading = true
        error = nil
        do {
            let result = try await store.api.request("/companion/memory/recycle") as? [String: Any] ?? [:]
            memories = (result["items"] as? [[String: Any]] ?? []).compactMap(RecycledOrbitMemory.init)
        } catch {
            guard !Task.isCancelled else { isLoading = false; return }
            self.error = mobilePageError(error, fallback: "回收站暂时无法读取。")
        }
        isLoading = false
    }

    private func restore(_ item: RecycledOrbitMemory) async {
        guard !isWorking else { return }
        isWorking = true
        do {
            _ = try await store.api.request("/companion/memory/\(item.id)/restore-deleted", method: "POST", body: [:])
            notice = "已恢复记忆。"
            await load()
        } catch let caughtError { self.error = mobilePageError(caughtError, fallback: "记忆没有恢复，请重试。") }
        isWorking = false
    }

    private func erase(_ item: RecycledOrbitMemory) async {
        guard !isWorking else { return }
        isWorking = true
        do {
            _ = try await store.api.request("/companion/memory/\(item.id)/erase", method: "DELETE")
            selectedForErase = nil
            notice = "已彻底清除。"
            await load()
        } catch let caughtError { self.error = mobilePageError(caughtError, fallback: "记忆没有清除，请重试。") }
        isWorking = false
    }
}

private struct OrbitDetailFeedback: View {
    let text: String
    let isError: Bool
    let retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AstellaGlyph(kind: isError ? .alert : .check, tint: isError ? StudyPalette.danger : StudyPalette.success).frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 5) {
                Text(text).font(.footnote).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                if let retry { Button("重新读取", action: retry).font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent) }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private func diaryParagraphs(_ text: String) -> [String] {
    text.components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func diaryDate(_ value: String) -> Date? {
    let parts = value.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

private func diaryTitle(_ value: String) -> String {
    guard let date = diaryDate(value) else { return "日记全文" }
    return "\(Calendar.current.component(.month, from: date))月\(Calendar.current.component(.day, from: date))日日记"
}

private func diaryLongDate(_ value: String) -> String {
    guard let date = diaryDate(value) else { return value }
    return date.formatted(.dateTime.month(.wide).day())
}

private func diaryTimestamp(_ value: String) -> String {
    let parser = ISO8601DateFormatter()
    guard let date = parser.date(from: value) else { return String(value.prefix(16)).replacingOccurrences(of: "T", with: " ") }
    return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
}

private func diaryMonthWindow(around value: String) -> [String] {
    guard let date = diaryDate(value) else { return [] }
    var result: [String] = []
    let formatter = DateFormatter()
    formatter.calendar = Calendar.current
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = Calendar.current.timeZone
    formatter.dateFormat = "yyyy-MM"
    for offset in -1...1 {
        guard let monthDate = Calendar.current.date(byAdding: .month, value: offset, to: date) else { continue }
        result.append(formatter.string(from: monthDate))
    }
    return result
}

private func diaryFailureDetail(_ reason: String?) -> String {
    switch reason {
    case "consent_required": "尚未同意使用外部 AI 服务，日记没有开始生成。"
    case "model_unavailable": "日记生成服务暂时不可用，这一天没有生成日记。"
    case "diary_output_invalid": "这次生成的内容没有通过保存检查，因此没有写入。"
    default: "日记没有生成成功。你可以稍后重新读取，或查看其他日期。"
    }
}

private func memoryStateLabel(_ memory: OrbitMemoryRecord) -> String {
    if memory.candidate { return "待确认" }
    if memory.archived { return "已归档" }
    if memory.pinned { return "已固定" }
    return switch memory.epistemicStatus {
    case "disputed": "有争议"
    case "tentative": "待核对"
    case "superseded": "已被替代"
    default: memory.userConfirmed ? "已确认" : "正在使用"
    }
}

private func memoryScopeLabel(_ scope: String) -> String {
    switch scope {
    case "global": "所有书房"
    case "task": "当前任务"
    default: "当前书房"
    }
}

private func memorySourceLabel(_ source: String) -> String {
    switch source {
    case "user_stated": "用户自述"
    case "model_inferred": "模型推断"
    case "confirmed": "用户确认"
    case "summary": "摘要整理"
    default: source.isEmpty ? "未记录" : source
    }
}

private func memorySpeakerLabel(_ speaker: String?, author: String) -> String {
    switch speaker {
    case "user": "用户原话"
    case "assistant": "伴星发言"
    case "companion": "伴星自己的理解"
    default:
        switch author {
        case "user": "你修订的内容"
        case "companion": "伴星整理"
        default: "未记录"
        }
    }
}

private func memoryEpistemicLabel(_ status: String) -> String {
    switch status {
    case "supported": "有据"
    case "tentative": "待核对"
    case "disputed": "有争议"
    case "superseded": "已被替代"
    default: "尚未确认"
    }
}

private func memoryDateLabel(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "时间未提供" }
    let parser = ISO8601DateFormatter()
    guard let date = parser.date(from: value) else { return String(value.prefix(10)) }
    return date.formatted(.dateTime.year().month().day())
}
