#!/usr/bin/env node
// Mac-side subscription quota collector: percent REMAINING per plan window for
// Claude, Codex, Grok and MiniMax.
//
// Why this runs on the Mac and not on the server: each of these endpoints is
// the one the vendor's OWN CLI calls, authenticated with the OAuth token that
// CLI already stored locally.  Owner ruling on issue #1411 (2026-09-03) keeps
// "Codex /status or local quota probe, Grok credits, Claude /usage remaining"
// as laptop jobs.  A server-side connector impersonating a product website
// stays forbidden, and no GPL code is vendored here.
//
// Antigravity is deliberately NOT handled here — scripts/antigravity-usage-collector.mjs
// already emits its quota windows, and duplicating them would double-count.
//
// Usage:
//   node scripts/subscription-quota-collector.mjs [--provider claude|codex|grok|minimax|all]
//                                                 [--dry-run] [--redacted]
//                                                 [--fixture path.json] [--debug]
//
// Owner one-shot, safe to paste (prints numbers, window labels and ISO dates only):
//   node scripts/subscription-quota-collector.mjs --dry-run --redacted
//
// Install the LaunchAgent (every 15 minutes, same pattern as the other collectors):
//   cp scripts/com.jays.subscription-quota-collector.plist.example \
//      ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
//   # replace the /ABSOLUTE/PATH placeholders, then:
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
//   launchctl kickstart -k gui/$(id -u)/com.jays.subscription-quota-collector
// Uninstall:
//   launchctl bootout gui/$(id -u)/com.jays.subscription-quota-collector
//
// Env:
//   USAGE_INGEST_TOKEN (or SUBSCRIPTION_QUOTA_INGEST_TOKEN), falling back to
//     ~/.secrets/global-api-keys via resolveCollectorToken
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   CLAUDE_HOME / CODEX_HOME / GROK_HOME / MINIMAX_CONFIG_PATH to override
//     credential locations
//
// SECRETS: this script reads local credential files and never prints, logs or
// posts their contents.  The only credential-derived value that ever leaves it
// is the plan name (e.g. "max_20x"), which is not a secret.  Raw HTTP response
// bodies are never printed under any flag, because they can carry account ids.

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  GROK_PRODUCER_ID,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import { expandHome, resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { planTypeFromCodexAuth } from "./lib/codex-observed-plan.mjs";
import { buildQuotaEvent } from "./lib/quota-event.mjs";
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseGrokBilling,
  parseMinimaxRemains,
} from "./lib/subscription-quota-parsers.mjs";

/** MiniMax has no seat in session-token-collectors yet; give it its own id. */
export const MINIMAX_PRODUCER_ID = "minimax-code";

const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

const REQUEST_TIMEOUT_MS = 20_000;

function log(message) {
  console.log(`[subscription-quota-collector] ${message}`);
}

// ---------------------------------------------------------------- helpers ---

/** Read and parse a JSON file.  Returns null on any failure; never logs content. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/**
 * Find the first present key from `candidates` in `record` (supports one level
 * of `a.b` nesting).  Returns `{ key, value }` so the caller can log WHICH key
 * name matched without ever logging the value.
 */
