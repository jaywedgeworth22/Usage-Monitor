import Foundation
import LocalSecrets

// MARK: - Shared HTTP

enum LocalHTTP {
    static func getJSON(
        url: String,
        headers: [String: String],
        timeout: TimeInterval = 30
    ) async throws -> (status: Int, json: [String: Any]?) {
        guard let u = URL(string: url) else {
            throw AdapterRunError.configuration("Bad URL: \(url)")
        }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch let e as URLError where e.code == .timedOut {
            throw AdapterRunError.timeout
        } catch {
            throw AdapterRunError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AdapterRunError.transport("Non-HTTP response")
        }
        if !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8)
            throw AdapterRunError.httpStatus(http.statusCode, body)
        }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (http.statusCode, obj)
    }

    static func num(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        if let n = any as? NSNumber { return n.doubleValue }
        if let s = any as? String { return Double(s) }
        return nil
    }

    static func utcMonthStart(_ date: Date = Date()) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month], from: date)
        return cal.date(from: DateComponents(year: c.year, month: c.month, day: 1))!
    }
}

// MARK: - DeepSeek (balance)

public struct DeepSeekAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "deepseek"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("DeepSeek API key empty") }
        let (_, json) = try await LocalHTTP.getJSON(
            url: "https://api.deepseek.com/user/balance",
            headers: ["Authorization": "Bearer \(key)"]
        )
        guard let json else { throw AdapterRunError.invalidResponse("Empty DeepSeek body") }
        var balance: Double?
        var credits: Double?
        if let infos = json["balance_infos"] as? [[String: Any]] {
            for info in infos {
                let currency = (info["currency"] as? String)?.uppercased()
                if currency == "USD" {
                    balance = LocalHTTP.num(info["total_balance"])
                    credits = LocalHTTP.num(info["granted_balance"])
                    break
                }
            }
        }
        return LocalUsageResult(
            totalCost: nil,
            balance: balance,
            costScope: .unknown,
            credits: credits,
            fetchedAt: Date(),
            statusNote: "DeepSeek reports balance only (no MTD cost API)."
        )
    }
}

// MARK: - OpenAI organization costs (simplified)

public struct OpenAIAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "openai"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("OpenAI API key empty") }

        let now = Date()
        let monthStart = LocalHTTP.utcMonthStart(now)
        let startTime = Int(monthStart.timeIntervalSince1970)
        let endTime = Int(now.timeIntervalSince1970)

        var url = URLComponents(string: "https://api.openai.com/v1/organization/costs")!
        url.queryItems = [
            URLQueryItem(name: "start_time", value: String(startTime)),
            URLQueryItem(name: "end_time", value: String(endTime)),
            URLQueryItem(name: "bucket_width", value: "1d"),
            URLQueryItem(name: "limit", value: "31"),
        ]
        let (_, json) = try await LocalHTTP.getJSON(
            url: url.url!.absoluteString,
            headers: ["Authorization": "Bearer \(key)"]
        )
        guard let json, let data = json["data"] as? [[String: Any]] else {
            throw AdapterRunError.invalidResponse("OpenAI costs: missing data[] (need Org Admin key)")
        }

        var total: Double = 0
        for bucket in data {
            guard let results = bucket["results"] as? [[String: Any]] else { continue }
            for result in results {
                guard let amount = result["amount"] as? [String: Any] else { continue }
                let currency = (amount["currency"] as? String)?.lowercased()
                guard currency == "usd", let value = LocalHTTP.num(amount["value"]) else { continue }
                total += value
            }
        }

        return LocalUsageResult(
            totalCost: total,
            costWindowStart: monthStart,
            costWindowEnd: now,
            costScope: .calendarMonthToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "openai_org_costs_mtd",
                message: "Month-to-date from OpenAI Organization Costs API (not an invoice)."
            ),
            fetchedAt: now
        )
    }
}

// MARK: - Anthropic Admin cost report

public struct AnthropicAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "anthropic"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Anthropic key empty") }

        // Personal messages keys cannot use org cost report.
        if !key.contains("admin") && !key.hasPrefix("sk-ant-admin") {
            return LocalUsageResult(
                totalCost: nil,
                costScope: .unknown,
                fetchedAt: Date(),
                statusNote:
                    "Not an Admin key — personal Claude usage is not pollable. Add a “Claude (subscription)” row for Max/Pro."
            )
        }

        let now = Date()
        let monthStart = LocalHTTP.utcMonthStart(now)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        var url = URLComponents(string: "https://api.anthropic.com/v1/organizations/cost_report")!
        url.queryItems = [
            URLQueryItem(name: "starting_at", value: formatter.string(from: monthStart)),
            URLQueryItem(name: "ending_at", value: formatter.string(from: now)),
            URLQueryItem(name: "bucket_width", value: "1d"),
        ]
        let (_, json) = try await LocalHTTP.getJSON(
            url: url.url!.absoluteString,
            headers: [
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            ]
        )
        guard let json else {
            throw AdapterRunError.invalidResponse("Anthropic cost report empty")
        }

        var total: Double = 0
        if let data = json["data"] as? [[String: Any]] {
            for bucket in data {
                guard let results = bucket["results"] as? [[String: Any]] else { continue }
                for result in results {
                    if let amount = LocalHTTP.num(result["amount"]) {
                        total += amount
                    } else if let amountObj = result["amount"] as? [String: Any],
                              let value = LocalHTTP.num(amountObj["amount"] ?? amountObj["value"]) {
                        total += value
                    }
                }
            }
        }

        return LocalUsageResult(
            totalCost: total,
            costWindowStart: monthStart,
            costWindowEnd: now,
            costScope: .calendarMonthToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "anthropic_admin_cost_report",
                message: "MTD from Anthropic organization cost report."
            ),
            fetchedAt: now
        )
    }
}

// MARK: - Registry

public enum LocalAdapterRegistry {
    public static func adapter(for kind: String) -> any ProviderAdapter {
        switch kind {
        case "openrouter": return OpenRouterAdapter()
        case "deepseek": return DeepSeekAdapter()
        case "openai": return OpenAIAdapter()
        case "anthropic": return AnthropicAdapter()
        default:
            return UnsupportedLocalAdapter(kind: kind)
        }
    }
}

private struct UnsupportedLocalAdapter: ProviderAdapter {
    let kind: String
    var adapterKind: String { kind }
    func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        throw AdapterRunError.unsupported(
            "No phone poll adapter for '\(kind)' — track as subscription or wait for a later port."
        )
    }
}
