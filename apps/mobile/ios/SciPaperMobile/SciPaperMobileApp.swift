import SwiftUI

@main
struct SciPaperMobileApp: App {
    var body: some Scene { WindowGroup { ConnectionView() } }
}

struct ConnectionView: View {
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("recentOrigin") private var recentOrigin = ""
    @State private var pairingLink = ""
    @State private var connection: URL?
    @State private var connectionID = UUID()
    @State private var error = ""
    private var dark: Bool { colorScheme == .dark }
    private var teal: Color { dark ? Color(red: 123 / 255, green: 196 / 255, blue: 187 / 255)
        : Color(red: 21 / 255, green: 99 / 255, blue: 95 / 255) }
    private var paper: Color { dark ? Color(red: 28 / 255, green: 33 / 255, blue: 31 / 255)
        : Color(red: 250 / 255, green: 249 / 255, blue: 246 / 255) }
    private var inputFill: Color { dark ? Color(red: 44 / 255, green: 50 / 255, blue: 46 / 255) : .white }
    private var ink: Color { dark ? Color(red: 249 / 255, green: 250 / 255, blue: 251 / 255)
        : Color(red: 28 / 255, green: 28 / 255, blue: 25 / 255) }
    private var muted: Color { dark ? Color(red: 182 / 255, green: 186 / 255, blue: 178 / 255)
        : Color(red: 104 / 255, green: 103 / 255, blue: 95 / 255) }
    private var errorInk: Color { dark ? Color(red: 233 / 255, green: 154 / 255, blue: 114 / 255) : .red }

    var body: some View {
        Group {
            if let url = connection {
                let activeConnectionID = connectionID
                NavigationStack {
                    BrowserView(url: url, onDisconnect: {
                        if connectionID == activeConnectionID { connection = nil }
                    }, onCleanNavigation: { cleanURL in
                        if connectionID == activeConnectionID { connection = cleanURL }
                    })
                        .id(connectionID)
                        .navigationTitle("SciPaper").navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .navigationBarLeading) {
                                Button("电脑") { connection = nil }.tint(teal)
                            }
                        }
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ResearchMark().stroke(teal, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                            .frame(width: 64, height: 64)
                        Text("SciPaper").font(.largeTitle.weight(.medium)).foregroundStyle(ink)
                        Text("随时继续你的研究").font(.title3).foregroundStyle(muted)
                        Text("连接电脑").font(.title2.weight(.medium)).foregroundStyle(ink).padding(.top, 20)
                        Text("在电脑的手机连接页面生成链接，然后在这里粘贴。电脑保持在线时，可查看会话、研究进度和文件。")
                            .foregroundStyle(muted)
                        TextField("HTTPS 连接链接", text: $pairingLink)
                            .keyboardType(.URL).textContentType(.URL)
                            .autocorrectionDisabled().textInputAutocapitalization(.never)
                            .foregroundStyle(ink)
                            .padding(16).background(inputFill, in: RoundedRectangle(cornerRadius: 14))
                        if !error.isEmpty { Text(error).foregroundStyle(errorInk).font(.subheadline) }
                        Button("连接") { connect(pairingLink) }
                            .frame(maxWidth: .infinity).buttonStyle(.borderedProminent).tint(teal)
                            .foregroundStyle(dark ? paper : Color.white)
                        if !recentOrigin.isEmpty {
                            Text("最近连接").font(.subheadline).foregroundStyle(muted).padding(.top, 16)
                            Button(recentOrigin) { connect(recentOrigin + "/") }.tint(teal)
                            Button("移除最近连接") { recentOrigin = "" }.tint(teal)
                        }
                    }.padding(28)
                }.background(paper)
            }
        }
        .onOpenURL { link in
            guard link.scheme == "scipaper", link.host == "connect",
                  let parts = URLComponents(url: link, resolvingAgainstBaseURL: false),
                  let target = parts.queryItems?.first(where: { $0.name == "url" })?.value else { return }
            connect(target)
        }
    }

    private func connect(_ value: String) {
        guard let url = ConnectionPolicy.remoteHTTPS(value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let origin = ConnectionPolicy.origin(url) else {
            error = NSLocalizedString("请输入有效的远程 HTTPS 连接链接，不能使用本机回环地址。", comment: "Connection validation")
            return
        }
        pairingLink = ""
        error = ""
        recentOrigin = origin
        // Each accepted link owns a new WebView, navigation policy and history.
        connectionID = UUID()
        connection = url
    }
}

struct ResearchMark: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 108
        let sy = rect.height / 108
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * sx, y: y * sy) }
        var path = Path()
        path.move(to: point(44, 29)); path.addLine(to: point(64, 29))
        path.move(to: point(47, 29)); path.addLine(to: point(47, 49)); path.addLine(to: point(31, 76))
        path.addQuadCurve(to: point(35, 82), control: point(28, 82)); path.addLine(to: point(73, 82))
        path.addQuadCurve(to: point(77, 76), control: point(80, 82)); path.addLine(to: point(61, 49)); path.addLine(to: point(61, 29))
        path.move(to: point(39, 64)); path.addLine(to: point(69, 64))
        path.addEllipse(in: CGRect(x: 48 * sx, y: 55 * sy, width: 2 * sx, height: 2 * sy))
        path.addEllipse(in: CGRect(x: 57 * sx, y: 71 * sy, width: 2 * sx, height: 2 * sy))
        return path
    }
}
