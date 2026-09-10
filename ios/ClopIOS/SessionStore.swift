import Foundation

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var token: String?
    @Published private(set) var profile: UserProfile?
    @Published var selectedModel = ""
    @Published var selectedEffort = ""
    @Published var fast = false
    @Published var isLoading = false
    @Published var pairingURL: URL?
    @Published var errorMessage: String?

    private var pairingTask: Task<Void, Never>?

    var isSignedIn: Bool { token != nil && profile != nil }

    func restoreSession() async {
        guard token == nil, let stored = KeychainStore.readToken() else { return }
        token = stored
        do { try await refreshProfile() }
        catch { clearSession(); errorMessage = "Войдите снова — доступ устройства завершён." }
    }

    func beginPairing() async {
        pairingTask?.cancel()
        isLoading = true
        errorMessage = nil
        pairingURL = nil
        let pair = PairingCrypto.make()
        do {
            let response = try await APIClient.shared.startPairing(code: pair.code, secretHash: pair.hash)
            guard response.ok, let bot = response.bot, !bot.isEmpty else {
                throw ClopAPIError.server("Не удалось начать вход.")
            }
            pairingURL = URL(string: "https://t.me/\(bot)?start=desk_\(pair.code)")
            isLoading = false
            pairingTask = Task { [weak self] in
                await self?.poll(code: pair.code, secret: pair.secret)
            }
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    func refreshProfile() async throws {
        guard let token else { return }
        let value = try await APIClient.shared.profile(token: token)
        profile = value
        selectedModel = value.model
        selectedEffort = value.effort
        fast = value.fast
    }

    func applyProfile() async {
        guard let token else { return }
        do {
            _ = try await APIClient.shared.updateProfile(
                token: token,
                model: selectedModel,
                effort: selectedEffort,
                fast: fast
            )
            try await refreshProfile()
        } catch { errorMessage = error.localizedDescription }
    }

    func logout() async {
        pairingTask?.cancel()
        if let token { try? await APIClient.shared.logout(token: token) }
        clearSession()
    }

    private func poll(code: String, secret: String) async {
        let deadline = Date().addingTimeInterval(600)
        while !Task.isCancelled && Date() < deadline {
            do {
                let response = try await APIClient.shared.pollPairing(code: code, secret: secret)
                if response.ok, let newToken = response.token {
                    KeychainStore.saveToken(newToken)
                    token = newToken
                    pairingURL = nil
                    try await refreshProfile()
                    return
                }
                if response.pending != true, let message = response.error {
                    throw ClopAPIError.server(message)
                }
            } catch {
                errorMessage = error.localizedDescription
                pairingURL = nil
                return
            }
            try? await Task.sleep(for: .seconds(2))
        }
        if !Task.isCancelled {
            pairingURL = nil
            errorMessage = "Код входа истёк. Запустите вход ещё раз."
        }
    }

    private func clearSession() {
        KeychainStore.deleteToken()
        token = nil
        profile = nil
        selectedModel = ""
        selectedEffort = ""
        pairingURL = nil
    }
}

