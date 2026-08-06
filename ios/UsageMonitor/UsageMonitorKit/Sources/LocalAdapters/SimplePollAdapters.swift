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

// MARK: - Hetzner Cloud (catalog run-rate pro-rated MTD estimate)

/// Inventories servers and common paid add-ons, multiplies public catalog
/// monthly prices by UTC month fraction. Not an invoice — Hetzner has no
/// public billing-history API (same model as the remote adapter).
public struct HetznerAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "hetzner"
    public init() {}

    private static let eurUsdFallback = 1.09

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Hetzner API token empty") }
        let headers = ["Authorization": "Bearer \(key)"]

        async let serversTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/servers?per_page=50",
            headers: headers
        )
        async let pricingTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/pricing",
            headers: headers
        )
        async let volumesTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/volumes?per_page=50",
            headers: headers
        )
        async let floatingTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/floating_ips?per_page=50",
            headers: headers
        )
        async let primaryTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/primary_ips?per_page=50",
            headers: headers
        )
        async let lbTask = LocalHTTP.getJSON(
            url: "https://api.hetzner.cloud/v1/load_balancers?per_page=50",
            headers: headers
        )

        let (_, serversJson) = try await serversTask
        let (_, pricingJson) = try await pricingTask
        let volumesPair = try? await volumesTask
        let floatingPair = try? await floatingTask
        let primaryPair = try? await primaryTask
        let lbPair = try? await lbTask

        guard let pricingRoot = pricingJson?["pricing"] as? [String: Any] else {
            throw AdapterRunError.invalidResponse("Hetzner pricing catalog missing")
        }

        let rawCurrency = ((pricingRoot["currency"] as? String) ?? "").uppercased()
        var exchangeRate = Self.eurUsdFallback
        let convertEUR = rawCurrency == "EUR"
        if convertEUR {
            if let fx = try? await LocalHTTP.getJSON(
                url: "https://open.er-api.com/v6/latest/EUR",
                headers: [:]
            ),
               let rates = fx.json?["rates"] as? [String: Any],
               let usd = LocalHTTP.num(rates["USD"]), usd > 0 {
                exchangeRate = usd
            }
        }

        func convert(_ eurOrNative: Double?) -> Double? {
            guard let v = eurOrNative, v >= 0 else { return nil }
            return convertEUR ? v * exchangeRate : v
        }

        func locationPrice(
            catalog: [[String: Any]]?,
            typeName: String?,
            location: String?,
            fallbackPrices: [[String: Any]]? = nil
        ) -> Double? {
            guard let typeName, let location else { return nil }
            let entry = catalog?.first {
                ($0["name"] as? String) == typeName || ($0["type"] as? String) == typeName
            }
            let prices = (entry?["prices"] as? [[String: Any]]) ?? fallbackPrices ?? []
            guard let match = prices.first(where: { ($0["location"] as? String) == location }),
                  let monthly = match["price_monthly"] as? [String: Any]
            else { return nil }
            return LocalHTTP.num(monthly["net"])
        }

        let serverTypes = pricingRoot["server_types"] as? [[String: Any]]
        let volumePerGb: Double? = {
            guard let vol = pricingRoot["volume"] as? [String: Any],
                  let ppg = vol["price_per_gb_month"] as? [String: Any]
            else { return nil }
            return LocalHTTP.num(ppg["net"])
        }()
        let floatingCatalog = pricingRoot["floating_ips"] as? [[String: Any]]
        let primaryCatalog = pricingRoot["primary_ips"] as? [[String: Any]]
        let lbTypes = pricingRoot["load_balancer_types"] as? [[String: Any]]
        let backupPct = LocalHTTP.num(
            (pricingRoot["server_backup"] as? [String: Any])?["percentage"]
        )

        var monthlyRunRate = 0.0
        var serverCount = 0
        var incomplete = false

        if let servers = serversJson?["servers"] as? [[String: Any]] {
            for server in servers {
                serverCount += 1
                let typeObj = server["server_type"] as? [String: Any]
                let typeName = typeObj?["name"] as? String
                let location =
                    (server["location"] as? [String: Any])?["name"] as? String
                    ?? ((server["datacenter"] as? [String: Any])?["location"] as? [String: Any])?["name"] as? String
                let fallback = typeObj?["prices"] as? [[String: Any]]
                let price = locationPrice(
                    catalog: serverTypes,
                    typeName: typeName,
                    location: location,
                    fallbackPrices: fallback
                )
                if let c = convert(price) {
                    monthlyRunRate += c
                    let backupWindow = server["backup_window"] as? String
                    if let backupWindow, !backupWindow.isEmpty, let pct = backupPct, let price {
                        if let b = convert(price * (pct / 100)) {
                            monthlyRunRate += b
                        }
                    }
                } else {
                    incomplete = true
                }
            }
        }

        if let volumes = volumesPair?.json?["volumes"] as? [[String: Any]], let volumePerGb {
            for volume in volumes {
                let size = LocalHTTP.num(volume["size"]) ?? 0
                if let c = convert(volumePerGb * size) {
                    monthlyRunRate += c
                }
            }
        }

        if let ips = floatingPair?.json?["floating_ips"] as? [[String: Any]] {
            for ip in ips {
                let type = ip["type"] as? String
                let location = (ip["home_location"] as? [String: Any])?["name"] as? String
                let price = locationPrice(catalog: floatingCatalog, typeName: type, location: location)
                if let c = convert(price) { monthlyRunRate += c }
                else { incomplete = true }
            }
        }

        if let ips = primaryPair?.json?["primary_ips"] as? [[String: Any]] {
            for ip in ips {
                let type = ip["type"] as? String
                let location =
                    (ip["location"] as? [String: Any])?["name"] as? String
                    ?? ((ip["datacenter"] as? [String: Any])?["location"] as? [String: Any])?["name"] as? String
                let price = locationPrice(catalog: primaryCatalog, typeName: type, location: location)
                if let c = convert(price) { monthlyRunRate += c }
                else { incomplete = true }
            }
        }

        if let lbs = lbPair?.json?["load_balancers"] as? [[String: Any]] {
            for lb in lbs {
                let type = (lb["load_balancer_type"] as? [String: Any])?["name"] as? String
                let location = (lb["location"] as? [String: Any])?["name"] as? String
                let price = locationPrice(catalog: lbTypes, typeName: type, location: location)
                if let c = convert(price) { monthlyRunRate += c }
                else { incomplete = true }
            }
        }

        let now = Date()
        let monthStart = LocalHTTP.utcMonthStart(now)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let nextMonth = cal.date(byAdding: .month, value: 1, to: monthStart) ?? now
        let monthMs = max(1, nextMonth.timeIntervalSince(monthStart))
        let elapsed = min(monthMs, max(0, now.timeIntervalSince(monthStart)))
        let fraction = elapsed / monthMs
        let estimatedMtd = monthlyRunRate * fraction

        let note: String
        if incomplete {
            note =
                "Partial catalog estimate (some resources lacked prices). \(serverCount) server(s). Not an invoice."
        } else {
            note =
                "Pro-rated catalog MTD from Hetzner public pricing × inventory (\(serverCount) server(s)). Not an invoice."
        }

        return LocalUsageResult(
            totalCost: estimatedMtd,
            costWindowStart: monthStart,
            costWindowEnd: now,
            costScope: .calendarMonthToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "hetzner_catalog_runrate_prorated",
                message: note
            ),
            fetchedAt: now,
            statusNote: String(format: "Catalog monthly run-rate ≈ $%.2f (USD estimate)", monthlyRunRate)
        )
    }
}

// MARK: - Registry

public enum LocalAdapterRegistry {
    public static let supportedPollKinds: Set<String> = [
        "openrouter", "openai", "anthropic", "deepseek", "hetzner",
    ]

    public static func isSupportedPoll(_ kind: String) -> Bool {
        supportedPollKinds.contains(kind)
    }

    public static func adapter(for kind: String) -> any ProviderAdapter {
        switch kind {
        case "openrouter": return OpenRouterAdapter()
        case "deepseek": return DeepSeekAdapter()
        case "openai": return OpenAIAdapter()
        case "anthropic": return AnthropicAdapter()
        case "hetzner": return HetznerAdapter()
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
