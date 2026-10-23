# API

Base path: `/api/v1`. All endpoints except health require `Authorization: Bearer <Supabase access token>`.

Errors always look like:

```json
{ "error": { "code": "AI_PROVIDER_RATE_LIMITED", "message": "The AI service is busy. Wait a minute and try again.", "retryable": true, "request_id": "…", "details": {} } }
```

Interactive docs: `GET /docs` (development only).

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | App, database, migration and provider status. No secrets. |
| GET | `/ready` | 200 only when the DB is reachable and migrations are current. Render health check. |

## Documents

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/documents/resume` | multipart `file` (PDF/DOCX ≤ 5 MB) | `DocumentOut` (parsed) |
| POST | `/documents/job-description` | multipart `file` **or** form field `text` | `DocumentOut` |
| GET | `/documents/{id}` | | `DocumentOut` |
| POST | `/documents/{id}/parse` | | Retry parsing after a failure |
| PATCH | `/documents/{id}` | `{ "extracted_data": {...} }` | Manual correction, validated against the same schema |

If parsing fails after the file was accepted, the error's `details.document_id` lets the client retry without re-uploading.

## Roles and planning

| Method | Path | Body |
|---|---|---|
| POST | `/roles/detect` | `{ "job_description_document_id" }` → `{ roles[], default_role, needs_user_choice }` |
| POST | `/interviews/plan` | `{ "interview_id" }` → interview detail with questions (idempotent) |

## Interviews

| Method | Path | Notes |
|---|---|---|
| POST | `/interviews` | Header `Idempotency-Key`. Body: `resume_document_id`, `job_description_document_id`, `job_role`, `duration_minutes` (10/20/30/45), `evaluation_rigor` (standard/target_bar/stress_test), `recording_mode` (video/audio/none), `consent_given: true`. 201 when created, 200 when the key was seen before. |
| GET | `/interviews?limit&offset` | History with scores and the current-recording pointer |
| GET | `/interviews/{id}` | Detail: questions, attempts, transcript, `server_time` |
| POST | `/interviews/{id}/live-token` | Ephemeral Gemini Live token + connect config + deadline |
| POST | `/interviews/{id}/events` | `{ "events": [ ... up to 50 ] }` (see below) |
| POST | `/interviews/{id}/complete` | `{ "reason" }`. Idempotent. |
| POST | `/interviews/{id}/cancel` | Only before the interview starts |
| POST | `/interviews/{id}/retry-evaluation` | After scoring failed |
| GET | `/interviews/{id}/status` | Status, report status, remaining seconds, progress |
| GET | `/interviews/{id}/report` | Validated report |
| POST | `/interviews/{id}/feedback` | `{ "rating": 1-5, "comments" }` (upsert) |
| GET | `/interviews/{id}/recording-url` | 5-minute signed playback URL, only for the current recording |

### Events

Every event has `client_event_id` (8–64 chars `[A-Za-z0-9_-]`) and `event_type`:

| Type | Fields | Effect |
|---|---|---|
| `session_started` | | `connecting → in_progress`; sets `started_at` and `deadline_at` once |
| `question_asked` | `question_id` | `pending → asked` |
| `answer_submitted` | `question_id`, `answer_source` (voice/text), `transcript_text`, `exchange[]` | New attempt, selected for evaluation |
| `question_skipped` | `question_id` | Skipped attempt recorded, nothing selected |
| `answer_retake` | `question_id` | Only after an answer; next answer becomes a new attempt |
| `transcript_segment` | `speaker`, `text`, `question_id?` | Stored for the transcript |
| `paused` / `resumed` | | `in_progress ⇄ paused` |
| `connection_lost` / `reconnected` / `metric` | `reason?`, `metric_name`, `metric_value` | Recorded |

Duplicates (same `client_event_id`) are acknowledged with `duplicate: true` and not applied twice.

## Recordings

| Method | Path | Notes |
|---|---|---|
| POST | `/recordings/upload-url` | `{ interview_id, mime_type, size_bytes, duration_seconds }` → signed upload slot for a backend-chosen path |
| POST | `/recordings/confirm` | `{ upload_id }` → verifies size and type in storage, swaps the pointer, deletes the old file. Idempotent. |
| GET | `/recordings/latest` | Current recording metadata |
| DELETE | `/recordings/latest` | Deletes the file; reports and transcripts stay |
