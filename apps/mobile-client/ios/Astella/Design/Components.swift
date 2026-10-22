import SwiftUI
import UIKit

struct PageHeading: View {
    let eyebrow: String
    let title: String
    var subtitle: String? = nil
    var trailing: AnyView? = nil

    var body: some View {
        HStack(alignment: .top, spacing: StudySpacing.lg - 2) {
            VStack(alignment: .leading, spacing: 5) {
                SectionEyebrow(text: eyebrow)
                Text(title)
                    .font(.system(size: 30, weight: .semibold)).lineSpacing(4)
                    .tracking(StudyTracking.largeTitle)
                    .foregroundStyle(StudyPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(StudyPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
    }
}

struct SectionEyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium)).tracking(0.3)
            .foregroundStyle(StudyPalette.muted)
    }
}

/// 静态伴星立绘——Live2D 运行时（阶段 4）加载成功前的降级形态。
struct CompanionPortrait: View {
    var body: some View {
        Image("Companion")
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 190)
        .frame(maxWidth: .infinity, minHeight: 140, maxHeight: 210)
        .accessibilityLabel("伴星在书桌前陪你学习")
    }
}


struct AstellaStar: Shape {
    func path(in rect: CGRect) -> Path {
        let x = rect.midX, y = rect.midY, rx = rect.width / 2, ry = rect.height / 2
        var p = Path()
        p.move(to: CGPoint(x: x, y: y - ry))
        p.addQuadCurve(to: CGPoint(x: x + rx, y: y), control: CGPoint(x: x + rx * 0.18, y: y - ry * 0.18))
        p.addQuadCurve(to: CGPoint(x: x, y: y + ry), control: CGPoint(x: x + rx * 0.18, y: y + ry * 0.18))
        p.addQuadCurve(to: CGPoint(x: x - rx, y: y), control: CGPoint(x: x - rx * 0.18, y: y + ry * 0.18))
        p.addQuadCurve(to: CGPoint(x: x, y: y - ry), control: CGPoint(x: x - rx * 0.18, y: y - ry * 0.18))
        return p
    }
}

enum AstellaGlyphKind: Equatable {
    case companion, hand, book, library, orbit, sparkle, edit, recall, tasks, search, add, close, back, chevron, person, mic, send, document, download, moon, sun, refresh, photo, camera, more, play, pause, stop, wave, text
    case alert, check, checkmark, info, quote, mindMap
    case mail, lock, key, eye, eyeSlash, settings, history, chat, logout, shield, copy, speaker, number
}

