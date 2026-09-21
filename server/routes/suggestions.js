const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOnly, adminOrManager } = require('../middleware/auth');

// GET /api/suggestions
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('price_update_suggestions')
      .select('*, users!fetched_by(name)')
      .order('fetched_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// POST /api/suggestions
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { fuel_type, suggested_price_per_litre, npa_reference } = req.body;

    if (!fuel_type || !suggested_price_per_litre) {
      return res.status(400).json({ error: 'fuel_type and suggested_price_per_litre are required' });
    }

    const { data, error } = await req.supabaseAdmin
      .from('price_update_suggestions')
      .insert({
        fuel_type, suggested_price_per_litre,
        npa_reference, fetched_by: req.user.id,
        status: 'pending'
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save suggestion' });
  }
});

// POST /api/suggestions/:id/approve — Admin only
router.post('/:id/approve', authenticate, adminOnly, async (req, res) => {
  try {
    const { data: suggestion, error: fetchError } = await req.supabaseAdmin
      .from('price_update_suggestions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Same upsert pattern as prices.js's POST route — this second write
    // path to fuel_prices was missed when the unique constraint on
    // (fuel_type, effective_date) was added in migration 007. A plain
    // insert() here would throw a raw 23505 the first time an admin
    // approves a second suggestion for the same fuel on the same day, and
    // the suggestion would be stuck (price never applied, never marked
    // approved either, since that update never runs after this fails).
    //
    // onConflict updated to fuel_type,effective_date,effective_time —
    // the constraint itself was widened to three columns in
    // 20260918120000_intraday_price_sessions.sql (to allow a genuine
    // same-day second price for a mid-shift change) and this second write
    // path was missed in that same pass; left pointing at the old
    // two-column target, Postgres rejects the upsert outright with "no
    // unique or exclusion constraint matching the ON CONFLICT
    // specification" — every approval would fail, not just collide.
    // effective_time is omitted from the payload below and defaults to
    // '00:00:00' (an AI-fetched suggestion is always a day-start price,
    // never a mid-shift entry — that flow only exists through the Meter
    // Book "Price changed today?" panel), so this still upserts onto the
    // same day-start row a second approval for the same day would target.
    const { error: priceError } = await req.supabaseAdmin
      .from('fuel_prices')
      .upsert(
        {
          fuel_type: suggestion.fuel_type,
          price_per_litre: suggestion.suggested_price_per_litre,
          effective_date: new Date().toISOString().split('T')[0],
          npa_reference: suggestion.npa_reference,
          updated_by: req.user.id
        },
        { onConflict: 'fuel_type,effective_date,effective_time' }
      );

    if (priceError) {
      return res.status(500).json({ error: `Failed to apply price: ${priceError.message}` });
    }

    // Mark approved
    const { data, error } = await req.supabaseAdmin
      .from('price_update_suggestions')
      .update({
        status: 'approved',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve suggestion' });
  }
});

// POST /api/suggestions/:id/reject — Admin only
router.post('/:id/reject', authenticate, adminOnly, async (req, res) => {
  try {
    const { data, error } = await req.supabaseAdmin
      .from('price_update_suggestions')
      .update({
        status: 'rejected',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject suggestion' });
  }
});

module.exports = router;