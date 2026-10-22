const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOrManager, adminOnly } = require('../middleware/auth');

// ---- Server-derived fields ----
// opening_stock, litres_sold, and expected_variance are all meant to be
// reconciliation checks against independently-recorded data (previous dip
// readings, actual pump sales, delivery waybills) — the whole point of Tank
// Stock is to catch a mismatch between what the pumps report and what's
// physically in the tank. Previously all three were auto-fetched by the
// frontend for convenience but left editable, and the server trusted
// whatever arrived, which defeats the reconciliation entirely. Deriving
// them here, independent of client input, is the fix. expected_variance in
// particular wasn't handled by this route AT ALL before — every row got
// the column's default of 0 forever, regardless of delivery shortages.

async function getPreviousClosingStock(supabaseAdmin, tankId, fuelType, stockDate) {
  const { data, error } = await supabaseAdmin
    .from('tank_stock')
    .select('closing_stock_dip')
    .eq('tank_id', tankId)
    .eq('fuel_type', fuelType)
    .lt('stock_date', stockDate)
    .order('stock_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up previous closing stock: ${error.message}`);
  return data ? parseFloat(data.closing_stock_dip) : null;
}

async function getLitresSoldForDate(supabaseAdmin, fuelType, stockDate) {
  const { data, error } = await supabaseAdmin
    .from('pump_meter_readings')
    .select('litres_sold')
    .eq('fuel_type', fuelType)
    .eq('reading_date', stockDate);
  if (error) throw new Error(`Failed to sum pump sales: ${error.message}`);
  return (data || []).reduce((sum, r) => sum + (parseFloat(r.litres_sold) || 0), 0);
}

// Dip readings are entered the morning AFTER the day they close, so a tank stock
// entry dated D+1 closes physical day D. Deliveries are logged on the day the
// truck actually arrived (matching the station's paper records), so the delivery
// that belongs to the entry dated D+1 is the one dated D — the day before.
// (Same one-day entry lag the reports already correct for meter readings.)
function previousDate(dateStr) {
  // Malformed input is passed through untouched so the database rejects it
  // exactly as it did before this change (rather than a RangeError from here).
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

async function getWaybillExpectedLitres(supabaseAdmin, tankId, stockDate) {
  const { data, error } = await supabaseAdmin
    .from('tanker_deliveries')
    .select('expected_litres')
    .eq('tank_id', tankId)
    .eq('delivery_date', previousDate(stockDate));
  if (error) throw new Error(`Failed to look up waybill expected litres: ${error.message}`);
  return (data || []).reduce((sum, r) => sum + (parseFloat(r.expected_litres) || 0), 0);
}

// GET /api/tank-stock
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { start_date, end_date, tank_id } = req.query;
    let query = req.supabaseAdmin
      .from('tank_stock')
      .select('*')
      .order('stock_date', { ascending: false });

    if (start_date) query = query.gte('stock_date', start_date);
    if (end_date) query = query.lte('stock_date', end_date);
    if (tank_id) query = query.eq('tank_id', tank_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tank stock' });
  }
});

