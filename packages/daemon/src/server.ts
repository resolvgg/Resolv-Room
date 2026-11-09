import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PROTOCOL_VERSION, validateEnvelope } from "@resolvroom/protocol";
import { IdentityMismatchError, NotAllowedError, UnknownSessionError } from "@resolvroom/core";
import type { Engine } from "@resolvroom/core";
import type { IdentityProvider } from "./identity.js";

export interface TransportServerOptions {
  engine: Engine;
  identity: IdentityProvider;
  selfName: string;
  agents: string[];
  maxBodyBytes?: number;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}

/** The peer-to-peer HTTP surface: GET /v1/ping and POST /v1/envelopes. */
export function createTransportServer(o: TransportServerOptions): Server {
  const limit = o.maxBodyBytes ?? 1024 * 1024;
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, errorBody("internal", "internal error"));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const identity = await o.identity.identify(req);
    if (!identity) return sendJson(res, 403, errorBody("permission_denied", "could not verify your identity on the tailnet"));

    if (req.method === "GET" && url.pathname === "/v1/ping") {
      return sendJson(res, 200, { v: PROTOCOL_VERSION, peer: o.selfName, agents: o.agents });
    }

    if (req.method === "POST" && url.pathname === "/v1/envelopes") {
      let text: string;
      try {
        text = await readBody(req, limit);
      } catch (err) {
        if (err instanceof BodyTooLarge) return sendJson(res, 413, errorBody("protocol_violation", err.message));
        throw err;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return sendJson(res, 400, errorBody("protocol_violation", "body is not valid JSON"));
      }
      const v = validateEnvelope(json);
      if (!v.ok) return sendJson(res, 400, errorBody("protocol_violation", v.errors.slice(0, 5).join("; ")));
      try {
        await o.engine.receive(v.value, identity);
      } catch (err) {
        if (err instanceof NotAllowedError) return sendJson(res, 403, errorBody("not_allowed", err.message));
        if (err instanceof IdentityMismatchError) return sendJson(res, 403, errorBody("permission_denied", err.message));
        if (err instanceof UnknownSessionError) return sendJson(res, 404, errorBody("protocol_violation", err.message));
        throw err;
      }
      return sendJson(res, 202, {});
    }

    sendJson(res, 404, errorBody("protocol_violation", "unknown endpoint"));
  }
}
