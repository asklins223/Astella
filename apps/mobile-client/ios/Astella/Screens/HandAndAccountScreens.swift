import SwiftUI
import PhotosUI
import UIKit
import ImageIO

private enum OrbitSection: String, CaseIterable {
    case diary = "日记"
    case memory = "伴星记忆"
    case hand = "手边"
}

private enum OrbitMemoryGroup: String, CaseIterable {
    case aboutYou = "关于你的"
    case herNotes = "她的记事"
    case goals = "目标与方法"
}

private enum OrbitMemoryFilter: String, CaseIterable {
    case active = "正在使用"
    case candidate = "待确认"
    case resident = "固定"
    case disputed = "有争议"
    case archived = "已归档"
}

private struct OrbitDay: Identifiable {
    var date: String
    var status: String
    var hasImage = false
    var id: String { date }
}

private struct OrbitMemory: Identifiable {
    var id: String
    var content: String
    var kind: String
    var tier: String
    var candidate: Bool
}

struct OrbitScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var section: OrbitSection = .diary
    @State private var days: [OrbitDay] = []
    @State private var diarySummaries: [String: String] = [:]
    @State private var firstGeneratedDate: Date?
    @State private var memories: [OrbitMemory] = []
    @State private var loading = true
    @State private var diaryError: String?
    @State private var memoryError: String?
    @State private var memoryGroup: OrbitMemoryGroup = .aboutYou
    @State private var memoryFilter: OrbitMemoryFilter = .active
    @State private var appeared = false
    @Namespace private var sectionLens
    @Namespace private var memoryGroupLens

    private var recentDays: [OrbitDay] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -13, to: Calendar.current.startOfDay(for: Date())) ?? .distantPast
        return days.filter { (orbitDate($0.date) ?? .distantPast) >= cutoff }
    }
    private var companionDays: Int {
        guard let firstGeneratedDate else { return 0 }
        let elapsedDays = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: firstGeneratedDate), to: Calendar.current.startOfDay(for: Date())).day ?? 0
        return max(1, elapsedDays + 1)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                orbitHero
                    .shellEntrance(0, active: appeared)
                sectionPicker
                    .padding(.top, 20)
                    .shellEntrance(1, active: appeared)
                Group {
                    switch section {
                    case .diary: diaryContent.padding(.top, 22)
                    case .memory: memoryContent.padding(.top, 22)
                    case .hand: handContent.padding(.top, 22)
                    }
                }
                .shellEntrance(2, active: appeared)
            }
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 128)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .onAppear {
            guard !appeared else { return }
            Task { @MainActor in
                await Task.yield()
                appeared = true
            }
        }
        .task {
            #if DEBUG
            if ["orbit", "orbit-memory", "orbit-tasks"].contains(store.uiReviewMode ?? "") {
                if store.orbitRootSection == "memory" { section = .memory }
                else if store.orbitRootSection == "hand" { section = .hand }
                else { section = .diary }
                days = [
                    OrbitDay(date: "2026-10-16", status: "generated", hasImage: true),
                    OrbitDay(date: "2026-10-15", status: "generated"),
                    OrbitDay(date: "2026-10-13", status: "generated"),
                ]
                diarySummaries = [
                    "2026-10-16": "今晚把《赤壁赋》读到了「惟江上之清风，与山间之明月」，她说这句话最像我们现在的样子。",
                    "2026-10-15": "第一次做完一整套回想题，第三题卡了很久，翻开对照之后才想起来。",
                    "2026-10-13": "把那篇英语长难句存进了书房，她提醒我这周还有 4 条批注没看。",
                ]
                memories = [
                    OrbitMemory(id: "memory-preference", content: "你偏好先读原文，再看注解", kind: "preference", tier: "active", candidate: false),
                    OrbitMemory(id: "memory-attention", content: "你不太喜欢被一次问太多问题", kind: "interaction_note", tier: "resident", candidate: false),
                    OrbitMemory(id: "memory-rhythm", content: "你更喜欢先安静读十分钟，再开口讨论", kind: "preference", tier: "active", candidate: false),
                    OrbitMemory(id: "memory-candidate", content: "最近常在晚上九点后读书", kind: "preference", tier: "active", candidate: true),
                    OrbitMemory(id: "memory-goal", content: "这学期想把《古文观止》读完", kind: "goal", tier: "active", candidate: false),
                ]
                firstGeneratedDate = Calendar.current.date(byAdding: .day, value: -6, to: Date())
                loading = false
                return
            }
            if store.uiReviewMode != nil { loading = false; return }
            #endif
            if store.orbitRootSection == "hand" { section = .hand }
            else if store.orbitRootSection == "memory" { section = .memory }
            store.orbitRootSection = "diary"
            await loadOrbit()
            await loadDiarySummaries()
        }
    }

    private var orbitHero: some View {
        let active = recentDays.filter { $0.status == "generated" }.count
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("拾星 · 相伴的日子")
                        .font(.system(size: 10, weight: .medium)).tracking(1.4)
                        .foregroundStyle(.white.opacity(0.66))
                    Group {
                        if companionDays > 0 {
                            Text("相伴 ") + Text("\(companionDays)").fontWeight(.bold) + Text(" 天")
                        } else {
                            Text("从第一颗星开始")
                        }
                    }
                    .font(.system(size: 34, weight: .medium))
                    .tracking(-0.9)
                    .foregroundStyle(.white)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                    Text("我们一起走过的日子，都成了星光。")
                        .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.72))
                }
                Spacer(minLength: 0)
                Image("CompanionAvatar")
                    .resizable().scaledToFill()
                    .frame(width: 56, height: 56).clipShape(Circle())
                    .background(.white.opacity(0.10), in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.32), lineWidth: 1))
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            OrbitStarTrail(days: recentDays)
                .frame(height: 86)
                .padding(.top, 20)
            HStack(alignment: .center) {
                Text("最近 14 天").foregroundStyle(.white.opacity(0.66))
                Spacer()
                HStack(spacing: 5) {
                    AstellaGlyph(kind: .orbit, tint: .white).frame(width: 12, height: 12)
                    Text("点亮 \(active) 颗星").foregroundStyle(.white)
                }
            }
            .font(.system(size: 11, weight: .medium))
            .padding(.top, 4)
        }
        .padding(.horizontal, 26)
        .padding(.top, 30)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: 270, alignment: .topLeading)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.25, green: 0.38, blue: 0.56),
                            Color(red: 0.17, green: 0.25, blue: 0.38),
                            Color(red: 0.15, green: 0.21, blue: 0.31),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(RadialGradient(
                            colors: [Color(red: 0.47, green: 0.64, blue: 0.89).opacity(0.42), .clear],
                            center: .topLeading,
                            startRadius: 0,
                            endRadius: 300
                        ))
                }
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.18), lineWidth: 0.8))
                .shadow(color: Color(red: 0.15, green: 0.24, blue: 0.38).opacity(0.20), radius: 16, x: 0, y: 11)
        }
    }

    private var sectionPicker: some View {
        HStack(spacing: 3) {
            ForEach(OrbitSection.allCases, id: \.self) { item in
                let selected = item == section
                Button {
                    withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment)) { section = item }
                } label: {
                    ZStack {
                        if selected {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(StudyPalette.paper)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7))
                                .shadow(color: StudyPalette.ink.opacity(0.05), radius: 4, x: 0, y: 2)
                                .matchedGeometryEffect(id: "orbit-section-lens", in: sectionLens)
                        }
                        Text(item.rawValue)
                            .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .contentShape(Rectangle())
                    }
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(4)
        .frame(height: 46)
        .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))
    }

    private var diaryContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("她替你写下的日子")
                        .font(.system(size: 17, weight: .semibold))
                        .tracking(-0.2)
                        .foregroundStyle(StudyPalette.ink)
                    Text("列表只给摘要，点开看当日全文。")
                        .font(.system(size: 12))
                        .foregroundStyle(StudyPalette.muted)
                }
                Spacer(minLength: 8)
                Button {
                    withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.routePush)) {
                        store.beginDiaryCapture()
                    }
                } label: {
                    HStack(spacing: 6) {
                        AstellaGlyph(kind: .edit, tint: StudyPalette.accent).frame(width: 14, height: 14)
                        Text("聊聊今天").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(StudyPalette.ink)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .modifier(StudyGlassSurfaceStyle(radius: 18, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .sensoryFeedback(.selection, trigger: store.selectedTab)
                .accessibilityLabel("告诉伴星今天想记下的事")
                .accessibilityHint("打开对话并聚焦输入框，发送前可以继续编辑")
            }
            .padding(.bottom, 18)

            if loading { OrbitLoadingRow() }
            else if let diaryError { OrbitEmptyCard(title: "暂时看不到星迹", detail: diaryError, glyph: .orbit) }
            else if recentDays.filter({ $0.status == "generated" }).isEmpty {
                OrbitEmptyCard(title: "星轨还很安静", detail: "等伴星写下第一篇日记，这里就会亮起一颗星。", glyph: .orbit)
            } else {
                ForEach(Array(recentDays.filter { $0.status == "generated" }.sorted { $0.date > $1.date }.enumerated()), id: \.element.id) { index, day in
                    OrbitDiaryRow(day: day, summary: diarySummaries[day.date])
                        .padding(.bottom, 13)
                        .shellEntrance(3 + index, active: appeared)
                }
            }
        }
    }

    private var memoryContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("她记住的事")
                    .font(.system(size: 17, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(StudyPalette.ink)
                Text("从相处里记下的事实，可核对、修订或收回。")
                    .font(.system(size: 12))
                    .foregroundStyle(StudyPalette.muted)
            }
            .padding(.bottom, 16)

            memoryGroupPicker
                .padding(.bottom, 12)

            memoryFilterChips
                .padding(.bottom, 18)

            if loading { OrbitLoadingRow() }
            else if let memoryError { OrbitEmptyCard(title: "记忆暂时不可用", detail: memoryError, glyph: .companion) }
            else if visibleMemories.isEmpty {
                OrbitEmptyCard(title: memoryEmptyTitle, detail: memoryEmptyDetail, glyph: .companion)
            } else {
                ForEach(Array(visibleMemories.enumerated()), id: \.element.id) { index, memory in
                    NavigationLink(value: OrbitNavigationRoute.memory(memory.id)) {
                        memoryCard(memory)
                    }
                    .buttonStyle(AstellaPressStyle())
                    .padding(.bottom, 12)
                    .shellEntrance(3 + index, active: appeared)
                }
            }

            NavigationLink(value: OrbitNavigationRoute.memoryRecycle) {
                settingDestinationRow(title: "记忆回收站", detail: "恢复最近删除的记忆", glyph: .history)
            }
            .buttonStyle(AstellaPressStyle())
            .padding(.top, 8)
        }
    }

    private var memoryGroupPicker: some View {
        HStack(spacing: 2) {
            ForEach(OrbitMemoryGroup.allCases, id: \.self) { group in
                let selected = group == memoryGroup
                Button {
                    withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.segment)) {
                        memoryGroup = group
                        memoryFilter = .active
                    }
                } label: {
                    ZStack {
                        if selected {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(StudyPalette.paper)
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7))
                                .shadow(color: StudyPalette.ink.opacity(0.04), radius: 3, x: 0, y: 1)
                                .matchedGeometryEffect(id: "orbit-memory-group-lens", in: memoryGroupLens)
                        }
                        Text(group.rawValue)
                            .font(.system(size: 12, weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .contentShape(Rectangle())
                    }
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(4)
        .frame(height: 42)
        .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
    }

    private var memoryFilterChips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(OrbitMemoryFilter.allCases, id: \.self) { filter in
                    let selected = filter == memoryFilter
                    Button {
                        withAnimation(Motion.gated(reduceMotion || store.localReduceMotion, Motion.press)) {
                            memoryFilter = filter
                        }
                    } label: {
                        Text(filter.rawValue)
                            .font(.system(size: 11.5, weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? StudyPalette.accentLabel : StudyPalette.ink)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 32)
                            .background(selected ? StudyPalette.accent : StudyPalette.paper.opacity(0.66), in: Capsule())
                            .overlay(Capsule().stroke(selected ? Color.clear : StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.7))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
    }

    private func memoryCard(_ memory: OrbitMemory) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                HStack(spacing: 5) {
                    Circle().fill(StudyPalette.accent).frame(width: 4, height: 4)
                    Text(memoryKindLabel(memory.kind))
                        .font(.system(size: 10.5, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(StudyPalette.accent)
                }
                .padding(.horizontal, 9)
                .frame(minHeight: 24)
                .background(StudyPalette.sky.opacity(0.8), in: Capsule())
                Spacer(minLength: 8)
                Text(memoryStatusLabel(memory))
                    .font(.system(size: 10.5))
                    .foregroundStyle(StudyPalette.muted)
            }
            Text(memory.content)
                .font(.system(size: 16, weight: .medium))
                .lineSpacing(5)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Rectangle().fill(StudyPalette.paperEdge.opacity(0.5)).frame(height: 0.7)
            HStack(spacing: 7) {
                AstellaGlyph(kind: .library, tint: StudyPalette.muted).frame(width: 12, height: 12)
                Text("相处里记下的").font(.system(size: 10.5)).foregroundStyle(StudyPalette.muted)
                Spacer(minLength: 8)
                SettingsStatusPill(
                    text: memory.candidate ? "待确认" : "有依据",
                    color: memory.candidate ? StudyPalette.danger : StudyPalette.success
                )
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.45), lineWidth: 0.8)
        }
        .shadow(color: StudyPalette.ink.opacity(0.03), radius: 8, x: 0, y: 3)
    }

    private var visibleMemories: [OrbitMemory] {
        memories.filter { memory in
            memoryGroupMatches(memory) && memoryFilterMatches(memory)
        }
    }

    private func memoryGroupMatches(_ memory: OrbitMemory) -> Bool {
        switch memoryGroup {
        case .aboutYou: return ["preference", "learning_context", "judgment", "interaction_note"].contains(memory.kind)
        case .herNotes: return ["episodic"].contains(memory.kind) || memory.kind.isEmpty
        case .goals: return memory.kind == "goal"
        }
    }

    private func memoryFilterMatches(_ memory: OrbitMemory) -> Bool {
        switch memoryFilter {
        case .active: return !memory.candidate && memory.tier != "resident" && memory.tier != "archived"
        case .candidate: return memory.candidate
        case .resident: return memory.tier == "resident"
        case .disputed: return false
        case .archived: return memory.tier == "archived"
        }
    }

    private func memoryStatusLabel(_ memory: OrbitMemory) -> String {
        if memory.candidate { return "待确认 · 相处里记下" }
        switch memory.tier {
        case "resident": return "固定 · 长期保留"
        case "archived": return "已归档"
        default: return "已确认 · 相处里记下"
        }
    }

    private var memoryEmptyTitle: String {
        switch memoryFilter {
        case .disputed: return "还没有有争议的记忆"
        case .archived: return "没有归档的记忆"
        case .candidate: return "没有待确认的记忆"
        default: return "这部分还没有记忆"
        }
    }

    private var memoryEmptyDetail: String {
        switch memoryFilter {
        case .disputed: return "如果某条记忆与你的理解不同，可以在详情里提出异议。"
        case .archived: return "收回的记忆会先放进回收站，再从这里彻底归档。"
        case .candidate: return "伴星刚记下的事会先等你确认，再进入长期记忆。"
        default: return "当伴星记住与你长期有关的内容时，会在这里说明来源。"
        }
    }

    private var handContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("现在交给伴星的")
                    .font(.system(size: 17, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(StudyPalette.ink)
                Text("需要你确认的事会留在这里。")
                    .font(.system(size: 12))
                    .foregroundStyle(StudyPalette.muted)
            }
            if store.runs.isEmpty && store.messages.flatMap(\.blocks).compactMap(\.proposalId).isEmpty {
                OrbitEmptyCard(title: "没有等待处理的事", detail: "你可以安心读一会儿；需要继续时，再从相伴页把内容交给伴星。", glyph: .hand)
            }
            ForEach(store.runs) { run in
                PaperSurface(padding: 17, radius: 18) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            AstellaGlyph(kind: .hand, tint: StudyPalette.accent).frame(width: 18, height: 18)
                            Text(run.statusLabel)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(StudyPalette.ink)
                            Spacer()
                            Circle().fill(run.isActive ? StudyPalette.accent : StudyPalette.success).frame(width: 6, height: 6)
                        }
                        Text(run.thinkingText?.isEmpty == false ? run.thinkingText! : "整理完成后，会回到你们的对话里。")
                            .font(.system(size: 12.5))
                            .foregroundStyle(StudyPalette.muted)
                            .lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                        Rectangle().fill(StudyPalette.paperEdge.opacity(0.5)).frame(height: 0.7)
                        HStack(spacing: 14) {
                            Button("查看对话") { store.returnToConversation(records: true) }
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(StudyPalette.accent)
                            Spacer()
                            if run.isActive {
                                Button("停止") { Task { await store.cancelActiveRuns() } }
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(StudyPalette.muted)
                            }
                        }
                        .frame(minHeight: 30)
                    }
                }
            }
            ForEach(Array(Set(store.messages.flatMap(\.blocks).compactMap(\.proposalId))), id: \.self) { proposalId in
                CompanionProposalCard(proposalId: proposalId)
            }
            if let note = store.notes.first {
                PaperSurface(padding: 17, radius: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("继续上次的思路")
                            .font(.system(size: 10.5, weight: .semibold))
                            .tracking(0.5)
                            .foregroundStyle(StudyPalette.muted)
                        Text(note.title)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(StudyPalette.ink)
                        if let snippet = note.snippet {
                            Text(snippet)
                                .font(.system(size: 12.5))
                                .lineSpacing(3)
                                .foregroundStyle(StudyPalette.muted)
                                .lineLimit(2)
                        }
                        Button("带着这篇手记继续聊") {
                            Task {
                                await store.loadNote(note.id)
                                if let document = store.noteDocument { store.continueWithNote(document) }
                            }
                        }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(StudyPalette.accent)
                        .padding(.top, 2)
                        .buttonStyle(AstellaPressStyle())
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Button("回到对话看完整过程") { store.returnToConversation(records: true) }
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(StudyPalette.muted)
                .frame(maxWidth: .infinity, minHeight: 44)
                .buttonStyle(AstellaPressStyle())
        }
    }

    private func loadOrbit() async {
        await store.refreshRuns()
        if store.notes.isEmpty { await store.loadNotes() }
        let now = Date()
        let monthFormatter = DateFormatter()
        monthFormatter.dateFormat = "yyyy-MM"
        let month = monthFormatter.string(from: now)
        loading = true
        do {
            let result = try await store.api.request("/companion/daily/month", query: [URLQueryItem(name: "month", value: month)]) as? [String: Any]
            firstGeneratedDate = (result?["firstGeneratedDate"] as? String).flatMap(orbitDate)
            days = (result?["days"] as? [[String: Any]] ?? []).compactMap { value in
                guard let date = value["date"] as? String, let status = value["status"] as? String else { return nil }
                return OrbitDay(date: date, status: status)
            }
            diaryError = nil
        } catch {
            guard !Task.isCancelled else { loading = false; return }
            diaryError = mobilePageError(error, fallback: "日记暂时没有连上，稍后再试。")
        }
        guard !Task.isCancelled else { loading = false; return }
        do {
            let result = try await store.api.request("/companion/memory", query: [
                URLQueryItem(name: "includeCandidates", value: "true"),
                URLQueryItem(name: "includeArchived", value: "true"),
            ]) as? [String: Any]
            memories = (result?["items"] as? [[String: Any]] ?? []).compactMap { value in
                guard let id = value["memoryItemId"] as? String, let content = value["content"] as? String else { return nil }
                return OrbitMemory(id: id, content: content, kind: value["kind"] as? String ?? "", tier: value["budgetTier"] as? String ?? "active", candidate: value["candidate"] as? Bool ?? false)
            }
            memoryError = nil
        } catch {
            guard !Task.isCancelled else { loading = false; return }
            memoryError = mobilePageError(error, fallback: "伴星记忆暂时不可用。")
        }
        loading = false
    }

    private func loadDiarySummaries() async {
        let generatedDays = recentDays
            .filter { $0.status == "generated" }
            .sorted { $0.date > $1.date }
            .prefix(5)
        for day in generatedDays {
            guard !Task.isCancelled else { return }
            do {
                let result = try await store.api.request("/companion/daily", query: [URLQueryItem(name: "date", value: day.date)]) as? [String: Any]
                let blocks = result?["blocks"] as? [[String: Any]] ?? []
                let summary = blocks.compactMap { $0["text"] as? String }
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
                if !summary.isEmpty { diarySummaries[day.date] = String(summary.prefix(140)) }
            } catch {
                // The day remains available; its full entry can still be opened on demand.
            }
        }
    }

}

