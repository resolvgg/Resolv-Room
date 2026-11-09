export const PROTOCOL_VERSION = "0.1" as const;

export type Mode = "ask" | "auto";

export interface Address {
  /** Tailscale node name. */
  peer: string;
  /** Agent on that peer, for example "claude-code". Optional when addressing the daemon. */
  agent?: string;
}

export interface Limits {
  max_rounds?: number;
  max_duration_s?: number;
  idle_timeout_s?: number;
  /** Advisory unless the runner can measure usage. */
  max_tokens?: number;
}

export interface Capabilities {
  read: boolean;
  write: boolean;
  exec: boolean;
  network: boolean;
}

export interface PermissionProfile {
  mode: Mode;
  capabilities: Capabilities;
  scope?: {
    roots?: string[];
    extra_deny?: string[];
  };
  out_of_scope?: "ask" | "deny";
  ask?: {
    timeout_s?: number;
    remember?: "never" | "session";
  };
  /** Required for auto mode. null means no expiry and must be written explicitly. */
  expires_at?: string | null;
}

export interface DaemonConfig {
  v: typeof PROTOCOL_VERSION;
  listen?: { port?: number };
  ceiling?: Mode;
  auto_requires_tag?: boolean;
  default_limits?: Limits;
  peers: Array<{
    peer: string;
    profile: PermissionProfile;
    added_at: string;
  }>;
}

export interface SessionOpenPayload {
  kind: "consult" | "room";
  goal: string;
  participants?: Address[];
  limits?: Limits;
  mode_cap?: Mode;
}

export interface SessionAcceptPayload {
  effective: { mode: Mode; capabilities: Capabilities };
}

export type RejectReason =
  | "not_allowed"
  | "busy"
  | "unsupported_version"
  | "limits_unacceptable"
  | "user_declined"
  | "agent_unavailable";

export interface SessionRejectPayload {
  reason: RejectReason;
  detail?: string;
}

export interface SessionStatusPayload {
  state: "working" | "awaiting_approval" | "awaiting_human" | "idle";
}

export interface TextPayload {
  text: string;
  format?: "text" | "markdown";
}

export interface ResultPayload {
  status: "solved" | "partial" | "unsolved";
  summary: string;
  format?: "text" | "markdown";
}

export type ErrorCode =
  | "protocol_violation"
  | "unsupported_version"
  | "limit_exceeded"
  | "permission_denied"
  | "agent_failed"
  | "internal";

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export type CloseReason =
  | "done"
  | "cancelled"
  | "error"
  | "limit_reached"
  | "peer_unavailable"
  | "rejected";

export interface SessionClosePayload {
  reason: CloseReason;
  summary?: string;
}

export interface BaseEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  session_id: string;
  /** Stamped by the host. */
  seq?: number;
  in_reply_to?: string;
  from: Address;
  to: Address | "all";
  ts: string;
}

export type Envelope = BaseEnvelope &
  (
    | { type: "session.open"; payload: SessionOpenPayload }
    | { type: "session.accept"; payload: SessionAcceptPayload }
    | { type: "session.reject"; payload: SessionRejectPayload }
    | { type: "session.status"; payload: SessionStatusPayload }
    | { type: "message" | "question" | "handoff"; payload: TextPayload }
    | { type: "result"; payload: ResultPayload }
    | { type: "error"; payload: ErrorPayload }
    | { type: "session.close"; payload: SessionClosePayload }
  );

export type EnvelopeType = Envelope["type"];
