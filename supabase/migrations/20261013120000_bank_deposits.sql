-- ============================================================================
-- Multiple NIB / UMB deposits per day.
--
-- DESIGN: `banking` keeps ONE row per day (the unique entry_date constraint and
-- every downstream reader — Dashboard KPI, report Section 5 total_banked,
-- Section 12 banking health, variance_vs_sales — keep working unchanged).
-- banking.nib_ghs / banking.umb_momo_ghs stay as stored daily totals, but they
-- are now WRITTEN ONLY by save_banking_entry() below, as the sum of that day's
-- rows in bank_deposits, so the two can never disagree.
--
-- bank_deposits holds one row per physical deposit slip (NIB or UMB only).
-- GoCard and coupon fields are unchanged (single value per day).
--
-- SAFE TO RE-RUN: every statement is idempotent.
-- ORDER: apply this BEFORE deploying the new server/client code. (The new code
-- tolerates the table being absent, but entries saved before it exists can't
-- hold multiple deposits.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bank_deposits (
    id          uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    banking_id  uuid        NOT NULL REFERENCES public.banking(id) ON DELETE CASCADE,
    bank        text        NOT NULL CHECK (bank IN ('NIB', 'UMB')),
    seq         integer     NOT NULL CHECK (seq >= 1),
    amount_ghs  numeric(12,2) NOT NULL CHECK (amount_ghs > 0),
    slip_ref    text CHECK (slip_ref IS NULL OR char_length(slip_ref) <= 60),
    created_by  uuid        REFERENCES public.users(id),
    created_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT bank_deposits_banking_bank_seq_key UNIQUE (banking_id, bank, seq)
);

-- ── Backfill: every existing day's NIB / UMB figure becomes deposit #1 ───────
-- Done BEFORE the audit trigger is attached below, on purpose: this is a
-- re-representation of existing data, not a user action, and shouldn't flood
-- audit_log (or the Dashboard activity feed) with hundreds of INSERT rows.
INSERT INTO public.bank_deposits (banking_id, bank, seq, amount_ghs, created_by)
SELECT id, 'NIB', 1, nib_ghs, created_by FROM public.banking WHERE nib_ghs > 0
ON CONFLICT (banking_id, bank, seq) DO NOTHING;

INSERT INTO public.bank_deposits (banking_id, bank, seq, amount_ghs, created_by)
SELECT id, 'UMB', 1, umb_momo_ghs, created_by FROM public.banking WHERE umb_momo_ghs > 0
ON CONFLICT (banking_id, bank, seq) DO NOTHING;

-- ── Audit trail (same trigger every other operational table uses) ────────────
CREATE OR REPLACE TRIGGER audit_bank_deposits
    AFTER INSERT OR DELETE OR UPDATE ON public.bank_deposits
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger();

-- ── RLS: mirrors the banking table's policies ────────────────────────────────
ALTER TABLE public.bank_deposits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_deposits_select       ON public.bank_deposits;
DROP POLICY IF EXISTS bank_deposits_insert       ON public.bank_deposits;
DROP POLICY IF EXISTS bank_deposits_update       ON public.bank_deposits;
DROP POLICY IF EXISTS bank_deposits_delete_admin ON public.bank_deposits;

CREATE POLICY bank_deposits_select ON public.bank_deposits FOR SELECT
    USING (public.get_user_role() = ANY (ARRAY['admin'::public.user_role, 'manager'::public.user_role]));
CREATE POLICY bank_deposits_insert ON public.bank_deposits FOR INSERT
    WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::public.user_role, 'manager'::public.user_role]));
CREATE POLICY bank_deposits_update ON public.bank_deposits FOR UPDATE
    USING (public.get_user_role() = ANY (ARRAY['admin'::public.user_role, 'manager'::public.user_role]));
CREATE POLICY bank_deposits_delete_admin ON public.bank_deposits FOR DELETE
    USING (public.get_user_role() = 'admin'::public.user_role);

GRANT ALL ON TABLE public.bank_deposits TO anon;
GRANT ALL ON TABLE public.bank_deposits TO authenticated;
GRANT ALL ON TABLE public.bank_deposits TO service_role;

-- ── Atomic save: banking row + all its deposits in ONE transaction ───────────
-- supabase-js can't span a transaction across two table writes; a failure
-- between "write the day" and "write its deposits" would leave a day whose
-- stored NIB total disagrees with its deposits. This function does both.
--
--   p_id          NULL = create a new day (p_entry_date required);
--                 otherwise edit that day (its entry_date is looked up from the
--                 row, never trusted from the caller — same rule banking.js
--                 already followed).
--   p_nib/p_umb   jsonb arrays: [{"amount_ghs": 7000, "slip_ref": "A123"}, ...]
--                 Blank / zero amounts are dropped; the rest are renumbered 1..n.
--   nib_ghs / umb_momo_ghs / variance_vs_sales are DERIVED here, not passed in.
--
-- Unique-date clash raises SQLSTATE 23505 (banking.js maps it to HTTP 409).
-- Unchanged deposit sets are left alone (no delete/re-insert), so re-saving an
-- entry without touching its deposits doesn't churn audit_log.
CREATE OR REPLACE FUNCTION public.save_banking_entry(
    p_id          uuid,
    p_entry_date  date,
    p_nib         jsonb,
    p_umb         jsonb,
    p_gocard      numeric,
    p_coupons_50  numeric,
    p_coupons_100 numeric,
    p_actor       uuid
) RETURNS SETOF public.banking
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_row        public.banking;
    v_date       date;
    v_new        jsonb;
    v_old        jsonb;
    v_nib_total  numeric(12,2);
    v_umb_total  numeric(12,2);
    v_total      numeric(12,2);
    v_sales      numeric;
