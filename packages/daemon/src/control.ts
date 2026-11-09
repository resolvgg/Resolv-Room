import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { DaemonConfig, Limits, Mode } from "@resolvroom/protocol";
import { PeerUnavailableError } from "@resolvroom/core";
import type { ConsultOutcome, Engine } from "@resolvroom/core";
import { errorBody, readBody, sendJson, BodyTooLarge } from "./server.js";
import type { ConfigStore } from "@resolvroom/core";
import type { HttpPeerClient } from "./client.js";
import type { PairingManager, PairingStatus } from "./pairing.js";
import { DEFAULT_PAIR_PROFILE } from "./pairing.js";
import type { PendingApproval, QueuePrompter } from "./approvals.js";
import { sendFiles } from "./send.js";
import type { SendOutcome, SendRequest } from "./send.js";

export interface ControlServerOptions {
  engine: Engine;
  config: () => DaemonConfig;
  selfName: string;
  agents: string[];
  socketPath: string;
  store?: ConfigStore;
  pairing?: PairingManager;
  pairClient?: HttpPeerClient;
  /** Present when the daemon has no terminal and queues approvals. */
  approvals?: QueuePrompter;
  /** Home folder, for the secrets filter of `send`. Enables /control/send together with pairClient. */
  home?: string;
}

export interface PairJoinRequest {
  peer: string;
  code: string;
  /** Where to reach the peer, if not http://<peer>:7777. */
  endpoint?: string;
  /** Dev identity only: where the peer should reply to us. */
  reply_endpoint?: string;
}

export interface ConsultRequest {
  peer: string;
  goal: string;
  proposal: string;
  mode_cap?: Mode;
  limits?: Limits;
}

export interface DaemonStatus {
  v: string;
  name: string;
  agents: string[];
  active_guest_sessions: number;
  pid: number;
}

export interface PeerSummary {
  peer: string;
  mode: Mode;
  capabilities: DaemonConfig["peers"][number]["profile"]["capabilities"];
  endpoint?: string;
  expires_at?: string | null;
}

const MAX_GOAL = 4000;
const MAX_PROPOSAL = 200_000;

function parseConsult(body: unknown): ConsultRequest | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const b = body as Record<string, unknown>;
  if (typeof b.peer !== "string" || b.peer.length === 0) return "peer is required";
  if (typeof b.goal !== "string" || b.goal.trim().length === 0 || b.goal.length > MAX_GOAL) return `goal is required (max ${MAX_GOAL} chars)`;
  if (typeof b.proposal !== "string" || b.proposal.trim().length === 0 || b.proposal.length > MAX_PROPOSAL) {
    return `proposal is required (max ${MAX_PROPOSAL} chars)`;
  }
  const out: ConsultRequest = { peer: b.peer, goal: b.goal, proposal: b.proposal };
  if (b.mode_cap !== undefined) {
    if (b.mode_cap !== "ask") return 'mode_cap can only be "ask"';
    out.mode_cap = "ask";
  }
  if (b.limits !== undefined) {
    const l = b.limits as Record<string, unknown>;
    const limits: Limits = {};
    for (const k of ["max_duration_s", "idle_timeout_s", "max_rounds"] as const) {
      const v = l[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 86400) return `limits.${k} must be an integer between 1 and 86400`;
      limits[k] = v;
    }
    out.limits = limits;
  }
  return out;
}

