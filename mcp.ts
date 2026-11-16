// MCP Streamable HTTP endpoint for the forge: POST /mcp.
//
// JSON-RPC 2.0 over plain POST/JSON (the suite's client also accepts an SSE
// answer, but a single JSON body is the transport's other legal form and is
// what this handler always sends). Both protocol eras are served:
//
//   modern 2026-07-28: server/discover -> {supportedVersions, capabilities,
//           serverInfo}; no handshake, no session.
//   legacy 2025-11-25 and earlier: initialize (echoes the offered revision)
//           + notifications/initialized; no session id is issued.
//
// tools/list offers the six github-mcp-server tools; tools/call executes
// them against the same Store the REST and GraphQL surfaces use, so ids and
// numbers agree across surfaces. Results travel as content[0].text (a JSON
// string) plus structuredContent.
//
// No wall clock, no randomness: every timestamp comes from store.nowIso /
// store.nowEpoch. TypeScript type-stripping only (no enums, no parameter
// properties, explicit `.ts` imports), stdlib only.

import type { ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import type { Req } from './httputil.ts';
import { errJson, nextRequestId, sendJson } from './httputil.ts';
import { buildCommit, listTreePaths, parseCommit } from './gitobj.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

/** One constant table: two tools/list calls serialize byte-identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const CANONICAL: Record<string, string> = {
  createrepo: 'create_repo',
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepo: 'get_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  createissue: 'create_issue',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  listissues: 'list_issues',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  createpullrequest: 'create_pull_request',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  mergepullrequest: 'merge_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Canonical tool for a name the client sent (prefixes such as github__ allowed). */
function canonicalTool(name: string): string | null {
  const normalized = normalizeName(name);
  if (normalized in CANONICAL) return CANONICAL[normalized] as string;
  for (const [suffix, canonical] of Object.entries(CANONICAL)) {
    if (normalized.length > suffix.length && normalized.endsWith(suffix)) return canonical;
  }
  return null;
}

function toolDef(canonical: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === canonical);
}

export async function handleMcp(req: Req, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    // Best-effort legacy session close; nothing is held server-side.
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!req.authOk) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  if (req.jsonError) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  const body = req.json;
  if (!isRecord(body) || typeof body['method'] !== 'string') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: isRecord(body) && 'id' in body ? (body['id'] as unknown) : null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return true;
  }
  const id = 'id' in body ? (body['id'] as unknown) : null;
  const method = body['method'] as string;
  const params = isRecord(body['params']) ? (body['params'] as Record<string, unknown>) : {};

  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    result({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'notifications/initialized') {
    sendJson(res, 202, {});
    return true;
  }
  if (method === 'ping') {
    result({});
    return true;
  }
  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    handleToolsCall(params, store, result, rpcError);
    return true;
  }
  rpcError(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(payload: Record<string, unknown>, isError: boolean): Record<string, unknown> {
  const text = JSON.stringify(payload);
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
  if (isError) out['isError'] = true;
  return out;
}

function handleToolsCall(
  params: Record<string, unknown>,
  store: Store,
  result: (value: unknown) => void,
  rpcError: (code: number, message: string) => void,
): void {
  const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
  const canonical = canonicalTool(name);
  if (canonical === null) {
    rpcError(-32602, `Unknown tool: ${name}`);
    return;
  }
  const def = toolDef(canonical) as ToolDef;
  const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
  for (const required of def.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      rpcError(-32602, `Missing required argument: ${required}`);
      return;
    }
  }
  try {
    const payload = executeTool(canonical, args, store);
    if (payload === null) {
      result(toolResult({ error: 'tool execution failed' }, true));
      return;
    }
    if ('error' in payload && typeof payload['error'] === 'string') {
      result(toolResult(payload, true));
      return;
    }
    result(toolResult(payload, false));
  } catch (err) {
    result(toolResult({ error: err instanceof Error ? err.message : String(err) }, true));
  }
}

