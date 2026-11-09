import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isAlwaysDenied, normalizePath, PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { DaemonConfig } from "@resolvroom/protocol";
import { inboxDirFor, peerMatches } from "@resolvroom/core";
import type { Identity, LogStore, Prompter, TransferSummary } from "@resolvroom/core";

/* ─────────────────────────────── wire format ─────────────────────────────── */

export interface TransferFile {
  /** Relative POSIX path under the transfer root. */
  path: string;
  size: number;
  /** Hex SHA-256 of the content. */
  sha256: string;
  /** True when the file was executable on the sender. */
  exec?: boolean;
}

export interface TransferOffer {
  v: string;
  transfer_id: string;
  root: string;
  message?: string;
  files: TransferFile[];
  total_bytes: number;
}

export const TRANSFER_TOKEN_HEADER = "x-resolvroom-transfer-token";

export const TRANSFER_LIMITS = {
  maxFiles: 50_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxPathLength: 1024,
  maxMessage: 2000,
} as const;

/** A relative path that cannot escape the folder it is joined to. */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > TRANSFER_LIMITS.maxPathLength) return false;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg.length <= 255 && seg !== "." && seg !== "..");
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "files";
}

export function validateOffer(json: unknown): TransferOffer | string {
  if (typeof json !== "object" || json === null) return "body must be an object";
  const b = json as Record<string, unknown>;
  if (b.v !== PROTOCOL_VERSION) return `unsupported protocol version ${String(b.v)}`;
  if (typeof b.transfer_id !== "string" || !/^[0-9a-f-]{36}$/.test(b.transfer_id)) return "transfer_id must be a UUID";
  if (typeof b.root !== "string" || b.root.length === 0 || b.root.length > 200) return "root is required";
  if (b.message !== undefined && (typeof b.message !== "string" || b.message.length > TRANSFER_LIMITS.maxMessage)) return "message is too long";
  if (!Array.isArray(b.files) || b.files.length === 0) return "files must be a non-empty list";
  if (b.files.length > TRANSFER_LIMITS.maxFiles) return `too many files (max ${TRANSFER_LIMITS.maxFiles})`;
  const seen = new Set<string>();
  let total = 0;
  const files: TransferFile[] = [];
  for (const f of b.files as unknown[]) {
    const x = f as Record<string, unknown>;
    if (typeof x?.path !== "string" || !isSafeRelativePath(x.path)) return `unsafe path: ${String(x?.path).slice(0, 100)}`;
    const key = x.path.toLowerCase();
    if (seen.has(key)) return `duplicate path: ${x.path}`;
    seen.add(key);
    if (typeof x.size !== "number" || !Number.isSafeInteger(x.size) || x.size < 0) return `bad size for ${x.path}`;
    if (typeof x.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.sha256)) return `bad sha256 for ${x.path}`;
    total += x.size;
    files.push({ path: x.path, size: x.size, sha256: x.sha256, ...(x.exec === true ? { exec: true } : {}) });
  }
  // A path that is also a folder of another path ("a" and "a/b") cannot both be written.
  for (const f of files) {
    const parts = f.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) return `path conflict: ${f.path}`;
  }
  if (total > TRANSFER_LIMITS.maxBytes) return `too large (max ${TRANSFER_LIMITS.maxBytes} bytes)`;
  if (b.total_bytes !== total) return "total_bytes does not match the files";
  return { v: PROTOCOL_VERSION, transfer_id: b.transfer_id, root: b.root, ...(typeof b.message === "string" ? { message: b.message } : {}), files, total_bytes: total };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ─────────────────────────────── receiving ─────────────────────────────── */

export class TransferError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

interface Incoming {
  offer: TransferOffer;
  peer: string;
  token: string;
  staging: string;
  dest: string;
  received: boolean[];
  idle: NodeJS.Timeout;
}

export interface TransferReceiverOptions {
  inbox: string;
  config: () => DaemonConfig;
  prompter: Prompter;
  logs?: LogStore;
  /** Seconds the human has to answer. Default: the config's ask.timeout_s or 120. */
  timeoutS?: number;
  /** An unfinished transfer is dropped after this long without progress. Default 30 minutes. */
  idleMs?: number;
  maxConcurrent?: number;
}

/**
 * Receives files from allowlisted peers. Every offer is shown to the local human; nothing is written before they
 * say yes. Files land in a fresh folder under the inbox (inbox/<peer>/<time>-<root>/), never anywhere else, and are
 * checked against the announced size and SHA-256 before the folder appears.
 */
export class TransferReceiver {
  private readonly active = new Map<string, Incoming>();

  constructor(private readonly o: TransferReceiverOptions) {}

