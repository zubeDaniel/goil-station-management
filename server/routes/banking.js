const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOrManager } = require('../middleware/auth');
const { fetchBanking, parseDeposits, MAX_AMOUNT_GHS } = require('../lib/bankDeposits');

// NIB and UMB can have several deposits on the same day (separate slips); each
// is one row in bank_deposits, and banking.nib_ghs / umb_momo_ghs are their
// sums. Every write goes through the save_banking_entry() Postgres function —
// one transaction for the day + all its deposits, deriving nib_ghs, umb_momo_ghs
// and variance_vs_sales itself — so the stored totals can never drift from the
// deposits (see supabase/migrations/20261013120000_bank_deposits.sql).
//
// Request shape (POST and PUT):
//   nib_deposits / umb_deposits : [{ amount_ghs, slip_ref? }, ...]   <- new clients
//   nib_ghs / umb_momo_ghs      : single number, treated as ONE deposit  <- old
//                                 callers (e.g. the Excel import) keep working
//   gocard_ghs, coupons_50_ghs, coupons_100_ghs : single values, unchanged

function validateSingleChannels(body) {
  const { gocard_ghs, coupons_50_ghs, coupons_100_ghs } = body;
  // All channel amounts are optional (default 0), so 0 must stay valid — only
  // reject non-numeric or negative values.
  for (const [field, value] of Object.entries({ gocard_ghs, coupons_50_ghs, coupons_100_ghs })) {
    if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return `${field} must be a non-negative number`;
    }
    if (value !== undefined && Number(value) > MAX_AMOUNT_GHS) {
      return `${field} is too large (maximum ${MAX_AMOUNT_GHS})`;
    }
  }
  return null;
}

// 'YYYY-MM-DD' AND a real calendar date (rejects 2026-02-31, which Postgres would
// also reject — but as a raw 500 instead of a clear 400).
function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dt = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === value;
}

function parseAll(body) {
  const nib = parseDeposits(body, 'nib_deposits', 'nib_ghs');
  if (nib.error) return { error: nib.error };
  const umb = parseDeposits(body, 'umb_deposits', 'umb_momo_ghs');
  if (umb.error) return { error: umb.error };
  return { nib: nib.deposits, umb: umb.deposits };
}

// Shape the saved row like GET does, from what was just written.
function withDeposits(row, nib, umb) {
  return { ...row, nib_deposits: nib, umb_deposits: umb };
}

// GET /api/banking
router.get('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const { data, error } = await fetchBanking(req.supabaseAdmin, { start_date, end_date, ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch banking entries' });
  }
});

// POST /api/banking
router.post('/', authenticate, adminOrManager, async (req, res) => {
  try {
    const { entry_date, gocard_ghs, coupons_50_ghs, coupons_100_ghs } = req.body;

    if (!entry_date) {
      return res.status(400).json({ error: 'entry_date is required' });
    }
    if (!isRealDate(entry_date)) {
      return res.status(400).json({ error: 'entry_date must be a valid date (YYYY-MM-DD)' });
    }
    const channelError = validateSingleChannels(req.body);
    if (channelError) return res.status(400).json({ error: channelError });
    const parsed = parseAll(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { data, error } = await req.supabaseAdmin.rpc('save_banking_entry', {
      p_id: null,
      p_entry_date: entry_date,
      p_nib: parsed.nib,
      p_umb: parsed.umb,
      p_gocard: parseFloat(gocard_ghs) || 0,
      p_coupons_50: parseFloat(coupons_50_ghs) || 0,
      p_coupons_100: parseFloat(coupons_100_ghs) || 0,
      p_actor: req.user.id
    }).single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `A banking entry for ${entry_date} already exists — edit that entry instead of creating a new one.` });
      }
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json(withDeposits(data, parsed.nib, parsed.umb));
  } catch (err) {
    res.status(500).json({ error: 'Failed to save banking entry' });
  }
});

// PUT /api/banking/:id
router.put('/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { gocard_ghs, coupons_50_ghs, coupons_100_ghs } = req.body;

    // entry_date is looked up from the existing row (inside save_banking_entry),
    // not trusted from the client — a client-supplied date would make the
    // variance get computed against whatever date happens to be sent, which may
    // not match the row actually being edited. The explicit 404 check stays here
    // so a missing row is reported before any validation noise.
    const { data: existing, error: fetchError } = await req.supabaseAdmin
      .from('banking')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Banking entry not found' });
    }

    const channelError = validateSingleChannels(req.body);
    if (channelError) return res.status(400).json({ error: channelError });
    const parsed = parseAll(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { data, error } = await req.supabaseAdmin.rpc('save_banking_entry', {
      p_id: req.params.id,
      p_entry_date: null,
      p_nib: parsed.nib,
      p_umb: parsed.umb,
      p_gocard: parseFloat(gocard_ghs) || 0,
      p_coupons_50: parseFloat(coupons_50_ghs) || 0,
      p_coupons_100: parseFloat(coupons_100_ghs) || 0,
      p_actor: req.user.id
    }).single();

    if (error) {
      if (error.code === 'P0002') return res.status(404).json({ error: 'Banking entry not found' });
      return res.status(500).json({ error: error.message });
    }
    res.json(withDeposits(data, parsed.nib, parsed.umb));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update banking entry' });
  }
});

// DELETE /api/banking/:id — bank_deposits rows go with it (ON DELETE CASCADE)
router.delete('/:id', authenticate, adminOrManager, async (req, res) => {
  try {
    const { error } = await req.supabaseAdmin
      .from('banking')
      .delete()
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Banking entry deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete banking entry' });
  }
});

module.exports = router;
