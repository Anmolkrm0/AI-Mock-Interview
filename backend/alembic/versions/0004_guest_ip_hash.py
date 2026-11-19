"""Add guest_ip_hash to interviews.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "interviews",
        sa.Column("guest_ip_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        op.f("ix_interviews_guest_ip_hash"),
        "interviews",
        ["guest_ip_hash"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_interviews_guest_ip_hash"), table_name="interviews")
    op.drop_column("interviews", "guest_ip_hash")
