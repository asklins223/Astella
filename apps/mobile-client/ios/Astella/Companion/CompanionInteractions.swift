import SwiftUI
import UIKit
import AVFoundation
import PDFKit
import ImageIO
import zlib
import Observation

struct CompanionFile: Identifiable {
    let id = UUID()
    let name: String
    let mime: String
    let data: Data
    let text: String
    var importId: String { "mobile-\(id.uuidString.lowercased())" }

    nonisolated static func read(_ url: URL) throws -> CompanionFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 20 * 1024 * 1024 else {
            throw MobileAPIError(status: 400, code: "file_size", message: "请选择不超过 20 MB 的非空文件。")
        }
        let data = try Data(contentsOf: url)
        let mime: String
        let text: String
        switch url.pathExtension.lowercased() {
        case "pdf":
            mime = "application/pdf"
            guard let pdf = PDFDocument(data: data), !pdf.isLocked else {
                throw MobileAPIError(status: 400, code: "pdf_locked", message: "这份 PDF 已加密或损坏，请先解锁。")
            }
            var pages = [String]()
            var count = 0
            for index in 0..<pdf.pageCount {
                let value = pdf.page(at: index)?.string ?? ""
                count += value.count
                guard count <= 100_000 else { throw tooLong }
                pages.append(value)
            }
            text = pages.joined(separator: "\n\n")
        case "docx":
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            let xml = try wordXML(data)
            let reader = WordTextReader()
            let parser = XMLParser(data: xml)
            parser.delegate = reader
            parser.shouldResolveExternalEntities = false
            guard parser.parse(), !reader.overflow else { throw tooLong }
            text = reader.text
        case "md", "txt":
            mime = url.pathExtension.lowercased() == "md" ? "text/markdown" : "text/plain"
            guard let decoded = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else {
                throw MobileAPIError(status: 400, code: "file_encoding", message: "文字编码无法识别，请另存为 UTF-8 后重试。")
            }
            text = decoded
        default:
            throw MobileAPIError(status: 415, code: "file_type", message: "支持 PDF、Word（.docx）、TXT 和 Markdown。")
        }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            throw MobileAPIError(status: 400, code: "no_text", message: "文件里没有可读取的文字。扫描件可以作为图片交给伴星。")
        }
        guard clean.count <= 100_000 else { throw tooLong }
        return CompanionFile(name: String(url.lastPathComponent.prefix(200)), mime: mime, data: data, text: clean)
    }

    nonisolated private static var tooLong: MobileAPIError {
        MobileAPIError(status: 400, code: "file_text_size", message: "正文超过 10 万字，请拆成几份再发送。")
    }

    // Read only word/document.xml from ZIP's central directory. Bounds and inflated size
    // are checked before allocation; no archive entries are written to the filesystem.
    nonisolated private static func wordXML(_ data: Data) throws -> Data {
        func u16(_ offset: Int) -> Int { Int(data[offset]) | Int(data[offset + 1]) << 8 }
        func u32(_ offset: Int) -> Int { u16(offset) | u16(offset + 2) << 16 }
        var index = max(0, data.count - 65_557)
        while index + 46 <= data.count {
            if u32(index) != 0x02014b50 { index += 1; continue }
            let length = u16(index + 28)
            let next = index + 46 + length + u16(index + 30) + u16(index + 32)
            guard next <= data.count else { break }
            let name = String(data: data[(index + 46)..<(index + 46 + length)], encoding: .utf8)
            if name == "word/document.xml" {
                let packed = u32(index + 20), unpacked = u32(index + 24), local = u32(index + 42)
                guard u16(index + 8) & 1 == 0, unpacked > 0, unpacked <= 8_000_000,
                      local >= 0, local + 30 <= data.count, u32(local) == 0x04034b50 else { break }
                let start = local + 30 + u16(local + 26) + u16(local + 28)
                guard start + packed <= data.count else { break }
                let input = Data(data[start..<(start + packed)])
                if u16(index + 10) == 0 { return input }
                guard u16(index + 10) == 8 else { break }
                var output = Data(count: unpacked)
                let success = input.withUnsafeBytes { source in
                    output.withUnsafeMutableBytes { destination in
                        var stream = z_stream()
                        stream.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: UInt8.self).baseAddress)
                        stream.avail_in = uInt(packed)
                        stream.next_out = destination.bindMemory(to: UInt8.self).baseAddress
                        stream.avail_out = uInt(unpacked)
                        guard inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return false }
                        defer { inflateEnd(&stream) }
                        return inflate(&stream, Z_FINISH) == Z_STREAM_END && stream.total_out == unpacked
                    }
                }
                if success { return output }
                break
            }
            index = next
        }
        throw MobileAPIError(status: 400, code: "invalid_docx", message: "无法读取这份 Word 文件，请检查文件或另存为 PDF。")
    }
}