private struct OrbitStarTrail: View {
    let days: [OrbitDay]
    private var written: Set<String> { Set(days.filter { $0.status == "generated" }.map(\.date)) }
    var body: some View {
        Canvas { context, size in
            let today = Calendar.current.startOfDay(for: Date())
            let points = (0..<14).compactMap { index -> CGPoint? in
                let x = size.width * (0.04 + CGFloat(index) * 0.071)
                let y = size.height * (0.55 - 0.30 * sin(Double(index) * 0.52) - Double(index) * 0.008)
                return CGPoint(x: x, y: y)
            }
            var path = Path()
            for (index, point) in points.enumerated() {
                if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            context.stroke(path, with: .color(.white.opacity(0.27)), lineWidth: 1.3)
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            let datedPoints = points.enumerated().compactMap { index, point -> (CGPoint, String)? in
                guard let date = Calendar.current.date(byAdding: .day, value: index - 13, to: today) else { return nil }
                return (point, formatter.string(from: date))
            }
            let litPoints = datedPoints.filter { written.contains($0.1) }.map(\.0)
            if litPoints.count > 1 {
                var activePath = Path()
                for (index, point) in litPoints.enumerated() {
                    if index == 0 { activePath.move(to: point) } else { activePath.addLine(to: point) }
                }
                context.stroke(activePath, with: .color(Color(red: 0.70, green: 0.82, blue: 1).opacity(0.78)), lineWidth: 1.6)
            }
            for (point, dateString) in datedPoints {
                let lit = written.contains(dateString)
                let radius: CGFloat = lit ? 3 : 1.8
                let dot = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
                if lit, dateString == written.max() {
                    let halo = dot.insetBy(dx: -5.5, dy: -5.5)
                    context.fill(Path(ellipseIn: halo), with: .color(Color(red: 0.72, green: 0.84, blue: 1).opacity(0.22)))
                }
                context.fill(Path(ellipseIn: dot), with: .color(lit ? Color(red: 0.72, green: 0.84, blue: 1) : .white.opacity(0.48)))
            }
        }
        .accessibilityLabel("最近两周的日记星轨")
    }
}

private struct OrbitDiaryRow: View {
    let day: OrbitDay
    let summary: String?
    private var generated: Bool { day.status == "generated" }
    private var isToday: Bool { Calendar.current.isDate(orbitDate(day.date) ?? .distantPast, inSameDayAs: Date()) }
    private var dayNumber: String {
        guard let date = orbitDate(day.date) else { return "—" }
        let formatter = DateFormatter(); formatter.dateFormat = "d"
        return formatter.string(from: date)
    }
    private var monthLabel: String {
        guard let date = orbitDate(day.date) else { return "" }
        let formatter = DateFormatter(); formatter.dateFormat = "M 月"
        return formatter.string(from: date)
    }
    private var weekdayLabel: String {
        guard let date = orbitDate(day.date) else { return "" }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = "EEE"
        return formatter.string(from: date)
    }
    var body: some View {
        NavigationLink(value: OrbitNavigationRoute.diaryDay(day.date)) {
            HStack(alignment: .top, spacing: 16) {
                VStack(spacing: 2) {
                    Text(dayNumber)
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text(monthLabel)
                        .font(.system(size: 8.5, weight: .medium))
                        .tracking(0.4)
                        .opacity(0.72)
                    Text(weekdayLabel)
                        .font(.system(size: 8.5))
                        .opacity(0.6)
                }
                .foregroundStyle(StudyPalette.muted)
                .frame(width: 50, height: 66)
                .background(LinearGradient(colors: [StudyPalette.paper, StudyPalette.sky], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(.white.opacity(0.78), lineWidth: 0.7))
                .overlay(alignment: .topTrailing) {
                    if isToday {
                        Circle().fill(StudyPalette.accent).frame(width: 6, height: 6).padding(6)
                    }
                }
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 7) {
                        if isToday {
                            Text("今天")
                                .font(.system(size: 9, weight: .semibold))
                                .tracking(0.4)
                                .foregroundStyle(StudyPalette.accent)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        }
                        Text("日记")
                            .font(.system(size: 9, weight: .medium))
                            .tracking(0.5)
                            .foregroundStyle(StudyPalette.muted)
                    }
                    .padding(.bottom, 8)

                    Text(summary ?? "日记已写下。点开查看那一天的完整记录。")
                        .font(.system(size: 14.5))
                        .lineSpacing(7)
                        .foregroundStyle(StudyPalette.ink)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        if day.hasImage {
                            HStack(spacing: 4) {
                                AstellaGlyph(kind: .photo, tint: StudyPalette.muted).frame(width: 11, height: 11)
                                Text("图").font(.system(size: 9, weight: .medium))
                            }
                            .foregroundStyle(StudyPalette.muted)
                            .padding(.horizontal, 7)
                            .frame(height: 20)
                            .background(StudyPalette.sky.opacity(0.7), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        }
                        Spacer(minLength: 0)
                        Text("看全文")
                            .font(.system(size: 11, weight: .medium))
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.accent).frame(width: 11, height: 11)
                    }
                    .foregroundStyle(StudyPalette.accent)
                    .padding(.top, 12)
                    .frame(minHeight: 24, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 17)
            .padding(.vertical, 16)
            .frame(minHeight: 128, alignment: .topLeading)
            .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8))
            .shadow(color: StudyPalette.ink.opacity(0.03), radius: 9, x: 0, y: 4)
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }.buttonStyle(AstellaPressStyle())
    }
}

