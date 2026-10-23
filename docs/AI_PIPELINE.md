# AI pipeline

Providers sit behind three interfaces in `backend/app/providers/base.py`: `TextGenerationProvider`, `EvaluationProvider`, `LiveInterviewProvider`. Selection is by environment variable (`TEXT_AI_PROVIDER`, `EVALUATION_AI_PROVIDER`, `LIVE_AI_PROVIDER`). Nothing switches provider or model automatically; when quota runs out the user sees a clear message.

## Models (verified against Google's model list, October 2026)

| Use | Default | Why |
|---|---|---|
| Live voice interviewer | `gemini-3.8-live` | Stable Live model; used with ephemeral tokens |
| Parsing, planning | `gemini-3.5-flash-lite` | Stable; far larger free daily quota than Flash (Flash's free tier was reported at ~20 requests/day) |
| Scoring | `gemini-3.5-flash-lite` | Same; switch `GEMINI_EVALUATION_MODEL` to a Flash model if you have paid quota and want stronger judgement |

Check current IDs at https://ai.google.dev/gemini-api/docs/models and your quotas at https://aistudio.google.com/rate-limit.

## Calls per interview

| Step | Calls |
|---|---|
| Resume parse | 1 (skipped if the same file was parsed in the last 7 days) |
| Job description parse | 1 |
| Plan | 1 |
| Live session | 1 token + 1 Live session (more tokens on reconnect) |
| Scoring | 1 (more only on retries) |

All calls are logged in `ai_usage` (tokens, latency, success, error code).

## Structured output and validation

Gemini text calls send `responseMimeType: application/json` and a `responseJsonSchema` generated from the Pydantic model (refs inlined). If a model rejects the schema form, the call retries once with the schema in the prompt. Every response is parsed and validated with Pydantic; invalid output is retried (bounded) with a short note listing the validation errors. Transient errors (timeout, 429 rate limit, 5xx, empty/malformed output) back off exponentially; quota exhaustion, bad keys and unknown models fail fast.

Document and transcript text is wrapped in labelled delimiters with an instruction to treat it as data.

## Planning

`question_budget()` derives the number of questions from duration and rigor (deeper probing → fewer, longer questions): e.g. 10 min Standard → 3 core, 45 min Stress test → 12 core, plus ~25% optional questions. Allocations are rescaled to fill the available time. Duplicate questions are removed; competency weights are normalized and any competency used by a question but missing from the weights is added.

## Live interviewer

The system instruction is built on the server for every token: role, rigor style, objectives, a compact candidate profile, the ordered plan with each question's status, and the remaining time. On reconnect it says the interview is resuming at question N, so the model doesn't re-introduce itself or repeat questions. Rigor changes the interviewer's style and follow-up depth, never the scoring rubric.

## Scoring

1. Gather the selected attempt per question (policy: the latest non-skipped attempt; abandoning a retake keeps the previous answer).
2. Skipped and unanswered questions are excluded from the score and listed as "Not scored".
3. The model returns, per answered question: a 1–5 score on the fixed rubric, rationale, up to 4 verbatim evidence quotes, gaps, a stronger-answer outline (for scores ≤ 3) and its confidence. It's told to ignore accent, appearance, speaking style and personality.
4. Each quote is checked against the actual transcript; quotes not found word-for-word are flagged in the report as interpretation, not evidence.
5. Code (not the model) computes competency scores (mean rubric → 0–100) and the overall score (competency weights from the plan, renormalized over competencies that have evidence).
6. Evidence sufficiency: `sufficient` (≥3 answers and ≥60% of core questions), `limited` (≥2), else `insufficient`. With no answers there is no score.

Rubric: 1 insufficient or incorrect, 2 significant gaps, 3 competent but incomplete, 4 strong and well-supported, 5 excellent, detailed and role-relevant.