function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function lookupRepo(args: Record<string, unknown>, store: Store): Repo | undefined {
  const owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : '';
  const repo = typeof args['repo'] === 'string' ? (args['repo'] as string) : '';
  if (owner === '' || repo === '') return undefined;
  return store.getRepo(owner, repo);
}

function executeTool(canonical: string, args: Record<string, unknown>, store: Store): Record<string, unknown> | null {
  if (canonical === 'create_repo') {
    const name = args['name'] as string;
    if (store.getRepo(store.viewer.login, name) !== undefined) {
      return { error: `Repository already exists: ${store.viewer.login}/${name}` };
    }
    const description = typeof args['description'] === 'string' ? (args['description'] as string) : '';
    const isPrivate = args['private'] === true;
    const repo = store.createRepo(name, isPrivate, description);
    return repoJson(repo, store);
  }
  if (canonical === 'get_repo') {
    const repo = lookupRepo(args, store);
    if (repo === undefined) return { error: 'Repository not found' };
    return repoJson(repo, store);
  }
  if (canonical === 'create_issue') {
    const repo = lookupRepo(args, store);
    if (repo === undefined) return { error: 'Repository not found' };
    const title = args['title'] as string;
    const body = typeof args['body'] === 'string' ? (args['body'] as string) : '';
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
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
      full_name: `${repo.owner}/${repo.name}`,
      repository: `${repo.owner}/${repo.name}`,
    };
  }
  if (canonical === 'list_issues') {
    const repo = lookupRepo(args, store);
    if (repo === undefined) return { error: 'Repository not found' };
    const state = typeof args['state'] === 'string' ? (args['state'] as string).toLowerCase() : 'all';
    const issues = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
    return { issues, total: issues.length };
  }
  if (canonical === 'create_pull_request') {
    const repo = lookupRepo(args, store);
    if (repo === undefined) return { error: 'Repository not found' };
    const title = args['title'] as string;
    const body = typeof args['body'] === 'string' ? (args['body'] as string) : '';
    const head = args['head'] as string;
    const base = args['base'] as string;
    const pull = createPullInStore(repo, title, body, head, base);
    if (pull === null) return { error: 'Head or base branch not found' };
    return {
      id: pull.number,
      number: pull.number,
      pull_number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      full_name: `${repo.owner}/${repo.name}`,
    };
  }
  if (canonical === 'merge_pull_request') {
    const repo = lookupRepo(args, store);
    if (repo === undefined) return { error: 'Repository not found' };
    const raw = args['pull_number'];
    const number = typeof raw === 'number' ? raw : Number(raw);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return { error: 'Pull request not found' };
    const outcome = squashMerge(store, repo, pull);
    if (outcome === 'conflict') return { error: 'Merge conflict' };
    if (outcome === 'missing') return { error: 'Head or base branch not found' };
    return {
      id: pull.number,
      number: pull.number,
      pull_number: pull.number,
      merged: true,
      state: 'closed',
      sha: pull.mergeCommitSha,
      merge_commit_sha: pull.mergeCommitSha,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git-backed pull-request helpers (same rules as REST and graphql.ts)
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

function computePullFiles(repo: Repo, baseSha: string, headSha: string): Array<{ filename: string; status: 'added' | 'modified' | 'changed'; additions: number; deletions: number; changes: number }> {
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  const basePaths = new Map(listTreePaths(repo, parseCommit(baseObj.data).tree).map((p) => [p.path, p.oid]));
  const headPaths = new Map(listTreePaths(repo, parseCommit(headObj.data).tree).map((p) => [p.path, p.oid]));
  const names = new Set([...basePaths.keys(), ...headPaths.keys()]);
  const files: Array<{ filename: string; status: 'added' | 'modified' | 'changed'; additions: number; deletions: number; changes: number }> = [];
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

function createPullInStore(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
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
