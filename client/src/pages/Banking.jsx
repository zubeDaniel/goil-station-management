import { useState, useEffect } from 'react'
import api from '../lib/api'
import { useToast } from '../components/Toast'

// NIB and UMB can be banked in several separate deposits on the same day (one
// per slip). Each is entered as its own row; the day's NIB / UMB figure is their
// sum. GoCard and the coupon fields stay single-value.
const BANKS = [
  { listKey: 'nib_deposits', label: 'NIB' },
  { listKey: 'umb_deposits', label: 'UMB / MoMo' },
]
const SINGLE_CHANNELS = [
  { key: 'gocard_ghs', label: 'GoCard' },
  { key: 'coupons_50_ghs', label: 'Coupons @50', hint: 'Physical coupon deposit by denomination — separate from Sales Book\'s coupon revenue, which this reconciles against' },
  { key: 'coupons_100_ghs', label: 'Coupons @100' },
]
// Used by the month totals table (stored daily totals, unchanged)
const CHANNELS = [
  { key: 'nib_ghs', label: 'NIB' },
  { key: 'umb_momo_ghs', label: 'UMB / MoMo' },
  ...SINGLE_CHANNELS,
]

const MAX_DEPOSITS = 20
const blankDeposit = () => ({ amount: '', slip_ref: '' })
const todayStr = () => new Date().toISOString().split('T')[0]
const emptyForm = () => ({
  entry_date: todayStr(),
  nib_deposits: [blankDeposit()],
  umb_deposits: [blankDeposit()],
  gocard_ghs: '0', coupons_50_ghs: '0', coupons_100_ghs: '0',
})

const money = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Same plain 2-decimal style the rest of the history table uses (no thousands separators).
const fx = (n) => (parseFloat(n) || 0).toFixed(2)
// Each deposit is rounded to 2dp BEFORE summing — exactly what the server does —
// so the total shown while typing can never differ from the one that gets saved.
const r2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100
const sumDeposits = (list) => (list || []).reduce((s, d) => s + r2(d.amount), 0)
const toRows = (list) => (list && list.length > 0
  ? list.map(d => ({ amount: String(d.amount_ghs), slip_ref: d.slip_ref || '' }))
  : [blankDeposit()])
const toPayload = (list) => list
  .filter(d => r2(d.amount) > 0)
  .map(d => ({ amount_ghs: r2(d.amount), slip_ref: d.slip_ref.trim() }))

// History-table cell: one amount normally; with several deposits, each on its
// own line (slip ref beside it) and the day's sum underneath.
function DepositCell({ deposits, total }) {
  const slip = (d) => d.slip_ref && <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6 }}>#{d.slip_ref}</span>
  if (!deposits || deposits.length === 0) return <>{fx(total)}</>
  if (deposits.length === 1) return <>{fx(total)}{slip(deposits[0])}</>
  return (
    <div>
      {deposits.map((d, i) => <div key={i}>{fx(d.amount_ghs)}{slip(d)}</div>)}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 3, paddingTop: 3, fontWeight: 700 }}>{fx(total)}</div>
    </div>
  )
}

