# Testing

Run everything on your Mac with `./scripts/verify.sh`.

## Automated suites

| Suite | Command | Real or mocked |
|---|---|---|
| Backend unit + integration (107 tests) | `cd backend && .venv/bin/pytest` | **Real PostgreSQL** (a throwaway `mock_interview_test` database, rebuilt by running the Alembic migrations). **AI and Storage mocked** (`tests/fakes.py`). Tokens are real JWTs checked by the production verifier. |
| Row Level Security | part of the above (`tests/test_rls.py`) | Real Postgres with a simulated Supabase `auth`/`storage` schema |
| Frontend unit (Vitest) | `cd frontend && npm test` | Mocked network, Supabase and Gemini |
| Real AI providers (opt-in) | `RUN_REAL_PROVIDER_TESTS=1 REAL_GEMINI_API_KEY=… .venv/bin/pytest tests/test_real_providers.py` | **Real Gemini**: structured extraction and Live token minting |
| End-to-end (opt-in) | `E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e` | **Real stack** (Supabase test project + Gemini). Fake microphone, typed answers. |

Point `TEST_DATABASE_URL` at a disposable local database. The suite drops and recreates it; never point it at Supabase.

Mocked tests prove our logic: state transitions, persistence, authorization, recovery. They are not proof that real voice works — that's what the opt-in suites and the manual checklist are for.

### What the backend suite covers

Resume/JD validation (type, magic bytes, size, empty, unreadable), parsing failure → retry → manual correction, role detection, plan validation and adaptive question count for every duration and rigor, idempotent creation under 4 concurrent requests, daily limit, state transitions (including "completed can't restart"), the full live flow (answer, follow-up exchange, retake preserving attempts, skip, duplicate events, deadline persistence across refresh and reconnect), event rejection after the deadline, auto-finalization, one active interview per user, evaluation retries / failure / manual retry, invalid model output retried, lease recovery after a simulated crash, recording replacement (old file kept until the new one is verified, truncated uploads rejected, failed deletes retried later, previous reports kept), user isolation on every endpoint, error responses without internals, and a contract test that replays the exact event stream produced by the frontend engine.

### What the frontend suite covers

The live interview engine end to end against a scripted fake Gemini session (answer → model advance → skip → typed answer → retake → dropped connection → resume with handle → end, idempotent finish), event queue persistence and recovery from network failure, API client error mapping and cold-start retries, route protection redirects, form validation, duration/rigor selection, interview controls, typed-answer keyboard behaviour, timer display, feedback submission, dashboard empty state and history, recording size budgeting, evidence highlighting.

## Manual release checklist

Run on the deployed URL with a real account before sharing. Tick each item; if one fails, fix and re-run.

**Setup and auth**
- [ ] Sign up, confirm email from the link, land on the dashboard. Sign out; protected pages redirect to sign-in and back after login.
- [ ] Empty dashboard shows "No interviews yet. Start your first mock interview to track your progress."
- [ ] A `.txt` resume and a 6 MB PDF are rejected with clear messages. A scanned-image PDF is rejected as unreadable.
- [ ] A real PDF resume and a pasted job description parse; corrections save.
- [ ] Role is preselected for a clear posting; you can choose "Something else".

**Live interview** (Chrome with headphones, then Safari without)
- [ ] The interviewer introduces itself, explains the format and asks question 1 out loud.
- [ ] A spoken answer appears in the transcript; the interviewer follows up or moves on, and the question panel advances.
- [ ] "Type an answer" pauses the mic; Enter sends; the interviewer responds.
- [ ] "Skip question" moves on; "Retake answer" asks you to answer again.
- [ ] Refresh mid-interview: the timer continues from where it was; "Rejoin" resumes at the right question.
- [ ] Turn Wi-Fi off for 10 seconds: "Reconnecting" appears, then the interview continues.
- [ ] Deny microphone permission: a clear message explains how to allow it.
- [ ] End the interview: processing page uploads the recording with progress, then opens the report.

**Report and history**
- [ ] Scores, competency bars, highlighted evidence, "Not scored" list for the skipped question.
- [ ] Feedback saves; dashboard shows the score and "Latest recording".
- [ ] Run a second recorded interview: the first interview's report still opens, its recording is gone, the second plays.
- [ ] Settings → Delete recording works and the report remains.
- [ ] Open another account in a private window: the first account's interview URLs show "not found".

**Ops**
- [ ] `GET /api/v1/health` shows database ok, `up_to_date: true`, providers configured, no secrets.
- [ ] View source / network tab: no `GEMINI_API_KEY` or `sb_secret_` anywhere in the browser.
