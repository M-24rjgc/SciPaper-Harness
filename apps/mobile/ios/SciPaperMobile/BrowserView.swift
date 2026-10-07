import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct BrowserView: UIViewRepresentable {
    let url: URL
    let onDisconnect: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(origin: ConnectionPolicy.origin(url)!, onDisconnect: onDisconnect) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isInspectable = false
        context.coordinator.web = web
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return web
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let origin: String
        let onDisconnect: () -> Void
        weak var web: WKWebView?
        var destinations: [ObjectIdentifier: URL] = [:]

        init(origin: String, onDisconnect: @escaping () -> Void) {
            self.origin = origin
            self.onDisconnect = onDisconnect
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == false && ConnectionPolicy.ownedBlob(url, origin) {
                decisionHandler(.allow)
            } else if ConnectionPolicy.sameOrigin(url, origin) {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
            } else {
                decisionHandler(.cancel)
                if action.navigationType == .linkActivated, let safe = ConnectionPolicy.remoteHTTPS(url.absoluteString) {
                    UIApplication.shared.open(safe)
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard let url = response.response.url,
                  ConnectionPolicy.sameOrigin(url, origin) || (!response.isForMainFrame && ConnectionPolicy.ownedBlob(url, origin)) else {
                decisionHandler(.cancel); return
            }
            if response.isForMainFrame, let status = (response.response as? HTTPURLResponse)?.statusCode, status >= 400 {
                decisionHandler(.cancel)
                showConnectionError(message: status == 401 || status == 403
                    ? "连接链接已失效，或访问已被撤销。请在电脑上生成新链接。"
                    : "连接请求未完成。请重试，或使用电脑生成的新连接链接。")
                return
            }
            let attachment = (response.response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
            decisionHandler(response.canShowMIMEType && !attachment ? .allow : .download)
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            completionHandler(.performDefaultHandling, nil)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showConnectionError()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showConnectionError()
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = action.request.url else { return nil }
            if ConnectionPolicy.sameOrigin(url, origin) { webView.load(action.request) }
            else if let safe = ConnectionPolicy.remoteHTTPS(url.absoluteString) { UIApplication.shared.open(safe) }
            return nil
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            guard let url = response.url, ConnectionPolicy.sameOrigin(url, origin) else { completionHandler(nil); return }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
                let target = folder.appendingPathComponent(name.isEmpty ? "download" : name)
                destinations[ObjectIdentifier(download)] = target
                completionHandler(target)
            } catch { completionHandler(nil) }
        }

        func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                      newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
            decisionHandler(request.url.map { ConnectionPolicy.sameOrigin($0, origin) } == true ? .allow : .cancel)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let target = destinations.removeValue(forKey: ObjectIdentifier(download)), let host = presenter() else { return }
            let share = UIActivityViewController(activityItems: [target], applicationActivities: nil)
            share.popoverPresentationController?.sourceView = web
            host.present(share, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
        }

        private func showConnectionError(message: String = "请确认电脑在线，并检查手机网络。") {
            guard let host = presenter(), host.presentedViewController == nil else { return }
            let alert = UIAlertController(title: NSLocalizedString("暂时无法连接电脑", comment: "Connection failure"),
                message: NSLocalizedString(message, comment: "Connection failure explanation"), preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: NSLocalizedString("重试", comment: "Retry"), style: .default) { [weak self] _ in
                guard let self, let target = URL(string: self.origin + "/") else { return }
                self.web?.load(URLRequest(url: target))
            })
            alert.addAction(UIAlertAction(title: NSLocalizedString("重新连接", comment: "Connect again"), style: .cancel) { [weak self] _ in self?.onDisconnect() })
            host.present(alert, animated: true)
        }

        private func presenter() -> UIViewController? {
            var parent = web?.window?.rootViewController
            while let next = parent?.presentedViewController { parent = next }
            return parent
        }
    }
}
