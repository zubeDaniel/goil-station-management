-- Supports intra-day NPA price changes (e.g. 16/09/2026, price revised
-- ~11:30am mid-shift). Previously fuel_prices had one row per
-- (fuel_type, effective_date) and pump_meter_readings had one row per
-- (reading_date, pump_id, fuel_type) — both assumptions break the moment
-- a price changes partway through a day, because there is no way to
-- record "sold before the change" separately from "sold after the
-- change" at the correct respective price. Until now this was
-- reconciled by hand on paper.
--
-- fuel_prices gains effective_time (default '00:00:00', so every
-- existing historical row — all day-start prices — is unaffected and
-- keeps sorting/resolving exactly as before). A same-day price change
-- is a second row with the same effective_date and a later
-- effective_time, not an overwrite of the first.
--
-- pump_meter_readings gains session_number (1 or 2, default 1 — a
-- normal day is still exactly one row, unaffected) and session_time
-- (nullable; set on session 2 to the changeover time, used to resolve
-- which fuel_prices row applies to that session's litres).
--
-- Both tables' unique constraints are widened accordingly so a split
-- day can hold two rows instead of raising a duplicate-key conflict.
BEGIN;

-- ── fuel_prices ─────────────────────────────────────────────
ALTER TABLE public.fuel_prices
  ADD COLUMN effective_time time NOT NULL DEFAULT '00:00:00';

ALTER TABLE public.fuel_prices
  DROP CONSTRAINT fuel_prices_fuel_type_effective_date_key;

ALTER TABLE public.fuel_prices
  ADD CONSTRAINT fuel_prices_fuel_type_effective_date_time_key
    UNIQUE (fuel_type, effective_date, effective_time);

COMMENT ON COLUMN public.fuel_prices.effective_time IS
  'Time within effective_date this price takes effect. Defaults to 00:00:00 for ordinary day-start prices. A same-day mid-shift change is a second row for the same effective_date with a later effective_time — never an overwrite of the day-start row. Resolved alongside effective_date in server/routes/meter.js and GET /api/prices/current.';

-- ── pump_meter_readings ─────────────────────────────────────
ALTER TABLE public.pump_meter_readings
  ADD COLUMN session_number smallint NOT NULL DEFAULT 1,
  ADD COLUMN session_time time;

ALTER TABLE public.pump_meter_readings
  ADD CONSTRAINT pump_meter_readings_session_number_check
    CHECK (session_number IN (1, 2));

ALTER TABLE public.pump_meter_readings
  ADD CONSTRAINT pump_meter_readings_session2_requires_time_check
    CHECK (session_number = 1 OR session_time IS NOT NULL);

ALTER TABLE public.pump_meter_readings
  DROP CONSTRAINT pump_meter_readings_reading_date_pump_id_fuel_type_key;

ALTER TABLE public.pump_meter_readings
  ADD CONSTRAINT pump_meter_readings_reading_date_pump_id_fuel_type_session_key
    UNIQUE (reading_date, pump_id, fuel_type, session_number);

COMMENT ON COLUMN public.pump_meter_readings.session_number IS
  'Always 1 for an ordinary single-price day. 2 exists only on a day the pump was split for a mid-shift price change — its opening_meter equals session 1''s closing_meter for the same pump/fuel/date, and its amount_ghs is priced from the fuel_prices row whose effective_date/effective_time matches session_time, not day-start.';

COMMENT ON COLUMN public.pump_meter_readings.session_time IS
  'The changeover time entered on the Meter Book "Price changed today?" panel. Set on BOTH rows of a split day — session 1 AND session 2 — not session 2 alone: session 1''s own price re-resolves against this same boundary (exclusive) on every future edit, and without it stored there too, an edit would silently re-price session 1 at the day''s later rate. NULL only on an ordinary (session_number = 1, no split) day. Used at write time to resolve the applicable fuel_prices row — see server/routes/meter.js.';

COMMIT;
