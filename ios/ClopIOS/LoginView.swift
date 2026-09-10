import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            ClopTheme.background.ignoresSafeArea()
            Circle()
                .fill(ClopTheme.orange.opacity(0.12))
                .frame(width: 330, height: 330)
                .blur(radius: 70)
                .offset(y: -260)

            VStack(spacing: 24) {
                Spacer()
                ClopMark(size: 84)
                VStack(spacing: 8) {
                    Text("Clop для iPhone")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                    Text("Нативный чат, модели и ваше облако")
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
                .padding(.horizontal, 20)
                Spacer()
                Text("Clop iOS Beta 1.0")
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.35))
                    .padding(.bottom, 12)
            }
        }
    }
}

