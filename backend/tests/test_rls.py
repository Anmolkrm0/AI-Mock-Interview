"""Row Level Security test against a simulated Supabase database.

Creates the pieces of Supabase the migration depends on (``auth.uid()``,
``auth.users``, the ``anon``/``authenticated`` roles and ``storage.buckets``),
runs the real migrations, then queries as two different authenticated users.
On real Supabase these objects already exist.
"""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from tests.conftest import TEST_DB

RLS_DB = TEST_DB.rsplit("/", 1)[0] + "/mock_interview_rls_test"

SUPABASE_SHIM = """
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
grant usage on schema public to anon, authenticated;
-- Supabase grants table privileges to API roles by default when tables are created.
alter default privileges in schema public grant all on tables to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
"""


@pytest.fixture(scope="module")
def rls_db() -> str:
    base, _, name = RLS_DB.rpartition("/")
    admin = psycopg.connect(f"{base}/postgres", autocommit=True)
    admin.execute(f'drop database if exists "{name}" with (force)')
    admin.execute(f'create database "{name}"')
    admin.close()
    with psycopg.connect(RLS_DB, autocommit=True) as conn:
        conn.execute(SUPABASE_SHIM)

    from alembic import command
    from alembic.config import Config

    here = os.path.dirname(__file__)
    cfg = Config(os.path.join(here, "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(here, "..", "alembic"))
    cfg.attributes["database_url"] = RLS_DB.replace("postgresql://", "postgresql+psycopg://")
    command.upgrade(cfg, "head")
    return RLS_DB


def _seed(conn, user: uuid.UUID) -> uuid.UUID:
    interview = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (user,))
    conn.execute("insert into profiles (id) values (%s)", (user,))
    conn.execute(
        "insert into interviews (id, user_id, job_role, duration_minutes, evaluation_rigor, status, "
        "recording_mode, live_tokens_issued) values (%s, %s, 'Engineer', 20, 'standard', 'completed', 'none', 0)",
        (interview, user),
    )
    q = uuid.uuid4()
    conn.execute(
        "insert into questions (id, interview_id, sequence_number, question_text, competency, difficulty, "
        "question_type, priority, time_allocation_seconds, expected_evidence, follow_up_topics, status) "
        "values (%s, %s, 1, 'Q?', 'Coding', 3, 'technical', 'core', 120, '[]', '[]', 'answered')",
        (q, interview),
    )
    conn.execute(
        "insert into answer_attempts (question_id, attempt_number, answer_source, transcript_text, exchange, "
        "selected_for_evaluation, is_skipped) values (%s, 1, 'text', 'secret answer', '[]', true, false)",
        (q,),
    )
    conn.execute(
        "insert into reports (interview_id, report_status, competency_scores, question_evaluations, strengths, "
        "improvement_areas, recommendations, unevaluated_questions, model_info) "
        "values (%s, 'completed', '[]', '[]', '[]', '[]', '[]', '[]', '{}')",
        (interview,),
    )
    conn.execute(
        "insert into evaluation_jobs (interview_id, status, attempts) values (%s, 'succeeded', 1)",
        (interview,),
    )
    return interview


def _count_as(conn, role: str, user: uuid.UUID | None, table: str) -> int:
    with conn.transaction():
        conn.execute(f"set local role {role}")
        if user:
            conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user),))
        return conn.execute(f"select count(*) from {table}").fetchone()[0]


def test_users_only_see_their_own_rows(rls_db: str) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(rls_db, autocommit=True) as conn:
        _seed(conn, alice)
        _seed(conn, bob)
        for table in ("profiles", "interviews", "questions", "answer_attempts", "reports"):
            assert _count_as(conn, "authenticated", alice, table) == 1, table
            assert _count_as(conn, "authenticated", bob, table) == 1, table
            assert _count_as(conn, "anon", None, table) == 0, table


def test_internal_tables_not_exposed(rls_db: str) -> None:
    with psycopg.connect(rls_db, autocommit=True) as conn:
        for table in ("evaluation_jobs", "recording_uploads", "ai_usage", "storage_cleanup_tasks"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                _count_as(conn, "authenticated", uuid.uuid4(), table)


def test_private_buckets_created(rls_db: str) -> None:
    with psycopg.connect(rls_db) as conn:
        rows = conn.execute("select id, public, file_size_limit from storage.buckets order by id").fetchall()
    assert rows == [("interview-documents", False, 5242880), ("interview-recordings", False, 52428800)]


def test_deleting_auth_user_cascades(rls_db: str) -> None:
    user = uuid.uuid4()
    with psycopg.connect(rls_db, autocommit=True) as conn:
        interview = _seed(conn, user)
        conn.execute("delete from auth.users where id = %s", (user,))
        assert conn.execute("select count(*) from interviews where id = %s", (interview,)).fetchone()[0] == 0
