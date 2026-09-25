import { describe, expect, it, vi } from "vitest";

import { defaultDestPath, installFromOriginMain } from "../install-agent-hook-otlp.mjs";

describe("defaultDestPath", () => {
  it("points at a stable path under ~/.local/share, outside any git worktree", () => {
    const dest = defaultDestPath();
    expect(dest).toMatch(/\.local\/share\/agent-hook-otlp\/agent-hook-otlp\.mjs$/);
  });
});

describe("installFromOriginMain", () => {
  it("fetches origin/main, reads the file's content from it (never from the working tree), and writes it to dest", () => {
    const execFileSyncImpl = vi.fn((cmd, args, opts) => {
      if (args.includes("fetch")) return "";
      if (args.includes("show")) {
        expect(args).toEqual(["-C", "/repo", "show", "origin/main:scripts/agent-hook-otlp.mjs"]);
        return "// agent-hook-otlp fixture content\n";
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    });
    const written = [];
    const writeFileSyncImpl = vi.fn((path, content, opts) => written.push({ path, content, opts }));
    const mkdirSyncImpl = vi.fn();
    const chmodSyncImpl = vi.fn();
    const readFileSyncImpl = vi.fn(() => "// agent-hook-otlp fixture content\n");

    const result = installFromOriginMain(
      { repo: "/repo", dest: "/dest/agent-hook-otlp.mjs" },
      {
        execFileSync: execFileSyncImpl,
        writeFileSync: writeFileSyncImpl,
        mkdirSync: mkdirSyncImpl,
        chmodSync: chmodSyncImpl,
        readFileSync: readFileSyncImpl,
      }
    );

    expect(execFileSyncImpl).toHaveBeenCalledWith("git", ["-C", "/repo", "fetch", "-q", "origin", "main"], expect.any(Object));
    expect(mkdirSyncImpl).toHaveBeenCalledWith("/dest", { recursive: true });
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe("/dest/agent-hook-otlp.mjs");
    expect(written[0].content).toContain("agent-hook-otlp fixture content");
    expect(chmodSyncImpl).toHaveBeenCalledWith("/dest/agent-hook-otlp.mjs", 0o755);
    expect(result).toEqual({ dest: "/dest/agent-hook-otlp.mjs", size: expect.any(Number) });
  });

  it("throws rather than installing garbage when origin/main's content does not look like the real script", () => {
    const execFileSyncImpl = vi.fn((cmd, args) => (args.includes("show") ? "not the right file at all" : ""));
    expect(() =>
      installFromOriginMain(
        { repo: "/repo", dest: "/dest/agent-hook-otlp.mjs" },
        { execFileSync: execFileSyncImpl, writeFileSync: vi.fn(), mkdirSync: vi.fn(), chmodSync: vi.fn(), readFileSync: vi.fn() }
      )
    ).toThrow(/unexpected content/);
  });
});
