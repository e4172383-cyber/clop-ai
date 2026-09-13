import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            ClopTheme.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 26) {
                Spacer()
                ClopMark(size: 66)
                VStack(alignment: .leading, spacing: 11) {
                    Text("ОДИН АККАУНТ НА ВСЕХ УСТРОЙСТВАХ")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.8)
                        .foregroundStyle(ClopTheme.orange)
                    Text("Clop для iPhone")
                        .font(.system(size: 33, weight: .semibold))
                        .tracking(-1.3)
                    Text("Нативный чат, модели и ваше облако")
                        .font(.system(size: 15))
                        .foregroundStyle(ClopTheme.secondary)
                }

                ClopCard {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Единый аккаунт Clop", systemImage: "checkmark.shield.fill")
                            .font(.headline)
                        Text("Подтвердите вход в Telegram. Пароль и ключи моделей не передаются приложению.")
                            .font(.subheadline)
                            .foregroundStyle(ClopTheme.secondary)

                        if let url = session.pairingURL {
                            Button {
                                openURL(url)
                            } label: {
                                Label("Открыть Telegram", systemImage: "paperplane.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)

                            HStack(spacing: 10) {
                                ProgressView().tint(ClopTheme.orange)
                                Text("Жду подтверждение в боте…")
                                    .font(.footnote)
                                    .foregroundStyle(ClopTheme.secondary)
                            }
                        } else {
                            Button {
                                Task {
                                    await session.beginPairing()
                                    if let url = session.pairingURL { openURL(url) }
                                }
                            } label: {
                                HStack {
                                    if session.isLoading { ProgressView().tint(.white) }
                                    else { Image(systemName: "paperplane.fill") }
                                    Text("Войти через Telegram")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                            .disabled(session.isLoading)
                        }
                    }
                }
                Spacer()
                Text("Clop iOS Beta 1.0")
                    .font(.caption)
                    .foregroundStyle(ClopTheme.secondary)
                    .padding(.bottom, 12)
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 25)
        }
    }
}

