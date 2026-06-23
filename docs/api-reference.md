# Atlas Server — API Reference

Base: `/api`. Auth: session cookie (`atlas_session`, from `/api/auth/login`) or
`Authorization: Bearer <tokenId.secret>`. Errors are RFC 7807
`application/problem+json` carrying a `code` (and `line`/`column`/`snippet` for
query errors).

## Auth
- `POST /api/auth/register` `{username,password}` → 201 `{username,isAdmin}`
- `POST /api/auth/login` `{username,password}` → 200 + session cookie
- `POST /api/auth/logout` → clears the cookie
- `GET /api/auth/whoami` → `{username,isAdmin}`

## Databases (permission matrix enforced)
- `GET /api/db` → databases the caller can access
- `POST /api/db` `{name}` → 201 (creator becomes owner)
- `GET /api/db/:name` → `{name,description,role,owners}` (read)
- `PATCH /api/db/:name` `{description}` (owner)
- `DELETE /api/db/:name` (owner or server admin)
- `POST /api/db/:name/roles` `{username,role}` (owner) · `DELETE /api/db/:name/roles/:user`

## Query & schema
- `POST /api/db/:name/query` `{query,params}` → `{columns,rows,stats}`. Role by
  statement: read/CALL=viewer+, write=editor+, DDL=owner. `EXPLAIN` = read.
- `GET /api/db/:name/schema` → labels + edge-type summary (read)

## Data CRUD
- `GET|POST /api/db/:name/nodes[/:id]`, `PATCH|DELETE …/nodes/:id` (`?detach=true`)
- `GET|POST /api/db/:name/edges[/:id]`, `PATCH|DELETE …/edges/:id`
- `DELETE …/nodes/:id` on a node with incident edges → 409 `application/problem+json`
  with `code: "DETACH_REQUIRED"`. Pass `?detach=true` to remove the node and its edges.

## Import / export / seed
- `POST /api/db/:name/import` — JSON `{nodes:[{tempId,labels,properties}],edges:[{from,to,type,properties}],atomic?}`
  → `{committed,idMap,error?}`. `?format=csv` with `{nodesCsv,edgesCsv}` (typed
  headers: `name:string`, `born:number`; `:label`, `:from`, `:to`, `:type`).
  Non-atomic commits in 10k batches and reports the first failure; `atomic:true`
  is all-or-nothing.
- `GET /api/db/:name/export` → the same JSON shape (real ids as tempIds)
- `POST /api/db/:name/seed/:dataset` — `science-history`

## Tokens
- `POST /api/tokens` `{name}` → `{tokenId,name,token}` (token shown once)
- `GET /api/tokens` → `[{tokenId,name}]` · `DELETE /api/tokens/:id`

## Users (server admin only)
All routes require an authenticated **server admin** (`isAdmin`); others get 401/403.
- `GET /api/users` → `[{username,isAdmin,createdAt}]`
- `POST /api/users` `{username,password,isAdmin?}` → 201 `{username}` (409 if it exists)
- `PATCH /api/users/:username` `{isAdmin}` → 204 (409 `CONSTRAINT_VIOLATION` if it would demote the last admin)
- `POST /api/users/:username/password` `{password}` → 204 (revokes that user's sessions)
- `DELETE /api/users/:username` → 204 (409 on self-delete or deleting the last admin)

## Audit log (server admin only)
- `GET /api/audit?limit=<1..1000, default 100>` → `[{seq,at,username,action,target,detail?}]`,
  most recent first. Records every write op (node/edge create·patch·delete, import,
  seed, db create·patch·delete, role grant·revoke, write queries, user admin) after
  it commits. Recording is best-effort — an audit-store failure never fails the
  underlying write.

## Live updates
- `WS /ws/db/:name?token=<t>&labels=A,B&types=X,Y` — server→client frames:
  `{type:'ready'}` (subscription active), `{type:'batch',txId,ops}` (a committed
  transaction matching the label/type filter), `{type:'resync_required'}` (the
  change feed is stale; the client should reload — the socket then closes), and
  `{type:'error',code,message}` (e.g. `code:"FORBIDDEN"` when the caller may not
  read the database; the socket then closes). Authentication failures abort the
  upgrade before `open` (the client never sees a frame).

## Ops
- `GET /healthz` → `{status:'ok'}` · `GET /metrics` → Prometheus text
