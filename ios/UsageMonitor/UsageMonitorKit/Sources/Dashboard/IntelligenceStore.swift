import Foundation
import Observation
import AppCore
import Models
import Networking

@MainActor
@Observable
public final class IntelligenceStore {
    public private(set) var burnState: LoadState<LlmBurnResponse> = .idle
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    private var didLoadOnce = false

    public init() {}

    public var burn: LlmBurnResponse? { burnState.value }

    public func reset() {
        burnState = .idle
        requiresSession = false
        lastError = nil
        didLoadOnce = false
    }

    public func loadIfNeeded(using client: APIClient) async {
        guard !didLoadOnce else { return }
        await refresh(using: client)
    }

    public func refresh(using client: APIClient) async {
        lastError = nil
        requiresSession = false
        if burnState.value == nil { burnState = .loading }
        do {
            let response = try await client.llmBurn()
            burnState = .loaded(response)
            didLoadOnce = true
        } catch let error as APIError {
            if case .unauthorized = error {
                requiresSession = true
                burnState = .idle
            } else if burnState.value == nil {
                burnState = .failed(error)
            } else {
                lastError = error
            }
            didLoadOnce = true
        } catch {
            let apiError = APIError.transport(error.localizedDescription)
            if burnState.value == nil { burnState = .failed(apiError) }
            else { lastError = apiError }
            didLoadOnce = true
        }
    }
}
