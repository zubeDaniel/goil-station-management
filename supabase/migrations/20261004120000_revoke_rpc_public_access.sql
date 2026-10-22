-- Lock the six creditor money functions to the server (service_role) only.
--
-- These are SECURITY DEFINER and were granted EXECUTE to anon/authenticated
-- with no caller check inside, so anyone holding the public anon key could
-- call them directly through PostgREST and bypass the Express role checks.
-- The Express server uses the service-role key, which is unaffected, and the
-- browser never calls these functions.
--
-- Verify before/after with:
--   curl -s -X POST "https://<project>.supabase.co/rest/v1/rpc/reverse_credit_sale" \
--     -H "apikey: <ANON KEY>" -H "Authorization: Bearer <ANON KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"p_id":"00000000-0000-0000-0000-000000000000"}'
--   Vulnerable: "not found or already reversed"   Fixed: "permission denied for function"
--
-- Safe to re-run.

REVOKE EXECUTE ON FUNCTION public.record_credit_sale(date, uuid, numeric, numeric, numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_creditor_payment(date, uuid, numeric, text, text, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_credit_sale(uuid)                                                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_creditor_payment(uuid)                                           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.edit_credit_sale(uuid, date, numeric, numeric, numeric, numeric, uuid)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.edit_creditor_payment(uuid, date, numeric, text, text, uuid)             FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_credit_sale(date, uuid, numeric, numeric, numeric, numeric, uuid)  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_creditor_payment(date, uuid, numeric, text, text, uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_credit_sale(uuid)                                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_creditor_payment(uuid)                                            TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_credit_sale(uuid, date, numeric, numeric, numeric, numeric, uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_creditor_payment(uuid, date, numeric, text, text, uuid)              TO service_role;
