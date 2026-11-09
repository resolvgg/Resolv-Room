import { unlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ConfigStore, Engine, FileLogStore } from "@resolvroom/core";
import type { LogStore, Prompter, Runner } from "@resolvroom/core";
import { HttpPeerClient } from "./client.js";
import { createControlServer, listenOnSocket } from "./control.js";
import { DevIdentityProvider, TailscaleIdentityProvider, isLoopback } from "./identity.js";
import type { IdentityProvider } from "./identity.js";
import { createTransportServer } from "./server.js";

export interface DaemonOptions {
  home: string;
  /** This machine's node name (Tailscale name, or any name in dev mode). */
  name: string;
  /** Interface to bind. Must be the Tailscale address (or loopback in dev mode). Never 0.0.0.0. */
  bind: string;
  port: number;
  /** "dev" trusts headers and is allowed only on loopback. */
  identity: "tailscale" | "dev";
  /** Tags this node sends in dev mode (simulates Tailscale tags). */
  devTags?: string[];
  runner: Runner;
  prompter: Prompter;
  logs?: LogStore;
  identityProvider?: IdentityProvider;
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
}

export interface DaemonHandle {
  name: string;
  host: string;
  port: number;
  store: ConfigStore;
  engine: Engine;
  close(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions): Promise<DaemonHandle> {
  if (o.bind === "0.0.0.0" || o.bind === "::" || o.bind === "") {
    throw new Error("refusing to listen on all interfaces; bind to the Tailscale address");
  }
  if (o.identity === "dev" && !isLoopback(o.bind)) {
    throw new Error("dev identity trusts request headers, so it can only be used on a loopback address");
  }

  const store = new ConfigStore(o.home);
  const logs = o.logs ?? new FileLogStore(store.logDir);
  const client = new HttpPeerClient({
    selfName: o.name,
    config: () => store.load(),
    ...(o.identity === "dev" ? { dev: { tags: o.devTags ?? [] } } : {}),
  });
  const engine = new Engine({
    selfName: o.name,
    config: () => store.load(),
    client,
    runner: o.runner,
    prompter: o.prompter,
    logs,
    ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
    ...(o.onError ? { onError: o.onError } : {}),
  });
  const agents = [o.runner.agent];
  const identity = o.identityProvider ?? (o.identity === "dev" ? new DevIdentityProvider() : new TailscaleIdentityProvider());

  const transport = createTransportServer({ engine, identity, selfName: o.name, agents });
  await new Promise<void>((resolve, reject) => {
    transport.once("error", reject);
    transport.listen(o.port, o.bind, () => {
      transport.off("error", reject);
      resolve();
    });
  });

  const control = createControlServer({ engine, config: () => store.load(), selfName: o.name, agents, socketPath: store.socketPath });
  try {
    await listenOnSocket(control, store.socketPath);
  } catch (err) {
    await closeServer(transport);
    throw err;
  }

  const port = (transport.address() as AddressInfo).port;
  return {
    name: o.name,
    host: o.bind,
    port,
    store,
    engine,
    async close() {
      await Promise.all([closeServer(transport), closeServer(control)]);
      try {
        unlinkSync(store.socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