private final class WordTextReader: NSObject, XMLParserDelegate {
    var text = ""
    var inText = false
    var overflow = false
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        if name == "w:t" { inText = true }
        if name == "w:tab" { text += "\t" }
        if name == "w:br" { text += "\n" }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if inText { text += string }
        if text.count > 100_000 { overflow = true; parser.abortParsing() }
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if name == "w:t" { inText = false }
        if name == "w:p" { text += "\n" }
    }
}

@MainActor @Observable
final class CompanionVoicePlayback: NSObject, AVAudioPlayerDelegate {
    private(set) var isLoading = false
    private(set) var isPlaying = false
    private(set) var isPaused = false
    private(set) var level: Double = 0
    private var player: AVAudioPlayer?
    private var task: Task<Void, Never>?
    private var meter: Task<Void, Never>?
    private var revision = UUID()
    func play(_ text: String, store: AppStore) {
        stop()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let current = revision
        isLoading = true
        task = Task {
            do {
                // Keep utterances within the server's 4,000-character contract.
                for chunk in clean.speechChunks {
                    let data = try await store.api.synthesizeSpeech(chunk)
                    try Task.checkCancellation()
                    guard revision == current else { return }
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.playback, mode: .spokenAudio)
                    try session.setActive(true)
                    let audio = try AVAudioPlayer(data: data)
                    audio.isMeteringEnabled = true
                    audio.delegate = self
                    player = audio
                    guard audio.play() else { throw MobileAPIError(status: 0, code: "audio_play", message: "这段声音暂时无法播放。") }
                    isLoading = false
                    isPlaying = true
                    store.emitCompanion(.speaking(start: true))
                    while (isPlaying || isPaused), revision == current, !Task.isCancelled {
                        audio.updateMeters()
                        level = isPlaying ? level * 0.55 + min(1, pow(10, Double(audio.averagePower(forChannel: 0)) / 30)) * 0.45 : 0
                        try await Task.sleep(for: .milliseconds(40))
                    }
                }
                guard revision == current else { return }
                stop()
                store.emitCompanion(.speaking(start: false))
            } catch is CancellationError { }
            catch {
                guard revision == current else { return }
                stop()
                store.errorMessage = mobilePageError(error, fallback: "声音暂时没有接回来，可以重试朗读。")
                store.emitCompanion(.fail)
            }
        }
    }
    func togglePause() {
        guard let player else { return }
        if isPaused { player.play(); isPlaying = true; isPaused = false }
        else { player.pause(); isPlaying = false; isPaused = true; level = 0 }
    }
    func stop() {
        revision = UUID()
        task?.cancel(); task = nil
        meter?.cancel(); meter = nil
        player?.stop(); player = nil
        isLoading = false; isPlaying = false; isPaused = false; level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            self.isPlaying = false; self.isPaused = false; self.level = 0
        }
    }
}

private extension String {
    var speechChunks: [String] {
        var result = [String](), chunk = ""
        for character in self {
            chunk.append(character)
            if chunk.count >= 1_200 && ("。！？\n".contains(character) || chunk.count >= 1_800) {
                result.append(chunk); chunk = ""
            }
        }
        if !chunk.isEmpty { result.append(chunk) }
        return result
    }
}

