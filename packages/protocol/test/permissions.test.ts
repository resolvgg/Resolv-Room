import { describe, expect, it } from "vitest";
import {
  TAG_ASK,
  TAG_AUTO,
  decideAction,
  globToRegExp,
  isWithin,
  normalizePath,
  resolvePermissions,
  type EffectivePermissions,
  type PermissionProfile,
} from "../src/index.js";

const HOME = "/home/dev";
const NOW = new Date("2026-11-09T18:00:00Z");

const askProfile: PermissionProfile = {
  mode: "ask",
  capabilities: { read: true, write: false, exec: false, network: false },
};

const autoProfile: PermissionProfile = {
  mode: "auto",
  capabilities: { read: true, write: true, exec: true, network: false },
  scope: { roots: ["/home/dev/projects/checkout"], extra_deny: ["**/secrets/**"] },
  expires_at: "2026-11-09T22:00:00Z",
};

function resolveAuto(overrides: Partial<Parameters<typeof resolvePermissions>[0]> = {}) {
  const result = resolvePermissions({
    peerProfile: autoProfile,
    ceiling: "auto",
    peerTags: [TAG_AUTO],
    now: NOW,
    ...overrides,
  });
  if (!result.allowed) throw new Error("expected an allowed resolution");
  return result;
}

