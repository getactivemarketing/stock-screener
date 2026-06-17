-- Migration 014: Research screens — Screen 2 (Entry Analysis)
CREATE TABLE IF NOT EXISTS entry_plans (
  id                   SERIAL PRIMARY KEY,
  ticker               TEXT NOT NULL,
  desired_position_usd NUMERIC NOT NULL,
  plan                 JSONB NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staged','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_orders (
  id              SERIAL PRIMARY KEY,
  entry_plan_id   INTEGER NOT NULL REFERENCES entry_plans(id) ON DELETE CASCADE,
  tranche_n       INTEGER NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  alpaca_order_id TEXT,
  shares          NUMERIC NOT NULL,
  limit_price     NUMERIC NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entry_orders_plan ON entry_orders (entry_plan_id);