  async offer(identity: Identity, raw: unknown): Promise<{ token: string; dest: string }> {
    const entry = this.o.config().peers.find((p) => peerMatches(p.peer, identity.peer));
    if (!entry) throw new TransferError(403, "not_allowed", `${identity.peer} is not on the allowlist`);
    const offer = validateOffer(raw);
    if (typeof offer === "string") throw new TransferError(400, "protocol_violation", offer);
    if (this.active.has(offer.transfer_id)) throw new TransferError(409, "protocol_violation", "transfer id already in use");
    if (this.active.size >= (this.o.maxConcurrent ?? 3)) throw new TransferError(429, "busy", "too many transfers in progress");

    const peerDir = inboxDirFor(this.o.inbox, identity.peer);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let dest = join(peerDir, `${stamp}-${safeName(offer.root)}`);
    for (let i = 2; existsSync(dest); i++) dest = join(peerDir, `${stamp}-${safeName(offer.root)}-${i}`);
    const timeoutS = this.o.timeoutS ?? entry.profile.ask?.timeout_s ?? 120;
    const summary: TransferSummary = {
      files: offer.files.length,
      bytes: offer.total_bytes,
      root: offer.root,
      dest,
      sample: offer.files.slice(0, 8).map((f) => f.path),
      ...(offer.message ? { message: offer.message } : {}),
    };
    const log = (event: string, detail: Record<string, unknown>): void =>
      this.o.logs?.decision({ session_id: offer.transfer_id, peer: identity.peer, event, detail });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutS * 1000);
    let answer: "allow" | "deny" = "deny";
    try {
      answer = await Promise.race([
        this.o.prompter.approve({
          peer: identity.peer,
          sessionId: offer.transfer_id,
          goal: offer.message ?? `receive ${offer.root}`,
          proposal: summary.sample.join("\n"),
          mode: "ask",
          capabilities: { read: false, write: false, exec: false, network: false },
          access: `save ${offer.files.length} files (${formatBytes(offer.total_bytes)}) to ${dest}`,
          timeoutS,
          transfer: summary,
          signal: ctl.signal,
        }),
        new Promise<"deny">((r) => ctl.signal.addEventListener("abort", () => r("deny"), { once: true })),
      ]);
    } catch {
      answer = "deny";
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    log("transfer.offer", { root: offer.root, files: offer.files.length, bytes: offer.total_bytes, answer });
    if (answer !== "allow") throw new TransferError(403, "declined", "the owner of that machine declined the transfer");

    const staging = join(this.o.inbox, ".incoming", offer.transfer_id);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString("hex");
    const inc: Incoming = { offer, peer: identity.peer, token, staging, dest, received: offer.files.map(() => false), idle: setTimeout(() => undefined, 0) };
    this.active.set(offer.transfer_id, inc);
    this.touch(inc);
    return { token, dest };
  }

  private touch(inc: Incoming): void {
    clearTimeout(inc.idle);
    inc.idle = setTimeout(() => this.drop(inc.offer.transfer_id), this.o.idleMs ?? 30 * 60_000);
    inc.idle.unref();
  }

  private drop(id: string): void {
    const inc = this.active.get(id);
    if (!inc) return;
    clearTimeout(inc.idle);
    this.active.delete(id);
    rmSync(inc.staging, { recursive: true, force: true });
  }

  private get(identity: Identity, id: string, token: string | undefined): Incoming {
    const inc = this.active.get(id);
    if (!inc || !peerMatches(inc.peer, identity.peer)) throw new TransferError(404, "not_found", "unknown transfer");
    const a = Buffer.from(token ?? "");
    const b = Buffer.from(inc.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new TransferError(403, "permission_denied", "bad transfer token");
    return inc;
  }

  async putFile(identity: Identity, id: string, index: number, token: string | undefined, body: AsyncIterable<Buffer> & Readable): Promise<void> {
    const inc = this.get(identity, id, token);
    const f = inc.offer.files[index];
    if (!f) throw new TransferError(400, "protocol_violation", "bad file index");
    const target = join(inc.staging, ...f.path.split("/"));
    if (!target.startsWith(inc.staging + sep)) throw new TransferError(400, "protocol_violation", "unsafe path");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(target, { mode: f.exec ? 0o755 : 0o644 });
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > f.size) throw new TransferError(400, "protocol_violation", `${f.path} is larger than announced`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
      await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
    } catch (err) {
      out.destroy();
      rmSync(target, { force: true });
      throw err;
    }
    if (size !== f.size || hash.digest("hex") !== f.sha256) {
      rmSync(target, { force: true });
      throw new TransferError(400, "protocol_violation", `${f.path} does not match its announced size or hash`);
    }
    inc.received[index] = true;
    this.touch(inc);
  }

