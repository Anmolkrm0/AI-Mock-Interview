"""Guest sessions, anonymous tracking, and conversion log.

Adds is_anonymous flag to profiles, is_guest flag to interviews, and
creates guest_conversions table for tracking guest -> registered conversions.

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "profiles",
        sa.Column("is_anonymous", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "interviews",
        sa.Column("is_guest", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.create_table(
        "guest_conversions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversion_type", sa.String(32), nullable=False),
        sa.Column("guest_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("registered_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.execute(
        """
        do $$
        begin
          if exists (select 1 from pg_namespace where nspname = 'auth') then
            execute 'alter table public.guest_conversions enable row level security';
          end if;
        end $$;
        """
    )


def downgrade() -> None:
    op.drop_table("guest_conversions")
    op.drop_column("interviews", "is_guest")
    op.drop_column("profiles", "is_anonymous")
