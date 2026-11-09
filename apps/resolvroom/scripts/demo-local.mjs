#!/usr/bin/env node
// Local demo: two Resolv Room daemons on this machine (no Tailscale, no AI tokens), a consult between them,
// and the approval prompt answered automatically on the "other machine".
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const homes = { alpha: mkdtempSync(join(tmpdir(), "rr-alpha-")), beta: mkdtempSync(join(tmpdir(), "rr-beta-")) };
const ports = { alpha: 17801, beta: 17802 };
const say = (s) => process.stdout.write(`${s}\n`);
// Must be async: a synchronous spawn would freeze this process while the daemons wait for our "y".
const cli = (name, ...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, RESOLVROOM_HOME: homes[name] } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const children = [];
function startDaemon(name) {
  const child = spawn(
    process.execPath,
    [bin, "start", "--insecure-dev-identity", "--stdin-prompts", "--agent", "mock", "--name", name, "--port", String(ports[name])],
    { env: { ...process.env, RESOLVROOM_HOME: homes[name] }, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (const line of String(d).split("\n")) if (line.trim()) say(`  [${name}] ${line}`);
    if (buf.includes("Allow? [y/N]")) {
      buf = "";
      say(`  [${name}] (demo) the human on ${name} types: y`);
      child.stdin.write("y\n");
    }
  });
  child.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => say(`  [${name}!] ${l}`)));
  return child;
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for the daemons");
}

let exit = 0;
try {
  say("== 1. Start two daemons (alpha and beta) ==");
  startDaemon("alpha");
  startDaemon("beta");
  await waitFor(async () => (await cli("alpha", "status")).status === 0 && (await cli("beta", "status")).status === 0);

  say("\n== 2. Each side allows the other (ask mode, read-only) ==");
  say((await cli("alpha", "peer", "allow", "beta", "--endpoint", `http://127.0.0.1:${ports.beta}`)).stdout.trim());
  say((await cli("beta", "peer", "allow", "alpha", "--endpoint", `http://127.0.0.1:${ports.alpha}`)).stdout.trim());

  say('\n== 3. alpha consults beta:  resolvroom consult beta "review my cache fix" ==');
  const r = await cli("alpha", "consult", "beta", "review my cache fix", "--proposal", "I changed the cache key to include the user id. Is that enough?");
  say(r.stdout.trim());
  if (r.stderr.trim()) say(r.stderr.trim());
  exit = r.status ?? 1;

  say("\n== 4. A peer that was not allowed is refused ==");
  await cli("beta", "peer", "remove", "alpha");
  const refused = await cli("alpha", "consult", "beta", "hello again");
  say(refused.stdout.trim().split("\n").slice(-3).join("\n"));
} catch (err) {
  say(`demo failed: ${err.message}`);
  exit = 1;
} finally {
  for (const c of children) c.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  for (const h of Object.values(homes)) rmSync(h, { recursive: true, force: true });
}
say(exit === 0 ? "\nDemo OK." : "\nDemo FAILED.");
process.exit(exit);
