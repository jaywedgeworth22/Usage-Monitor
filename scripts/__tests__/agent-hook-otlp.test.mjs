import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NOOP_REPLIES,
  buildLogRecord,
  coarseToolName,
  defaultCredentialsFilePath,
  extractFields,
  main,
  noopReplyFor,
  parsePayload,
  postOtlp,
  resolveCredentials,
} from "../agent-hook-otlp.mjs";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "agent-hook-otlp.mjs");

const ALLOWLIST_KEYS = new Set([
  "service.name",
  "agent.platform",
  "seat",
  "event",
  "tool.name",
  "success",
  "duration_ms",
  "session.id",
  "model",
]);

function attributeKeys(record) {
  const resourceKeys = record.resourceLogs[0].resource.attributes.map((a) => a.key);
  const logKeys = record.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a) => a.key);
  return new Set([...resourceKeys, ...logKeys]);
}

describe("coarseToolName", () => {
  it("collapses MCP-flavoured names case-insensitively", () => {
    expect(coarseToolName("mcp__github__search")).toBe("mcp_tool");
    expect(coarseToolName("MCP_TOOL")).toBe("mcp_tool");
    expect(coarseToolName("some-MCPish-name")).toBe("mcp_tool");
  });

  it("passes through a plain tool name unchanged", () => {
    expect(coarseToolName("Bash")).toBe("Bash");
    expect(coarseToolName("Edit")).toBe("Edit");
  });

  it("returns undefined for empty, whitespace, or non-string input", () => {
    expect(coarseToolName("")).toBeUndefined();
    expect(coarseToolName("   ")).toBeUndefined();
    expect(coarseToolName(undefined)).toBeUndefined();
    expect(coarseToolName(null)).toBeUndefined();
    expect(coarseToolName(42)).toBeUndefined();
  });
});

