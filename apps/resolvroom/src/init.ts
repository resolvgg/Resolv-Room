import { hostname } from "node:os";
import { ConfigStore, resolveHome } from "@resolvroom/core";
import { tailscaleSelf } from "@resolvroom/daemon";
import type { Exec, TailscaleSelf } from "@resolvroom/daemon";
import { runProcess } from "@resolvroom/runner";
import { LineReader, opts, sleep } from "./util.js";
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
    if ((openclaw || hermes) && !claude) io.out("  • Only the Claude Code runner exists today; OpenClaw and Hermes runners are planned.\n");

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
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        try {
          await exec("tailscale", ["set", `--advertise-tags=${wanted.join(",")}`]);
          ok = true;
        } catch (err) {
          const msg = (err as Error).message;
          io.out(`  ✖ \`tailscale set --advertise-tags=${wanted.join(",")}\` failed:\n    ${msg.split("\n")[0]}\n`);
          if (/access denied|permission|operator|sudo/i.test(msg)) {
            io.out(`    This usually needs root. Try:  sudo tailscale set --advertise-tags=${wanted.join(",")}\n    (or once:  sudo tailscale set --operator=$USER)\n`);
          } else {
            io.out(`\n    The tags are not declared in your tailnet policy yet (one time, for the whole tailnet).\n    Open https://login.tailscale.com/admin/acls and ADD these blocks to the policy, then Save:\n\n${ACL_SNIPPET}\n\n    (merge them with what you already have; do not replace your policy)\n`);
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

    // 4. Claude Code
    io.out(`\n4/6  Claude Code\n`);
    if (claude && !values["no-claude"]) {
      await deps.installClaude(values.yes || !interactive ? ["--yes"] : [], { ...io, stdin: io.stdin }).catch((e) => io.out(`  ✖ ${(e as Error).message}\n`));
    } else {
      io.out(claude ? "  • Skipped (--no-claude).\n" : "  • Claude Code not found; skipping the MCP server and /room command.\n");
    }

    // 5. Background service
    io.out(`\n5/6  Background service\n`);
    const canService = servicePaths(process.platform) !== null;
    let service = false;
    if (!canService) io.out("  • Not available on this OS. Run `resolvroom start` in a terminal.\n");
    else {
      const want = values.service ?? (await yesNo(`  Run the daemon as a background service${headless ? " (recommended on a server)" : ""}?`, headless));
      if (want) {
        let workdir = values.workdir;
        if (!workdir && reader) {
          const a = await reader.ask(io, `  Folder the agent may read once you approve a request [${io.cwd}]: `);
          workdir = a && a.trim() ? a.trim() : undefined;
        }
        service = (await serviceCommand(["install", "--yes", ...(workdir ? ["--workdir", workdir] : [])], io)) === 0;
      }
      else io.out("  • Not installing. Start it yourself with `resolvroom start`.\n");
    }

    // 6. Next steps
    io.out(`\n6/6  Next\n`);
    if (!service) io.out("  1. Start the daemon (keep it open):   resolvroom start\n");
    io.out(`  ${service ? "1" : "2"}. Pair with the other machine:\n       here:   resolvroom pair            (shows a code)\n       there:  resolvroom pair ${self.name} <code>\n`);
    if (service || !io.isTTY) io.out(`  ${service ? "2" : "3"}. This daemon has no terminal, so approvals wait in a queue:   resolvroom approvals --watch\n`);
    io.out(`  ${service ? "3" : "4"}. Test:  resolvroom consult <other-machine> "ping"      then in Claude Code:  /room <what you want solved>\n\n`);
    return 0;
  } finally {
    reader?.close();
  }
}
