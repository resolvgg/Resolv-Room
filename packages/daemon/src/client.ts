import type { DaemonConfig, Envelope } from "@resolvroom/protocol";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import { peerMatches } from "@resolvroom/core";
import type { PeerClient, PingInfo } from "@resolvroom/core";
import { DEV_PEER_HEADER, DEV_TAGS_HEADER } from "./identity.js";

export const DEFAULT_PORT = 7777;

export interface HttpPeerClientOptions {
  selfName: string;
  config: () => DaemonConfig;
  /** TESTING ONLY: also send the dev identity headers (accepted only by a daemon started with dev identity). */
  dev?: { tags: string[] };
  pingTimeoutMs?: number;
  sendTimeoutMs?: number;
}

export class PeerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PeerHttpError";
  }
}

export class HttpPeerClient implements PeerClient {
  constructor(private readonly o: HttpPeerClientOptions) {}

  endpointFor(peer: string): string {
    const entry = this.o.config().peers.find((p) => peerMatches(p.peer, peer));
    const base = entry?.endpoint ?? `http://${peer}:${DEFAULT_PORT}`;
    return base.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.o.dev) {
      h[DEV_PEER_HEADER] = this.o.selfName;
      h[DEV_TAGS_HEADER] = this.o.dev.tags.join(",");
    }
    return h;
  }

  async ping(peer: string, signal?: AbortSignal): Promise<PingInfo> {
    const res = await this.request(`${this.endpointFor(peer)}/v1/ping`, { method: "GET", headers: this.headers() }, this.o.pingTimeoutMs ?? 5000, signal);
    const body = (await res.json()) as PingInfo;
    if (body.v !== PROTOCOL_VERSION) throw new PeerHttpError(res.status, `peer speaks protocol ${String(body.v)}`);
    return body;
  }

  async send(peer: string, envelope: Envelope): Promise<void> {
    await this.request(
      `${this.endpointFor(peer)}/v1/envelopes`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(envelope) },
      this.o.sendTimeoutMs ?? 10_000,
    );
  }

  private async request(url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (outer) signals.push(outer);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (err) {
      throw new Error(`cannot reach ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let detail = "";
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        detail = j.error ? `${j.error.code}: ${j.error.message}` : "";
        code = j.error?.code;
      } catch {
        /* ignore */
      }
      throw new PeerHttpError(res.status, `HTTP ${res.status} from ${url}${detail ? ` (${detail})` : ""}`, code);
    }
    return res;
  }
}
