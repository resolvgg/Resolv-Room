import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig, validateEnvelope, validatePermissionProfile } from "../src/index.js";

const examplesDir = new URL("../../../spec/examples/", import.meta.url);

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(name, examplesDir), "utf8"));
}

const files = readdirSync(examplesDir);

describe("spec examples", () => {
  for (const file of files.filter((f) => f.endsWith(".envelope.json"))) {
    it(`${file} is a valid envelope`, () => {
      const result = validateEnvelope(load(file));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });
  }
  for (const file of files.filter((f) => f.endsWith(".profile.json"))) {
    it(`${file} is a valid permission profile`, () => {
      const result = validatePermissionProfile(load(file));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });
  }
  for (const file of files.filter((f) => f.endsWith(".config.json"))) {
    it(`${file} is a valid daemon config`, () => {
      const result = validateConfig(load(file));
      expect(result.ok ? [] : result.errors).toEqual([]);
    });
  }
});

describe("envelope validation", () => {
  const base = () => load("consult-proposal.envelope.json");

  it("rejects an unsupported protocol version", () => {
    expect(validateEnvelope({ ...base(), v: "0.2" }).ok).toBe(false);
  });

  it("rejects a malformed session id", () => {
    expect(validateEnvelope({ ...base(), session_id: "not-a-uuid" }).ok).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    expect(validateEnvelope({ ...base(), surprise: true }).ok).toBe(false);
  });

  it("rejects a message without text", () => {
    expect(validateEnvelope({ ...base(), payload: {} }).ok).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(validateEnvelope({ ...base(), type: "shell.exec" }).ok).toBe(false);
  });

  it("rejects a result with an unknown status", () => {
    const env = load("consult-result.envelope.json");
    env.payload.status = "maybe";
    expect(validateEnvelope(env).ok).toBe(false);
  });

  it("rejects a room opened with a single participant", () => {
    const env = load("room-open.envelope.json");
    env.payload.participants = [env.payload.participants[0]];
    expect(validateEnvelope(env).ok).toBe(false);
  });

  it("rejects a status payload that tries to carry details", () => {
    const env = load("status-awaiting-approval.envelope.json");
    env.payload.detail = "reading /home/dev/.ssh/id_rsa";
    expect(validateEnvelope(env).ok).toBe(false);
  });

  it("rejects a session.accept that discloses folder paths", () => {
    const env = load("consult-accept.envelope.json");
    env.payload.effective.roots = ["/home/dev/projects"];
    expect(validateEnvelope(env).ok).toBe(false);
  });

  it("rejects limits outside the allowed range", () => {
    const env = load("consult-open.envelope.json");
    env.payload.limits.max_rounds = 0;
    expect(validateEnvelope(env).ok).toBe(false);
  });
});

describe("permission profile validation", () => {
  it("accepts ask mode without a scope", () => {
    expect(validatePermissionProfile(load("default.profile.json")).ok).toBe(true);
  });

  it("requires a scope for auto mode", () => {
    const profile = load("trusted-auto.profile.json");
    delete profile.scope;
    expect(validatePermissionProfile(profile).ok).toBe(false);
  });

  it("requires at least one root for auto mode", () => {
    const profile = load("trusted-auto.profile.json");
    profile.scope.roots = [];
    expect(validatePermissionProfile(profile).ok).toBe(false);
  });

  it("requires expires_at for auto mode", () => {
    const profile = load("trusted-auto.profile.json");
    delete profile.expires_at;
    expect(validatePermissionProfile(profile).ok).toBe(false);
  });

  it("accepts an explicit null expiry for auto mode", () => {
    const profile = load("trusted-auto.profile.json");
    profile.expires_at = null;
    expect(validatePermissionProfile(profile).ok).toBe(true);
  });

  it("rejects incomplete capabilities", () => {
    const profile = load("default.profile.json");
    delete profile.capabilities.exec;
    expect(validatePermissionProfile(profile).ok).toBe(false);
  });

  it("rejects an unknown mode", () => {
    const profile = load("default.profile.json");
    profile.mode = "yolo";
    expect(validatePermissionProfile(profile).ok).toBe(false);
  });
});

describe("daemon config validation", () => {
  it("rejects an auto peer without a scope", () => {
    const config = load("daemon.config.json");
    delete config.peers[1].profile.scope;
    expect(validateConfig(config).ok).toBe(false);
  });

  it("rejects a peer entry without added_at", () => {
    const config = load("daemon.config.json");
    delete config.peers[0].added_at;
    expect(validateConfig(config).ok).toBe(false);
  });

  it("rejects an invalid port", () => {
    const config = load("daemon.config.json");
    config.listen.port = 70000;
    expect(validateConfig(config).ok).toBe(false);
  });
});
