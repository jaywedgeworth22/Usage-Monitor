import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCollectorToken } from "../lib/run-session-token-collector.mjs";

const dirs = [];
function secretsFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "collector-token-"));
  dirs.push(dir);
  const path = join(dir, "global-api-keys");
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("resolveCollectorToken", () => {
  it("prefers a scoped name in the secrets file over an unscoped name in the environment", () => {
    const secretsPath = secretsFile('CODEX_INGEST_TOKEN="scoped-file"\nUSAGE_INGEST_TOKEN="unscoped-file"\n');
    const token = resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
      env: { USAGE_INGEST_TOKEN: "unscoped-env" },
      secretsPath,
    });
    expect(token).toBe("scoped-file");
  });

  it("prefers the environment for the same name", () => {
    const secretsPath = secretsFile('CODEX_INGEST_TOKEN="scoped-file"\n');
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: { CODEX_INGEST_TOKEN: "scoped-env" }, secretsPath }),
    ).toBe("scoped-env");
  });

  it("falls back in order and returns null when nothing matches", () => {
    const secretsPath = secretsFile("export USAGE_INGEST_TOKEN=unscoped-file\n");
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env: {}, secretsPath })).toBe(
      "unscoped-file",
    );
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, secretsPath })).toBeNull();
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, secretsPath: join(tmpdir(), "missing-keys-file") }),
    ).toBeNull();
  });
});
