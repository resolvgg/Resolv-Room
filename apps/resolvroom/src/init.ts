import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { ConfigStore, resolveHome } from "@resolvroom/core";
import { tailscaleSelf } from "@resolvroom/daemon";
import type { Exec, TailscaleSelf } from "@resolvroom/daemon";
import { runProcess } from "@resolvroom/runner";
import { LineReader, opts, sleep, workdirProblem } from "./util.js";
import type { Io } from "./util.js";
import { serviceCommand, servicePaths } from "./service.js";

export const ACL_SNIPPET = `  "tagOwners": {
    "tag:resolvroom":      ["autogroup:admin"],
    "tag:resolvroom-ask":  ["autogroup:admin"],
    "tag:resolvroom-auto": ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["tag:resolvroom"], "dst": ["tag:resolvroom:7777"] }
  ]`;

const TAG = "tag:resolvroom";
const TAG_ASK = "tag:resolvroom-ask";
const TAG_AUTO = "tag:resolvroom-auto";

export interface InitDeps {
  installClaude(args: string[], io: Io): Promise<number>;
  installHermes?(args: string[], io: Io): Promise<number>;
}

/** The tag list to advertise: keep the machine's other tags, replace the ask/auto marker, make sure the base tag is there. */
export function mergeTags(existing: string[], autoEligible: boolean): string[] {
  const keep = existing.filter((t) => t !== TAG && t !== TAG_ASK && t !== TAG_AUTO);
  return [...keep, TAG, autoEligible ? TAG_AUTO : TAG_ASK];
}

export function tagsAreSet(existing: string[], autoEligible: boolean): boolean {
  const want = autoEligible ? TAG_AUTO : TAG_ASK;
  const other = autoEligible ? TAG_ASK : TAG_AUTO;
  return existing.includes(TAG) && existing.includes(want) && !existing.includes(other);
}

async function probe(cmd: string, io: Io): Promise<string | null> {
  try {
    const r = await runProcess(cmd, ["--version"], "", 8000, { env: io.env });
    return r.code === 0 ? r.stdout.trim().split("\n")[0] || "found" : null;
  } catch {
    return null;
  }
}

