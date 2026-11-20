// Git object model + packfile codec. Everything is byte-exact: objects the
// suite pushes are stored exactly as received and never re-serialized, so a
// clone returns the same bytes the client built (SHA-1 recomputes to the same id).
//
// Only the standard library is used: node:crypto for SHA-1, node:zlib for pack
// entry compression. No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType, Repo } from './store.ts';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id: SHA-1 of "<type> <len>\0" + data. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Message with ONE trailing newline stripped (git stores it with one). */
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let message = blank === -1 ? '' : text.slice(blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', msg);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  /** '100644' for files, '40000' for directories (no leading zero). */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git tree order: entries sort by name, directories as if named `name + '/'`. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let message = blank === -1 ? '' : text.slice(blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfile

/** Encode one pack entry header: varint type+size. */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** PACK v2, no deltas. `objects` may be in any order; the caller picks it. */
export function encodePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  // Memoized: the same object set (same oids, same order) always encodes to the
  // same bytes — objects are stored byte-exact and never mutated, so the oid
  // sequence fully determines the output. A fetch of the same tip (the clone
  // workload's 50 concurrent depth-1 clones) pays the deflate once.
  const key = objects.map((o) => o.oid).join(',');
  const hit = PACK_CACHE.get(key);
  if (hit !== undefined) return hit;
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const o of objects) {
    chunks.push(packEntryHeader(TYPE_CODES[o.type], o.data.length));
    chunks.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  const out = Buffer.concat([body, trailer]);
  if (PACK_CACHE.size >= PACK_CACHE_MAX) PACK_CACHE.clear();
  PACK_CACHE.set(key, out);
  return out;
}

/** Memoized pack encodings, keyed by the oid sequence (order included). */
const PACK_CACHE = new Map<string, Buffer>();
const PACK_CACHE_MAX = 1024;

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  /** For OFS_DELTA: base entry offset. For REF_DELTA: base oid. */
  baseOffset: number;
  baseOid: string;
  /** Inflated entry bytes (delta instructions for delta entries). */
  data: Buffer;
}

/** Read a pack entry header at `pos`; returns header + position after it. */
function readEntryHeader(buf: Buffer, pos: number): { typeCode: number; size: number; next: number } {
  let b = buf[pos++];
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = buf[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: pos };
}

/** Apply git delta instructions (`delta`) to `base`. The target size is read
 * from the delta itself (the pack entry header's size is the DELTA's length,
 * not the target's — a real git pack's delta entries prove it). */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[p++];
      out |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return out;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) {
    throw new Error('delta source size mismatch');
  }
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) len = delta[p++];
      if (op & 0x20) len |= delta[p++] << 8;
      if (op & 0x40) len |= delta[p++] << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(off, off + len));
      total += len;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Inflate the entry at `pos` in exactly one call. inflateSync stops at the
 * deflate stream's end and ignores trailing bytes; with `{ info: true }` the
 * engine reports the input bytes it consumed, which is the stream's exact
 * length (verified against node writePack packs and real git packs, plain and
 * delta entries alike). Returns null when the shape is unavailable or the
 * result fails validation, so the caller falls back to the probe parse.
 */
function inflateEntryExact(buf: Buffer, pos: number, size: number): { data: Buffer; end: number } | null {
  let result: unknown;
  try {
    const inflate = inflateSync as unknown as (b: Buffer, o: Record<string, unknown>) => unknown;
    result = inflate(buf.subarray(pos), { info: true });
  } catch {
    return null;
  }
  if (result === null || typeof result !== 'object') return null;
  const r = result as { buffer?: unknown; engine?: { bytesWritten?: unknown } };
  if (!Buffer.isBuffer(r.buffer) || typeof r.engine?.bytesWritten !== 'number') return null;
  const end = pos + r.engine.bytesWritten;
  if (end > buf.length - 20 || r.buffer.length !== size) return null;
  return { data: r.buffer, end };
}

/** One entry's header plus its OFS/REF delta base, and the position after it. */
function readPackEntryHead(
  buf: Buffer,
  pos: number,
): { typeCode: number; size: number; next: number; baseOffset: number; baseOid: string } {
  const start = pos;
  const { typeCode, size, next } = readEntryHeader(buf, pos);
  pos = next;
  let baseOffset = -1;
  let baseOid = '';
  if (typeCode === 6) {
    // OFS_DELTA: offset varint.
    let b = buf[pos++];
    let off = b & 0x7f;
    while (b & 0x80) {
      b = buf[pos++];
      off = ((off + 1) << 7) | (b & 0x7f);
    }
    baseOffset = start - off;
  } else if (typeCode === 7) {
    baseOid = buf.subarray(pos, pos + 20).toString('hex');
    pos += 20;
  }
  return { typeCode, size, next: pos, baseOffset, baseOid };
}