extension AppStore {
    func emitCompanion(_ event: CompanionEvent) {
        companionEvent = event
        companionEventRevision &+= 1
    }
    func prepareImage(_ data: Data) {
        intakeGeneration += 1
        guard data.count <= 10 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 4096
              ] as CFDictionary),
              let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.9), jpeg.count <= 10 * 1024 * 1024 else {
            errorMessage = "图片无法读取或超过 10 MB，请换一张。"; emitCompanion(.fail); return
        }
        selectedImage = jpeg; selectedFile = nil
        attachmentRevision = UUID(); errorMessage = nil
        emitCompanion(.attention)
    }
    func prepareFile(_ url: URL) async {
        intakeGeneration += 1
        let generation = intakeGeneration
        let session = api.token
        do {
            let file = try await Task.detached(priority: .userInitiated) { try CompanionFile.read(url) }.value
            guard generation == intakeGeneration, session == api.token, !Task.isCancelled else { return }
            selectedFile = file; selectedImage = nil; attachmentRevision = UUID(); errorMessage = nil
            emitCompanion(.attention)
        } catch {
            guard generation == intakeGeneration, session == api.token else { return }
            errorMessage = error.localizedDescription; emitCompanion(.fail)
        }
    }
    func importPreparedFile() async {
        guard let file = selectedFile, !isSending else { return }
        let session = api.token
        isSending = true; errorMessage = nil
        defer { if session == api.token { isSending = false } }
        do {
            let response = try await api.request("/import/markdown", method: "POST", body: [
                "importId": file.importId,
                "items": [["title": (file.name as NSString).deletingPathExtension, "content": file.text]]
            ]) as? [String: Any]
            guard session == api.token else { return }
            guard (response?["imported"] as? Int ?? 0) == 1 else {
                throw MobileAPIError(status: 422, code: "import_incomplete", message: "文件没有成功导入，请检查内容后重试。")
            }
            if selectedFile?.id == file.id { selectedFile = nil }
            emitCompanion(.absorb(success: true))
            await loadNotes()
            selectedTab = .library
        } catch { errorMessage = mobilePageError(error, fallback: "手记没有导入，文件仍保留在这里。") }
    }
    func askAboutSelection(_ text: String, document: NoteDocument, rewrite: Bool) async {
        guard !isSending else { return }
        let context = PendingNoteContext(noteId: document.id, versionId: document.versionId, title: document.title)
        selectionRunId = nil
        selectionRequestTitle = rewrite ? "一起改好这一段" : "读懂这一段"
        streamingText = ""
        emitCompanion(.attention)
        selectionRunId = await submit(text: rewrite ? "请改写我选中的这段原文，保留原意，先给出修改对照，等我确认后再写回手记。" : "请结合这篇手记解释我选中的原文，讲清含义与关键关系。", selection: String(text.prefix(20_000)), context: context)
    }
}

/// A deterministic field: only the envelope follows real audio energy. No fake
/// voice amplitude, per-particle state allocation, or view-tree mutation per frame.
struct CompanionParticleField: View {
    var level: Double
    var active: Bool
    var reduceMotion: Bool
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !active || reduceMotion)) { timeline in
            let time = active && !reduceMotion ? timeline.date.timeIntervalSinceReferenceDate : 0
            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                if reduceMotion {
                    guard active else { return }
                    for index in 0..<17 {
                        let height = 5.0 + Double(index % 4) * 3
                        let rect = CGRect(x: center.x - 51 + Double(index) * 6, y: center.y - height / 2, width: 2, height: height)
                        context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(StudyPalette.accent.opacity(0.5)))
                    }
                    return
                }
                let energy = active ? max(0.05, level) : 0
                for index in 0..<144 {
                    let seed = Double(index)
                    let angle = seed * 2.399963 + time * (index % 2 == 0 ? 0.13 : -0.09)
                    let shell = 0.62 + Double(index % 7) / 18
                    let wave = sin(angle * 5 + time * 2.2) * energy * 19
                    let radius = min(size.width, size.height) * 0.37 * shell + wave + energy * 16
                    let point = CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius * 0.52)
                    let diameter = 1.4 + Double(index % 3) * 0.6 + energy * 1.1
                    let alpha = (0.12 + energy * 0.45) * (0.45 + shell / 2)
                    context.fill(Path(ellipseIn: CGRect(x: point.x, y: point.y, width: diameter, height: diameter)), with: .color(StudyPalette.accent.opacity(alpha)))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Reader typography for selectable body text. Paragraph metrics are supplied by
