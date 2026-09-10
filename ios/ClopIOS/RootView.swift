import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        Group {
            if session.isSignedIn { MainTabView() }
            else { LoginView() }
        }
        .tint(ClopTheme.orange)
        .background(ClopTheme.background.ignoresSafeArea())
        .alert("Clop", isPresented: Binding(
            get: { session.errorMessage != nil },
            set: { if !$0 { session.errorMessage = nil } }
        )) {
            Button("Понятно", role: .cancel) { session.errorMessage = nil }
        } message: {
            Text(session.errorMessage ?? "")
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            ChatView()
                .tabItem { Label("Чат", systemImage: "bubble.left.and.bubble.right.fill") }
            CloudView()
                .tabItem { Label("Облако", systemImage: "icloud.fill") }
            ProfileView()
                .tabItem { Label("Профиль", systemImage: "person.crop.circle.fill") }
        }
        .toolbarBackground(ClopTheme.surface, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}