/** The first pass's output: every entry's inflated bytes, indexed by offset. */
interface ParsedEntries {
  raws: RawEntry[];
  byOffset: Map<number, RawEntry>;
}

/** First pass via the exact-inflate fast path; null when anything fails validation. */
function parseEntriesFast(buf: Buffer, count: number): ParsedEntries | null {
  const raws: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  try {
    for (let i = 0; i < count; i++) {
      const start = pos;
      const head = readPackEntryHead(buf, pos);
      pos = head.next;
      const fast = inflateEntryExact(buf, pos, head.size);
      if (fast === null) return null;
      const raw: RawEntry = {
        offset: start,
        typeCode: head.typeCode,
        size: head.size,
        baseOffset: head.baseOffset,
        baseOid: head.baseOid,
        data: fast.data,
      };
      raws.push(raw);
      byOffset.set(start, raw);
      pos = fast.end;
    }
  } catch {
    return null;
  }
  if (pos !== buf.length - 20) return null;
  return { raws, byOffset };
}

/** First pass via exponential probe + binary search (the original method). */
function parseEntriesWithProbe(buf: Buffer, count: number): ParsedEntries {
  const raws: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    const head = readPackEntryHead(buf, pos);
    pos = head.next;
    // Inflate: find the deflate stream's end with exponential probe + binary
    // search (a linear scan would re-inflate O(n) times per entry and sink the
    // push workload). inflateSync throws on a truncated slice and succeeds on
    // the exact end.
    let data: Buffer;
    let streamEnd: number;
    {
      const tryEnd = (end: number): Buffer | null => {
        try {
          return inflateSync(buf.subarray(pos, end));
        } catch {
          return null;
        }
      };
      let lo = pos + 1;
      let step = 1;
      let hi = -1;
      let first: Buffer | null = null;
      for (;;) {
        const end = Math.min(pos + step, buf.length - 20);
        const got = tryEnd(end);
        if (got !== null) {
          hi = end;
          first = got;
          break;
        }
        if (end >= buf.length - 20) throw new Error('truncated deflate stream');
        lo = end + 1;
        step *= 2;
      }
      // Binary search the smallest succeeding end in [lo, hi].
      let low = lo;
      let high = hi;
      let best: Buffer = first!;
      let bestEnd = hi;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const got = tryEnd(mid);
        if (got !== null) {
          best = got;
          bestEnd = mid;
          high = mid;
        } else {
          low = mid + 1;
        }
      }
      data = best;
      streamEnd = bestEnd;
    }
    const raw: RawEntry = {
      offset: start,
      typeCode: head.typeCode,
      size: head.size,
      baseOffset: head.baseOffset,
      baseOid: head.baseOid,
      data: data!,
    };
    raws.push(raw);
    byOffset.set(start, raw);
    pos = streamEnd;
  }
  return { raws, byOffset };
}

/**
 * Decode a packfile. Resolves OFS_DELTA / REF_DELTA (recursively, cycle-safe),
 * verifies the trailer SHA-1 and recomputes every object id. `external` supplies
 * base objects for thin packs (objects the receiver already holds).
 */