/// the caller so the reader can use Songti with a two-character first-line indent
/// without changing the selected range (indent is a paragraph style, not spaces).
struct CompanionTextStyle: Equatable {
    var fontSize: CGFloat
    var serif = false
    var firstLineIndent: CGFloat = 0
    var lineSpacing: CGFloat = 0
    var paragraphSpacing: CGFloat = 0
    var color: UIColor = .label
}

func companionMarkdown(_ text: String) -> AttributedString {
    let normalizedLists = text
        .replacingOccurrences(of: "\r\n", with: "\n")
        .components(separatedBy: "\n")
        .map { line -> String in
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            let indentation = String(line.prefix(line.count - trimmed.count))
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                return indentation + "• " + String(trimmed.dropFirst(2))
            }
            return line
        }
        .joined(separator: "\n")
    return (try? AttributedString(
        markdown: normalizedLists,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(normalizedLists)
}

func normalizedNoteReferenceMarkup(_ text: String) -> String {
    var value = text
    for _ in 0..<4 {
        let unescaped = value.replacingOccurrences(
            of: #"\\([\[\]])"#,
            with: "$1",
            options: .regularExpression
        )
        if unescaped == value { break }
        value = unescaped
    }
    return value.replacingOccurrences(
        of: #"\[\[([^\[\]\n]+)\]\]"#,
        with: "$1",
        options: .regularExpression
    )
}

/// Keeps internal note references readable and tappable in native message text.
/// SwiftUI's Markdown parser does not reliably recognize the app's custom URL scheme.
func companionMarkdownWithNoteLinks(_ text: String) -> AttributedString {
    let normalizedText = normalizedNoteReferenceMarkup(text)
    guard let regex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\(astella-note:([^\s)]+)\)"#) else {
        return companionMarkdown(normalizedText)
    }
    let matches = regex.matches(in: normalizedText, range: NSRange(normalizedText.startIndex..., in: normalizedText))
    guard !matches.isEmpty else { return companionMarkdown(normalizedText) }

    var result = AttributedString()
    var cursor = normalizedText.startIndex
    for match in matches {
        guard let fullRange = Range(match.range, in: normalizedText),
              let titleRange = Range(match.range(at: 1), in: normalizedText),
              let idRange = Range(match.range(at: 2), in: normalizedText) else { continue }
        result.append(companionMarkdown(String(normalizedText[cursor..<fullRange.lowerBound])))
        var title = AttributedString(String(normalizedText[titleRange]))
        let noteId = String(normalizedText[idRange])
        if let encodedId = noteId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
           let url = URL(string: "astella-note://note/\(encodedId)") {
            title.link = url
        }
        result.append(title)
        cursor = fullRange.upperBound
    }
    result.append(companionMarkdown(String(normalizedText[cursor...])))
    return result
}

struct CompanionMarkdownText: View {
    var text: String
    var onOpenNote: ((String) -> Void)? = nil

    var body: some View {
        Text(companionMarkdownWithNoteLinks(text))
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "astella-note" else { return .systemAction }
                let noteId = url.pathComponents.last?.removingPercentEncoding ?? ""
                guard !noteId.isEmpty, noteId != "note", let onOpenNote else { return .discarded }
                onOpenNote(noteId)
                return .handled
            })
    }
}

private func noteReferenceAttributedText(
    _ text: String,
    baseAttributes: [NSAttributedString.Key: Any],
    linkColor: UIColor
) -> NSAttributedString {
    let normalizedText = normalizedNoteReferenceMarkup(text)
    let result = NSMutableAttributedString(string: normalizedText, attributes: baseAttributes)
    guard let regex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\(astella-note:([^\s)]+)\)"#) else {
        return result
    }
    let source = normalizedText as NSString
    for match in regex.matches(in: normalizedText, range: NSRange(location: 0, length: source.length)).reversed() {
        guard match.numberOfRanges == 3 else { continue }
        let label = source.substring(with: match.range(at: 1))
        let noteId = source.substring(with: match.range(at: 2))
        guard let escapedID = noteId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "astella-note://note/\(escapedID)") else { continue }
        var linkAttributes = baseAttributes
        linkAttributes[.link] = url
        linkAttributes[.foregroundColor] = linkColor
        linkAttributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        result.replaceCharacters(in: match.range, with: NSAttributedString(string: label, attributes: linkAttributes))
    }
    return result
}

