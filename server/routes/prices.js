const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOnly, adminOrManager } = require('../middleware/auth');

// GET /api/prices
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('fuel_prices')
      .select('*')
      .order('effective_date', { ascending: false })
      .order('effective_time', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// GET /api/prices/current
router.get('/current', authenticate, adminOrManager, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const results = {};

    for (const fuel of ['SXP', 'DXP']) {
      const { data, error } = await req.supabaseAdmin
        .from('fuel_prices')
        .select('*')
        .eq('fuel_type', fuel)
        .lte('effective_date', today)
        // effective_time as the primary same-day tie-break (a mid-shift
        // price change on `today` must outrank today's original
        // day-start row), created_at as the final deterministic
        // tie-break for two rows sharing both effective_date and
        // effective_time (possible with existing pre-session-migration
        // data, which all defaulted to effective_time = '00:00:00').
        .order('effective_date', { ascending: false })
        .order('effective_time', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (!error) results[fuel] = data;
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

// POST /api/prices
// Upsert against the (fuel_type, effective_date, effective_time) unique
// constraint added in 20260918120000_intraday_price_sessions.sql.
// effective_time defaults to '00:00:00' when the client omits it, which
// is every existing caller today — so correcting today's already-entered
// price still upserts onto that same day-start row exactly as before
// this change. A genuine mid-shift price change is a *different* row
// because the client sends a non-midnight effective_time for it (see the
// Meter Book "Price changed today?" flow) — that's an insert, not an
// overwrite of the day-start price, which is the entire point: the old
// price must survive for session 1's revenue calc in server/routes/meter.js.
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { fuel_type, price_per_litre, effective_date, effective_time, npa_reference } = req.body;
    if (!fuel_type || !price_per_litre || !effective_date) {
      return res.status(400).json({ error: 'fuel_type, price_per_litre, and effective_date are required' });
    }
    if (!Number.isFinite(Number(price_per_litre)) || Number(price_per_litre) <= 0) {
      return res.status(400).json({ error: 'price_per_litre must be a positive number' });
    }
    // Same validation gap meter.js's session_time had: an unvalidated
    // effective_time either gets padded into something Postgres rejects
    // with a raw 500, or — worse — a same-length malformed string would
    // pass through as a literal, silently wrong sort key for every price
    // lookup that orders by effective_time (meter.js, sales.js,
    // creditors.js, GET /current above).
    if (effective_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(effective_time)) {
      return res.status(400).json({ error: 'effective_time must be in HH:MM or HH:MM:SS 24-hour format' });
    }
    // Deliberately NOT adding a "cannot be in the future" guard here.
    // Unlike meter/sales/deliveries/tank-stock — which record something
    // that already physically happened — NPA bulletins are routinely
    // published ahead of their effective date, and pre-entering that price
    // before it takes effect is a legitimate, sensible workflow. Blocking
    // it would fix a clock-skew edge case by breaking the common case.

    const effTime = effective_time && effective_time.length === 5 ? `${effective_time}:00` : (effective_time || '00:00:00');

    const { data, error } = await req.supabaseAdmin
      .from('fuel_prices')
      .upsert(
        { fuel_type, price_per_litre, effective_date, effective_time: effTime, npa_reference, updated_by: req.user.id },
        { onConflict: 'fuel_type,effective_date,effective_time' }
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create price entry' });
  }
});

module.exports = router;
