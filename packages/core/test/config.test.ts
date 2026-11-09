import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, ConfigStore, FileLogStore, peerMatches } from "../src/index.js";
import { writeFileSync } from "node:fs";
import { profile } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rr-core-"));

describe("peerMatches", () => {
  it("matches short and FQDN, case and trailing dot insensitive", () => {
    expect(peerMatches("notebook-b", "notebook-b.example.ts.net.")).toBe(true);
    expect(peerMatches("Notebook-B", "notebook-b")).toBe(true);
    expect(peerMatches("notebook-b.a.ts.net", "notebook-b.b.ts.net")).toBe(false);
    expect(peerMatches("notebook-a", "notebook-b")).toBe(false);
  });
});

describe("ConfigStore", () => {
  it("starts empty, saves with 0600, upserts and removes peers", () => {
    const store = new ConfigStore(join(tmp(), "home"));
    expect(store.load().peers).toEqual([]);
    store.upsertPeer("notebook-b", profile(), "http://127.0.0.1:7801");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(store.findPeer("notebook-b.example.ts.net")?.endpoint).toBe("http://127.0.0.1:7801");
    store.upsertPeer("notebook-b", profile({ ask: { timeout_s: 30 } }));
    expect(store.load().peers).toHaveLength(1);
    expect(store.load().peers[0]?.profile.ask?.timeout_s).toBe(30);
    expect(store.removePeer("notebook-b")).toBe(true);
    expect(store.removePeer("notebook-b")).toBe(false);
  });

  it("rejects an invalid file and refuses to write an invalid config", () => {
    const store = new ConfigStore(tmp());
    writeFileSync(store.path, JSON.stringify({ v: "0.1", peers: [{ peer: "x" }] }));
    expect(() => store.load()).toThrow(ConfigError);
    expect(() => store.save({ v: "0.1", peers: [{ peer: "bad name!", profile: profile(), added_at: "x" }] })).toThrow(ConfigError);
  });

  it("auto without expires_at is invalid", () => {
    const store = new ConfigStore(tmp());
    expect(() => store.upsertPeer("p", { mode: "auto", capabilities: { read: true, write: false, exec: false, network: false }, scope: { roots: ["/a"] } })).toThrow(ConfigError);
  });
});

describe("FileLogStore", () => {
  it("writes JSON Lines and decisions", () => {
    const dir = join(tmp(), "logs");
    const logs = new FileLogStore(dir);
    const log = logs.session("11111111-1111-4111-8111-111111111111");
    const n = log.append(
      { v: "0.1", id: "i", session_id: "s", type: "message", from: { peer: "a" }, to: { peer: "b" }, ts: "t", payload: { text: "x" } },
      "out",
    );
    expect(n).toBe(0);
    logs.decision({ session_id: "s", peer: "a", event: "ask", detail: { answer: "allow" } });
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).toContain('"event":"ask"');
    expect(() => logs.session("../evil")).toThrow();
  });
});
