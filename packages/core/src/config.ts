import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION, validateConfig } from "@resolvroom/protocol";
import type { DaemonConfig, PermissionProfile } from "@resolvroom/protocol";
import { peerMatches } from "./names.js";

export type PeerEntry = DaemonConfig["peers"][number];

/** `RESOLVROOM_HOME` or `~/.resolvroom`. Everything the daemon stores lives here. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESOLVROOM_HOME && env.RESOLVROOM_HOME.length > 0
    ? env.RESOLVROOM_HOME
    : join(homedir(), ".resolvroom");
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigStore {
  constructor(readonly home: string) {}

  get path(): string {
    return join(this.home, "config.json");
  }

  get socketPath(): string {
    return join(this.home, "daemon.sock");
  }

  get logDir(): string {
    return join(this.home, "logs");
  }

  /** Reads the file on every call so `peer allow` takes effect without restarting the daemon. */
  load(): DaemonConfig {
    if (!existsSync(this.path)) {
      return { v: PROTOCOL_VERSION, peers: [] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new ConfigError(`${this.path} is not valid JSON: ${(err as Error).message}`);
    }
    const result = validateConfig(raw);
    if (!result.ok) {
      throw new ConfigError(`${this.path} is invalid: ${result.errors.join("; ")}`);
    }
    return result.value;
  }

  save(config: DaemonConfig): void {
    const result = validateConfig(config);
    if (!result.ok) {
      throw new ConfigError(`refusing to write an invalid config: ${result.errors.join("; ")}`);
    }
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(dirname(this.path), 0o700);
  }

  findPeer(name: string): PeerEntry | undefined {
    return this.load().peers.find((p) => peerMatches(p.peer, name));
  }

  upsertPeer(peer: string, profile: PermissionProfile, endpoint?: string, now: Date = new Date()): PeerEntry {
    const config = this.load();
    const existing = config.peers.findIndex((p) => peerMatches(p.peer, peer));
    const entry: PeerEntry = {
      peer,
      profile,
      added_at: existing >= 0 ? (config.peers[existing]?.added_at ?? now.toISOString()) : now.toISOString(),
      ...(endpoint ? { endpoint } : {}),
    };
    if (existing >= 0) config.peers[existing] = entry;
    else config.peers.push(entry);
    this.save(config);
    return entry;
  }

  removePeer(name: string): boolean {
    const config = this.load();
    const next = config.peers.filter((p) => !peerMatches(p.peer, name));
    if (next.length === config.peers.length) return false;
    config.peers = next;
    this.save(config);
    return true;
  }
}
