import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { FsNode } from "./protocol.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".duet",
  ".claude-config",
  "dist",
  ".next",
  ".cache",
]);

const MAX_FILE_BYTES = 200 * 1024; // 200 KB viewer cap
const CHANGED_TTL_MS = 8000;       // how long a file stays flagged "changed"

// Heuristic: treat a file as binary if it contains a NUL byte in the first 4 KB.
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Watches a single root directory (the candidate's working dir) and produces
 * project-tree snapshots. Everything is confined to `root`: paths are stored
 * relative to it, and file reads are validated to stay within it (no `..`,
 * no symlink escapes).
 */
export class FsWatcher extends EventEmitter {
  readonly root: string;
  private watcher?: FSWatcher;
  private changed = new Map<string, number>(); // absolute path -> expiry ms... (monotonic-ish)
  private rebuildTimer?: ReturnType<typeof setTimeout>;
  private tick = 0;

  constructor(root: string) {
    super();
    this.root = fs.realpathSync(root);
  }

  start(): void {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 12,
      ignored: (p: string) => {
        const base = path.basename(p);
        return IGNORE_DIRS.has(base);
      },
    });
    const mark = (p: string) => {
      this.changed.set(p, ++this.tick);
      setTimeout(() => this.scheduleRebuild(), CHANGED_TTL_MS);
      this.scheduleRebuild();
    };
    this.watcher
      .on("add", mark)
      .on("change", mark)
      .on("unlink", mark)
      .on("addDir", mark)
      .on("unlinkDir", mark)
      .on("ready", () => this.scheduleRebuild());
    // Emit an initial snapshot promptly even before chokidar is "ready".
    this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      try {
        this.emit("tree", this.buildTree());
      } catch {
        /* transient fs races are fine — next event rebuilds */
      }
    }, 150);
  }

  private isRecentlyChanged(absPath: string): boolean {
    return this.changed.has(absPath);
  }

  private buildTree(): FsNode {
    const walk = (absDir: string, relDir: string): FsNode => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const children: FsNode[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") {
          // hide dotfiles/dirs (keeps the panel focused on project source)
          if (IGNORE_DIRS.has(e.name) || e.name === ".duet" || e.name.startsWith(".")) continue;
        }
        if (IGNORE_DIRS.has(e.name)) continue;
        const absChild = path.join(absDir, e.name);
        const relChild = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          children.push(walk(absChild, relChild));
        } else if (e.isFile()) {
          children.push({
            name: e.name,
            path: relChild,
            type: "file",
            changed: this.isRecentlyChanged(absChild) || undefined,
          });
        }
      }
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        name: relDir ? path.basename(relDir) : path.basename(this.root),
        path: relDir,
        type: "dir",
        changed: this.isRecentlyChanged(absDir) || undefined,
        children,
      };
    };
    return walk(this.root, "");
  }

  /**
   * Resolve a relative path to an absolute one, verifying it stays inside the
   * root. Returns null if the path escapes the confined directory.
   */
  resolveInside(relPath: string): string | null {
    const abs = path.resolve(this.root, relPath);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      real = abs; // may not exist yet; still enforce the prefix check below
    }
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (real !== this.root && !real.startsWith(rootWithSep)) return null;
    return real;
  }

  /**
   * Read a file confined to the root. Returns content (size-capped, text-only)
   * or an error string. Never reads outside the candidate directory.
   */
  async readFile(relPath: string): Promise<{ content: string; truncated: boolean; error?: string }> {
    const abs = this.resolveInside(relPath);
    if (!abs) return { content: "", truncated: false, error: "Path is outside the project directory." };
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return { content: "", truncated: false, error: "Not a file." };
      const fh = await fsp.open(abs, "r");
      try {
        const size = Math.min(stat.size, MAX_FILE_BYTES);
        const buf = Buffer.alloc(size);
        await fh.read(buf, 0, size, 0);
        if (looksBinary(buf)) return { content: "", truncated: false, error: "Binary file — not shown." };
        return { content: buf.toString("utf-8"), truncated: stat.size > MAX_FILE_BYTES };
      } finally {
        await fh.close();
      }
    } catch (err) {
      return { content: "", truncated: false, error: `Cannot read file: ${err instanceof Error ? err.message : err}` };
    }
  }

  stop(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.watcher?.close().catch(() => {});
  }
}