struct OrbitEmptyCard: View {
    let title: String
    let detail: String
    let glyph: AstellaGlyphKind
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
                .frame(width: 22, height: 22)
                .frame(width: 44, height: 44)
                .background(StudyPalette.sky.opacity(0.75), in: Circle())
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(StudyPalette.ink)
                .padding(.top, 2)
            Text(detail)
                .font(.system(size: 12.5))
                .lineSpacing(4)
                .foregroundStyle(StudyPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(StudyPalette.paper.opacity(0.8), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
        }
    }
}

struct OrbitLoadingRow: View {
    var body: some View {
        HStack(spacing: 10) {
            ProgressView().tint(StudyPalette.accent)
            Text("正在接回你的星轨…").font(.caption).foregroundStyle(StudyPalette.muted)
        }.frame(maxWidth: .infinity).padding(.vertical, 22)
    }
}

private func orbitDate(_ raw: String) -> Date? {
    let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.locale = Locale(identifier: "en_US_POSIX")
    return formatter.date(from: raw)
}

func memoryKindLabel(_ kind: String) -> String {
    switch kind {
    case "preference": "相处偏好"
    case "goal": "正在努力的事"
    case "learning_context": "学习背景"
    case "interaction_note": "相处记录"
    case "episodic": "共同经历"
    case "judgment": "伴星的理解"
    default: "伴星记忆"
    }
}

struct HandScreen: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeading(eyebrow: "继续未完的想法", title: "手边", subtitle: "交给伴星的事，在这里接续。")
                HStack(spacing: 12) {
                    AstellaStar().fill(StudyPalette.accent).frame(width: 27, height: 36).padding(.horizontal, 5)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(store.runs.isEmpty ? "现在，可以慢一点。" : "伴星正在替你整理")
                            .font(.headline)
                        Text(store.realtimeStatus == "已连接" ? "和你的书房连在一起" : store.realtimeStatus)
                            .font(.caption).foregroundStyle(StudyPalette.muted)
                    }
                    Spacer()
                    Button { store.returnToConversation(records: false) } label: {
                        AstellaGlyph(kind: .send, tint: StudyPalette.accent).frame(width: 19, height: 19).frame(width: 44, height: 44)
                    }.accessibilityLabel("回到伴星身边")
                }.padding(20).modifier(StudyGlassSurfaceStyle(radius: 24))
                if let error = store.errorMessage {
                    ConversationFailurePanel(message: error) { Task { await store.loadConversation() } }
                }
                if store.runs.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("暂时没有待接续的事").font(.title3.weight(.semibold))
                        Text("一个问题、一段原文，或者一份刚收到的资料，都可以交给伴星一起想。")
                            .font(.body).foregroundStyle(StudyPalette.muted).lineSpacing(5)
                        Button { store.returnToConversation(records: false) } label: {
                            astellaLabel("和伴星聊聊", glyph: .chat).font(.subheadline.weight(.medium))
                        }.padding(.top, 8)
                    }.padding(.vertical, 20)
                } else {
                    ForEach(store.runs) { run in
                        HStack(alignment: .top, spacing: 16) {
                            AstellaGlyph(kind: run.status == "waiting_for_confirmation" ? .hand : .companion, tint: StudyPalette.accent)
                                .frame(width: 36, height: 36).background(StudyPalette.sky, in: Circle())
                            VStack(alignment: .leading, spacing: 12) {
                                Text(run.statusLabel).font(.headline)
                                Text(run.thinkingText?.isEmpty == false ? run.thinkingText! : run.status == "waiting_for_confirmation" ? "先看看伴星准备的建议，再决定怎样继续。" : "整理完成后，会递回你们的对话里。")
                                    .font(.subheadline).foregroundStyle(StudyPalette.muted).lineSpacing(4)
                                HStack {
                                    Button("查看对话") { store.returnToConversation(records: true) }
                                    Spacer()
                                    Button("停止") { Task { await store.cancelActiveRuns() } }
                                }.font(.footnote.weight(.medium))
                            }
                        }.padding(.vertical, 8)
                    }
                }
                let proposalIds = store.messages.flatMap(\.blocks).compactMap(\.proposalId)
                ForEach(Array(Set(proposalIds)), id: \.self) { CompanionProposalCard(proposalId: $0) }
                if let note = store.notes.first {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionEyebrow(text: "也可以，接着上次的思路")
                        Text(note.title).font(.title3.weight(.semibold))
                        if let snippet = note.snippet { Text(snippet).font(.subheadline).foregroundStyle(StudyPalette.muted).lineLimit(3) }
                        Button("带着这篇手记继续聊") {
                            Task {
                                await store.loadNote(note.id)
                                if let document = store.noteDocument { store.continueWithNote(document) }
                            }
                        }.font(.subheadline.weight(.medium))
                    }.padding(.top, 12)
                }
            }.padding(24)
        }.scrollIndicators(.hidden).background(DawnBackground())
            .task { await store.refreshRuns(); if store.notes.isEmpty { await store.loadNotes() } }
            .refreshable { await store.refreshRuns() }
    }
}

