import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, resolvePermissions, validateEnvelope } from "@resolvroom/protocol";
import type {
  Address,
  DaemonConfig,
  EffectivePermissions,
  Envelope,
  Limits,
  Mode,
  SessionOpenPayload,
  SessionAcceptPayload,
  RejectReason,
} from "@resolvroom/protocol";
import {
  IdentityMismatchError,
  NotAllowedError,
  PeerUnavailableError,
  UnknownSessionError,
} from "./interfaces.js";
import type { AccessRequest, Identity, PeerClient, Prompter, Runner } from "./interfaces.js";
import type { LogStore, SessionLog } from "./logs.js";
import { peerMatches } from "./names.js";

export const CONSULT_DEFAULT_LIMITS = { max_rounds: 1, max_duration_s: 300, idle_timeout_s: 120 } as const;

export interface EngineOptions {
  /** This machine's own node name, used in `from.peer`. */
  selfName: string;
  /** Called on every use so allowlist changes apply immediately. */
  config: () => DaemonConfig;
  client: PeerClient;
  runner: Runner;
  prompter: Prompter;
  logs: LogStore;
  /** Maximum guest sessions running at once. Default 2. */
  maxConcurrentGuest?: number;
  /** Interval of `session.status: working` heartbeats while the agent runs. Default 15000. */
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
}

export interface ConsultOptions {
  peer: string;
  goal: string;
  proposal: string;
  modeCap?: Mode;
  limits?: Limits;
  signal?: AbortSignal;
}

export type ConsultStatus =
  | "solved"
  | "partial"
  | "unsolved"
  | "declined"
  | "rejected"
  | "failed"
  | "timeout"
  | "cancelled";

export interface ConsultOutcome {
  sessionId: string;
  peer: string;
  status: ConsultStatus;
  /** The answer when the peer replied, otherwise a readable explanation. */
  summary: string;
  effective?: SessionAcceptPayload["effective"];
  rejectReason?: RejectReason;
  durationMs: number;
}

type Waited = { kind: "env"; env: Envelope } | { kind: "timeout"; why: "idle" | "duration" } | { kind: "cancelled" };

class HostSession {
  private readonly queue: Envelope[] = [];
  private waiter: ((env: Envelope) => void) | undefined;
  private cancelWaiter: (() => void) | undefined;
  private paused = false;
  private cancelled = false;
  private seq = 0;
  readonly deadline: number;

  constructor(
    readonly id: string,
    readonly peer: string,
    readonly log: SessionLog,
    readonly idleMs: number,
    durationMs: number,
  ) {
    this.deadline = Date.now() + durationMs;
  }

  /** Stamps `seq` and writes the envelope to the host log. */
  record(env: Envelope, dir: "in" | "out"): Envelope {
    const stamped = { ...env, seq: this.seq++ } as Envelope;
    this.log.append(stamped, dir);
    return stamped;
  }

  push(env: Envelope): void {
    if (this.waiter) this.waiter(env);
    else this.queue.push(env);
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelWaiter?.();
  }

  private pull(): Promise<Waited> {
    return new Promise((resolve) => {
      if (this.cancelled) return resolve({ kind: "cancelled" });
      const queued = this.queue.shift();
      if (queued) return resolve({ kind: "env", env: queued });
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) return resolve({ kind: "timeout", why: "duration" });
      const idle = this.paused ? Number.POSITIVE_INFINITY : this.idleMs;
      const why = idle < remaining ? "idle" : "duration";
      const timer = setTimeout(
        () => {
          this.waiter = undefined;
          this.cancelWaiter = undefined;
          resolve({ kind: "timeout", why });
        },
        Math.min(idle, remaining),
      );
      this.waiter = (env) => {
        clearTimeout(timer);
        this.waiter = undefined;
        this.cancelWaiter = undefined;
        resolve({ kind: "env", env });
      };
      this.cancelWaiter = () => {
        clearTimeout(timer);
        this.waiter = undefined;
        this.cancelWaiter = undefined;
        resolve({ kind: "cancelled" });
      };
    });
  }

  /**
   * Waits for one of `types` (or an error / close from the peer). `session.status` envelopes reset the idle
   * timer, and `awaiting_*` pauses it; the duration limit always applies.
   */
  async waitFor(types: readonly Envelope["type"][]): Promise<Waited> {
    for (;;) {
      const w = await this.pull();
      if (w.kind !== "env") return w;
      const t = w.env.type;
      if (t === "session.status") {
        const state = w.env.payload.state;
        this.paused = state === "awaiting_approval" || state === "awaiting_human";
        continue;
      }
      if (types.includes(t) || t === "error" || t === "session.close") return w;
    }
  }
}

