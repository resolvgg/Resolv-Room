import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { alwaysDenyPatterns, globToRegExp, normalizePath } from "@resolvroom/protocol";
import type { Capabilities } from "@resolvroom/protocol";
import type { AccessRequest, ApprovalAnswer } from "@resolvroom/core";

export type PermissionDecision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

export interface AccessContext {
  /** Folders the session already allows (real paths). */
  folders: string[];
  caps: Capabilities;
  home: string;
  cwd: string;
  /**
   * What the human allowed during this run (real paths). Mutated when a new one is allowed. A "names" grant (from
   * Glob) only lists file names under that folder; a "contents" grant lets Read/Grep open that one file.
   */
  granted: Array<{ path: string; what: "names" | "contents" }>;
  ask?: (request: AccessRequest) => Promise<ApprovalAnswer>;
  /** The profile's `scope.extra_deny` globs: denied without asking. */
  extraDeny?: string[];
  /** The profile's `out_of_scope` in auto mode: "deny" turns every outside request into a deny without asking. */
  outOfScope?: "ask" | "deny";
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

function realOrSelf(p: string): string {
  try {
    return normalizePath(existsSync(p) ? realpathSync(p) : p);
  } catch {
    return normalizePath(p);
  }
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** Secrets and system files: never readable, whatever the human answers. */
export function alwaysDenied(path: string, home: string): boolean {
  if (SECRET_NAME.test(basename(path))) return true;
  return alwaysDenyPatterns(home).some((g) => globToRegExp(g).test(path));
}

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string" && input[k]) return input[k] as string;
  return undefined;
}

/**
 * Decides one Claude Code permission prompt. Only reads can be extended at run time, one path at a time, by the
 * local human; secrets, writes outside the session's folders and anything else are refused without asking.
 */
export async function decideAccess(tool: string, input: Record<string, unknown>, ctx: AccessContext): Promise<PermissionDecision> {
  const allow = (): PermissionDecision => ({ behavior: "allow", updatedInput: input });
  const deny = (message: string): PermissionDecision => ({ behavior: "deny", message });

  if (NETWORK_TOOLS.has(tool)) return ctx.caps.network ? allow() : deny("web access is not allowed in this session");

  const raw = pathOf(input) ?? (tool === "Glob" || tool === "Grep" ? ctx.cwd : undefined);
  if (raw === undefined) return deny(`${tool} is not allowed in this session`);
  const target = realOrSelf(resolve(ctx.cwd, raw));
  const home = realOrSelf(ctx.home);

  if (WRITE_TOOLS.has(tool)) {
    if (ctx.caps.write && ctx.folders.some((f) => inside(target, f)) && !alwaysDenied(target, home)) return allow();
    return deny("changes outside the shared folders are never allowed");
  }
  if (!READ_TOOLS.has(tool)) return deny(`${tool} is not allowed in this session`);
  if (!ctx.caps.read) return deny("reading files is not allowed in this session");
  if (alwaysDenied(target, home)) return deny("this path holds secrets or system files and is always denied");
  if ((ctx.extraDeny ?? []).some((g) => globToRegExp(g).test(target))) return deny("this path is on this peer's deny list");
  if (target === "/" || target === home) return deny("that is too broad; ask for a specific file or project folder");
  const isDir = existsSync(target) && statSync(target).isDirectory();
  // Searching file contents across a folder outside the session could surface secrets inside it (.env files and the
  // like are only filtered inside the shared folders). Outside, contents are read one file at a time.
  if (tool === "Grep" && isDir && !ctx.folders.some((f) => inside(target, f))) {
    return deny("outside the shared folder, search one file at a time (Read or Grep a file), or ask the owner to share the folder");
  }
  const what = tool === "Glob" ? "names" : "contents";
  if (ctx.folders.some((f) => inside(target, f))) return allow();
  if (ctx.granted.some((g) => (what === "names" ? g.what === "names" && inside(target, g.path) : g.what === "contents" && g.path === target))) return allow();
  if (ctx.outOfScope === "deny") return deny("outside the shared folders, and this peer's settings say not to ask");
  if (!ctx.ask) return deny("outside the shared folder (no one is available to approve)");
  const answer = await ctx.ask({ tool, target });
  if (answer !== "allow") return deny("the owner of this machine did not allow reading this path");
  ctx.granted.push({ path: target, what });
  return allow();
}
