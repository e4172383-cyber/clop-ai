import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ClopMark(size: 52)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(session.profile?.name ?? "Clop").font(.headline)
                            Text(session.profile?.plan ?? "").foregroundStyle(ClopTheme.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }

                Section("Модель") {
                    Picker("Модель", selection: $session.selectedModel) {
                        ForEach(session.profile?.models.filter(\.available) ?? []) { model in
                            Text(model.title).tag(model.key)
                        }
                    }
                    Picker("Рассуждение", selection: $session.selectedEffort) {
                        ForEach(session.profile?.efforts ?? []) { effort in
                            Text(effort.title).tag(effort.key)
                        }
                    }
                    Toggle("Быстрый режим", isOn: $session.fast)
                }
                .onChange(of: session.selectedModel) { _ in Task { await session.applyProfile() } }
                .onChange(of: session.selectedEffort) { _ in Task { await session.applyProfile() } }
                .onChange(of: session.fast) { _ in Task { await session.applyProfile() } }

                Section("Приложение") {
                    LabeledContent("Версия", value: "1.0.0 Beta")
                    LabeledContent("Подключение", value: "Clop API")
                }

                Section {
                    Button("Выйти из аккаунта", role: .destructive) {
                        Task { await session.logout() }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ClopTheme.background)
            .navigationTitle("Профиль")
        }
    }
}