struct AccountScreen: View {
    @Environment(AppStore.self) private var store
    @State private var firstDiaryDate: Date?
    @State private var todayDiaryCount = 0
    @State private var diaryStatsLoaded = false
    @State private var diaryStatsUnavailable = false

    private var companionDays: Int? {
        guard let firstDiaryDate else { return nil }
        let elapsed = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: firstDiaryDate), to: Calendar.current.startOfDay(for: Date())).day ?? 0
        return max(1, elapsed + 1)
    }

    var body: some View {
        @Bindable var store = store
        let currentAvatarURL = store.profile?.avatarURL
        let isAccountBusy = store.isAccountBusy
        ScrollViewReader { proxy in
          ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                NavigationLink(value: AccountScreenRoute.profile) {
                    if let avatarURL = currentAvatarURL {
                        ProfileAvatarImage(url: avatarURL, fallback: profileInitial, size: 66)
                    } else {
                        Image("CompanionAvatar")
                            .resizable()
                            .scaledToFill()
                            .frame(width: 66, height: 66)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(.white.opacity(0.88), lineWidth: 1))
                    }
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("打开个人资料")

                NavigationLink(value: AccountScreenRoute.profile) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.profile?.displayName.isEmpty == false ? store.profile!.displayName : "拾星同学")
                            .font(.system(size: 20, weight: .semibold))
                            .tracking(-0.3)
                            .foregroundStyle(StudyPalette.ink)
                            .lineLimit(1)
                        Text(store.profile?.email ?? "")
                            .font(.system(size: 12.5))
                            .foregroundStyle(StudyPalette.muted)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("编辑个人资料")

                NavigationLink(value: AccountScreenRoute.settings) {
                    AstellaGlyph(kind: .settings, tint: StudyPalette.ink).frame(width: 18, height: 18)
                        .frame(width: 38, height: 38)
                        .modifier(StudyGlassSurfaceStyle(radius: 19, interactive: true))
                }
                .buttonStyle(AstellaPressStyle())
                .accessibilityLabel("设置")
            }
            .padding(.horizontal, 4)
            .padding(.top, 20)
            .padding(.bottom, 18)

            VStack(alignment: .leading, spacing: 0) {
                Text(companionEyebrow)
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(Color(red: 0.35, green: 0.47, blue: 0.66))
                Text(companionDailyTitle)
                    .font(.system(size: 23, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(StudyPalette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                NavigationLink(value: AccountScreenRoute.companionCenter) {
                    HStack(spacing: 6) {
                        Text("进入伴星中心")
                            .font(.system(size: 12, weight: .semibold))
                        AstellaGlyph(kind: .chevron, tint: StudyPalette.accentLabel).frame(width: 10, height: 10)
                    }
                    .foregroundStyle(StudyPalette.accentLabel)
                    .padding(.horizontal, 15)
                    .frame(minHeight: 34)
                    .background(LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .shadow(color: StudyPalette.accent.opacity(0.18), radius: 8, x: 0, y: 4)
                }
                .buttonStyle(AstellaPressStyle())
                .padding(.top, 16)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LinearGradient(colors: [Color(red: 0.85, green: 0.91, blue: 0.99).opacity(0.94), Color(red: 0.78, green: 0.87, blue: 0.98).opacity(0.68)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                Image("CompanionAvatar")
                    .resizable().scaledToFit()
                    .frame(width: 118, height: 118)
                    .opacity(0.92)
                    .offset(x: -10, y: 20)
                    .allowsHitTesting(false)
            }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(.white.opacity(0.5), lineWidth: 0.8))

            if let message = store.accountError {
                AccountSection { accountNotice(message, glyph: .alert, color: StudyPalette.danger) }
            } else if let message = store.accountNotice {
                AccountSection { accountNotice(message, glyph: .check, color: StudyPalette.success) }
            }

            AccountSection("和伴星相处") {
                VStack(spacing: 0) {
                    NavigationLink(value: AccountScreenRoute.devicePermissions) {
                        accountLink(title: "伴星权限", detail: "麦克风、照片、文件与通知", glyph: .shield)
                    }
                    accountRowDivider
                    NavigationLink(value: AccountScreenRoute.conventions) {
                        accountLink(title: "个人约定", detail: "把你的节奏告诉她", glyph: .check)
                    }
                    if store.workspaces.count > 1 {
                        accountRowDivider
                        Menu {
                            ForEach(store.workspaces) { workspace in
                                Button {
                                    Task { await store.switchWorkspace(workspace) }
                                } label: {
                                    Label {
                                        Text(workspace.name)
                                    } icon: {
                                        if workspace.id == store.profile?.workspaceId {
                                            AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 15, height: 15)
                                        }
                                    }
                                }
                            }
                        } label: {
                            accountLink(title: "书房", detail: store.profile?.workspaceName ?? "当前学习空间", glyph: .library)
                        }
                        .disabled(isAccountBusy)
                        .accessibilityLabel("切换书房")
                    } else {
                        accountRowDivider
                        Button { store.selectedTab = .library } label: {
                            accountLink(title: "书房", detail: store.profile?.workspaceName ?? "当前学习空间", glyph: .library)
                        }
                        .buttonStyle(AstellaPressStyle())
                    }
                }
            }

            AccountSection("阅读") {
                VStack(spacing: 0) {
                    NavigationLink(value: AccountScreenRoute.readingSettings) {
                        accountLink(title: "阅读字号", detail: "字号、默认打开与动效", glyph: .document)
                    }
                    accountRowDivider
                    Menu {
                        Button {
                            store.setChatShowsRecords(false)
                        } label: {
                            Label {
                                Text("伴星场景")
                            } icon: {
                                if !store.chatShowsRecords { AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 15, height: 15) }
                            }
                        }
                        Button {
                            store.setChatShowsRecords(true)
                        } label: {
                            Label {
                                Text("记录场景")
                            } icon: {
                                if store.chatShowsRecords { AstellaGlyph(kind: .check, tint: StudyPalette.accent).frame(width: 15, height: 15) }
                            }
                        }
                    } label: {
                        accountLink(title: "默认打开", detail: store.chatShowsRecords ? "记录场景" : "伴星场景", glyph: .eye)
                    }
                    accountRowDivider
                    Toggle(isOn: Binding(
                        get: { store.localReduceMotion },
                        set: { store.setLocalReduceMotion($0) }
                    )) {
                        HStack(spacing: 12) {
                            AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent)
                                .frame(width: 17, height: 17)
                                .frame(width: 34, height: 34)
                                .background(StudyPalette.sky.opacity(0.75), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                            VStack(alignment: .leading, spacing: 3) {
                                Text("轻柔动效").font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                                Text("减少位移，留下安静的状态反馈").font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                            }
                        }
                    }
                    .frame(minHeight: 56)
                    .tint(StudyPalette.accent)
                    .accessibilityLabel("轻柔动效")
                }
            }

            AccountSection("隐私与高级") {
                VStack(spacing: 0) {
                    NavigationLink(value: AccountScreenRoute.aiAuthorization) {
                        accountLink(
                            title: "AI 使用授权与数据偏好",
                            detail: aiAuthorizationSummary,
                            glyph: .lock
                        )
                    }
                    accountRowDivider
                    NavigationLink(value: AccountScreenRoute.changePassword) {
                        accountLink(title: "修改密码", detail: "更换登录密码", glyph: .key)
                    }
                    accountRowDivider
                    NavigationLink(value: AccountScreenRoute.serverAddress) {
                        accountLink(title: "服务地址", detail: serviceAddressSummary, glyph: .document)
                    }
                }
            }

            Button(role: .destructive) { store.logout() } label: {
                HStack(spacing: 9) {
                    AstellaGlyph(kind: .logout, tint: StudyPalette.danger).frame(width: 17, height: 17)
                    Text("退出登录").font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(StudyPalette.danger)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(StudyPalette.paper.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.8))
            }
            .buttonStyle(AstellaPressStyle())
            .padding(.top, 18)

            Text("ASTELLA · 拾星笔记")
                .font(.system(size: 10, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(StudyPalette.muted.opacity(0.68))
                .frame(maxWidth: .infinity)
                .padding(.top, 28)
                .padding(.bottom, 14)
                .accessibilityHidden(true)
                .id("account-footer")
        }
        .padding(.horizontal, 22).padding(.top, 0).padding(.bottom, 72)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: store.profile?.workspaceId) {
            #if DEBUG
            if ["me", "me-bottom"].contains(store.uiReviewMode ?? "") {
                firstDiaryDate = Calendar.current.date(byAdding: .day, value: -6, to: Date())
                todayDiaryCount = 0
                diaryStatsLoaded = true
                diaryStatsUnavailable = false
                return
            }
            if store.uiReviewMode != nil { return }
            #endif
            await store.loadAccountSettings()
            if store.notes.isEmpty { await store.loadNotes() }
            await loadDailySummaryStats()
        }
        .onAppear {
            #if DEBUG
            if store.uiReviewMode == "me-bottom" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    proxy.scrollTo("account-footer", anchor: .top)
                }
            }
            #endif
        }
        }
    }

    private func accountNotice(_ message: String, glyph: AstellaGlyphKind, color: Color) -> some View {
        Label { Text(message) } icon: { AstellaGlyph(kind: glyph, tint: color).frame(width: 16, height: 16) }
            .font(.footnote.weight(.medium))
            .foregroundStyle(color)
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var profileInitial: String {
        String((store.profile?.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first)
            ?? store.profile?.email.first
            ?? "阅").uppercased()
    }

    private var companionEyebrow: String {
        guard diaryStatsLoaded else { return "伴星 · 正在接回日记" }
        if diaryStatsUnavailable { return "伴星 · 日记暂时不可用" }
        guard let companionDays else { return "伴星 · 还没开始记录" }
        return "伴星 · 陪你读书的第 \(companionDays) 天"
    }

    private var companionDailyTitle: String {
        guard diaryStatsLoaded else { return "正在接回今天的记录" }
        if diaryStatsUnavailable { return "今天的日记暂时没有读到" }
        return todayDiaryCount > 0 ? "今天一起留下了 \(todayDiaryCount) 段记录" : "今天还没一起读"
    }

    private func loadDailySummaryStats() async {
        diaryStatsLoaded = false
        diaryStatsUnavailable = false
        let today = Date()
        let monthFormatter = DateFormatter()
        monthFormatter.dateFormat = "yyyy-MM"
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "yyyy-MM-dd"
        do {
            let month = try await store.api.request("/companion/daily/month", query: [URLQueryItem(name: "month", value: monthFormatter.string(from: today))]) as? [String: Any]
            firstDiaryDate = (month?["firstGeneratedDate"] as? String).flatMap(orbitDate)
            if firstDiaryDate == nil {
                firstDiaryDate = (month?["days"] as? [[String: Any]] ?? [])
                    .filter { $0["status"] as? String == "generated" }
                    .compactMap { ($0["date"] as? String).flatMap(orbitDate) }
                    .min()
            }
            let daily = try await store.api.request("/companion/daily", query: [URLQueryItem(name: "date", value: dayFormatter.string(from: today))]) as? [String: Any]
            if daily?["status"] as? String == "generated" {
                let count = (daily?["blocks"] as? [[String: Any]] ?? []).filter {
                    ($0["text"] as? String)?.isEmpty == false
                }.count
                todayDiaryCount = max(1, count)
            } else {
                todayDiaryCount = 0
            }
            diaryStatsUnavailable = false
        } catch {
            guard !Task.isCancelled else { return }
            diaryStatsUnavailable = true
        }
        diaryStatsLoaded = true

    }

    private var aiAuthorizationSummary: String {
        guard let settings = store.aiSettings else {
            return store.isAccountBusy ? "正在读取授权状态…" : "已授权 · 可在本页调整"
        }
        if settings.needsSigning { return "尚未签署 · AI 外发调用已关闭" }
        if let version = settings.consentVersion { return "已授权 · \(version)" }
        return "已授权 · 可在本页调整"
    }

    private var serviceAddressSummary: String {
        store.api.baseURL == store.api.defaultBaseURL ? "默认" : store.api.baseURL
    }

    private func accountLink(title: String, detail: String, glyph: AstellaGlyphKind) -> some View {
        HStack(spacing: 12) {
            AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
                .frame(width: 17, height: 17)
                .frame(width: 34, height: 34)
                .background(StudyPalette.sky.opacity(0.75), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.7)).frame(width: 13, height: 13)
        }
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }

    private var accountRowDivider: some View {
        Rectangle()
            .fill(StudyPalette.paperEdge.opacity(0.45))
            .frame(height: 0.7)
            .padding(.leading, 58)
            .accessibilityHidden(true)
    }
}

