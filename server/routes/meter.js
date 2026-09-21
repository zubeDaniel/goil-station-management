const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOnly, adminOrManager, allRoles } = require('../middleware/auth');

// ── Session-aware price resolution ──────────────────────────────
// Ordinary day: session_number = 1, session_time = null. Behaves exactly
// as before this migration — picks the latest fuel_prices row effective
// on or before reading_date (day granularity only), which in practice
// means "today's price if one exists, else the most recent prior one".
//
// Split day (a mid-shift NPA price change — see
// 20260918120000_intraday_price_sessions.sql): the client sends the same
// session_time (the changeover clock time) on BOTH halves of the day.
//   - session_number 1 with session_time set: this half covers UP TO the
//     changeover, so its price must be resolved STRICTLY BEFORE
//     session_time — otherwise it would silently pick up the very price
//     it's supposed to predate.
//   - session_number 2 (session_time required): this half covers FROM
//     the changeover onward, so its price must be resolved AT OR AFTER
//     session_time — inclusive, since the new price is in effect from
//     that instant.
//
// `rows` must already be pre-sorted effective_date desc, effective_time
// desc, created_at desc (see the two call sites below) — that ordering
// is what lets a single linear scan return the correct row without a
// second query.
// Accepts 'HH:MM' or 'HH:MM:SS', 24-hour. Used to reject a malformed
// session_time before it's either (a) compared as a string in
// resolveEffectivePrice — a non-conforming string sorts unpredictably
// against real 'HH:MM:SS' values with no error at all — or (b) sent to
// Postgres, which would reject it, but as a raw 500 rather than a clean
// validation error.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function normaliseTime(t) {
  if (!t) return null;
  // Accept 'HH:MM' or 'HH:MM:SS' from the client; Postgres always returns
  // 'HH:MM:SS' for a time column, so pad the short form to match before
  // any string comparison.
  return t.length === 5 ? `${t}:00` : t;
}

function resolveEffectivePrice(rows, readingDate, boundaryTime, inclusive) {
  const boundary = boundaryTime || '23:59:59';
  for (const row of rows) {
    if (row.effective_date !== readingDate) {
      // Already filtered to effective_date <= readingDate and sorted
      // desc, so the first row that isn't today is the most recent
      // *prior* day's price — always before any same-day boundary.
      return row;
    }
    const rowTime = row.effective_time || '00:00:00';
    const isBeforeBoundary = inclusive ? rowTime <= boundary : rowTime < boundary;
    if (isBeforeBoundary) return row;
    // Same-day row at/after the boundary (i.e. the mid-shift change
    // itself, when resolving session 1) — not applicable here, keep
    // scanning toward earlier same-day or prior-day rows.
  }
  return null;
}

async function fetchPriceRows(supabaseAdmin, fuel_type, reading_date) {
  const { data } = await supabaseAdmin
    .from('fuel_prices')
    .select('price_per_litre, effective_date, effective_time, created_at')
    .eq('fuel_type', fuel_type)
    .lte('effective_date', reading_date)
    .order('effective_date', { ascending: false })
    .order('effective_time', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);
  return data || [];
}

// session_number/session_time validation shared by POST and PUT.
// Returns an error string, or null if valid.
function validateSession(session_number, session_time) {
  if (session_time !== undefined && session_time !== null && session_time !== '' && !TIME_RE.test(session_time)) {
    return 'session_time must be in HH:MM or HH:MM:SS 24-hour format';
  }
  if (session_number === undefined || session_number === null) return null;
  const n = Number(session_number);
  if (![1, 2].includes(n)) return 'session_number must be 1 or 2';
  if (n === 2 && !session_time) {
    return 'session_time is required when session_number is 2 (the price-change time for a split day)';
  }
  return null;
}

