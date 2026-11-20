// The forge's store: every repository, git object, issue, pull request and label,
// all in memory. No wall clock and no randomness anywhere in request handling:
// every timestamp comes from the trial's fixed now (MAKEFUN_TRIAL_NOW), so two
// runs of the same trial observe identical state.
//
// Ownership: the shop token (MAKEFUN_SHOP_TOKEN) names exactly one viewer. The
// token itself is `shpat_<hex>` and does NOT encode the login, so the viewer
// login comes from the kit's scenario, whose seed is a fixed public constant
// (wire.ts SCENARIO_SEED) — the same in every trial, live, replay and practice.
// Viewer: adaiversen (id 1000). The only other login the suite ever names is the
// stranger olgabauer, whose repos are 404 to the viewer, never 403.

import { objectId } from './gitobj.ts';

export interface ViewerInfo {
  login: string;
  id: number;
  name: string;
  email: string;
}

export const VIEWER: ViewerInfo = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const STRANGER_LOGIN = 'olgabauer';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Raw content WITHOUT the "<type> <len>\0" header. Stored byte-exact. */
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  /** Global numeric id (stable across reads; unique per forge instance). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Creation order, 1-based per repo: drives sort=created asc/desc. */
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string; // always 'main'
  refs: Map<string, string>; // 'refs/heads/main' | 'refs/tags/v1' -> oid
  objects: Map<string, GitObject>;
  issues: Issue[];
  nextIssue: number; // starts at 1
  pulls: Pull[];
  nextPull: number; // starts at 1
  labels: Map<string, Label>;
  nextCommentId: number; // starts at 1
  nextSeq: number; // creation-order counter, starts at 1
}

const FALLBACK_NOW_ISO = '2026-01-01T00:00:00Z';

export class Store {
  readonly viewer: ViewerInfo = VIEWER;
  /** The trial's fixed now (RFC 3339). Never the wall clock. */
  readonly nowIso: string;
  /** Epoch seconds of nowIso, for git author/committer lines. */
  readonly nowEpoch: number;
  /** MAKEFUN_SHOP_TOKEN, or '' when unset (local dev only). */
  readonly token: string;
  repos: Map<string, Repo>;
  nextRepoId: number;
  /** Global issue id counter, starts at 1 (REST `id`, stable across reads). */
  nextIssueId: number;

  constructor() {
    const rawNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = rawNow === '' ? NaN : Date.parse(rawNow);
    this.nowIso = Number.isFinite(parsed) ? new Date(parsed).toISOString().replace('.000Z', 'Z') : FALLBACK_NOW_ISO;
    this.nowEpoch = Math.floor(Date.parse(this.nowIso) / 1000);
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
  }

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer.login,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      labels: new Map(),
      nextCommentId: 1,
      nextSeq: 1,
    };
    this.repos.set(Store.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  /** Store the object if absent; return its oid. Never rewrites stored bytes. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /**
   * Store an object whose oid is already known (the pack decoder verified it
   * by recomputing it); skips re-hashing. Same "never rewrites" rule as
   * putObject.
   */
  putObjectKnown(repo: Repo, oid: string, type: ObjType, data: Buffer): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Git author/committer line for REST-created commits: deterministic. */
  gitAuthor(): string {
    return `${this.viewer.name} <${this.viewer.email}> ${this.nowEpoch} +0000`;
  }
}
