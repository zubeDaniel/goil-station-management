-- Adds physical_cash_ghs (till-counted cash) to sales_book, and folds it
-- into total_sales_ghs / variance_ghs.
--
-- Why: sales_book previously had no field for physical cash at all — only
-- coupons, GoCard, MoMo, Merka Wood credit, genset, and lubricant. Per the
-- station's own physical ledger, cash is the single largest channel most
-- days (e.g. GHS 41,976 of a GHS 54,806 non-credit total on one sampled
-- day). With cash entirely absent from total_sales_ghs, variance_ghs
-- (total_sales_ghs - meter_amount_ghs) was short by roughly that day's
-- cash figure regardless of whether the day actually reconciled —
-- producing the large, persistent negative variances reported after the
-- first month live.
--
-- Postgres doesn't support altering a GENERATED ALWAYS AS expression in
-- place, so the two dependent generated columns are dropped and recreated
-- with the new formula rather than altered. Nothing else in this schema
-- references either column (checked against every migration file), so
-- this is safe to do directly.
BEGIN;

ALTER TABLE public.sales_book
  ADD COLUMN physical_cash_ghs numeric(12,2) DEFAULT 0 NOT NULL;

ALTER TABLE public.sales_book
  DROP COLUMN total_sales_ghs,
  DROP COLUMN variance_ghs;

ALTER TABLE public.sales_book
  ADD COLUMN total_sales_ghs numeric(12,2) GENERATED ALWAYS AS (
    coupons_ghs + gocard_ghs + momo_ghs + merka_wood_ghs + genset_ghs + lubricant_ghs + physical_cash_ghs
  ) STORED,
  ADD COLUMN variance_ghs numeric(12,2) GENERATED ALWAYS AS (
    (coupons_ghs + gocard_ghs + momo_ghs + merka_wood_ghs + genset_ghs + lubricant_ghs + physical_cash_ghs) - meter_amount_ghs
  ) STORED;

COMMENT ON COLUMN public.sales_book.physical_cash_ghs IS
  'Till-counted physical cash for the day. Distinct from coupons/GoCard/MoMo/credit — those are non-cash or already-recorded channels. Added because cash was previously untracked and total_sales_ghs undercounted revenue by roughly the day''s cash figure.';

COMMENT ON COLUMN public.sales_book.meter_amount_ghs IS
  'Server-derived cross-check total from pump_meter_readings for this date, net of RTT value (rtt_litres priced at the effective rate and subtracted) — see deriveMeterAmount() in server/routes/sales.js. Not a plain sum of amount_ghs.';

COMMIT;