/// Native text selection with actions attached to the actual range, not a
/// whole-block context menu. UITextView keeps platform handles and copy behavior.
struct CompanionSelectableText: UIViewRepresentable {
    let text: String
    let fontSize: CGFloat
    var style: CompanionTextStyle?
    var onOpenNote: ((String) -> Void)? = nil
    var annotationMarks: [SelectableTextAnnotationMark] = []
    var noteReferences: [SelectableTextNoteReference] = []
    var onOpenAnnotationBlock: ((Int) -> Void)? = nil
    var onSelection: (String, Bool) -> Void
    func makeUIView(context: Context) -> SelectionTextView {
        let view = SelectionTextView()
        view.isEditable = false; view.isScrollEnabled = false
        view.delegate = view
        view.backgroundColor = .clear; view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: SelectionTextView, context: Context) {
        let resolvedStyle = style ?? CompanionTextStyle(fontSize: fontSize, color: .label)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = resolvedStyle.lineSpacing
        paragraph.paragraphSpacing = resolvedStyle.paragraphSpacing
        paragraph.firstLineHeadIndent = resolvedStyle.firstLineIndent
        paragraph.headIndent = 0
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [
            .font: StudySerif.uiFont(size: resolvedStyle.fontSize, serif: resolvedStyle.serif),
            .foregroundColor: resolvedStyle.color,
            .paragraphStyle: paragraph,
        ]
        let rendered = NSMutableAttributedString(
            attributedString: noteReferenceAttributedText(text, baseAttributes: attributes, linkColor: UIColor(StudyPalette.accent))
        )
        let renderedLength = rendered.length
        for reference in noteReferences {
            guard reference.startOffset >= 0, reference.endOffset > reference.startOffset,
                  reference.endOffset <= renderedLength,
                  let escapedID = reference.noteId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                  let url = URL(string: "astella-note://note/\(escapedID)") else { continue }
            let range = NSRange(location: reference.startOffset, length: reference.endOffset - reference.startOffset)
            rendered.addAttribute(.link, value: url, range: range)
            rendered.addAttribute(.foregroundColor, value: UIColor(StudyPalette.accent), range: range)
            rendered.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
        }
        for mark in annotationMarks.sorted(by: {
            if $0.endOffset != $1.endOffset { return $0.endOffset > $1.endOffset }
            return ($0.number ?? 0) > ($1.number ?? 0)
        }) {
            guard mark.startOffset >= 0, mark.endOffset > mark.startOffset,
                  mark.endOffset <= renderedLength else { continue }
            let range = NSRange(location: mark.startOffset, length: mark.endOffset - mark.startOffset)
            rendered.addAttribute(.backgroundColor, value: UIColor(StudyPalette.accent.opacity(0.16)), range: range)
            rendered.addAttribute(.underlineColor, value: UIColor(StudyPalette.accent.opacity(0.58)), range: range)
            rendered.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)

            guard let number = mark.number,
                  let markerURL = URL(string: "astella-annotation://block/\(mark.blockOrdinal)") else { continue }
            let markerFont = UIFont.systemFont(ofSize: resolvedStyle.fontSize * 0.62, weight: .semibold)
            let markerAttributes: [NSAttributedString.Key: Any] = [
                .font: markerFont,
                .foregroundColor: UIColor(StudyPalette.accent),
                .baselineOffset: resolvedStyle.fontSize * 0.34,
                .link: markerURL,
            ]
            rendered.insert(NSAttributedString(string: superscriptAnnotationNumber(number), attributes: markerAttributes), at: mark.endOffset)
        }
        view.attributedText = rendered
        view.onSelection = onSelection
        view.onOpenNote = onOpenNote
        view.onOpenAnnotationBlock = onOpenAnnotationBlock
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectionTextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}

struct SelectableTextAnnotationMark: Equatable {
    var blockOrdinal: Int
    var startOffset: Int
    var endOffset: Int
    var number: Int?
}

struct SelectableTextNoteReference: Equatable {
    var startOffset: Int
    var endOffset: Int
    var noteId: String
}

