"""Cashfree payments, credit ledger, and contact messages.

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. payment_orders
    op.create_table(
        "payment_orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("profiles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("package_code", sa.String(32), nullable=False),
        sa.Column("credits", sa.Integer(), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(3), server_default=sa.text("'INR'"), nullable=False),
        sa.Column("cf_order_id", sa.String(128), unique=True, nullable=False),
        sa.Column("cf_payment_id", sa.String(128), unique=True, nullable=True),
        sa.Column("status", sa.String(20), server_default=sa.text("'created'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status in ('created','paid','failed','expired')", name="ck_payment_orders_status"),
    )
    op.create_index(
        "ix_payment_orders_user_created",
        "payment_orders",
        ["user_id", "created_at"],
        unique=False,
    )

    # 2. credit_ledger
    op.create_table(
        "credit_ledger",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("profiles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column(
            "payment_order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("payment_orders.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "interview_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("interviews.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("profiles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "reason in ('purchase','interview_use','interview_refund','free_grant','admin_grant')",
            name="ck_credit_ledger_reason",
        ),
    )
    op.create_index(
        "ix_credit_ledger_user_created",
        "credit_ledger",
        ["user_id", "created_at"],
        unique=False,
    )
    # Unique constraint: a payment order credits at most once
    op.create_index(
        "uq_credit_ledger_payment_order",
        "credit_ledger",
        ["payment_order_id"],
        unique=True,
        postgresql_where=sa.text("payment_order_id IS NOT NULL"),
    )
    # Unique constraint: an interview is charged at most once
    op.create_index(
        "uq_credit_ledger_interview_use",
        "credit_ledger",
        ["interview_id"],
        unique=True,
        postgresql_where=sa.text("reason = 'interview_use'"),
    )
    # Unique constraint: an interview is refunded at most once
    op.create_index(
        "uq_credit_ledger_interview_refund",
        "credit_ledger",
        ["interview_id"],
        unique=True,
        postgresql_where=sa.text("reason = 'interview_refund'"),
    )
    # Unique constraint: a user gets at most one free_grant
    op.create_index(
        "uq_credit_ledger_user_free_grant",
        "credit_ledger",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("reason = 'free_grant'"),
    )

    # 3. contact_messages
    op.create_table(
        "contact_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("profiles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("handled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.create_index("ix_contact_messages_created", "contact_messages", ["created_at"], unique=False)
    op.create_index("ix_contact_messages_handled", "contact_messages", ["handled"], unique=False)

    # Enable RLS if Supabase auth schema exists
    op.execute(
        """
        do $$
        begin
          if exists (select 1 from pg_namespace where nspname = 'auth') then
            execute 'alter table public.payment_orders enable row level security';
            execute 'alter table public.credit_ledger enable row level security';
            execute 'alter table public.contact_messages enable row level security';

            -- Users can view their own payment orders
            execute 'create policy payment_orders_owner_select on public.payment_orders
                     for select using (auth.uid() = user_id)';

            -- Users can view their own credit ledger
            execute 'create policy credit_ledger_owner_select on public.credit_ledger
                     for select using (auth.uid() = user_id)';
          end if;
        end $$;
        """
    )

    # Grant 1 free credit to every existing non-anonymous profile
    op.execute(
        """
        INSERT INTO credit_ledger (id, user_id, delta, reason, note, created_at)
        SELECT gen_random_uuid(), id, 1, 'free_grant', 'Welcome free credit', now()
        FROM profiles
        WHERE is_anonymous = false
        ON CONFLICT DO NOTHING;
        """
    )


def downgrade() -> None:
    op.drop_table("contact_messages")
    op.drop_table("credit_ledger")
    op.drop_table("payment_orders")