/// Small, hand-drawn Astella symbols used in the mobile navigation and controls.
struct AstellaGlyph: View {
    var kind: AstellaGlyphKind
    var tint: Color = StudyPalette.ink

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            context.translateBy(x: (size.width - 24 * scale) / 2, y: (size.height - 24 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            let line = StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
            func stroke(_ path: Path) { context.stroke(path, with: .color(tint), style: line) }
            func fill(_ path: Path) { context.fill(path, with: .color(tint)) }
            switch kind {
            case .companion:
                var star = Path()
                star.move(to: CGPoint(x: 12, y: 2.2))
                star.addQuadCurve(to: CGPoint(x: 21.8, y: 12), control: CGPoint(x: 13.3, y: 10.7))
                star.addQuadCurve(to: CGPoint(x: 12, y: 21.8), control: CGPoint(x: 10.7, y: 13.3))
                star.addQuadCurve(to: CGPoint(x: 2.2, y: 12), control: CGPoint(x: 10.7, y: 10.7))
                star.addQuadCurve(to: CGPoint(x: 12, y: 2.2), control: CGPoint(x: 13.3, y: 10.7))
                fill(star)
                fill(Path(ellipseIn: CGRect(x: 18.7, y: 2.5, width: 2.5, height: 2.5)))
            case .hand:
                var tray = Path()
                tray.move(to: CGPoint(x: 3.5, y: 7.5)); tray.addLine(to: CGPoint(x: 20.5, y: 7.5))
                tray.addLine(to: CGPoint(x: 19.5, y: 19.5)); tray.addLine(to: CGPoint(x: 4.5, y: 19.5)); tray.closeSubpath()
                tray.move(to: CGPoint(x: 7.5, y: 12.5)); tray.addLine(to: CGPoint(x: 10, y: 15.5)); tray.addLine(to: CGPoint(x: 14, y: 15.5)); tray.addLine(to: CGPoint(x: 16.5, y: 12.5))
                stroke(tray)
            case .book:
                var book = Path()
                book.move(to: CGPoint(x: 4, y: 5.5)); book.addQuadCurve(to: CGPoint(x: 6.5, y: 3), control: CGPoint(x: 4, y: 3))
                book.addLine(to: CGPoint(x: 19, y: 3)); book.addLine(to: CGPoint(x: 19, y: 20)); book.addLine(to: CGPoint(x: 6.5, y: 20))
                book.addQuadCurve(to: CGPoint(x: 4, y: 17.5), control: CGPoint(x: 4, y: 20)); book.closeSubpath()
                book.move(to: CGPoint(x: 8, y: 3)); book.addLine(to: CGPoint(x: 8, y: 20))
                book.move(to: CGPoint(x: 11, y: 7)); book.addLine(to: CGPoint(x: 16, y: 7))
                book.move(to: CGPoint(x: 11, y: 10)); book.addLine(to: CGPoint(x: 16, y: 10))
                stroke(book)
            case .library:
                var shelf = Path()
                shelf.move(to: CGPoint(x: 4, y: 5.5)); shelf.addQuadCurve(to: CGPoint(x: 6.5, y: 3), control: CGPoint(x: 4, y: 3))
                shelf.addLine(to: CGPoint(x: 20, y: 3)); shelf.addLine(to: CGPoint(x: 20, y: 20)); shelf.addLine(to: CGPoint(x: 6.5, y: 20))
                shelf.addQuadCurve(to: CGPoint(x: 4, y: 17.5), control: CGPoint(x: 4, y: 20)); shelf.closeSubpath()
                shelf.move(to: CGPoint(x: 8, y: 3)); shelf.addLine(to: CGPoint(x: 8, y: 20))
                shelf.move(to: CGPoint(x: 12, y: 7)); shelf.addLine(to: CGPoint(x: 16, y: 7)); shelf.addLine(to: CGPoint(x: 16, y: 13)); shelf.addLine(to: CGPoint(x: 12, y: 13)); shelf.closeSubpath()
                stroke(shelf)
            case .orbit:
                // A tilted ring with a satellite, so 星轨 is not a second copy
                // of the four-point star used for 相伴.
                let spin = CGAffineTransform(translationX: -12, y: -12)
                    .concatenating(CGAffineTransform(rotationAngle: -.pi / 6))
                    .concatenating(CGAffineTransform(translationX: 12, y: 12))
                let ring = Path(ellipseIn: CGRect(x: 2.8, y: 7.4, width: 18.4, height: 9.2)).applying(spin)
                stroke(ring)
                fill(Path(ellipseIn: CGRect(x: 10.8, y: 10.8, width: 2.4, height: 2.4)))
                fill(Path(ellipseIn: CGRect(x: 19.2, y: 2.4, width: 3.6, height: 3.6)))
            case .sparkle:
                var sparkle = Path()
                sparkle.move(to: CGPoint(x: 12, y: 2.5))
                sparkle.addQuadCurve(to: CGPoint(x: 21.5, y: 12), control: CGPoint(x: 13.5, y: 10.8))
                sparkle.addQuadCurve(to: CGPoint(x: 12, y: 21.5), control: CGPoint(x: 10.8, y: 13.5))
                sparkle.addQuadCurve(to: CGPoint(x: 2.5, y: 12), control: CGPoint(x: 10.8, y: 10.8))
                sparkle.addQuadCurve(to: CGPoint(x: 12, y: 2.5), control: CGPoint(x: 13.5, y: 10.8))
                fill(sparkle)
                fill(Path(ellipseIn: CGRect(x: 18.5, y: 2.5, width: 2.5, height: 2.5)))
            case .edit:
                var pencil = Path()
                pencil.move(to: CGPoint(x: 15.5, y: 3))
                pencil.addLine(to: CGPoint(x: 21, y: 8.5))
                pencil.addLine(to: CGPoint(x: 9, y: 20.5))
                pencil.addLine(to: CGPoint(x: 3, y: 21.5))
                pencil.addLine(to: CGPoint(x: 4, y: 15.5))
                pencil.closeSubpath()
                pencil.move(to: CGPoint(x: 13.5, y: 5))
                pencil.addLine(to: CGPoint(x: 19, y: 10.5))
                stroke(pencil)
            case .recall:
                var bolt = Path()
                bolt.move(to: CGPoint(x: 13.5, y: 2.5)); bolt.addLine(to: CGPoint(x: 6, y: 13)); bolt.addLine(to: CGPoint(x: 11, y: 13))
                bolt.addLine(to: CGPoint(x: 9.5, y: 21.5)); bolt.addLine(to: CGPoint(x: 18, y: 10.5)); bolt.addLine(to: CGPoint(x: 13, y: 10.5)); bolt.closeSubpath()
                fill(bolt)
                fill(Path(ellipseIn: CGRect(x: 18.5, y: 3, width: 2.5, height: 2.5)))
            case .tasks:
                var tasks = Path()
                tasks.addEllipse(in: CGRect(x: 3.5, y: 5, width: 3, height: 3))
                tasks.addEllipse(in: CGRect(x: 3.5, y: 10.5, width: 3, height: 3))
                tasks.addEllipse(in: CGRect(x: 3.5, y: 16, width: 3, height: 3))
                tasks.move(to: CGPoint(x: 10, y: 6.5)); tasks.addLine(to: CGPoint(x: 20.5, y: 6.5))
                tasks.move(to: CGPoint(x: 10, y: 12)); tasks.addLine(to: CGPoint(x: 20.5, y: 12))
                tasks.move(to: CGPoint(x: 10, y: 17.5)); tasks.addLine(to: CGPoint(x: 20.5, y: 17.5))
                stroke(tasks)
            case .search:
                var search = Path(ellipseIn: CGRect(x: 2.8, y: 2.8, width: 14.2, height: 14.2))
                search.move(to: CGPoint(x: 15.5, y: 15.5)); search.addLine(to: CGPoint(x: 21.2, y: 21.2))
                stroke(search)
            case .sun:
                var sun = Path(ellipseIn: CGRect(x: 8, y: 8, width: 8, height: 8))
                [(12.0, 2.5, 12.0, 5.3), (12.0, 18.7, 12.0, 21.5), (2.5, 12.0, 5.3, 12.0), (18.7, 12.0, 21.5, 12.0), (5.3, 5.3, 7.2, 7.2), (16.8, 16.8, 18.7, 18.7), (18.7, 5.3, 16.8, 7.2), (7.2, 16.8, 5.3, 18.7)].forEach { x1, y1, x2, y2 in
                    sun.move(to: CGPoint(x: x1, y: y1)); sun.addLine(to: CGPoint(x: x2, y: y2))
                }
                stroke(sun)
            case .add:
                var plus = Path(); plus.move(to: CGPoint(x: 12, y: 4)); plus.addLine(to: CGPoint(x: 12, y: 20)); plus.move(to: CGPoint(x: 4, y: 12)); plus.addLine(to: CGPoint(x: 20, y: 12)); stroke(plus)
            case .close:
                var close = Path(); close.move(to: CGPoint(x: 6, y: 6)); close.addLine(to: CGPoint(x: 18, y: 18)); close.move(to: CGPoint(x: 18, y: 6)); close.addLine(to: CGPoint(x: 6, y: 18)); stroke(close)
            case .back:
                var back = Path(); back.move(to: CGPoint(x: 15.5, y: 4.5)); back.addLine(to: CGPoint(x: 8, y: 12)); back.addLine(to: CGPoint(x: 15.5, y: 19.5)); stroke(back)
            case .chevron:
                var next = Path(); next.move(to: CGPoint(x: 8.5, y: 5)); next.addLine(to: CGPoint(x: 15.5, y: 12)); next.addLine(to: CGPoint(x: 8.5, y: 19)); stroke(next)
            case .person:
                var person = Path()
                person.addEllipse(in: CGRect(x: 8.4, y: 3, width: 7.2, height: 7.2))
                person.move(to: CGPoint(x: 4, y: 20.5))
                person.addCurve(to: CGPoint(x: 20, y: 20.5), control1: CGPoint(x: 4, y: 14), control2: CGPoint(x: 20, y: 14))
                stroke(person)
            case .mic:
                var mic = Path(roundedRect: CGRect(x: 9, y: 2.8, width: 6, height: 11), cornerRadius: 3)
                mic.move(to: CGPoint(x: 5.5, y: 10.5)); mic.addCurve(to: CGPoint(x: 18.5, y: 10.5), control1: CGPoint(x: 5.5, y: 18.8), control2: CGPoint(x: 18.5, y: 18.8))
                mic.move(to: CGPoint(x: 12, y: 17)); mic.addLine(to: CGPoint(x: 12, y: 21)); mic.move(to: CGPoint(x: 9, y: 21)); mic.addLine(to: CGPoint(x: 15, y: 21))
                stroke(mic)
            case .send:
                var send = Path()
                send.move(to: CGPoint(x: 12, y: 3)); send.addLine(to: CGPoint(x: 20.5, y: 20)); send.addLine(to: CGPoint(x: 12, y: 16.5)); send.addLine(to: CGPoint(x: 3.5, y: 20)); send.closeSubpath()
                send.move(to: CGPoint(x: 12, y: 16.5)); send.addLine(to: CGPoint(x: 12, y: 9))
                fill(send)
            case .document:
                var page = Path(); page.move(to: CGPoint(x: 6, y: 3.5)); page.addLine(to: CGPoint(x: 14, y: 3.5)); page.addLine(to: CGPoint(x: 18, y: 7.5)); page.addLine(to: CGPoint(x: 18, y: 20)); page.addLine(to: CGPoint(x: 6, y: 20)); page.closeSubpath()
                page.move(to: CGPoint(x: 14, y: 3.5)); page.addLine(to: CGPoint(x: 14, y: 7.5)); page.addLine(to: CGPoint(x: 18, y: 7.5))
                page.move(to: CGPoint(x: 9, y: 12)); page.addLine(to: CGPoint(x: 15, y: 12)); page.move(to: CGPoint(x: 9, y: 16)); page.addLine(to: CGPoint(x: 15, y: 16)); stroke(page)
            case .text:
                var text = Path()
                text.move(to: CGPoint(x: 4, y: 6)); text.addLine(to: CGPoint(x: 20, y: 6))
                text.move(to: CGPoint(x: 12, y: 6)); text.addLine(to: CGPoint(x: 12, y: 19))
                stroke(text)
            case .download:
                var download = Path()
                download.move(to: CGPoint(x: 12, y: 3)); download.addLine(to: CGPoint(x: 12, y: 15))
                download.move(to: CGPoint(x: 7, y: 10)); download.addLine(to: CGPoint(x: 12, y: 15)); download.addLine(to: CGPoint(x: 17, y: 10))
                download.move(to: CGPoint(x: 5, y: 18)); download.addLine(to: CGPoint(x: 5, y: 21)); download.addLine(to: CGPoint(x: 19, y: 21)); download.addLine(to: CGPoint(x: 19, y: 18))
                stroke(download)
            case .moon:
                let outerMoon = Path(ellipseIn: CGRect(x: 2.4, y: 2.4, width: 19.2, height: 19.2))
                let innerMoon = Path(ellipseIn: CGRect(x: 9.8, y: -4.8, width: 19.2, height: 19.2))
                fill(outerMoon.subtracting(innerMoon))
            case .refresh:
                var refresh = Path(); refresh.move(to: CGPoint(x: 20, y: 7)); refresh.addLine(to: CGPoint(x: 20, y: 12)); refresh.addLine(to: CGPoint(x: 15, y: 12)); refresh.move(to: CGPoint(x: 19, y: 12)); refresh.addArc(center: CGPoint(x: 12, y: 12), radius: 7, startAngle: .degrees(0), endAngle: .degrees(250), clockwise: false); stroke(refresh)
            case .photo:
                var image = Path(roundedRect: CGRect(x: 3, y: 4, width: 18, height: 16), cornerRadius: 2)
                image.addEllipse(in: CGRect(x: 7, y: 7, width: 3, height: 3))
                image.move(to: CGPoint(x: 4.5, y: 17)); image.addLine(to: CGPoint(x: 9, y: 12)); image.addLine(to: CGPoint(x: 12, y: 15)); image.addLine(to: CGPoint(x: 15, y: 11)); image.addLine(to: CGPoint(x: 20, y: 17))
                stroke(image)
            case .camera:
                var camera = Path(roundedRect: CGRect(x: 3, y: 7, width: 18, height: 14), cornerRadius: 3)
                camera.move(to: CGPoint(x: 8, y: 7)); camera.addLine(to: CGPoint(x: 10, y: 4)); camera.addLine(to: CGPoint(x: 15, y: 4)); camera.addLine(to: CGPoint(x: 17, y: 7))
                camera.addEllipse(in: CGRect(x: 9, y: 10, width: 6, height: 6))
                stroke(camera)
            case .more:
                fill(Path(ellipseIn: CGRect(x: 4, y: 10, width: 4, height: 4)))
                fill(Path(ellipseIn: CGRect(x: 10, y: 10, width: 4, height: 4)))
                fill(Path(ellipseIn: CGRect(x: 16, y: 10, width: 4, height: 4)))
            case .play:
                var play = Path(); play.move(to: CGPoint(x: 7, y: 4)); play.addLine(to: CGPoint(x: 20, y: 12)); play.addLine(to: CGPoint(x: 7, y: 20)); play.closeSubpath(); fill(play)
            case .pause:
                fill(Path(roundedRect: CGRect(x: 5, y: 4, width: 5, height: 16), cornerRadius: 1.5))
                fill(Path(roundedRect: CGRect(x: 14, y: 4, width: 5, height: 16), cornerRadius: 1.5))
            case .stop:
                fill(Path(roundedRect: CGRect(x: 5, y: 5, width: 14, height: 14), cornerRadius: 2))
            case .wave:
                var wave = Path()
                let bars: [(CGFloat, CGFloat)] = [(5, 5), (8, 10), (11, 15), (14, 8), (17, 13), (20, 6)]
                for (x, height) in bars { wave.move(to: CGPoint(x: x, y: 12 - height / 2)); wave.addLine(to: CGPoint(x: x, y: 12 + height / 2)) }
                stroke(wave)
            case .alert:
                var alert = Path(ellipseIn: CGRect(x: 2.5, y: 2.5, width: 19, height: 19))
                alert.move(to: CGPoint(x: 12, y: 7)); alert.addLine(to: CGPoint(x: 12, y: 13))
                alert.addEllipse(in: CGRect(x: 11.2, y: 16, width: 1.6, height: 1.6))
                stroke(alert)
            case .check:
                var check = Path(ellipseIn: CGRect(x: 2.5, y: 2.5, width: 19, height: 19))
                check.move(to: CGPoint(x: 7, y: 12)); check.addLine(to: CGPoint(x: 10.2, y: 15.2)); check.addLine(to: CGPoint(x: 17.5, y: 8))
                stroke(check)
            case .checkmark:
                var checkmark = Path()
                checkmark.move(to: CGPoint(x: 5, y: 12)); checkmark.addLine(to: CGPoint(x: 10, y: 17)); checkmark.addLine(to: CGPoint(x: 20, y: 7))
                stroke(checkmark)
            case .info:
                var info = Path(ellipseIn: CGRect(x: 2.5, y: 2.5, width: 19, height: 19))
                info.move(to: CGPoint(x: 12, y: 10)); info.addLine(to: CGPoint(x: 12, y: 16))
                info.addEllipse(in: CGRect(x: 11.2, y: 6.5, width: 1.6, height: 1.6))
                stroke(info)
            case .quote:
                var quote = Path()
                quote.move(to: CGPoint(x: 10, y: 6)); quote.addCurve(to: CGPoint(x: 5.5, y: 11), control1: CGPoint(x: 6.2, y: 6.5), control2: CGPoint(x: 5.5, y: 8.5))
                quote.addLine(to: CGPoint(x: 9, y: 11)); quote.addLine(to: CGPoint(x: 7, y: 16))
                quote.move(to: CGPoint(x: 19, y: 6)); quote.addCurve(to: CGPoint(x: 14.5, y: 11), control1: CGPoint(x: 15.2, y: 6.5), control2: CGPoint(x: 14.5, y: 8.5))
                quote.addLine(to: CGPoint(x: 18, y: 11)); quote.addLine(to: CGPoint(x: 16, y: 16))
                stroke(quote)
            case .mindMap:
                var map = Path()
                map.move(to: CGPoint(x: 12, y: 12)); map.addLine(to: CGPoint(x: 5, y: 5))
                map.move(to: CGPoint(x: 12, y: 12)); map.addLine(to: CGPoint(x: 5, y: 19))
                map.move(to: CGPoint(x: 12, y: 12)); map.addLine(to: CGPoint(x: 19, y: 7))
                map.move(to: CGPoint(x: 12, y: 12)); map.addLine(to: CGPoint(x: 19, y: 17))
                stroke(map)
                for point in [CGPoint(x: 12, y: 12), CGPoint(x: 5, y: 5), CGPoint(x: 5, y: 19), CGPoint(x: 19, y: 7), CGPoint(x: 19, y: 17)] {
                    fill(Path(ellipseIn: CGRect(x: point.x - 1.7, y: point.y - 1.7, width: 3.4, height: 3.4)))
                }
            case .mail:
                var mail = Path(roundedRect: CGRect(x: 3, y: 5, width: 18, height: 14), cornerRadius: 2)
                mail.move(to: CGPoint(x: 4, y: 7)); mail.addLine(to: CGPoint(x: 12, y: 13)); mail.addLine(to: CGPoint(x: 20, y: 7)); stroke(mail)
            case .lock:
                var lock = Path(roundedRect: CGRect(x: 5.5, y: 10, width: 13, height: 11), cornerRadius: 2.2)
                lock.move(to: CGPoint(x: 8, y: 10)); lock.addLine(to: CGPoint(x: 8, y: 7)); lock.addCurve(to: CGPoint(x: 16, y: 7), control1: CGPoint(x: 8, y: 2.5), control2: CGPoint(x: 16, y: 2.5)); lock.addLine(to: CGPoint(x: 16, y: 10))
                lock.move(to: CGPoint(x: 12, y: 14)); lock.addLine(to: CGPoint(x: 12, y: 17)); stroke(lock)
            case .key:
                var key = Path(ellipseIn: CGRect(x: 3, y: 4, width: 11, height: 11))
                key.addEllipse(in: CGRect(x: 6.5, y: 7.5, width: 4, height: 4))
                key.move(to: CGPoint(x: 13, y: 9.5)); key.addLine(to: CGPoint(x: 21, y: 9.5)); key.addLine(to: CGPoint(x: 18.5, y: 12)); key.addLine(to: CGPoint(x: 21, y: 14.5)); key.addLine(to: CGPoint(x: 17, y: 14.5)); stroke(key)
            case .eye, .eyeSlash:
                var eye = Path()
                eye.move(to: CGPoint(x: 2, y: 12)); eye.addCurve(to: CGPoint(x: 22, y: 12), control1: CGPoint(x: 7, y: 3.5), control2: CGPoint(x: 17, y: 3.5))
                eye.addCurve(to: CGPoint(x: 2, y: 12), control1: CGPoint(x: 17, y: 20.5), control2: CGPoint(x: 7, y: 20.5))
                eye.addEllipse(in: CGRect(x: 9, y: 9, width: 6, height: 6))
                if kind == .eyeSlash { eye.move(to: CGPoint(x: 4, y: 4)); eye.addLine(to: CGPoint(x: 20, y: 20)) }
                stroke(eye)
            case .settings:
                var rails = Path()
                rails.move(to: CGPoint(x: 3.5, y: 6.5)); rails.addLine(to: CGPoint(x: 20.5, y: 6.5))
                rails.move(to: CGPoint(x: 3.5, y: 12)); rails.addLine(to: CGPoint(x: 20.5, y: 12))
                rails.move(to: CGPoint(x: 3.5, y: 17.5)); rails.addLine(to: CGPoint(x: 20.5, y: 17.5))
                stroke(rails)
                fill(Path(ellipseIn: CGRect(x: 7, y: 4, width: 5, height: 5)))
                fill(Path(ellipseIn: CGRect(x: 13, y: 9.5, width: 5, height: 5)))
                fill(Path(ellipseIn: CGRect(x: 6, y: 15, width: 5, height: 5)))
            case .history:
                var history = Path()
                history.move(to: CGPoint(x: 4, y: 9)); history.addArc(center: CGPoint(x: 12, y: 12), radius: 8, startAngle: .degrees(200), endAngle: .degrees(160), clockwise: false)
                history.move(to: CGPoint(x: 3, y: 4)); history.addLine(to: CGPoint(x: 3, y: 10)); history.addLine(to: CGPoint(x: 9, y: 10))
                history.move(to: CGPoint(x: 12, y: 7)); history.addLine(to: CGPoint(x: 12, y: 12)); history.addLine(to: CGPoint(x: 16, y: 14.5)); stroke(history)
            case .chat:
                var chat = Path(roundedRect: CGRect(x: 3, y: 4, width: 18, height: 14), cornerRadius: 4)
                chat.move(to: CGPoint(x: 7, y: 18)); chat.addLine(to: CGPoint(x: 5, y: 21)); chat.addLine(to: CGPoint(x: 11, y: 18))
                chat.move(to: CGPoint(x: 7, y: 9)); chat.addLine(to: CGPoint(x: 17, y: 9)); chat.move(to: CGPoint(x: 7, y: 13)); chat.addLine(to: CGPoint(x: 14, y: 13)); stroke(chat)
            case .logout:
                var logout = Path(roundedRect: CGRect(x: 4, y: 3, width: 9, height: 18), cornerRadius: 1.5)
                logout.move(to: CGPoint(x: 10, y: 12)); logout.addLine(to: CGPoint(x: 21, y: 12)); logout.move(to: CGPoint(x: 17, y: 8)); logout.addLine(to: CGPoint(x: 21, y: 12)); logout.addLine(to: CGPoint(x: 17, y: 16)); stroke(logout)
            case .shield:
                var shield = Path()
                shield.move(to: CGPoint(x: 12, y: 2.8)); shield.addLine(to: CGPoint(x: 20, y: 6)); shield.addLine(to: CGPoint(x: 20, y: 11)); shield.addCurve(to: CGPoint(x: 12, y: 21), control1: CGPoint(x: 20, y: 16), control2: CGPoint(x: 16, y: 19.5)); shield.addCurve(to: CGPoint(x: 4, y: 11), control1: CGPoint(x: 8, y: 19.5), control2: CGPoint(x: 4, y: 16)); shield.addLine(to: CGPoint(x: 4, y: 6)); shield.closeSubpath()
                shield.move(to: CGPoint(x: 8, y: 12)); shield.addLine(to: CGPoint(x: 10.5, y: 14.5)); shield.addLine(to: CGPoint(x: 16, y: 9)); stroke(shield)
            case .copy:
                var copy = Path(roundedRect: CGRect(x: 8, y: 7, width: 12, height: 14), cornerRadius: 1.5)
                copy.addPath(Path(roundedRect: CGRect(x: 4, y: 3, width: 12, height: 14), cornerRadius: 1.5)); stroke(copy)
            case .speaker:
                var speaker = Path()
                speaker.move(to: CGPoint(x: 3, y: 9)); speaker.addLine(to: CGPoint(x: 7, y: 9)); speaker.addLine(to: CGPoint(x: 13, y: 4)); speaker.addLine(to: CGPoint(x: 13, y: 20)); speaker.addLine(to: CGPoint(x: 7, y: 15)); speaker.addLine(to: CGPoint(x: 3, y: 15)); speaker.closeSubpath()
                speaker.move(to: CGPoint(x: 16, y: 9)); speaker.addCurve(to: CGPoint(x: 16, y: 15), control1: CGPoint(x: 20, y: 9), control2: CGPoint(x: 20, y: 15))
                speaker.move(to: CGPoint(x: 18, y: 6)); speaker.addCurve(to: CGPoint(x: 18, y: 18), control1: CGPoint(x: 23, y: 6), control2: CGPoint(x: 23, y: 18)); stroke(speaker)
            case .number:
                var number = Path()
                number.move(to: CGPoint(x: 8, y: 4)); number.addLine(to: CGPoint(x: 5, y: 20))
                number.move(to: CGPoint(x: 17, y: 4)); number.addLine(to: CGPoint(x: 14, y: 20))
                number.move(to: CGPoint(x: 3, y: 9)); number.addLine(to: CGPoint(x: 21, y: 9))
                number.move(to: CGPoint(x: 2, y: 15)); number.addLine(to: CGPoint(x: 20, y: 15)); stroke(number)
            }
        }
        .accessibilityHidden(true)
    }
}