export function resolveCredentialField(record, candidates) {
  const root = asRecord(record);
  for (const candidate of candidates) {
    const parts = candidate.split(".");
    let cursor = root;
    let ok = true;
    for (const part of parts) {
      cursor = asRecord(cursor)[part];
      if (cursor == null) {
        ok = false;
        break;
      }
    }
    if (ok && typeof cursor === "string" && cursor.trim()) {
      return { key: candidate, value: cursor.trim() };
    }
  }
  return null;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  // Deliberately does NOT include the body: it can carry account identifiers.
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  if (parsed == null) throw new Error(`Non-JSON response from ${new URL(url).host}`);
  return parsed;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// -------------------------------------------------------------- providers ---

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MINIMAX_URLS = [
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
];

const PROVIDERS = {
  claude: {
    provider: "anthropic",
    service: "claude-code",
    producerId: CLAUDE_PRODUCER_ID,
    defaultSource: hostOf(CLAUDE_USAGE_URL),
    parse: (payload, context) => parseClaudeUsage(payload, context),
    async fetch() {
      const path = join(expandHome(process.env.CLAUDE_HOME || "~/.claude"), ".credentials.json");
      const credentials = await readJson(path);
      const oauth = asRecord(asRecord(credentials).claudeAiOauth);
      const token = resolveCredentialField(oauth, ["accessToken", "access_token"]);
      if (!token) return { skipped: "no Claude Code OAuth credential found" };
      const expiresAt = Number(oauth.expiresAt ?? oauth.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        // Refreshing here would race Claude Code's own refresh and could
        // invalidate the CLI's token.  Claude Code refreshes on next use.
        return { skipped: "Claude Code access token is expired; skipping this tick" };
      }
      const planType =
        typeof oauth.subscriptionType === "string" ? oauth.subscriptionType.trim() : null;
      const payload = await fetchJson(CLAUDE_USAGE_URL, {
        authorization: `Bearer ${token.value}`,
        "anthropic-beta": "oauth-2025-04-20",
      });
      return { payload, context: { planType }, source: hostOf(CLAUDE_USAGE_URL) };
    },
  },

  codex: {
    provider: "openai",
    service: "codex-cli",
    producerId: CODEX_PRODUCER_ID,
    defaultSource: hostOf(CODEX_USAGE_URL),
    parse: (payload, context) => parseCodexUsage(payload, context),
    async fetch() {
      const path = join(expandHome(process.env.CODEX_HOME || "~/.codex"), "auth.json");
      const auth = await readJson(path);
      const tokens = asRecord(asRecord(auth).tokens);
      const token = resolveCredentialField(tokens, ["access_token", "accessToken"]);
      if (!token) return { skipped: "no Codex CLI credential found" };
      const accountId = resolveCredentialField(tokens, ["account_id", "accountId"]);
      const planType = planTypeFromCodexAuth(auth);
      const headers = {
        authorization: `Bearer ${token.value}`,
        "user-agent": "codex-cli",
      };
      if (accountId) headers["chatgpt-account-id"] = accountId.value;
      const payload = await fetchJson(CODEX_USAGE_URL, headers);
      return { payload, context: { planType }, source: hostOf(CODEX_USAGE_URL) };
    },
  },

  grok: {
    provider: "xai",
    service: "grok-cli",
    producerId: GROK_PRODUCER_ID,
    defaultSource: hostOf(GROK_BILLING_URL),
    parse: (payload) => parseGrokBilling(payload),
    async fetch({ debug }) {
      const path = join(expandHome(process.env.GROK_HOME || "~/.grok"), "auth.json");
      const auth = await readJson(path);
      const token = resolveCredentialField(auth, [
        "access_token",
        "accessToken",
        "token",
        "api_key",
        "apiKey",
        "tokens.access_token",
        "tokens.accessToken",
        "auth.access_token",
      ]);
      if (!token) return { skipped: "no Grok CLI credential found" };
      // Log the key NAME only, never the value — the key layout is undocumented
      // and knowing which name matched is what makes a bad tick diagnosable.
      if (debug) log(`grok credential matched key name "${token.key}"`);
      const payload = await fetchJson(GROK_BILLING_URL, {
        authorization: `Bearer ${token.value}`,
      });
      return { payload, source: hostOf(GROK_BILLING_URL) };
    },
  },

  minimax: {
    provider: "minimax",
    service: "minimax-code",
    producerId: MINIMAX_PRODUCER_ID,
    defaultSource: hostOf(MINIMAX_URLS[0]),
    parse: (payload) => parseMinimaxRemains(payload),
    async fetch({ debug }) {
      const path = expandHome(process.env.MINIMAX_CONFIG_PATH || "~/.mmx/config.json");
      const config = await readJson(path);
      const key = resolveCredentialField(config, [
        "api_key",
        "apiKey",
        "key",
        "token",
        "auth.api_key",
        "auth.apiKey",
      ]);
      if (!key) return { skipped: "no MiniMax credential found" };
      if (debug) log(`minimax credential matched key name "${key.key}"`);
      const configuredBase = resolveCredentialField(config, ["base_url", "baseUrl", "baseURL"]);
      const urls = configuredBase
        ? [
            `${configuredBase.value.replace(/\/+$/, "")}/v1/api/openplatform/coding_plan/remains`,
            ...MINIMAX_URLS,
          ]
        : MINIMAX_URLS;
      let lastError = null;
      for (const url of urls) {
        try {
          const payload = await fetchJson(url, { authorization: `Bearer ${key.value}` });
          return { payload, source: hostOf(url) };
        } catch (error) {
          // api.minimax.io and api.minimaxi.com are region mirrors; a 4xx on one
          // is routinely a "wrong region for this account", not a bad key.
          lastError = error;
        }
      }
      throw lastError ?? new Error("MiniMax request failed");
    },
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);

// --------------------------------------------------------------- CLI body ---

export function parseArgs(argv) {
  const args = {
    providers: PROVIDER_KEYS,
    dryRun: argv.includes("--dry-run"),
    redacted: argv.includes("--redacted"),
    debug: argv.includes("--debug"),
    fixture: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--provider" && argv[i + 1]) {
      const value = argv[i + 1].trim().toLowerCase();
      if (value !== "all") {
        if (!PROVIDER_KEYS.includes(value)) {
          throw new Error(`Unknown --provider ${value}; expected one of ${PROVIDER_KEYS.join(", ")}, all`);
        }
        args.providers = [value];
      }
    }
    if (argv[i] === "--fixture" && argv[i + 1]) {
      args.fixture = argv[i + 1];
    }
  }
  if (args.fixture && args.providers.length !== 1) {
    throw new Error("--fixture requires a single --provider");
  }
  return args;
}

/** Turn one provider's raw payload into ingest events.  Pure; used by tests. */
export function eventsForProvider(providerKey, payload, { context, source, occurredAtIso } = {}) {
  const definition = PROVIDERS[providerKey];
  if (!definition) throw new Error(`Unknown provider ${providerKey}`);
  const readings = definition.parse(payload, context ?? {});
  // A window whose remaining percent we could not read is dropped, not posted.
  // The read path's "N/A remaining means none remains" rule is an Antigravity
  // ruling (owner 2026-09-04); applying it to a field-name mismatch would tell
  // the user their Grok plan is exhausted when we simply failed to parse it.
  // A provider with nothing postable shows the honest "no quota report yet" row.
  return readings
    .filter((r) => !r.remainingUnknown && r.remainingPercent != null)
    .map((r) =>
      buildQuotaEvent({
        provider: definition.provider,
        service: definition.service,
        reading: r,
        source: source ?? definition.defaultSource,
        occurredAtIso: occurredAtIso ?? new Date().toISOString(),
      }),
    );
}

function summarise(providerKey, events, { redacted }) {
  const definition = PROVIDERS[providerKey];
  for (const event of events) {
    const meta = event.metadata;
    const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
    log(
      `${definition.provider} | ${event.label} | remaining ${remaining} | resets ${
        meta.resetAt ?? "unknown"
      } | plan ${meta.planType ?? "unknown"}`,
    );
  }
  if (!redacted) {
    // Still safe: these events carry only derived numbers, labels and ISO dates.
    log(`${providerKey} events: ${JSON.stringify(events)}`);
  }
}

async function collectProvider(providerKey, args) {
  const definition = PROVIDERS[providerKey];
  try {
    let payload;
    let context = {};
    let source = definition.defaultSource;
    if (args.fixture) {
      payload = await readJson(args.fixture);
      if (payload == null) {
        return { providerKey, status: "failed", error: `unreadable fixture ${args.fixture}`, events: [] };
      }
      source = `fixture:${definition.defaultSource}`;
    } else {
      const result = await definition.fetch({ debug: args.debug });
      if (result.skipped) {
        log(`${providerKey}: ${result.skipped}`);
        return { providerKey, status: "skipped", events: [] };
      }
      payload = result.payload;
      context = result.context ?? {};
      source = result.source ?? source;
    }
    const parsedWindows = definition.parse(payload, context).length;
    const events = eventsForProvider(providerKey, payload, { context, source });
    if (events.length === 0) {
      log(
        parsedWindows > 0
          ? `${providerKey}: ${parsedWindows} window(s) parsed but none reported a remaining percentage; run with --debug and check the field names in scripts/lib/subscription-quota-parsers.mjs`
          : `${providerKey}: response parsed but reported no quota windows`,
      );
      return { providerKey, status: "skipped", events: [] };
    }
    summarise(providerKey, events, { redacted: args.redacted });
    return { providerKey, status: "ok", events };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${providerKey}: FAILED (${message})`);
    return { providerKey, status: "failed", error: message, events: [] };
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(`[subscription-quota-collector] ${error.message}`);
    process.exit(2);
  }

  const results = [];
  for (const providerKey of args.providers) {
    // Sequential on purpose: one failing provider must not stop the others, and
    // four parallel OAuth calls from a laptop is a good way to get rate limited.
    results.push(await collectProvider(providerKey, args));
  }

  const withEvents = results.filter((r) => r.events.length > 0);
  if (withEvents.length > 0 && !args.dryRun) {
    const token = resolveCollectorToken([
      "SUBSCRIPTION_QUOTA_INGEST_TOKEN",
      "USAGE_INGEST_TOKEN",
    ]);
    for (const result of withEvents) {
      const definition = PROVIDERS[result.providerKey];
      try {
        const ack = await postUsageBatches({
          events: result.events,
          ingestUrl: INGEST_URL,
          ingestToken: token,
          producerId: definition.producerId,
          dryRun: false,
          log,
        });
        log(
          `${result.providerKey} ingest ack: received=${ack.received} persisted=${ack.persisted} rejected=${ack.rejected}`,
        );
        if (ack.rejected > 0) result.status = "failed";
      } catch (error) {
        result.status = "failed";
        log(
          `${result.providerKey}: ingest FAILED (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  } else if (withEvents.length > 0) {
    log(`--dry-run; not posting ${withEvents.reduce((n, r) => n + r.events.length, 0)} event(s)`);
  }

  const summary = results.map((r) => `${r.providerKey}=${r.status}`).join(" ");
  log(`pass complete: ${summary}`);

  // Exit 1 only when EVERY provider failed.  A skipped provider (no credential,
  // expired token) is an expected state on a machine that does not use it.
  const anySucceeded = results.some((r) => r.status === "ok" || r.status === "skipped");
  process.exit(anySucceeded ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[subscription-quota-collector] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { PROVIDERS };