  complete(identity: Identity, id: string, token: string | undefined): { dest: string; files: number; bytes: number } {
    const inc = this.get(identity, id, token);
    const missing = inc.received.filter((r) => !r).length;
    if (missing > 0) throw new TransferError(400, "protocol_violation", `${missing} file(s) not received yet`);
    mkdirSync(dirname(inc.dest), { recursive: true, mode: 0o700 });
    renameSync(inc.staging, inc.dest);
    clearTimeout(inc.idle);
    this.active.delete(id);
    this.o.logs?.decision({ session_id: id, peer: inc.peer, event: "transfer.complete", detail: { dest: inc.dest, files: inc.offer.files.length, bytes: inc.offer.total_bytes } });
    return { dest: inc.dest, files: inc.offer.files.length, bytes: inc.offer.total_bytes };
  }

  close(): void {
    for (const id of [...this.active.keys()]) this.drop(id);
  }
}

/* ─────────────────────────────── sending ─────────────────────────────── */

/** Folders left out unless asked for: dependencies, builds and caches that the receiver can recreate. */
export const DEFAULT_EXCLUDES = ["node_modules", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "dist", "build", "out", "coverage", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", ".DS_Store"];

export interface ManifestOptions {
  home: string;
  includeGit?: boolean;
  includeDeps?: boolean;
  maxFiles?: number;
  maxBytes?: number;
}

export interface ManifestEntry extends TransferFile {
  abs: string;
}

export interface Manifest {
  root: string;
  entries: ManifestEntry[];
  totalBytes: number;
  skipped: { secrets: string[]; excluded: number; links: number; other: number };
}

export class ManifestError extends Error {}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * Lists what `send` would transfer. Secrets and system files (the hard deny list, .env, keys…) are never included,
 * whatever the flags; dependency/build folders and .git are left out by default; symlinks are not followed.
 */
export async function buildManifest(paths: string[], o: ManifestOptions): Promise<Manifest> {
  if (paths.length === 0) throw new ManifestError("nothing to send");
  const home = normalizePath(realpathSync(o.home));
  const maxFiles = Math.min(o.maxFiles ?? 20_000, TRANSFER_LIMITS.maxFiles);
  const maxBytes = Math.min(o.maxBytes ?? 1024 * 1024 * 1024, TRANSFER_LIMITS.maxBytes);
  const excludes = new Set([...(o.includeDeps ? [] : DEFAULT_EXCLUDES), ...(o.includeGit ? [] : [".git"])]);
  const out: Manifest = { root: "", entries: [], totalBytes: 0, skipped: { secrets: [], excluded: 0, links: 0, other: 0 } };
  const absList = paths.map((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new ManifestError(`${abs} does not exist`);
    const real = normalizePath(realpathSync(abs));
    if (real === "/" || real === home) throw new ManifestError(`refusing to send ${real} as a whole; pick a project folder`);
    if (isAlwaysDenied(real, home)) throw new ManifestError(`${real} holds secrets or system files and cannot be sent`);
    return real;
  });
  out.root = absList.length === 1 ? basename(absList[0] ?? "files") : "files";
  const add = async (abs: string, rel: string): Promise<void> => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.skipped.links++;
      return;
    }
    if (isAlwaysDenied(abs, home)) {
      out.skipped.secrets.push(rel);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (excludes.has(name)) {
          out.skipped.excluded++;
          continue;
        }
        await add(join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!st.isFile() || !isSafeRelativePath(rel)) {
      out.skipped.other++;
      return;
    }
    if (out.entries.length >= maxFiles) throw new ManifestError(`more than ${maxFiles} files; send a smaller folder`);
    out.totalBytes += st.size;
    if (out.totalBytes > maxBytes) throw new ManifestError(`more than ${formatBytes(maxBytes)}; send a smaller folder`);
    out.entries.push({ abs, path: rel, size: st.size, sha256: await sha256File(abs), ...(st.mode & 0o111 ? { exec: true } : {}) });
  };
  for (const abs of absList) {
    const st = statSync(abs);
    // One folder: its contents at the top. Several items, or a file: each under its own name.
    if (absList.length === 1 && st.isDirectory()) await add(abs, "");
    else await add(abs, basename(abs));
  }
  if (out.entries.length === 0) throw new ManifestError("no files left to send after filtering");
  return out;
}

export function offerFor(m: Manifest, message?: string): TransferOffer {
  return {
    v: PROTOCOL_VERSION,
    transfer_id: randomUUID(),
    root: m.root,
    ...(message ? { message: message.slice(0, TRANSFER_LIMITS.maxMessage) } : {}),
    files: m.entries.map(({ path, size, sha256, exec }) => ({ path, size, sha256, ...(exec ? { exec } : {}) })),
    total_bytes: m.totalBytes,
  };
}

/** Relative path of `p` under `root`, POSIX style (helper for callers that show paths). */
export function relPosix(root: string, p: string): string {
  return relative(root, p).split(sep).join("/");
}