private func superscriptAnnotationNumber(_ value: Int) -> String {
    let digits: [Character: Character] = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"]
    return String(String(value).map { digits[$0] ?? $0 })
}

final class SelectionTextView: UITextView, UITextViewDelegate {
    var onSelection: ((String, Bool) -> Void)?
    var onOpenNote: ((String) -> Void)?
    var onOpenAnnotationBlock: ((Int) -> Void)?

    func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
        guard case let .link(url) = textItem.content else { return defaultAction }
        if url.scheme == "astella-annotation" {
            guard let blockOrdinal = Int(url.lastPathComponent) else { return nil }
            return UIAction(title: "查看批注", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
                self?.onOpenAnnotationBlock?(blockOrdinal)
            }
        }
        guard url.scheme == "astella-note" else { return defaultAction }
        let noteId = url.pathComponents.last ?? ""
        guard !noteId.isEmpty, noteId != "note" else { return nil }
        return UIAction(title: "打开引用笔记", image: UIImage(systemName: "book")) { [weak self] _ in
            self?.onOpenNote?(noteId.removingPercentEncoding ?? noteId)
        }
    }

    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard range.length > 0, range.location + range.length <= (text as NSString).length else { return nil }
        let selected = (text as NSString).substring(with: range)
        let explain = UIAction(title: "伴星解释", image: UIImage(systemName: "sparkles")) { [weak self] _ in self?.onSelection?(selected, false) }
        let rewrite = UIAction(title: "伴星改写", image: UIImage(systemName: "pencil.line")) { [weak self] _ in self?.onSelection?(selected, true) }
        return UIMenu(children: [UIMenu(title: "", options: .displayInline, children: [explain, rewrite])] + suggestedActions)
    }
}

struct CompanionSelectionSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let original: String
    let baseline: Set<String>
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 10) {
                        Image("BrandMark").resizable().scaledToFit().frame(width: 34, height: 34)
                        Text(store.selectionRequestTitle ?? "一起读这一段").font(.title2.weight(.semibold))
                    }
                    Text(original).font(.subheadline).foregroundStyle(StudyPalette.muted)
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 16))
                    ForEach(store.messages.filter { !baseline.contains($0.id) && $0.role == "assistant" && $0.runId == store.selectionRunId && store.selectionRunId != nil }) { message in MessageRow(message: message) }
                    if !store.streamingText.isEmpty, store.streamingRunId == store.selectionRunId, store.selectionRunId != nil { Text(store.streamingText).lineSpacing(5).textSelection(.enabled) }
                    if store.isSending || !store.runs.isEmpty {
                        HStack { ProgressView().controlSize(.small); Text("伴星正在读原文…").font(.footnote).foregroundStyle(StudyPalette.muted) }
                    }
                    if let error = store.errorMessage { Text(error).font(.footnote).foregroundStyle(StudyPalette.danger) }
                }.padding(24)
            }.background(DawnBackground())
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("收起") { dismiss() } } }
        }
    }
}

