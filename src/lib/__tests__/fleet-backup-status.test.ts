import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFleetBackupStatus,
  resetFleetBackupStatusCacheForTests,
} from "../fleet-backup-status";

describe("fetchFleetBackupStatus", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetFleetBackupStatusCacheForTests();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unexpected fetch");
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetFleetBackupStatusCacheForTests();
  });

  it("returns unconfigured B2 rows when monitor credentials are missing", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "");
    vi.stubEnv("B2_MONITOR_KEY_ID", "");
    vi.stubEnv("B2_MONITOR_APPLICATION_KEY", "");
    vi.stubEnv("FLEET_ST_HEALTH_URL", "");

    const payload = await fetchFleetBackupStatus();
    expect(payload.configured).toBe(false);
    expect(payload.apps).toHaveLength(3);
    expect(payload.apps.map((a) => a.id)).toEqual([
      "usage-monitor",
      "socratic-trade",
      "congress-trade",
    ]);
    const um = payload.apps.find((a) => a.id === "usage-monitor");
    expect(um?.self).toBe(true);
    expect(um?.locations.some((l) => l.id === "local")).toBe(true);
    expect(um?.locations.some((l) => l.id === "r2-historic")).toBe(true);
    expect(
      payload.apps
        .find((a) => a.id === "socratic-trade")
        ?.locations.find((l) => l.id === "b2-full-dump")?.reason
    ).toBe("b2_unconfigured");
  });

  it("inventories B2 prefixes and peer litestream age when credentials work", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    vi.stubEnv(
      "FLEET_ST_HEALTH_URL",
      "https://example.test/st/api/health"
    );

    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return new Response(
            JSON.stringify({
              accountId: "acct",
              apiUrl: "https://api003.backblazeb2.com",
              authorizationToken: "tok",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_buckets")) {
          return new Response(
            JSON.stringify({
              buckets: [
                {
                  bucketId: "b-um",
                  bucketName: "jays-usage-monitor-eu",
                },
                {
                  bucketId: "b-st",
                  bucketName: "jays-socratic-trade-eu",
                },
                {
                  bucketId: "b-ct",
                  bucketName: "jays-congress-trade-eu",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_file_names")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            bucketId?: string;
            prefix?: string;
          };
          const files =
            body.prefix === "hetzner/"
              ? [
                  {
                    action: "upload",
                    contentLength: 1_000_000,
                    uploadTimestamp: now - 2 * 3600 * 1000,
                    fileName: `${body.prefix}dump.db`,
                  },
                ]
              : body.prefix?.includes("trading-live") ||
                  body.prefix?.includes("api-usage-monitor") ||
                  body.prefix?.includes("congress-trade")
                ? [
                    {
                      action: "upload",
                      contentLength: 500,
                      uploadTimestamp: now - 60_000,
                      fileName: `${body.prefix}ltx`,
                    },
                  ]
                : [];
          return new Response(JSON.stringify({ files, nextFileName: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("example.test/st/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: 42,
                  litestreamStatus: "replicating",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchFleetBackupStatus();
    expect(payload.configured).toBe(true);

    const st = payload.apps.find((a) => a.id === "socratic-trade");
    expect(st).toBeTruthy();
    const stDump = st!.locations.find((l) => l.id === "b2-full-dump");
    expect(stDump?.present).toBe(true);
    expect(stDump?.ok).toBe(true);
    const stPeer = st!.locations.find((l) => l.id === "peer-litestream");
    expect(stPeer?.latestAgeSeconds).toBe(42);
    expect(stPeer?.ok).toBe(true);
    const stLtx = st!.locations.find((l) => l.id === "b2-litestream");
    expect(stLtx).toBeUndefined();

    const ct = payload.apps.find((a) => a.id === "congress-trade");
    const ctLtx = ct!.locations.find((l) => l.id === "b2-litestream");
    expect(ctLtx?.present).toBe(true);
    expect(ctLtx?.ok).toBe(true);
    const ctDump = ct!.locations.find((l) => l.id === "b2-full-dump");
    expect(ctDump?.present).toBe(true);
  });
});
