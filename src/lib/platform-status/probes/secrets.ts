/**
 * Secrets platform probes.
 *
 * Infisical is the fleet's credential source of truth: `infisical-provider-sync`
 * exchanges a Universal Auth machine identity for a short-lived access token and
 * pulls provider credentials from four project scopes.  When that identity stops
 * authenticating nothing crashes — provider keys simply stop rotating, which is a
 * silent production outage.  This probe makes that failure loud by proving, on
 * every sweep, that each configured machine identity can still log in and still
 * sees secrets in its project.
 *
 * The probe reads names only.  `viewSecretValue=false` on the list call means no
 * secret value ever reaches this process, and nothing derived from a client id,
 * client secret, or access token is ever placed on the card.
 */

import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  formatCount,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";

/** Same default host `infisical-provider-sync` uses. */
const DEFAULT_BASE_URL = "https://app.infisical.com";
/** Same allowlist `infisical-provider-sync.infisicalBaseUrl()` enforces. */
const ALLOWED_HOSTS = new Set(["app.infisical.com", "us.infisical.com", "eu.infisical.com"]);
const DEFAULT_ENVIRONMENT = "prod";
const DEFAULT_SECRET_PATH = "/";

/** Fleet-wide fallback identity — set alone, it enables every scope below. */
const AUTOMATION_CLIENT_ID_ENV = "INFISICAL_AUTOMATION_CLIENT_ID";
const AUTOMATION_CLIENT_SECRET_ENV = "INFISICAL_AUTOMATION_CLIENT_SECRET";

interface ScopeDefinition {
  /** Project display name, used verbatim as the metric label. */
  label: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  projectIdEnv: string;
  pathEnv: string;
  defaultProjectId: string;
}

/**
 * Mirrors `SOURCE_DEFINITIONS` in `src/lib/infisical-provider-sync.ts` — same
 * env var names, same verified default project ids (project ids identify a
 * project and are not credentials).  Keep the two lists in step.
 */
const SCOPES: readonly ScopeDefinition[] = [
  {
    label: "SocraticTrade.com",
    clientIdEnv: "INFISICAL_ST_CLIENT_ID",
    clientSecretEnv: "INFISICAL_ST_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_ST_PROJECT_ID",
    pathEnv: "INFISICAL_ST_SECRET_PATH",
    defaultProjectId: "39d93bb7-76f9-498c-8b50-a7def52e072f",
  },
  {
    label: "Congress.Trade",
    clientIdEnv: "INFISICAL_CT_CLIENT_ID",
    clientSecretEnv: "INFISICAL_CT_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_CT_PROJECT_ID",
    pathEnv: "INFISICAL_CT_SECRET_PATH",
    defaultProjectId: "f61a79de-8d77-4f0b-9361-4b7208598290",
  },
  {
    label: "Shared",
    clientIdEnv: "INFISICAL_SHARED_CLIENT_ID",
    clientSecretEnv: "INFISICAL_SHARED_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_SHARED_PROJECT_ID",
    pathEnv: "INFISICAL_SHARED_SECRET_PATH",
    defaultProjectId: "18f563a3-9c88-454c-96eb-28fc9678f3ba",
  },
  {
    label: "Usage-Monitor",
    clientIdEnv: "INFISICAL_UM_CLIENT_ID",
    clientSecretEnv: "INFISICAL_UM_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_UM_PROJECT_ID",
    pathEnv: "INFISICAL_UM_SECRET_PATH",
    defaultProjectId: "86e35e51-91bc-4dfd-a045-4484726b9c40",
  },
] as const;

interface ResolvedScope {
  label: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  secretPath: string;
}

interface ResolvedScopes {
  ready: ResolvedScope[];
  /** Scopes with exactly one half of the credential pair set. */
  incomplete: number;
}

/**
 * Env presence only — pure, synchronous, never throws.  A scope counts when
 * both halves resolve, either from its own pair or the automation fallback.
 */
function resolveScopes(): ResolvedScopes {
  const ready: ResolvedScope[] = [];
  let incomplete = 0;

  for (const scope of SCOPES) {
    const clientId = envValue(scope.clientIdEnv, AUTOMATION_CLIENT_ID_ENV);
    const clientSecret = envValue(scope.clientSecretEnv, AUTOMATION_CLIENT_SECRET_ENV);
    if (clientId && clientSecret) {
      ready.push({
        label: scope.label,
        clientId,
        clientSecret,
        projectId: envValue(scope.projectIdEnv) ?? scope.defaultProjectId,
        secretPath: envValue(scope.pathEnv) ?? DEFAULT_SECRET_PATH,
      });
    } else if (clientId || clientSecret) {
      incomplete += 1;
    }
  }

  return { ready, incomplete };
}

