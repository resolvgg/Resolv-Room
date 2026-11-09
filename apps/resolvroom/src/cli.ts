import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigStore, resolveHome } from "@resolvroom/core";
import { ControlClient, ControlError, QueuePrompter, TerminalPrompter, startDaemon, tailscaleSelf } from "@resolvroom/daemon";
import type { DaemonOptions } from "@resolvroom/daemon";
import { formatSend, peerSkillMarkdown, roomCommandMarkdown, runStdioServer } from "@resolvroom/mcp";
import type { PermissionProfile } from "@resolvroom/protocol";
import { ClaudeCodeRunner, HermesRunner, MockRunner, runProcess } from "@resolvroom/runner";
import { installHermesCommand } from "./hermes.js";
import { updateCommand } from "./update.js";
import { UsageError, confirm, opts, parseDuration, workdirProblem } from "./util.js";
import { approvalsCommand, pairCommand } from "./pair.js";
import { serviceCommand } from "./service.js";
import { initCommand } from "./init.js";
import type { Io } from "./util.js";

export const HELP = `resolvroom: let AI agents on different machines work on a problem together over your tailnet

Usage: resolvroom <command> [options]

Setup
  init [--yes] [--auto-eligible] [--service] [--agent claude-code|hermes] [--no-claude] [--no-hermes]
                             Guided setup: identify this machine, set the Tailscale tags, register Claude Code, install the service
  doctor                     Check Node, Tailscale (and its tags), Claude Code and the daemon
  pair                       Show a pairing code (5 min, single use)
  pair <peer> <code>         Pair with a machine that is showing a code (no need for peer allow)
  service install|uninstall|restart
                             Run the daemon in the background (systemd --user / launchd)
  install-claude [--yes|--print]
                             Register the MCP server with Claude Code and install the /room command
  install-hermes [--yes|--print]
                             Register the MCP server with Hermes Agent and install the /room skill
  update                     Download the latest version, rebuild, restart the service (keeps your setup)
  peer allow <name> [options]  Allow a peer (do this on BOTH machines)
       --mode ask|auto         default ask (every session needs your OK)
       --write --network       extra capabilities (read is on by default; --no-read turns it off)
       --scope <dir>           folder for auto mode (repeatable; required for auto)
       --expires 8h|30m|2d     required for auto (or --no-expiry)
       --endpoint <url>        default http://<name>:7777
  peer list | peer remove <name>
  ceiling ask|auto           Highest mode this machine will ever grant (default ask)

Run
  start [options]            Run the daemon (keep it open: it asks you before agents act in ask mode)
       --workdir <dir>         folder the agent can read once you approve (default: current folder)
       --inbox <dir>           where received files land (default ~/resolvroom-inbox)
       --agent claude-code|hermes|mock
                               hermes answers from the request text only (its file tools cannot be confined to a folder)
  consult <peer> <goal...> [--proposal <text>] [--ask-only]
  send <peer> <path>... [-m note] [--include-git] [--include-deps]
                             Send files/folders; the other owner accepts; they land in its ~/resolvroom-inbox/<you>/
                             (secrets are never sent; node_modules/build/.git left out unless asked)
  approvals [--watch]        Requests waiting for your OK (daemons without a terminal); approve <id> | deny <id>
  mcp                        MCP server on stdio (used by Claude Code)
  status                     Ask the running daemon

Local testing without Tailscale (two daemons on one machine)
  start --insecure-dev-identity --name alpha --bind 127.0.0.1 --port 7801 --agent mock
  (add --stdin-prompts to answer approval questions on stdin when there is no terminal)
  Or just run: pnpm demo:local
`;

