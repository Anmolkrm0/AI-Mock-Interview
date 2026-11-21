"""Keep anonymous results of guest interviews after the guest account is cleaned up.

Revision ID: 0006
Revises: 0005
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # No user id, documents, transcript or answers: only the outcome, so the numbers
    # survive the 48-hour guest clean-up without keeping anyone's personal data.
    op.create_table(
        "guest_interview_stats",
        sa.Column("interview_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("job_role", sa.String(200), nullable=False),
        sa.Column("duration_minutes", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("questions_total", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("questions_answered", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("overall_score", sa.Float(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_guest_interview_stats_created", "guest_interview_stats", ["created_at"], unique=False)
    op.execute(
        """
        do $$
        begin
          if exists (select 1 from pg_namespace where nspname = 'auth') then
            execute 'alter table public.guest_interview_stats enable row level security';
          end if;
        end $$;
        """
    )


def downgrade() -> None:
    op.drop_index("ix_guest_interview_stats_created", table_name="guest_interview_stats")
    op.drop_table("guest_interview_stats")