BEGIN
    IF p_id IS NULL THEN
        IF p_entry_date IS NULL THEN
            RAISE EXCEPTION 'entry_date is required';
        END IF;
        v_date := p_entry_date;
    ELSE
        SELECT entry_date INTO v_date FROM public.banking WHERE id = p_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Banking entry % not found', p_id USING ERRCODE = 'P0002';
        END IF;
    END IF;

    -- Normalise both deposit arrays into one list: drop blank/zero, round to 2dp,
    -- renumber seq 1..n per bank in the order the caller sent them.
    WITH raw AS (
        SELECT 'NIB'::text AS bank, ord, e
          FROM jsonb_array_elements(COALESCE(p_nib, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
        UNION ALL
        SELECT 'UMB'::text, ord, e
          FROM jsonb_array_elements(COALESCE(p_umb, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
    ), clean AS (
        SELECT bank, ord,
               round(NULLIF(btrim(e->>'amount_ghs'), '')::numeric, 2)  AS amount,
               NULLIF(btrim(e->>'slip_ref'), '')      AS slip_ref
          FROM raw
    ), numbered AS (
        SELECT bank,
               (row_number() OVER (PARTITION BY bank ORDER BY ord))::int AS seq,
               amount, slip_ref
          FROM clean
         WHERE amount > 0
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'bank', bank, 'seq', seq, 'amount_ghs', amount, 'slip_ref', slip_ref
           ) ORDER BY bank, seq), '[]'::jsonb),
           COALESCE(sum(amount) FILTER (WHERE bank = 'NIB'), 0),
           COALESCE(sum(amount) FILTER (WHERE bank = 'UMB'), 0)
      INTO v_new, v_nib_total, v_umb_total
      FROM numbered;

    v_total := v_nib_total + v_umb_total
             + COALESCE(p_gocard, 0) + COALESCE(p_coupons_50, 0) + COALESCE(p_coupons_100, 0);

    -- Same definition banking.js used: banked total minus that day's Sales Book total.
    SELECT total_sales_ghs INTO v_sales FROM public.sales_book WHERE entry_date = v_date;

    IF p_id IS NULL THEN
        INSERT INTO public.banking (
            entry_date, nib_ghs, umb_momo_ghs, gocard_ghs,
            coupons_50_ghs, coupons_100_ghs, variance_vs_sales, created_by
        ) VALUES (
            v_date, v_nib_total, v_umb_total, COALESCE(p_gocard, 0),
            COALESCE(p_coupons_50, 0), COALESCE(p_coupons_100, 0),
            v_total - COALESCE(v_sales, 0), p_actor
        ) RETURNING * INTO v_row;
    ELSE
        UPDATE public.banking SET
            nib_ghs           = v_nib_total,
            umb_momo_ghs      = v_umb_total,
            gocard_ghs        = COALESCE(p_gocard, 0),
            coupons_50_ghs    = COALESCE(p_coupons_50, 0),
            coupons_100_ghs   = COALESCE(p_coupons_100, 0),
            variance_vs_sales = v_total - COALESCE(v_sales, 0)
         WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'bank', bank, 'seq', seq, 'amount_ghs', amount_ghs, 'slip_ref', slip_ref
           ) ORDER BY bank, seq), '[]'::jsonb)
      INTO v_old
      FROM public.bank_deposits WHERE banking_id = v_row.id;

    IF v_old IS DISTINCT FROM v_new THEN
        DELETE FROM public.bank_deposits WHERE banking_id = v_row.id;
        INSERT INTO public.bank_deposits (banking_id, bank, seq, amount_ghs, slip_ref, created_by)
        SELECT v_row.id, d->>'bank', (d->>'seq')::int, (d->>'amount_ghs')::numeric, d->>'slip_ref', p_actor
          FROM jsonb_array_elements(v_new) AS d;
    END IF;

    RETURN NEXT v_row;
    RETURN;
END;
$$;

-- Same lock-down as the six creditor money functions (see
-- revoke-rpc-public-access.sql): SECURITY DEFINER + the public anon key means
-- anyone could call this straight through PostgREST, skipping the Express role
-- checks. Only the server (service role) may execute it.
REVOKE ALL     ON FUNCTION public.save_banking_entry(uuid, date, jsonb, jsonb, numeric, numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE  ON FUNCTION public.save_banking_entry(uuid, date, jsonb, jsonb, numeric, numeric, numeric, uuid) TO service_role;