struct AstellaAppHeader: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced
    @AppStorage("study.appearance.dark") private var darkMode = false
    var onAccount: () -> Void
    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            if store.selectedTab == .conversation {
                workspacePicker.frame(maxWidth: 112, alignment: .leading)
                Spacer(minLength: 1)
                HStack(spacing: 2) {
                    conversationSegment(records: false, title: "伴星")
                    conversationSegment(records: true, title: "记录")
                }
                .padding(3)
                .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: false))
                Spacer(minLength: 1)
            } else {
                Menu { workspaceMenuItems } label: {
                    HStack(spacing: 9) {
                        ZStack {
                            Ellipse().stroke(StudyPalette.accent.opacity(0.35), lineWidth: 0.9).frame(width: 35, height: 21).rotationEffect(.degrees(-35))
                            AstellaStar().fill(StudyPalette.accent).frame(width: 19, height: 24)
                        }.frame(width: 42, height: 42)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("伴星").font(.system(size: 17, weight: .semibold)).tracking(-0.4)
                            Text(store.profile?.workspaceName ?? "随身书房").font(.system(size: 12)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                        }
                    }
                }
                .buttonStyle(AstellaPressStyle())
                Spacer(minLength: 10)
            }
            if store.selectedTab == .conversation {
                Button { darkMode.toggle() } label: {
                    AstellaGlyph(kind: darkMode ? .sun : .moon, tint: StudyPalette.ink).frame(width: 18, height: 18)
                        .frame(width: 42, height: 42).modifier(StudyGlassSurfaceStyle(radius: 21, interactive: true))
                }.accessibilityLabel(darkMode ? "切换浅色外观" : "切换深色外观")
            } else {
                Button(action: onAccount) {
                    Text(profileInitial)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(StudyPalette.ink)
                        .frame(width: 46, height: 46)
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay(Circle().stroke(StudyPalette.paperEdge, lineWidth: 1))
                        .shadow(color: StudyPalette.ink.opacity(0.04), radius: 5, x: 0, y: 2)
                }.accessibilityLabel("我的账户")
            }
        }.foregroundStyle(StudyPalette.ink).buttonStyle(AstellaPressStyle())
            .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 8)
    }

    private var workspacePicker: some View {
        Menu { workspaceMenuItems } label: {
            HStack(spacing: 7) {
                Circle().fill(StudyPalette.accent).frame(width: 7, height: 7)
                Text(store.profile?.workspaceName ?? "随身书房")
                    .font(.system(size: 12, weight: .medium)).lineLimit(1).minimumScaleFactor(0.84)
                if store.workspaces.count > 1 { AstellaGlyph(kind: .chevron, tint: StudyPalette.muted).frame(width: 10, height: 10) }
            }.foregroundStyle(StudyPalette.ink).frame(minHeight: 42, alignment: .leading)
        }
        .buttonStyle(AstellaPressStyle())
        .disabled(store.workspaces.count < 2)
        .accessibilityLabel("选择书房")
    }

    @ViewBuilder private var workspaceMenuItems: some View {
        ForEach(store.workspaces) { workspace in
            Button {
                Task { await store.switchWorkspace(workspace) }
            } label: {
                HStack(spacing: 9) {
                    if workspace.id == store.profile?.workspaceId {
                        AstellaStar().fill(StudyPalette.accent).frame(width: 13, height: 17)
                    }
                    Text(workspace.name)
                }
            }
        }
    }

    private func conversationSegment(records: Bool, title: String) -> some View {
        let selected = store.chatShowsRecords == records
        return Button {
            withAnimation(Motion.gated(reduced || store.localReduceMotion, Motion.segment)) {
                store.setChatShowsRecords(records)
            }
        } label: {
            Text(title).font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? StudyPalette.ink : StudyPalette.muted)
                .frame(width: 57, height: 33)
                .background {
                    if selected { Capsule().fill(StudyPalette.paper.opacity(0.9)).matchedGeometryEffect(id: "header-segment", in: headerNamespace) }
                }
        }
        .buttonStyle(AstellaPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    @Namespace private var headerNamespace

    private var profileInitial: String {
        let displayName = store.profile?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let first = displayName.first { return String(first).uppercased() }
        if let first = store.profile?.email.first { return String(first).uppercased() }
        return "S"
    }
}