interface GuestSession {
  id: string;
  peer: string;
  tags: string[];
  log: SessionLog;
  state: "accepted" | "running" | "done";
  goal: string;
  permissions: EffectivePermissions;
  limits: Limits;
  ttl?: NodeJS.Timeout;
  abort: AbortController;
  lastEnvelopeId: string;
}

const SEEN_MAX = 5000;
/** Mid-run "may I read this?" questions per session; more are refused without asking. */
const MAX_ACCESS_REQUESTS = 10;

export class Engine {
  private readonly hosts = new Map<string, HostSession>();
  private readonly guests = new Map<string, GuestSession>();
  private readonly seen = new Set<string>();

  constructor(private readonly o: EngineOptions) {}

  get activeGuestSessions(): number {
    return this.guests.size;
  }

  // ───────────────────────────── host side ─────────────────────────────

  /** Opens a consult with `opts.peer`, sends the proposal and waits for the answer. */
  async consult(opts: ConsultOptions): Promise<ConsultOutcome> {
    const started = Date.now();
    const sessionId = randomUUID();
    const cfg = this.o.config();
    const limits = { ...CONSULT_DEFAULT_LIMITS, ...cfg.default_limits, ...opts.limits };
    const peer = opts.peer;
    const outcome = (partial: Omit<ConsultOutcome, "sessionId" | "peer" | "durationMs">): ConsultOutcome => ({
      sessionId,
      peer,
      durationMs: Date.now() - started,
      ...partial,
    });

    try {
      await this.o.client.ping(peer, opts.signal);
    } catch (err) {
      throw new PeerUnavailableError(peer, (err as Error).message);
    }

    const hs = new HostSession(
      sessionId,
      peer,
      this.o.logs.session(sessionId),
      limits.idle_timeout_s * 1000,
      limits.max_duration_s * 1000,
    );
    this.hosts.set(sessionId, hs);
    const onAbort = (): void => hs.cancel();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) hs.cancel();

    const close = async (reason: "done" | "cancelled" | "limit_reached" | "peer_unavailable" | "error", summary?: string) => {
      try {
        await this.hostSend(hs, "session.close", { reason, ...(summary ? { summary } : {}) });
      } catch {
        /* best effort */
      }
    };

