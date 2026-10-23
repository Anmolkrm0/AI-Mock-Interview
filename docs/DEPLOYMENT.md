# Deployment (Render + Supabase)

## 0. Before you start

- `./scripts/verify.sh` passes on your Mac.
- `frontend/package-lock.json` exists and is committed (`setup-mac.sh` creates it). Render's `npm ci` fails without it.
- No `.env` files are committed (`git status` should not show them; `.gitignore` excludes them).

## 1. Push to GitHub

```bash
git remote add origin https://github.com/<you>/ai-mock-interview.git
git push -u origin main
```

## 2. Production Supabase

You can reuse your development project for a small beta, but a separate production project keeps test data out. For the production project, repeat README step 1 and then:

```bash
./scripts/migrate.sh "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

This creates the tables, RLS policies and the private `interview-recordings` / `interview-documents` buckets. Re-run it after any future schema change, **before** deploying the new backend.

Auth settings (Authentication → URL Configuration), after step 3 gives you URLs:
- Site URL: `https://<frontend>.onrender.com`
- Redirect URLs: `https://<frontend>.onrender.com/auth/callback`

Optional but recommended for real users: Authentication → Emails → set up custom SMTP. Supabase's built-in email sender has a low hourly limit meant for testing.

## 3. Render Blueprint

Render → **New → Blueprint** → choose the repo. `render.yaml` defines:

| Service | Root | Build | Start | Health check |
|---|---|---|---|---|
| `ai-mock-interview-api` | `backend` | `pip install -r requirements.txt` | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` | `/api/v1/ready` |
| `ai-mock-interview-web` | `frontend` | `npm ci && npm run build` | `npm start` (binds `$PORT`) | `/` |

Fill in the values Render asks for:

**Backend**
- `DATABASE_URL` — production Session pooler URI
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (and `SUPABASE_JWT_SECRET` only for legacy-secret projects)
- `GEMINI_API_KEY`
- `CORS_ORIGINS` — `https://<frontend>.onrender.com` (exact, no trailing slash)
- `ADMIN_EMAILS` — comma-separated admin emails allowed to access `/admin` dashboard and `/admin/feedback` (empty = no admins; email must be verified in Supabase)

**Frontend**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_API_URL` — `https://<backend>.onrender.com`

`NEXT_PUBLIC_*` values are baked into the build: after changing one, trigger **Manual Deploy → Clear build cache & deploy**.

The backend's `/api/v1/ready` returns 503 until the database is reachable and migrations are current, so Render won't send traffic to a backend whose schema is out of date. Nothing is created or dropped automatically at startup.

## 4. Verify the deployment

```bash
curl https://<backend>.onrender.com/api/v1/health
```

Expect `"database": {"status": "ok", "up_to_date": true}` and every provider `"configured": true`. Then run the manual checklist in [TESTING.md](TESTING.md#manual-release-checklist) on the live URL, including one full interview and the recording replacement check.

## Free-tier behaviour

- **Render free:** each service spins down after 15 minutes without traffic and takes about a minute to wake. The 750 free instance-hours per month are shared across your workspace, and this app runs two services, so if both stayed awake around the clock they'd run out mid-month. Normal beta traffic with idle periods stays well under. If you need always-on, upgrade the backend first.
- **Render filesystem is ephemeral.** Nothing is stored on it; all data is in Supabase.
- **Supabase free:** 500 MB database, 1 GB file storage, 50 MB per file, 5 GB egress; the project pauses after 7 days without activity (restore it from the dashboard). Recordings are budgeted to stay under 50 MB, and only each user's latest recording is kept, so 1 GB covers a few dozen active users. For more, use Supabase Pro (larger files, 100 GB storage).
- **Gemini free tier:** daily per-project limits. When exhausted, users see "The AI service's free quota is used up for now" and can retry after the daily reset (midnight Pacific time). `DAILY_INTERVIEW_LIMIT` (default 5 per user per 24 h) protects the shared quota.

## Rollback

Render keeps previous deploys: Service → Events → pick a deploy → **Rollback**. Migrations are additive; if a migration must be undone, `cd backend && .venv/bin/alembic downgrade -1` against the target database.