export function decodePack(
  buf: Buffer,
  external?: Map<string, GitObject>,
): Array<{ oid: string; type: ObjType; data: Buffer }> {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expectTrailer = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expectTrailer)) throw new Error('pack trailer checksum mismatch');

  // First pass: parse every entry's header + inflated bytes. The fast path
  // inflates each entry exactly once; anything it cannot prove falls back to
  // the probe parse, which is the method this file always used.
  const parsed = parseEntriesFast(buf, count) ?? parseEntriesWithProbe(buf, count);
  const { raws, byOffset } = parsed;

  // Second pass: resolve deltas recursively.
  const resolved = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  const plainByOid = new Map<string, RawEntry>();
  let plainByOidBuilt = false;
  const buildPlainByOid = (): void => {
    // Only REF_DELTA resolution needs the oid -> entry map; packs without
    // ref-deltas (every push the suite sends) skip these hashes entirely.
    if (plainByOidBuilt) return;
    plainByOidBuilt = true;
    for (const r of raws) {
      if (r.typeCode !== 6 && r.typeCode !== 7) {
        plainByOid.set(objectId(CODE_TYPES[r.typeCode], r.data), r);
      }
    }
  };
  const resolving = new Set<number>();
  const resolve = (raw: RawEntry): { oid: string; type: ObjType; data: Buffer } => {
    const cached = resolved.get(raw.offset);
    if (cached) return cached;
    if (resolving.has(raw.offset)) throw new Error('pack delta cycle');
    resolving.add(raw.offset);
    try {
      let out: { oid: string; type: ObjType; data: Buffer };
      if (raw.typeCode === 6 || raw.typeCode === 7) {
        let base: { type: ObjType; data: Buffer } | undefined;
        if (raw.typeCode === 6) {
          const baseRaw = byOffset.get(raw.baseOffset);
          if (!baseRaw) throw new Error('pack delta base missing');
          base = resolve(baseRaw);
        } else {
          buildPlainByOid();
          const inPack = plainByOid.get(raw.baseOid);
          if (inPack) {
            base = resolve(inPack);
          } else if (external) {
            base = external.get(raw.baseOid);
          }
          if (!base) {
            // Base may itself be a delta entry in this pack: resolve delta
            // entries until one yields this oid.
            for (const cand of raws) {
              if (cand.typeCode !== 6 && cand.typeCode !== 7) continue;
              if (cand === raw) continue;
              const r = resolve(cand);
              if (r.oid === raw.baseOid) {
                base = r;
                break;
              }
            }
          }
          if (!base) throw new Error('pack delta base missing');
        }
        const data = applyDelta(base.data, raw.data);
        out = { oid: objectId(base.type, data), type: base.type, data };
      } else {
        const type = CODE_TYPES[raw.typeCode];
        if (!type) throw new Error(`unknown pack object type ${raw.typeCode}`);
        if (raw.data.length !== raw.size) throw new Error('pack object size mismatch');
        out = { oid: objectId(type, raw.data), type, data: raw.data };
      }
      resolved.set(raw.offset, out);
      return out;
    } finally {
      resolving.delete(raw.offset);
    }
  };
  return raws.map((r) => resolve(r));
}

// ---------------------------------------------------------------- graph ops

/** All objects reachable from `tips` (commits, trees, tags, blobs). */
export function closure(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return seen;
}

/** True when `ancestor` equals `descendant` or is reachable from it via parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  return false;
}

/** Resolve `path` (e.g. `docs/readme.md`) in the tree `rootTreeOid`. */
export function treeGet(
  repo: Repo,
  rootTreeOid: string,
  path: string,
): { oid: string; type: ObjType } | undefined {
  const parts = path.split('/').filter((s) => s !== '');
  let treeOid = rootTreeOid;
  for (let i = 0; i < parts.length; i++) {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return undefined;
    const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      const obj = repo.objects.get(entry.oid);
      if (!obj) return undefined;
      return { oid: entry.oid, type: obj.type };
    }
    if (entry.mode !== '40000') return undefined;
    treeOid = entry.oid;
  }
  return undefined;
}

const EMPTY_TREE_OID = objectId('tree', Buffer.alloc(0));

/**
 * Return a new root tree oid with `path` set to `blobOid` (or deleted when null).
 * Intermediate trees are created as needed; new tree objects are stored in the repo.
 * `rootTreeOid` may be null (empty tree).
 */
export function treePut(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((s) => s !== '');
  if (parts.length === 0) return rootTreeOid ?? EMPTY_TREE_OID;
  const put = (treeOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid) {
      const obj = repo.objects.get(treeOid);
      if (obj?.type === 'tree') {
        for (const e of parseTree(obj.data)) entries.set(e.name, e);
      }
    }
    const name = parts[depth];
    if (depth === parts.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const sub = entries.get(name);
      const next = put(sub && sub.mode === '40000' ? sub.oid : null, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    const data = buildTree([...entries.values()]);
    const oid = objectId('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return put(rootTreeOid, 0) ?? EMPTY_TREE_OID;
}

/** Every blob under a tree, with full paths. */
export function listTreePaths(repo: Repo, rootTreeOid: string): Array<{ path: string; oid: string; mode: string }> {
  const out: Array<{ path: string; oid: string; mode: string }> = [];
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, p);
      else out.push({ path: p, oid: e.oid, mode: e.mode });
    }
  };
  walk(rootTreeOid, '');
  return out;
}
