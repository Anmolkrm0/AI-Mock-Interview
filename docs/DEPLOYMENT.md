# Deployment (Netlify + Render + Supabase)

Host the Next.js frontend on Netlify's free plan, keep the FastAPI backend on Render's free plan, and store data in Supabase (free tier). Total server cost: **₹0 / month**.

---

## 0. Before you start

- `./scripts/verify.sh` passes on your Mac.
- `frontend/package-lock.json` exists and is committed (`setup-mac.sh` creates it).
- No `.env` or `.env.local` files are committed (`.gitignore` excludes them).
- `netlify.toml` is present at the repository root.

---

## 1. Push to GitHub

```bash
git remote add origin https://github.com/<you>/ai-mock-interview.git
git push -u origin main
```

---

## 2. Production Supabase

You can reuse your development project for a small beta, or create a separate production project at [supabase.com](https://supabase.com).

Run the migrations once against production:

```bash
./scripts/migrate.sh "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

This creates tables, Row Level Security policies, and the private `interview-recordings` and `interview-documents` storage buckets.

Auth settings (**Authentication → URL Configuration**):
- **Site URL:** `https://<netlify-site>`
- **Redirect URLs:** add `https://<netlify-site>/auth/callback` (and `http://localhost:3000/auth/callback` for local development).

---

## 3. Backend on Render (free tier)

Deploy the FastAPI service on Render as a free Web Service (or via `render.yaml` Blueprint):

| Field | Value |
|---|---|
| **Name** | `ai-mock-interview-api` |
| **Runtime** | `Python` |
| **Root Directory** | `backend` |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"` |
| **Health Check Path** | `/api/v1/ready` |

**Environment variables:**
- `DATABASE_URL` — production Session pooler URI (`postgresql://...:5432/postgres`)
- `SUPABASE_URL` — `https://<ref>.supabase.co`
- `SUPABASE_SECRET_KEY` — `sb_secret_...`
- `SUPABASE_JWT_SECRET` — only for legacy-secret projects
- `GEMINI_API_KEY` — Google Gemini API key
- `GEMINI_TEXT_MODEL` — `gemini-3.5-flash-lite`
- `GEMINI_EVALUATION_MODEL` — `gemini-3.5-flash-lite`
- `GEMINI_LIVE_MODEL` — `gemini-3.8-live`
- `GEMINI_LIVE_API_VERSION` — `v1alpha`
- `CORS_ORIGINS` — `https://<netlify-site>,https://<frontend>.onrender.com` (comma-separated if transitioning; no trailing slash)
- `ADMIN_EMAILS` — comma-separated admin emails allowed to access `/admin` dashboard (must be email-verified)
- `DAILY_INTERVIEW_LIMIT` — `5`
- `RUN_WORKER` — `true`

### Keep-awake pinger (₹0 cost)
Render's free tier spins down services after 15 minutes of idle time. Set up a free external uptime monitor (such as [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com)) to ping:
```
GET https://<backend>.onrender.com/api/v1/health
```
every 10–14 minutes. This keeps the backend warm so candidates receive an immediate greeting without waiting for a cold start.

---

## 4. Frontend on Netlify (free tier)

1. Log in to [netlify.com](https://netlify.com) and click **Add new site → Import an existing project**.
2. Select your GitHub repository.
3. The included `netlify.toml` automatically configures:
   - **Base directory:** `frontend`
   - **Build command:** `npm run build`
   - **Publish directory:** `.next`
   - **Node version:** `22` (via `[build.environment] NODE_VERSION = "22"`)
   Netlify's Next.js runtime is detected automatically; do not add a custom server.
4. In **Site configuration → Environment variables**, add the 4 public configuration variables:
   - `NEXT_PUBLIC_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — `sb_publishable_...` (or legacy anon key)
   - `NEXT_PUBLIC_API_URL` — `https://<backend>.onrender.com` (your live Render backend URL, no trailing slash)
   - `NEXT_PUBLIC_RECORDING_MAX_BYTES` — `52428800`
5. Click **Deploy site**. Once built, your site will be live at `https://<netlify-site>`.

---

## 5. Legacy Render frontend redirect (transition)

If you previously hosted the frontend on Render (`ai-mock-interview-web`):

1. In the Render Dashboard, go to your old `ai-mock-interview-web` service → **Environment**.
2. Add environment variable:
   ```ini
   LEGACY_REDIRECT_TO=https://<netlify-site>
   ```
3. `frontend/proxy.ts` checks `LEGACY_REDIRECT_TO` on every incoming request. If set to a valid `https:` URL, it returns an immediate `308 Permanent Redirect` to the new Netlify origin, preserving the exact path and query string.
4. **Important:** Set `LEGACY_REDIRECT_TO` *only* on the old Render frontend service. Never set it on Netlify itself.

---

## 6. Verify the deployment

1. **Backend health check:**
   ```bash
   curl https://<backend>.onrender.com/api/v1/health
   ```
   Expect `"database": {"status": "ok", "up_to_date": true}` and every provider `"configured": true`.

2. **Frontend check:**
   Open `https://<netlify-site>` in Chrome or Safari. Log in, upload a resume and job description, and start a practice interview.

3. **Legacy redirect check (if transitioning from Render):**
   ```bash
   curl -sI https://<old-frontend>.onrender.com/interview/setup?role=swe
   ```
   Expect `HTTP/2 308` with `location: https://<netlify-site>/interview/setup?role=swe`.

4. Follow the manual checklist in [docs/TESTING.md](TESTING.md#manual-release-checklist).

---

## 7. Free-tier behaviour & ₹0 cost guarantee

- **Netlify free tier:** Generous free bandwidth and build minutes, global CDN edge, zero cold starts for static assets and server components.
- **Render free tier:** Backend API service runs at ₹0. The keep-awake pinger on `/api/v1/health` keeps the service responsive.
- **Supabase free tier:** 500 MB database, 1 GB file storage, 50 MB per file, 5 GB egress.
- **Gemini free tier:** Daily quota per project; `DAILY_INTERVIEW_LIMIT` (default 5 per user per day) prevents quota exhaustion.
- **Total server cost:** ₹0 / $0 per month.

---

## 8. Rollback

- **Netlify:** Site configuration → **Deploys** → select previous deploy → **Publish deploy**.
- **Render:** Service → **Events** → select previous deploy → **Rollback**.
- Migrations are additive; if a migration must be undone: `cd backend && .venv/bin/alembic downgrade -1`.
