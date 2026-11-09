import type { DaemonConfig, Envelope } from "@resolvroom/protocol";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import { peerMatches } from "@resolvroom/core";
import type { PeerClient, PingInfo } from "@resolvroom/core";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { DEV_PEER_HEADER, DEV_TAGS_HEADER } from "./identity.js";
import { TRANSFER_TOKEN_HEADER } from "./transfer.js";
import type { TransferOffer } from "./transfer.js";

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

  /** Redeems a pairing code on `peer`. `endpoint` overrides where to reach it (needed before it is on the allowlist in tests). */
  async pair(peer: string, code: string, opts: { endpoint?: string; replyEndpoint?: string } = {}): Promise<{ peer: string }> {
    const base = (opts.endpoint ?? this.endpointFor(peer)).replace(/\/+$/, "");
    const res = await this.request(
      `${base}/v1/pair`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ code, ...(opts.replyEndpoint ? { reply_endpoint: opts.replyEndpoint } : {}) }),
      },
      this.o.sendTimeoutMs ?? 10_000,
    );
    return (await res.json()) as { peer: string };
  }

  /** Offers files to `peer`. Waits while its owner decides (up to their prompt timeout). */
  async offerTransfer(peer: string, offer: TransferOffer, timeoutMs = 10 * 60_000): Promise<{ token: string; dest: string }> {
    const res = await this.request(`${this.endpointFor(peer)}/v1/transfers`, { method: "POST", headers: this.headers(), body: JSON.stringify(offer) }, timeoutMs);
    return (await res.json()) as { token: string; dest: string };
  }

  async uploadFile(peer: string, id: string, index: number, token: string, path: string, size: number): Promise<void> {
    const headers = { ...this.headers(), "content-type": "application/octet-stream", "content-length": String(size), [TRANSFER_TOKEN_HEADER]: token };
    const body = Readable.toWeb(createReadStream(path)) as unknown as RequestInit["body"];
    await this.request(
      `${this.endpointFor(peer)}/v1/transfers/${id}/files/${index}`,
      { method: "PUT", headers, body, duplex: "half" } as RequestInit,
      Math.max(60_000, Math.ceil(size / (256 * 1024)) * 1000),
    );
  }

  async completeTransfer(peer: string, id: string, token: string): Promise<{ dest: string; files: number; bytes: number }> {
    const res = await this.request(
      `${this.endpointFor(peer)}/v1/transfers/${id}/complete`,
      { method: "POST", headers: { ...this.headers(), [TRANSFER_TOKEN_HEADER]: token }, body: "{}" },
      60_000,
    );
    return (await res.json()) as { dest: string; files: number; bytes: number };
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