describe("resolveCredentials", () => {
  it("prefers env vars when all three are set", () => {
    const env = {
      AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
      AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
      AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=abc",
    };
    const readFile = vi.fn(() => {
      throw new Error("must not read the credentials file when env vars are complete");
    });
    expect(resolveCredentials(env, readFile)).toEqual({
      endpoint: "https://example.sentry.io/v1/logs",
      headerName: "x-sentry-auth",
      headerValue: "sentry sentry_key=abc",
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to the credentials file when env vars are incomplete", () => {
    const readFile = vi.fn(() =>
      JSON.stringify({
        endpoint: "https://example.sentry.io/v1/logs",
        headerName: "x-sentry-auth",
        headerValue: "sentry sentry_key=fromfile",
      })
    );
    expect(resolveCredentials({}, readFile)).toEqual({
      endpoint: "https://example.sentry.io/v1/logs",
      headerName: "x-sentry-auth",
      headerValue: "sentry sentry_key=fromfile",
    });
  });

  it("honours AGENT_HOOK_OTLP_CREDENTIALS_FILE for the file path", () => {
    const readFile = vi.fn((path) => {
      expect(path).toBe("/custom/path.json");
      return JSON.stringify({ endpoint: "e", headerName: "h", headerValue: "v" });
    });
    resolveCredentials({ AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/custom/path.json" }, readFile);
    expect(readFile).toHaveBeenCalledWith("/custom/path.json", "utf8");
  });

  it("returns null when the file is missing", () => {
    const readFile = vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("returns null when the file has malformed JSON", () => {
    const readFile = vi.fn(() => "{not json");
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("returns null when the file is missing a required field", () => {
    const readFile = vi.fn(() => JSON.stringify({ endpoint: "e", headerName: "h" }));
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("defaultCredentialsFilePath points under ~/.config/usage-monitor", () => {
    expect(defaultCredentialsFilePath()).toMatch(/\.config\/usage-monitor\/agent-hook-otlp-sentry\.json$/);
  });
});

describe("extractFields: antigravity", () => {
  it("PostToolUse: coarse tool name, success from absence of error", () => {
    const fields = extractFields("antigravity", "PostToolUse", {
      toolCall: { name: "run_terminal_command", args: { command: "rm -rf /tmp/x" } },
      conversationId: "conv-1",
      modelName: "gemini-3-pro",
      stepIdx: 4,
    });
    expect(fields.toolName).toBe("run_terminal_command");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("conv-1");
    expect(fields.model).toBe("gemini-3-pro");
  });

  it("PostToolUse: an MCP tool name collapses, and a present error means failure", () => {
    const fields = extractFields("antigravity", "PostToolUse", {
      toolCall: { name: "mcp__cloudflare__deploy" },
      error: "boom",
      conversationId: "conv-2",
    });
    expect(fields.toolName).toBe("mcp_tool");
    expect(fields.success).toBe(false);
  });

  it("PostInvocation carries no tool name and defaults to success", () => {
    const fields = extractFields("antigravity", "PostInvocation", {
      conversationId: "conv-3",
      invocationNum: 2,
      modelName: "gemini-3-flash",
    });
    expect(fields.toolName).toBeUndefined();
    expect(fields.success).toBe(true);
    expect(fields.model).toBe("gemini-3-flash");
  });

  it("Stop reflects an error field when present", () => {
    const clean = extractFields("antigravity", "Stop", { conversationId: "c", fullyIdle: true });
    expect(clean.success).toBe(true);
    const failed = extractFields("antigravity", "Stop", { conversationId: "c", error: "panic" });
    expect(failed.success).toBe(false);
  });

  it("an unrecognised antigravity event still yields a safe field set", () => {
    const fields = extractFields("antigravity", "SomeFutureEvent", { conversationId: "c" });
    expect(fields.sessionId).toBe("c");
    expect(fields.success).toBe(true);
  });
});

describe("extractFields: cursor", () => {
  it("afterFileEdit synthesizes a coarse Edit tool name without touching the diff", () => {
    const fields = extractFields("cursor", "afterFileEdit", {
      conversation_id: "sess-1",
      model: "claude-sonnet-5",
      file_path: "/Users/jay/secret-project/file.ts",
      edits: [{ old_string: "password = 'x'", new_string: "password = 'y'" }],
    });
    expect(fields.toolName).toBe("Edit");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("sess-1");
    expect(fields.model).toBe("claude-sonnet-5");
  });

  it("afterAgentResponse never reads the response text", () => {
    const fields = extractFields("cursor", "afterAgentResponse", {
      conversation_id: "sess-2",
      text: "the assistant's full reply, never allowed to leave this process",
    });
    expect(fields.toolName).toBeUndefined();
    expect(fields.success).toBe(true);
    expect(fields).not.toHaveProperty("text");
  });

  it("stop maps status:completed to success and anything else to failure", () => {
    expect(extractFields("cursor", "stop", { status: "completed" }).success).toBe(true);
    expect(extractFields("cursor", "stop", { status: "aborted" }).success).toBe(false);
    expect(extractFields("cursor", "stop", { status: "error" }).success).toBe(false);
  });
});

describe("extractFields: copilot", () => {
  it("postToolUse reads camelCase fields and collapses MCP tool names", () => {
    const fields = extractFields("copilot", "postToolUse", {
      sessionId: "s-1",
      toolName: "mcp_github_search",
      toolResult: { resultType: "success", textResultForLlm: "should never be read" },
    });
    expect(fields.toolName).toBe("mcp_tool");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("s-1");
  });

  it("postToolUse also reads the VS Code-compatible snake_case shape", () => {
    const fields = extractFields("copilot", "postToolUse", {
      session_id: "s-2",
      tool_name: "read_file",
      tool_result: { result_type: "error" },
    });
    expect(fields.toolName).toBe("read_file");
    expect(fields.success).toBe(false);
    expect(fields.sessionId).toBe("s-2");
  });

  it("sessionEnd maps reason:complete to success", () => {
    expect(extractFields("copilot", "sessionEnd", { reason: "complete" }).success).toBe(true);
    expect(extractFields("copilot", "sessionEnd", { reason: "error" }).success).toBe(false);
    expect(extractFields("copilot", "sessionEnd", { reason: "user_exit" }).success).toBe(false);
  });

  it("errorOccurred is always success:false and never carries the error object", () => {
    const fields = extractFields("copilot", "errorOccurred", {
      sessionId: "s-3",
      error: { message: "stack trace and everything", name: "TypeError", stack: "at foo()" },
    });
    expect(fields.success).toBe(false);
    expect(fields).not.toHaveProperty("error");
  });
});

describe("extractFields: duration_ms passthrough", () => {
  it("picks a numeric duration when a payload happens to carry one", () => {
    expect(extractFields("copilot", "postToolUse", { duration_ms: 1234 }).durationMs).toBe(1234);
    expect(extractFields("copilot", "postToolUse", { durationMs: 5 }).durationMs).toBe(5);
  });

  it("omits duration_ms when absent or non-numeric", () => {
    expect(extractFields("copilot", "postToolUse", {}).durationMs).toBeUndefined();
    expect(extractFields("copilot", "postToolUse", { duration_ms: "not a number" }).durationMs).toBeUndefined();
  });

  it("an unknown platform yields an otherwise-empty field set", () => {
    expect(extractFields("unknown-platform", "whatever", { conversationId: "x" })).toEqual({
      durationMs: undefined,
    });
  });
});

describe("buildLogRecord", () => {
  it("only ever contains allowlisted attribute keys", () => {
    const record = buildLogRecord("antigravity", "PostToolUse", {
      toolName: "Bash",
      success: true,
      durationMs: 42,
      sessionId: "conv-1",
      model: "gemini-3-pro",
    });
    for (const key of attributeKeys(record)) {
      expect(ALLOWLIST_KEYS.has(key)).toBe(true);
    }
    expect(record.resourceLogs[0].resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "agent.platform", value: { stringValue: "antigravity" } },
        { key: "seat", value: { stringValue: "antigravity" } },
      ])
    );
    const logRecord = record.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body).toEqual({ stringValue: "antigravity.PostToolUse" });
    expect(logRecord.attributes).toEqual(
      expect.arrayContaining([
        { key: "event", value: { stringValue: "PostToolUse" } },
        { key: "tool.name", value: { stringValue: "Bash" } },
        { key: "success", value: { boolValue: true } },
        { key: "duration_ms", value: { intValue: "42" } },
        { key: "session.id", value: { stringValue: "conv-1" } },
        { key: "model", value: { stringValue: "gemini-3-pro" } },
      ])
    );
  });

  it("omits attributes for undefined fields instead of emitting null/empty values", () => {
    const record = buildLogRecord("cursor", "afterAgentResponse", { success: true });
    const logRecord = record.resourceLogs[0].scopeLogs[0].logRecords[0];
    const keys = logRecord.attributes.map((a) => a.key);
    expect(keys).toContain("event");
    expect(keys).toContain("success");
    expect(keys).not.toContain("tool.name");
    expect(keys).not.toContain("duration_ms");
    expect(keys).not.toContain("session.id");
    expect(keys).not.toContain("model");
  });

  it("never leaks forbidden content even when field values are adversarially stuffed with it", () => {
    // extractFields would never produce these in real use, but buildLogRecord
    // itself must not special-case or widen anything if it did.
    const record = buildLogRecord("cursor", "afterFileEdit", {
      toolName: "Edit",
      sessionId: "sess-1",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(/password|secret|api[_-]?key/i);
  });

  it("stamps a plausible current timeUnixNano", () => {
    const before = BigInt(Date.now()) * 1_000_000n;
    const record = buildLogRecord("copilot", "postToolUse", {});
    const after = BigInt(Date.now()) * 1_000_000n;
    const stamped = BigInt(record.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano);
    expect(stamped >= before && stamped <= after).toBe(true);
  });

  it("stamps a fresh 32/16-hex trace/span id pair on every record (required for Sentry to index the log -- see newTraceContext's comment)", () => {
    const a = buildLogRecord("copilot", "postToolUse", {}).resourceLogs[0].scopeLogs[0].logRecords[0];
    const b = buildLogRecord("copilot", "postToolUse", {}).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  it("accepts an injectable randomBytes for deterministic tests", () => {
    const fixed = (n) => Buffer.alloc(n, 0xab);
    const record = buildLogRecord("cursor", "stop", {}, fixed).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.traceId).toBe("ab".repeat(16));
    expect(record.spanId).toBe("ab".repeat(8));
  });
});

describe("noopReplyFor / NOOP_REPLIES", () => {
  it("antigravity's three wired events each have a fixed safe reply", () => {
    expect(noopReplyFor("antigravity", "PostToolUse")).toEqual({});
    expect(noopReplyFor("antigravity", "PostInvocation")).toEqual({});
    expect(noopReplyFor("antigravity", "Stop")).toEqual({ decision: "continue" });
  });

  it("cursor and copilot events have no special reply (fire-and-forget, print nothing)", () => {
    expect(noopReplyFor("cursor", "afterFileEdit")).toBeUndefined();
    expect(noopReplyFor("cursor", "afterAgentResponse")).toBeUndefined();
    expect(noopReplyFor("cursor", "stop")).toBeUndefined();
    expect(noopReplyFor("copilot", "postToolUse")).toBeUndefined();
    expect(noopReplyFor("copilot", "sessionEnd")).toBeUndefined();
    expect(noopReplyFor("copilot", "errorOccurred")).toBeUndefined();
  });

  it("NOOP_REPLIES only covers antigravity today", () => {
    expect(Object.keys(NOOP_REPLIES)).toEqual(["antigravity"]);
  });
});

describe("parsePayload", () => {
  it("parses a valid JSON object", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns {} for empty, whitespace, malformed, or non-object input", () => {
    expect(parsePayload("")).toEqual({});
    expect(parsePayload("   ")).toEqual({});
    expect(parsePayload("{not json")).toEqual({});
    expect(parsePayload("42")).toEqual({});
    expect(parsePayload("[1,2,3]")).toEqual({});
    expect(parsePayload("null")).toEqual({});
  });
});

describe("postOtlp", () => {
  it("posts once with the auth header and never throws on success", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    });
    await postOtlp(
      { endpoint: "https://example.sentry.io/v1/logs", headerName: "x-sentry-auth", headerValue: "abc" },
      { hello: "world" },
      fetchImpl
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.sentry.io/v1/logs");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-sentry-auth"]).toBe("abc");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ hello: "world" });
  });

  it("swallows a network error without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      postOtlp({ endpoint: "https://x", headerName: "h", headerValue: "v" }, {}, fetchImpl)
    ).resolves.toBeUndefined();
  });

  it("aborts and swallows the abort instead of hanging when fetch never resolves", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          })
      );
      const promise = postOtlp({ endpoint: "https://x", headerName: "h", headerValue: "v" }, {}, fetchImpl);
      await vi.advanceTimersByTimeAsync(2100);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("main", () => {
  it("no-ops silently (no network call) when credentials are not configured", async () => {
    const postOtlpImpl = vi.fn();
    await main(
      ["node", "agent-hook-otlp.mjs", "cursor", "afterFileEdit"],
      // A real credentials file may exist on this machine (this repo's own
      // setup writes one); point the file fallback at a path that never
      // exists so this test exercises the true "nothing configured" path
      // regardless of the host machine's state.
      { AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/nonexistent/agent-hook-otlp-sentry.json" },
      {
        readStdin: async () => JSON.stringify({ conversation_id: "s", model: "m" }),
        postOtlp: postOtlpImpl,
      }
    );
    expect(postOtlpImpl).not.toHaveBeenCalled();
  });

  it("no-ops on an unrecognised platform without reading stdin", async () => {
    const readStdinImpl = vi.fn();
    const postOtlpImpl = vi.fn();
    await main(["node", "agent-hook-otlp.mjs", "not-a-real-platform", "SomeEvent"], {}, {
      readStdin: readStdinImpl,
      postOtlp: postOtlpImpl,
    });
    expect(readStdinImpl).not.toHaveBeenCalled();
    expect(postOtlpImpl).not.toHaveBeenCalled();
  });

  it("posts a log record end to end when credentials are present", async () => {
    const postOtlpImpl = vi.fn(async () => {});
    const env = {
      AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
      AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
      AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=abc",
    };
    await main(
      ["node", "agent-hook-otlp.mjs", "copilot", "postToolUse"],
      env,
      {
        readStdin: async () => JSON.stringify({ sessionId: "s-9", toolName: "read_file", toolResult: { resultType: "success" } }),
        postOtlp: postOtlpImpl,
      }
    );
    expect(postOtlpImpl).toHaveBeenCalledTimes(1);
    const [credentials, body] = postOtlpImpl.mock.calls[0];
    expect(credentials.endpoint).toBe("https://example.sentry.io/v1/logs");
    const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.attributes).toEqual(
      expect.arrayContaining([{ key: "session.id", value: { stringValue: "s-9" } }])
    );
  });

  it("never throws even when readStdin itself rejects", async () => {
    await expect(
      main(["node", "agent-hook-otlp.mjs", "cursor", "stop"], {}, {
        readStdin: async () => {
          throw new Error("pipe closed");
        },
      })
    ).resolves.toBeUndefined();
  });
});