// POST /api/tank-stock
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { stock_date, tank_id, fuel_type, delivery_litres, closing_stock_dip } = req.body;

    if (!stock_date || !tank_id || !fuel_type || closing_stock_dip === undefined) {
      return res.status(400).json({ error: 'stock_date, tank_id, fuel_type, and closing_stock_dip are required' });
    }
    // closing_stock_dip is a physical dip-stick reading — can't legitimately
    // be negative, and it feeds directly into expected_variance, the number
    // this whole module exists to keep trustworthy for catching shortage.
    if (!Number.isFinite(Number(closing_stock_dip)) || Number(closing_stock_dip) < 0) {
      return res.status(400).json({ error: 'closing_stock_dip must be a non-negative number' });
    }
    if (delivery_litres !== undefined && (!Number.isFinite(Number(delivery_litres)) || Number(delivery_litres) < 0)) {
      return res.status(400).json({ error: 'delivery_litres must be a non-negative number' });
    }
    // A dip reading dated in the future doesn't correspond to a physical
    // measurement that's happened yet.
    if (stock_date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'stock_date cannot be in the future' });
    }

    // opening_stock is locked to the previous day's actual closing dip for
    // this tank. The only time the client's value is used is when no prior
    // row exists at all for this tank+fuel_type — i.e. the very first entry
    // ever recorded (the Setup Wizard's initial baseline).
    const previousClosing = await getPreviousClosingStock(req.supabaseAdmin, tank_id, fuel_type, stock_date);
    const openingStock = previousClosing !== null ? previousClosing : (parseFloat(req.body.opening_stock) || 0);

    const litresSold = await getLitresSoldForDate(req.supabaseAdmin, fuel_type, stock_date);

    // expected_variance uses the waybill's *expected* litres, not what was
    // actually measured on arrival (that's actual_variance, a generated
    // column). The two only differ on a delivery day where the waybill and
    // the physically-measured delivery disagree — see PRD §2.2, "Dual
    // variance system".
    const waybillExpected = await getWaybillExpectedLitres(req.supabaseAdmin, tank_id, stock_date);
    const expectedVariance = parseFloat(closing_stock_dip) - (openingStock + waybillExpected - litresSold);

    const { data, error } = await req.supabaseAdmin
      .from('tank_stock')
      .insert({
        stock_date, tank_id, fuel_type,
        opening_stock: openingStock,
        litres_sold: litresSold,
        delivery_litres: delivery_litres || 0,
        closing_stock_dip,
        expected_variance: expectedVariance,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `A tank stock entry for ${tank_id} on ${stock_date} already exists — edit that entry instead of creating a new one.` });
      }
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save tank stock' });
  }
});

// PUT /api/tank-stock/:id
// Only closing_stock_dip and delivery_litres are editable — correcting a
// typo in a physically-measured reading. stock_date/tank_id/fuel_type stay
// fixed (changing those would mean "this is a different record", not "fix
// a mistake in this one"). opening_stock is NOT re-derived here — it's a
// snapshot of what the previous day's closing dip actually was at the
// moment this row was created, and shouldn't shift retroactively just
// because a later field gets corrected. litres_sold and expected_variance
// ARE re-derived fresh, same as on create, since they're independent
// reconciliation checks that should always reflect the true current state
// of pump readings and delivery waybills, not a stale value from whenever
// this row was first saved.
router.put('/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { closing_stock_dip, delivery_litres } = req.body;

    if (closing_stock_dip === undefined) {
      return res.status(400).json({ error: 'closing_stock_dip is required' });
    }
    if (!Number.isFinite(Number(closing_stock_dip)) || Number(closing_stock_dip) < 0) {
      return res.status(400).json({ error: 'closing_stock_dip must be a non-negative number' });
    }
    if (delivery_litres !== undefined && (!Number.isFinite(Number(delivery_litres)) || Number(delivery_litres) < 0)) {
      return res.status(400).json({ error: 'delivery_litres must be a non-negative number' });
    }

    const { data: existing, error: fetchError } = await req.supabaseAdmin
      .from('tank_stock')
      .select('tank_id, fuel_type, stock_date, opening_stock')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Tank stock entry not found' });
    }

    const litresSold = await getLitresSoldForDate(req.supabaseAdmin, existing.fuel_type, existing.stock_date);
    const waybillExpected = await getWaybillExpectedLitres(req.supabaseAdmin, existing.tank_id, existing.stock_date);
    const openingStock = parseFloat(existing.opening_stock);
    const expectedVariance = parseFloat(closing_stock_dip) - (openingStock + waybillExpected - litresSold);

    const { data, error } = await req.supabaseAdmin
      .from('tank_stock')
      .update({
        litres_sold: litresSold,
        delivery_litres: delivery_litres || 0,
        closing_stock_dip,
        expected_variance: expectedVariance
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update tank stock' });
  }
});

// DELETE /api/tank-stock/:id — Admin only.
// Originally scoped out (see earlier code review notes) on the reasoning
// that a dip reading is closer to an audit record than a correctable
// draft. Revisited after a real incident: a wrong entry with no recovery
// path at all is a worse outcome than the theoretical audit-trail risk —
// especially since every delete is still fully logged in audit_log
// regardless (nothing is ever actually unrecoverable at the database
// level, even after this). Restricted to Admin, unlike edit which is
// Admin+Manager, as a middle ground.
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { error } = await req.supabaseAdmin
      .from('tank_stock')
      .delete()
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Tank stock entry deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tank stock entry' });
  }
});

module.exports = router;