# QFree — Know Your Queue. Save Your Time.

A smart healthcare queue management and real-time waiting-time system for doctors, clinics, hospitals and laboratories.

**Live demo:** https://qfree-two.vercel.app. The API runs on Render's free plan and sleeps when idle, so the first visit after a quiet period can take up to a minute.

Patients see a provider's live queue, join from their phone, get a digital token (for example `QF-031`), and watch their position and estimated wait update by themselves. They are nudged when their turn is near. Doctors call the next patient with one tap. Clinics and labs run many queues from one dashboard. Administrators oversee the whole platform.

```
┌──────────────────────────────────┐
│       QFree — Live Queue         │
├──────────────────────────────────┤
│ Dr. Sharma · General Physician   │
│ Current Token:       QF-024      │
│ Your Token:          QF-031      │
│ Patients Ahead:      6           │
│ Estimated Wait:      35 min      │
│ ███████████░░░░░░                │
│        🟢 Queue Active           │
└──────────────────────────────────┘
```

**Design docs:** [docs/DESIGN.md](docs/DESIGN.md) covers the architecture, ER diagram, schema, API, frontend structure, auth and roles, queue algorithm, real-time design, and roadmap. **API reference:** Swagger UI at `http://localhost:4000/api/docs` (source: [server/openapi.yaml](server/openapi.yaml)).

## Stack

| | |
|---|---|
| Frontend (`web/`) | React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · React Router 7 · TanStack Query · Socket.IO client · Recharts |
| Backend (`server/`) | Node 24 · Express 5 · TypeScript · Zod 4 · Socket.IO 4 · JWT · pino |
| Database | PostgreSQL · Prisma 7 (driver adapter `@prisma/adapter-pg`) |
| Tests | Vitest · Supertest · socket.io-client · Testing Library |

## Quick start

Requirements: **Node.js 20.19+** (developed on Node 24). Docker and a PostgreSQL install are **not** needed for local development.

```bash
npm install                       # installs both workspaces, generates the Prisma client
cp server/.env.example server/.env  # then set the two JWT secrets (any 32+ char strings)

# terminal 1 — a real PostgreSQL server in server/.pgdata (port 54329)
npm run db:dev

# terminal 2 — schema + demo data + API on :4000
cd server
npx prisma migrate deploy
npm run seed
npm run dev

# terminal 3 — web app on :5173 (proxies /api and /socket.io to :4000)
npm run dev:web
```

Open http://localhost:5173. To use your own PostgreSQL instead, point `DATABASE_URL` / `TEST_DATABASE_URL` at it and skip `db:dev`.

> npm 11 blocks dependency install scripts by default. The root `package.json` already approves the ones QFree needs (`prisma`, `@prisma/engines`, `esbuild`, `embedded-postgres`).

### Demo accounts (password `Password123`)

| Role | Email | Try this |
|---|---|---|
| Patient | `patient@qfree.dev` | Find care → Dr. Rajesh Sharma → **Join queue**. You become QF-031 with 6 ahead. |
| Doctor | `dr.sharma@qfree.dev` | Today's queue → **Done · call next**. Watch the patient's screen update. |
| Clinic admin | `clinic@qfree.dev` | Live dashboard of every queue, doctors, services, staff, hours, reports, analytics |
| Receptionist | `reception@qfree.dev` | Runs Sharma Family Clinic's queues |
| Lab admin | `lab@qfree.dev` | Blood collection and X-ray queues |
| Administrator | `admin@qfree.dev` | Users, verification, audit log, issues, settings. On the live site this account uses the secret `DEMO_ADMIN_PASSWORD` from Render, not `Password123`. |

The seed produces today's live sessions plus 30 days of simulated history (about 4,800 tokens) for analytics. To wipe the local database and reload the demo, run `npm run seed:reset`. Plain `npm run seed` refuses to touch a database that already has users.

## Tests

```bash
cd server && npm test   # 47 tests: queue algorithm, auth, queue flows incl. concurrency, RBAC, sockets
cd web && npm test      # component and helper tests
```

Server integration tests run against `TEST_DATABASE_URL` (the `qfree_test` database created by `npm run db:dev`) and apply migrations automatically.

## Project layout