const READ_ONLY = { read: true, write: false, exec: false, network: false };

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      case "--version":
      case "-v":
        io.out(`${version()}\n`);
        return 0;
      case "peer":
        return await peerCommand(rest, io);
      case "ceiling":
        return await ceilingCommand(rest, io);
      case "consult":
        return await consultCommand(rest, io);
      case "send":
        return await sendCommand(rest, io);
      case "status":
        return await statusCommand(io);
      case "mcp":
        await runStdioServer(store(io).socketPath);
        return 0;
      case "start":
        return await startCommand(rest, io);
      case "doctor":
        return await doctorCommand(io);
      case "init":
        return await initCommand(rest, io, { installClaude: installClaudeCommand, installHermes: installHermesCommand });
      case "pair":
        return await pairCommand(rest, io);
      case "approvals":
        return await approvalsCommand(rest, io, "list");
      case "approve":
        return await approvalsCommand(rest, io, "allow");
      case "deny":
        return await approvalsCommand(rest, io, "deny");
      case "service":
        return await serviceCommand(rest, io);
      case "install-hermes":
        return await installHermesCommand(rest, io);
      case "update":
        return await updateCommand(rest, io);
      case "install-claude":
        return await installClaudeCommand(rest, io);
      default:
        throw new UsageError(`unknown command "${cmd}". Run "resolvroom help".`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`resolvroom: ${err.message}\n`);
      return 2;
    }
    if (err instanceof ControlError) {
      io.err(`resolvroom: ${err.message}\n`);
      return 1;
    }
    io.err(`resolvroom: ${(err as Error).message}\n`);
    return 1;
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const store = (io: Io): ConfigStore => new ConfigStore(resolveHome(io.env));

// ───────────────────────────────── peers ─────────────────────────────────

async function peerCommand(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  const s = store(io);
  if (sub === "list") {
    const cfg = s.load();
    if (cfg.peers.length === 0) io.out("No peers. Add one with: resolvroom peer allow <name>\n");
    for (const p of cfg.peers) {
      const c = p.profile.capabilities;
      const caps = (Object.keys(c) as Array<keyof typeof c>).filter((k) => c[k]).join("+") || "none";
      const extra = p.profile.mode === "auto" ? `, scope ${(p.profile.scope?.roots ?? []).join(",")}, expires ${p.profile.expires_at ?? "never"}` : "";
      io.out(`${p.peer}  mode=${p.profile.mode}  caps=${caps}${extra}${p.endpoint ? `  endpoint=${p.endpoint}` : ""}\n`);
    }
    return 0;
  }
  if (sub === "remove") {
    const name = rest[0];
    if (!name) throw new UsageError("usage: resolvroom peer remove <name>");
    io.out(s.removePeer(name) ? `Removed ${name}.\n` : `${name} was not on the list.\n`);
    return 0;
  }
  if (sub === "allow") {
    const { values, positionals } = opts(rest, {
      mode: { type: "string" },
      read: { type: "boolean" },
      write: { type: "boolean" },
      exec: { type: "boolean" },
      network: { type: "boolean" },
      scope: { type: "string", multiple: true },
      expires: { type: "string" },
      "no-expiry": { type: "boolean" },
      endpoint: { type: "string" },
      "ask-timeout": { type: "string" },
    });
    const name = positionals[0];
    if (!name) throw new UsageError("usage: resolvroom peer allow <name> [options]");
    const mode = values.mode ?? "ask";
    if (mode !== "ask" && mode !== "auto") throw new UsageError('--mode must be "ask" or "auto"');
    if (values.exec) throw new UsageError("--exec is not supported yet: the Claude Code runner cannot confine commands to a folder");
    const profile: PermissionProfile = {
      mode,
      capabilities: { read: values.read ?? true, write: values.write ?? false, exec: false, network: values.network ?? false },
    };
    if (values["ask-timeout"]) {
      const n = Number(values["ask-timeout"]);
      if (!Number.isInteger(n) || n < 5 || n > 3600) throw new UsageError("--ask-timeout must be between 5 and 3600 seconds");
      profile.ask = { timeout_s: n };
    }
    if (mode === "auto") {
      const roots = (values.scope ?? []).map((r) => resolve(io.cwd, r));
      if (roots.length === 0) throw new UsageError("auto mode needs at least one --scope <folder>");
      if (!values.expires && !values["no-expiry"]) throw new UsageError("auto mode needs --expires <8h|30m|2d> (or --no-expiry, explicitly)");
      profile.scope = { roots };
      profile.expires_at = values["no-expiry"] ? null : new Date(Date.now() + parseDuration(values.expires as string)).toISOString();
    } else if (values.scope?.length || values.expires) {
      throw new UsageError("--scope and --expires only apply to --mode auto");
    }
    s.upsertPeer(name, profile, values.endpoint);
    io.out(`Allowed ${name} in ${mode} mode.\n`);
    if (mode === "auto") {
      const cfg = s.load();
      if ((cfg.ceiling ?? "ask") !== "auto") io.out('Note: this machine\'s ceiling is "ask", so sessions still run in ask mode. Raise it with: resolvroom ceiling auto\n');
      io.out("Note: auto also needs the peer's Tailscale node to carry tag:resolvroom-auto (and not tag:resolvroom-ask).\n");
    }
    io.out("Remember: the other machine must also allow this one, or it will refuse.\n");
    return 0;
  }
  throw new UsageError("usage: resolvroom peer allow|list|remove");
}

