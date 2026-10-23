# Beta launch plan

You're sharing this with real people to learn whether it helps them prepare. This page is the product side: who it's for, what to measure, how to read feedback, and what to change first.

## Who the beta is for

Job seekers preparing for a specific role who have a job description in hand: students and early-career candidates for campus and lateral roles, and experienced people switching roles. Start with 15–30 people you can talk to (classmates, colleagues, a placement cell, a community you're part of). A small group you can follow up with teaches more than a large anonymous one.

## What to tell beta users

> I built a mock-interview tool and I'd value your honest feedback. You upload your resume and a real job description, and an AI interviewer asks you role-specific questions out loud for 10–45 minutes, then scores each answer and shows which lines earned the score. It works best in Chrome with headphones. There's a limit of a few interviews a day per person because it runs on free AI quota. Your recordings and transcripts are private to your account, and you can delete your recording any time. At the end of each report there's a short rating box: please use it.

## The questions this beta should answer

1. **Do people finish?** If many drop out mid-interview, the live experience (latency, interruptions, question quality) is the problem to fix first.
2. **Do they trust the score?** Low ratings with comments like "the score felt random" point at the evaluation prompt or model choice.
3. **Do they come back?** A second interview within a week is the strongest signal that it's useful.

## Metrics and how to read them

Run these in Supabase → SQL Editor.

**Funnel (last 30 days)**

```sql
select
  count(*) filter (where status <> 'cancelled')                       as created,
  count(*) filter (where started_at is not null)                       as started,
  count(*) filter (where status = 'completed')                         as completed,
  round(100.0 * count(*) filter (where status = 'completed')
        / nullif(count(*) filter (where started_at is not null), 0), 1) as completion_rate_pct
from interviews
where created_at > now() - interval '30 days';
```

**Ratings and comments (read every comment)**

```sql
select f.rating, f.comments, i.job_role, i.evaluation_rigor, i.duration_minutes, r.overall_score, f.created_at
from feedback f
join interviews i on i.id = f.interview_id
left join reports r on r.interview_id = i.id
order by f.created_at desc;
```

**Returning users**

```sql
select count(*) filter (where n >= 2) as returning_users, count(*) as users_with_interviews
from (select user_id, count(*) n from interviews where status = 'completed' group by user_id) t;
```

**Live experience quality** (time to first interviewer audio, connection failures)

```sql
select
  percentile_cont(0.5) within group (order by (event_payload->>'value')::float) filter (where event_payload->>'metric' = 'time_to_first_response_ms') as median_first_response_ms,
  count(*) filter (where event_payload->>'metric' = 'live_connection_failed') as failed_connections,
  count(*) filter (where event_type = 'connection_lost') as dropped_connections,
  count(*) filter (where event_payload->>'metric' = 'recording_upload_failed') as failed_uploads
from interview_events
where created_at > now() - interval '7 days';
```

**AI quota use and failures**

```sql
select operation, model, count(*) calls,
       count(*) filter (where not success) failures,
       round(avg(latency_ms)) avg_ms, sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)) tokens
from ai_usage
where created_at > now() - interval '1 day'
group by 1, 2 order by calls desc;
```

Rough targets for a useful beta: completion rate above 60%, average rating 4+, a quarter of users returning within a week, median first response under 2 seconds.

## Feedback loop

- Read every comment weekly. Tag each one: question quality, interviewer behaviour, scoring fairness, technical problem, UX.
- Message the three lowest-rated users and ask what happened. Ask to watch someone use it once.
- Change one thing at a time, then compare the next week's numbers.

## Likely first improvements

- If AI quota runs out often: enable billing on the Gemini project, or raise `DAILY_INTERVIEW_LIMIT` only after you have paid quota.
- If scores feel generous or harsh: switch `GEMINI_EVALUATION_MODEL` to a Flash model (paid quota) and compare on the same transcripts.
- If people want to practise more often: add shorter "single question drill" sessions.

## Privacy and data

Tell users plainly: audio is processed by Google Gemini to run the interview; transcripts and reports are stored in your database; only the latest recording per person is kept; uploaded documents' raw text and files are deleted after 30 days (`DOCUMENT_RETENTION_DAYS`). If someone asks to delete their account, delete the user in Supabase → Authentication; their profile, interviews, reports and feedback are removed by cascade, and you should also delete their folder in both storage buckets.
