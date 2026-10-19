import SwiftUI
import WebKit

struct LaunchMotionWebView: UIViewRepresentable {
    let dark: Bool
    let reduced: Bool
    let active: Bool
    let ready: Bool
    let target: CGRect?
    let onPreparing: () -> Void
    let onRendered: () -> Void
    let onFinished: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "astellaMotion")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isUserInteractionEnabled = false
        view.navigationDelegate = context.coordinator
        context.coordinator.webView = view
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "LaunchMotion") {
            context.coordinator.resourceRoot = url.deletingLastPathComponent()
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            DispatchQueue.main.async { onFinished() }
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.sendConfiguration()
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.ended = true
        uiView.evaluateJavaScript("window.AstellaLaunch?.destroy()", completionHandler: nil)
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "astellaMotion")
        uiView.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: LaunchMotionWebView
        weak var webView: WKWebView?
        var resourceRoot: URL?
        var bridgeReady = false
        var ended = false
        private var lastPayload: String?
        private let createdAt = ProcessInfo.processInfo.systemUptime

        init(_ parent: LaunchMotionWebView) { self.parent = parent }

        func sendConfiguration() {
            guard bridgeReady, !ended, let view = webView else { return }
            var payload: [String: Any] = ["dark": parent.dark, "reduced": parent.reduced,
                                          "active": parent.active, "ready": parent.ready]
            if lastPayload == nil { payload["elapsed"] = ProcessInfo.processInfo.systemUptime - createdAt }
            if let global = parent.target, !global.isEmpty {
                let rect = view.convert(global, from: nil)
                payload["target"] = ["x": rect.minX, "y": rect.minY, "width": rect.width,
                                     "height": rect.height, "scaleX": 1.08]
            } else { payload["target"] = NSNull() }
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                  let json = String(data: data, encoding: .utf8), json != lastPayload else { return }
            lastPayload = json
            view.evaluateJavaScript("window.AstellaLaunch?.update(\(json))") { [weak self] _, error in
                if error != nil { self?.finish() }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !ended, message.frameInfo.isMainFrame,
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            #if DEBUG
            print("AstellaLaunch \(type)")
            #endif
            switch type {
            case "bridgeReady": bridgeReady = true; parent.onPreparing(); sendConfiguration()
            case "rendered": parent.onRendered()
            case "landed", "failed": finish()
            default: break
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { sendConfiguration() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish() }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = navigationAction.request.url.map { url in
                url.isFileURL && resourceRoot.map { url.standardizedFileURL.path.hasPrefix($0.standardizedFileURL.path + "/") } == true
            } ?? false
            decisionHandler(allowed ? .allow : .cancel)
        }

        private func finish() {
            guard !ended else { return }
            ended = true
            parent.onFinished()
        }
    }
}
