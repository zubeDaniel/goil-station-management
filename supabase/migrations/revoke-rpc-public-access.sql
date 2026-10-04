-- ============================================================================
-- Lock the six creditor money functions to the server only.
--
-- WHY: these functions are SECURITY DEFINER (they bypass row-level security)
-- and, in the 2026-07-22 schema dump, are granted EXECUTE to `anon` and
-- `authenticated` with no check inside them of who is calling. The Supabase
-- anon key is public by design (it ships in the website's JavaScript), so
-- anyone holding it could call them directly at
--   POST https://<project>.supabase.co/rest/v1/rpc/<function_name>
-- skipping the Express server and its admin/manager checks. They'd need real
-- row UUIDs to do damage, which limits it, but a former manager who once
-- saw those IDs in the browser's network tab is a realistic case.
--
-- SAFE FOR THE APP: the Express server calls these with the SERVICE ROLE key,
-- which is unaffected by this revoke, and the browser never calls them (it
-- only uses supabase-js for login).
--
-- DO NOT run this blind. Steps:
--   1. BEFORE: confirm the problem is real on production (see the curl at the
--      bottom). If it already returns "permission denied", the live database
--      differs from the dump and you don't need this file.
--   2. Run this script in the Supabase SQL editor.
--   3. AFTER: re-run the curl (must now be denied), then record a test credit
--      sale and a test payment from the app to confirm it still works.
--   To undo, run the GRANT block at the very bottom.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.record_credit_sale(date, uuid, numeric, numeric, numeric, numeric, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_creditor_payment(date, uuid, numeric, text, text, uuid)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_credit_sale(uuid)                                                      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_creditor_payment(uuid)                                                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.edit_credit_sale(uuid, date, numeric, numeric, numeric, numeric, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.edit_creditor_payment(uuid, date, numeric, text, text, uuid)                   FROM PUBLIC, anon, authenticated;

-- (service_role keeps EXECUTE; re-assert it explicitly so this is safe to re-run)
GRANT EXECUTE ON FUNCTION public.record_credit_sale(date, uuid, numeric, numeric, numeric, numeric, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.record_creditor_payment(date, uuid, numeric, text, text, uuid)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_credit_sale(uuid)                                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_creditor_payment(uuid)                                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_credit_sale(uuid, date, numeric, numeric, numeric, numeric, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_creditor_payment(uuid, date, numeric, text, text, uuid)                    TO service_role;

-- ---------------------------------------------------------------------------
-- Test (run from your own terminal, NOT in the SQL editor). Uses a made-up UUID
-- so it can't change anything either way:
--   curl -s -X POST "https://<project>.supabase.co/rest/v1/rpc/reverse_credit_sale" \
--     -H "apikey: <ANON KEY>" -H "Authorization: Bearer <ANON KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"p_id":"00000000-0000-0000-0000-000000000000"}'
--
--   Vulnerable:  error mentioning "not found or already reversed"  (it RAN)
--   Fixed:       error mentioning "permission denied for function"
--
-- Undo (only if something breaks):
--   GRANT EXECUTE ON FUNCTION public.record_credit_sale(date, uuid, numeric, numeric, numeric, numeric, uuid) TO anon, authenticated;
--   ...and likewise for the other five.
-- ---------------------------------------------------------------------------
