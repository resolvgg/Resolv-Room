import { randomInt, timingSafeEqual } from "node:crypto";
import type { ConfigStore, Identity } from "@resolvroom/core";
import type { PermissionProfile } from "@resolvroom/protocol";

/** No 0/O/1/I/L, so a code read aloud or typed from a screen is hard to get wrong. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIR_TAG = "tag:resolvroom";

export function generateCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const DEFAULT_PAIR_PROFILE: PermissionProfile = {
  mode: "ask",
  capabilities: { read: true, write: false, exec: false, network: false },
};

export interface PairingOptions {
  store: ConfigStore;
  /** Require the caller's node to carry tag:resolvroom (true on a real tailnet). */
  requireTag: boolean;
  /** Dev identity only: accept the endpoint the caller says to reply to. */
  trustReplyEndpoint?: boolean;
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export type PairingState = "idle" | "waiting" | "paired" | "expired" | "locked";

export interface PairingStatus {
  state: PairingState;
  peer?: string;
  expires_at?: string;
}

export type PairVerdict = { ok: true; peer: string } | { ok: false; locked: boolean };

/**
 * One pairing window at a time: a single-use code, valid for 5 minutes, 3 wrong tries.
 * A successful pairing only adds the other node as `ask`, read-only; it never raises an existing profile.
 */
export class PairingManager {
  private code: string | undefined;
  private expiresAt = 0;
  private attemptsLeft = 0;
  private state: PairingState = "idle";
  private pairedPeer: string | undefined;

  constructor(private readonly o: PairingOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  start(): { code: string; expiresAt: string } {
    this.code = generateCode();
    this.expiresAt = this.now() + (this.o.ttlMs ?? 5 * 60_000);
    this.attemptsLeft = this.o.maxAttempts ?? 3;
    this.state = "waiting";
    this.pairedPeer = undefined;
    return { code: this.code, expiresAt: new Date(this.expiresAt).toISOString() };
  }

  cancel(): void {
    this.code = undefined;
    this.state = "idle";
  }

  status(): PairingStatus {
    if (this.state === "waiting" && this.now() >= this.expiresAt) {
      this.code = undefined;
      this.state = "expired";
    }
    return {
      state: this.state,
      ...(this.pairedPeer ? { peer: this.pairedPeer } : {}),
      ...(this.state === "waiting" ? { expires_at: new Date(this.expiresAt).toISOString() } : {}),
    };
  }

  verify(identity: Identity, code: string, replyEndpoint?: string): PairVerdict {
    if (this.status().state !== "waiting" || !this.code) return { ok: false, locked: this.state === "locked" };
    this.attemptsLeft--;
    const a = Buffer.from(normalizeCode(code).padEnd(16, "-"));
    const b = Buffer.from(normalizeCode(this.code).padEnd(16, "-"));
    const sameCode = a.length === b.length && timingSafeEqual(a, b);
    const tagOk = !this.o.requireTag || identity.tags.includes(PAIR_TAG);
    if (!(sameCode && tagOk)) {
      if (this.attemptsLeft <= 0) {
        this.code = undefined;
        this.state = "locked";
        return { ok: false, locked: true };
      }
      return { ok: false, locked: false };
    }
    const existing = this.o.store.findPeer(identity.peer);
    if (!existing) {
      const endpoint = this.o.trustReplyEndpoint && replyEndpoint ? replyEndpoint : undefined;
      this.o.store.upsertPeer(identity.peer, DEFAULT_PAIR_PROFILE, endpoint);
    }
    this.code = undefined;
    this.state = "paired";
    this.pairedPeer = identity.peer;
    return { ok: true, peer: identity.peer };
  }
}
