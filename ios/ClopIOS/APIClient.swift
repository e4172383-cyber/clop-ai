import CryptoKit
import Foundation
import UIKit

enum ClopAPIError: LocalizedError {
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Сервер вернул некорректный ответ."
        case .server(let message): return message
        }
    }
}

struct APIClient {
    static let shared = APIClient()
    static let baseURL = URL(string: "https://clop.195-201-169-74.sslip.io")!

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func startPairing(code: String, secretHash: String) async throws -> PairInitResponse {
        let device = await UIDevice.current.name
        return try await request(
            "/desk/init",
            method: "POST",
            body: PairStartBody(code: code, secretHash: secretHash, device: "iPhone · \(device)"),
            token: nil
        )
    }

    func pollPairing(code: String, secret: String) async throws -> PairPollResponse {
        try await request("/desk/poll", method: "POST", body: PairPollBody(code: code, secret: secret), token: nil)
    }

    func profile(token: String) async throws -> UserProfile {
        try await request("/desk/me", token: token)
    }

    func updateProfile(token: String, model: String?, effort: String?, fast: Bool?) async throws -> ProfileUpdateResponse {
        try await request(
            "/desk/profile",
            method: "POST",
            body: ProfileBody(model: model, effort: effort, fast: fast),
            token: token
        )
    }

    func chat(token: String, text: String, model: String, effort: String, fast: Bool, chatID: String?) async throws -> ChatResponse {
        try await request(
            "/desk/chat",
            method: "POST",
            body: ChatBody(text: text, model: model, effort: effort, fast: fast, chatId: chatID),
            token: token,
            timeout: 600
        )
    }

    func storage(token: String) async throws -> CloudSummary {
        try await request("/desk/storage", token: token)
    }

    func upload(token: String, name: String, mime: String, data: Data) async throws -> CloudSummary {
        try await request(
            "/desk/storage/upload",
            method: "POST",
            body: UploadBody(name: name, mime: mime, kind: mime.hasPrefix("image/") ? "photo" : "file", data: data.base64EncodedString()),
            token: token,
            timeout: 180
        )
    }

    func delete(token: String, id: String) async throws -> CloudSummary {
        try await request("/desk/storage/delete", method: "POST", body: IdentifierBody(id: id), token: token)
    }

    func optimize(token: String) async throws -> CloudSummary {
        try await request("/desk/storage/optimize", method: "POST", body: EmptyBody(), token: token)
    }

    func backup(token: String) async throws -> CloudSummary {
        try await request("/desk/storage/backup", method: "POST", body: EmptyBody(), token: token)
    }

    func logout(token: String) async throws {
        let _: BasicResponse = try await request("/desk/logout", method: "POST", body: EmptyBody(), token: token)
    }

    private func request<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil,
        token: String?,
        timeout: TimeInterval = 60
    ) async throws -> Response {
        var request = URLRequest(url: Self.baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Clop-iOS/1.0", forHTTPHeaderField: "User-Agent")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try encoder.encode(AnyEncodable(body))
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClopAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(APIErrorEnvelope.self, from: data).error)
            throw ClopAPIError.server(message ?? "Ошибка сервера \(http.statusCode).")
        }
        do { return try decoder.decode(Response.self, from: data) }
        catch { throw ClopAPIError.invalidResponse }
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init(_ value: any Encodable) {
        encodeValue = { encoder in try value.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

private struct PairStartBody: Encodable { let code: String; let secretHash: String; let device: String }
private struct PairPollBody: Encodable { let code: String; let secret: String }
private struct ProfileBody: Encodable { let model: String?; let effort: String?; let fast: Bool? }
private struct ChatBody: Encodable { let text: String; let model: String; let effort: String; let fast: Bool; let chatId: String? }
private struct UploadBody: Encodable { let name: String; let mime: String; let kind: String; let data: String }
private struct IdentifierBody: Encodable { let id: String }
private struct EmptyBody: Encodable {}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum PairingCrypto {
    static func make() -> (code: String, secret: String, hash: String) {
        let codeBytes = random(count: 8)
        let secret = random(count: 32).base64URLEncodedString()
        let digest = Data(SHA256.hash(data: Data(secret.utf8))).base64URLEncodedString()
        return (codeBytes.map { String(format: "%02x", $0) }.joined(), secret, digest)
    }

    private static func random(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let result = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(result == errSecSuccess)
        return Data(bytes)
    }
}