```
server/
  prisma/            schema.prisma · migrations (incl. partial unique indexes, CHECKs) · seed.ts
  src/
    config/env.ts    validated environment
    lib/             prisma, logger, audit, settings, time zones, tokens, validation
    middleware/      auth (JWT + roles), errors, rate limits
    modules/         auth · queues (logic/state/service/routes) · organizations · doctors · services
                     patients · notifications · analytics · issues · admin · access (resource RBAC)
    realtime/        Socket.IO server, rooms, publish-after-commit
  tests/             vitest suites
  openapi.yaml       API spec served at /api/docs
web/
  src/lib            api client (silent token refresh), auth, socket manager
  src/hooks          live queue hooks
  src/components     ui primitives · queue (LiveQueueCard, QueueBoard…) · charts
  src/pages          public · patient · doctor · org · admin · shared
docs/DESIGN.md
```

## Configuration

`server/.env`:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `TEST_DATABASE_URL` | — | Separate database for tests |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | — | **Required**, at least 32 characters each, different from each other |
| `ACCESS_TOKEN_TTL` | `15m` | |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list |
| `PORT` | `4000` | |
| `TRUST_PROXY` | `1` | Hops of reverse proxy (for correct client IPs in rate limits and audit) |
| `LOG_LEVEL` | `info` | |

Web build settings:
- `VITE_API_URL`: leave empty, so REST calls go to `/api` on the same origin.
- `VITE_SOCKET_URL`: the API origin for WebSockets (see `web/.env.production`).

## Deployment

The live setup is **web on Vercel**, **API + PostgreSQL on Render**:

```
browser ──▶ qfree-two.vercel.app ──/api/* proxy──▶ qfree-api.onrender.com ──▶ PostgreSQL (Render)
   └───────────── WebSocket (Socket.IO) ────────────▶ qfree-api.onrender.com
```

REST calls go through Vercel's `/api` proxy ([web/vercel.json](web/vercel.json)), which makes the refresh cookie first-party. Otherwise Safari/iOS would block it as a third-party cookie. Vercel can't proxy WebSockets, so the socket connects to Render directly. It authenticates with the access token, not cookies.

**API + database (Render):** [render.yaml](render.yaml) is a Blueprint.
- **Setup:** in the Render dashboard choose New → Blueprint → this repo, and enter `CORS_ORIGINS` (the web origin). Render generates the JWT secrets and the demo admin password.
- **On each start:** it runs `prisma migrate deploy`, then loads demo data if `SEED_DEMO=true` and the database is empty, then starts the server.
- **Redeploys:** pushes to `main` redeploy automatically.
- **Free-plan limits:** the service sleeps after 15 idle minutes, and the free database expires after 30 days. Point `DATABASE_URL` at e.g. Neon to keep data.

**Web (Vercel):** the project root is `web`. Deploy with:

```bash
cd web
npx vercel@latest build --prod
npx vercel@latest deploy --prebuilt --prod
```

If the API moves, update the `/api` rewrite in `web/vercel.json` and `VITE_SOCKET_URL` in `web/.env.production`.

**Scaling:** the API is stateless (queue locks live in PostgreSQL). For multiple instances, add the Socket.IO Redis adapter (see DESIGN §8).

## Security summary

bcrypt password hashing (cost 12) · short-lived JWT held only in memory · rotating httpOnly refresh cookie with reuse detection · role- and resource-level authorization on REST and sockets · Zod validation on every input · parameterized SQL only · helmet, strict CORS, and body size limits · rate limiting on API, credentials and joins · audit log for logins, role changes, priority changes, out-of-hours openings and every view of patient details · public queue data carries token numbers only · minimal patient data (no medical records).

## Roadmap

**Done recently:** advance booking (booking window, quota, estimated times), on-the-spot patients added at reception, missed → recall without disturbing the line, daily limit + cutoff-time closing rules with manual stop/reopen, doctor availability and location page.

**Next:** QR code joining · SMS/WhatsApp and Web Push · arrival check-in for booked patients · multilingual UI · payments · lab report tracking · multi-branch rollups · ML wait prediction. See [docs/DESIGN.md §9](docs/DESIGN.md#9-roadmap).
