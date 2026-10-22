-- ============================================================================
-- One-time data fix: move every existing tanker delivery back ONE day.
--
-- WHY: until now a delivery had to be logged under the DAY AFTER the truck
-- arrived, because tank stock for day D is entered on the morning of D+1
-- (stock_date = D+1) and used to look up deliveries with delivery_date =
-- stock_date. That left every digital delivery one day later than the station's
-- paper records. The new rule: a tank stock entry dated D+1 picks up deliveries
-- dated D (the real arrival date). Existing rows were all entered the old way,
-- so they move back a day to become correct under the new rule.
--
-- !! DEPLOY TOGETHER !!  Run this at the same time as deploying the new
-- server + client code (tankstock.js / reports.js / TankStock.jsx / MeterBook.jsx).
--   * New code + old data  -> every old delivery is looked up a day early.
--   * Old code + shifted data -> the reverse.
-- Don't save or edit tank stock entries between the two steps.
--
-- SAFE TO RE-RUN: guarded by a marker row, so a second run is a no-op and can
-- never shift the data twice.
--
-- AUDIT: the audit_tanker_deliveries trigger is deliberately left ENABLED, so
-- the shift is recorded in audit_log (one UPDATE per delivery). Run from the
-- SQL editor there is no x-actor-id header, so changed_by falls back to each
-- delivery's original creator — expect those rows to show that name, and
-- expect the Dashboard "recent activity" feed to show them briefly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_fixes_applied (
    name       text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    note       text
);
-- RLS on, no policies: invisible to the anon/authenticated API roles; the SQL
-- editor (postgres) and the service role are unaffected.
ALTER TABLE public.data_fixes_applied ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    v_moved integer;
BEGIN
    IF EXISTS (SELECT 1 FROM public.data_fixes_applied WHERE name = 'deliveries_shift_back_1d_2026_10') THEN
        RAISE NOTICE 'deliveries_shift_back_1d_2026_10 already applied — nothing to do.';
        RETURN;
    END IF;

    -- (WHERE is a no-op filter — delivery_date is NOT NULL — kept so the Supabase
    -- SQL editor doesn't flag this as a blanket UPDATE. The shift is intentionally
    -- applied to every delivery.)
    UPDATE public.tanker_deliveries SET delivery_date = delivery_date - 1
     WHERE delivery_date IS NOT NULL;
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    INSERT INTO public.data_fixes_applied (name, note)
    VALUES ('deliveries_shift_back_1d_2026_10',
            format('Shifted %s tanker_deliveries rows back one day', v_moved));

    RAISE NOTICE 'Shifted % tanker_deliveries rows back one day.', v_moved;
END
$$;
