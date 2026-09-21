import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import api from '../lib/api'
import { useToast } from '../components/Toast'
import { useRole } from '../hooks/useRole'

const PUMP_CONFIGS = [
  { key: 'P1_SXP', pumpId: 'P1', label: 'Pump 1', fuel: 'SXP', dotColor: 'var(--orange)' },
  { key: 'P1_DXP', pumpId: 'P1', label: 'Pump 1', fuel: 'DXP', dotColor: 'var(--amber)' },
  { key: 'P2_SXP', pumpId: 'P2', label: 'Pump 2', fuel: 'SXP', dotColor: 'var(--orange)' },
  { key: 'P2_DXP', pumpId: 'P2', label: 'Pump 2', fuel: 'DXP', dotColor: 'var(--amber)' },
  { key: 'P3_DXP', pumpId: 'P3', label: 'Pump 3', fuel: 'DXP', dotColor: 'var(--amber)' },
]

// session2 stays null on an ordinary day — it's only populated when the
// "Price changed today?" toggle is on. opening_meter/attendant_id/
// rtt_litres are deliberately NOT duplicated per session: RTT and
// attendant are recorded once per pump/fuel/day (see server/routes/
// meter.js and the migration's column comments) — duplicating rtt_litres
// onto both session rows would double-count it in the monthly RTT
// summary column.
const emptyPump = () => ({ opening_meter: '', closing_meter: '', attendant_id: '', rtt_litres: '', session2: null })