function ceilingCommand(args: string[], io: Io): number {
  const v = args[0];
  const s = store(io);
  if (v !== "ask" && v !== "auto") {
    io.out(`ceiling: ${s.load().ceiling ?? "ask"}\n`);
    return 0;
  }
  const cfg = s.load();
  cfg.ceiling = v;
  s.save(cfg);
  io.out(`Ceiling set to ${v}.\n`);
  return 0;
}

// ───────────────────────────────── consult ─────────────────────────────────

async function sendCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = opts(args, {
    message: { type: "string", short: "m" },
    "include-git": { type: "boolean" },
    "include-deps": { type: "boolean" },
  });
  const [peer, ...paths] = positionals;
  if (!peer || paths.length === 0) throw new UsageError('usage: resolvroom send <peer> <file-or-folder>... [-m "note"] [--include-git] [--include-deps]');
  const client = new ControlClient(store(io).socketPath);
  io.out(`Preparing and offering the files to ${peer}... (its owner has to accept)\n`);
  const out = await client.send({
    peer,
    paths: paths.map((p) => resolve(io.cwd, p)),
    ...(values.message ? { message: values.message } : {}),
    ...(values["include-git"] ? { include_git: true } : {}),
    ...(values["include-deps"] ? { include_deps: true } : {}),
  });
  io.out(`${formatSend(out)}\n`);
  return out.status === "sent" ? 0 : 1;
}

async function consultCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = opts(args, { proposal: { type: "string" }, "ask-only": { type: "boolean" } });
  const [peer, ...goalWords] = positionals;
  const goal = goalWords.join(" ").trim();
  if (!peer || !goal) throw new UsageError('usage: resolvroom consult <peer> "<goal>" [--proposal "<text>"] [--ask-only]');
  const client = new ControlClient(store(io).socketPath);
  io.out(`Consulting ${peer}... (it may ask its user for approval first)\n`);
  const out = await client.consult({
    peer,
    goal,
    proposal: values.proposal ?? goal,
    ...(values["ask-only"] ? { mode_cap: "ask" as const } : {}),
  });
  const where = out.effective ? ` (applied there: ${out.effective.mode} mode)` : "";
  io.out(`\n${peer}: ${out.status}${where}\n\n${out.summary}\n`);
  return ["solved", "partial", "unsolved"].includes(out.status) ? 0 : 1;
}

async function statusCommand(io: Io): Promise<number> {
  const client = new ControlClient(store(io).socketPath);
  const s = await client.status();
  io.out(`daemon "${s.name}" is running (pid ${s.pid}), agents: ${s.agents.join(", ")}, active sessions: ${s.active_guest_sessions}\n`);
  return 0;
}

// ───────────────────────────────── start ─────────────────────────────────