private struct ProfileAvatarImage: View {
    @Environment(AppStore.self) private var store
    var url: String
    var fallback: String
    var size: CGFloat = 54
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(fallback).font(.title2.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                    .frame(width: size, height: size).background(StudyPalette.sky)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: url) {
            do { image = UIImage(data: try await store.api.imageData(url)) }
            catch { image = nil }
        }
    }
}

struct AccountProfileScreen: View {
    @Environment(AppStore.self) private var store
    @State private var displayName = ""
    @State private var avatarItem: PhotosPickerItem?
    @State private var appeared = false
    private var userId: String { store.profile?.userId ?? "unknown" }
    private var fallback: String {
        String((store.profile?.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first)
            ?? store.profile?.email.first
            ?? "阅").uppercased()
    }

    var body: some View {
        let avatarURL = store.profile?.avatarURL
        let avatarFallback = fallback
#if DEBUG
        let noteCount = store.uiReviewMode == "profile" ? 8 : store.notes.count
#else
        let noteCount = store.notes.count
#endif
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 16) {
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        ZStack(alignment: .bottomTrailing) {
                            Group {
                                if let avatarURL {
                                    ProfileAvatarImage(url: avatarURL, fallback: avatarFallback, size: 74)
                                } else {
                                    Image("CompanionAvatar").resizable().scaledToFill()
                                        .frame(width: 74, height: 74).clipShape(Circle())
                                }
                            }
                            AstellaGlyph(kind: .camera, tint: .white)
                                .frame(width: 26, height: 26)
                                .background(StudyPalette.accent, in: Circle())
                                .overlay(Circle().stroke(StudyPalette.canvas, lineWidth: 2))
                        }
                    }
                    .buttonStyle(AstellaPressStyle())
                    .disabled(store.isAccountBusy)
                    .accessibilityLabel("更换头像")

                    VStack(alignment: .leading, spacing: 6) {
                        TextField("你的昵称", text: $displayName)
                            .font(.system(size: 21, weight: .semibold))
                            .tracking(-0.3)
                            .foregroundStyle(StudyPalette.ink)
                            .textInputAutocapitalization(.never)
                            .onChange(of: displayName) { _, value in
                                if value.count > 12 { displayName = String(value.prefix(12)) }
                            }
                        Text("相伴 · \(store.profile?.workspaceName ?? "我的书房")")
                            .font(.system(size: 12)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 4)
                .shellEntrance(0, active: appeared)

                HStack(alignment: .center, spacing: 12) {
                    Text("点头像可以更换照片，改好名字点保存。")
                        .font(.system(size: 11.5))
                        .lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button {
                        Task { await store.saveProfile(displayName: displayName) }
                    } label: {
                        if store.isAccountBusy { ProgressView().tint(StudyPalette.accentLabel) }
                        else { Text("保存").font(.system(size: 13, weight: .semibold)) }
                    }
                    .foregroundStyle(StudyPalette.accentLabel)
                    .frame(width: 58, height: 36)
                    .background(StudyPalette.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .buttonStyle(AstellaPressStyle())
                    .disabled(store.isAccountBusy || displayName.trimmingCharacters(in: .whitespacesAndNewlines) == (store.profile?.displayName ?? ""))
                }
                .padding(.top, 16)
                .padding(.bottom, 8)
                .shellEntrance(1, active: appeared)

                if let message = store.accountError {
                    featureAccountMessage(message, isError: true, retry: nil).padding(.top, 8).padding(.bottom, 6)
                } else if let message = store.accountNotice {
                    featureAccountMessage(message, isError: false, retry: nil).padding(.top, 8).padding(.bottom, 6)
                }

                AccountSection("账号") {
                    VStack(spacing: 0) {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("邮箱").font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                                Text("用于登录与找回密码").font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                            }
                            Spacer(minLength: 12)
                            Text(store.profile?.email ?? "")
                                .font(.system(size: 12)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                        }
                        .frame(minHeight: 56)
                        Rectangle().fill(StudyPalette.paperEdge.opacity(0.45)).frame(height: 0.7)
                        Button { store.selectedTab = .library } label: {
                            settingDestinationRow(title: "我的书房", detail: "\(noteCount) 份手记", glyph: .library)
                        }
                        .buttonStyle(AstellaPressStyle())
                    }
                }
                .shellEntrance(2, active: appeared)

                Button(role: .destructive) { store.logout() } label: {
                    HStack(spacing: 8) {
                        AstellaGlyph(kind: .logout, tint: StudyPalette.danger).frame(width: 17, height: 17)
                        Text("退出登录").font(.system(size: 14, weight: .medium))
                    }
                    .foregroundStyle(StudyPalette.danger)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(StudyPalette.paper.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.8))
                }
                .buttonStyle(AstellaPressStyle())
                .padding(.top, 20)
                .shellEntrance(3, active: appeared)

                Text("ASTELLA · 拾星笔记")
                    .font(.system(size: 10, weight: .medium)).tracking(2.2).foregroundStyle(StudyPalette.muted.opacity(0.68))
                    .frame(maxWidth: .infinity).padding(.top, 30).padding(.bottom, 24)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 22)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "个人资料") }
        .onAppear {
            guard !appeared else { return }
            Task { @MainActor in await Task.yield(); appeared = true }
        }
        .task(id: userId) { displayName = store.profile?.displayName ?? "" }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            Task {
                do {
                    guard let original = try await item.loadTransferable(type: Data.self), original.count <= 10 * 1024 * 1024 else {
                        store.accountError = "头像不能超过 10 MB，请换一张小一点的。"
                        return
                    }
                    let source = CGImageSourceCreateWithData(original as CFData, nil)
                    let image = source.flatMap {
                        CGImageSourceCreateThumbnailAtIndex($0, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1024,
                        ] as CFDictionary)
                    }
                    guard let image, let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.88) else {
                        store.accountError = "这张图片暂时无法读取，请换一张图片后重试。"
                        return
                    }
                    await store.saveAvatar(data: jpeg, fileName: "astella-avatar.jpg")
                    avatarItem = nil
                } catch { store.accountError = "头像没有读取成功：\(error.localizedDescription)" }
            }
        }
    }
}