/** The configured base URL, or null when it is not an allowed Infisical host. */
function allowedBaseUrl(): string | null {
  let url: URL;
  try {
    url = new URL(envValue("INFISICAL_BASE_URL") ?? DEFAULT_BASE_URL);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.origin;
}

type ScopeOutcome =
  | { kind: "ok"; label: string; secrets: number }
  | { kind: "http"; status: number }
  | { kind: "invalid" }
  | { kind: "error"; error: unknown };

/**
 * Log one machine identity in and count the secret names it can see.  Values
 * are never requested, so nothing sensitive enters this process.
 */
async function readScope(
  baseUrl: string,
  scope: ResolvedScope,
  environment: string
): Promise<ScopeOutcome> {
  try {
    const login = await requestJson(
      `${baseUrl}/api/v1/auth/universal-auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: scope.clientId,
          clientSecret: scope.clientSecret,
        }),
      },
      { security: "untrusted" }
    );
    if (!login.ok) return { kind: "http", status: login.status };

    const accessToken = asRecord(login.data)?.accessToken;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return { kind: "invalid" };
    }

    const params = new URLSearchParams({
      projectId: scope.projectId,
      environment,
      secretPath: scope.secretPath,
      viewSecretValue: "false",
      expandSecretReferences: "false",
      recursive: "false",
      includePersonalOverrides: "false",
      includeImports: "false",
    });
    const listed = await requestJson(
      `${baseUrl}/api/v4/secrets?${params.toString()}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      { security: "untrusted" }
    );
    if (!listed.ok) return { kind: "http", status: listed.status };

    const body = asRecord(listed.data);
    if (!body || !Array.isArray(body.secrets)) return { kind: "invalid" };
    return { kind: "ok", label: scope.label, secrets: asArray(body.secrets).length };
  } catch (error) {
    return { kind: "error", error };
  }
}

function isConfigured(): boolean {
  return resolveScopes().ready.length > 0;
}

async function probe(): Promise<PlatformProbeResult> {
  const baseUrl = allowedBaseUrl();
  if (!baseUrl) {
    return {
      state: "degraded",
      headline:
        "The configured Infisical base URL is not an allowed host.  Fix INFISICAL_BASE_URL to probe secrets.",
      metrics: [],
      error: "invalid_base_url",
    };
  }

  const { ready, incomplete } = resolveScopes();
  if (ready.length === 0) {
    return {
      state: "degraded",
      headline:
        "No Infisical machine identity is fully configured.  Each identity needs a client id and a client secret.",
      metrics: [],
      error: "incomplete_credentials",
    };
  }

  const environment = envValue("INFISICAL_ENV") ?? DEFAULT_ENVIRONMENT;
  const outcomes = await Promise.all(
    ready.map((scope) => readScope(baseUrl, scope, environment))
  );

  // Rejected credentials outrank everything else: that is the failure mode that
  // silently stops provider keys from rotating.
  const rejected = outcomes.find(
    (outcome) => outcome.kind === "http" && (outcome.status === 401 || outcome.status === 403)
  );
  if (rejected && rejected.kind === "http") {
    return upstreamFailure(
      rejected.status,
      "Infisical rejected the machine identity credentials.  Provider credential sync cannot refresh secrets."
    );
  }

  const failed = outcomes.find((outcome) => outcome.kind === "http");
  if (failed && failed.kind === "http") {
    return upstreamFailure(
      failed.status,
      `Infisical returned HTTP ${failed.status}.  Secret visibility could not be confirmed.`
    );
  }

  const unreachable = outcomes.find((outcome) => outcome.kind === "error");
  if (unreachable && unreachable.kind === "error") {
    return failureResult(
      unreachable.error,
      "Infisical did not respond.  Provider credential sync could not be verified."
    );
  }

  if (outcomes.some((outcome) => outcome.kind === "invalid")) {
    return {
      state: "degraded",
      headline:
        "Infisical returned an unexpected response.  Secret visibility could not be confirmed.",
      metrics: [],
      error: "invalid_response",
    };
  }

  const authenticated = outcomes.filter(
    (outcome): outcome is Extract<ScopeOutcome, { kind: "ok" }> => outcome.kind === "ok"
  );
  const empty = authenticated.filter((outcome) => outcome.secrets === 0);
  const total = authenticated.reduce((sum, outcome) => sum + outcome.secrets, 0);

  const metrics: PlatformMetric[] = authenticated.map((outcome) =>
    metric(outcome.label, formatCount(outcome.secrets, "secret"))
  );
  if (incomplete > 0) {
    metrics.push(
      metric(
        "Incomplete Identities",
        formatCount(incomplete, "identity", "identities"),
        "client id and secret must both be set"
      )
    );
  }
  metrics.push(metric("Environment", environment));

  if (empty.length > 0) {
    return {
      state: "degraded",
      headline: `No secrets are visible in ${formatCount(empty.length, "project")}.  Provider credential sync has nothing to read there.`,
      metrics,
      error: "no_secrets_visible",
    };
  }

  if (incomplete > 0) {
    return {
      state: "degraded",
      headline: `Authenticated.  Half a credential pair is set for ${formatCount(incomplete, "identity", "identities")}.`,
      metrics,
      error: "incomplete_credentials",
    };
  }

  return {
    state: "healthy",
    headline: `${formatCount(authenticated.length, "machine identity", "machine identities")} authenticated.  ${formatCount(total, "secret")} visible in ${environment}.`,
    metrics,
  };
}

export const SECRETS_PROBES: readonly PlatformProbe[] = [
  {
    id: "infisical",
    name: "Infisical",
    category: "secrets",
    // The automation pair alone enables every scope; the per-project
    // INFISICAL_<SCOPE>_CLIENT_ID / _CLIENT_SECRET pairs override it.
    requiredEnv: [AUTOMATION_CLIENT_ID_ENV, AUTOMATION_CLIENT_SECRET_ENV],
    consoleUrl: "https://app.infisical.com",
    isConfigured,
    probe,
  },
];
