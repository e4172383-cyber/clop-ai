import SwiftUI

@main
struct ClopIOSApp: App {
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
                .task { await session.restoreSession() }
        }
    }
}

