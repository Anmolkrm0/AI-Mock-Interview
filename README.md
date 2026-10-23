# AI Mock Interview

Practice a spoken interview for the exact job you're applying to. Upload a resume and a job description, pick the role, length and how hard the interviewer should push, then answer an AI interviewer out loud. Afterwards, every answer is scored on a fixed 1–5 rubric with the exact lines from your answer that support the score.

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, shadcn/ui-style components, React Hook Form + Zod
- **Backend:** FastAPI, Pydantic v2, SQLAlchemy 2 (async), Alembic, psycopg 3, HTTPX
- **Data:** Supabase Auth, Postgres (with Row Level Security) and private Storage
- **AI:** Gemini Live (`gemini-3.8-live`) for the voice interview; Gemini Flash-Lite for parsing, planning and scoring; optional Groq for text
- **Hosting:** Render (two free web services)

```
Browser ──(Supabase session)──► Next.js on Render ──────────► FastAPI on Render ──► Supabase Postgres / Storage
   │                                                              │
   └──── WebSocket audio, short-lived token minted by FastAPI ──► Gemini Live API      Gemini text API ◄──┘
```

The Gemini API key never reaches the browser: FastAPI mints a single-use token that locks the interviewer's instructions, then the browser talks to Gemini Live directly for low-latency audio. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## What's verified, and what you must verify

| Area | Status |
|---|---|
| Backend: 107 automated tests against real PostgreSQL (migrations, auth, user isolation, RLS, the full interview → report flow, skip/retake, timer persistence, recording replacement, failure recovery, durable jobs) | Passing |
| Frontend live-interview engine (3 scenario tests) and validation / recording-budget / highlighting logic (10 tests) | Passing (run in the build workspace) |
| Contract: the exact event stream produced by the frontend engine replayed against the real backend | Passing |
| Frontend type check of all app code against real React, Zod and React Hook Form types | Passing |
| `npm install`, `next build`, ESLint, and the rest of the Vitest suite (components, API client, event queue, route protection) | **Run `./scripts/verify.sh` on your Mac** (the build workspace had no npm access) |
| Real Gemini voice session, real Supabase, Render deploy | **Needs your keys** — follow the checklist in [docs/TESTING.md](docs/TESTING.md#manual-release-checklist) |

AI calls are mocked in the automated suite. Opt-in tests that hit real Gemini are in `backend/tests/test_real_providers.py` and `frontend/tests/e2e/`.

---

## Run it on your Mac

You need macOS with [Homebrew](https://brew.sh). Everything else is installed by the setup script (Python 3.12, Node 22, and a local PostgreSQL used only by tests). No Docker needed.

```bash
git clone <your-repo-url> ai-mock-interview && cd ai-mock-interview
./scripts/setup-mac.sh
```

### 1. Create the Supabase project (free)

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a region near your users (for India: Mumbai). Save the database password.
2. **Project Settings → API keys**: copy the **Publishable key** (`sb_publishable_…`) and a **Secret key** (`sb_secret_…`).
   If your project only shows legacy keys, use `anon` as the publishable key and `service_role` as the secret key.
3. **Project Settings → Database → Connect → Session pooler**: copy the URI. It works on IPv4 networks (Render needs this).
4. **Authentication → URL Configuration**:
   - Site URL: `http://localhost:3000` (change to your Render URL after deploying)
   - Redirect URLs: add `http://localhost:3000/auth/callback` and later `https://<your-frontend>.onrender.com/auth/callback`
5. If your project still signs tokens with the legacy JWT secret, copy **Project Settings → JWT Keys → Legacy JWT secret**. Projects using the newer signing keys don't need it; the backend verifies tokens against the project's public keys.

### 2. Get a Gemini API key (free tier)

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key**. Check your quotas at [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). Flash-Lite's free daily quota is much larger than Flash's, which is why it's the default for text work.

### 3. Configure

`backend/.env` (created from `.env.example`):

```ini
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_JWT_SECRET=            # only for legacy-secret projects
CORS_ORIGINS=http://localhost:3000
ADMIN_EMAILS=you@example.com    # comma-separated; access private /admin/feedback (must be email-verified)
GEMINI_API_KEY=...
```

Admin page: users whose email is listed in `ADMIN_EMAILS` (and email verified) can visit `/admin/feedback` to inspect all user ratings, comments, and interview details. For all other users, admin routes return 404.


`frontend/.env.local`:

```ini
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_API_URL=http://localhost:8000
```

### 4. Create the schema, verify, run

```bash
./scripts/migrate.sh     # creates tables, Row Level Security policies and the private storage buckets
./scripts/verify.sh      # lint, types, all tests, production build
./scripts/dev.sh         # backend on :8000, frontend on :3000
```

Open http://localhost:3000, create an account, and run a 10-minute interview. Use Chrome, Edge or Safari, and headphones for the most natural conversation.

Health: http://localhost:8000/api/v1/health shows database and provider status (never secrets). API docs: http://localhost:8000/docs (disabled in production).

---

## Deploy to Render and share it

Full walkthrough: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short:

1. Push to GitHub (`package-lock.json` must be committed; `setup-mac.sh` creates it).
2. Render → **New → Blueprint** → select the repo. `render.yaml` creates both services; fill in the secret values it asks for.
3. Run `./scripts/migrate.sh "<production DATABASE_URL>"` once (and after future schema changes).
4. Set the backend's `CORS_ORIGINS` to your frontend URL, the frontend's `NEXT_PUBLIC_API_URL` to your backend URL, and add the frontend URL to Supabase's Site URL and Redirect URLs.
5. Run the release checklist in [docs/TESTING.md](docs/TESTING.md#manual-release-checklist) on the live URL, then share it.

For running a beta with real users (limits, what to measure, how to read feedback): [docs/LAUNCH.md](docs/LAUNCH.md).

---

## Free-tier limits you will hit

- **Render free:** services sleep after ~15 minutes idle; the first request takes up to a minute. The app shows a "server is waking up" state and retries.
- **Gemini free tier:** per-project daily request limits. Each interview uses ~3–4 text requests (parse, plan, score) plus one Live session. The backend caps each account at 5 interviews per 24 hours (`DAILY_INTERVIEW_LIMIT`) and shows a clear message when Google's quota is exhausted. It never switches to a paid model silently.
- **Supabase free:** 50 MB per file and 1 GB storage in total. Recordings are budgeted to fit 50 MB; only each user's latest recording is kept. Free projects pause after a week of inactivity.

## Repository layout

```
backend/   FastAPI app (app/api, services, providers, models), Alembic migrations, tests
frontend/  Next.js app (app/ routes, components, lib/live = interview engine), tests
docs/      ARCHITECTURE, API, DATABASE, AI_PIPELINE, TESTING, DEPLOYMENT, LAUNCH
scripts/   setup-mac.sh, verify.sh, dev.sh, migrate.sh
render.yaml  Render Blueprint for both services
```