describe("agent-hook-otlp.mjs as a real subprocess", () => {
  let server;
  let serverUrl;
  let receivedRequests;
  let tempDir;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function startServer() {
    receivedRequests = [];
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        receivedRequests.push({
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    serverUrl = `http://127.0.0.1:${port}/otlp/v1/logs`;
  }

  function run(args, { input = "{}", env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it("posts allowlisted fields only and prints the fixed antigravity Stop reply", async () => {
    await startServer();
    const payload = {
      conversationId: "conv-secret-session",
      modelName: "gemini-3-pro",
      error: "",
      fullyIdle: true,
      // Adversarial: if the shim ever widened its extraction, these must
      // never reach the wire.
      transcriptPath: "/Users/jay/very/private/transcript.json",
      workspacePaths: ["/Users/jay/private-repo"],
    };
    const { code, stdout } = await run(["antigravity", "Stop"], {
      input: JSON.stringify(payload),
      env: {
        AGENT_HOOK_OTLP_ENDPOINT: serverUrl,
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe(JSON.stringify({ decision: "continue" }));

    // Give the fire-and-forget POST a moment to land after process exit.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedRequests).toHaveLength(1);
    const [request] = receivedRequests;
    expect(request.headers["x-sentry-auth"]).toBe("sentry sentry_key=test");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).not.toMatch(/transcriptPath|workspacePaths|private-repo|private\/transcript/);
    const parsed = JSON.parse(request.body);
    for (const key of attributeKeys(parsed)) {
      expect(ALLOWLIST_KEYS.has(key)).toBe(true);
    }
  });

  it("exits 0 and prints nothing extra for a fire-and-forget cursor event, even with no server listening", async () => {
    const { code, stdout, stderr } = await run(["cursor", "afterAgentResponse"], {
      input: JSON.stringify({ conversation_id: "s", text: "never sent" }),
      env: {
        AGENT_HOOK_OTLP_ENDPOINT: "http://127.0.0.1:1/unreachable",
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("exits 0 with malformed stdin and no configured credentials", async () => {
    const { code, stdout } = await run(["copilot", "postToolUse"], {
      input: "not json at all {{{",
      env: {
        AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/nonexistent/agent-hook-otlp-sentry.json",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("reads credentials from a chmod-600 file when env vars are absent", async () => {
    await startServer();
    tempDir = await mkdtemp(join(tmpdir(), "agent-hook-otlp-"));
    const credsPath = join(tempDir, "creds.json");
    await writeFile(
      credsPath,
      JSON.stringify({ endpoint: serverUrl, headerName: "x-sentry-auth", headerValue: "sentry sentry_key=fromfile" }),
      { mode: 0o600 }
    );
    const { code, stdout } = await run(["cursor", "afterFileEdit"], {
      input: JSON.stringify({ conversation_id: "s-file", model: "claude-sonnet-5" }),
      env: { AGENT_HOOK_OTLP_CREDENTIALS_FILE: credsPath },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].headers["x-sentry-auth"]).toBe("sentry sentry_key=fromfile");
  });
});
