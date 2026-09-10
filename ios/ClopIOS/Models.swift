import Foundation

struct APIErrorEnvelope: Decodable {
    let ok: Bool?
    let error: String?
}

struct PairInitResponse: Decodable {
    let ok: Bool
    let bot: String?
}

struct PairPollResponse: Decodable {
    struct User: Decodable {
        let name: String
        let plan: String
    }

    let ok: Bool
    let pending: Bool?
    let token: String?
    let user: User?
    let error: String?
}

struct ClopModel: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let title: String
    let provider: String
    let description: String
    let available: Bool
    let plans: [String]?
    let supportsEffort: Bool?
}

struct EffortOption: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let title: String
}

struct UserProfile: Decodable {
    let ok: Bool
    let name: String
    let plan: String
    let planKey: String
    let models: [ClopModel]
    let model: String
    let efforts: [EffortOption]
    let effort: String
    let fast: Bool
}

struct ProfileUpdateResponse: Decodable {
    let ok: Bool
    let model: String
    let effort: String
    let fast: Bool
}

struct ChatResponse: Decodable {
    let ok: Bool
    let text: String?
    let chatId: String?
    let model: String?
    let tokens: TokenUsage?
    let durationMs: Double?
    let error: String?
}

struct TokenUsage: Decodable {
    let input: Int?
    let output: Int?
    let total: Int?
    let billable: Int?
}

struct CloudFile: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let mime: String
    let kind: String
    let size: Int64
    let createdAt: Double
    let downloadUrl: String?
}

struct CloudSummary: Decodable {
    let ok: Bool
    let quotaBytes: Int64
    let usedBytes: Int64
    let freeBytes: Int64
    let percent: Double
    let maxFileBytes: Int64
    let files: [CloudFile]
}

struct BasicResponse: Decodable {
    let ok: Bool
}

struct ChatMessage: Identifiable, Equatable {
    enum Role: Equatable { case user, assistant }

    let id = UUID()
    let role: Role
    let text: String
    var meta: String?
}