describe("resolvePermissions", () => {
  it("refuses a peer that is not on the allowlist", () => {
    expect(resolvePermissions({ peerProfile: undefined, peerTags: [TAG_AUTO] })).toEqual({
      allowed: false,
      reason: "peer_not_allowed",
    });
  });

  it("keeps ask mode for an ask profile", () => {
    const r = resolvePermissions({ peerProfile: askProfile });
    expect(r.allowed && r.mode).toBe("ask");
    expect(r.allowed && r.downgradedBy).toEqual([]);
  });

  it("grants auto only when profile, ceiling and tag all agree", () => {
    const r = resolveAuto();
    expect(r.mode).toBe("auto");
    expect(r.downgradedBy).toEqual([]);
  });

  it("downgrades to ask when the machine ceiling is ask (the default)", () => {
    const r = resolveAuto({ ceiling: undefined });
    expect(r.mode).toBe("ask");
    expect(r.downgradedBy).toContain("ceiling");
  });

  it("lets the session lower the mode but never raise it", () => {
    expect(resolveAuto({ sessionCap: "ask" }).mode).toBe("ask");
    const ask = resolvePermissions({ peerProfile: askProfile, sessionCap: "auto", ceiling: "auto" });
    expect(ask.allowed && ask.mode).toBe("ask");
  });

  it("downgrades when the node carries the ask tag, even with the auto tag", () => {
    const r = resolveAuto({ peerTags: [TAG_AUTO, TAG_ASK] });
    expect(r.mode).toBe("ask");
    expect(r.downgradedBy).toContain("tag_ask");
  });

  it("requires the auto tag by default", () => {
    const r = resolveAuto({ peerTags: [] });
    expect(r.mode).toBe("ask");
    expect(r.downgradedBy).toContain("missing_auto_tag");
  });

  it("can drop the tag requirement through config", () => {
    expect(resolveAuto({ peerTags: [], autoRequiresTag: false }).mode).toBe("auto");
  });

  it("falls back to ask when the profile has expired", () => {
    const r = resolveAuto({ now: new Date("2026-11-09T22:00:01Z") });
    expect(r.mode).toBe("ask");
    expect(r.downgradedBy).toContain("expired");
  });

  it("treats a null expiry as no expiry", () => {
    const r = resolveAuto({
      peerProfile: { ...autoProfile, expires_at: null },
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(r.mode).toBe("auto");
  });

  it("reports every reason when several downgrades apply", () => {
    const r = resolveAuto({ ceiling: "ask", sessionCap: "ask", peerTags: [TAG_ASK] });
    expect(r.downgradedBy).toEqual(["ceiling", "session_cap", "tag_ask", "missing_auto_tag"]);
  });
});

describe("decideAction", () => {
  const auto: EffectivePermissions = resolveAuto();
  const ask = resolvePermissions({ peerProfile: askProfile }) as EffectivePermissions;
  const opts = { home: HOME };

  it("always asks in ask mode for permitted capabilities", () => {
    expect(decideAction(ask, { kind: "read", path: "/home/dev/projects/checkout/a.ts" }, opts)).toEqual({
      decision: "ask",
      reason: "approval_required",
    });
  });

  it("denies capabilities that are disabled, with no prompt", () => {
    expect(decideAction(ask, { kind: "write", path: "/home/dev/projects/checkout/a.ts" }, opts)).toEqual({
      decision: "deny",
      reason: "capability_disabled",
    });
    expect(decideAction(ask, { kind: "exec", path: "/home/dev" }, opts).decision).toBe("deny");
  });

  it("allows auto mode inside the scope", () => {
    expect(decideAction(auto, { kind: "write", path: "/home/dev/projects/checkout/src/a.ts" }, opts)).toEqual({
      decision: "allow",
    });
    expect(decideAction(auto, { kind: "exec", path: "/home/dev/projects/checkout" }, opts)).toEqual({
      decision: "allow",
    });
  });

  it("asks in auto mode outside the scope by default", () => {
    expect(decideAction(auto, { kind: "read", path: "/home/dev/other/a.ts" }, opts)).toEqual({
      decision: "ask",
      reason: "outside_scope",
    });
  });

  it("denies outside the scope when configured to", () => {
    const strict = resolveAuto({ peerProfile: { ...autoProfile, out_of_scope: "deny" } });
    expect(decideAction(strict, { kind: "read", path: "/etc/hosts" }, opts)).toEqual({
      decision: "deny",
      reason: "outside_scope",
    });
  });

  it("does not treat a sibling folder with the same prefix as inside the scope", () => {
    expect(decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout-evil/a.ts" }, opts).decision).toBe(
      "ask",
    );
  });

  it("applies the hard deny list in every mode", () => {
    for (const perms of [auto, ask]) {
      expect(decideAction(perms, { kind: "read", path: "/home/dev/.ssh/id_rsa" }, opts)).toEqual({
        decision: "deny",
        reason: "always_deny",
      });
    }
  });

  it("protects the daemon config from agents", () => {
    expect(decideAction(auto, { kind: "write", path: "/home/dev/.resolvroom/config.json" }, opts)).toEqual({
      decision: "deny",
      reason: "always_deny",
    });
  });

  it("denies .env files even inside an auto scope", () => {
    expect(decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout/.env" }, opts).decision).toBe(
      "deny",
    );
    expect(decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout/.env.production" }, opts).decision).toBe(
      "deny",
    );
  });

  it("is not fooled by path traversal", () => {
    expect(
      decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout/../../.ssh/id_rsa" }, opts),
    ).toEqual({ decision: "deny", reason: "always_deny" });
    expect(decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout/../other/a.ts" }, opts).decision).toBe(
      "ask",
    );
  });

  it("is not fooled by letter case on the deny list", () => {
    expect(decideAction(auto, { kind: "read", path: "/home/dev/.SSH/id_rsa" }, opts).decision).toBe("deny");
  });

  it("honors extra_deny inside the scope", () => {
    expect(decideAction(auto, { kind: "read", path: "/home/dev/projects/checkout/secrets/token.txt" }, opts)).toEqual({
      decision: "deny",
      reason: "extra_deny",
    });
  });

  it("rejects relative paths", () => {
    expect(decideAction(auto, { kind: "read", path: "src/a.ts" }, opts)).toEqual({
      decision: "deny",
      reason: "path_not_absolute",
    });
  });

  it("asks when auto mode has no path to check", () => {
    expect(decideAction(auto, { kind: "read" }, opts)).toEqual({ decision: "ask", reason: "path_required" });
  });

  it("allows network in auto mode only when the capability is enabled", () => {
    const withNet = resolveAuto({
      peerProfile: { ...autoProfile, capabilities: { ...autoProfile.capabilities, network: true } },
    });
    expect(decideAction(withNet, { kind: "network" }, opts)).toEqual({ decision: "allow" });
    expect(decideAction(auto, { kind: "network" }, opts).decision).toBe("deny");
  });

  it("runs a downgraded auto profile as ask: the scope no longer pre-approves anything", () => {
    const downgraded = resolveAuto({ peerTags: [] });
    expect(decideAction(downgraded, { kind: "read", path: "/home/dev/projects/checkout/a.ts" }, opts)).toEqual({
      decision: "ask",
      reason: "approval_required",
    });
  });
});

describe("path helpers", () => {
  it("normalizes dot segments and backslashes", () => {
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePath("C:\\Users\\dev\\..\\x")).toBe("C:/Users/x");
  });

  it("checks containment without prefix confusion", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/b/", "/a/b/c")).toBe(true);
  });

  it("translates globs", () => {
    expect(globToRegExp("**/*.pem").test("/x/y/server.pem")).toBe(true);
    expect(globToRegExp("/h/.ssh/**").test("/h/.ssh")).toBe(true);
    expect(globToRegExp("/h/.ssh/**").test("/h/.sshd/x")).toBe(false);
    expect(globToRegExp("/a/*.txt").test("/a/b/c.txt")).toBe(false);
  });
});
