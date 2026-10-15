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

struct AstellaAppHeader: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduced
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if store.selectedTab == .conversation && store.chatShowsRecords {
                Button { withAnimation(Motion.gated(reduced, Motion.segment)) { store.setChatShowsRecords(false) } } label: {
                    Image(systemName: "arrow.left").font(.system(size: 18)).frame(width: 42, height: 44)
                }.accessibilityLabel("回到伴星身边")
                Text("交流记录").font(.system(size: 20, weight: .semibold))
            } else {
                ZStack {
                    Ellipse().stroke(StudyPalette.accent.opacity(0.35), lineWidth: 0.8).frame(width: 30, height: 18).rotationEffect(.degrees(-35))
                    AstellaStar().fill(StudyPalette.accent).frame(width: 19, height: 25)
                }.frame(width: 38, height: 38).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("伴星").font(.system(size: 19, weight: .semibold)).tracking(-0.4)
                    Text(store.profile?.workspaceName ?? "随身书房").font(.system(size: 11)).foregroundStyle(StudyPalette.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 10)
            if store.selectedTab == .conversation && !store.chatShowsRecords {
                Button { withAnimation(Motion.gated(reduced, Motion.segment)) { store.setChatShowsRecords(true) } } label: {
                    Image(systemName: "text.bubble").font(.system(size: 19, weight: .light)).frame(width: 40, height: 44)
                }.accessibilityLabel("交流记录")
            }
            NavigationLink { AccountScreen().navigationTitle("") } label: {
                Text(String((store.profile?.displayName.isEmpty == false ? store.profile?.displayName : store.profile?.email)?.prefix(1) ?? "我").uppercased())
                    .font(.system(size: 13, weight: .semibold)).frame(width: 38, height: 38)
                    .modifier(StudyGlassSurfaceStyle(radius: 16, interactive: true))
            }.accessibilityLabel("我的账户")
        }.foregroundStyle(StudyPalette.ink).buttonStyle(AstellaPressStyle())
            .padding(.horizontal, 24).padding(.top, 6).padding(.bottom, 14)
    }
}

struct AstellaDetailHeader: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var body: some View {
        HStack {
            Button { dismiss() } label: { Image(systemName: "arrow.left").font(.system(size: 19)).frame(width: 44, height: 44) }.accessibilityLabel("返回")
            Text(title).font(.system(size: 14, weight: .medium))
            Spacer()
            AstellaStar().fill(StudyPalette.accent).frame(width: 14, height: 18).padding(.trailing, 14)
        }.foregroundStyle(StudyPalette.ink).buttonStyle(AstellaPressStyle()).padding(.horizontal, 14).background(StudyPalette.canvas)
    }
}


struct AstellaToggleStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduced
    func makeBody(configuration: Configuration) -> some View {
        Button { withAnimation(Motion.gated(reduced, Motion.press)) { configuration.isOn.toggle() } } label: {
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