    try {
      const open: SessionOpenPayload = {
        kind: "consult",
        goal: opts.goal,
        limits,
        ...(opts.modeCap ? { mode_cap: opts.modeCap } : {}),
      };
      try {
        await this.hostSend(hs, "session.open", open);
      } catch (err) {
        if ((err as { code?: string }).code === "not_allowed") {
          return outcome({ status: "rejected", rejectReason: "not_allowed", summary: describeReject("not_allowed") });
        }
        return outcome({ status: "failed", summary: `could not reach ${peer}: ${(err as Error).message}` });
      }

      const first = await hs.waitFor(["session.accept", "session.reject"]);
      const early = this.hostEarlyExit(first, outcome);
      if (early) {
        if (first.kind === "timeout") await close(first.why === "idle" ? "peer_unavailable" : "limit_reached");
        if (first.kind === "cancelled") await close("cancelled");
        return early;
      }
      const accepted = (first as { kind: "env"; env: Envelope }).env;
      if (accepted.type === "session.reject") {
        return outcome({
          status: "rejected",
          rejectReason: accepted.payload.reason,
          summary: accepted.payload.detail ?? describeReject(accepted.payload.reason),
        });
      }
      if (accepted.type !== "session.accept") {
        return outcome({ status: "failed", summary: `unexpected ${accepted.type} while waiting for accept` });
      }
      const effective = accepted.payload.effective;

      try {
        await this.hostSend(hs, "message", { text: opts.proposal, format: "markdown" }, accepted.id);
      } catch (err) {
        return outcome({ status: "failed", effective, summary: `could not send the proposal: ${(err as Error).message}` });
      }

      const second = await hs.waitFor(["result"]);
      const early2 = this.hostEarlyExit(second, outcome, effective);
      if (early2) {
        if (second.kind === "timeout") await close(second.why === "idle" ? "peer_unavailable" : "limit_reached");
        if (second.kind === "cancelled") await close("cancelled");
        return early2;
      }
      const reply = (second as { kind: "env"; env: Envelope }).env;
      if (reply.type === "result") {
        await close("done");
        return outcome({ status: reply.payload.status, summary: reply.payload.summary, effective });
      }
      return outcome({ status: "failed", effective, summary: `unexpected ${reply.type} while waiting for the result` });
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      this.hosts.delete(sessionId);
    }
  }

  /** Maps timeouts, cancellation, peer errors and peer-initiated closes to an outcome; undefined to keep going. */
  private hostEarlyExit(
    w: Waited,
    outcome: (p: Omit<ConsultOutcome, "sessionId" | "peer" | "durationMs">) => ConsultOutcome,
    effective?: SessionAcceptPayload["effective"],
  ): ConsultOutcome | undefined {
    const extra = effective ? { effective } : {};
    if (w.kind === "timeout") {
      return outcome({
        status: "timeout",
        ...extra,
        summary:
          w.why === "idle"
            ? "the peer stopped responding (idle timeout); the session was closed"
            : "the maximum session duration was reached; the session was closed",
      });
    }
    if (w.kind === "cancelled") return outcome({ status: "cancelled", ...extra, summary: "cancelled" });
    const env = w.env;
    if (env.type === "error") {
      const declined = env.payload.code === "permission_denied";
      return outcome({
        status: declined ? "declined" : "failed",
        ...extra,
        summary: declined ? `the user on ${env.from.peer} declined the request` : `${env.payload.code}: ${env.payload.message}`,
      });
    }
    if (env.type === "session.close") {
      return outcome({ status: "failed", ...extra, summary: `the peer closed the session (${env.payload.reason})` });
    }
    return undefined;
  }

  private async hostSend<T extends Envelope["type"]>(
    hs: HostSession,
    type: T,
    payload: Extract<Envelope, { type: T }>["payload"],
    inReplyTo?: string,
  ): Promise<void> {
    const env = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      session_id: hs.id,
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      type,
      from: { peer: this.o.selfName } as Address,
      to: { peer: hs.peer } as Address,
      ts: new Date().toISOString(),
      payload,
    } as unknown as Envelope;
    const stamped = hs.record(env, "out");
    this.assertValid(stamped);
    await this.o.client.send(hs.peer, stamped);
  }

  // ─────────────────────────── inbound dispatch ───────────────────────────

  /**
   * Handles one validated envelope that arrived from `identity`.
   * Throws IdentityMismatchError (403) or UnknownSessionError (404); everything else is handled asynchronously.
   */
  async receive(env: Envelope, identity: Identity): Promise<void> {
    if (!peerMatches(env.from.peer, identity.peer)) {
      throw new IdentityMismatchError(`from.peer "${env.from.peer}" does not match the verified identity "${identity.peer}"`);
    }
    if (this.seen.has(env.id)) return;
    this.seen.add(env.id);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    const host = this.hosts.get(env.session_id);
    if (host) {
      if (!peerMatches(host.peer, identity.peer)) {
        throw new IdentityMismatchError("this session belongs to another peer");
      }
      host.push(host.record(env, "in"));
      return;
    }

    if (env.type === "session.open") {
      // Refuse strangers synchronously: no reply is sent, so a non-allowlisted node cannot make us open connections.
      const allowed = this.o.config().peers.some((p) => peerMatches(p.peer, identity.peer));
      if (!allowed) throw new NotAllowedError(identity.peer);
      this.spawn(this.guestOpen(env, identity));
      return;
    }

    const guest = this.guests.get(env.session_id);
    if (!guest) throw new UnknownSessionError(env.session_id);
    if (!peerMatches(guest.peer, identity.peer)) {
      throw new IdentityMismatchError("this session belongs to another peer");
    }
    guest.log.append(env, "in");
    if (env.type === "message") this.spawn(this.guestMessage(guest, env));
    else if (env.type === "session.close") this.guestClose(guest);
  }

  private spawn(p: Promise<unknown>): void {
    p.catch((err) => (this.o.onError ? this.o.onError(err) : process.stderr.write(`resolvroom: ${String(err)}\n`)));
  }

  // ───────────────────────────── guest side ─────────────────────────────

  private async guestSend<T extends Envelope["type"]>(
    g: { id: string; peer: string; log: SessionLog },
    type: T,
    payload: Extract<Envelope, { type: T }>["payload"],
    inReplyTo?: string,
  ): Promise<void> {
    const env = {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      session_id: g.id,
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      type,
      from: { peer: this.o.selfName, agent: this.o.runner.agent } as Address,
      to: { peer: g.peer } as Address,
      ts: new Date().toISOString(),
      payload,
    } as unknown as Envelope;
    this.assertValid(env);
    g.log.append(env, "out");
    await this.o.client.send(g.peer, env);
  }

  private async guestOpen(env: Extract<Envelope, { type: "session.open" }>, identity: Identity): Promise<void> {
    const log = this.o.logs.session(env.session_id);
    log.append(env, "in");
    const base = { id: env.session_id, peer: env.from.peer, log };
    const decide = (event: string, detail?: Record<string, unknown>): void =>
      this.o.logs.decision({ session_id: env.session_id, peer: identity.peer, event, ...(detail ? { detail } : {}) });
    const reject = async (reason: RejectReason, detail?: string): Promise<void> => {
      decide("reject", { reason, ...(detail ? { detail } : {}) });
      await this.guestSend(base, "session.reject", { reason, ...(detail ? { detail } : {}) }, env.id);
    };

    const open = env.payload;
    if (open.kind !== "consult") {
      return reject("unsupported_version", "this build only supports consult sessions");
    }

    const cfg = this.o.config();
    const entry = cfg.peers.find((p) => peerMatches(p.peer, identity.peer));
    const resolved = resolvePermissions({
      peerProfile: entry?.profile,
      ceiling: cfg.ceiling,
      sessionCap: open.mode_cap,
      peerTags: identity.tags,
      autoRequiresTag: cfg.auto_requires_tag,
    });
    if (!resolved.allowed) return reject("not_allowed", "this peer is not on the allowlist");

    if (this.guests.size >= (this.o.maxConcurrentGuest ?? 2)) return reject("busy", "too many sessions at once");
    if (!(await this.o.runner.available())) return reject("agent_unavailable", `${this.o.runner.agent} is not available here`);
    const capabilities = this.o.runner.restrict(resolved);
    if (!capabilities) {
      return reject("agent_unavailable", "the local agent cannot be restricted to the permissions this session would need");
    }

    const permissions = { ...resolved, capabilities };
    const limits = { ...CONSULT_DEFAULT_LIMITS, ...cfg.default_limits, ...open.limits };
    const guest: GuestSession = {
      ...base,
      tags: identity.tags,
      goal: open.goal,
      state: "accepted",
      permissions,
      limits,
      abort: new AbortController(),
      lastEnvelopeId: env.id,
    };
    this.guests.set(env.session_id, guest);
    // Safety net: forget the session if the host never sends session.close.
    guest.ttl = setTimeout(() => this.guestClose(guest), ((limits.max_duration_s ?? 300) + 30) * 1000);
    guest.ttl.unref();
    decide("accept", { mode: permissions.mode, capabilities, downgraded_by: permissions.downgradedBy });
    await this.guestSend(guest, "session.accept", { effective: { mode: permissions.mode, capabilities } }, env.id);
  }

  private async guestMessage(g: GuestSession, env: Extract<Envelope, { type: "message" }>): Promise<void> {
    if (g.state !== "accepted") {
      await this.guestSend(g, "error", { code: "protocol_violation", message: "only one proposal per consult" }, env.id);
      return;
    }
    g.state = "running";
    const decide = (event: string, detail?: Record<string, unknown>): void =>
      this.o.logs.decision({ session_id: g.id, peer: g.peer, event, ...(detail ? { detail } : {}) });
    const p = g.permissions;

    if (p.mode === "ask") {
      await this.guestSend(g, "session.status", { state: "awaiting_approval" }, env.id);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), p.askTimeoutS * 1000);
      let answer: "allow" | "deny" = "deny";
      try {
        answer = await Promise.race([
          this.o.prompter.approve({
            peer: g.peer,
            sessionId: g.id,
            goal: g.goal,
            proposal: env.payload.text,
            mode: p.mode,
            capabilities: p.capabilities,
            access: this.o.runner.describeAccess(p),
            timeoutS: p.askTimeoutS,
            signal: ctl.signal,
          }),
          new Promise<"deny">((resolve) => ctl.signal.addEventListener("abort", () => resolve("deny"), { once: true })),
        ]);
      } catch {
        answer = "deny";
      } finally {
        clearTimeout(timer);
        ctl.abort();
      }
      decide("ask", { answer });
      if (answer !== "allow") {
        this.guestClose(g);
        await this.guestSend(g, "error", { code: "permission_denied", message: "declined by the local user" }, env.id);
        return;
      }
    }

    const heartbeat = setInterval(() => {
      this.guestSend(g, "session.status", { state: "working" }).catch(() => undefined);
    }, this.o.heartbeatMs ?? 15000);
    const limitTimer = setTimeout(() => g.abort.abort(), (g.limits.max_duration_s ?? 300) * 1000);
    try {
      await this.guestSend(g, "session.status", { state: "working" }, env.id);
      let asked = 0;
      const askAccess = async (a: AccessRequest): Promise<"allow" | "deny"> => {
        if (g.abort.signal.aborted) return "deny";
        if (++asked > MAX_ACCESS_REQUESTS) {
          decide("access", { ...a, answer: "deny", reason: "too many requests" });
          return "deny";
        }
        await this.guestSend(g, "session.status", { state: "awaiting_approval" }).catch(() => undefined);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), p.askTimeoutS * 1000);
        const onEnd = (): void => ctl.abort();
        g.abort.signal.addEventListener("abort", onEnd, { once: true });
        let answer: "allow" | "deny" = "deny";
        try {
          answer = await Promise.race([
            this.o.prompter.approve({
              peer: g.peer,
              sessionId: g.id,
              goal: g.goal,
              proposal: env.payload.text,
              mode: p.mode,
              capabilities: p.capabilities,
              access: `read ${a.target} (${a.tool})`,
              timeoutS: p.askTimeoutS,
              action: a,
              signal: ctl.signal,
            }),
            new Promise<"deny">((resolve) => ctl.signal.addEventListener("abort", () => resolve("deny"), { once: true })),
          ]);
        } catch {
          answer = "deny";
        } finally {
          clearTimeout(timer);
          g.abort.signal.removeEventListener("abort", onEnd);
          ctl.abort();
        }
        decide("access", { ...a, answer });
        await this.guestSend(g, "session.status", { state: "working" }).catch(() => undefined);
        return answer;
      };
      const result = await this.o.runner.run({
        sessionId: g.id,
        peer: g.peer,
        goal: g.goal,
        proposal: env.payload.text,
        permissions: p,
        signal: g.abort.signal,
        askAccess,
      });
      if (g.abort.signal.aborted) return;
      await this.guestSend(g, "result", { status: result.status, summary: result.summary, format: "markdown" }, env.id);
    } catch (err) {
      if (!g.abort.signal.aborted) {
        await this.guestSend(g, "error", { code: "agent_failed", message: shortMessage(err) }, env.id).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(limitTimer);
      g.state = "done";
    }
  }

  private guestClose(g: GuestSession): void {
    if (g.ttl) clearTimeout(g.ttl);
    g.abort.abort();
    this.guests.delete(g.id);
  }

  private assertValid(env: Envelope): void {
    const r = validateEnvelope(env);
    if (!r.ok) throw new Error(`internal: built an invalid ${env.type} envelope: ${r.errors.join("; ")}`);
  }
}

function describeReject(reason: RejectReason): string {
  switch (reason) {
    case "not_allowed":
      return "the peer does not have you on its allowlist";
    case "busy":
      return "the peer is busy with other sessions";
    case "user_declined":
      return "the user on the peer declined";
    case "agent_unavailable":
      return "no usable agent on the peer";
    case "unsupported_version":
      return "the peer does not support this protocol version or session kind";
    case "limits_unacceptable":
      return "the peer does not accept these limits";
  }
}

function shortMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}
