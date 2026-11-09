import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@resolvroom/protocol";
import type { DaemonConfig } from "@resolvroom/protocol";
import type { ApprovalRequest, Prompter } from "@resolvroom/core";
import { TransferError, TransferReceiver, buildManifest, isSafeRelativePath, offerFor, validateOffer } from "../src/index.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "rr-tx-")));
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const cfg = (peers: string[]): DaemonConfig => ({
  v: PROTOCOL_VERSION,
  peers: peers.map((peer) => ({ peer, profile: { mode: "ask", capabilities: { read: true, write: false, exec: false, network: false } }, added_at: new Date().toISOString() })),
});
class Answer implements Prompter {
  seen: ApprovalRequest[] = [];
  constructor(public a: "allow" | "deny") {}
  async approve(r: ApprovalRequest) {
    this.seen.push(r);
    return this.a;
  }
}
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const offer = (files: Array<{ path: string; content: string }>) => ({
  v: PROTOCOL_VERSION,
  transfer_id: "6f1c1e0e-1111-4222-8333-444455556666",
  root: "proj",
  files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), sha256: sha(f.content) })),
  total_bytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0),
});

describe("paths in an offer", () => {
  it("only plain relative paths are accepted", () => {
    for (const p of ["a.txt", "src/a.ts", ".github/x.yml"]) expect(isSafeRelativePath(p)).toBe(true);
    for (const p of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a\\b", "a\u0000b", "x\n"]) expect(isSafeRelativePath(p)).toBe(false);
  });
  it("validateOffer rejects traversal, duplicates, conflicts and wrong totals", () => {
    expect(typeof validateOffer({ ...offer([{ path: "../evil", content: "x" }]) })).toBe("string");
    expect(typeof validateOffer(offer([{ path: "A", content: "x" }, { path: "a", content: "y" }]))).toBe("string");
    expect(typeof validateOffer(offer([{ path: "a", content: "x" }, { path: "a/b", content: "y" }]))).toBe("string");
    expect(typeof validateOffer({ ...offer([{ path: "a", content: "x" }]), total_bytes: 99 })).toBe("string");
    expect(typeof validateOffer(offer([{ path: "a", content: "x" }]))).toBe("object");
  });
});

describe("TransferReceiver", () => {
  const id = { peer: "laptop", tags: [] };

  it("asks the human, writes into a fresh inbox folder, verifies hashes, then reveals the folder", async () => {
    const inbox = join(tmp(), "inbox");
    const p = new Answer("allow");
    const r = new TransferReceiver({ inbox, config: () => cfg(["laptop"]), prompter: p });
    const o = offer([{ path: "src/a.ts", content: "A" }, { path: "b.md", content: "BB" }]);
    const { token, dest } = await r.offer(id, o);
    expect(p.seen[0]?.transfer).toMatchObject({ files: 2, bytes: 3, root: "proj", dest });
    expect(dest.startsWith(join(inbox, "laptop"))).toBe(true);
    await r.putFile(id, o.transfer_id, 0, token, body("A"));
    expect(() => r.complete(id, o.transfer_id, token)).toThrow(/not received/);
    expect(existsSync(dest)).toBe(false);
    await r.putFile(id, o.transfer_id, 1, token, body("BB"));
    expect(r.complete(id, o.transfer_id, token)).toEqual({ dest, files: 2, bytes: 3 });
    expect(readFileSync(join(dest, "src/a.ts"), "utf8")).toBe("A");
    expect(readdirSync(join(inbox, ".incoming"))).toEqual([]);
  });

  it("a no (or a peer not on the allowlist) writes nothing", async () => {
    const inbox = join(tmp(), "inbox");
    const deny = new TransferReceiver({ inbox, config: () => cfg(["laptop"]), prompter: new Answer("deny") });
    await expect(deny.offer(id, offer([{ path: "a", content: "x" }]))).rejects.toMatchObject({ code: "declined" });
    const stranger = new TransferReceiver({ inbox, config: () => cfg([]), prompter: new Answer("allow") });
    await expect(stranger.offer(id, offer([{ path: "a", content: "x" }]))).rejects.toMatchObject({ code: "not_allowed" });
    expect(existsSync(inbox)).toBe(false);
  });

  it("wrong token, other peer, wrong content or oversize are refused", async () => {
    const inbox = join(tmp(), "inbox");
    const r = new TransferReceiver({ inbox, config: () => cfg(["laptop", "other"]), prompter: new Answer("allow") });
    const o = offer([{ path: "a", content: "hello" }]);
    const { token } = await r.offer(id, o);
    await expect(r.putFile(id, o.transfer_id, 0, "nope", body("hello"))).rejects.toBeInstanceOf(TransferError);
    await expect(r.putFile({ peer: "other", tags: [] }, o.transfer_id, 0, token, body("hello"))).rejects.toMatchObject({ code: "not_found" });
    await expect(r.putFile(id, o.transfer_id, 0, token, body("HELLO"))).rejects.toThrow(/hash/);
    await expect(r.putFile(id, o.transfer_id, 0, token, body("hello world"))).rejects.toThrow(/larger/);
    await r.putFile(id, o.transfer_id, 0, token, body("hello"));
    expect(r.complete(id, o.transfer_id, token).files).toBe(1);
  });
});

describe("buildManifest (sender side)", () => {
  it("leaves out secrets, deps/build/.git and symlinks; keeps the exec bit", async () => {
    const home = tmp();
    const proj = join(home, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(join(proj, "node_modules", "x"), { recursive: true });
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, "src", "a.ts"), "A");
    writeFileSync(join(proj, "run.sh"), "#!/bin/sh");
    chmodSync(join(proj, "run.sh"), 0o755);
    writeFileSync(join(proj, ".env"), "S=1");
    writeFileSync(join(proj, "server.pem"), "k");
    writeFileSync(join(proj, "node_modules", "x", "i.js"), "1");
    writeFileSync(join(proj, ".git", "HEAD"), "r");
    symlinkSync("/etc/passwd", join(proj, "link"));
    const m = await buildManifest([proj], { home });
    expect(m.root).toBe("proj");
    expect(m.entries.map((e) => e.path)).toEqual(["run.sh", "src/a.ts"]);
    expect(m.entries[0]?.exec).toBe(true);
    expect(m.skipped).toEqual({ secrets: [".env", "server.pem"], excluded: 2, links: 1, other: 0 });
    const withAll = await buildManifest([proj], { home, includeGit: true, includeDeps: true });
    expect(withAll.entries.map((e) => e.path)).toEqual([".git/HEAD", "node_modules/x/i.js", "run.sh", "src/a.ts"]);
    expect(typeof validateOffer(offerFor(m, "hi"))).toBe("object");
  });

  it("refuses /, the home folder and secret folders as a whole", async () => {
    const home = tmp();
    mkdirSync(join(home, ".ssh"));
    await expect(buildManifest([home], { home })).rejects.toThrow(/as a whole/);
    await expect(buildManifest(["/"], { home })).rejects.toThrow(/as a whole/);
    await expect(buildManifest([join(home, ".ssh")], { home })).rejects.toThrow(/secrets/);
  });
});