/** Local control API on a unix socket (0600). Used by the MCP server and the CLI; never reachable from the network. */
export function createControlServer(o: ControlServerOptions): Server {
  const server = createServer((req, res) => {
    handle(req).then(
      ([status, body]) => sendJson(res, status, body),
      () => sendJson(res, 500, errorBody("internal", "internal error")),
    );
    async function handle(r: IncomingMessage): Promise<[number, unknown]> {
      const url = new URL(r.url ?? "/", "http://x");
      if (r.method === "GET" && url.pathname === "/control/status") {
        const s: DaemonStatus = {
          v: PROTOCOL_VERSION,
          name: o.selfName,
          agents: o.agents,
          active_guest_sessions: o.engine.activeGuestSessions,
          pid: process.pid,
        };
        return [200, s];
      }
      if (r.method === "GET" && url.pathname === "/control/peers") {
        const peers: PeerSummary[] = o.config().peers.map((p) => ({
          peer: p.peer,
          mode: p.profile.mode,
          capabilities: p.profile.capabilities,
          ...(p.endpoint ? { endpoint: p.endpoint } : {}),
          ...(p.profile.expires_at !== undefined ? { expires_at: p.profile.expires_at } : {}),
        }));
        return [200, { peers }];
      }
      if (r.method === "POST" && url.pathname === "/control/consult") {
        let text: string;
        try {
          text = await readBody(r, 1024 * 1024);
        } catch (err) {
          if (err instanceof BodyTooLarge) return [413, errorBody("invalid_request", err.message)];
          throw err;
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return [400, errorBody("invalid_request", "body is not valid JSON")];
        }
        const parsed = parseConsult(json);
        if (typeof parsed === "string") return [400, errorBody("invalid_request", parsed)];
        const ctl = new AbortController();
        // If the caller goes away before we answer (for example the MCP call was cancelled), cancel the session.
        res_close(r, () => ctl.abort());
        try {
          const outcome: ConsultOutcome = await o.engine.consult({
            peer: parsed.peer,
            goal: parsed.goal,
            proposal: parsed.proposal,
            ...(parsed.mode_cap ? { modeCap: parsed.mode_cap } : {}),
            ...(parsed.limits ? { limits: parsed.limits } : {}),
            signal: ctl.signal,
          });
          return [200, outcome];
        } catch (err) {
          if (err instanceof PeerUnavailableError) return [502, errorBody("peer_unavailable", err.message)];
          throw err;
        }
      }
      const readJson = async (): Promise<[unknown, undefined] | [undefined, [number, unknown]]> => {
        try {
          return [JSON.parse(await readBody(r, 16 * 1024)), undefined];
        } catch {
          return [undefined, [400, errorBody("invalid_request", "body is not valid JSON")]];
        }
      };

      if (o.pairing && o.store && o.pairClient) {
        if (r.method === "POST" && url.pathname === "/control/pair/start") {
          return [200, o.pairing.start()];
        }
        if (r.method === "GET" && url.pathname === "/control/pair/status") {
          return [200, o.pairing.status()];
        }
        if (r.method === "POST" && url.pathname === "/control/pair/cancel") {
          o.pairing.cancel();
          return [200, {}];
        }
        if (r.method === "POST" && url.pathname === "/control/pair/join") {
          const [body, bad] = await readJson();
          if (bad) return bad;
          const b = body as Partial<PairJoinRequest>;
          if (typeof b.peer !== "string" || b.peer.length === 0 || typeof b.code !== "string" || b.code.length === 0) {
            return [400, errorBody("invalid_request", "peer and code are required")];
          }
          try {
            await o.pairClient.pair(b.peer, b.code, {
              ...(b.endpoint ? { endpoint: b.endpoint } : {}),
              ...(b.reply_endpoint ? { replyEndpoint: b.reply_endpoint } : {}),
            });
          } catch (err) {
            const status = (err as { status?: number }).status;
            if (status === 429) return [403, errorBody("pairing_locked", "the other side closed the pairing window after too many wrong codes; run `resolvroom pair` there again")];
            if (status === 403) return [403, errorBody("pairing_failed", "pairing failed: wrong or expired code, or this node is missing tag:resolvroom")];
            return [502, errorBody("peer_unavailable", (err as Error).message)];
          }
          if (!o.store.findPeer(b.peer)) o.store.upsertPeer(b.peer, DEFAULT_PAIR_PROFILE, b.endpoint);
          return [200, { peer: b.peer }];
        }
      }

      if (o.pairClient && o.home && r.method === "POST" && url.pathname === "/control/send") {
        const [body, bad] = await readJson();
        if (bad) return bad;
        const b = body as Partial<SendRequest>;
        if (typeof b.peer !== "string" || !b.peer || !Array.isArray(b.paths) || b.paths.length === 0 || !b.paths.every((p) => typeof p === "string" && p.startsWith("/"))) {
          return [400, errorBody("invalid_request", "peer and paths (absolute) are required")];
        }
        if (!o.config().peers.some((p) => p.peer.toLowerCase() === (b.peer ?? "").toLowerCase())) {
          return [400, errorBody("invalid_request", `${b.peer} is not one of your peers (resolvroom peer list)`)];
        }
        const outcome: SendOutcome = await sendFiles(o.pairClient, {
          peer: b.peer,
          paths: b.paths,
          ...(typeof b.message === "string" ? { message: b.message } : {}),
          ...(b.include_git === true ? { include_git: true } : {}),
          ...(b.include_deps === true ? { include_deps: true } : {}),
        }, { home: o.home });
        return [200, outcome];
      }

      if (o.approvals) {
        if (r.method === "GET" && url.pathname === "/control/approvals") {
          return [200, { approvals: o.approvals.list() }];
        }
        if (r.method === "POST" && url.pathname === "/control/approvals/answer") {
          const [body, bad] = await readJson();
          if (bad) return bad;
          const b = body as { id?: unknown; answer?: unknown };
          if (typeof b.id !== "string" || (b.answer !== "allow" && b.answer !== "deny")) {
            return [400, errorBody("invalid_request", 'id and answer ("allow" or "deny") are required')];
          }
          const res = o.approvals.answer(b.id, b.answer);
          if (res === "not_found") return [404, errorBody("not_found", "no such pending request (it may have timed out)")];
          if (res === "ambiguous") return [400, errorBody("invalid_request", "that id matches more than one request; type more characters")];
          return [200, {}];
        }
      }

      return [404, errorBody("not_found", "unknown endpoint")];
    }
  });
  return server;
}