export default function MeterBook() {
  const { showToast } = useToast()
  const { isAdminOrManager } = useRole()

  const [readings, setReadings]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [prices, setPrices]       = useState({})
  const [attendants, setAttendants] = useState([])
  const [saving, setSaving]       = useState(false)
  const [dealerMargin, setDealerMargin] = useState(0.30)

  // Maps pump key (e.g. 'P1_SXP') -> { s1: id, s2: id } of the existing
  // pump_meter_readings row(s) for the currently selected date, if any
  // were already saved. s2 is only present on a day that was split for a
  // mid-shift price change. A key with neither means "no entry yet for
  // this pump/fuel on this date" — save will POST. A present s1/s2 means
  // "already saved" — save will PUT that specific session instead of
  // creating a duplicate.
  const [existingIds, setExistingIds] = useState({})

  // Delivery state — Option A: checkbox only, fetches from tanker_deliveries
  const [deliveryChecked, setDeliveryChecked]   = useState(false)
  const [deliveryFetching, setDeliveryFetching] = useState(false)
  const [deliveryData, setDeliveryData]         = useState(null) // array of delivery records for the date

  // ── Intra-day price change ("Price changed today?") ─────────
  // priceChanged is the toggle's own state; changeTime is the shared
  // changeover boundary sent as session_time on BOTH session 1 and
  // session 2 of every pump touched today — see server/routes/meter.js's
  // resolveEffectivePrice for why session 1 needs it too, not just
  // session 2. newPrices/npaReference feed a POST /api/prices with an
  // explicit effective_time before any session 2 meter reading is saved,
  // so the new price row exists by the time meter.js resolves it.
  const [priceChanged, setPriceChanged] = useState(false)
  const [changeTime, setChangeTime]     = useState('')
  const [newPrices, setNewPrices]       = useState({ SXP: '', DXP: '' })
  const [npaReference, setNpaReference] = useState('')

  // ── Recent readings — filters ──────────────────────────────
  // These filter the already-loaded `readings` array client-side (GET
  // /meter currently returns the full table with no pagination, so
  // `readings` already holds everything the server has — no extra
  // network round trip needed). Kept fully separate from `form` /
  // `existingIds` above so filtering the history view can never
  // interfere with the daily-entry form's auto-fill logic, which needs
  // the *complete* unfiltered history to compute opening meters and
  // detect existing rows correctly.
  const [historyDate, setHistoryDate]     = useState('')  // exact-match reading_date
  const [historyAttendant, setHistoryAttendant] = useState('') // attendant_id
  const [historyPump, setHistoryPump]     = useState('')  // pump_id

  const [form, setForm] = useState({
    reading_date: new Date().toISOString().split('T')[0],
    P1_SXP: emptyPump(),
    P1_DXP: emptyPump(),
    P2_SXP: emptyPump(),
    P2_DXP: emptyPump(),
    P3_DXP: emptyPump(),
  })

  // ── Load initial data ──────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/meter'),
      // GET /prices/current is admin/manager-only on the backend — same bug
// class as the /attendants and /setup calls below. Unguarded here, it
// 403'd for Viewer, rejected the whole Promise.all, and setReadings()
// never fired — Meter Book appeared empty even though GET /meter and
// the 10 existing readings were fine all along.
isAdminOrManager ? api.get('/prices/current') : Promise.resolve({ data: {} }),
      // Previously fetched unconditionally, which broke this entire screen
      // for Viewer: GET /attendants is admin/manager-only on the backend,
      // so Viewer's call 403'd, Promise.all rejected as a whole, and
      // .then() never ran — meaning setReadings() never fired and Meter
      // Book appeared completely empty for Viewer, even though GET /meter
      // itself would have succeeded fine. Guarded the same way /setup
      // already correctly was.
      isAdminOrManager ? api.get('/attendants') : Promise.resolve({ data: [] }),
      isAdminOrManager ? api.get('/setup') : Promise.resolve(null),
    ]).then(([meterRes, pricesRes, attendantsRes, setupRes]) => {
      setReadings(meterRes.data)
      setPrices(pricesRes.data)
      setAttendants(attendantsRes.data)
      if (setupRes?.data?.dealer_margin_per_litre !== undefined) {
        setDealerMargin(parseFloat(setupRes.data.dealer_margin_per_litre))
      }
    }).catch(console.error)
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-fill attendant per pump from the Shifts assignment for this
  // date. Previously this screen only ever fetched the full attendant
  // list for a blank dropdown — assigning someone to a pump on the Shifts
  // screen had no effect here at all, so the same assignment had to be
  // manually re-picked from the full staff list on every single entry.
  // Still just a default: the dropdown stays editable so a wrong or
  // missing shift assignment can be corrected here directly.
  const applyShiftAttendants = useCallback(async (date) => {
    try {
      const res = await api.get(`/shifts?start_date=${date}&end_date=${date}`)
      const shiftsForDate = res.data
      setForm(prev => {
        const updated = { ...prev }
        PUMP_CONFIGS.forEach(({ key, pumpId }) => {
          const shift = shiftsForDate.find(s => s.pump_id === pumpId)
          if (shift) {
            updated[key] = { ...updated[key], attendant_id: shift.attendant_id }
          }
        })
        return updated
      })
    } catch (err) {
      console.error('Failed to load shift assignments', err)
    }
  }, [])

  // ── Auto-fill opening meters whenever readings or date changes ──
  const autoFillOpeningMeters = useCallback((allReadings, date) => {
    setForm(prev => {
      const updated = { ...prev }
      PUMP_CONFIGS.forEach(({ key, pumpId, fuel }) => {
        // Find the most recent reading for this pump+fuel strictly before
        // the selected date. A prior date can now hold TWO rows (a split
        // day has session 1 and session 2 sharing one reading_date) — the
        // true end-of-day closing is whichever has the higher
        // session_number, not just whichever the sort happens to land on
        // first when two rows share the same reading_date. Every row
        // returned by the API has a session_number (defaults to 1 on the
        // DB side even for pre-migration rows), so this is safe for old
        // data too.
        const prior = allReadings
          .filter(r => r.pump_id === pumpId && r.fuel_type === fuel && r.reading_date < date)
          .sort((a, b) => {
            if (a.reading_date !== b.reading_date) return b.reading_date.localeCompare(a.reading_date)
            return (b.session_number || 1) - (a.session_number || 1)
          })[0]

        if (prior) {
          updated[key] = {
            ...updated[key],
            opening_meter: parseFloat(prior.closing_meter).toFixed(2),
          }
        } else {
          // No prior record — leave blank so user can enter opening baseline
          updated[key] = { ...updated[key], opening_meter: '' }
        }
      })
      return updated
    })
  }, [])

  // ── Detect an already-saved reading for the selected date ──
  // For each pump+fuel, look for row(s) on this exact reading_date (not
  // "strictly before", like autoFillOpeningMeters above — this is looking
  // for what's ON this date). A date can now hold up to two rows per
  // pump/fuel — session 1 and, on a split day, session 2 — so this
  // filters for both instead of assuming a single match. When session 2
  // is found, the "Price changed today?" toggle and its changeover time
  // are restored from that row so reopening an already-split day shows
  // the split UI without the user re-entering anything. Runs after
  // autoFillOpeningMeters/applyShiftAttendants so it can override their
  // guesses with the actual saved record where one exists — ground truth
  // wins over a shift-assignment default.
  const applyExistingReadings = useCallback((allReadings, date) => {
    const idsForDate = {}
    let detectedSplit = false
    let detectedChangeTime = ''
    setForm(prev => {
      const updated = { ...prev }
      PUMP_CONFIGS.forEach(({ key, pumpId, fuel }) => {
        const rowsForKey = allReadings.filter(
          r => r.pump_id === pumpId && r.fuel_type === fuel && r.reading_date === date
        )
        const s1 = rowsForKey.find(r => (r.session_number || 1) === 1)
        const s2 = rowsForKey.find(r => r.session_number === 2)

        if (s1) {
          idsForDate[key] = { ...(idsForDate[key] || {}), s1: s1.id }
          updated[key] = {
            ...updated[key],
            opening_meter: parseFloat(s1.opening_meter).toFixed(2),
            closing_meter: String(s1.closing_meter),
            attendant_id:  s1.attendant_id || '',
            rtt_litres:    s1.rtt_litres ? String(s1.rtt_litres) : '',
          }
        }
        if (s2) {
          idsForDate[key] = { ...(idsForDate[key] || {}), s2: s2.id }
          updated[key] = { ...updated[key], session2: { closing_meter: String(s2.closing_meter) } }
          detectedSplit = true
          if (s2.session_time) detectedChangeTime = s2.session_time.slice(0, 5)
        }
      })
      return updated
    })
    setExistingIds(idsForDate)
    if (detectedSplit) {
      setPriceChanged(true)
      if (detectedChangeTime) setChangeTime(detectedChangeTime)
    }
  }, [])

  // Run auto-fill on mount (readings available) and on date change
  useEffect(() => {
    if (!loading && readings.length > 0) {
      autoFillOpeningMeters(readings, form.reading_date)
      applyExistingReadings(readings, form.reading_date)
    }
  }, [readings, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Shift-based attendant auto-fill runs once on mount too, independent of
  // the meter-readings load (it doesn't depend on prior readings existing).
  useEffect(() => {
    applyShiftAttendants(form.reading_date)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Shared reset used by both handleDateChange and clearForm — resets the
  // per-pump entries AND the price-change toggle/panel state together, so
  // switching dates never carries a split-day UI state onto a date that
  // doesn't have one (applyExistingReadings will re-detect and re-enable
  // it afterward if the new date actually is a saved split day).
  const resetPumpsAndPriceChange = (prev) => {
    const reset = { ...prev }
    PUMP_CONFIGS.forEach(({ key }) => { reset[key] = emptyPump() })
    return reset
  }

  // ── Date change: reset, re-fill meters + reset delivery ────
  // Previously this never reset closing_meter/attendant_id/rtt_litres, so
  // switching dates without saving left stale values from the old date
  // sitting in the form. Reset to blank first, then let auto-fill and
  // existing-entry detection repopulate correctly for the new date.
  const handleDateChange = (newDate) => {
    setDeliveryChecked(false)
    setDeliveryData(null)
    setExistingIds({})
    setPriceChanged(false)
    setChangeTime('')
    setNewPrices({ SXP: '', DXP: '' })
    setNpaReference('')
    setForm(prev => ({ ...resetPumpsAndPriceChange(prev), reading_date: newDate }))
    autoFillOpeningMeters(readings, newDate)
    applyShiftAttendants(newDate)
    applyExistingReadings(readings, newDate)
  }

  // Wires up the previously-dead "Clear form" button — resets the current
  // date's entries back to their auto-filled/existing state rather than
  // leaving half-typed values sitting in the form.
  const clearForm = () => {
    setExistingIds({})
    setPriceChanged(false)
    setChangeTime('')
    setNewPrices({ SXP: '', DXP: '' })
    setNpaReference('')
    setForm(prev => resetPumpsAndPriceChange(prev))
    autoFillOpeningMeters(readings, form.reading_date)
    applyShiftAttendants(form.reading_date)
    applyExistingReadings(readings, form.reading_date)
  }

  // ── Delivery checkbox: Option A ────────────────────────────
  const handleDeliveryToggle = async (checked) => {
    setDeliveryChecked(checked)
    setDeliveryData(null)

    if (!checked) return

    setDeliveryFetching(true)
    try {
      const res = await api.get(`/deliveries?date=${form.reading_date}`)
      const records = res.data

      if (!records || records.length === 0) {
        showToast(
          'warning',
          'No delivery record found',
          `No tanker delivery logged for ${form.reading_date}. Log it in Deliveries first.`
        )
        setDeliveryChecked(false)
        return
      }

      setDeliveryData(records)
      // Show a brief confirmation of what was found
      const summary = records
        .map(d => `${d.fuel_type}: ${parseFloat(d.actual_litres).toFixed(0)} L`)
        .join(' · ')
      showToast('info', 'Delivery found', summary)
    } catch (err) {
      showToast('error', 'Could not fetch deliveries', err.response?.data?.error || 'Check your connection')
      setDeliveryChecked(false)
    } finally {
      setDeliveryFetching(false)
    }
  }

  // ── Intra-day price change: toggle + field updates ──────────
  // A day already saved as a single (ordinary) entry per pump can't be
  // retroactively split — server/routes/meter.js treats session_number/
  // session_time as immutable on an existing row by design (same rule as
  // opening_meter), so a PUT can never stamp a changeover time onto a row
  // that was saved without one. Blocking this here avoids a half-applied
  // split: session 2 would save correctly, but session 1 would remain
  // priced as an ordinary end-of-day reading forever, exactly the bug
  // this feature exists to prevent. A date that's already a genuine split
  // (some row already has session_number 2) isn't blocked — that's just
  // re-enabling what applyExistingReadings already detected.
  const hasOrdinarySavedEntries =
    Object.keys(existingIds).length > 0 && !Object.values(existingIds).some(v => v?.s2)

  const togglePriceChanged = () => {
    if (!priceChanged && hasOrdinarySavedEntries) {
      showToast(
        'error',
        "Can't split an already-saved day",
        "This date's entries were already saved as single readings, and their session time can't be changed after the fact. Pick a date that hasn't been saved yet, or correct the price directly in Price Settings."
      )
      return
    }
    const next = !priceChanged
    setPriceChanged(next)
    if (next) {
      setForm(prev => {
        const updated = { ...prev }
        PUMP_CONFIGS.forEach(({ key }) => {
          if (!updated[key].session2) updated[key] = { ...updated[key], session2: { closing_meter: '' } }
        })
        return updated
      })
    } else {
      setChangeTime('')
      setNewPrices({ SXP: '', DXP: '' })
      setNpaReference('')
      setForm(prev => {
        const updated = { ...prev }
        PUMP_CONFIGS.forEach(({ key }) => { updated[key] = { ...updated[key], session2: null } })
        return updated
      })
    }
  }

  // Locked once the day already has a real session-2 row saved — the
  // changeover time on those rows is immutable (see the block above), so
  // letting the field stay editable would make it look editable when it
  // no longer affects anything already saved.
  const changeTimeLocked = Object.values(existingIds).some(v => v?.s2)

  const updateSession2 = (key, value) => {
    setForm(prev => ({ ...prev, [key]: { ...prev[key], session2: { ...prev[key].session2, closing_meter: value } } }))
  }

  // ── Calculations ───────────────────────────────────────────
  const calcLitres = (opening, closing) => {
    const diff = parseFloat(closing) - parseFloat(opening)
    return isNaN(diff) || diff < 0 ? 0 : diff
  }

  // useNewPrice picks which price this litres figure should preview
  // against — session 1 always previews at today's already-"current"
  // price, session 2 previews at whatever's typed into the price-change
  // panel. This is a LIVE PREVIEW ONLY: the server is authoritative and
  // recomputes amount_ghs itself from fuel_prices at save time (see
  // server/routes/meter.js's resolveEffectivePrice) — this never has to
  // be exactly right, only close enough to sanity-check before saving.
  const calcAmount = (litres, fuelType, useNewPrice = false) => {
    const price = useNewPrice && newPrices[fuelType]
      ? parseFloat(newPrices[fuelType])
      : parseFloat(prices[fuelType]?.price_per_litre || 0)
    return (litres * price).toFixed(2)
  }

  const pumpLitres = (key) => {
    const data = form[key]
    const l1 = calcLitres(data.opening_meter, data.closing_meter)
    const l2 = data.session2 ? calcLitres(data.closing_meter, data.session2.closing_meter) : 0
    return l1 + l2
  }

  // Per-pump revenue preview, session-aware: session 1's litres × the old
  // price plus session 2's litres × the new price, summed — NOT combined
  // litres × a single price, which would mix two different rates into
  // one multiplication and misprice the total the moment two prices are
  // in play for the same day.
  const pumpAmount = (key, fuel) => {
    const data = form[key]
    const l1 = calcLitres(data.opening_meter, data.closing_meter)
    const a1 = parseFloat(calcAmount(l1, fuel, false))
    const l2 = data.session2 ? calcLitres(data.closing_meter, data.session2.closing_meter) : 0
    const a2 = l2 ? parseFloat(calcAmount(l2, fuel, true)) : 0
    return a1 + a2
  }

  // ── Save ───────────────────────────────────────────────────
  // Branches per pump/fuel row: existingIds[key].s1/.s2 set -> PUT
  // (correcting an already-saved reading), unset -> POST (first entry for
  // that session on this date). This was the actual bug in the original
  // version of this function: it always POSTed regardless, so re-saving a
  // date that already had entries hit the unique constraint on
  // (reading_date, pump_id, fuel_type[, session_number]) with no way to
  // edit instead.
  const handleSave = async () => {
    if (priceChanged && !changeTime) {
      showToast('error', 'Price change time required', 'Enter the time the price changed before saving.')
      return
    }
    setSaving(true)
    try {
      // A genuine mid-shift price change must be posted before any
      // session 2 meter reading — meter.js resolves each session's price
      // by reading fuel_prices at write time, so if the new price row
      // doesn't exist yet, session 2 would silently price at the old rate.
      if (priceChanged) {
        for (const fuel of ['SXP', 'DXP']) {
          if (newPrices[fuel]) {
            await api.post('/prices', {
              fuel_type: fuel,
              price_per_litre: parseFloat(newPrices[fuel]),
              effective_date: form.reading_date,
              effective_time: changeTime,
              npa_reference: npaReference || undefined,
            })
          }
        }
      }

      let updated = 0, created = 0
      for (const { key, pumpId, fuel } of PUMP_CONFIGS) {
        const pump = form[key]
        if (!pump.closing_meter) continue
        const ids = existingIds[key] || {}

        // Session 1 — on a split day, every pump's session-1 row is
        // stamped with the changeover time regardless of whether that
        // specific pump has any session-2 litres at all: without it, a
        // pump with no session-2 entry (e.g. it wasn't used after the
        // change) would resolve as an ordinary end-of-day reading and
        // pick up whichever price is latest for the date — the NEW
        // one — mispricing litres that were entirely sold before the
        // change actually happened.
        if (ids.s1) {
          // PUT only accepts closing_meter/attendant_id/rtt_litres — see
          // server/routes/meter.js. reading_date/pump_id/fuel_type/
          // opening_meter/session_number/session_time are immutable on an
          // existing row by design.
          await api.put(`/meter/${ids.s1}`, {
            closing_meter: parseFloat(pump.closing_meter),
            attendant_id:  pump.attendant_id || null,
            rtt_litres:    parseFloat(pump.rtt_litres) || 0,
          })
          updated++
        } else {
          const litres = calcLitres(pump.opening_meter, pump.closing_meter)
          const amount = calcAmount(litres, fuel, false)
          await api.post('/meter', {
            reading_date:  form.reading_date,
            pump_id:       pumpId,
            fuel_type:     fuel,
            attendant_id:  pump.attendant_id || null,
            opening_meter: parseFloat(pump.opening_meter) || 0,
            closing_meter: parseFloat(pump.closing_meter),
            amount_ghs:    parseFloat(amount),
            rtt_litres:    parseFloat(pump.rtt_litres) || 0,
            ...(priceChanged ? { session_number: 1, session_time: changeTime } : {}),
          })
          created++
        }

        // Session 2 — only when this pump actually has a closing reading
        // entered for after the changeover. RTT is deliberately sent as 0
        // here, not pump.rtt_litres — it's recorded once on session 1's
        // row; sending the same value on both would double-count it in
        // the monthly RTT summary column.
        if (priceChanged && pump.session2?.closing_meter) {
          if (ids.s2) {
            await api.put(`/meter/${ids.s2}`, {
              closing_meter: parseFloat(pump.session2.closing_meter),
              attendant_id:  pump.attendant_id || null,
              rtt_litres:    0,
            })
            updated++
          } else {
            const litres2 = calcLitres(pump.closing_meter, pump.session2.closing_meter)
            const amount2 = calcAmount(litres2, fuel, true)
            await api.post('/meter', {
              reading_date:  form.reading_date,
              pump_id:       pumpId,
              fuel_type:     fuel,
              attendant_id:  pump.attendant_id || null,
              opening_meter: parseFloat(pump.closing_meter) || 0,
              closing_meter: parseFloat(pump.session2.closing_meter),
              amount_ghs:    parseFloat(amount2),
              rtt_litres:    0,
              session_number: 2,
              session_time: changeTime,
            })
            created++
          }
        }
      }

      const summary = updated && created
        ? `${created} new, ${updated} updated`
        : updated
          ? `${updated} entr${updated > 1 ? 'ies' : 'y'} updated`
          : `${created} entr${created > 1 ? 'ies' : 'y'} saved`

      showToast('success', 'Meter entry saved', `${form.reading_date} — ${summary}`)
      const [meterRes, pricesRes] = await Promise.all([
        api.get('/meter'),
        // Refresh "current" price too — a split-day save can genuinely
        // change it, and the live preview above reads from this state.
        isAdminOrManager ? api.get('/prices/current') : Promise.resolve({ data: prices }),
      ])
      setReadings(meterRes.data)
      setPrices(pricesRes.data)
      applyExistingReadings(meterRes.data, form.reading_date)
    } catch (err) {
      showToast('error', 'Save failed', err.response?.data?.error || 'Check your connection')
    } finally {
      setSaving(false)
    }
  }

  const updatePump = (key, field, value) => {
    setForm(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }

  // ── Totals ─────────────────────────────────────────────────
  // Session-aware: pumpLitres/pumpAmount above already fold session 2 in
  // where it exists, so these totals are correct whether or not today is
  // a split day — an ordinary day's session2 is always null, contributing
  // 0 everywhere it's summed.
  const totalSXP     = ['P1_SXP','P2_SXP'].reduce((s, k) => s + pumpLitres(k), 0)
  const totalDXP     = ['P1_DXP','P2_DXP','P3_DXP'].reduce((s, k) => s + pumpLitres(k), 0)
  const totalLitres  = totalSXP + totalDXP
  const dealerEarnings = totalLitres * dealerMargin
  const sxpRevenue   = ['P1_SXP','P2_SXP'].reduce((s, k) => s + pumpAmount(k, 'SXP'), 0)
  const dxpRevenue   = ['P1_DXP','P2_DXP','P3_DXP'].reduce((s, k) => s + pumpAmount(k, 'DXP'), 0)
  const totalRevenue = sxpRevenue + dxpRevenue
  const session1Revenue = PUMP_CONFIGS.reduce((s, { key, fuel }) => {
    const l1 = calcLitres(form[key].opening_meter, form[key].closing_meter)
    return s + parseFloat(calcAmount(l1, fuel, false))
  }, 0)
  const session2Revenue = totalRevenue - session1Revenue

  // ── Recent readings — attendant filter options ──────────────
  // Derived from `readings` (already loaded for every role, unlike the
  // gated /attendants list which 403s for Viewer) so the filter works
  // identically for Admin, Manager, and Viewer.
  const attendantOptions = useMemo(() => {
    const map = new Map()
    readings.forEach(r => {
      if (r.attendant_id && r.attendants?.name) map.set(r.attendant_id, r.attendants.name)
    })
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [readings])

  const historyFilterActive = Boolean(historyDate || historyAttendant || historyPump)

  const filteredReadings = useMemo(() => {
    if (!historyFilterActive) return readings.slice(0, 20)
    return readings.filter(r => {
      if (historyDate && r.reading_date !== historyDate) return false
      if (historyAttendant && String(r.attendant_id) !== String(historyAttendant)) return false
      if (historyPump && r.pump_id !== historyPump) return false
      return true
    })
  }, [readings, historyDate, historyAttendant, historyPump, historyFilterActive])

  const clearHistoryFilters = () => {
    setHistoryDate('')
    setHistoryAttendant('')
    setHistoryPump('')
  }

  // Group the (already reading_date-descending-ordered) filtered rows
  // into per-date blocks so the date renders once per block instead of
  // once per pump/fuel row — this is the actual fix for "hard to find a
  // specific date/attendant": the eye scans date banners, not 5 nearly
  // identical rows per date.
  const historyGroups = useMemo(() => {
    const groups = []
    let current = null
    filteredReadings.forEach(r => {
      if (!current || current.date !== r.reading_date) {
        current = { date: r.reading_date, rows: [] }
        groups.push(current)
      }
      current.rows.push(r)
    })
    return groups
  }, [filteredReadings])

  const formatHistoryDate = (isoDate) => {
    const d = new Date(isoDate + 'T00:00:00')
    if (isNaN(d.getTime())) return isoDate
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  }

  if (loading) return <div className="loading-screen">Loading meter book...</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Meter Book</h2>
          <p>Per-pump daily readings · P1 (SXP+DXP) · P2 (SXP+DXP) · P3 (DXP only)</p>
        </div>
      </div>

      {isAdminOrManager && (
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">
              {Object.keys(existingIds).length > 0 ? `Editing entry — ${form.reading_date}` : `Daily entry — ${form.reading_date}`}
            </div>
            {Object.keys(existingIds).length > 0 && (
              <span className="badge badge-amber">Editing saved entries</span>
            )}
          </div>

          {/* Date picker */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:16, marginBottom:14, flexWrap:'wrap' }}>
            <div className="form-group" style={{ maxWidth:220 }}>
              <label className="form-label">Date</label>
              <input
                className="form-input"
                type="date"
                value={form.reading_date}
                onChange={e => handleDateChange(e.target.value)}
              />
            </div>

            {/* Delivery toggle — Option A */}
            <div
              style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'8px 14px',
                background: deliveryChecked ? 'var(--amber-subtle)' : 'var(--surface-2)',
                border:`1px solid ${deliveryChecked ? 'var(--amber-border)' : 'var(--border)'}`,
                borderRadius:'var(--r-md)',
                cursor: deliveryFetching ? 'wait' : 'pointer',
                transition:'all 0.12s',
                userSelect:'none',
              }}
              onClick={() => !deliveryFetching && handleDeliveryToggle(!deliveryChecked)}
            >
              {/* Custom checkbox */}
              <div style={{
                width:16, height:16,
                border:`2px solid ${deliveryChecked ? 'var(--amber)' : 'var(--border-strong)'}`,
                borderRadius:3,
                background: deliveryChecked ? 'var(--amber)' : 'transparent',
                display:'flex', alignItems:'center', justifyContent:'center',
                flexShrink:0,
                transition:'all 0.12s',
              }}>
                {deliveryChecked && (
                  <svg viewBox="0 0 10 8" fill="none" width={10} height={10}>
                    <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <span style={{ fontSize:13, fontWeight:500, color: deliveryChecked ? 'var(--amber)' : 'var(--text-2)' }}>
                {deliveryFetching ? 'Checking deliveries…' : 'Delivery received today'}
              </span>
            </div>

            {/* Price-changed toggle */}
            <div
              style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'8px 14px',
                background: priceChanged ? 'var(--amber-subtle)' : 'var(--surface-2)',
                border:`1px solid ${priceChanged ? 'var(--amber-border)' : 'var(--border)'}`,
                borderRadius:'var(--r-md)',
                cursor:'pointer',
                transition:'all 0.12s',
                userSelect:'none',
              }}
              onClick={togglePriceChanged}
            >
              <div style={{
                width:16, height:16,
                border:`2px solid ${priceChanged ? 'var(--amber)' : 'var(--border-strong)'}`,
                borderRadius:3,
                background: priceChanged ? 'var(--amber)' : 'transparent',
                display:'flex', alignItems:'center', justifyContent:'center',
                flexShrink:0,
                transition:'all 0.12s',
              }}>
                {priceChanged && (
                  <svg viewBox="0 0 10 8" fill="none" width={10} height={10}>
                    <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <span style={{ fontSize:13, fontWeight:500, color: priceChanged ? 'var(--amber)' : 'var(--text-2)' }}>
                Price changed today?
              </span>
            </div>
          </div>

          {/* Delivery info strip — shown when delivery found */}
          {deliveryChecked && deliveryData && deliveryData.length > 0 && (
            <div style={{
              display:'flex', gap:12, flexWrap:'wrap',
              padding:'10px 14px',
              background:'var(--amber-subtle)',
              border:'1px solid var(--amber-border)',
              borderRadius:'var(--r-md)',
              marginBottom:14,
            }}>
              <span style={{ fontSize:12, fontWeight:600, color:'var(--amber)', marginRight:4 }}>
                <i className="ph ph-truck" style={{ marginRight:4 }}></i>
                Delivery logged for {form.reading_date}:
              </span>
              {deliveryData.map(d => (
                <span key={d.id} style={{ fontSize:12, color:'var(--text-2)' }}>
                  <strong>{d.fuel_type}</strong> — {parseFloat(d.actual_litres).toFixed(0)} L actual
                  {parseFloat(d.shortage_litres) > 0 && (
                    <span style={{ color:'var(--red)', marginLeft:4 }}>
                      ({parseFloat(d.shortage_litres).toFixed(0)} L short)
                    </span>
                  )}
                  &nbsp;· BOL: {d.bol_number}
                </span>
              ))}
              <span style={{ fontSize:11, color:'var(--text-3)', marginLeft:'auto' }}>
                Variance will be adjusted in Tank Stock
              </span>
            </div>
          )}

          {/* Price-change panel — shown when the toggle above is on */}
          {priceChanged && (
            <div style={{
              padding:14,
              background:'var(--amber-subtle)',
              border:'1px solid var(--amber-border)',
              borderRadius:'var(--r-md)',
              marginBottom:14,
            }}>
              <div style={{ fontSize:10, fontWeight:600, color:'var(--amber)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:12 }}>
                Price change details
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Time of change</label>
                  <input
                    className="form-input"
                    type="time"
                    value={changeTime}
                    onChange={e => setChangeTime(e.target.value)}
                    disabled={changeTimeLocked}
                  />
                  {changeTimeLocked && (
                    <span className="form-hint">Locked — already saved for this date</span>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">SXP — new (GHS/L)</label>
                  <input
                    className="form-input"
                    type="number"
                    step="0.0001"
                    placeholder={prices.SXP?.price_per_litre ? `was ${parseFloat(prices.SXP.price_per_litre).toFixed(4)}` : '0.0000'}
                    value={newPrices.SXP}
                    onChange={e => setNewPrices(prev => ({ ...prev, SXP: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">DXP — new (GHS/L)</label>
                  <input
                    className="form-input"
                    type="number"
                    step="0.0001"
                    placeholder={prices.DXP?.price_per_litre ? `was ${parseFloat(prices.DXP.price_per_litre).toFixed(4)}` : '0.0000'}
                    value={newPrices.DXP}
                    onChange={e => setNewPrices(prev => ({ ...prev, DXP: e.target.value }))}
                  />
                </div>
                <div className="form-group" style={{ gridColumn:'span 2' }}>
                  <label className="form-label">NPA reference</label>
                  <input
                    className="form-input"
                    placeholder="NPA Bulletin — mid-month revision"
                    value={npaReference}
                    onChange={e => setNpaReference(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ fontSize:11, color:'var(--text-2)', marginTop:10, lineHeight:1.5 }}>
                Every pump's reading below now splits into Session 1 (up to {changeTime || 'the time above'}) and Session 2 (from {changeTime || 'the time above'}). A pump with no litres sold after the change can be left blank in Session 2 — its Session 1 reading will still correctly price at the old rate.
              </div>
            </div>
          )}

          {/* Pump sections */}
          {PUMP_CONFIGS.map(({ key, pumpId, label, fuel, dotColor }) => {
            const data    = form[key]
            const litres  = calcLitres(data.opening_meter, data.closing_meter)
            const amount  = calcAmount(litres, fuel, false)
            const tagBg   = pumpId === 'P3' ? 'var(--amber)' : 'var(--charcoal)'
            const litres2 = data.session2 ? calcLitres(data.closing_meter, data.session2.closing_meter) : 0
            const amount2 = data.session2 ? calcAmount(litres2, fuel, true) : '0.00'

            return (
              <div key={key} style={{ border:'1px solid var(--border)', borderRadius:'var(--r-md)', overflow:'hidden', marginBottom:12 }}>
                {/* Pump header */}
                <div style={{ background:'var(--surface-2)', padding:'10px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid var(--border)' }}>
                  <span style={{ background:tagBg, color:'#fff', padding:'2px 9px', borderRadius:4, fontSize:11, fontWeight:700 }}>
                    {pumpId}
                  </span>
                  <span style={{ fontSize:13, fontWeight:500, color:'var(--charcoal)' }}>
                    {label} — {fuel}
                  </span>
                  {existingIds[key]?.s1 && (
                    <span className="badge badge-amber" style={{ fontSize:10 }}>Already saved — editing</span>
                  )}
                  <div style={{ width:8, height:8, background:dotColor, borderRadius:'50%', marginLeft:'auto' }}></div>
                </div>

                {/* Pump body */}
                <div style={{ padding:14 }}>
                  <div className="form-row-4" style={{ marginBottom:8 }}>
                    <div className="form-group">
                      <label className="form-label">{priceChanged ? 'Opening (session 1)' : 'Opening meter'}</label>
                      <input
                        className="form-input is-auto"
                        value={data.opening_meter}
                        readOnly
                        placeholder="Auto-filled"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{priceChanged ? 'Closing (session 1)' : 'Closing meter'}</label>
                      <input
                        className="form-input"
                        type="number"
                        value={data.closing_meter}
                        onChange={e => updatePump(key, 'closing_meter', e.target.value)}
                        placeholder="Enter reading"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Litres sold</label>
                      <input className="form-input is-calc" value={litres.toFixed(2)} readOnly />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Amount (GHS)</label>
                      <input className="form-input is-calc" value={amount} readOnly />
                    </div>
                  </div>

                  {priceChanged && (
                    <div className="form-row-4" style={{ marginBottom:8, padding:10, background:'var(--amber-subtle)', border:'1px solid var(--amber-border)', borderRadius:'var(--r-sm)' }}>
                      <div className="form-group">
                        <label className="form-label" style={{ color:'var(--amber)' }}>Opening (session 2)</label>
                        <input className="form-input is-auto" value={data.closing_meter || ''} readOnly placeholder="= session 1 closing" />
                      </div>
                      <div className="form-group">
                        <label className="form-label" style={{ color:'var(--amber)' }}>Closing (session 2)</label>
                        <input
                          className="form-input"
                          type="number"
                          value={data.session2?.closing_meter || ''}
                          onChange={e => updateSession2(key, e.target.value)}
                          placeholder="Leave blank if unused after change"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label" style={{ color:'var(--amber)' }}>Litres sold</label>
                        <input className="form-input is-calc" value={litres2.toFixed(2)} readOnly />
                      </div>
                      <div className="form-group">
                        <label className="form-label" style={{ color:'var(--amber)' }}>Amount (GHS)</label>
                        <input className="form-input is-calc" value={amount2} readOnly />
                      </div>
                    </div>
                  )}

                  <div style={{ display:'flex', gap:14 }}>
                    <div className="form-group" style={{ flex:1, maxWidth:200 }}>
                      <label className="form-label">Attendant</label>
                      <select
                        className="form-select"
                        value={data.attendant_id}
                        onChange={e => updatePump(key, 'attendant_id', e.target.value)}
                      >
                        <option value="">Select attendant</option>
                        {attendants.filter(a => a.is_active).map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group" style={{ flex:1, maxWidth:200 }}>
                      <label className="form-label" style={{ color:'var(--amber)' }}>RTT litres (optional)</label>
                      <input
                        className="form-input"
                        type="number"
                        placeholder="0.00"
                        style={{ borderColor:'var(--amber-border)' }}
                        value={data.rtt_litres}
                        onChange={e => updatePump(key, 'rtt_litres', e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Totals band */}
          <div style={{
            background:'var(--orange-subtle)',
            border:'1px solid var(--orange-border)',
            borderRadius:'var(--r-md)',
            padding:'14px 16px',
            marginTop:12,
          }}>
            <div style={{ fontSize:10, fontWeight:600, color:'var(--charcoal)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:12 }}>
              Daily totals — auto-calculated
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:8 }}>
              {[
                { label:'Total SXP',      value:`${totalSXP.toFixed(2)} L`,    calc:true },
                { label:'Total DXP',      value:`${totalDXP.toFixed(2)} L`,    calc:true },
                { label:'Total litres',   value:`${totalLitres.toFixed(2)} L`, calc:false },
                { label:'SXP revenue',    value:`GHS ${sxpRevenue.toFixed(2)}`, calc:true },
                { label:'Total revenue',  value:`GHS ${totalRevenue.toFixed(2)}`, calc:false },
                { label:'Dealer earnings ★', value:`GHS ${dealerEarnings.toFixed(2)}`, calc:true, green:true },
              ].map(cell => (
                <div key={cell.label} style={{ textAlign:'center' }}>
                  <div style={{ fontSize:10, color:'var(--text-3)', marginBottom:4, textTransform:'uppercase', letterSpacing:0.3 }}>
                    {cell.label}
                  </div>
                  <div style={{
                    fontSize:16, fontWeight:700,
                    color: cell.green ? 'var(--green)' : cell.calc ? 'var(--calc-text)' : 'var(--charcoal)',
                    fontFamily: cell.calc ? 'var(--font-mono)' : 'var(--font)',
                  }}>
                    {cell.value}
                  </div>
                </div>
              ))}
            </div>
            {priceChanged && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:12, paddingTop:12, borderTop:'1px dashed var(--orange-border)' }}>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:10, color:'var(--text-3)', marginBottom:4, textTransform:'uppercase' }}>Session 1 subtotal</div>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--calc-text)', fontFamily:'var(--font-mono)' }}>GHS {session1Revenue.toFixed(2)}</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:10, color:'var(--text-3)', marginBottom:4, textTransform:'uppercase' }}>Session 2 subtotal</div>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--calc-text)', fontFamily:'var(--font-mono)' }}>GHS {session2Revenue.toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>

          <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:16 }}>
            <button className="btn btn-ghost" onClick={clearForm}>Clear form</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <i className="ph ph-floppy-disk"></i>
              {saving ? 'Saving…' : Object.keys(existingIds).length > 0 ? 'Update entries' : 'Save entry'}
            </button>
          </div>
        </div>
      )}

      {/* History table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent readings</div>
          {historyFilterActive && (
            <span className="badge badge-navy">
              {filteredReadings.length} match{filteredReadings.length !== 1 ? 'es' : ''}
            </span>
          )}
        </div>

        {/* Filters — date, attendant, pump. All client-side over the
            already-loaded `readings` array; see historyFilterActive
            above for why no extra fetch is needed. */}
        <div style={{ display:'flex', alignItems:'flex-end', gap:12, flexWrap:'wrap', marginBottom:14 }}>
          <div className="form-group" style={{ maxWidth:170 }}>
            <label className="form-label">Date</label>
            <input
              className="form-input"
              type="date"
              value={historyDate}
              onChange={e => setHistoryDate(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ maxWidth:200 }}>
            <label className="form-label">Attendant</label>
            <select
              className="form-select"
              value={historyAttendant}
              onChange={e => setHistoryAttendant(e.target.value)}
            >
              <option value="">All attendants</option>
              {attendantOptions.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ maxWidth:140 }}>
            <label className="form-label">Pump</label>
            <select
              className="form-select"
              value={historyPump}
              onChange={e => setHistoryPump(e.target.value)}
            >
              <option value="">All pumps</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </div>
          {historyFilterActive && (
            <button className="btn btn-ghost btn-sm" onClick={clearHistoryFilters}>
              <i className="ph ph-x"></i> Clear filters
            </button>
          )}
          {!historyFilterActive && (
            <span style={{ fontSize:11, color:'var(--text-3)', paddingBottom:8 }}>
              Showing 20 most recent — filter to search the full history
            </span>
          )}
        </div>

        <div className="table-wrap">
          <table className="tbl-history">
            <thead>
              <tr>
                <th>Pump</th><th>Fuel</th><th>Session</th><th>Attendant</th><th>Opening</th>
                <th>Closing</th><th>Litres sold</th><th>Amount (GHS)</th><th>RTT</th>
              </tr>
            </thead>
            <tbody>
              {historyGroups.map((group, groupIdx) => (
                <Fragment key={group.date}>
                  <tr className="history-date-group" key={`date-${group.date}`}>
                    <td colSpan={9}>
                      {formatHistoryDate(group.date)}
                      <span style={{ marginLeft:8, fontWeight:400, fontSize:11, color:'var(--text-3)', textTransform:'none' }}>
                        {group.rows.length} reading{group.rows.length !== 1 ? 's' : ''}
                      </span>
                    </td>
                  </tr>
                  {group.rows.map(r => (
                    <tr key={r.id} className={groupIdx % 2 === 1 ? 'history-row-alt' : undefined}>
                      <td><span className="badge badge-navy">{r.pump_id}</span></td>
                      <td><span className={`badge ${r.fuel_type === 'SXP' ? 'badge-blue' : 'badge-amber'}`}>{r.fuel_type}</span></td>
                      <td>
                        {r.session_number === 2 ? (
                          <span className="badge badge-amber" style={{ fontSize:10 }}>
                            2{r.session_time ? ` · from ${String(r.session_time).slice(0,5)}` : ''}
                          </span>
                        ) : (
                          <span style={{ color:'var(--text-3)' }}>—</span>
                        )}
                      </td>
                      <td>{r.attendants?.name || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                      <td className="td-calc">{parseFloat(r.opening_meter).toFixed(2)}</td>
                      <td className="td-calc">{parseFloat(r.closing_meter).toFixed(2)}</td>
                      <td className="td-calc">{parseFloat(r.litres_sold).toFixed(2)}</td>
                      <td className="td-calc">{parseFloat(r.amount_ghs).toFixed(2)}</td>
                      <td className="td-calc" style={{ color:'var(--amber)' }}>
                        {parseFloat(r.rtt_litres || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              {historyGroups.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ textAlign:'center', color:'var(--text-3)', padding:24 }}>
                    {historyFilterActive
                      ? 'No readings match these filters'
                      : 'No readings yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
