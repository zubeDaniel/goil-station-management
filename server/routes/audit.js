const express = require('express');
const router = express.Router();
// Uses req.supabaseAdmin (per-request, actor-attributed) attached by the auth middleware — see middleware/auth.js
const { authenticate, adminOnly } = require('../middleware/auth');

// GET /api/audit — Admin only
router.get('/', authenticate, adminOnly, async (req, res) => {
  try {
    const { table_name, changed_by, start_date, end_date, exclude_tables, limit = 100 } = req.query;
    let query = req.supabaseAdmin
      .from('audit_log')
      .select('*, users(name, email)')
      .order('changed_at', { ascending: false })
      .limit(parseInt(limit));

    if (table_name) query = query.eq('table_name', table_name);
    // Comma-separated table names to leave out (the Dashboard feed hides
    // bank_deposits: its banking row already represents the event). Names are
    // restricted to [a-z_] so nothing is interpolated into the filter unchecked.
    if (exclude_tables) {
      const names = String(exclude_tables).split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s));
      if (names.length) query = query.not('table_name', 'in', `(${names.join(',')})`);
    }
    if (changed_by) query = query.eq('changed_by', changed_by);
    if (start_date) query = query.gte('changed_at', start_date);
    if (end_date) query = query.lte('changed_at', end_date);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;