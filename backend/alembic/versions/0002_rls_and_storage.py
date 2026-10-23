"""Row Level Security, auth.users link and private storage buckets.

The FastAPI backend connects as the table owner and enforces ownership in every
query. RLS is defence in depth: if anyone queries the database through
Supabase's Data API with a user token or the publishable key, they can only
read their own rows, and internal tables are not reachable at all.

The Supabase-specific parts (auth.users FK, storage buckets) only run when the
``auth`` / ``storage`` schemas exist, so the same migrations run on plain
Postgres for automated tests.

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

USER_TABLES = {
    # table: SQL expression proving ownership for auth.uid()
    "profiles": "id = auth.uid()",
    "documents": "user_id = auth.uid()",
    "interviews": "user_id = auth.uid()",
    "recordings": "user_id = auth.uid()",
    "feedback": "user_id = auth.uid()",
    "interview_plans": "exists (select 1 from interviews i where i.id = interview_id and i.user_id = auth.uid())",
    "questions": "exists (select 1 from interviews i where i.id = interview_id and i.user_id = auth.uid())",
    "interview_events": "exists (select 1 from interviews i where i.id = interview_id and i.user_id = auth.uid())",
    "reports": "exists (select 1 from interviews i where i.id = interview_id and i.user_id = auth.uid())",
    "answer_attempts": (
        "exists (select 1 from questions q join interviews i on i.id = q.interview_id "
        "where q.id = question_id and i.user_id = auth.uid())"
    ),
}
INTERNAL_TABLES = [
    "evaluation_jobs",
    "storage_cleanup_tasks",
    "recording_uploads",
    "ai_usage",
]

BUCKETS = [
    # (bucket id, size limit bytes, allowed mime types)
    (
        "interview-recordings",
        52428800,
        ["video/webm", "audio/webm", "video/mp4", "audio/mp4", "audio/ogg"],
    ),
    (
        "interview-documents",
        5242880,
        [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain",
        ],
    ),
]


def upgrade() -> None:
    for table in [*USER_TABLES, *INTERNAL_TABLES]:
        op.execute(f"alter table public.{table} enable row level security")

    # Policies reference auth.uid(), which only exists on Supabase.
    op.execute(
        """
        do $$
        begin
          if exists (select 1 from pg_namespace where nspname = 'auth') then
            execute 'alter table public.profiles
                       add constraint fk_profiles_auth_users
                       foreign key (id) references auth.users(id) on delete cascade';
          end if;
        end $$;
        """
    )
    for table, condition in USER_TABLES.items():
        sql_condition = condition.replace("'", "''")
        op.execute(
            f"""
            do $$
            begin
              if exists (select 1 from pg_namespace where nspname = 'auth') then
                execute 'create policy {table}_owner_select on public.{table}
                           for select to authenticated using ({sql_condition})';
              end if;
            end $$;
            """
        )
    op.execute(
        """
        do $$
        begin
          if exists (select 1 from pg_roles where rolname = 'anon') then
            execute 'revoke all on public.evaluation_jobs, public.storage_cleanup_tasks,
                     public.recording_uploads, public.ai_usage from anon, authenticated';
          end if;
        end $$;
        """
    )

    for bucket, limit, mimes in BUCKETS:
        mime_array = "array[" + ",".join(f"''{m}''" for m in mimes) + "]"
        op.execute(
            f"""
            do $$
            begin
              if exists (select 1 from pg_namespace where nspname = 'storage') then
                execute 'insert into storage.buckets
                           (id, name, public, file_size_limit, allowed_mime_types)
                         values (''{bucket}'', ''{bucket}'', false, {limit}, {mime_array})
                         on conflict (id) do update set public = false';
              end if;
            end $$;
            """
        )
    # No storage.objects policies are created on purpose: users never access
    # these buckets directly. Uploads use short-lived signed upload URLs and
    # playback uses short-lived signed URLs, both issued by the backend after
    # an ownership check.


def downgrade() -> None:
    for table in USER_TABLES:
        op.execute(
            f"""
            do $$
            begin
              if exists (select 1 from pg_namespace where nspname = 'auth') then
                execute 'drop policy if exists {table}_owner_select on public.{table}';
              end if;
            end $$;
            """
        )
    op.execute("alter table public.profiles drop constraint if exists fk_profiles_auth_users")
    for table in [*USER_TABLES, *INTERNAL_TABLES]:
        op.execute(f"alter table public.{table} disable row level security")
