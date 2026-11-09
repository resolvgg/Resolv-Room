import type { Capabilities, Mode, PermissionProfile } from "./types.js";

/** Tailscale tag that forces a node into ask mode (set by the tailnet admin). */
export const TAG_ASK = "tag:resolvroom-ask";
/** Tailscale tag that makes a node eligible for auto mode. It never grants auto by itself. */
export const TAG_AUTO = "tag:resolvroom-auto";

/**
 * Hard deny list. No permission profile can override it.
 * Patterns are matched case-insensitively against absolute, normalized, symlink-resolved paths.
 */
export function alwaysDenyPatterns(home: string): string[] {
  const h = toPosix(home).replace(/\/+$/, "");
  return [
    `${h}/.ssh/**`,
    `${h}/.aws/**`,
    `${h}/.gnupg/**`,
    `${h}/.kube/**`,
    `${h}/.config/gcloud/**`,
    `${h}/.config/gh/**`,
    `${h}/.docker/config.json`,
    `${h}/.netrc`,
    `${h}/.npmrc`,
    `${h}/.pypirc`,
    `${h}/.password-store/**`,
    `${h}/.local/share/keyrings/**`,
    `${h}/Library/Keychains/**`,
    `${h}/.mozilla/**`,
    `${h}/.config/google-chrome/**`,
    `${h}/.config/chromium/**`,
    `${h}/Library/Application Support/Google/Chrome/**`,
    // The daemon's own config: an agent that could edit it could grant itself auto mode.
    `${h}/.resolvroom/**`,
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/id_ecdsa*",
  ];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globBody(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

/** Minimal glob: `**`, `*` and `?`. A trailing `/**` also matches the folder itself. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const g = toPosix(glob);
  if (g.endsWith("/**")) {
    return new RegExp(`^${globBody(g.slice(0, -3))}(?:/.*)?$`, "i");
  }
  return new RegExp(`^${globBody(g)}$`, "i");
}

export function isAbsolutePath(p: string): boolean {
  const s = toPosix(p);
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

/** Collapses `.` and `..` segments. Callers must resolve symlinks before deciding anything. */
export function normalizePath(p: string): string {
  const s = toPosix(p);
  const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : "";
  const rest = drive ? s.slice(2) : s;
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `${drive}/${out.join("/")}`;
}

/** Case-sensitive on purpose: if the casing differs the check fails closed and the action prompts. */
export function isWithin(root: string, target: string): boolean {
  const r = normalizePath(root).replace(/\/+$/, "");
  const t = normalizePath(target);
  return t === r || t.startsWith(`${r}/`);
}

export type DowngradeReason =
  | "ceiling"
  | "session_cap"
  | "tag_ask"
  | "missing_auto_tag"
  | "expired";

export interface ResolveInput {
  /** Entry from the local allowlist. Undefined means the peer is not allowed. */
  peerProfile: PermissionProfile | undefined;
  /** Highest mode this machine grants to anyone. Default: ask. */
  ceiling?: Mode;
  /** `mode_cap` from the session.open envelope. It can only lower the mode. */
  sessionCap?: Mode;
  /** Tailscale tags of the peer's node, as reported by whois. */
  peerTags?: string[];
  /** Default: true. */
  autoRequiresTag?: boolean;
  now?: Date;
}

export interface EffectivePermissions {
  allowed: true;
  mode: Mode;
  capabilities: Capabilities;
  roots: string[];
  extraDeny: string[];
  outOfScope: "ask" | "deny";
  askTimeoutS: number;
  askRemember: "never" | "session";
  /** Why an auto profile is running as ask. Empty when nothing was downgraded. */
  downgradedBy: DowngradeReason[];
}

export type Resolution = { allowed: false; reason: "peer_not_allowed" } | EffectivePermissions;

/**
 * Decides which mode and capabilities apply to one session.
 * The receiver decides: the requester only ever contributes a cap that lowers the mode.
 */
export function resolvePermissions(input: ResolveInput): Resolution {
  const profile = input.peerProfile;
  if (!profile) {
    return { allowed: false, reason: "peer_not_allowed" };
  }

  const tags = input.peerTags ?? [];
  const downgradedBy: DowngradeReason[] = [];
  let mode: Mode = profile.mode;

  if (mode === "auto") {
    if ((input.ceiling ?? "ask") !== "auto") downgradedBy.push("ceiling");
    if (input.sessionCap === "ask") downgradedBy.push("session_cap");
    if (tags.includes(TAG_ASK)) downgradedBy.push("tag_ask");
    if ((input.autoRequiresTag ?? true) && !tags.includes(TAG_AUTO)) {
      downgradedBy.push("missing_auto_tag");
    }
    const expiresAt = profile.expires_at;
    if (typeof expiresAt === "string") {
      const now = (input.now ?? new Date()).getTime();
      if (Date.parse(expiresAt) <= now) downgradedBy.push("expired");
    }
    if (downgradedBy.length > 0) mode = "ask";
  }

  return {
    allowed: true,
    mode,
    capabilities: { ...profile.capabilities },
    roots: [...(profile.scope?.roots ?? [])],
    extraDeny: [...(profile.scope?.extra_deny ?? [])],
    outOfScope: profile.out_of_scope ?? "ask",
    askTimeoutS: profile.ask?.timeout_s ?? 120,
    askRemember: profile.ask?.remember ?? "never",
    downgradedBy,
  };
}

export type ActionKind = "read" | "write" | "exec" | "network";

export interface Action {
  kind: ActionKind;
  /** Absolute, symlink-resolved path. For exec, the working directory. Not used by network. */
  path?: string;
}

export type Decision =
  | { decision: "allow" }
  | { decision: "ask"; reason: "approval_required" | "outside_scope" | "path_required" }
  | {
      decision: "deny";
      reason:
        | "capability_disabled"
        | "path_not_absolute"
        | "always_deny"
        | "extra_deny"
        | "outside_scope";
    };

/** Decides what happens with one action. A deny can never be turned into an allow by a prompt. */
export function decideAction(
  permissions: EffectivePermissions,
  action: Action,
  options: { home: string },
): Decision {
  if (!permissions.capabilities[action.kind]) {
    return { decision: "deny", reason: "capability_disabled" };
  }

  let target: string | undefined;
  if (action.path !== undefined) {
    if (!isAbsolutePath(action.path)) {
      return { decision: "deny", reason: "path_not_absolute" };
    }
    target = normalizePath(action.path);
    if (alwaysDenyPatterns(options.home).some((g) => globToRegExp(g).test(target as string))) {
      return { decision: "deny", reason: "always_deny" };
    }
    if (permissions.extraDeny.some((g) => globToRegExp(g).test(target as string))) {
      return { decision: "deny", reason: "extra_deny" };
    }
  }

  if (permissions.mode === "ask") {
    return { decision: "ask", reason: "approval_required" };
  }

  // auto mode
  if (action.kind === "network") {
    return { decision: "allow" };
  }
  if (target === undefined) {
    return { decision: "ask", reason: "path_required" };
  }
  if (permissions.roots.some((root) => isWithin(root, target as string))) {
    return { decision: "allow" };
  }
  return permissions.outOfScope === "deny"
    ? { decision: "deny", reason: "outside_scope" }
    : { decision: "ask", reason: "outside_scope" };
}
