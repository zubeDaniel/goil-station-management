-- One FINAL (non-preliminary) snapshot per report month in generated_reports.
--
-- WHY: the Reports route now freezes a few figures the first time a CLOSED month is generated
-- (dealer margin rate, creditor month-end balances, prices in the month) so old reports stop
-- changing when station_setup or later balances change. The write is "insert if none exists";
-- this partial unique index makes that safe if two people generate the same month at once
-- (the loser gets a 23505, which the route ignores).
--
-- SAFE TO RE-RUN. generated_reports has had no writers until now, so there is no existing data to
-- conflict; the DELETE below only matters if rows were inserted by hand.
--
-- To RE-FREEZE a month (e.g. after correcting a creditor balance), delete its row:
--   DELETE FROM public.generated_reports
--    WHERE report_month = '2026-09-01' AND is_preliminary = false;
-- and generate the report again.

CREATE UNIQUE INDEX IF NOT EXISTS generated_reports_one_final_per_month
    ON public.generated_reports (report_month)
    WHERE is_preliminary = false;