export async function initCommand(args: string[], io: Io, deps: InitDeps): Promise<number> {
  const { values } = opts(args, {
    yes: { type: "boolean" },
    "auto-eligible": { type: "boolean" },
    service: { type: "boolean" },
    "no-claude": { type: "boolean" },
    "no-hermes": { type: "boolean" },
    agent: { type: "string" },
    workdir: { type: "string" },
  });
  const interactive = io.isTTY && !values.yes;
  const reader = interactive ? new LineReader(io.stdin) : undefined;
  const yesNo = async (q: string, def: boolean): Promise<boolean> => (reader ? reader.yesNo(io, q, def) : def);
  const exec: Exec = async (file, a) => {
    const r = await runProcess(file, a, "", 15_000, { env: io.env });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit code ${r.code}`);
    return r.stdout;
  };
  try {
    // 1. Who is this machine?
    const headless = process.platform === "linux" && !io.env.DISPLAY && !io.env.WAYLAND_DISPLAY;
    io.out(`\n1/6  This machine\n`);
    io.out(`  ✔ ${hostname()} (${process.platform}/${process.arch}, Node ${process.versions.node}${headless ? ", headless: looks like a server" : ""})\n`);
    const [claude, openclaw, hermes] = await Promise.all([probe("claude", io), probe("openclaw", io), probe("hermes", io)]);
    const found = [claude && `claude-code (${claude})`, openclaw && "openclaw", hermes && "hermes"].filter(Boolean);
    io.out(found.length ? `  ✔ Agents found: ${found.join(", ")}\n` : "  • No agent found (claude, openclaw, hermes). You can still run with --agent mock to try it.\n");
    if (openclaw) io.out("  • OpenClaw is not supported yet (planned).\n");

    // 2. Tailscale
    io.out(`\n2/6  Tailscale\n`);
    let self: TailscaleSelf;
    try {
      self = await tailscaleSelf(exec);
    } catch (err) {
      io.out(`  ✖ ${(err as Error).message}\n    Install and log in: https://tailscale.com/download   then run this again.\n`);
      return 1;
    }
    io.out(`  ✔ Node name "${self.name}", address ${self.ips[0] ?? "?"}\n`);

    // 3. Tags
    io.out(`\n3/6  Tags\n`);
    const autoEligible = values["auto-eligible"] ?? (await yesNo("  May this machine run requests unattended (auto mode) for peers you later grant it to?", false));
    io.out(`  ${autoEligible ? `Marking this machine eligible for auto (${TAG_AUTO}). You still grant auto per peer, with a folder and an expiry.` : `Keeping it in ask mode only (${TAG_ASK}).`}\n`);
    let current = self.tags;
    if (tagsAreSet(current, autoEligible)) {
      io.out(`  ✔ Already tagged: ${current.join(", ")}\n`);
    } else {
      const wanted = mergeTags(current, autoEligible);
      let ok = false;
      const flag = `--advertise-tags=${wanted.join(",")}`;
      const firstLine = (m: string): string => m.split("\n")[0] ?? "";
      const user = io.env.USER ?? io.env.LOGNAME ?? "$USER";
      let useUp = false;
      const consoleHint =
        `    Or skip the terminal: in https://login.tailscale.com/admin/machines open this machine's ⋯ menu > Edit ACL tags,\n` +
        `    add ${wanted.join(" and ")}, then press Enter here.\n`;
      const applyTags = async (): Promise<void> => {
        if (useUp) {
          await exec("tailscale", ["up", flag]);
          return;
        }
        try {
          await exec("tailscale", ["set", flag]);
        } catch (err) {
          // Older Tailscale versions have no `set --advertise-tags`; `up` does the same thing.
          if (!/flag provided but not defined/i.test(firstLine((err as Error).message))) throw err;
          io.out("  • `tailscale set` cannot change tags here; using `tailscale up` instead.\n");
          useUp = true;
          await exec("tailscale", ["up", flag]);
        }
      };
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        if (attempt > 0 && tagsAreSet((await tailscaleSelf(exec).catch(() => self)).tags, autoEligible)) {
          ok = true; // you applied them yourself while the wizard was waiting
          break;
        }
        try {
          await applyTags();
          ok = true;
        } catch (err) {
          const msg = (err as Error).message;
          const head = firstLine(msg);
          io.out(`  ✖ Could not apply ${flag}\n    ${head}\n`);
          if (/non-default flags|mentioning all/i.test(msg)) {
            io.out(
              "\n    `tailscale up` needs every non-default setting of this machine repeated. Tailscale printed the exact command it wants:\n\n" +
                `${msg.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n")}\n\n` +
                `    Run that command with ${flag} added (with sudo if needed), or update Tailscale (\`tailscale update\`) to get \`tailscale set --advertise-tags\`.\n` + consoleHint,
            );
          } else if (/access denied|permission denied|must be root|requires root|use sudo|operator/i.test(head)) {
            const cmd = useUp ? `sudo tailscale up ${flag} --operator=${user}` : `sudo tailscale set ${flag}`;
            io.out(`    Your user may not change Tailscale settings. In another terminal run:\n      ${cmd}\n${consoleHint}`);
          } else if (/tags?\b.*(invalid|not permitted)|not permitted|invalid tag/i.test(head)) {
            io.out(`\n    The tags are not declared in your tailnet policy yet (one time, for the whole tailnet).\n    Open https://login.tailscale.com/admin/acls and ADD these blocks to the policy, then Save:\n\n${ACL_SNIPPET}\n\n    (merge them with what you already have; do not replace your policy)\n`);
          } else {
            io.out(`    ${msg.split("\n").slice(1, 4).join("\n    ")}\n    Fix that, or set the tags yourself:  sudo tailscale up ${flag} --operator=${user}\n${consoleHint}`);
          }
          if (!reader) return 1;
          const a = await reader.ask(io, "  Press Enter after fixing it to retry (or type skip): ");
          if (a === null || /^\s*skip\s*$/i.test(a)) {
            io.out("  Skipped. Without the tag, other machines cannot reach this one through the tailnet policy.\n");
            break;
          }
        }
      }
      if (ok) {
        let seen = false;
        for (let i = 0; i < 15 && !seen; i++) {
          current = (await tailscaleSelf(exec).catch(() => self)).tags;
          seen = tagsAreSet(current, autoEligible);
          if (!seen) await sleep(1000);
        }
        io.out(seen ? `  ✔ Tags applied: ${current.join(", ")}\n` : "  ✖ The tags were requested but have not shown up in `tailscale status` yet. Check the admin console, then run `resolvroom doctor`.\n");
      }
    }
    const store = new ConfigStore(resolveHome(io.env));
    const cfg = store.load();
    cfg.ceiling = autoEligible ? "auto" : "ask";
    store.save(cfg);

    // 4. Agents: let the local agents call other machines (/room)
    io.out(`\n4/6  Agents\n`);
    const nested = { ...io, ...(reader ? { reader } : {}) };
    const installArgs = values.yes || !interactive ? ["--yes"] : [];
    if (claude && !values["no-claude"]) {
      io.out("  Claude Code:\n");
      await deps.installClaude(installArgs, nested).catch((e) => io.out(`  ✖ ${(e as Error).message}\n`));
    } else if (claude) io.out("  • Claude Code: skipped (--no-claude).\n");
    if (hermes && !values["no-hermes"] && deps.installHermes) {
      io.out("  Hermes:\n");
      await deps.installHermes(installArgs, nested).catch((e) => io.out(`  ✖ ${(e as Error).message}\n`));
    } else if (hermes) io.out("  • Hermes: skipped.\n");
    if (!claude && !hermes) io.out("  • No supported agent found; skipping the MCP server and /room.\n");

    // Which agent answers requests that arrive from other machines.
    const answerers = [claude && "claude-code", hermes && "hermes"].filter((a): a is string => Boolean(a));
    let agent = values.agent ?? answerers[0] ?? "claude-code";
    if (!values.agent && answerers.length > 1 && reader) {
      io.out("  Which agent should answer requests from other machines?\n    1. claude-code  (can read the shared folder after you approve)\n    2. hermes       (answers from the request text only; its file tools cannot be confined to a folder)\n");
      const a = await reader.ask(io, "  Choose 1 or 2 [1]: ");
      agent = (a ?? "").trim() === "2" || /^h/i.test((a ?? "").trim()) ? "hermes" : "claude-code";
    }
    if (!["claude-code", "hermes", "mock"].includes(agent)) {
      io.out(`  ✖ Unknown agent "${agent}" (use claude-code, hermes or mock)\n`);
      return 1;
    }
    io.out(`  ✔ Requests from other machines will be answered by: ${agent}\n`);

    // 5. Background service
    io.out(`\n5/6  Background service\n`);
    const canService = servicePaths(process.platform) !== null;
    let service = false;
    if (!canService) io.out("  • Not available on this OS. Run `resolvroom start` in a terminal.\n");
    else {
      const want = values.service ?? (await yesNo(`  Run the daemon as a background service${headless ? " (recommended on a server)" : ""}?`, headless));
      if (want) {
        const home = io.env.HOME ?? homedir();
        let workdir: string | undefined = values.workdir ? resolve(io.cwd, values.workdir) : undefined;
        if (!workdir) {
          const fallback = join(home, "resolvroom-workspace");
          const suggested = workdirProblem(io.cwd, home) === null ? io.cwd : fallback;
          for (let i = 0; i < 5 && !workdir; i++) {
            const a = reader ? await reader.ask(io, `  Folder the agent may read once you approve a request [${suggested}]: `) : null;
            const dir = resolve(io.cwd, (a ?? "").trim().replace(/^~(?=$|\/)/, home) || suggested);
            if (!existsSync(dir) && (dir === fallback || (reader && (await reader.yesNo(io, `  ${dir} does not exist. Create it?`, true))))) {
              mkdirSync(dir, { recursive: true });
              io.out(`  ✔ created ${dir}\n`);
            }
            const problem = workdirProblem(dir, home);
            if (problem) io.out(`  ✖ ${problem}\n`);
            else workdir = dir;
            if (!reader) break;
          }
        }
        if (!workdir) io.out("  • No usable folder; not installing the service. Later:  resolvroom service install --workdir <project folder>\n");
        else service = (await serviceCommand(["install", "--yes", "--workdir", workdir, "--agent", agent], io)) === 0;
      }
      else io.out("  • Not installing. Start it yourself with `resolvroom start`.\n");
    }

    // 6. Next steps
    io.out(`\n6/6  Next\n`);
    if (!service) io.out(`  1. Start the daemon (keep it open):   resolvroom start --agent ${agent}\n`);
    io.out(`  ${service ? "1" : "2"}. Pair with the other machine:\n       here:   resolvroom pair            (shows a code)\n       there:  resolvroom pair ${self.name} <code>\n`);
    if (service || !io.isTTY) io.out(`  ${service ? "2" : "3"}. This daemon has no terminal, so approvals wait in a queue:   resolvroom approvals --watch\n`);
    io.out(`  ${service ? "3" : "4"}. Test:  resolvroom consult <other-machine> "ping"      then in Claude Code or Hermes:  /room <what you want solved>\n\n`);
    writeFileSync(join(resolveHome(io.env), "setup-done"), `${new Date().toISOString()}\n`);
    return 0;
  } finally {
    reader?.close();
  }
}