struct AstellaDetailHeader: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var body: some View {
        HStack(spacing: 15) {
            Button { dismiss() } label: {
                AstellaGlyph(kind: .back, tint: StudyPalette.ink)
                    .frame(width: 19, height: 19)
                    .frame(width: 44, height: 44)
                    .modifier(StudyGlassSurfaceStyle(radius: 22, interactive: true))
            }
            .accessibilityLabel("返回")

            Text(title)
                .font(.system(size: 32, weight: .bold))
                .tracking(-0.9)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .foregroundStyle(StudyPalette.ink)
            Spacer(minLength: 0)
        }
        .foregroundStyle(StudyPalette.ink)
        .buttonStyle(AstellaRoundPressStyle())
        .padding(.horizontal, 22)
        .padding(.top, 8)
        // Keep the content inset stable while placing the visible header on
        // the same baseline as the OpenDesign mobile frames.
        .frame(height: 82, alignment: .top)
    }
}


/// Companion speech bubble used by permission / authorization / convention pages:
/// the avatar sits outside a quiet paper card, matching the OpenDesign frames.
struct CompanionBubbleRow: View {
    var text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image("CompanionAvatar")
                .resizable()
                .scaledToFill()
                .frame(width: 34, height: 34)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.85), lineWidth: 0.8))
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 14))
                .lineSpacing(4)
                .foregroundStyle(StudyPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StudyPalette.paper.opacity(0.86), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(.white.opacity(0.85), lineWidth: 0.8)
                }
                .shadow(color: StudyPalette.ink.opacity(0.04), radius: 8, x: 0, y: 3)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Small status pill + optional action pill used by the permissions group.
struct SettingsStatusPill: View {
    var text: String
    var color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .frame(minHeight: 24)
            .background(color.opacity(0.13), in: Capsule())
    }
}

struct AstellaToggleStyle: ToggleStyle {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced

    private var motionDisabled: Bool { reduced || store.localReduceMotion }

    func makeBody(configuration: Configuration) -> some View {
        Button { withAnimation(Motion.gated(motionDisabled, Motion.press)) { configuration.isOn.toggle() } } label: {
            HStack(spacing: 16) {
                configuration.label.foregroundStyle(StudyPalette.ink).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule().fill(configuration.isOn ? StudyPalette.accent : StudyPalette.paperEdge)
                    Circle().fill(StudyPalette.paper).frame(width: 20, height: 20).padding(4)
                }.frame(width: 46, height: 28)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityValue(configuration.isOn ? "已开启" : "已关闭")
            .accessibilityAddTraits(.isButton)
    }
}

struct AstellaCompactActionStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .medium)).padding(.horizontal, 15).frame(minHeight: 44)
            .foregroundStyle(primary ? StudyPalette.paper : StudyPalette.accent)
            .background(primary ? StudyPalette.accent : StudyPalette.sky, in: RoundedRectangle(cornerRadius: 12))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}
