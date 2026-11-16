// REST v3 handler for the forge (Builder B).
// All routes under /api/v3. Returns false when the path is not under /api/v3
// (app.ts falls through to its 404). Every reply goes through sendJson /
// errJson, so it carries X-GitHub-Request-Id and application/json.
// Auth is enforced here as well as in app.ts: without a valid Bearer token
// every /api/v3 route answers 401 {"message": "Requires authentication"}.

import type { ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull, PullFile } from './store.ts';
import type { Req } from './httputil.ts';
import { sendJson, errJson, nextRequestId } from './httputil.ts';
import {
  buildCommit,
  parseCommit,
  treeGet,
  treePut,
  listTreePaths,
} from './gitobj.ts';

type Body = Record<string, unknown>;

function bodyOf(req: Req): Body {
  if (req.json !== null && typeof req.json === 'object' && !Array.isArray(req.json)) {
    return req.json as Body;
  }
  return {};
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parsePageParams(req: Req): { perPage: number; page: number } {
  const perRaw = req.query.get('per_page');
  const pageRaw = req.query.get('page');
  let perPage = perRaw === null ? 30 : parseInt(perRaw, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = pageRaw === null ? 1 : parseInt(pageRaw, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage, page };
}

/** Slice `items` for the requested page; returns the page plus a next Link or null. */
function paginate<T>(
  req: Req,
  items: T[],
): { page: T[]; nextLink: string | null } {
  const { perPage, page } = parsePageParams(req);
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  let nextLink: string | null = null;
  if (start + perPage < items.length) {
    const url = `http://${req.host}${req.pathname}?per_page=${perPage}&page=${page + 1}`;
    nextLink = `<${url}>; rel="next"`;
  }
  return { page: sliced, nextLink };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
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

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

/** Resolve a ref-ish string (branch name, full ref, or commit oid) to a commit oid. */
function resolveCommit(repo: Repo, ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) {
    return repo.refs.get(ref);
  }
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return undefined;
}

function commitTree(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  // A trailing newline terminates the last line; it is not an extra line.
  if (text.endsWith('\n')) parts.pop();
  return parts.length;
}

/** Diff base-tip tree vs head-tip tree, as stored on the Pull. */
function computePullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const baseTree = commitTree(repo, baseSha);
  const headTree = commitTree(repo, headSha);
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  if (baseTree !== undefined) {
    for (const e of listTreePaths(repo, baseTree)) baseMap.set(e.path, e.oid);
  }
  if (headTree !== undefined) {
    for (const e of listTreePaths(repo, headTree)) headMap.set(e.path, e.oid);
  }
  const files: PullFile[] = [];
  const names = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const name of [...names].sort()) {
    const b = baseMap.get(name);
    const h = headMap.get(name);
    if (b === h) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h);
      const additions = blob !== undefined ? countLines(blob.data) : 0;
      files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined && b !== undefined) {
      const blob = repo.objects.get(b);
      const deletions = blob !== undefined ? countLines(blob.data) : 0;
      files.push({ filename: name, status: 'changed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b);
      const newBlob = repo.objects.get(h);
      const additions = newBlob !== undefined ? countLines(newBlob.data) : 0;
      const deletions = oldBlob !== undefined ? countLines(oldBlob.data) : 0;
      files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Find a merge-base: the ancestor of `headSha` (closest to it) that is also an ancestor of `baseSha`. */
function findMergeBase(repo: Repo, headSha: string, baseSha: string): string | undefined {
  // Collect every ancestor of baseSha (including itself).
  const baseAncestors = new Set<string>();
  const stack: string[] = [baseSha];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  // Walk head ancestors tip-first; the first one also in baseAncestors wins.
  const seen = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (baseAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return undefined;
}

function commitList(repo: Repo, tip: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha: oid, commit: { message: parsed.message, author: parsed.author, committer: parsed.committer } });
    // Push parents in reverse so the first parent is visited next (tip-first order).
    for (let i = parsed.parents.length - 1; i >= 0; i--) stack.push(parsed.parents[i]);
  }
  return out;
}

export async function handleRest(req: Req, res: ServerResponse, store: Store): Promise<boolean> {
  const pathname = req.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;

  // Auth: every /api/v3 route requires a valid Bearer token.
  if (!req.authOk) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  // Malformed JSON body on a JSON endpoint -> 400.
  if (req.jsonError) {
    errJson(res, 400, 'Malformed JSON body');
    return true;
  }

  const segs = pathname.split('/').filter((s) => s.length > 0).map(decodeSeg);
  // segs[0] = 'api', segs[1] = 'v3'
  const method = req.method;

  // ---- GET /api/v3/ (root) ----
  if (segs.length === 2) {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // ---- GET /api/v3/meta ----
  if (segs.length === 3 && segs[2] === 'meta') {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // ---- /api/v3/user/repos ----
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      const body = bodyOf(req);
      const name = str(body.name, '');
      if (name === '') {
        errJson(res, 422, 'name is required');
        return true;
      }
      if (store.getRepo(store.viewer.login, name) !== undefined) {
        errJson(res, 422, 'already exists');
        return true;
      }
      const isPrivate = body.private === true;
      const description = str(body.description, '');
      const repo = store.createRepo(name, isPrivate, description);
      sendJson(res, 201, repoJson(store, repo));
      return true;
    }
    if (method === 'GET') {
      const mine: Repo[] = [];
      for (const repo of store.repos.values()) {
        if (repo.owner === store.viewer.login) mine.push(repo);
      }
      const { page, nextLink } = paginate(req, mine);
      const extra: Record<string, string> = {};
      if (nextLink !== null) extra.link = nextLink;
      sendJson(res, 200, page.map((r) => repoJson(store, r)), extra);
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }

  // ---- /api/v3/repos/{owner}/{repo}[...] ----
  if (segs.length >= 5 && segs[2] === 'repos') {
    const owner = segs[3];
    const repoName = segs[4];
    const repo = store.getRepo(owner, repoName);
    // Missing repo, or owner != viewer.login, is 404 (never 403).
    if (repo === undefined || owner !== store.viewer.login) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const rest = segs.slice(5);

    // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = bodyOf(req);
        if (typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const body = bodyOf(req);
      const ref = str(body.ref, '');
      const sha = str(body.sha, '');
      if (ref === '' || sha === '') {
        errJson(res, 422, 'ref and sha are required');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
        }
      }
      sendJson(res, 200, branches);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>]
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const shaParam = req.query.get('sha');
      const refName = shaParam === null || shaParam === '' ? repo.defaultBranch : shaParam;
      const tip = resolveCommit(repo, refName);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      sendJson(res, 200, commitList(repo, tip));
      return true;
    }

    // PUT / GET / DELETE /api/v3/repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const body = bodyOf(req);
        const message = str(body.message, '');
        const contentB64 = str(body.content, '');
        const contentBytes = contentB64 === '' ? Buffer.alloc(0) : Buffer.from(contentB64, 'base64');
        const branch = str(body.branch, '') === '' ? repo.defaultBranch : str(body.branch, '');
        const refKey = `refs/heads/${branch}`;
        const tip = repo.refs.get(refKey);
        const currentTree = tip !== undefined ? commitTree(repo, tip) : undefined;
        const current =
          currentTree !== undefined ? treeGet(repo, currentTree, contentPath) : undefined;
        const givenSha = typeof body.sha === 'string' ? body.sha : '';
        if (givenSha !== '') {
          if (current === undefined || current.oid.toLowerCase() !== givenSha.toLowerCase()) {
            errJson(res, 409, 'sha does not match the current blob');
            return true;
          }
        }
        const isCreate = current === undefined;
        const blobOid = store.putObject(repo, 'blob', contentBytes);
        const newTree = treePut(repo, currentTree ?? null, contentPath, blobOid);
        const author = store.gitAuthor();
        const parents = tip !== undefined ? [tip] : [];
        const commitData = buildCommit(newTree, parents, author, author, message);
        const commitOid = store.putObject(repo, 'commit', commitData);
        repo.refs.set(refKey, commitOid);
        const baseName = contentPath.split('/').pop() ?? contentPath;
        sendJson(res, isCreate ? 201 : 200, {
          content: {
            name: baseName,
            path: contentPath,
            sha: blobOid,
            size: contentBytes.length,
            type: 'file',
            encoding: 'base64',
            content: contentBytes.toString('base64'),
          },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = req.query.get('ref');
        const refName = refParam === null || refParam === '' ? repo.defaultBranch : refParam;
        const tip = resolveCommit(repo, refName);
        if (tip === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const rootTree = commitTree(repo, tip);
        if (rootTree === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const found = treeGet(repo, rootTree, contentPath);
        if (found !== undefined && found.type === 'blob') {
          const blob = repo.objects.get(found.oid);
          const data = blob !== undefined ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: found.oid,
            size: data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
          });
          return true;
        }
        // Directory: immediate children under contentPath.
        const all = listTreePaths(repo, rootTree);
        const prefix = `${contentPath}/`;
        const children = new Map<string, { type: string; sha: string }>();
        for (const entry of all) {
          if (!entry.path.startsWith(prefix)) continue;
          const restPath = entry.path.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (children.has(first)) continue;
          if (restPath.includes('/')) {
            const sub = treeGet(repo, rootTree, `${contentPath}/${first}`);
            children.set(first, { type: 'dir', sha: sub !== undefined ? sub.oid : '' });
          } else {
            children.set(first, { type: 'file', sha: entry.oid });
          }
        }
        if (children.size === 0) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const listing = [...children.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([name, info]) => ({
            type: info.type,
            name,
            path: `${contentPath}/${name}`,
            sha: info.sha,
          }));
        sendJson(res, 200, listing);
        return true;
      }
      if (method === 'DELETE') {
        const body = bodyOf(req);
        const message = str(body.message, '');
        const branch = str(body.branch, '') === '' ? repo.defaultBranch : str(body.branch, '');
        const refKey = `refs/heads/${branch}`;
        const tip = repo.refs.get(refKey);
        if (tip === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const currentTree = commitTree(repo, tip);
        if (currentTree === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const current = treeGet(repo, currentTree, contentPath);
        if (current === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const givenSha = typeof body.sha === 'string' ? body.sha : '';
        if (givenSha !== '' && current.oid.toLowerCase() !== givenSha.toLowerCase()) {
          errJson(res, 409, 'sha does not match the current blob');
          return true;
        }
        const newTree = treePut(repo, currentTree, contentPath, null);
        const author = store.gitAuthor();
        const commitData = buildCommit(newTree, [tip], author, author, message);
        const commitOid = store.putObject(repo, 'commit', commitData);
        repo.refs.set(refKey, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const body = bodyOf(req);
      const name = str(body.name, '');
      if (name === '') {
        errJson(res, 422, 'name is required');
        return true;
      }
      const color = str(body.color, '');
      const description = str(body.description, '');
      repo.labels.set(name, { name, color, description });
      sendJson(res, 201, { name, color, description });
      return true;
    }

    // Issues: /issues, /issues/{n}, /issues/{n}/comments
    if (rest.length >= 1 && rest[0] === 'issues') {
      // POST / GET /api/v3/repos/{o}/{r}/issues
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyOf(req);
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labelNames: string[] = [];
          for (const l of rawLabels) {
            if (typeof l === 'string') labelNames.push(l);
            else if (l !== null && typeof l === 'object') {
              const n = (l as Body).name;
              if (typeof n === 'string') labelNames.push(n);
            }
          }
          for (const n of labelNames) {
            if (!repo.labels.has(n)) {
              errJson(res, 422, `unknown label: ${n}`);
              return true;
            }
          }
          const issue: Issue = {
            id: store.nextIssueId++,
            number: repo.nextIssue++,
            title: str(body.title, ''),
            body: str(body.body, ''),
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: repo.nextSeq++,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(issue));
          return true;
        }
        if (method === 'GET') {
          const stateParam = req.query.get('state');
          let list = [...repo.issues];
          if (stateParam === null || stateParam === '') {
            list = list.filter((i) => i.state === 'open');
          } else if (stateParam !== 'all') {
            list = list.filter((i) => i.state === stateParam);
          }
          const sort = req.query.get('sort');
          const direction = req.query.get('direction');
          if (sort === null || sort === '' || sort === 'created') {
            list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
          }
          const { page, nextLink } = paginate(req, list);
          const extra: Record<string, string> = {};
          if (nextLink !== null) extra.link = nextLink;
          sendJson(res, 200, page.map((i) => issueJson(i)), extra);
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      // /issues/{n} and /issues/{n}/comments
      const n = parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === n);
      if (issue === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = bodyOf(req);
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          sendJson(res, 200, issueJson(issue));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const body = bodyOf(req);
          const comment = { id: repo.nextCommentId++, body: str(body.body, '') };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // Pulls: /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
    if (rest.length >= 1 && rest[0] === 'pulls') {
      // POST / GET /api/v3/repos/{o}/{r}/pulls
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyOf(req);
          const headRef = str(body.head, '');
          const baseRef = str(body.base, '');
          const headSha = headRef === '' ? undefined : repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = baseRef === '' ? undefined : repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            errJson(res, 404, 'head or base branch not found');
            return true;
          }
          const pull: Pull = {
            number: repo.nextPull++,
            title: str(body.title, ''),
            body: str(body.body, ''),
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
          sendJson(res, 201, pullJson(pull));
          return true;
        }
        if (method === 'GET') {
          const stateParam = req.query.get('state');
          let list = [...repo.pulls];
          if (stateParam === null || stateParam === '') {
            list = list.filter((p) => p.state === 'open');
          } else if (stateParam === 'open') {
            list = list.filter((p) => p.state === 'open');
          } else if (stateParam === 'closed') {
            list = list.filter((p) => p.state === 'closed');
          }
          // state=all (or anything else unrecognised that is not open/closed) keeps all.
          const { page, nextLink } = paginate(req, list);
          const extra: Record<string, string> = {};
          if (nextLink !== null) extra.link = nextLink;
          sendJson(res, 200, page.map((p) => pullJson(p)), extra);
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      const n = parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === n);
      if (pull === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(pull));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pull.files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (pull.merged || pull.state === 'closed') {
          errJson(res, 405, 'pull request is already closed');
          return true;
        }
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headTip === undefined || baseTip === undefined) {
          errJson(res, 404, 'head or base branch not found');
          return true;
        }
        // Conflict: head and base both changed the same file vs the merge-base,
        // to different blobs.
        const mergeBase = findMergeBase(repo, headTip, baseTip);
        let conflict = false;
        if (mergeBase !== undefined) {
          const baseTree = commitTree(repo, mergeBase);
          const headTree = commitTree(repo, headTip);
          const curBaseTree = commitTree(repo, baseTip);
          const mbMap = new Map<string, string>();
          const hMap = new Map<string, string>();
          const bMap = new Map<string, string>();
          if (baseTree !== undefined) {
            for (const e of listTreePaths(repo, baseTree)) mbMap.set(e.path, e.oid);
          }
          if (headTree !== undefined) {
            for (const e of listTreePaths(repo, headTree)) hMap.set(e.path, e.oid);
          }
          if (curBaseTree !== undefined) {
            for (const e of listTreePaths(repo, curBaseTree)) bMap.set(e.path, e.oid);
          }
          const paths = new Set<string>([...mbMap.keys(), ...hMap.keys(), ...bMap.keys()]);
          for (const p of paths) {
            const mb = mbMap.get(p);
            const h = hMap.get(p);
            const b = bMap.get(p);
            const headChanged = h !== mb;
            const baseChanged = b !== mb;
            if (headChanged && baseChanged && h !== b) {
              conflict = true;
              break;
            }
          }
        }
        if (conflict) {
          errJson(res, 405, 'merge conflict');
          return true;
        }
        const headTree = commitTree(repo, headTip);
        if (headTree === undefined) {
          errJson(res, 404, 'head commit not found');
          return true;
        }
        const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
        const author = store.gitAuthor();
        const commitData = buildCommit(headTree, [baseTip], author, author, message);
        const mergeSha = store.putObject(repo, 'commit', commitData);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.nowIso;
        pull.mergeCommitSha = mergeSha;
        sendJson(res, 200, { merged: true, sha: mergeSha, message });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }

    // Anything else under /repos/{o}/{r}/... is unknown.
    errJson(res, 404, 'Not Found');
    return true;
  }

  // Any other path under /api/v3 is an unknown route.
  errJson(res, 404, 'Not Found');
  return true;
}