struct CompanionSettingsScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AccountSection("表达设定") {
                    VStack(spacing: 0) {
                        NavigationLink(value: AccountScreenRoute.profile) {
                            companionPreferenceRow(
                                title: "名字",
                                detail: "她这样称呼你",
                                value: store.profile?.displayName.isEmpty == false ? store.profile!.displayName : "拾星同学"
                            )
                        }.buttonStyle(AstellaPressStyle())
                        companionSettingsDivider
                        companionPreferenceRow(
                            title: "说话风格",
                            detail: "会参考个人约定与当前语境",
                            value: "随对话调整"
                        )
                        companionSettingsDivider
                        companionPreferenceRow(
                            title: "讲解分量",
                            detail: "结合问题和阅读内容调整深浅",
                            value: "自动"
                        )
                    }
                }
                AccountSection("相处方式") {
                    VStack(spacing: 0) {
                        NavigationLink(value: AccountScreenRoute.conventions) {
                            companionPreferenceRow(title: "相处偏好", detail: "补充相处节奏和表达方式", showsChevron: true)
                        }.buttonStyle(AstellaPressStyle())
                        companionSettingsDivider
                        Button {
                            store.orbitRootSection = "memory"
                            store.selectedTab = .orbit
                        } label: {
                            companionPreferenceRow(title: "她记得的事", detail: "查看、核对与修正伴星记忆", showsChevron: true)
                        }.buttonStyle(AstellaPressStyle())
                    }
                }
                AccountSection("声音与语音") {
                    VStack(spacing: 0) {
                        Button {
                            store.chatShowsRecords = false
                            store.selectedTab = .conversation
                        } label: {
                            companionPreferenceRow(
                                title: "实时语音交流",
                                detail: "从相伴页的麦克风开始，不转写文字",
                                trailingGlyph: .mic
                            )
                        }.buttonStyle(AstellaPressStyle())
                        companionSettingsDivider
                        companionPreferenceRow(
                            title: "朗读回复",
                            detail: "移动端当前尚未接入播放",
                            value: "未启用"
                        )
                    }
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 26)
            .padding(.top, 5)
            .padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "伴星配置") }
    }

    private var companionSettingsDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.45)).frame(height: 0.7)
    }

    private func companionPreferenceRow(
        title: String,
        detail: String,
        value: String? = nil,
        showsChevron: Bool = false,
        trailingGlyph: AstellaGlyphKind? = nil
    ) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                Text(detail).font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted).lineLimit(2)
            }
            Spacer(minLength: 8)
            if let value {
                Text(value).font(.system(size: 12)).foregroundStyle(StudyPalette.muted).lineLimit(1)
            }
            if let trailingGlyph {
                AstellaGlyph(kind: trailingGlyph, tint: StudyPalette.muted).frame(width: 15, height: 15)
            } else if showsChevron {
                AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.7)).frame(width: 13, height: 13)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct MobileSettingsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("study.appearance.dark") private var darkMode = false
    @AppStorage("study.appearance.mode") private var appearanceMode = "light"
    @State private var reduceMotion = false
    @State private var appeared = false
    @Namespace private var appearanceLens

    private var userId: String { store.profile?.userId ?? "unknown" }
    private var motionDisabled: Bool { systemReduceMotion || store.localReduceMotion }

    private func appearanceButton(_ title: String, mode: String) -> some View {
        let selected = appearanceMode == mode
        return Button {
            let apply = {
                appearanceMode = mode
                darkMode = mode == "dark"
            }
            withAnimation(Motion.gated(motionDisabled, Motion.segment), apply)
        } label: {
            ZStack {
                if selected {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(StudyPalette.paper)
                        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7))
                        .shadow(color: StudyPalette.ink.opacity(0.05), radius: 4, x: 0, y: 2)
                        .matchedGeometryEffect(id: "settings-appearance-lens", in: appearanceLens)
                        .padding(3)
                }
                Text(title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 10) {
                    settingsPageLabel("外观与显示")
                    HStack(spacing: 0) {
                        appearanceButton("银白", mode: "light")
                        appearanceButton("深空", mode: "dark")
                        appearanceButton("随日夜", mode: "system")
                    }
                    .frame(height: 46)
                    .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))

                    VStack(spacing: 0) {
                        NavigationLink(value: AccountScreenRoute.readingSettings) {
                            settingDestinationRow(title: "阅读设置", detail: "字号、默认打开与动效", glyph: .text)
                        }
                        settingsDivider
                        Toggle(isOn: Binding(
                            get: { reduceMotion },
                            set: { value in
                                reduceMotion = value
                                store.setLocalReduceMotion(value)
                                UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "reduceMotion"))
                            }
                        )) {
                            HStack(spacing: 12) {
                                AstellaGlyph(kind: .sparkle, tint: StudyPalette.accent)
                                    .frame(width: 17, height: 17)
                                    .frame(width: 34, height: 34)
                                    .background(StudyPalette.sky.opacity(0.75), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("轻柔动效").font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                                    Text(systemReduceMotion ? "系统辅助功能已要求减少动效。" : "减少位移，留下安静的状态反馈")
                                        .font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                                }
                            }
                        }
                        .frame(minHeight: 56)
                        .tint(StudyPalette.accent)
                        .disabled(systemReduceMotion)
                        .accessibilityLabel("轻柔动效")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 2)
                    .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                    }
                    .shadow(color: StudyPalette.ink.opacity(0.025), radius: 8, x: 0, y: 3)
                }
                .shellEntrance(0, active: appeared)

                AccountSection("伴星与隐私") {
                    VStack(spacing: 0) {
                        NavigationLink(value: AccountScreenRoute.devicePermissions) {
                            settingDestinationRow(title: "设备权限", detail: "麦克风、相册、相机、文件与通知", glyph: .wave)
                        }.buttonStyle(AstellaPressStyle())
                        settingsDivider
                        NavigationLink(value: AccountScreenRoute.aiAuthorization) {
                            settingDestinationRow(title: "AI 授权与数据", detail: "读取手记、上传材料与记录保存", glyph: .lock)
                        }.buttonStyle(AstellaPressStyle())
                    }
                }
                .shellEntrance(1, active: appeared)

                AccountSection("资料与连接") {
                    VStack(spacing: 0) {
                        Button {
                            store.selectedTab = .library
                        } label: {
                            settingDestinationRow(title: "书房与手记", detail: "手记、来源与导入进度", glyph: .library)
                        }.buttonStyle(AstellaPressStyle())
                        settingsDivider
                        NavigationLink(value: AccountScreenRoute.serverAddress) {
                            settingDestinationRow(title: "服务地址", detail: "连接自建或私有部署", glyph: .document)
                        }.buttonStyle(AstellaPressStyle())
                    }
                }
                .shellEntrance(2, active: appeared)

                Text("阅读字号、打开方式和动效偏好只保存在这台设备上。")
                    .font(.system(size: 11.5))
                    .lineSpacing(3)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 4)
                    .padding(.top, 22)
                    .shellEntrance(3, active: appeared)

                Text("ASTELLA · 拾星笔记")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(2.2)
                    .foregroundStyle(StudyPalette.muted.opacity(0.68))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 32)
                    .padding(.bottom, 30)
                    .accessibilityHidden(true)
                    .shellEntrance(4, active: appeared)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 30)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "设置") }
        .onAppear {
            guard !appeared else { return }
            Task { @MainActor in await Task.yield(); appeared = true }
        }
        .task(id: userId) {
            reduceMotion = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "reduceMotion"))
        }
    }

    private var settingsDivider: some View {
        Rectangle().fill(StudyPalette.paperEdge.opacity(0.45)).frame(height: 0.7)
    }

    private func settingsPageLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .tracking(0.7)
            .foregroundStyle(StudyPalette.muted)
            .padding(.leading, 2)
    }
}

func settingDestinationRow(title: String, detail: String, glyph: AstellaGlyphKind) -> some View {
    HStack(spacing: 12) {
        AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
            .frame(width: 17, height: 17)
            .frame(width: 34, height: 34)
            .background(StudyPalette.sky.opacity(0.75), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
            Text(detail).font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted).lineLimit(2)
        }
        Spacer(minLength: 8)
        AstellaGlyph(kind: .chevron, tint: StudyPalette.muted.opacity(0.7)).frame(width: 13, height: 13)
    }
    .frame(minHeight: 56)
    .contentShape(Rectangle())
}

