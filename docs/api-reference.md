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

## Live updates
- `WS /ws/db/:name?token=<t>&labels=A,B&types=X,Y` — frames: `{type:'ready'}`,
  `{type:'batch',txId,ops}`, `{type:'resync_required'}` (then close).

## Ops
- `GET /healthz` → `{status:'ok'}` · `GET /metrics` → Prometheus text
