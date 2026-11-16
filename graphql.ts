// GraphQL v4 executor for the forge: POST /api/graphql.
//
// A small, dependency-free GraphQL engine covering exactly the surface the
// conformance suite speaks (see DESIGN.md and analysis/graphql-mcp-checks.md):
// viewer/repository/node/__type reads, issue + pull-request connections with
// states/orderBy/cursor pagination, and the createIssue / closeIssue /
// createPullRequest / mergePullRequest (SQUASH) / addComment mutations — all
// against the same Store the REST surface uses, so ids and numbers agree.
//
// No wall clock, no randomness: every timestamp comes from store.nowIso /
// store.nowEpoch. TypeScript type-stripping only (no enums, no parameter
// properties, explicit `.ts` imports), stdlib only.

import type { ServerResponse } from 'node:http';
import type { Issue, Pull, PullFile, Repo, Store } from './store.ts';
import type { Req } from './httputil.ts';
import { errJson, sendJson } from './httputil.ts';
import { buildCommit, listTreePaths, parseCommit } from './gitobj.ts';

export async function handleGraphql(req: Req, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!req.authOk) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  if (req.jsonError) {
    errJson(res, 400, 'Invalid JSON');
    return true;
  }
  const body = req.json;
  if (Array.isArray(body)) {
    const results = body.map((op) => executeOperation(op, store));
    sendJson(res, 200, results);
    return true;
  }
  if (isRecord(body)) {
    sendJson(res, 200, executeOperation(body, store));
    return true;
  }
  errJson(res, 400, 'Invalid request body');
  return true;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.owner}/${repo.name}/${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64url(`PullRequest:${repo.owner}/${repo.name}/${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64url(`IssueComment:${repo.owner}/${repo.name}/${issue.number}/${commentId}`);
}

function viewerGlobalId(store: Store): string {
  return b64url(`User:${store.viewer.login}`);
}

function cursorOf(seq: number): string {
  return b64url(`cursor:${seq}`);
}

function seqOfCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) return null;
  if (!text.startsWith('cursor:')) return null;
  const n = Number(text.slice('cursor:'.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface DecodedId {
  kind: string;
  owner: string;
  name: string;
  number: number;
  extra: number;
}

function decodeGlobalId(id: string): DecodedId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const parts = text.slice(colon + 1).split('/');
  if (parts.length < 2 || parts[0] === '' || parts[1] === '') return null;
  const number = parts.length > 2 ? Number(parts[2]) : 0;
  const extra = parts.length > 3 ? Number(parts[3]) : 0;
  return { kind, owner: parts[0] as string, name: parts[1] as string, number, extra };
}

function resolveRepoByGlobalId(store: Store, id: unknown): Repo | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  const dec = decodeGlobalId(id);
  if (dec !== null && dec.kind === 'Repository') return store.getRepo(dec.owner, dec.name);
  if (/^\d+$/.test(id)) {
    const numeric = Number(id);
    for (const repo of store.repos.values()) {
      if (repo.id === numeric) return repo;
    }
  }
  if (id.includes('/')) {
    const slash = id.indexOf('/');
    return store.getRepo(id.slice(0, slash), id.slice(slash + 1));
  }
  return undefined;
}

function resolveIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'Issue') return undefined;
  const repo = store.getRepo(dec.owner, dec.name);
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((entry) => entry.number === dec.number);
  if (issue === undefined) return undefined;
  return { repo, issue };
}

function resolvePullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'PullRequest') return undefined;
  const repo = store.getRepo(dec.owner, dec.name);
  if (repo === undefined) return undefined;
  const pull = repo.pulls.find((entry) => entry.number === dec.number);
  if (pull === undefined) return undefined;
  return { repo, pull };
}

// ---------------------------------------------------------------------------
// Git-backed pull-request helpers (same rules as REST: DESIGN.md rest.ts)
// ---------------------------------------------------------------------------

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function blobLines(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return 0;
  return countLines(obj.data.toString('utf8'));
}

/** Diff base-tip tree vs head-tip tree, the way REST GET /pulls/{n}/files does. */
function computePullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  const basePaths = new Map(listTreePaths(repo, parseCommit(baseObj.data).tree).map((p) => [p.path, p.oid]));
  const headPaths = new Map(listTreePaths(repo, parseCommit(headObj.data).tree).map((p) => [p.path, p.oid]));
  const names = new Set([...basePaths.keys(), ...headPaths.keys()]);
  const files: PullFile[] = [];
  for (const path of [...names].sort()) {
    const inBase = basePaths.get(path);
    const inHead = headPaths.get(path);
    if (inHead !== undefined && inBase === undefined) {
      const additions = blobLines(repo, inHead);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (inHead === undefined && inBase !== undefined) {
      const deletions = blobLines(repo, inBase);
      files.push({ filename: path, status: 'changed', additions: 0, deletions, changes: deletions });
    } else if (inHead !== undefined && inBase !== undefined && inHead !== inBase) {
      const additions = blobLines(repo, inHead);
      const deletions = blobLines(repo, inBase);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

function treeBlobs(repo: Repo, treeOid: string | null): Map<string, string> {
  if (treeOid === null) return new Map();
  return new Map(listTreePaths(repo, treeOid).map((p) => [p.path, p.oid]));
}

/** Nearest common ancestor of two commits (first head ancestor also reachable from base). */
function mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const baseAncestors = new Set<string>();
  const stack: string[] = [baseSha];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (baseAncestors.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    baseAncestors.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  const queue: string[] = [headSha];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (baseAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

function mergeConflict(repo: Repo, headSha: string, baseSha: string): boolean {
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (baseObj === undefined || headObj === undefined) return false;
  const mb = mergeBase(repo, headSha, baseSha);
  const mbTree = mb === null ? null : parseCommit((repo.objects.get(mb) as { data: Buffer }).data).tree;
  const mbBlobs = treeBlobs(repo, mbTree);
  const headBlobs = treeBlobs(repo, parseCommit(headObj.data).tree);
  const baseBlobs = treeBlobs(repo, parseCommit(baseObj.data).tree);
  const paths = new Set([...mbBlobs.keys(), ...headBlobs.keys(), ...baseBlobs.keys()]);
  for (const path of paths) {
    const mbOid = mbBlobs.get(path);
    const headOid = headBlobs.get(path);
    const baseOid = baseBlobs.get(path);
    if (headOid !== mbOid && baseOid !== mbOid && headOid !== baseOid) return true;
  }
  return false;
}

function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.headSha === '' || pull.baseSha === '') return 'UNKNOWN';
  return mergeConflict(repo, pull.headSha, pull.baseSha) ? 'CONFLICTING' : 'MERGEABLE';
}

/** One squash commit on the base branch; returns 'ok' | 'conflict' | 'missing'. */
function squashMerge(store: Store, repo: Repo, pull: Pull): 'ok' | 'conflict' | 'missing' {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return 'missing';
  if (mergeConflict(repo, headSha, baseSha)) return 'conflict';
  const headObj = repo.objects.get(headSha);
  if (headObj === undefined) return 'missing';
  const tree = parseCommit(headObj.data).tree;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commit = buildCommit(tree, [baseSha], store.gitAuthor(), store.gitAuthor(), message);
  const sha = store.putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso;
  pull.mergeCommitSha = sha;
  pull.headSha = headSha;
  pull.baseSha = baseSha;
  return 'ok';
}

function createPullInStore(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    files: computePullFiles(repo, baseSha, headSha),
    seq: repo.nextSeq++,
  };
  repo.pulls.push(pull);
  return pull;
}

function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.nextSeq++,
  };
  repo.issues.push(issue);
  return issue;
}

// ---------------------------------------------------------------------------
// GraphQL document parsing (tokenizer + recursive descent)
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class VarRef {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

interface Selection {
  kind: 'field' | 'inline' | 'spread';
  alias?: string;
  name?: string;
  args?: Record<string, unknown>;
  selections?: Selection[];
  typeCondition?: string;
  fragmentName?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  tokens: Token[];
  pos: number;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${tok.value}`);
    }
  }

  expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected a name in GraphQL document, got ${tok.value}`);
    if (value !== undefined && tok.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${tok.value}`);
    }
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const tok = this.peek() as Token;
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.next();
        const kind = tok.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${tok.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): void {
    if (this.peek()?.kind !== 'punct' || this.peek()?.value !== '(') return;
    this.next();
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  parseType(): void {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.parseArguments();
      }
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): Selection {
    const tok = this.peek() as Token;
    if (tok.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const fragmentName = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', fragmentName };
      }
      throw new Error('Invalid fragment spread in GraphQL document');
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, unknown> | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): unknown {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return new VarRef(this.expectName());
    if (tok.kind === 'punct' && tok.value === '[') {
      const list: unknown[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        list.push(this.parseValue());
      }
      this.expectPunct(']');
      return list;
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'int') return Number.parseInt(tok.value, 10);
    if (tok.kind === 'float') return Number.parseFloat(tok.value);
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return tok.value;
    }
    throw new Error(`Unexpected value ${tok.value} in GraphQL document`);
  }
}

