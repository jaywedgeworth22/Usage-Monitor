import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";

export function parseCollectorArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const debug = argv.includes("--debug");
  let days = null;
  let sinceIso = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = Number.parseInt(argv[i + 1], 10);
    }
    if (argv[i] === "--since" && argv[i + 1]) {
      sinceIso = argv[i + 1];
    }
  }
  let since = null;
  if (sinceIso) {
    since = new Date(sinceIso);
  } else if (Number.isFinite(days) && days > 0) {
    since = new Date(Date.now() - days * 86_400_000);
  } else {
    const now = new Date();
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  if (Number.isNaN(since.getTime())) {
    throw new Error(`Invalid --since ${sinceIso}`);
  }
  return { dryRun, debug, since };
}

export async function walkFiles(root, { suffix, name } = {}) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (suffix && !entry.name.endsWith(suffix)) continue;
      if (name && entry.name !== name) continue;
      out.push(full);
    }
  }
  await walk(root);
  return out;
}

export async function readIfFresh(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function sessionKeyFor(root, filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}
