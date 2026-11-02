import Foundation
import Testing
@testable import CompanionRecords

/// 审计见证测试：回放真实 API/worker 事件，确认当前缺陷存在，不作为正常行为回归。
@Test func agentAuditRealSSEPlacesFinishProcessAfterBody() throws {
    struct Fixture: Decodable {
        var runId: String
        var status: String
        var events: [CompanionProcessEventDTO]
        var messages: [CompanionMessageDTO]
    }
    let path = try #require(ProcessInfo.processInfo.environment["ASTELLA_AUDIT_REPLAY"])
    let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    var run = ActiveRun(id: fixture.runId, status: fixture.status, stepCount: 3, toolCallCount: 1, thinkingText: nil)
    run.timeline = fixture.events.compactMap { $0.timelineEvent(runID: run.id) }
    run.nodes = run.timeline.compactMap(\.node)
    run.thinkingText = run.timeline.filter { $0.type == "assistant.thinking" }.compactMap(\.text).joined()
    let messages = fixture.messages.map { companionMessage(from: $0) }
    let turn = CompanionRecordTurn(id: "run:\(run.id)", messages: messages, run: run, associatedRunId: run.id)
    let sections = turn.replySections(streamingText: "")
    var seenBody = false
    var processAfterBody = 0
    var shape: [[String]] = []
    var displayBodies: [String] = []
    for section in sections {
        var sectionShape: [String] = []
        for part in section.parts {
            switch part.content {
            case .message(let message):
                seenBody = true
                displayBodies.append(message.displayText)
                sectionShape.append("body(\(message.displayText.count))")
            case .process(let process):
                if seenBody { processAfterBody += 1 }
                sectionShape.append(process.recordProcessTitle + "(" + process.nodes.compactMap(\.toolName).joined(separator: ",") + ")")
            default: sectionShape.append("artifact")
            }
        }
        shape.append(sectionShape)
    }
    let saved = messages.map(\.displayText).joined()
    let display = displayBodies.joined()
    print("AUDIT_REPLAY sections=\(shape) processAfterBody=\(processAfterBody) savedChars=\(saved.count) visibleChars=\(display.count)")
    #expect(processAfterBody > 0, "复现正文后出现思考与过程")
    #expect(display != saved, "复现单条消息重建以流式片段为准、与落库正文分歧")
    #expect(run.nodes.contains { $0.toolName == "companion_finish" }, "内部 finish 被当作用户过程")
}
