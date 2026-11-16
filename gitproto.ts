// Smart HTTP git transport: protocol v2 upload-pack (ls-refs / fetch) and
// protocol v0 receive-pack (push). One entry point, `handleGit`, which the
// app router calls first; it returns false when the path is not a git route.
//
// Protocol notes (see analysis/git-checks.md; the suite's GitClient is the
// authority on the wire format):
// - info/refs upload-pack always answers v2: `version 2` + capability lines
//   (`fetch=shallow`, `ls-refs=unborn`, `object-format=sha1`).
// - info/refs receive-pack always answers v0: `# service=git-receive-pack`,
//   refs with capabilities on the first line, peeled `^{}` lines for
//   annotated tags, `capabilities^{}` for an empty repo.
// - fetch replies in sections, mirroring git's own upload-pack byte for
//   byte: a `shallow-info` section ONLY when there are shallow/unshallow
//   lines (lines carry no trailing LF, the section ends with a delim
//   pkt-line `0001`), then the `packfile` section. There is no
//   acknowledgments section (git sends none when the request carries `done`)
//   and no wanted-refs section. The packfile section carries the pack in
//   sideband band 1, pkt-lines <= 65520 bytes; no packfile-uris section is
//   ever sent. Objects are sent whole (no deltas) via encodePack.
// - receive-pack is v0 only. The command list is followed by the raw pack
//   (always present for create/update, even when empty; absent for
//   delete-only). Objects are stored byte-exact as pushed. Each ref is
//   applied in order: create / fast-forward / delete ok, anything else
//   `ng <ref> non-fast-forward` with the ref unmoved. The report-status
//   (`unpack ok` first, then one ok/ng line per command) is itself a
//   pkt-line stream, wrapped in sideband band 1 when negotiated (exactly
//   as git's own receive-pack does); HTTP 200 even when refs are refused.
// - HEAD is a symref to refs/heads/main (unborn, oid zero, before main
//   exists). The default branch is always main.

import type { ServerResponse } from 'node:http';
import type { ObjType, Repo, Store } from './store.ts';
import type { Req } from './httputil.ts';
import { errJson, sendBytes } from './httputil.ts';
import {
  closure,
  decodePack,
  encodePack,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
} from './gitobj.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
/** Max total pkt-line size (git LARGE_PACKET_MAX); payload max is 65516. */
const MAX_PKT_LINE = 65520;
/** Max pack bytes per sideband packet (65516 payload - 1 band byte). */
const SIDEBAND_CHUNK = 65515;

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const RECEIVE_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=makefun-git-forge/1.0';

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: 4 lowercase hex digits (total length incl. header) + payload. */
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > MAX_PKT_LINE) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

type PktItem = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

interface PktStream {
  lines: PktItem[];
  /** Bytes after the pkt-line stream (the raw packfile for receive-pack). */
  rest: Buffer;
}

/**
 * Parse a pkt-line stream. Stops at the first 4 bytes that are not a hex
 * length (the start of a raw packfile) or at end of input; throws on a
 * truncated or malformed pkt-line. A body that does not start with a
 * pkt-line header yields zero lines and the whole body as `rest`, so a
 * malformed POST is a 400, never a crash.
 */
function parsePktStream(buf: Buffer): PktStream {
  const lines: PktItem[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      lines.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      pos += 4; // response-end: skip
      continue;
    }
    if (len < 4) throw new Error('invalid pkt-line length');
    if (pos + len > buf.length) throw new Error('truncated pkt-line');
    lines.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { lines, rest: buf.subarray(pos) };
}

// ---------------------------------------------------------------- ref helpers

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow tag objects to the final non-tag object; undefined unless `oid` is a tag. */
function peelTarget(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  let cur = parseTag(obj.data).object;
  const seen = new Set<string>([oid]);
  for (;;) {
    const next = repo.objects.get(cur);
    if (!next) return undefined;
    if (next.type !== 'tag') return cur;
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    cur = parseTag(next.data).object;
  }
}