struct CompanionProposalCard: View {
    @Environment(AppStore.self) private var store
    let proposalId: String
    @State private var proposal: [String: Any]?
    @State private var error: String?
    @State private var busy = false
    @State private var decisionKeys = [String: String]()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let proposal {
                Text(proposal["title"] as? String ?? "伴星的修改建议").font(.headline)
                if let impact = proposal["impactSummary"] as? String { Text(impact).font(.footnote).foregroundStyle(StudyPalette.muted) }
                if let payload = proposal["payload"] as? [String: Any], let preview = payload["preview"] as? [String: Any] {
                    if let before = preview["beforeMarkdown"] as? String, !before.isEmpty {
                        Text("原文").font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.muted)
                        Text(before).font(.subheadline).textSelection(.enabled).padding(12)
                            .background(StudyPalette.inset, in: RoundedRectangle(cornerRadius: 12))
                    }
                    if let after = preview["markdown"] as? String, !after.isEmpty {
                        Text("改写后").font(.caption.weight(.semibold)).foregroundStyle(StudyPalette.accent)
                        Text(after).font(.subheadline).textSelection(.enabled).padding(12)
                            .background(StudyPalette.sky, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                if proposal["status"] as? String == "pending" {
                    HStack {
                        Button("保留原文") { decide("reject") }.buttonStyle(AstellaCompactActionStyle())
                        Spacer()
                        Button("确认写回") { decide("confirm") }.buttonStyle(AstellaCompactActionStyle(primary: true))
                    }.disabled(busy)
                } else { Text(statusLabel(proposal["status"] as? String)).font(.footnote).foregroundStyle(StudyPalette.muted) }
            } else {
                Button("查看修改建议") { Task { await load() } }.font(.subheadline.weight(.medium))
            }
            if busy { ProgressView().controlSize(.small) }
            if let error {
                Text(error).font(.footnote).foregroundStyle(StudyPalette.danger)
                Button("重新读取建议") { Task { await load() } }.font(.footnote)
            }
        }.padding(16).background(StudyPalette.paper, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(StudyPalette.paperEdge.opacity(0.5), lineWidth: 0.5))
            .task(id: proposalId) { await load() }
            .task(id: proposal?["status"] as? String) {
                while ["accepted", "executing"].contains(proposal?["status"] as? String ?? ""), !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                    await load()
                }
            }
    }
    private func statusLabel(_ status: String?) -> String {
        switch status {
        case "succeeded": "已经写回手记"
        case "rejected": "已保留原文"
        case "failed": "写回没有完成，请重新请伴星修改"
        case "expired": "这份建议已过期，请按当前原文重新生成"
        default: "正在写回手记…"
        }
    }
    private func load() async {
        do {
            let result = try await store.api.request("/companion/proposals/\(proposalId)") as? [String: Any]
            proposal = result?["proposal"] as? [String: Any]; error = nil
        } catch { self.error = mobilePageError(error, fallback: "建议暂时没有加载出来，请重试。") }
    }
    private func decide(_ decision: String) {
        guard !busy, let hash = proposal?["payloadSha256"] as? String else { return }
        let key = decisionKeys[decision] ?? UUID().uuidString.lowercased()
        decisionKeys[decision] = key
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await store.api.request("/companion/proposals/\(proposalId)/decision", method: "POST", body: [
                    "version": 1, "decision": decision, "expectedPayloadSha256": hash, "idempotencyKey": key
                ], idempotencyKey: key)
                await load()
                await store.refreshMessages()
            } catch { self.error = mobilePageError(error, fallback: "决定没有送达，请重试。") }
        }
    }
}

extension AppStore {
    func reportAwareness(topic: String, foreground: Bool) async {
        guard profile != nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let elapsed = foreground ? min(45_000, max(0, Int((now - lastObservation) * 1000))) : 0
        lastObservation = now
        let quiet = min(86_400_000, max(0, Int((now - lastInteraction) * 1000)))
        let typing = foreground && now - lastInteraction < 3 && !draft.isEmpty
        let pageLabel = visibleNoteId != nil ? "阅读手记" : selectedTab == .library ? "书房" : selectedTab == .orbit ? "星轨" : selectedTab == .me ? "我的" : "与伴星交流"
        var context: [String: Any] = [
            "foreground": foreground, "unlocked": foreground, "typing": typing,
            "learning": visibleNoteId != nil, "speaking": voicePlayback.isPlaying,
            "participationAllowed": true, "conversationId": conversationId as Any? ?? NSNull(),
            "page": ["key": visibleNoteId.map { "note:\($0)" } ?? "mobile:\(pageLabel)", "label": pageLabel,
                     "revision": visibleNoteId != nil ? noteDocument?.versionId as Any? ?? NSNull() : NSNull(),
                     "context": visibleNoteId.map { ["noteId": $0] } as Any? ?? NSNull()]
        ]
        if topic == "presence.quiet" && quiet >= 90_000 && !typing { context["quietForMs"] = quiet }
        else if topic == "presence.quiet" { return }
        do {
            _ = try await api.request("/me/companion/awareness", method: "POST", body: [
                "version": 1, "id": UUID().uuidString.lowercased(), "deviceSessionId": awarenessLaunchId,
                "appLaunchId": awarenessLaunchId, "host": "ios", "topic": topic,
                "occurredAt": ISO8601DateFormatter().string(from: Date()), "elapsedMs": elapsed, "context": context
            ])
        } catch { /* Passive presence must not replace a user's actionable error. */ }
    }
}
