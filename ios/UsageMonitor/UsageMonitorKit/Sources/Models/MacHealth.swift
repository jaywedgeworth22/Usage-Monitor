import Foundation

/// `GET /api/health/mac` — latest Mac heartbeat (read token or dashboard session).
public struct MacHealthResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var status: String
    public var lastHeartbeatAt: String?
    public var secondsSinceHeartbeat: Int?
    public var mac: MacHostTelemetry?

    public init(
        ok: Bool,
        status: String,
        lastHeartbeatAt: String? = nil,
        secondsSinceHeartbeat: Int? = nil,
        mac: MacHostTelemetry? = nil
    ) {
        self.ok = ok
        self.status = status
        self.lastHeartbeatAt = lastHeartbeatAt
        self.secondsSinceHeartbeat = secondsSinceHeartbeat
        self.mac = mac
    }
}

public struct MacHostTelemetry: Codable, Hashable, Sendable {
    public var hostname: String
    public var osVersion: String?
    public var arch: String?
    public var cpuUsagePct: Double
    public var memoryUsagePct: Double
    public var diskUsagePct: Double
    public var uptimeSeconds: Int
    public var processes: [String: String]?
    public var lastHeartbeatAt: String?

    public init(
        hostname: String,
        osVersion: String? = nil,
        arch: String? = nil,
        cpuUsagePct: Double,
        memoryUsagePct: Double,
        diskUsagePct: Double,
        uptimeSeconds: Int,
        processes: [String: String]? = nil,
        lastHeartbeatAt: String? = nil
    ) {
        self.hostname = hostname
        self.osVersion = osVersion
        self.arch = arch
        self.cpuUsagePct = cpuUsagePct
        self.memoryUsagePct = memoryUsagePct
        self.diskUsagePct = diskUsagePct
        self.uptimeSeconds = uptimeSeconds
        self.processes = processes
        self.lastHeartbeatAt = lastHeartbeatAt
    }

    /// Sorted process rows so the UI does not shuffle on every refresh.
    public var processRows: [(name: String, status: String)] {
        (processes ?? [:]).map { ($0.key, $0.value) }.sorted { $0.name < $1.name }
    }
}