struct ReadingSettingsScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("study.appearance.dark") private var darkMode = false
    @AppStorage("study.appearance.mode") private var appearanceMode = "light"
    @State private var textSize = 19.0
    @State private var showRecords = false
    @State private var reduceMotion = false
    @State private var appeared = false
    @Namespace private var appearanceLens
    private var userId: String { store.profile?.userId ?? "unknown" }

    private var textSizeName: String {
        if textSize <= 15 { return "小" }
        if textSize <= 17 { return "标准" }
        if textSize <= 20 { return "大" }
        return "特大"
    }

    private func saveTextSize(_ value: Double) {
        textSize = value
        store.setReadingScale(value / 16)
    }

    private func appearanceButton(_ title: String, mode: String) -> some View {
        let selected = appearanceMode == mode
        return Button {
            withAnimation(Motion.gated(systemReduceMotion || store.localReduceMotion, Motion.segment)) {
                appearanceMode = mode
                darkMode = mode == "dark"
            }
        } label: {
            ZStack {
                if selected {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(StudyPalette.paper)
                        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.7))
                        .shadow(color: StudyPalette.ink.opacity(0.05), radius: 4, x: 0, y: 2)
                        .matchedGeometryEffect(id: "reading-appearance-lens", in: appearanceLens)
                        .padding(3)
                }
                Text(title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func sectionLabel(_ title: String, bottom: CGFloat = 12) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .tracking(0.7)
            .foregroundStyle(StudyPalette.muted)
            .padding(.leading, 2)
            .padding(.bottom, bottom)
    }

    private var themeLabel: String {
        switch appearanceMode {
        case "dark": "深夜"
        case "system": "随系统"
        default: "银白"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("这一页的改动保存在本机（这台设备），不会同步到账号。")
                    .font(.system(size: 12.5))
                    .lineSpacing(3)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 2)
                    .shellEntrance(0, active: appeared)

                Text("清风徐来，水波不兴。举酒属客，诵明月之诗，歌窈窕之章。")
                    .font(StudySerif.font(size: textSize))
                    .lineSpacing(textSize * 0.8)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 28)
                    .padding(.horizontal, 22)
                    .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                    }
                    .padding(.top, 16)
                    .shellEntrance(1, active: appeared)

                HStack(spacing: 13) {
                    Text("A").font(.system(size: 13, design: .serif)).foregroundStyle(StudyPalette.muted)
                    Slider(value: Binding(get: { textSize }, set: saveTextSize), in: 15...25, step: 1)
                        .tint(StudyPalette.accent.opacity(0.6))
                        .accessibilityLabel("阅读字号")
                    Text("A").font(.system(size: 21, weight: .medium, design: .serif)).foregroundStyle(StudyPalette.muted)
                }
                .padding(.horizontal, 4)
                .padding(.top, 20)

                Text("当前字号：\(textSizeName)（\(Int(textSize))pt）")
                    .font(.system(size: 11.5))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.leading, 4)
                    .padding(.top, 10)

                VStack(alignment: .leading, spacing: 0) {
                    sectionLabel("外观")
                    HStack(spacing: 0) {
                        appearanceButton("银白", mode: "light")
                        appearanceButton("深夜", mode: "dark")
                        appearanceButton("随系统", mode: "system")
                    }
                    .frame(height: 46)
                    .modifier(StudyGlassSurfaceStyle(radius: 20, interactive: true))
                    Text("当前：\(themeLabel)。选择「随系统」时会跟随设备深浅色。")
                        .font(.system(size: 11.5))
                        .lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                        .padding(.horizontal, 4)
                        .padding(.top, 8)
                }
                .padding(.top, 26)
                .shellEntrance(2, active: appeared)

                VStack(alignment: .leading, spacing: 0) {
                    sectionLabel("默认打开")
                    VStack(spacing: 0) {
                        defaultOpenOption(title: "伴星场景", detail: "打开先见到她，安静陪伴", glyph: .eye, selected: !showRecords) {
                            setDefaultOpen(records: false)
                        }
                        Rectangle().fill(StudyPalette.paperEdge.opacity(0.45)).frame(height: 0.7)
                        defaultOpenOption(title: "记录场景", detail: "打开就到对话记录", glyph: .text, selected: showRecords) {
                            setDefaultOpen(records: true)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 2)
                    .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                    }
                    Text("保存在本机，下次打开按这里的设置进入。")
                        .font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                        .padding(.horizontal, 4).padding(.top, 8)
                }
                .padding(.top, 26)
                .shellEntrance(3, active: appeared)

                VStack(alignment: .leading, spacing: 0) {
                    sectionLabel("动效")
                    Toggle(isOn: Binding(
                        get: { reduceMotion },
                        set: { value in
                            reduceMotion = value
                            store.setLocalReduceMotion(value)
                            UserDefaults.standard.set(value, forKey: mobilePreferenceKey(userId, "reduceMotion"))
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("减少动效").font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                            Text("模型保持静止，粒子改为静态音量条")
                                .font(.system(size: 11.5)).foregroundStyle(StudyPalette.muted)
                        }
                    }
                    .frame(minHeight: 56)
                    .tint(StudyPalette.accent)
                    .disabled(systemReduceMotion)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 2)
                    .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                    }
                    if systemReduceMotion {
                        Text("系统已开启「减弱动态效果」，动效会被强制减少，与此处开关无关。")
                            .font(.system(size: 11.5)).lineSpacing(3).foregroundStyle(StudyPalette.muted)
                            .padding(.horizontal, 4).padding(.top, 8)
                    }
                }
                .padding(.top, 26)
                .shellEntrance(4, active: appeared)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 34)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "阅读与显示") }
        .onAppear {
            guard !appeared else { return }
            Task { @MainActor in await Task.yield(); appeared = true }
        }
        .task(id: userId) {
            let savedScale = UserDefaults.standard.object(forKey: mobilePreferenceKey(userId, "textScale")) as? Double ?? store.readingScale
            textSize = min(25, max(15, savedScale * 16))
            showRecords = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "showRecords"))
            reduceMotion = UserDefaults.standard.bool(forKey: mobilePreferenceKey(userId, "reduceMotion"))
        }
    }

    private func setDefaultOpen(records: Bool) {
        showRecords = records
        store.setChatShowsRecords(records)
        UserDefaults.standard.set(records, forKey: mobilePreferenceKey(userId, "showRecords"))
    }

    private func defaultOpenOption(title: String, detail: String, glyph: AstellaGlyphKind, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                AstellaGlyph(kind: glyph, tint: StudyPalette.accent.opacity(0.9))
                    .frame(width: 17, height: 17)
                    .frame(width: 34, height: 34)
                    .background(StudyPalette.sky.opacity(0.75), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 15.5, weight: .medium)).foregroundStyle(StudyPalette.ink)
                    Text(detail).font(.system(size: 11.5)).lineLimit(1).foregroundStyle(StudyPalette.muted)
                }
                Spacer()
                if selected { AstellaGlyph(kind: .checkmark, tint: StudyPalette.accent).frame(width: 14, height: 14) }
            }
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

struct PersonalConventionsScreen: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CompanionBubbleRow(text: "这是我们之间的约定，我会在每次对话做记录。")
                    .padding(.bottom, 22)
                ParticipationPreferencesEditor()
            }
            .padding(.horizontal, 22)
            .padding(.top, 16)
            .padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground())
        .tint(StudyPalette.accent)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "个人约定") }
    }
}

private struct ParticipationPreferencesEditor: View {
    @Environment(AppStore.self) private var store
    @State private var revision = 0
    @State private var enabled = true
    @State private var markdown = ""
    @State private var savedMarkdown = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var error: String?
    @State private var notice: String?
    @State private var conflictLatestMarkdown: String?
    @State private var showDefaults = false
    @State private var loaded = false
    @State private var isAdding = false
    @State private var newConvention = ""