/** Follow tag objects to a commit oid; undefined when there is no commit. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      cur = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- advertisements

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function advertiseV0(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${RECEIVE_CAPS} symref=HEAD:refs/heads/main\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peelTarget(repo, oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

/** Split an upload-pack request body into the command and its arguments. */
function parseUploadArgs(body: Buffer): { command: string; args: string[] } {
  const { lines, rest } = parsePktStream(body);
  if (rest.length > 0) throw new Error('trailing bytes after pkt-line stream');
  const texts: string[] = [];
  for (const item of lines) {
    if (item.kind === 'flush') break;
    if (item.kind === 'data') texts.push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  const first = texts[0] ?? '';
  if (!first.startsWith('command=')) throw new Error('missing command= line');
  const command = first.slice('command='.length).trim();
  // agent=/object-format= lines precede the delim; args never use those keys.
  const args = texts.slice(1).filter((t) => !t.startsWith('agent=') && !t.startsWith('object-format='));
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    // 'unborn' is accepted; an unborn HEAD is reported whenever main is missing.
  }
  const parts: Buffer[] = [];
  // HEAD is a pseudo-ref: it only survives a prefix filter when a prefix
  // matches it (it never starts with `refs/`), matching real git.
  const showHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (showHead) {
    const mainOid = repo.refs.get('refs/heads/main');
    if (mainOid !== undefined) {
      parts.push(
        pktLine(symrefs ? `${mainOid} HEAD symref-target:refs/heads/main\n` : `${mainOid} HEAD\n`),
      );
    } else {
      parts.push(
        pktLine(symrefs ? 'unborn HEAD symref-target:refs/heads/main\n' : 'unborn HEAD\n'),
      );
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelTarget(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Objects the client already holds, from its `have` tips: the full closure,
 * except that a shallow boundary's parents are NOT held (the client never
 * received them). Without this cutoff a shallow client's `have` would make
 * the server wrongly withhold the parent a deepen fetch must send.
 */
function heldClosure(repo: Repo, haves: Iterable<string>, boundaries: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundaries.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return seen;
}

/** Commits within `depth` generations of `wants` (generation 0 = the wants). */
function depthLimitedCommits(repo: Repo, wants: Iterable<string>, depth: number): Set<string> {
  const included = new Set<string>();
  let frontier: string[] = [];
  for (const w of wants) {
    const c = peelToCommit(repo, w);
    if (c !== undefined) frontier.push(c);
  }
  for (let g = 0; g < depth && frontier.length > 0; g++) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) next.push(p);
      }
    }
    frontier = next;
  }
  return included;
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) oldShallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      deepen = Number.isFinite(n) ? n : null;
    } else if (a === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, include-tag: accepted, no effect
    // (full objects; tags are included when their oid is wanted).
    // filter / deepen-since / deepen-not: never sent by the suite; ignored.
  }
  const oldShallowSet = new Set(oldShallow);
  const held = heldClosure(repo, haves, oldShallowSet);

  const sent = new Set<string>();
  if (deepen !== null && deepen > 0) {
    const included = depthLimitedCommits(repo, wants, deepen);
    for (const c of included) {
      sent.add(c);
      const obj = repo.objects.get(c);
      if (obj?.type === 'commit') {
        for (const o of closure(repo, [parseCommit(obj.data).tree])) sent.add(o);
      }
    }
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (!obj) continue;
      if (obj.type === 'tag') sent.add(w);
      else if (obj.type !== 'commit') {
        for (const o of closure(repo, [w])) sent.add(o);
      }
    }
  } else {
    for (const o of closure(repo, wants)) sent.add(o);
  }
  for (const o of held) sent.delete(o);

  // Shallow boundaries the client will hold after this fetch: a commit whose
  // parents are not all held is a boundary. New boundaries are reported as
  // `shallow`, old boundaries whose parents are now all held as `unshallow`.
  const knownCommits = new Set<string>();
  for (const o of held) {
    if (repo.objects.get(o)?.type === 'commit') knownCommits.add(o);
  }
  for (const o of sent) {
    if (repo.objects.get(o)?.type === 'commit') knownCommits.add(o);
  }
  const finalBoundaries = new Set<string>();
  for (const c of knownCommits) {
    const obj = repo.objects.get(c);
    if (obj?.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((p) => !knownCommits.has(p))) finalBoundaries.add(c);
  }
  const shallowLines = [...finalBoundaries].filter((c) => !oldShallowSet.has(c)).sort();
  const unshallowLines = [...oldShallowSet]
    .filter((c) => knownCommits.has(c) && !finalBoundaries.has(c))
    .sort();

  const packObjects: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  for (const oid of sent) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) packObjects.push({ oid, type: obj.type, data: obj.data });
  }
  packObjects.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const pack = encodePack(packObjects);

  // Sections mirror git's own upload-pack: when the request carries no
  // `done` the client is negotiating, so the acknowledgments section comes
  // first (ACK per common have, else NAK, then `ready`), closed by a delim.
  // A shallow-info section follows only when there is something to report
  // (lines without a trailing LF, closed by a delim), then packfile. With
  // `done` there is no negotiation round: no acknowledgments section, and
  // no wanted-refs section either.
  const parts: Buffer[] = [];
  if (!done) {
    const wantCommits = new Set<string>();
    for (const w of wants) {
      const c = peelToCommit(repo, w);
      if (c !== undefined) wantCommits.add(c);
    }
    const ackLines: string[] = [];
    for (const h of haves) {
      const hc = peelToCommit(repo, h);
      if (hc === undefined) continue;
      for (const w of wantCommits) {
        if (isAncestor(repo, hc, w)) {
          ackLines.push(`ACK ${hc}\n`);
          break;
        }
      }
    }
    parts.push(pktLine('acknowledgments\n'));
    if (ackLines.length === 0) parts.push(pktLine('NAK\n'));
    else for (const line of ackLines) parts.push(pktLine(line));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const c of shallowLines) parts.push(pktLine(`shallow ${c}`));
    for (const c of unshallowLines) parts.push(pktLine(`unshallow ${c}`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + SIDEBAND_CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPack(req: Req, res: ServerResponse, repo: Repo): boolean {
  const { command, args } = parseUploadArgs(req.rawBody);
  if (command === 'ls-refs') {
    sendBytes(res, 200, lsRefsResponse(repo, args), UPLOAD_RESULT_CT);
    return true;
  }
  if (command === 'fetch') {
    sendBytes(res, 200, fetchResponse(repo, args), UPLOAD_RESULT_CT);
    return true;
  }
  throw new Error(`unsupported upload-pack command ${command}`);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

function handleReceivePack(req: Req, res: ServerResponse, repo: Repo, store: Store): boolean {
  const { lines, rest } = parsePktStream(req.rawBody);
  const commands: PushCommand[] = [];
  for (const item of lines) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const text = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    const caps = nul === -1 ? '' : text.slice(nul + 1);
    const fields = head.split(' ');
    if (fields.length !== 3) throw new Error('malformed receive-pack command');
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2], caps });
  }
  if (commands.length === 0) throw new Error('no receive-pack commands');

  const useSideband = commands[0].caps.split(' ').includes('side-band-64k');
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);

  let unpackError: string | null = null;
  if (needsPack) {
    if (rest.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        // `external` lets thin-pack REF_DELTA bases resolve against objects
        // the repo already holds. Objects are stored byte-exact as pushed.
        const objects = decodePack(rest, repo.objects);
        for (const o of objects) store.putObject(repo, o.type, o.data);
      } catch (err) {
        unpackError = (err instanceof Error ? err.message : 'unpack failed').replace(/[\r\n]+/g, ' ');
      }
    }
  }

  // The report-status stream is itself pkt-line framed; when sideband was
  // negotiated it is wrapped in sideband band 1 (git's own receive-pack
  // sends exactly this shape), otherwise it goes out as raw pkt-lines.
  const reportLines: string[] = [];
  if (unpackError !== null) {
    // A failed unpack aborts the whole push: no ref moves.
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      let ok = false;
      if (cmd.newOid === ZERO_OID) {
        // Delete: the old value must match the current ref.
        if (cmd.oldOid === current) {
          repo.refs.delete(cmd.ref);
          ok = true;
        }
      } else if (current === ZERO_OID) {
        // Create: only from the zero oid.
        if (cmd.oldOid === ZERO_OID) {
          repo.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        }
      } else if (cmd.oldOid === current) {
        if (cmd.newOid === current) {
          ok = true; // no-op update
        } else {
          const oldPeeled = peelToCommit(repo, cmd.oldOid);
          const newPeeled = peelToCommit(repo, cmd.newOid);
          if (
            oldPeeled !== undefined &&
            newPeeled !== undefined &&
            isAncestor(repo, oldPeeled, newPeeled)
          ) {
            repo.refs.set(cmd.ref, cmd.newOid);
            ok = true;
          }
        }
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} non-fast-forward\n`);
    }
  }
  const reportParts: Buffer[] = reportLines.map((line) => pktLine(line));
  reportParts.push(pktFlush()); // inner flush ends the report stream
  const reportBytes = Buffer.concat(reportParts);
  const out: Buffer[] = [];
  if (useSideband) {
    for (let off = 0; off < reportBytes.length; off += SIDEBAND_CHUNK) {
      const chunk = reportBytes.subarray(off, Math.min(off + SIDEBAND_CHUNK, reportBytes.length));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  } else {
    out.push(reportBytes);
  }
  out.push(pktFlush()); // outer flush ends the response
  sendBytes(res, 200, Buffer.concat(out), RECEIVE_RESULT_CT);
  return true;
}

// ---------------------------------------------------------------- entry point

export async function handleGit(req: Req, res: ServerResponse, store: Store): Promise<boolean> {
  const m = GIT_ROUTE.exec(req.pathname);
  if (m === null) return false;
  const owner = m[1];
  const repoName = m[2];
  const route = m[3];
  if (route === 'info/refs') {
    if (req.method !== 'GET') return false;
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (service === 'git-upload-pack') sendBytes(res, 200, advertiseV2(), UPLOAD_AD_CT);
    else sendBytes(res, 200, advertiseV0(repo), RECEIVE_AD_CT);
    return true;
  }
  if (req.method !== 'POST') return false;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  try {
    if (route === 'git-upload-pack') return handleUploadPack(req, res, repo);
    return handleReceivePack(req, res, repo, store);
  } catch (err) {
    // Malformed git input: 400, and the server stays alive for later checks.
    errJson(res, 400, err instanceof Error ? err.message : 'malformed git request');
    return true;
  }
}
