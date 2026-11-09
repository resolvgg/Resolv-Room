import type { HttpPeerClient } from "./client.js";
import { PeerHttpError } from "./client.js";
import { buildManifest, offerFor } from "./transfer.js";
import type { Manifest, ManifestOptions } from "./transfer.js";

export interface SendRequest {
  peer: string;
  paths: string[];
  message?: string;
  include_git?: boolean;
  include_deps?: boolean;
}

export type SendOutcome =
  | { status: "sent"; peer: string; files: number; bytes: number; dest: string; skipped: Manifest["skipped"] }
  | { status: "declined"; peer: string; message: string; skipped: Manifest["skipped"] }
  | { status: "error"; peer: string; message: string };

/** Builds the manifest, offers it, uploads every file (a few at a time) and asks the receiver to finish. */
export async function sendFiles(client: HttpPeerClient, req: SendRequest, o: Pick<ManifestOptions, "home"> & { concurrency?: number }): Promise<SendOutcome> {
  let manifest: Manifest;
  try {
    manifest = await buildManifest(req.paths, { home: o.home, ...(req.include_git ? { includeGit: true } : {}), ...(req.include_deps ? { includeDeps: true } : {}) });
  } catch (err) {
    return { status: "error", peer: req.peer, message: (err as Error).message };
  }
  const offer = offerFor(manifest, req.message);
  let accepted: { token: string; dest: string };
  try {
    accepted = await client.offerTransfer(req.peer, offer);
  } catch (err) {
    if (err instanceof PeerHttpError && (err.code === "declined" || err.code === "not_allowed")) {
      return { status: "declined", peer: req.peer, message: err.code === "declined" ? "the owner of that machine declined (or did not answer in time)" : "that machine does not have you on its allowlist", skipped: manifest.skipped };
    }
    return { status: "error", peer: req.peer, message: (err as Error).message };
  }
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < manifest.entries.length) {
        const i = next++;
        const e = manifest.entries[i];
        if (e) await client.uploadFile(req.peer, offer.transfer_id, i, accepted.token, e.abs, e.size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, manifest.entries.length) }, worker));
    const done = await client.completeTransfer(req.peer, offer.transfer_id, accepted.token);
    return { status: "sent", peer: req.peer, files: done.files, bytes: done.bytes, dest: done.dest, skipped: manifest.skipped };
  } catch (err) {
    return { status: "error", peer: req.peer, message: `upload failed: ${(err as Error).message}` };
  }
}
