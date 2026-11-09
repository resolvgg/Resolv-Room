import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { Capabilities, DaemonConfig, EffectivePermissions, Envelope, PermissionProfile } from "@resolvroom/protocol";
import { Engine, MemoryLogStore } from "../src/index.js";
import type {
  ApprovalRequest,
  Identity,
  PeerClient,
  PingInfo,
  Prompter,
  Runner,
  RunnerRequest,
  RunnerResult,
} from "../src/index.js";

export const READ_ONLY: Capabilities = { read: true, write: false, exec: false, network: false };

export function profile(over: Partial<PermissionProfile> = {}): PermissionProfile {
  return { mode: "ask", capabilities: READ_ONLY, ...over };
}

export class FakeRunner implements Runner {
  readonly agent = "claude-code";
  calls: RunnerRequest[] = [];
  isAvailable = true;
  restrictTo: ((p: EffectivePermissions) => Capabilities | null) | undefined;
  impl: (req: RunnerRequest) => Promise<RunnerResult> = async (req) => ({
    status: "solved",
    summary: `answer to: ${req.proposal}`,
  });
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  restrict(p: EffectivePermissions): Capabilities | null {
    return this.restrictTo ? this.restrictTo(p) : p.capabilities;
  }
  describeAccess(): string {
    return "fake access";
  }
  async run(req: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(req);
    return this.impl(req);
  }
}

export class FakePrompter implements Prompter {
  requests: ApprovalRequest[] = [];
  answer: "allow" | "deny" | "never" = "allow";
  async approve(req: ApprovalRequest): Promise<"allow" | "deny"> {
    this.requests.push(req);
    if (this.answer === "never") return new Promise(() => undefined);
    return this.answer;
  }
}

export interface Node {
  name: string;
  engine: Engine;
  runner: FakeRunner;
  prompter: FakePrompter;
  logs: MemoryLogStore;
  config: DaemonConfig;
}

/** Tiny in-memory "network": each node delivers envelopes straight into the other node's engine. */
export class Network {
  nodes = new Map<string, Node>();
  tags = new Map<string, string[]>();
  down = new Set<string>();
  errors: unknown[] = [];

  add(name: string, config: Partial<DaemonConfig> = {}, opts: { heartbeatMs?: number; maxConcurrentGuest?: number } = {}): Node {
    const network = this;
    const cfg: DaemonConfig = { v: PROTOCOL_VERSION, peers: [], ...config };
    const runner = new FakeRunner();
    const prompter = new FakePrompter();
    const logs = new MemoryLogStore();
    const client: PeerClient = {
      async ping(peer: string): Promise<PingInfo> {
        const target = network.nodes.get(peer);
        if (!target || network.down.has(peer)) throw new Error("connection refused");
        return { v: PROTOCOL_VERSION, peer, agents: ["claude-code"] };
      },
      async send(peer: string, env: Envelope): Promise<void> {
        const target = network.nodes.get(peer);
        if (!target || network.down.has(peer)) throw new Error("connection refused");
        const identity: Identity = { peer: name, tags: network.tags.get(name) ?? [] };
        // deliver asynchronously like a real HTTP 202
        await target.engine.receive(structuredClone(env), identity);
      },
    };
    const engine = new Engine({
      selfName: name,
      config: () => node.config,
      client,
      runner,
      prompter,
      logs,
      heartbeatMs: opts.heartbeatMs ?? 20,
      ...(opts.maxConcurrentGuest ? { maxConcurrentGuest: opts.maxConcurrentGuest } : {}),
      // Late replies to a session the host already closed get a 404 in real life too; that is benign here.
      onError: (e) => network.errors.push(e),
    });
    const node: Node = { name, engine, runner, prompter, logs, config: cfg };
    this.nodes.set(name, node);
    return node;
  }
}

export function allow(peer: string, p: PermissionProfile = profile()): DaemonConfig["peers"][number] {
  return { peer, profile: p, added_at: new Date().toISOString() };
}
