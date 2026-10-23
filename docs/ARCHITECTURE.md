# Architecture

## Components

| Component | Runs on | Responsibility |
|---|---|---|
| Next.js frontend | Render web service (Node) | Pages, Supabase sign-in, the live interview engine (`lib/live`), recording, uploads |
| FastAPI backend | Render web service (Python) | Validation, ownership checks, state machine, AI calls, token minting, evaluation jobs |
| Supabase Auth | Supabase | Email + password accounts, session cookies |
| Supabase Postgres | Supabase | Source of truth for every user record; RLS on all tables |
| Supabase Storage | Supabase | Private buckets `interview-recordings` and `interview-documents` |
| Gemini Live API | Google | Real-time voice interviewer (browser ↔ Google over WebSocket) |
| Gemini text API | Google | Resume/JD parsing, interview planning, scoring |

## Key decisions

**Browser connects to Gemini Live directly, with an ephemeral token.** Relaying audio through the backend would add latency and keep a long-lived WebSocket on a free Render instance that sleeps and restarts. Instead FastAPI calls `POST /v1alpha/auth_tokens` with the interview's full setup (model, system instruction, tools, transcription) and a `fieldMask` that locks those fields. The browser gets a single-use token that expires in 30 minutes and can only start a session within 2 minutes. It cannot change the interviewer's instructions. Session resumption is left unlocked so reconnects can resume context. The permanent API key never leaves the server.

**The backend is authoritative; the browser reports events.** The browser posts typed events (`question_asked`, `answer_submitted`, `question_skipped`, `answer_retake`, `transcript_segment`, …). Each has a client-generated id; the backend applies them inside a transaction holding a row lock on the interview, assigns a sequence number, and ignores duplicates. Events are also written to `localStorage` before sending, so a crash or refresh doesn't lose answers.

**Turn control through tool calls.** The interviewer model calls `advance_to_question(n)` when it's done with a question (after any follow-ups). The browser submits the collected answer for the current question, marks the next one asked, and replies with that question's text. Candidate controls (skip, retake) are sent to the model as clearly marked `[CONTROL]` messages. One question per turn; the plan is never generated as one long response.

**Server-anchored timer.** `started_at`/`deadline_at` are set by the backend on `session_started`. The browser computes the countdown from the server's clock offset, so refreshes, sleeping tabs and wrong device clocks don't change it. The backend rejects answers after the deadline (plus a 2-minute grace), refuses new live tokens, and a worker finalizes abandoned sessions.

**Durable work in Postgres, not memory.** Report generation is a row in `evaluation_jobs`, claimed with `FOR UPDATE SKIP LOCKED` and a lease. If Render restarts mid-evaluation, the lease expires and the job is picked up again. Storage deletions that fail go to `storage_cleanup_tasks` and are retried.

**No transaction is held during an AI call.** Services commit, call the model, then reopen a short transaction to persist the result.

## Interview state machine

```
created ─► preparing ─► ready ─► connecting ─► in_progress ⇄ paused
   │           │          │          │              │          │
   └► cancelled ◄──────────┴──────────┘              └──► finalizing ─► evaluating ─► completed
               │                                                          │
               └────────────► failed ◄────────────────────────────────────┘
failed ─► preparing   (only if planning failed)
failed ─► connecting  (only if the live connection failed)
failed ─► evaluating  (only if scoring failed)
```

Rules live in `backend/app/services/interview_service.py` (`TRANSITIONS`, `RETRY_FROM_FAILED`). A completed interview can't restart; retries never create a second interview.

## Request flow for one interview

1. `POST /documents/resume` → validate (type, magic bytes, size) → extract text locally (PyMuPDF / python-docx) → reject unreadable files → store original privately → LLM extraction validated by Pydantic.
2. `POST /documents/job-description` (file or pasted text) → same pipeline; also proposes role titles with confidence.
3. `POST /roles/detect` → preselect a role only when one is clearly dominant.
4. `POST /interviews` with an `Idempotency-Key` → `created`. `POST /interviews/plan` → `preparing` → plan persisted → `ready`.
5. `POST /interviews/{id}/live-token` → `connecting`; browser connects to Gemini Live; `session_started` event → `in_progress`, deadline set.
6. Events stream in; answers and attempts are persisted as they happen.
7. `POST /interviews/{id}/complete` (idempotent) → `finalizing` → `evaluating`, job queued.
8. Browser uploads the recording via a signed upload URL, then `POST /recordings/confirm` swaps the user's single recording pointer.
9. Worker scores the answers → report persisted → `completed`.

## Security model

- Backend verifies Supabase access tokens itself (JWKS for asymmetric keys, or the legacy HS256 secret), checking signature, issuer, audience, expiry and subject. A user id from the browser is never trusted.
- Every query is scoped by the authenticated user; foreign ids return 404 (no existence leak).
- Postgres RLS: users can read only their own rows through Supabase's Data API; internal tables are revoked from API roles.
- Storage buckets are private with no user policies. Uploads use backend-issued signed upload tokens for backend-chosen paths (`{user}/{interview}/{uuid}.ext`); playback uses 5-minute signed URLs.
- Untrusted document and transcript text is delimited and labelled as data in every prompt.
- Logs redact keys and tokens; error responses never include stack traces or SQL.
- Rate limits per user (general, AI calls, live tokens), daily interview cap, one active interview per user.
