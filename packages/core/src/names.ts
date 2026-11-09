function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Compares two Tailscale node names. Accepts the short MagicDNS name or the FQDN on either side:
 * "notebook-b" matches "notebook-b.example.ts.net". Two different FQDNs never match.
 */
export function peerMatches(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  const xDots = x.includes(".");
  const yDots = y.includes(".");
  if (xDots && yDots) return false;
  const shortX = x.split(".")[0];
  const shortY = y.split(".")[0];
  return shortX === shortY;
}

/** Folder under the inbox where files sent by `peer` land: the peer name made safe for a directory name. */
export function inboxDirFor(inbox: string, peer: string): string {
  const safe = peer.toLowerCase().replace(/[^a-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "_";
  return `${inbox.replace(/\/+$/, "")}/${safe}`;
}