function res_close(req: IncomingMessage, fn: () => void): void {
  req.socket.on("close", fn);
}

export async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  if (existsSync(socketPath)) {
    if (await isSocketAlive(socketPath)) throw new Error(`another resolvroom daemon is already running (${socketPath})`);
    unlinkSync(socketPath);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
}

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/control/status", method: "GET", timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

/** Talks to the daemon's control socket. */
export class ControlClient {
  constructor(private readonly socketPath: string) {}

  status(): Promise<DaemonStatus> {
    return this.call<DaemonStatus>("GET", "/control/status");
  }

  async peers(): Promise<PeerSummary[]> {
    return (await this.call<{ peers: PeerSummary[] }>("GET", "/control/peers")).peers;
  }

  pairStart(): Promise<{ code: string; expiresAt: string }> {
    return this.call("POST", "/control/pair/start", {});
  }

  pairStatus(): Promise<PairingStatus> {
    return this.call("GET", "/control/pair/status");
  }

  pairCancel(): Promise<unknown> {
    return this.call("POST", "/control/pair/cancel", {});
  }

  pairJoin(req: PairJoinRequest): Promise<{ peer: string }> {
    return this.call("POST", "/control/pair/join", req);
  }

  async approvals(): Promise<PendingApproval[]> {
    return (await this.call<{ approvals: PendingApproval[] }>("GET", "/control/approvals")).approvals;
  }

  answerApproval(id: string, answer: "allow" | "deny"): Promise<unknown> {
    return this.call("POST", "/control/approvals/answer", { id, answer });
  }

  send(req: SendRequest): Promise<SendOutcome> {
    return this.call<SendOutcome>("POST", "/control/send", req);
  }

  consult(req: ConsultRequest, signal?: AbortSignal): Promise<ConsultOutcome> {
    return this.call<ConsultOutcome>("POST", "/control/consult", req, signal);
  }

  private call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
          ...(signal ? { signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              return reject(new ControlError("internal", `bad response from the daemon: ${text.slice(0, 200)}`));
            }
            if ((res.statusCode ?? 500) >= 400) {
              const e = (json as { error?: { code?: string; message?: string } }).error;
              return reject(new ControlError(e?.code ?? "internal", e?.message ?? `HTTP ${res.statusCode}`));
            }
            resolve(json as T);
          });
        },
      );
      req.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new ControlError("daemon_not_running", "the Resolv Room daemon is not running. Start it with `resolvroom start`."));
        } else {
          reject(err);
        }
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