function resolveVars(value: unknown, vars: Record<string, unknown>): unknown {
  if (value instanceof VarRef) return vars[value.name];
  if (Array.isArray(value)) return value.map((entry) => resolveVars(entry, vars));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveVars(entry, vars);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown> | undefined, vars: Record<string, unknown>): Record<string, unknown> {
  if (args === undefined) return {};
  return resolveVars(args, vars) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema surface (drives both introspection and unknown-field errors)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName',
    'baseRefName', 'mergeable', 'files', 'mergedAt',
  ],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  Ref: ['name'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  Node: ['id'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeKind(typeName: string): string {
  if (typeName in TYPE_ENUM_VALUES) return 'ENUM';
  if (typeName === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

type NodeObj = Record<string, unknown> & { __typename: string };

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  doc: Document;
}

function repoNode(repo: Repo): NodeObj {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): NodeObj {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeObj {
  return { __typename: 'PullRequest', repo, pull };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): NodeObj {
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = isRecord(args['orderBy']) ? args['orderBy'] : undefined;
  const dir = orderBy?.['direction'] === 'DESC' ? -1 : 1;
  // No orderBy at all means CREATED_AT ASC (REST default).
  list.sort((a, b) => {
    const bySeq = (a.seq - b.seq) * dir;
    return bySeq !== 0 ? bySeq : (a.number - b.number) * dir;
  });
  let start = 0;
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const seq = seqOfCursor(after);
    if (seq !== null) {
      const idx = list.findIndex((issue) => issue.seq === seq);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args['first'] === 'number' ? args['first'] : list.length - start;
  const nodes = list.slice(start, start + Math.max(0, first));
  const hasNextPage = start + nodes.length < list.length;
  const endCursor = nodes.length > 0 ? cursorOf((nodes[nodes.length - 1] as Issue).seq) : null;
  const startCursor = nodes.length > 0 ? cursorOf((nodes[0] as Issue).seq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: nodes.map((issue) => issueNode(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor,
      hasPreviousPage: start > 0,
      startCursor,
    },
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): NodeObj {
  const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
  const first = typeof args['first'] === 'number' ? args['first'] : list.length;
  const nodes = list.slice(0, Math.max(0, first));
  return { __typename: 'PullRequestConnection', nodes: nodes.map((pull) => pullNode(repo, pull)) };
}

function resolveField(node: NodeObj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const typeName = node.__typename;
  const known = TYPE_FIELDS[typeName];
  if (known !== undefined && !known.includes(field)) {
    throw new FieldError(`Cannot query field "${field}" on type "${typeName}".`);
  }
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') {
        return {
          __typename: 'User',
          login: store.viewer.login,
          id: viewerGlobalId(store),
          name: store.viewer.name,
          email: store.viewer.email,
        };
      }
      if (field === 'repository') {
        const owner = args['owner'];
        const name = args['name'];
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repoNode(repo);
      }
      if (field === 'node') {
        const id = args['id'];
        if (typeof id !== 'string') return null;
        const dec = decodeGlobalId(id);
        if (dec === null) return null;
        if (dec.kind === 'Repository') {
          const repo = store.getRepo(dec.owner, dec.name);
          return repo === undefined ? null : repoNode(repo);
        }
        if (dec.kind === 'Issue') {
          const found = resolveIssueByGlobalId(store, id);
          return found === undefined ? null : issueNode(found.repo, found.issue);
        }
        if (dec.kind === 'PullRequest') {
          const found = resolvePullByGlobalId(store, id);
          return found === undefined ? null : pullNode(found.repo, found.pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = args['name'];
        if (typeof name !== 'string') return null;
        if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
        return { __typename: '__Type', typeName: name };
      }
      break;
    }
    case 'User': {
      return node[field] ?? null;
    }
    case 'Repository': {
      const repo = node['repo'] as Repo;
      if (field === 'id') return repoGlobalId(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'description') return repo.description;
      if (field === 'owner') {
        return { __typename: 'User', login: repo.owner, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email };
      }
      if (field === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const number = args['number'];
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequests') return pullRequestsConnection(repo, args);
      if (field === 'pullRequest') {
        const number = args['number'];
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const issue = node['issue'] as Issue;
      const repo = node['repo'] as Repo;
      if (field === 'id') return issueGlobalId(repo, issue);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issueState(issue);
      if (field === 'body') return issue.body;
      break;
    }
    case 'IssueConnection': {
      if (field === 'nodes') return node['nodes'] as unknown;
      if (field === 'pageInfo') return node['pageInfo'] as NodeObj;
      break;
    }
    case 'PageInfo': {
      return node[field] ?? null;
    }
    case 'PullRequest': {
      const pull = node['pull'] as Pull;
      const repo = node['repo'] as Repo;
      if (field === 'id') return pullGlobalId(repo, pull);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'mergeable') return mergeableOf(repo, pull);
      if (field === 'files') {
        const first = typeof args['first'] === 'number' ? args['first'] : pull.files.length;
        const files = pull.files.slice(0, Math.max(0, first));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        };
      }
      break;
    }
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return node['nodes'] as unknown;
      break;
    }
    case 'PullRequestChangedFile':
    case 'Ref':
    case 'IssueComment':
    case '__Field':
    case '__EnumValue': {
      return node[field] ?? null;
    }
    case 'CommentEdge': {
      if (field === 'node') return node['node'] as NodeObj;
      if (field === 'cursor') return node['cursor'] ?? null;
      break;
    }
    case '__Type': {
      const typeNameValue = node['typeName'] as string;
      if (field === 'name') return typeNameValue;
      if (field === 'kind') return typeKind(typeNameValue);
      if (field === 'fields') {
        if (typeNameValue in TYPE_ENUM_VALUES && !(typeNameValue in TYPE_FIELDS)) return null;
        const fields = TYPE_FIELDS[typeNameValue] ?? [];
        return fields.map((name) => ({ __typename: '__Field', name }));
      }
      if (field === 'enumValues') {
        const values = TYPE_ENUM_VALUES[typeNameValue];
        if (values === undefined) return null;
        return values.map((name) => ({ __typename: '__EnumValue', name }));
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      return node[field] ?? null;
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    default: {
      break;
    }
  }
  throw new FieldError(`Cannot query field "${field}" on type "${typeName}".`);
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const input = isRecord(args['input']) ? args['input'] : {};
  if (field === 'createIssue') {
    const repo = resolveRepoByGlobalId(store, input['repositoryId']);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const issue = createIssueInStore(store, repo, title, body);
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
  }
  if (field === 'closeIssue') {
    const found = resolveIssueByGlobalId(store, input['issueId']);
    if (found === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
  }
  if (field === 'createPullRequest') {
    const repo = resolveRepoByGlobalId(store, input['repositoryId']);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const baseRef = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
    const headRef = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
    const pull = createPullInStore(repo, title, body, headRef, baseRef);
    if (pull === null) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch not found' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  if (field === 'mergePullRequest') {
    const found = resolvePullByGlobalId(store, input['pullRequestId']);
    if (found === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    const result = squashMerge(store, found.repo, found.pull);
    if (result === 'conflict') {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    if (result === 'missing') {
      ctx.errors.push({ message: 'mergePullRequest: head or base branch not found' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
  }
  if (field === 'addComment') {
    const found = resolveIssueByGlobalId(store, input['subjectId']);
    if (found === undefined) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const commentId = found.repo.nextCommentId++;
    found.issue.comments.push({ id: commentId, body });
    const commentNode: NodeObj = {
      __typename: 'IssueComment',
      id: commentGlobalId(found.repo, found.issue, commentId),
      body,
    };
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: commentNode, cursor: cursorOf(commentId) },
    };
  }
  throw new FieldError(`Cannot query field "${field}" on type "Mutation".`);
}

function isNodeObj(value: unknown): value is NodeObj {
  return isRecord(value) && typeof value['__typename'] === 'string';
}

function materialize(value: unknown, selections: Selection[] | undefined, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (selections === undefined || selections.length === 0) return value;
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, selections, ctx));
  if (isNodeObj(value)) return executeSelections(value, selections, ctx);
  return value;
}

function executeSelections(node: NodeObj, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? (sel.name as string);
      if (sel.name === '__typename') {
        out[key] = node.__typename;
        continue;
      }
      let value: unknown;
      try {
        value = resolveField(node, sel.name as string, resolveArgs(sel.args, ctx.vars), ctx);
      } catch (err) {
        if (err instanceof FieldError) {
          ctx.errors.push({ message: err.message });
          continue;
        }
        throw err;
      }
      out[key] = materialize(value, sel.selections, ctx);
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition === undefined || sel.typeCondition === node.__typename) {
        Object.assign(out, executeSelections(node, sel.selections ?? [], ctx));
      }
    } else {
      const frag = ctx.doc.fragments.get(sel.fragmentName as string);
      if (frag !== undefined && frag.typeCondition === node.__typename) {
        Object.assign(out, executeSelections(node, frag.selections, ctx));
      }
    }
  }
  return out;
}

function executeOperation(body: unknown, store: Store): Record<string, unknown> {
  if (!isRecord(body) || typeof body['query'] !== 'string') {
    return { data: null, errors: [{ message: 'Invalid GraphQL operation: expected {query, variables}' }] };
  }
  const query = body['query'] as string;
  const variables = isRecord(body['variables']) ? (body['variables'] as Record<string, unknown>) : {};
  const operationName = typeof body['operationName'] === 'string' ? body['operationName'] : undefined;
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: {}, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: {}, errors: [{ message: 'No operation in GraphQL document.' }] };
  } else {
    operation = doc.operations[0];
  }
  const ctx: ExecCtx = { store, vars: variables, errors: [], doc };
  const root: NodeObj = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  let data: Record<string, unknown>;
  try {
    data = executeSelections(root, operation.selections, ctx);
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