async function startCommand(args: string[], io: Io): Promise<number> {
  const { values } = opts(args, {
    name: { type: "string" },
    bind: { type: "string" },
    port: { type: "string" },
    workdir: { type: "string" },
    agent: { type: "string" },
    "claude-command": { type: "string" },
    "hermes-command": { type: "string" },
    inbox: { type: "string" },
    "insecure-dev-identity": { type: "boolean" },
    "dev-tags": { type: "string" },
    "stdin-prompts": { type: "boolean" },
  });
  const dev = values["insecure-dev-identity"] === true;
  const port = values.port ? Number(values.port) : 7777;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a number");
  let name = values.name;
  let bind = values.bind;
  if (dev) {
    if (!name) throw new UsageError("--name is required with --insecure-dev-identity");
    bind ??= "127.0.0.1";
    io.err("WARNING: dev identity is for local testing only. Anyone who can reach this port can pretend to be any peer.\n");
  } else {
    const self = await tailscaleSelf();
    name ??= self.name;
    bind ??= self.ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (!bind) throw new UsageError("could not find this machine's Tailscale IPv4 address; pass --bind");
    if (!self.tags.includes("tag:resolvroom")) io.err('Note: this node does not carry tag:resolvroom yet (run "resolvroom doctor").\n');
  }

  const workdir = resolve(io.cwd, values.workdir ?? ".");
  const inbox = resolve(io.cwd, values.inbox ?? io.env.RESOLVROOM_INBOX ?? join(io.env.HOME ?? homedir(), "resolvroom-inbox"));
  const agent = values.agent ?? "claude-code";
  if (agent === "claude-code" || agent === "hermes") {
    const problem = workdirProblem(workdir, io.env.HOME ?? homedir());
    if (problem) throw new UsageError(`--workdir: ${problem}. Start the daemon inside (or with --workdir) the project folder you want to share.`);
  }
  const runner =
    agent === "mock"
      ? new MockRunner({ name })
      : agent === "claude-code"
        ? new ClaudeCodeRunner({ workdir, inbox, ...(values["claude-command"] ? { command: values["claude-command"] } : {}) })
        : agent === "hermes"
          ? new HermesRunner({ workdir, ...(values["hermes-command"] ? { command: values["hermes-command"] } : {}) })
          : null;
  if (!runner) throw new UsageError('--agent must be "claude-code", "hermes" or "mock"');

  const interactive = io.isTTY || values["stdin-prompts"] === true;
  const queue = interactive ? undefined : new QueuePrompter();
  const prompter = queue ?? new TerminalPrompter({ input: io.stdin, output: { write: (s: string | Uint8Array) => (io.out(String(s)), true) } as NodeJS.WritableStream });
  if (!interactive) io.err("No terminal attached: requests that need approval wait in a queue. Answer them with `resolvroom approvals --watch` (or approve/deny <id>).\n");

  const options: DaemonOptions = {
    home: resolveHome(io.env),
    name,
    bind,
    port,
    identity: dev ? "dev" : "tailscale",
    devTags: values["dev-tags"] ? values["dev-tags"].split(",") : [],
    runner,
    prompter,
    inbox,
    ...(queue ? { approvals: queue } : {}),
    onError: (e) => io.err(`resolvroom: ${String(e)}\n`),
  };
  const d = await startDaemon(options);
  io.out(
    [
      `Resolv Room daemon "${d.name}" listening on http://${d.host}:${d.port}`,
      `  agent:   ${agent}${agent === "claude-code" ? ` (can read ${workdir} after you approve)` : agent === "hermes" ? " (answers from the request text; no file access)" : " (no AI, echoes only)"}`,
      `  config:  ${d.store.path}`,
      `  peers:   ${d.store.load().peers.map((p) => p.peer).join(", ") || "none yet (resolvroom peer allow <name>)"}`,
      "Waiting for requests. Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  await new Promise<void>((done) => {
    const stop = (): void => done();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await d.close();
  return 0;
}

// ───────────────────────────────── doctor / init ─────────────────────────────────

async function doctorCommand(io: Io): Promise<number> {
  let failed = 0;
  const ok = (m: string): void => io.out(`✔ ${m}\n`);
  const bad = (m: string, fix?: string): void => {
    failed++;
    io.out(`✖ ${m}\n`);
    if (fix) io.out(`    ${fix.split("\n").join("\n    ")}\n`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} (need 22 or newer)`, "Install Node 22+: https://nodejs.org");

  try {
    const self = await tailscaleSelf();
    ok(`Tailscale: this machine is "${self.name}" (${self.ips[0] ?? "no IP"})`);
    if (self.tags.includes("tag:resolvroom")) ok(`Tag tag:resolvroom present (${self.tags.join(", ")})`);
    else
      bad(
        "Tag tag:resolvroom not found on this node",
        [
          "1. In the Tailscale admin console (Access controls) add tagOwners and an ACL for tag:resolvroom on port 7777",
          "   (snippet: spec/permissions-v0.1.md, section 5).",
          "2. Then, in the admin console Machines list, this machine's ⋯ menu > Edit ACL tags: add tag:resolvroom and tag:resolvroom-ask",
          "   (tag:resolvroom-auto instead of -ask only on a machine that may ever run in auto mode), or run resolvroom init.",
        ].join("\n"),
      );
  } catch (err) {
    bad(`Tailscale: ${(err as Error).message}`, "Install and log in: https://tailscale.com/download");
  }

  const agentVersion = async (cmd: string): Promise<string | null> => {
    try {
      const { code, stdout } = await runProcess(cmd, ["--version"], "", 15_000, { env: io.env });
      return code === 0 ? stdout.trim().split("\n")[0] ?? "found" : null;
    } catch {
      return null;
    }
  };
  const [claudeV, hermesV] = await Promise.all([agentVersion("claude"), agentVersion("hermes")]);
  if (claudeV) ok(`Claude Code: ${claudeV}`);
  if (hermesV) ok(`Hermes Agent: ${hermesV} (answers from the request text only)`);
  if (!claudeV && !hermesV) bad("No agent found (claude or hermes) in PATH", "Install Claude Code (https://claude.com/claude-code) or Hermes Agent  (or use --agent mock to try without one)");

  try {
    const s = await new ControlClient(store(io).socketPath).status();
    ok(`Daemon running as "${s.name}" (pid ${s.pid})`);
  } catch {
    io.out("• Daemon not running (start it with: resolvroom start)\n");
  }

  const peers = store(io).load().peers;
  io.out(`• ${peers.length} peer(s) allowed${peers.length ? `: ${peers.map((p) => p.peer).join(", ")}` : ""}\n`);
  return failed === 0 ? 0 : 1;
}

// ───────────────────────────────── install-claude ─────────────────────────────────

export function writeIfChanged(io: Io, file: string, content: string, label: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === content) {
    io.out(`• ${label} already up to date\n`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  io.out(`✔ wrote ${file}\n`);
}

async function installClaudeCommand(args: string[], io: Io): Promise<number> {
  const { values } = opts(args, { yes: { type: "boolean" }, print: { type: "boolean" } });
  const claudeDir = io.env.CLAUDE_CONFIG_DIR && io.env.CLAUDE_CONFIG_DIR.length > 0 ? io.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  const cmdFile = join(claudeDir, "commands", "room.md");
  const wanted = roomCommandMarkdown();
  const bin = realpathSync(process.argv[1] ?? "");
  // The name must come before -e: -e takes a list and would swallow it.
  const mcpArgs = ["mcp", "add", "--scope", "user", "resolvroom"];
  if (io.env.RESOLVROOM_HOME) mcpArgs.push("-e", `RESOLVROOM_HOME=${io.env.RESOLVROOM_HOME}`);
  mcpArgs.push("--", process.execPath, bin, "mcp");

  const skillFile = join(claudeDir, "skills", "resolvroom", "SKILL.md");
  io.out(`This will:\n  1. write the /room command to ${cmdFile}\n  2. write the resolvroom skill (loads by itself for "migrate/send/ask the other machine") to ${skillFile}\n  3. run: claude ${mcpArgs.join(" ")}\n`);
  if (values.print) {
    io.out(`\n--- ${cmdFile} ---\n${wanted}`);
    return 0;
  }
  const current = existsSync(cmdFile) ? readFileSync(cmdFile, "utf8") : undefined;
  if (current !== undefined && current !== wanted) io.out(`Note: ${cmdFile} exists with different content and will be overwritten.\n`);
  if (!values.yes && !(await confirm(io, "Proceed?"))) {
    io.out("Nothing changed. (Use --yes to skip this question, or --print to see the command file.)\n");
    return 1;
  }
  if (current === wanted) io.out("• /room command already up to date\n");
  else {
    mkdirSync(dirname(cmdFile), { recursive: true });
    writeFileSync(cmdFile, wanted);
    io.out(`✔ wrote ${cmdFile}\n`);
  }
  writeIfChanged(io, skillFile, peerSkillMarkdown(), "resolvroom skill");
  try {
    const got = await runProcess("claude", ["mcp", "get", "resolvroom"], "", 15_000, { env: io.env });
    if (got.code === 0) {
      io.out("• MCP server \"resolvroom\" is already registered in Claude Code\n");
      return 0;
    }
    const add = await runProcess("claude", mcpArgs, "", 30_000, { env: io.env });
    if (add.code !== 0) throw new Error(add.stderr.trim() || add.stdout.trim() || `exit ${add.code}`);
    io.out('✔ registered the MCP server "resolvroom" in Claude Code (user scope)\n');
  } catch (err) {
    io.err(`Could not run the claude CLI (${(err as Error).message}). Register it yourself:\n  claude ${mcpArgs.join(" ")}\n`);
    return 1;
  }
  io.out("Restart Claude Code, then try:  /room <what you want solved>\n");
  return 0;
}