// GET /api/meter
router.get('/', authenticate, allRoles, async (req, res) => {
  try {
    const { start_date, end_date, pump_id } = req.query;
    let query = req.supabaseAdmin
      .from('pump_meter_readings')
      .select('*, attendants(name)')
      .order('reading_date', { ascending: false })
      .order('session_number', { ascending: true });

    if (start_date) query = query.gte('reading_date', start_date);
    if (end_date) query = query.lte('reading_date', end_date);
    if (pump_id) query = query.eq('pump_id', pump_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch meter readings' });
  }
});

// POST /api/meter
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const {
      reading_date, pump_id, fuel_type,
      attendant_id, opening_meter, closing_meter,
      rtt_litres, session_number, session_time
    } = req.body;

    if (!reading_date || !pump_id || !fuel_type || closing_meter === undefined) {
      return res.status(400).json({ error: 'reading_date, pump_id, fuel_type, and closing_meter are required' });
    }

    if (!Number.isFinite(Number(closing_meter)) || !Number.isFinite(Number(opening_meter))) {
      return res.status(400).json({ error: 'opening_meter and closing_meter must be valid numbers' });
    }
    if (closing_meter < opening_meter) {
      return res.status(400).json({ error: 'Closing meter cannot be less than opening meter' });
    }
    if (reading_date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'reading_date cannot be in the future' });
    }

    const sessionError = validateSession(session_number, session_time);
    if (sessionError) return res.status(400).json({ error: sessionError });

    const sessionNum = session_number ? Number(session_number) : 1;
    const sessionTime = normaliseTime(session_time);

    const litres_sold = parseFloat(closing_meter) - parseFloat(opening_meter || 0);

    // Effective price for this fuel type as of reading_date (and, on a
    // split day, as of the specific session) — not "current" price.
    const priceRows = await fetchPriceRows(req.supabaseAdmin, fuel_type, reading_date);
    const priceRow = resolveEffectivePrice(
      priceRows,
      reading_date,
      sessionTime,
      sessionNum !== 1 || !sessionTime // session 2 (or ordinary day, sessionTime null) is inclusive; split-day session 1 is exclusive
    );

    const amount_ghs = litres_sold * (parseFloat(priceRow?.price_per_litre) || 0);

    const { data, error } = await req.supabaseAdmin
      .from('pump_meter_readings')
      .insert({
        reading_date, pump_id, fuel_type,
        attendant_id, opening_meter, closing_meter,
        amount_ghs,
        rtt_litres: rtt_litres || 0,
        session_number: sessionNum,
        session_time: sessionTime,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        const sessionNote = sessionNum === 2 ? ' (session 2)' : sessionNum === 1 && sessionTime ? ' (session 1)' : '';
        return res.status(409).json({ error: `A meter reading for ${pump_id} ${fuel_type} on ${reading_date}${sessionNote} already exists — edit that entry instead of creating a new one.` });
      }
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save meter reading' });
  }
});

// PUT /api/meter/:id
router.put('/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { closing_meter, attendant_id, rtt_litres } = req.body;

    const { data: existing, error: fetchError } = await req.supabaseAdmin
      .from('pump_meter_readings')
      .select('reading_date, fuel_type, opening_meter, closing_meter, session_number, session_time')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Meter reading not found' });
    }

    const finalClosing = closing_meter !== undefined ? closing_meter : existing.closing_meter;

    // Same validation POST already has, applied here too — this route had
    // no check at all, meaning a PUT could set closing_meter below
    // opening_meter with no rejection, producing negative litres_sold and
    // negative revenue. Also guards against a non-numeric closing_meter:
    // `closing_meter < opening_meter` on a NaN comparison is always false
    // in JS, so a malformed value would have silently passed the naive
    // version of this check.
    if (!Number.isFinite(Number(finalClosing)) || !Number.isFinite(Number(existing.opening_meter))) {
      return res.status(400).json({ error: 'closing_meter must be a valid number' });
    }
    if (Number(finalClosing) < Number(existing.opening_meter)) {
      return res.status(400).json({ error: 'Closing meter cannot be less than opening meter' });
    }

    const litres_sold = parseFloat(finalClosing) - parseFloat(existing.opening_meter || 0);

    // session_number/session_time are immutable on an existing row (same
    // rule as opening_meter, per the comment above) — re-resolve price
    // using the session this row was originally saved under, not
    // whatever the client happens to send.
    const priceRows = await fetchPriceRows(req.supabaseAdmin, existing.fuel_type, existing.reading_date);
    const priceRow = resolveEffectivePrice(
      priceRows,
      existing.reading_date,
      existing.session_time,
      existing.session_number !== 1 || !existing.session_time
    );

    const amount_ghs = litres_sold * (parseFloat(priceRow?.price_per_litre) || 0);

    // Write finalClosing explicitly — the value actually validated and used
    // for litres_sold/amount_ghs above. The raw closing_meter previously
    // written here only worked when unset because JSON.stringify silently
    // drops undefined keys before the request body is sent; anyone changing
    // that defaulting logic later would have silently reintroduced the
    // negative-litres bug this validation exists to prevent.
    const { data, error } = await req.supabaseAdmin
      .from('pump_meter_readings')
      .update({ closing_meter: finalClosing, attendant_id, amount_ghs, rtt_litres })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update meter reading' });
  }
});

module.exports = router;
