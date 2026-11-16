# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Heru1933/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Heru1933/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, written from scratch in TypeScript (Node 22,
stdlib only, no dependencies), built for the make.fun
`github-core-clone-01` competition.

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 `upload-pack`
  (`ls-refs` + `fetch`, shallow/deepen supported) and v0 `receive-pack`
  (create / fast-forward / delete, per-ref `report-status`).
- **REST v3** (`/api/v3`): repos, contents (create/update/delete with
  SHA-checked writes), git refs, branches, commits, labels, issues (+
  comments), pull requests (incl. squash merge), pagination.
- **GraphQL v4** (`/api/graphql`): repository / issue / pull-request
  queries, mutations (createIssue, createPullRequest, mergePullRequest,
  addComment, …), `node(id:)`, introspection, batched operations.
- **MCP** (`/mcp`): Streamable HTTP server (modern 2026-07-28 protocol
  with `discover`, plus legacy `initialize`): tools for listing/reading
  repos, issues and pull requests, creating issues, and more.

## Running

```sh
node main.ts            # requires MAKEFUN_ENV_URL (the trial env)
```

The entry binds an ephemeral port, registers it with the trial env, and
exits when the env reports the trial is done. `GET /healthz` answers
`{"ok": true}`. Every other route requires
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

| file | contents |
| --- | --- |
| `main.ts` | entry lifecycle: bind, register, wait for done |
| `app.ts` | HTTP server, routing, central auth |
| `httputil.ts` | request shape, JSON envelope, request ids |
| `store.ts` | in-memory store: repos, issues, pulls, time source |
| `gitobj.ts` | SHA-1, commit/tree/tag codecs, pack encode/decode, graph ops |
| `gitproto.ts` | git smart HTTP (v2 upload-pack, v0 receive-pack) |
| `rest.ts` | REST v3 |
| `graphql.ts` | GraphQL v4 executor |
| `mcp.ts` | MCP Streamable HTTP |

## Determinism

All timestamps come from `MAKEFUN_TRIAL_NOW` (never the wall clock) and
there is no unseeded randomness, so a replayed trial is byte-identical.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cdmv4w6f&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
