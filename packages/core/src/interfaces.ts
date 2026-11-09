import type { Capabilities, EffectivePermissions, Envelope, Mode } from "@resolvroom/protocol";

/** Who is on the other end of a connection, as verified from the network (never from the message). */
export interface Identity {
  peer: string;
  tags: string[];
}

export interface PingInfo {
  v: string;
  peer: string;
  agents: string[];
}

/** Outbound side of the transport. */
export interface PeerClient {
  ping(peer: string, signal?: AbortSignal): Promise<PingInfo>;
  send(peer: string, envelope: Envelope): Promise<void>;
}

export interface RunnerRequest {
  sessionId: string;
  peer: string;
  goal: string;
  proposal: string;
  /** Effective permissions, with `capabilities` already reduced to what the runner can honor. */
  permissions: EffectivePermissions;
  signal: AbortSignal;
  /**
   * Asks the local human, mid-run, to let the agent read something outside the shared folders. Set by the engine;
   * a runner that supports it calls it instead of silently refusing. Resolves "deny" on timeout.
   */
  askAccess?: (request: AccessRequest) => Promise<ApprovalAnswer>;
}

/** One file or folder the agent wants to read, outside what the session already allows. */
export interface AccessRequest {
  /** Agent tool name, for example "Read" or "Grep". */
  tool: string;
  /** Absolute path the tool wants. */
  target: string;
}

export interface RunnerResult {
  status: "solved" | "partial" | "unsolved";
  summary: string;
}

/** Starts the local agent headless. A runner MUST NOT give the agent more than the effective permissions. */
export interface Runner {
  readonly agent: string;
  available(): Promise<boolean>;
  /** The capabilities this runner can really enforce, or null when it cannot run safely under these permissions. */
  restrict(permissions: EffectivePermissions): Capabilities | null;
  /** Human-readable description of what the agent will be able to touch. Shown in the ask prompt. */
  describeAccess(permissions: EffectivePermissions): string;
  run(request: RunnerRequest): Promise<RunnerResult>;
}

export interface ApprovalRequest {
  peer: string;
  sessionId: string;
  goal: string;
  proposal: string;
  mode: Mode;
  capabilities: Capabilities;
  access: string;
  timeoutS: number;
  /** Set when this is a mid-run request to read one extra path, not the start of a session. */
  action?: AccessRequest;
  /** Aborted when the prompt times out or the session ends. */
  signal: AbortSignal;
}

export type ApprovalAnswer = "allow" | "deny";

/** Asks the LOCAL human. It MUST NOT be answerable by the requester. */
export interface Prompter {
  approve(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

export class PeerUnavailableError extends Error {
  constructor(
    readonly peer: string,
    detail: string,
  ) {
    super(`peer unavailable: ${peer} (${detail})`);
    this.name = "PeerUnavailableError";
  }
}

/** The connection identity does not match `from.peer` (HTTP 403). */
export class IdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityMismatchError";
  }
}

/** An envelope for a session this daemon does not know (HTTP 404). */
export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`unknown session: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

/** The sender is not on this daemon's allowlist (HTTP 403 `not_allowed`). Refused before any reply is sent. */
export class NotAllowedError extends Error {
  readonly code = "not_allowed";
  constructor(peer: string) {
    super(`${peer} is not on the allowlist`);
    this.name = "NotAllowedError";
  }
}
