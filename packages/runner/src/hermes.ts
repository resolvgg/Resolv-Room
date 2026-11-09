import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { alwaysDenyPatterns, globToRegExp, normalizePath } from "@resolvroom/protocol";
import type { Capabilities, EffectivePermissions } from "@resolvroom/protocol";
import type { Runner, RunnerRequest, RunnerResult } from "@resolvroom/core";
import { CONSULT_PREAMBLE, composePrompt, parseAnswer, runProcess } from "./claude-code.js";

export interface HermesRunnerOptions {
  /** Binary name or path. Default "hermes". */
  command?: string;
  /** Folder the process starts in. Hermes gets no file tools (see below), so this is only its working directory. */
  workdir: string;
  /** Receiver's home folder, used to refuse unsafe working folders. Default: os.homedir(). */
  home?: string;
  /** Extra CLI arguments for `hermes chat` (for example ["-m", "anthropic/claude-sonnet-4"]). */
  extraArgs?: string[];
  /** Cap on tool-calling iterations. Default 25. */
  maxTurns?: number;
  /** Hard stop for one run. Default 10 minutes. */
  timeoutMs?: number;
}

/** Linux refuses a single argv string over 128 KiB (MAX_ARG_STRLEN); Hermes 0.19 only takes the query as an argument. */
const MAX_QUERY_BYTES = 120_000;

/** A toolset with no access to files, the shell, the network or other agents. Used so `-t` is never empty. */
const INERT_TOOLSET = "todo";

/**
 * Wakes Hermes Agent headless (`hermes chat -q … -Q`) under the effective permissions.
 *
 * What it enforces (checked against Hermes Agent 0.19 source):
 * - `-t` lists the ONLY toolsets loaded; Hermes then includes nothing else (no terminal, no MCP servers, no
 *   delegation, no browser). network -> `web`; otherwise just the inert `todo` toolset;
 * - NO file access, in any mode: Hermes' read_file/search_files cannot be confined to a folder (they read any
 *   path the process can), so the runner reports read:false/write:false in `session.accept`;
 * - exec is never granted;
 * - `--ignore-rules`: no AGENTS.md/SOUL.md, no persistent memory, no preloaded skills;
 * - `--source tool`: the run stays out of the user's session list.
 */
export class HermesRunner implements Runner {
  readonly agent = "hermes";
  private readonly command: string;
  private readonly home: string;

  constructor(private readonly opts: HermesRunnerOptions) {
    this.command = opts.command ?? "hermes";
    this.home = opts.home ?? homedir();
  }

  async available(): Promise<boolean> {
    try {
      const { code } = await runProcess(this.command, ["--version"], "", 15_000);
      return code === 0;
    } catch {
      return false;
    }
  }

  private cwd(): string | null {
    const f = this.opts.workdir;
    if (!f.startsWith("/") || !existsSync(f) || !statSync(f).isDirectory()) return null;
    const real = normalizePath(realpathSync(f));
    if (real === "/" || real === normalizePath(this.home)) return null;
    return alwaysDenyPatterns(this.home).some((g) => globToRegExp(g).test(real)) ? null : real;
  }

  restrict(p: EffectivePermissions): Capabilities | null {
    if (this.cwd() === null) return null;
    return { read: false, write: false, exec: false, network: p.mode === "auto" && p.capabilities.network };
  }

  describeAccess(p: EffectivePermissions): string {
    const c = this.restrict(p);
    if (!c) return "no access (cannot run safely)";
    return c.network ? "no file access (answers from the request text); may use the web" : "no file or web access (answers from the request text only)";
  }

  buildArgs(p: EffectivePermissions, query: string): { args: string[]; cwd: string } {
    const cwd = this.cwd();
    const caps = this.restrict(p);
    if (!cwd || !caps) throw new Error("runner cannot honor these permissions");
    const toolsets = [INERT_TOOLSET, ...(caps.network ? ["web"] : [])];
    const args = [
      "chat",
      "-q",
      query,
      "-Q",
      "-t",
      toolsets.join(","),
      "--ignore-rules",
      "--source",
      "tool",
      "--max-turns",
      String(this.opts.maxTurns ?? 25),
      ...(this.opts.extraArgs ?? []),
    ];
    return { args, cwd };
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const query = buildHermesQuery(req.peer, req.goal, req.proposal);
    const { args, cwd } = this.buildArgs(req.permissions, query);
    const { code, stdout, stderr } = await runProcess(this.command, args, "", this.opts.timeoutMs ?? 600_000, { cwd, signal: req.signal });
    if (req.signal.aborted) throw new Error("aborted");
    const text = stripHermesNotices(stdout);
    if (code !== 0 || text === "") {
      const why = stderr.replace(/\n?session_id:.*$/m, "").trim().slice(0, 300);
      throw new Error(`hermes exited with code ${code}${why ? `: ${why}` : " and no answer"}`);
    }
    return parseAnswer(text);
  }
}

/** Preamble + consultation, trimmed so it fits in one argv string. */
export function buildHermesQuery(peer: string, goal: string, proposal: string): string {
  const full = `${CONSULT_PREAMBLE}\n\n${composePrompt(peer, goal, proposal)}`;
  if (Buffer.byteLength(full) <= MAX_QUERY_BYTES) return full;
  const overhead = Buffer.byteLength(`${CONSULT_PREAMBLE}\n\n${composePrompt(peer, goal, "")}`) + 200;
  let cut = Buffer.from(proposal).subarray(0, Math.max(0, MAX_QUERY_BYTES - overhead)).toString("utf8");
  cut = cut.replace(/�+$/, "");
  return `${CONSULT_PREAMBLE}\n\n${composePrompt(peer, goal, `${cut}\n\n[… proposal truncated by Resolv Room: too long to pass to Hermes]`)}`;
}

/** Hermes prints a few notices ("⚠ tirith security scanner …") on stdout before the answer: drop them. */
export function stripHermesNotices(stdout: string): string {
  const lines = stdout.split("\n");
  while (lines.length > 0 && (/^\s*$/.test(lines[0] ?? "") || /^\s*(⚠|⚠️)/.test(lines[0] ?? ""))) lines.shift();
  return lines.join("\n").trim();
}