export default function Banking() {
  const { showToast } = useToast()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7))
  const [form, setForm] = useState(emptyForm())

  const startDate = `${selectedMonth}-01`
  const endDate = new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth() + 1, 0)
    .toISOString().split('T')[0]

  useEffect(() => {
    loadData()
  }, [selectedMonth])

  const loadData = async () => {
    setLoading(true)
    try {
      const res = await api.get(`/banking?start_date=${startDate}&end_date=${endDate}`)
      setEntries(res.data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const nibTotal = sumDeposits(form.nib_deposits)
  const umbTotal = sumDeposits(form.umb_deposits)
  const total = nibTotal + umbTotal
    + SINGLE_CHANNELS.reduce((s, ch) => s + (parseFloat(form[ch.key]) || 0), 0)

  // ── Deposit-row editing ──────────────────────────────────
  const setDeposit = (listKey, i, field, value) =>
    setForm(p => ({ ...p, [listKey]: p[listKey].map((d, idx) => idx === i ? { ...d, [field]: value } : d) }))
  const addDeposit = (listKey) =>
    setForm(p => p[listKey].length >= MAX_DEPOSITS ? p : ({ ...p, [listKey]: [...p[listKey], blankDeposit()] }))
  const removeDeposit = (listKey, i) =>
    setForm(p => p[listKey].length <= 1 ? p : ({ ...p, [listKey]: p[listKey].filter((_, idx) => idx !== i) }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        entry_date: form.entry_date,
        nib_deposits: toPayload(form.nib_deposits),
        umb_deposits: toPayload(form.umb_deposits),
        gocard_ghs: form.gocard_ghs,
        coupons_50_ghs: form.coupons_50_ghs,
        coupons_100_ghs: form.coupons_100_ghs,
      }
      if (editingId) {
        await api.put(`/banking/${editingId}`, payload)
        showToast('success', 'Banking entry updated', form.entry_date)
        setEditingId(null)
      } else {
        await api.post('/banking', payload)
        showToast('success', 'Banking entry saved', form.entry_date)
      }
      setForm(emptyForm())
      await loadData()
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error)
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (entry) => {
    setEditingId(entry.id)
    setForm({
      entry_date: entry.entry_date,
      nib_deposits: toRows(entry.nib_deposits),
      umb_deposits: toRows(entry.umb_deposits),
      gocard_ghs: String(entry.gocard_ghs || 0),
      coupons_50_ghs: String(entry.coupons_50_ghs || 0),
      coupons_100_ghs: String(entry.coupons_100_ghs || 0),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setForm(emptyForm())
  }

  const handleDelete = async (id, date) => {
    if (!confirm(`Delete the banking entry for ${date}? This cannot be undone.`)) return
    try {
      await api.delete(`/banking/${id}`)
      showToast('success', 'Banking entry deleted', date)
      if (editingId === id) handleCancelEdit()
      await loadData()
    } catch (err) {
      showToast('error', 'Delete failed', err.response?.data?.error)
    }
  }

  // Monthly totals (stored daily totals — the sum of each day's deposits)
  const monthlyTotals = CHANNELS.reduce((acc, ch) => {
    acc[ch.key] = entries.reduce((s, e) => s + parseFloat(e[ch.key] || 0), 0)
    return acc
  }, {})
  const grandTotal = entries.reduce((s, e) => s + parseFloat(e.total_banked_ghs || 0), 0)

  // Available months
  const months = []
  for (let i = 0; i < 6; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    months.push(d.toISOString().slice(0, 7))
  }

  if (loading) return <div className="loading-screen">Loading banking...</div>

  return (
    <div>
      <div className="page-header">
        <div><h2>Banking</h2><p>Daily payment channel deposits and reconciliation</p></div>
        <div className="page-header-actions">
          <div style={{ display: 'flex', gap: 4 }}>
            {months.map(m => (
              <button key={m} className={`btn btn-sm ${selectedMonth === m ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSelectedMonth(m)}>
                {new Date(m + '-01').toLocaleString('default', { month: 'short' })}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2 mb-16">
        {/* Daily entry form */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">{editingId ? `Editing entry — ${form.entry_date}` : `Daily entry — ${form.entry_date}`}</div>
            {editingId && <span className="badge badge-amber">Editing</span>}
          </div>
          <div className="form-group" style={{ marginBottom: 14, maxWidth: 220 }}>
            <label className="form-label">Date</label>
            <input className="form-input" type="date" value={form.entry_date} disabled={!!editingId}
              onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))} />
            {editingId && <span className="form-hint">Date can't be changed while editing — delete and re-create instead</span>}
          </div>

          {/* NIB and UMB — one row per deposit slip */}
          {BANKS.map(bank => {
            const list = form[bank.listKey]
            const subtotal = sumDeposits(list)
            const filled = list.filter(d => r2(d.amount) > 0).length
            return (
              <div key={bank.listKey} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', marginBottom: 12, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)', padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--navy)' }}>
                    {bank.label}
                    {filled > 1 && <span className="badge badge-amber" style={{ marginLeft: 8 }}>{filled} deposits</span>}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--calc-text)' }}>GHS {money(subtotal)}</span>
                </div>
                <div style={{ padding: 12 }}>
                  {list.map((d, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '22px 1.2fr 1fr 34px', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', paddingBottom: 10 }}>{i + 1}</div>
                      <div className="form-group">
                        <label className="form-label">Amount (GHS)</label>
                        <input className="form-input" type="number" min="0" step="0.01" placeholder="0.00" value={d.amount}
                          onChange={e => setDeposit(bank.listKey, i, 'amount', e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Slip ref (optional)</label>
                        <input className="form-input" maxLength={60} placeholder="e.g. slip no." value={d.slip_ref}
                          onChange={e => setDeposit(bank.listKey, i, 'slip_ref', e.target.value)} />
                      </div>
                      <button className="btn btn-ghost btn-sm" style={{ height: 34, justifyContent: 'center', color: 'var(--red)' }}
                        title="Remove this deposit" aria-label={`Remove ${bank.label} deposit ${i + 1}`}
                        disabled={list.length <= 1} onClick={() => removeDeposit(bank.listKey, i)}>
                        <i className="ph ph-x"></i>
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center', borderStyle: 'dashed' }}
                    disabled={list.length >= MAX_DEPOSITS} onClick={() => addDeposit(bank.listKey)}>
                    <i className="ph ph-plus"></i> Add another {bank.label} deposit
                  </button>
                </div>
              </div>
            )
          })}

          {/* Single-value channels */}
          <div className="form-row">
            {SINGLE_CHANNELS.map(ch => (
              <div key={ch.key} className="form-group">
                <label className="form-label">{ch.label} (GHS)</label>
                <input className="form-input" type="number" value={form[ch.key]}
                  onChange={e => setForm(p => ({ ...p, [ch.key]: e.target.value }))} />
                {ch.hint && <span className="form-hint">{ch.hint}</span>}
              </div>
            ))}
            <div className="form-group">
              <label className="form-label">Total banked (GHS)</label>
              <input className="form-input is-calc" value={total.toFixed(2)} readOnly />
            </div>
          </div>

          {/* Total banked summary */}
          <div style={{ background: 'var(--green-subtle)', border: '1px solid var(--green-border)', borderRadius: 'var(--r-sm)', padding: '10px 12px', textAlign: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--green)', textTransform: 'uppercase', marginBottom: 2 }}>Total banked</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>GHS {total.toFixed(2)}</div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {editingId && (
              <button className="btn btn-ghost" onClick={handleCancelEdit}>Cancel</button>
            )}
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}
              onClick={handleSave} disabled={saving}>
              <i className="ph ph-floppy-disk"></i> {saving ? 'Saving...' : editingId ? 'Update banking entry' : 'Save banking entry'}
            </button>
          </div>
        </div>

        {/* Monthly channel totals */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              {new Date(selectedMonth + '-01').toLocaleString('default', { month: 'long' })} {new Date(selectedMonth + '-01').getFullYear()} — Channel totals
            </div>
          </div>
          <table>
            <thead><tr><th>Channel</th><th>Month total (GHS)</th><th>%</th></tr></thead>
            <tbody>
              {CHANNELS.map(ch => (
                <tr key={ch.key}>
                  <td>{ch.label}</td>
                  <td className="td-calc">{monthlyTotals[ch.key].toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td>{grandTotal > 0 ? Math.round((monthlyTotals[ch.key] / grandTotal) * 100) : 0}%</td>
                </tr>
              ))}
              <tr className="tr-total">
                <td><strong>Grand total</strong></td>
                <td className="td-calc"><strong>{grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></td>
                <td><strong>100%</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* History table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            {new Date(selectedMonth + '-01').toLocaleString('default', { month: 'long' })} — Daily view
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>NIB</th><th>MoMo</th><th>GoCard</th><th>Coupons @50</th><th>Coupons @100</th><th>Total banked</th><th>Variance vs sales</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{e.entry_date}</td>
                  <td className="td-calc" style={{ verticalAlign: 'top' }}><DepositCell deposits={e.nib_deposits} total={e.nib_ghs} /></td>
                  <td className="td-calc" style={{ verticalAlign: 'top' }}><DepositCell deposits={e.umb_deposits} total={e.umb_momo_ghs} /></td>
                  <td className="td-calc">{parseFloat(e.gocard_ghs).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(e.coupons_50_ghs).toFixed(2)}</td>
                  <td className="td-calc">{parseFloat(e.coupons_100_ghs).toFixed(2)}</td>
                  <td className="td-calc" style={{ fontWeight: 700 }}>GHS {parseFloat(e.total_banked_ghs).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${parseFloat(e.variance_vs_sales) >= 0 ? 'badge-green' : 'badge-red'}`}>
                      {parseFloat(e.variance_vs_sales) >= 0 ? '+' : ''}{parseFloat(e.variance_vs_sales || 0).toFixed(2)}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleEdit(e)}><i className="ph ph-pencil-simple"></i></button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => handleDelete(e.id, e.entry_date)}><i className="ph ph-trash"></i></button>
                    </div>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No entries for this month</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