    private var conventions: [String] {
        markdown.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isLoading && !loaded {
                ProgressView("正在读取个人约定…")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else {
                Toggle(isOn: Binding(
                    get: { enabled },
                    set: { value in
                        enabled = value
                        Task { await save(enabled: value) }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("让约定生效")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(StudyPalette.ink)
                        Text("暂停后这些约定不会影响伴星的回应")
                            .font(.system(size: 11))
                            .foregroundStyle(StudyPalette.muted)
                    }
                }
                .tint(StudyPalette.accent)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                }
                .disabled(isSaving)

                Text("我的约定")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.7)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.leading, 2)
                    .padding(.top, 28)
                    .padding(.bottom, 12)

                VStack(spacing: 0) {
                    if conventions.isEmpty {
                        Text("还没有个人约定。添加一条，或继续使用默认陪伴方式。")
                            .font(.system(size: 13))
                            .foregroundStyle(StudyPalette.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 16)
                    } else {
                        ForEach(Array(conventions.enumerated()), id: \.offset) { index, convention in
                            HStack(alignment: .center, spacing: 12) {
                                Text(convention)
                                    .font(.system(size: 15))
                                    .foregroundStyle(StudyPalette.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 8)
                                Button {
                                    removeConvention(convention)
                                } label: {
                                    AstellaGlyph(kind: .close, tint: StudyPalette.muted)
                                        .frame(width: 12, height: 12)
                                        .frame(width: 30, height: 30)
                                        .background(StudyPalette.inset.opacity(0.9), in: Circle())
                                }
                                .buttonStyle(AstellaPressStyle())
                                .disabled(isSaving || !enabled)
                                .accessibilityLabel("删除这条约定：\(convention)")
                            }
                            .padding(.vertical, 13)
                            if index < conventions.count - 1 {
                                Rectangle().fill(StudyPalette.paperEdge.opacity(0.55)).frame(height: 0.7)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
                .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                }

                if isAdding {
                    VStack(alignment: .leading, spacing: 11) {
                        TextField("写下你希望她怎样陪你学习", text: $newConvention, axis: .vertical)
                            .font(.system(size: 15))
                            .lineLimit(2...4)
                            .padding(13)
                            .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.7))
                            .disabled(isSaving)
                        HStack(spacing: 12) {
                            Button {
                                isAdding = false
                                newConvention = ""
                            } label: {
                                Text("取消")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(StudyPalette.ink)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(StudyPalette.paper.opacity(0.9), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(AstellaPressStyle())
                            Button {
                                addConvention()
                            } label: {
                                Text("保存这条约定")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(StudyPalette.accentLabel)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(
                                        LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing),
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    )
                            }
                            .buttonStyle(AstellaPressStyle())
                            .disabled(isSaving || newConvention.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .padding(.top, 14)
                }

                HStack(spacing: 12) {
                    Button {
                        restoreDefaults()
                    } label: {
                        Text("恢复默认")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(StudyPalette.ink)
                            .frame(maxWidth: .infinity, minHeight: 46)
                            .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.6), lineWidth: 0.7))
                    }
                    .buttonStyle(AstellaPressStyle())
                    .disabled(isSaving || !loaded)
                    Button {
                        isAdding = true
                    } label: {
                        Text("添加约定")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(StudyPalette.accentLabel)
                            .frame(maxWidth: .infinity, minHeight: 46)
                            .background(
                                LinearGradient(colors: [StudyPalette.actionFill, StudyPalette.accent], startPoint: .topLeading, endPoint: .bottomTrailing),
                                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                            )
                    }
                    .buttonStyle(AstellaPressStyle())
                    .disabled(isSaving || !loaded || !enabled)
                }
                .padding(.top, 16)

                Text(conventions.isEmpty
                     ? "尚未添加个人约定，默认陪伴方式会照常生效。"
                     : enabled ? "个人约定正在生效。" : "个人约定已暂停，默认陪伴方式仍会生效。")
                    .font(.system(size: 11.5))
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.horizontal, 2)
                    .padding(.top, 12)

                DisclosureGroup("默认陪伴方式", isExpanded: $showDefaults) {
                    Text("页面帮助、自然分句、主动问候与久学休息会根据你实际在看的内容和相处偏好判断是否出现。")
                        .font(.system(size: 12))
                        .foregroundStyle(StudyPalette.muted)
                        .padding(.top, 7)
                        .padding(.horizontal, 2)
                }
                .font(.system(size: 13, weight: .medium))
                .tint(StudyPalette.accent)
                .padding(.horizontal, 2)
                .padding(.top, 22)

                if let error {
                    featureAccountMessage(error, isError: true, retry: {
                        Task { await load(preservingDraft: error.contains("另一台设备刚改过约定")) }
                    })
                    .padding(.top, 14)
                }
                if let notice { featureAccountMessage(notice, isError: false, retry: nil).padding(.top, 14) }
                if let conflictLatestMarkdown {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("另一台设备保存的版本")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(StudyPalette.muted)
                        Text(conflictLatestMarkdown.isEmpty ? "（云端约定为空）" : conflictLatestMarkdown)
                            .font(.system(size: 12))
                            .foregroundStyle(StudyPalette.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("上方列表仍保留你的草稿。合并需要的内容后，保存会以草稿作为最新版本。")
                            .font(.system(size: 11))
                            .foregroundStyle(StudyPalette.muted)
                        Button("用另一台设备的版本替换草稿") {
                            markdown = conflictLatestMarkdown
                            self.conflictLatestMarkdown = nil
                        }
                        .font(.system(size: 12, weight: .medium))
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(.top, 14)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: store.profile?.userId) { await load() }
    }

    private func removeConvention(_ convention: String) {
        var items = conventions
        items.removeAll { $0 == convention }
        markdown = items.joined(separator: "\n")
        Task { await save(enabled: enabled) }
    }

    private func addConvention() {
        let text = newConvention.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var items = conventions
        items.append(text)
        markdown = items.joined(separator: "\n")
        newConvention = ""
        isAdding = false
        Task { await save(enabled: enabled) }
    }

    private func restoreDefaults() {
        markdown = ""
        Task { await save(enabled: enabled) }
    }

    private func load(preservingDraft: Bool = false) async {
        #if DEBUG
        if store.uiReviewMode != nil {
            revision = 3
            enabled = true
            markdown = "称呼我为「夏」\n讲解时先给结论，再举例\n每天 21:30 提醒我复习"
            savedMarkdown = markdown
            loaded = true
            return
        }
        #endif
        let localDraft = markdown
        isLoading = true; error = nil
        defer { isLoading = false }
        do {
            let value = try await store.loadParticipation()
            let serverMarkdown = value["markdown"] as? String ?? ""
            revision = value["revision"] as? Int ?? 0
            enabled = value["enabled"] as? Bool ?? true
            savedMarkdown = serverMarkdown
            markdown = preservingDraft ? localDraft : serverMarkdown
            conflictLatestMarkdown = preservingDraft ? serverMarkdown : nil
            loaded = true
        } catch let cause { error = "个人约定没有同步成功：\(cause.localizedDescription)" }
    }

    private func save(enabled nextEnabled: Bool) async {
        isSaving = true; error = nil; notice = nil
        defer { isSaving = false }
        do {
            let result = try await store.saveParticipation(expectedRevision: revision, markdown: markdown, enabled: nextEnabled)
            revision = result["revision"] as? Int ?? revision + 1
            enabled = result["enabled"] as? Bool ?? nextEnabled
            markdown = result["markdown"] as? String ?? markdown
            savedMarkdown = markdown
            conflictLatestMarkdown = nil
            notice = nextEnabled ? "个人约定已保存并生效。" : "个人约定已暂停，默认陪伴方式仍会生效。"
        } catch {
            let apiError = error as? MobileAPIError
            if apiError?.status == 409 {
                self.error = "另一台设备刚改过约定。读取最新版本时会保留你的草稿，核对并合并后再保存。"
            } else {
                self.error = "这次没有保存成功，编辑内容还在。\(error.localizedDescription)"
            }
        }
    }
}

struct CompanionCenterScreen: View {
    @Environment(AppStore.self) private var store
    @State private var appeared = false

    private var latest: String? {
        guard !store.streamingText.isEmpty else {
            return store.messages.last(where: { $0.role == "assistant" })?.displayText
        }
        return store.streamingText
    }

    private var isResponding: Bool { !store.streamingText.isEmpty || store.isSending }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                companionHero
                    .shellEntrance(0, active: appeared)
                recentExchange
                    .shellEntrance(1, active: appeared)
                relationshipShortcuts
                    .shellEntrance(2, active: appeared)
                NavigationLink(value: AccountScreenRoute.companionSettings) {
                    settingDestinationRow(title: "伴星配置", detail: "相处偏好与交流方式", glyph: .companion)
                        .padding(.horizontal, 16)
                        .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8))
                }
                .buttonStyle(AstellaPressStyle())
                .shellEntrance(3, active: appeared)
            }
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 36)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.hidden)
        .background(DawnBackground()).toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { AstellaDetailHeader(title: "伴星中心") }
        .onAppear {
            guard !appeared else { return }
            Task { @MainActor in await Task.yield(); appeared = true }
        }
    }

    private var companionHero: some View {
        ZStack(alignment: .trailing) {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(LinearGradient(
                    colors: [StudyPalette.sky.opacity(0.92), StudyPalette.paper.opacity(0.92), StudyPalette.paper.opacity(0.78)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
            Circle()
                .fill(StudyPalette.accent.opacity(0.08))
                .frame(width: 176, height: 176)
                .offset(x: 28, y: 38)
                .clipped()
            Image("CompanionStage")
                .resizable()
                .scaledToFit()
                .frame(width: 142, height: 154, alignment: .bottom)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .offset(x: 0, y: -4)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 10) {
                SectionEyebrow(text: "拾星 · 伴星")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text("伴星")
                    .font(.system(size: 27, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(StudyPalette.ink)
                HStack(spacing: 6) {
                    Circle()
                        .fill(isResponding ? StudyPalette.accent : (store.realtimeStatus == "已连接" ? StudyPalette.success : StudyPalette.muted))
                        .frame(width: 7, height: 7)
                    Text(isResponding ? "正在回应" : (store.realtimeStatus == "已连接" ? "语音交流已连接" : "随时可以继续交流"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(StudyPalette.muted)
                        .lineLimit(1)
                }
                Text(store.profile?.workspaceName ?? "和你一起读，也一起想")
                    .font(.system(size: 12))
                    .foregroundStyle(StudyPalette.muted)
                    .lineLimit(1)
                    .padding(.top, 1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 22)
            .padding(.leading, 20)
            .padding(.trailing, 138)
        }
        .frame(height: 160)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(.white.opacity(0.82), lineWidth: 0.9))
        .shadow(color: StudyPalette.ink.opacity(0.06), radius: 16, x: 0, y: 8)
    }

    private var recentExchange: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    SectionEyebrow(text: isResponding ? "此刻的交流" : "最近一次交流")
                }
                Spacer()
                if isResponding { ProgressView().controlSize(.small) }
            }

            Group {
                if let latest, !latest.isEmpty {
                    CompanionMarkdownText(text: latest, onOpenNote: { store.requestNoteReference($0) })
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("还没有新的交流。想读什么、想到什么，都可以从这里继续。")
                        .foregroundStyle(StudyPalette.muted)
                }
            }
            .font(.system(size: 15))
            .lineSpacing(4)
            .foregroundStyle(StudyPalette.ink)
            .textSelection(.enabled)

            Rectangle().fill(StudyPalette.paperEdge.opacity(0.62)).frame(height: 0.7)

            HStack(spacing: 10) {
                Button { store.returnToConversation(records: false) } label: {
                    Label("继续对话", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(StudyPalette.accentLabel)
                        .background(StudyPalette.actionFill, in: Capsule())
                }
                .buttonStyle(AstellaPressStyle())
                Button { store.returnToConversation(records: true) } label: {
                    Label("完整记录", systemImage: "text.alignleft")
                        .font(.system(size: 13, weight: .medium))
                        .frame(minHeight: 44)
                        .padding(.horizontal, 12)
                        .foregroundStyle(StudyPalette.accent)
                        .background(StudyPalette.sky.opacity(0.72), in: Capsule())
                }
                .buttonStyle(AstellaPressStyle())
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.58), lineWidth: 0.8))
    }

    private var relationshipShortcuts: some View {
        VStack(alignment: .leading, spacing: 11) {
            VStack(alignment: .leading, spacing: 4) {
                SectionEyebrow(text: "相伴 · 留下的记录")
                Text("记忆与日记")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(StudyPalette.ink)
            }

            HStack(spacing: 10) {
                relationshipShortcut(
                    title: "她记得的事",
                    detail: "查看与修正",
                    glyph: .sparkle,
                    action: { store.orbitRootSection = "memory"; store.selectedTab = .orbit }
                )
                relationshipShortcut(
                    title: "我们的日记",
                    detail: "回看相伴片段",
                    glyph: .orbit,
                    action: { store.orbitRootSection = "diary"; store.selectedTab = .orbit }
                )
            }
        }
    }

    private func relationshipShortcut(title: String, detail: String, glyph: AstellaGlyphKind, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                AstellaGlyph(kind: glyph, tint: StudyPalette.accent)
                    .frame(width: 19, height: 19)
                    .frame(width: 38, height: 38)
                    .background(StudyPalette.sky.opacity(0.78), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(StudyPalette.ink).lineLimit(1)
                    Text(detail).font(.system(size: 11)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
            .padding(.horizontal, 13)
            .background(StudyPalette.paper.opacity(0.78), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(StudyPalette.paperEdge.opacity(0.55), lineWidth: 0.8))
            .contentShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        }
        .buttonStyle(AstellaPressStyle())
    }
}

func mobilePreferenceKey(_ userId: String, _ name: String) -> String {
    "astella.mobile.\(userId).\(name)"
}

private func astellaLabel(_ title: String, glyph: AstellaGlyphKind) -> some View {
    Label {
        Text(title)
    } icon: {
        AstellaGlyph(kind: glyph, tint: StudyPalette.accent).frame(width: 16, height: 16)
    }
}

private func featureAccountMessage(_ text: String, isError: Bool, retry: (() -> Void)?) -> some View {
    HStack(alignment: .top, spacing: 8) {
        AstellaGlyph(kind: isError ? .alert : .check, tint: isError ? StudyPalette.danger : StudyPalette.success)
            .frame(width: 16, height: 16)
        VStack(alignment: .leading, spacing: 5) {
            Text(text).font(.footnote).foregroundStyle(StudyPalette.muted)
            if let retry { Button("重新读取", action: retry).font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent) }
        }
    }.padding(11).frame(maxWidth: .infinity, alignment: .leading).background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 13))
}

private struct AccountSection<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content
    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.7)
                    .foregroundStyle(StudyPalette.muted)
                    .padding(.leading, 2)
            }
            content
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
                .background(StudyPalette.paper.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(StudyPalette.paperEdge.opacity(0.42), lineWidth: 0.8)
                }
                .shadow(color: StudyPalette.ink.opacity(0.025), radius: 8, x: 0, y: 3)
        }.frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, title == nil ? 10 : 26)
    }
}

// MARK: - Shell entrance (local helper)

/// Shell-level entrance used by the 星轨 / 我的 / 设置 pages: each section rises
/// 10 pt and fades in, 45 ms after the previous one. Timing stays local to the
/// shell pages instead of adding a new global token; movement is removed when
/// either the system or the in-app reduce-motion preference is on.
private struct AstellaShellEntranceModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var systemReduce
    @Environment(AppStore.self) private var store
    var index: Int
    var active: Bool

    private var disabled: Bool { systemReduce || store.localReduceMotion }

    func body(content: Content) -> some View {
        content
            .opacity(active || disabled ? 1 : 0)
            .offset(y: active || disabled ? 0 : 10)
            .animation(
                disabled ? nil : Animation.spring(duration: 0.42, bounce: 0.03).delay(Double(max(0, index)) * 0.045),
                value: active
            )
    }
}

extension View {
    /// Staggered page entrance for shell sections (`index * 45 ms`).
    func shellEntrance(_ index: Int, active: Bool) -> some View {
        modifier(AstellaShellEntranceModifier(index: index, active: active))
    }
}
