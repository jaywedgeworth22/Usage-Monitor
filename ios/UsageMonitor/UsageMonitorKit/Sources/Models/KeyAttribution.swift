import Foundation

public struct KeyAttributionSummary: Codable, Hashable, Sendable {
    public var matchedIdentities: Int?
    public var unattributedKeys: Int?
    public var monthCostUsd: Double?
    public var coverageDeclared: Double?
}

public struct KeyAttributionResponse: Codable, Hashable, Sendable {
    public var summary: KeyAttributionSummary?
    public var identities: [KeyAttributionIdentityLite]?
}

public struct KeyAttributionIdentityLite: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var displayName: String?
    public var projectName: String?
}
