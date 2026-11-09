import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Identity } from "@resolvroom/core";

/** Works out who is on the other end of a connection from the network, never from the message. */
export interface IdentityProvider {
  identify(req: IncomingMessage): Promise<Identity | null>;
}

export const DEV_PEER_HEADER = "x-resolvroom-dev-peer";
export const DEV_TAGS_HEADER = "x-resolvroom-dev-tags";

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost" || /^127\./.test(a);
}

/**
 * TESTING ONLY. Trusts headers sent by the caller, which is why it only answers connections that come from
 * loopback and the daemon refuses to start in this mode on any other interface.
 */
export class DevIdentityProvider implements IdentityProvider {
  async identify(req: IncomingMessage): Promise<Identity | null> {
    if (!isLoopback(req.socket.remoteAddress)) return null;
    const peer = req.headers[DEV_PEER_HEADER];
    if (typeof peer !== "string" || peer.length === 0) return null;
    const rawTags = req.headers[DEV_TAGS_HEADER];
    const tags = typeof rawTags === "string" ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    return { peer, tags };
  }
}

export type Exec = (file: string, args: string[]) => Promise<string>;

export const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** Parses `tailscale whois --json <ip>`. The name is the MagicDNS short name when available. */
export function parseWhois(json: string): Identity | null {
  let data: { Node?: { ComputedName?: string; Name?: string; Tags?: string[] | null } };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const node = data.Node;
  if (!node) return null;
  const name = node.ComputedName || (node.Name ? node.Name.replace(/\.$/, "") : "");
  if (!name) return null;
  return { peer: name, tags: Array.isArray(node.Tags) ? node.Tags : [] };
}

export interface TailscaleSelf {
  name: string;
  ips: string[];
  tags: string[];
}

/** Parses `tailscale status --json` for this machine. */
export function parseStatusSelf(json: string): TailscaleSelf | null {
  let data: { Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Tags?: string[] | null } };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const self = data.Self;
  if (!self) return null;
  const name = self.DNSName ? self.DNSName.split(".")[0] : self.HostName;
  if (!name) return null;
  return { name, ips: self.TailscaleIPs ?? [], tags: Array.isArray(self.Tags) ? self.Tags : [] };
}

export async function tailscaleSelf(exec: Exec = defaultExec): Promise<TailscaleSelf> {
  let out: string;
  try {
    out = await exec("tailscale", ["status", "--json"]);
  } catch (err) {
    throw new Error(`could not run "tailscale status": ${(err as Error).message}. Is Tailscale installed and logged in?`);
  }
  const self = parseStatusSelf(out);
  if (!self) throw new Error("could not read this machine from `tailscale status --json`. Is Tailscale logged in?");
  return self;
}

export class TailscaleIdentityProvider implements IdentityProvider {
  private readonly cache = new Map<string, { at: number; identity: Identity | null }>();

  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly ttlMs = 10_000,
  ) {}

  async identify(req: IncomingMessage): Promise<Identity | null> {
    const raw = req.socket.remoteAddress;
    if (!raw) return null;
    const ip = raw.replace(/^::ffff:/, "");
    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.identity;
    let identity: Identity | null = null;
    try {
      identity = parseWhois(await this.exec("tailscale", ["whois", "--json", ip]));
    } catch {
      identity = null;
    }
    this.cache.set(ip, { at: Date.now(), identity });
    return identity;
  }
}
