/* Quote Builder: Summit Home Services (fictional). Plain JS, no build step.
 *
 * Money is handled in integer cents. Every line total is rounded to the cent,
 * then everything else is summed from those rounded lines, so the quote the
 * customer sees always adds up on paper.
 */

/* ------------------------------------------------------------------ */
/* Pure math (no DOM, so it can be require()d and tested in Node)      */
/* ------------------------------------------------------------------ */
(function (root) {
  // Round a dollar amount to whole cents, half away from zero.
  // The tiny epsilon fixes float artifacts like 1.005 * 100 = 100.49999...
  function cents(dollars) {
    const n = Number(dollars) || 0;
    const s = n < 0 ? -1 : 1;
    return s * Math.round(Math.abs(n) * 100 + 1e-6);
  }
  function roundCents(c) {
    const s = c < 0 ? -1 : 1;
    return s * Math.round(Math.abs(c) + 1e-9);
  }
  function lineCents(line) {
    return cents((Number(line.qty) || 0) * (Number(line.price) || 0));
  }

  /**
   * lines: [{type:'labor'|'fee'|'part', qty, unit, price, cost}]
   * opts:  {discountType:'none'|'pct'|'amt', discountValue, taxRate, laborCostRate}
   * Returns amounts in cents (margin as a 0..1 ratio, or null with no revenue).
   */
  function calc(lines, opts) {
    opts = opts || {};
    let parts = 0, labor = 0, fees = 0, partsCost = 0, laborHours = 0;
    for (const l of lines || []) {
      const t = lineCents(l);
      if (l.type === 'part') {
        parts += t;
        partsCost += cents((Number(l.qty) || 0) * (Number(l.cost) || 0));
      } else if (l.type === 'labor') {
        labor += t;
        if ((l.unit || 'hr') === 'hr') laborHours += Number(l.qty) || 0;
      } else {
        fees += t;
      }
    }
    const subtotal = parts + labor + fees;

    let discount = 0;
    const dv = Math.max(0, Number(opts.discountValue) || 0);
    if (opts.discountType === 'pct') discount = roundCents(subtotal * Math.min(dv, 100) / 100);
    else if (opts.discountType === 'amt') discount = cents(dv);
    discount = Math.max(0, Math.min(discount, Math.max(subtotal, 0)));

    // Tax applies to parts only. A discount is spread across the quote, so the
    // parts share of the discount also comes off the taxable amount.
    const partsDiscount = subtotal > 0 ? roundCents(discount * parts / subtotal) : 0;
    const taxable = Math.max(0, parts - partsDiscount);
    const tax = roundCents(taxable * (Number(opts.taxRate) || 0));

    const net = subtotal - discount;            // revenue before tax
    const total = net + tax;
    const laborCost = cents(laborHours * (Number(opts.laborCostRate) || 0));
    const grossProfit = net - partsCost - laborCost;
    const margin = net > 0 ? grossProfit / net : null;

    return { parts, labor, fees, subtotal, discount, partsDiscount, taxable, tax, net, total,
      partsCost, laborHours, laborCost, grossProfit, margin };
  }

  function marginBand(m) {
    if (m === null || m === undefined || isNaN(m)) return 'none';
    if (m < 0.35) return 'bad';
    if (m <= 0.50) return 'warn';
    return 'good';
  }

  // Unicode-safe base64url, for the approval link.
  function encode(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const QuoteMath = { cents, lineCents, calc, marginBand, encode, decode };
  root.QuoteMath = QuoteMath;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuoteMath;
})(typeof window !== 'undefined' ? window : globalThis);

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
if (typeof document !== 'undefined') (function () {
  'use strict';
  const S = window.SUMMIT;
  const M = window.QuoteMath;
  const co = S.company;
  const $ = id => document.getElementById(id);
  const PB = Object.fromEntries(S.priceBook.map(p => [p.sku, p]));

  const KEY_QUOTES = 'qb.v1.quotes';
  const KEY_CURRENT = 'qb.v1.current';
  const KEY_APPROVALS = 'qb.v1.approvals';
  const KEY_SETTINGS = 'qb.v1.settings';

  const OPTION_NAMES = ['Good', 'Better', 'Best'];
  const STATUS = { draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined' };
  const STATUS_CHIP = { draft: '', sent: 'info', approved: 'good', declined: 'bad' };
  const DEFAULT_TERMS = 'Price includes parts, labor and cleanup for the work listed. Parts carry the manufacturer warranty; Summit labor is guaranteed for 1 year. Equipment replacements require a 50% deposit when scheduled, balance due on completion. Additional repairs found during the work will be quoted before we proceed.';

  const TEMPLATES = [
    { id: 'cap', name: 'AC capacitor replacement', trade: 'HVAC', issue: 'AC blowing warm air. Run capacitor tested out of spec; replace capacitor and test system.', items: [['TRIP', 1], ['LAB-STD', 1], ['HV-CAP45', 1]] },
    { id: 'wh', name: 'Water heater replacement (50 gal gas)', trade: 'Plumbing', issue: 'Water heater leaking from tank. Replace with new 50 gal gas unit, new T&P valve and connections; haul away old tank.', items: [['TRIP', 1], ['LAB-STD', 4], ['PL-WH50', 1], ['PL-TPR', 1], ['PL-PEX', 1]], custom: [{ type: 'fee', desc: 'Haul-away & disposal of old tank', qty: 1, unit: 'ea', price: 75, cost: 0 }] },
    { id: 'dp', name: 'Washer drain pump', trade: 'Appliance', issue: 'Washer not draining (code 5E). Drain pump seized; replace pump and run test cycle.', items: [['TRIP', 1], ['LAB-STD', 1], ['AP-DRPUMP', 1]] },
    { id: 'ign', name: 'Furnace igniter', trade: 'HVAC', issue: 'Furnace not lighting. Hot surface igniter cracked; replace igniter, clean flame sensor, verify operation.', items: [['TRIP', 1], ['LAB-STD', 1], ['HV-IGN', 1]] },
    { id: 'toilet', name: 'Toilet rebuild', trade: 'Plumbing', issue: 'Toilet running constantly and rocking at base. Replace fill valve, reset toilet on new wax ring.', items: [['TRIP', 1], ['LAB-STD', 1], ['PL-FILL', 1], ['PL-WAXR', 1]] },
    { id: 'belt', name: 'Dryer belt & idler', trade: 'Appliance', issue: 'Dryer squealing and drum not turning. Replace drum belt and idler pulley.', items: [['TRIP', 1], ['LAB-STD', 1], ['AP-BELT', 1]] },
  ];
  const DISCOUNT_PRESETS = [
    { label: 'Senior / veteran discount', type: 'pct', value: 10, short: 'Senior/veteran 10%' },
    { label: 'Repeat customer discount', type: 'pct', value: 5, short: 'Repeat customer 5%' },
    { label: 'Mailer coupon', type: 'amt', value: 25, short: '$25 coupon' },
  ];

  /* ---------- helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = c => (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = c => '$' + Math.round(c / 100).toLocaleString('en-US');
  const uid = () => Math.random().toString(36).slice(2, 9);
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoDate(d); };
  function parseDate(iso) { const [y, m, d] = String(iso || '').split('-').map(Number); return y ? new Date(y, m - 1, d) : new Date(); }
  const fmtDate = iso => parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtStamp = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtQty = q => { const n = Number(q) || 0; return Number.isInteger(n) ? String(n) : String(+n.toFixed(2)); };
  const clone = o => JSON.parse(JSON.stringify(o));
  const todayIso = isoDate(new Date());

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  function lineFromSku(sku, qty) {
    const p = PB[sku];
    return { id: uid(), sku, type: p.type, desc: p.name, qty: qty == null ? 1 : qty, unit: p.unit, price: p.price, cost: p.type === 'part' ? p.cost : null };
  }
  function laborLine(hours, afterHours) {
    return lineFromSku(afterHours ? 'LAB-AH' : 'LAB-STD', hours);
  }
  function templateLines(t, afterHours) {
    const out = t.items.map(([sku, q]) => sku === 'LAB-STD' ? laborLine(q, afterHours) : lineFromSku(sku, q));
    (t.custom || []).forEach(c => out.push({ id: uid(), sku: null, ...c }));
    return out;
  }

  /* ---------- quote model ---------- */
  function blankQuote(number) {
    return {
      id: uid(), number, status: 'draft', createdAt: Date.now(), updatedAt: Date.now(),
      customer: { name: '', phone: '', address: '', zip: '' }, issue: '', techId: S.techs[0].id,
      date: todayIso, validUntil: addDays(todayIso, 14), afterHours: false,
      discount: { type: 'none', value: 0, label: '' }, gbb: false,
      options: [{ id: uid(), name: 'Good', title: '', lines: [lineFromSku('TRIP', 1)] }],
      active: 0, terms: DEFAULT_TERMS, approval: null, declined: null,
    };
  }
  function custFrom(id) { const c = S.byId(S.customers, id); return { name: c.name, phone: c.phone, address: c.address, zip: c.zip }; }

  function seedQuotes() {
    const t = Date.now(), H = 3600e3, D = 24 * H;
    const T = id => TEMPLATES.find(x => x.id === id);

    // 1) The example the visitor lands on: a Good / Better / Best AC repair.
    const ac = blankQuote('Q-1042');
    Object.assign(ac, {
      customer: custFrom('C01'), techId: 'T1', gbb: true, active: 1, updatedAt: t - 20 * 60e3,
      issue: 'AC blowing warm air, outdoor unit humming. Run capacitor failed and contactor points are pitted; condenser fan motor bearings are noisy.',
      discount: { type: 'pct', value: 5, label: 'Repeat customer discount' },
      options: [
        { id: uid(), name: 'Good', title: 'Replace capacitor', lines: [lineFromSku('TRIP'), laborLine(1), lineFromSku('HV-CAP45')] },
        { id: uid(), name: 'Better', title: 'Capacitor + contactor', lines: [lineFromSku('TRIP'), laborLine(1.5), lineFromSku('HV-CAP45'), lineFromSku('HV-CONT')] },
        { id: uid(), name: 'Best', title: 'Capacitor, contactor + fan motor', lines: [lineFromSku('TRIP'), laborLine(2.5), lineFromSku('HV-CAP45'), lineFromSku('HV-CONT'), lineFromSku('HV-FMOT')] },
      ],
    });

    const wh = blankQuote('Q-1041');
    Object.assign(wh, { customer: custFrom('C02'), techId: 'T2', status: 'sent', issue: T('wh').issue,
      date: addDays(todayIso, -1), validUntil: addDays(todayIso, 13), createdAt: t - D, updatedAt: t - 22 * H,
      options: [{ id: uid(), name: 'Good', title: '', lines: templateLines(T('wh')) }] });

    const dp = blankQuote('Q-1040');
    Object.assign(dp, { customer: custFrom('C03'), techId: 'T3', status: 'approved', issue: T('dp').issue,
      date: addDays(todayIso, -2), validUntil: addDays(todayIso, 12), createdAt: t - 2 * D, updatedAt: t - 2 * D + 3 * H,
      options: [{ id: uid(), name: 'Good', title: '', lines: templateLines(T('dp')) }],
      approval: { name: 'Carla Jensen', at: t - 2 * D + 3 * H, option: 0 } });

    const disp = blankQuote('Q-1039');
    Object.assign(disp, { customer: custFrom('C06'), techId: 'T2', status: 'declined',
      issue: 'Garbage disposal jammed and leaking at the body. Replace with new 3/4 HP unit.',
      date: addDays(todayIso, -4), validUntil: addDays(todayIso, 10), createdAt: t - 4 * D, updatedAt: t - 3 * D,
      discount: { type: 'pct', value: 10, label: 'Senior / veteran discount' },
      options: [{ id: uid(), name: 'Good', title: '', lines: [lineFromSku('TRIP'), laborLine(1.5), lineFromSku('PL-DISP')] }],
      declined: { at: t - 3 * D } });

    const ign = blankQuote('Q-1038');
    Object.assign(ign, { customer: custFrom('C04'), techId: 'T4', status: 'draft', issue: T('ign').issue,
      date: addDays(todayIso, -5), validUntil: addDays(todayIso, 9), createdAt: t - 5 * D, updatedAt: t - 5 * D,
      options: [{ id: uid(), name: 'Good', title: '', lines: templateLines(T('ign')) }] });
    // Deliberately under-priced part, so the margin warning has something to say.
    ign.options[0].lines[2].price = 40;

    return [ac, wh, dp, disp, ign];
  }

  /* ---------- state ---------- */
  let settings = Object.assign({ laborCost: 48 }, load(KEY_SETTINGS, {}));
  let quotes = load(KEY_QUOTES, null);
  if (!Array.isArray(quotes) || !quotes.length) { quotes = seedQuotes(); store(KEY_QUOTES, quotes); }
  mergeApprovals();
  let q = quotes.find(x => x.id === load(KEY_CURRENT, null)) || quotes[0];
  let savedFilter = 'all';
  let pickerTrade = 'all';

  function mergeApprovals() {
    const ap = load(KEY_APPROVALS, {});
    quotes.forEach(x => {
      const a = ap[x.number];
      if (!a) return;
      if (a.status === 'approved' && (!x.approval || x.approval.at !== a.at)) { x.approval = { name: a.name, at: a.at, option: a.option }; x.status = 'approved'; x.declined = null; }
      if (a.status === 'declined' && (!x.declined || x.declined.at !== a.at)) { x.declined = { at: a.at, reason: a.reason || '' }; x.status = 'declined'; x.approval = null; }
    });
  }

  function opts(quote) {
    return { discountType: quote.discount.type, discountValue: quote.discount.value, taxRate: co.taxRate, laborCostRate: settings.laborCost };
  }
  const visibleOptions = quote => quote.gbb ? quote.options : quote.options.slice(0, 1);
  const curOpt = () => q.options[q.gbb ? q.active : 0] || q.options[0];

  let saveTimer = null;
  function touch() {
    q.updatedAt = Date.now();
    $('tbSaved').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 350);
  }
  function persist() {
    const i = quotes.findIndex(x => x.id === q.id);
    if (i === -1) quotes.unshift(q); else quotes[i] = q;
    const ok = store(KEY_QUOTES, quotes);
    store(KEY_CURRENT, q.id);
    $('tbSaved').textContent = ok ? 'Saved' : 'Not saved (storage blocked)';
    renderSaved();
  }

  /* ---------- toast ---------- */
  let toastTimer = null, undoFn = null;
  function toast(msg, undo) {
    $('toastMsg').textContent = msg;
    undoFn = undo || null;
    $('toastUndo').hidden = !undo;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; undoFn = null; }, undo ? 6000 : 2600);
  }
  $('toastUndo').addEventListener('click', () => { if (undoFn) undoFn(); $('toast').hidden = true; });

  /* ================================================================ */
  /* Builder rendering                                                 */
  /* ================================================================ */
  function renderAll() {
    renderHeader();
    renderTabs();
    renderLines();
    renderOptions();
    renderTotals();
    renderSaved();
  }

  function renderHeader() {
    $('tbNumber').textContent = q.number;
    const st = $('tbStatus');
    st.textContent = STATUS[q.status];
    st.className = 'chip ' + STATUS_CHIP[q.status];
    $('statusSelect').value = q.status;
    $('custName').value = q.customer.name;
    $('custPhone').value = q.customer.phone;
    $('custAddress').value = q.customer.address + (q.customer.zip ? ', ' + q.customer.zip : '');
    $('issue').value = q.issue;
    $('tech').value = q.techId;
    $('qnum').value = q.number;
    $('qdate').value = q.date;
    $('qvalid').value = q.validUntil;
    updateCustHint();
  }

  function updateCustHint() {
    const known = S.customers.find(c => c.name.toLowerCase() === q.customer.name.trim().toLowerCase());
    $('custHint').textContent = !q.customer.name.trim() ? 'Pick an existing customer or type a new one.'
      : known ? 'Existing customer · ' + countJobs(known.id) : 'New customer: will be added when the quote is approved.';
  }
  function countJobs(cid) {
    const n = S.jobs.filter(j => j.customerId === cid).length;
    return n ? n + ' past job' + (n > 1 ? 's' : '') + ' on file' : 'no past jobs';
  }

  function renderTabs() {
    const tabs = $('optTabs');
    tabs.hidden = !q.gbb;
    $('optTitleRow').hidden = !q.gbb;
    if (!q.gbb) return;
    if (q.active >= q.options.length) q.active = 0;
    const html = q.options.map((o, i) => {
      const c = M.calc(o.lines, opts(q));
      return `<button type="button" role="tab" class="opt-tab${i === q.active ? ' on' : ''}" aria-selected="${i === q.active}" data-i="${i}">
        <span class="ot-name">${esc(o.name)}</span><span class="ot-title">${esc(o.title || 'Untitled option')}</span><span class="ot-total mono">${money(c.total)}</span></button>`;
    }).join('');
    const add = q.options.length < 3 ? `<button type="button" class="opt-tab add" id="btnAddOpt">+ Add ${OPTION_NAMES[q.options.length]}</button>` : '';
    tabs.innerHTML = html + add;
    $('optTitle').value = curOpt().title;
  }

  function lineWarn(l) {
    if (l.type !== 'part' || l.cost == null) return '';
    const target = M.cents(l.cost * (1 + co.partsMarkup)) / 100;
    if (Number(l.price) < Number(l.cost)) return 'Priced below cost';
    if (Number(l.price) + 0.005 < target) return 'Below ' + Math.round(co.partsMarkup * 100) + '% markup (book ' + money(M.cents(target)) + ')';
    return '';
  }

  // Update a line's markup warning in place (no re-render, so typing focus is kept).
  function updateRowWarn(row, l) {
    const w = lineWarn(l);
    row.classList.toggle('has-warn', !!w);
    let el = row.querySelector('.warn-txt');
    if (w && !el) { el = document.createElement('div'); el.className = 'warn-txt'; row.querySelector('.ln-desc').appendChild(el); }
    if (el) { if (w) el.textContent = '⚠ ' + w; else el.remove(); }
  }

  function renderLines() {
    const o = curOpt();
    const box = $('lines');
    if (!o.lines.length) {
      box.innerHTML = `<div class="empty"><b>No line items yet.</b><span>Pick a quick-start job above or add items from the price book.</span></div>`;
      return;
    }
    const head = `<div class="ln ln-head" aria-hidden="true"><span>Description</span><span>Qty</span><span>Unit</span><span>Cost</span><span>Unit price</span><span class="r">Total</span><span></span></div>`;
    box.innerHTML = head + o.lines.map((l, i) => {
      const w = lineWarn(l);
      const typeLabel = l.type === 'part' ? 'Part' : l.type === 'labor' ? 'Labor' : 'Fee';
      const n = i + 1;
      return `<div class="ln${w ? ' has-warn' : ''}" data-id="${l.id}">
        <div class="ln-desc">
          <label class="sr-only" for="d-${l.id}">Line ${n} description</label>
          <div class="desc-wrap">
            ${l.sku ? `<span class="tag t-${l.type}" title="${esc(l.sku)}">${typeLabel}</span>` :
              `<label class="sr-only" for="t-${l.id}">Line ${n} type</label><select class="tag-sel t-${l.type}" id="t-${l.id}" data-f="type"><option value="part"${l.type === 'part' ? ' selected' : ''}>Part</option><option value="labor"${l.type === 'labor' ? ' selected' : ''}>Labor</option><option value="fee"${l.type === 'fee' ? ' selected' : ''}>Fee</option></select>`}
            <input id="d-${l.id}" data-f="desc" value="${esc(l.desc)}" placeholder="Description">
          </div>
          ${w ? `<div class="warn-txt">⚠ ${esc(w)}</div>` : ''}
        </div>
        <div class="ln-num"><label class="m-lab" for="q-${l.id}">Qty</label><input id="q-${l.id}" data-f="qty" type="number" min="0" step="0.25" inputmode="decimal" value="${esc(l.qty)}"></div>
        <div class="ln-num"><label class="m-lab" for="u-${l.id}">Unit</label><input id="u-${l.id}" data-f="unit" value="${esc(l.unit)}"></div>
        <div class="ln-num ln-cost"><label class="m-lab" for="c-${l.id}">Cost</label>${l.type === 'part'
          ? `<input id="c-${l.id}" data-f="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${l.cost == null ? '' : esc(l.cost)}" placeholder="0.00">`
          : `<span class="na" id="c-${l.id}">n/a</span>`}</div>
        <div class="ln-num"><label class="m-lab" for="p-${l.id}">Unit price</label><input id="p-${l.id}" data-f="price" type="number" step="0.01" inputmode="decimal" value="${esc(l.price)}"></div>
        <div class="ln-total mono" data-total>${money(M.lineCents(l))}</div>
        <div class="ln-btns">
          <button type="button" class="icon-btn" data-act="up" aria-label="Move line ${n} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-act="down" aria-label="Move line ${n} down"${i === o.lines.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="icon-btn del" data-act="del" aria-label="Delete line ${n}">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderOptions() {
    $('afterHours').checked = q.afterHours;
    $('gbb').checked = q.gbb;
    $('discType').value = q.discount.type;
    $('discValue').value = q.discount.type === 'none' ? '' : q.discount.value;
    $('discValue').disabled = q.discount.type === 'none';
    $('discLabel').value = q.discount.label;
    $('discLabel').disabled = q.discount.type === 'none';
    $('terms').value = q.terms;
    $('ahDesc').textContent = `Switches labor from $${co.laborRate}/hr to the nights & weekends rate of $${co.afterHoursRate}/hr.`;
    $('taxChip').textContent = (co.taxRate * 100).toFixed(2) + '% on parts';
    $('discPresets').innerHTML = DISCOUNT_PRESETS.map((p, i) => {
      const on = q.discount.type === p.type && Number(q.discount.value) === p.value;
      return `<button type="button" class="pchip${on ? ' on' : ''}" aria-pressed="${on}" data-i="${i}">${esc(p.short)}</button>`;
    }).join('');
    $('laborCost').value = settings.laborCost;
  }

  function discLabel(quote) {
    const d = quote.discount;
    const base = d.label || 'Discount';
    return d.type === 'pct' ? `${base} (${fmtQty(d.value)}%)` : base;
  }

  function renderTotals() {
    // Totals card (what the customer pays)
    const vis = visibleOptions(q);
    const o = curOpt();
    const c = M.calc(o.lines, opts(q));
    const hasTrip = o.lines.some(l => l.type === 'fee');
    $('totals').innerHTML = `
      <div class="tot-head"><h2>Customer total</h2>${q.gbb ? `<span class="chip">${esc(o.name)}${o.title ? ': ' + esc(o.title) : ''}</span>` : ''}</div>
      <dl class="tot">
        <div><dt>Labor</dt><dd>${money(c.labor)}</dd></div>
        <div><dt>Parts &amp; materials</dt><dd>${money(c.parts)}</dd></div>
        <div><dt>Trip &amp; fees</dt><dd>${money(c.fees)}</dd></div>
        <div class="sub"><dt>Subtotal</dt><dd>${money(c.subtotal)}</dd></div>
        ${c.discount ? `<div class="disc"><dt>${esc(discLabel(q))}</dt><dd>−${money(c.discount)}</dd></div>` : ''}
        <div><dt>Tax ${(co.taxRate * 100).toFixed(2)}% on ${money(c.taxable)} parts</dt><dd>${money(c.tax)}</dd></div>
        <div class="grand"><dt>Total</dt><dd>${money(c.total)}</dd></div>
      </dl>
      ${!hasTrip && o.lines.length ? `<div class="nudge">⚠ No trip charge on this quote. <button type="button" class="linkbtn" id="btnAddTrip">Add ${money(M.cents(co.tripCharge))} trip charge</button></div>` : ''}
      ${q.afterHours ? `<div class="nudge info">After-hours labor rate applied.</div>` : ''}`;

    // Owner panel
    // Items but nothing left to charge (e.g. a discount as big as the subtotal) is not "no items".
    const band = c.margin == null && o.lines.length ? 'bad' : M.marginBand(c.margin);
    const pct = c.margin == null ? '–' : (c.margin * 100).toFixed(1) + '%';
    const markupReal = c.partsCost > 0 ? ((c.parts - c.partsCost) / c.partsCost * 100).toFixed(0) + '% markup' : '';
    const warns = o.lines.map(lineWarn).filter(Boolean);
    let hint;
    if (band === 'none') hint = 'Add line items to see the margin.';
    else if (c.margin == null) hint = 'Nothing left to charge: the quote comes to $0 before tax. Check the prices and the discount.';
    else if (band === 'bad') hint = warns.length ? 'Margin below target: check parts pricing. ' + warns.length + ' part' + (warns.length > 1 ? 's are' : ' is') + ' under the book price.' : 'Margin below target: check parts pricing, labor hours and the discount.';
    else if (band === 'warn') hint = q.gbb ? 'Margin is OK but under the 50% goal. Make sure the Better/Best options carry it.' : 'Margin is OK but under the 50% goal. Consider offering a Better/Best option.';
    else hint = 'Healthy margin. Good to send.';
    if (band !== 'bad' && warns.length) hint += ' Note: ' + warns.length + ' part' + (warns.length > 1 ? 's' : '') + ' priced under book.';
    const barW = c.margin == null ? 0 : Math.max(0, Math.min(100, c.margin * 100));

    const compare = q.gbb && vis.length > 1 ? `<div class="cmp"><div class="cmp-title">All options</div>${vis.map((x, i) => {
      const cc = M.calc(x.lines, opts(q)); const b = M.marginBand(cc.margin);
      return `<div class="cmp-row${i === q.active ? ' on' : ''}"><span>${esc(x.name)}</span><span class="mono">${money0(cc.grossProfit)} GP</span><span class="chip ${b === 'none' ? '' : b}">${cc.margin == null ? '–' : (cc.margin * 100).toFixed(0) + '%'}</span></div>`;
    }).join('')}</div>` : '';

    $('owner').innerHTML = `
      <div class="margin-big">
        <div><div class="mb-label">Gross margin</div><div class="mb-val mono">${pct}</div></div>
        <span class="chip big ${band === 'none' ? '' : band}">${band === 'good' ? 'On target' : band === 'warn' ? 'Watch' : band === 'bad' ? 'Below target' : 'No items'}</span>
      </div>
      <div class="mbar" role="img" aria-label="Margin ${pct}; target zones: under 35% low, 35 to 50% okay, over 50% healthy"><span class="mbar-fill ${band}" style="width:${barW}%"></span><i style="left:35%"></i><i style="left:50%"></i></div>
      <div class="mbar-scale"><span>0</span><span style="left:35%">35%</span><span style="left:50%">50%</span><span class="end">100%</span></div>
      <p class="owner-hint ${band}">${esc(hint)}</p>
      <dl class="tot owner-tot">
        <div><dt>Parts price</dt><dd>${money(c.parts)}</dd></div>
        <div><dt>Parts cost ${markupReal ? `<small>${markupReal}</small>` : ''}</dt><dd>−${money(c.partsCost)}</dd></div>
        <div><dt>Labor revenue <small>${fmtQty(c.laborHours)} hr</small></dt><dd>${money(c.labor)}</dd></div>
        <div><dt>Tech labor cost <small>${fmtQty(c.laborHours)} hr × $${fmtQty(settings.laborCost)}</small></dt><dd>−${money(c.laborCost)}</dd></div>
        <div><dt>Trip &amp; fees</dt><dd>${money(c.fees)}</dd></div>
        ${c.discount ? `<div><dt>Discount given</dt><dd>−${money(c.discount)}</dd></div>` : ''}
        <div class="grand"><dt>Gross profit</dt><dd>${money(c.grossProfit)}</dd></div>
      </dl>
      ${compare}`;

    // keep option tab totals fresh without rebuilding inputs
    if (q.gbb) document.querySelectorAll('#optTabs .opt-tab[data-i]').forEach(b => {
      const x = q.options[+b.dataset.i]; if (!x) return;
      b.querySelector('.ot-total').textContent = money(M.calc(x.lines, opts(q)).total);
      b.querySelector('.ot-title').textContent = x.title || 'Untitled option';
    });

    $('doc').innerHTML = docHTML(q, { mode: 'preview' });
  }

  /* ---------- the customer-facing document ---------- */
  function docHTML(quote, { mode, techName, selected }) {
    const tech = techName || (S.byId(S.techs, quote.techId) || {}).name || '';
    const vis = visibleOptions(quote);
    const o = { discountType: quote.discount.type, discountValue: quote.discount.value, taxRate: co.taxRate, laborCostRate: 0 };
    const multi = vis.length > 1;
    const approved = quote.approval;
    const expired = quote.validUntil < todayIso && !approved;

    const linesTable = (lines, compact) => `<table class="doc-lines${compact ? ' compact' : ''}">
      <thead><tr><th>Description</th>${compact ? '' : '<th class="r">Qty</th><th class="r">Unit price</th>'}<th class="r">Amount</th></tr></thead>
      <tbody>${lines.length ? lines.map(l => `<tr><td>${esc(l.desc || 'Item')}${compact && Number(l.qty) !== 1 ? ` <span class="q">× ${fmtQty(l.qty)} ${esc(l.unit)}</span>` : ''}${!compact && l.type === 'part' ? '<span class="tx" title="Taxable">T</span>' : ''}${!compact ? `<span class="q-m">${fmtQty(l.qty)} ${esc(l.unit)} × ${money(M.cents(l.price))}</span>` : ''}</td>${compact ? '' : `<td class="r">${fmtQty(l.qty)} ${esc(l.unit)}</td><td class="r">${money(M.cents(l.price))}</td>`}<td class="r">${money(M.lineCents(l))}</td></tr>`).join('')
        : `<tr><td colspan="${compact ? 2 : 4}" class="muted">No items yet</td></tr>`}</tbody></table>`;

    const sums = c => `<dl class="doc-sum">
      <div><dt>Subtotal</dt><dd>${money(c.subtotal)}</dd></div>
      ${c.discount ? `<div class="d"><dt>${esc(discLabel(quote))}</dt><dd>−${money(c.discount)}</dd></div>` : ''}
      <div><dt>Sales tax (${(co.taxRate * 100).toFixed(2)}%, parts only)</dt><dd>${money(c.tax)}</dd></div>
      <div class="g"><dt>Total</dt><dd>${money(c.total)}</dd></div></dl>`;

    let body;
    if (multi) {
      body = `<p class="doc-pick">${approved ? 'Option selected by customer' : 'Choose the option that works best for you'}</p>
      <div class="doc-opts n${vis.length}">${vis.map((x, i) => {
        const c = M.calc(x.lines, o);
        const isSel = approved ? approved.option === i : selected === i;
        const rec = i === 1 && vis.length === 3;
        return `<section class="doc-opt${isSel ? ' sel' : ''}${approved && !isSel ? ' dim' : ''}" data-opt="${i}">
          <div class="do-head"><span class="do-name">${esc(x.name)}</span>${rec ? '<span class="do-rec">Most popular</span>' : ''}${approved && isSel ? '<span class="do-rec ok">Approved</span>' : ''}</div>
          <h3>${esc(x.title || x.name + ' option')}</h3>
          <div class="do-total">${money(c.total)}</div>
          ${linesTable(x.lines, true)}
          ${sums(c)}
          ${mode === 'customer' && !approved && !quote.declined ? `<button type="button" class="btn ${isSel ? '' : 'ghost'} small do-choose" data-choose="${i}" aria-pressed="${isSel}">${isSel ? '✓ Selected' : 'Select ' + esc(x.name)}</button>` : ''}
        </section>`;
      }).join('')}</div><p class="doc-note"><span class="tx">T</span> Sales tax applies to parts and materials only.</p>`;
    } else {
      const c = M.calc(vis[0].lines, o);
      body = `${linesTable(vis[0].lines, false)}<div class="doc-foot-row"><p class="doc-note"><span class="tx">T</span> Taxable item. Sales tax applies to parts and materials only; labor is not taxed.</p>${sums(c)}</div>`;
    }

    const sig = approved
      ? `<div class="sig approved"><div><div class="sig-line">✓ Approved electronically by <b>${esc(approved.name)}</b></div><div class="sig-cap">${esc(fmtStamp(approved.at))}${multi ? ' · ' + esc(vis[approved.option] ? vis[approved.option].name + ': ' + (vis[approved.option].title || '') : '') : ''}</div></div></div>`
      : `<div class="sig"><div><div class="sig-line"></div><div class="sig-cap">Customer signature</div></div><div><div class="sig-line"></div><div class="sig-cap">Date</div></div></div>`;

    return `
      <header class="doc-head">
        <div class="doc-brand">
          <div class="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M3 26 L12 11 L17 18 L21 13 L29 26 Z" fill="currentColor"/><path d="M12 11 L14.5 15 L11 15 Z" fill="#fff" opacity=".9"/></svg></div>
          <div><div class="doc-co">${esc(co.name)}</div><div class="doc-tag">${esc(co.tagline)}</div></div>
        </div>
        <div class="doc-contact">${esc(co.address)}<br>${esc(co.phone)}<br>${esc(co.email)}</div>
      </header>
      <div class="doc-title-row">
        <div><div class="doc-kicker">Service quote</div><div class="doc-num">${esc(quote.number)}</div></div>
        <dl class="doc-meta">
          <div><dt>Date</dt><dd>${esc(fmtDate(quote.date))}</dd></div>
          <div><dt>Valid until</dt><dd${expired ? ' class="exp"' : ''}>${esc(fmtDate(quote.validUntil))}${expired ? ' (expired)' : ''}</dd></div>
          <div><dt>Technician</dt><dd>${esc(tech)}</dd></div>
        </dl>
      </div>
      <div class="doc-parties">
        <div><div class="dp-label">Prepared for</div><div class="dp-name">${esc(quote.customer.name || 'Customer name')}</div><div>${esc(quote.customer.address)}${quote.customer.zip ? ', ' + esc(quote.customer.zip) : ''}</div><div>${esc(quote.customer.phone)}</div></div>
        <div><div class="dp-label">Work requested</div><div class="dp-issue">${esc(quote.issue || 'Describe the job')}</div>${quote.afterHours ? '<div class="dp-ah">After-hours service (nights &amp; weekends rate)</div>' : ''}</div>
      </div>
      ${body}
      <div class="doc-terms"><div class="dp-label">Terms</div><p>${esc(quote.terms)}</p></div>
      ${sig}
      <div class="doc-thanks">Thank you for choosing ${esc(co.name)}. Questions? Call ${esc(co.phone)}.</div>`;
  }

  /* ---------- saved quotes ---------- */
  function quoteTotalLabel(x) {
    const vis = visibleOptions(x);
    const tots = vis.map(o => M.calc(o.lines, { discountType: x.discount.type, discountValue: x.discount.value, taxRate: co.taxRate }).total);
    if (x.approval && vis[x.approval.option]) return money(tots[x.approval.option]);
    if (tots.length > 1) return money0(Math.min(...tots)) + '–' + money0(Math.max(...tots));
    return money(tots[0] || 0);
  }
  function renderSaved() {
    $('savedCount').textContent = quotes.length;
    const counts = { all: quotes.length };
    Object.keys(STATUS).forEach(k => counts[k] = quotes.filter(x => x.status === k).length);
    $('savedFilter').innerHTML = ['all', ...Object.keys(STATUS)].map(k =>
      `<button type="button" class="pchip${savedFilter === k ? ' on' : ''}" aria-pressed="${savedFilter === k}" data-f="${k}">${k === 'all' ? 'All' : STATUS[k]} <span class="n">${counts[k]}</span></button>`).join('');
    const list = quotes.filter(x => savedFilter === 'all' || x.status === savedFilter).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) { $('savedList').innerHTML = `<div class="empty"><b>No ${STATUS[savedFilter] ? STATUS[savedFilter].toLowerCase() : ''} quotes.</b></div>`; return; }
    $('savedList').innerHTML = `<div class="sq sq-head" aria-hidden="true"><span>Quote</span><span>Customer &amp; job</span><span class="r">Total</span><span>Status</span><span>Updated</span><span></span></div>` +
      list.map(x => {
        const tech = S.byId(S.techs, x.techId);
        const statusNote = x.status === 'approved' && x.approval ? 'by ' + x.approval.name : x.status === 'sent' ? 'awaiting customer' : '';
        return `<div class="sq${x.id === q.id ? ' current' : ''}" data-id="${x.id}">
          <span class="sq-num mono">${esc(x.number)}${x.id === q.id ? '<em>Open</em>' : ''}</span>
          <span class="sq-cust"><b>${esc(x.customer.name || 'No customer')}</b><small>${esc((x.issue || 'No description').slice(0, 70))}${(x.issue || '').length > 70 ? '…' : ''}</small></span>
          <span class="sq-tot mono r">${quoteTotalLabel(x)}${x.gbb && x.options.length > 1 ? `<small>${x.options.length} options</small>` : ''}</span>
          <span class="sq-status"><span class="chip ${STATUS_CHIP[x.status]}">${STATUS[x.status]}</span>${statusNote ? `<small>${esc(statusNote)}</small>` : ''}</span>
          <span class="sq-date muted">${esc(fmtDate(isoDate(new Date(x.updatedAt))))}${tech ? `<small>${esc(tech.name)}</small>` : ''}</span>
          <span class="sq-btns">
            <button type="button" class="btn ghost small" data-act="open"${x.id === q.id ? ' disabled' : ''} aria-label="Open ${esc(x.number)}">Open</button>
            <button type="button" class="btn ghost small" data-act="dup" aria-label="Duplicate ${esc(x.number)}">Duplicate</button>
            <button type="button" class="icon-btn del" data-act="del" aria-label="Delete ${esc(x.number)}">✕</button>
          </span>
        </div>`;
      }).join('');
  }

  /* ================================================================ */
  /* Builder events                                                    */
  /* ================================================================ */
  function initBuilder() {
    $('custList').innerHTML = S.customers.map(c => `<option value="${esc(c.name)}">${esc(c.address)}</option>`).join('');
    $('tech').innerHTML = S.techs.map(t => `<option value="${t.id}">${esc(t.name)} · ${esc(t.trade)}</option>`).join('');
    $('templates').innerHTML = TEMPLATES.map(t => `<button type="button" class="tpl" data-t="${t.id}"><span class="dot d-${t.trade.toLowerCase()}" aria-hidden="true"></span><span><b>${esc(t.name)}</b><small>${esc(t.trade)} · ${money(templateTotal(t))}</small></span></button>`).join('');
    $('markupPct').textContent = Math.round(co.partsMarkup * 100);

    // Header fields
    $('custName').addEventListener('input', e => {
      q.customer.name = e.target.value;
      const c = S.customers.find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
      if (c) { q.customer = custFrom(c.id); $('custPhone').value = c.phone; $('custAddress').value = c.address + ', ' + c.zip; }
      updateCustHint(); touch(); renderTotalsSoon();
    });
    $('custPhone').addEventListener('input', e => { q.customer.phone = e.target.value; touch(); renderTotalsSoon(); });
    $('custAddress').addEventListener('input', e => {
      const v = e.target.value; const m = v.match(/^(.*?),?\s*(\d{5})$/);
      if (m) { q.customer.address = m[1].trim(); q.customer.zip = m[2]; } else { q.customer.address = v; q.customer.zip = ''; }
      touch(); renderTotalsSoon();
    });
    $('issue').addEventListener('input', e => { q.issue = e.target.value; touch(); renderTotalsSoon(); });
    $('tech').addEventListener('change', e => { q.techId = e.target.value; touch(); renderTotals(); });
    $('qdate').addEventListener('change', e => {
      const old = q.date; q.date = e.target.value || todayIso;
      if (q.validUntil === addDays(old, 14)) { q.validUntil = addDays(q.date, 14); $('qvalid').value = q.validUntil; }
      touch(); renderTotals();
    });
    $('qvalid').addEventListener('change', e => { q.validUntil = e.target.value || addDays(q.date, 14); touch(); renderTotals(); });
    $('statusSelect').addEventListener('change', e => {
      setStatus(e.target.value); renderHeader(); renderTotals(); touch();
    });

    // Templates
    $('templates').addEventListener('click', e => {
      const b = e.target.closest('.tpl'); if (!b) return;
      const t = TEMPLATES.find(x => x.id === b.dataset.t);
      const o = curOpt();
      const before = clone(q);
      o.lines = templateLines(t, q.afterHours);
      if (q.gbb && (!o.title || OPTION_NAMES.includes(o.title))) o.title = t.name;
      if (!q.issue.trim()) q.issue = t.issue;
      touch(); renderAll();
      toast(`Loaded “${t.name}”${q.gbb ? ' into ' + o.name : ''}.`, () => { q = before; touch(); renderAll(); });
    });

    // Line editing (input = live values, no re-render so focus stays put)
    $('lines').addEventListener('input', e => {
      const row = e.target.closest('.ln'); const f = e.target.dataset.f; if (!row || !f) return;
      const l = curOpt().lines.find(x => x.id === row.dataset.id); if (!l) return;
      if (f === 'qty' || f === 'price' || f === 'cost') l[f] = e.target.value === '' ? (f === 'cost' ? null : 0) : Number(e.target.value);
      else l[f] = e.target.value;
      if (f === 'type') {
        l.type = e.target.value; if (l.type !== 'part') l.cost = null;
        touch(); renderLines(); renderTotals(); renderTabs(); const el = $('t-' + l.id); if (el) el.focus(); return;
      }
      row.querySelector('[data-total]').textContent = money(M.lineCents(l));
      updateRowWarn(row, l);
      touch(); renderTotals();
    });
    $('lines').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const row = b.closest('.ln'); const lines = curOpt().lines;
      const i = lines.findIndex(x => x.id === row.dataset.id); if (i < 0) return;
      const act = b.dataset.act;
      if (act === 'del') {
        const [gone] = lines.splice(i, 1);
        touch(); renderLines(); renderTotals(); renderTabs();
        toast(`Removed “${gone.desc}”.`, () => { lines.splice(i, 0, gone); touch(); renderLines(); renderTotals(); renderTabs(); });
        return;
      }
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= lines.length) return;
      [lines[i], lines[j]] = [lines[j], lines[i]];
      touch(); renderLines(); renderTotals();
      const again = document.querySelector(`.ln[data-id="${lines[j].id}"] [data-act="${act}"]`);
      (again && !again.disabled ? again : document.querySelector(`.ln[data-id="${lines[j].id}"] input`)).focus();
    });

    $('btnAddCustom').addEventListener('click', () => {
      const l = { id: uid(), sku: null, type: 'part', desc: '', qty: 1, unit: 'ea', price: 0, cost: null };
      curOpt().lines.push(l); touch(); renderLines(); renderTotals();
      $('d-' + l.id).focus();
    });
    $('btnAddItem').addEventListener('click', openPicker);

    // Good / Better / Best tabs
    $('optTabs').addEventListener('click', e => {
      if (e.target.closest('#btnAddOpt')) {
        const base = curOpt();
        const n = q.options.length;
        q.options.push({ id: uid(), name: OPTION_NAMES[n], title: '', lines: base.lines.map(l => ({ ...l, id: uid() })) });
        q.active = n; touch(); renderAll();
        $('optTitle').focus();
        toast(`${OPTION_NAMES[n]} option added, copied from ${base.name}. Adjust the lines.`);
        return;
      }
      const t = e.target.closest('.opt-tab[data-i]'); if (!t) return;
      q.active = +t.dataset.i; renderTabs(); renderLines(); renderTotals();
      const nt = document.querySelector(`.opt-tab[data-i="${q.active}"]`); if (nt) nt.focus();
    });
    $('optTabs').addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = q.options.length; q.active = (q.active + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
      renderTabs(); renderLines(); renderTotals();
      document.querySelector(`.opt-tab[data-i="${q.active}"]`).focus();
    });
    $('optTitle').addEventListener('input', e => { curOpt().title = e.target.value; touch(); renderTotals(); });

    // Options
    $('afterHours').addEventListener('change', e => { setAfterHours(e.target.checked); touch(); renderLines(); renderTotals(); renderTabs(); });
    $('gbb').addEventListener('change', e => {
      q.gbb = e.target.checked;
      if (q.gbb) {
        const base = q.options[0];
        if (!base.title) base.title = 'Repair';
        if (q.options.length < 2) q.options.push({ id: uid(), name: 'Better', title: '', lines: base.lines.map(l => ({ ...l, id: uid() })) });
        q.active = 0;
        toast('Good / Better / Best on. Better starts as a copy of Good.');
      } else {
        q.active = 0;
        if (q.options.length > 1) toast('Showing only the Good option. Better/Best are kept if you turn this back on.');
      }
      touch(); renderAll();
    });
    $('discType').addEventListener('change', e => {
      q.discount.type = e.target.value;
      if (q.discount.type === 'none') { q.discount.value = 0; q.discount.label = ''; }
      else if (!q.discount.label) q.discount.label = 'Discount';
      touch(); renderOptions(); renderTotals(); renderTabs();
      if (q.discount.type !== 'none') $('discValue').focus();
    });
    $('discValue').addEventListener('input', e => { q.discount.value = Math.max(0, Number(e.target.value) || 0); touch(); renderTotals(); markPresets(); });
    // A discount can't be negative: once the field is left, show the 0 that the totals actually use.
    $('discValue').addEventListener('change', e => { if (e.target.value !== '' && !(Number(e.target.value) >= 0)) e.target.value = q.discount.value; });
    $('discLabel').addEventListener('input', e => { q.discount.label = e.target.value; touch(); renderTotals(); });
    $('discPresets').addEventListener('click', e => {
      const b = e.target.closest('.pchip'); if (!b) return;
      const p = DISCOUNT_PRESETS[+b.dataset.i];
      const on = q.discount.type === p.type && Number(q.discount.value) === p.value;
      q.discount = on ? { type: 'none', value: 0, label: '' } : { type: p.type, value: p.value, label: p.label };
      touch(); renderOptions(); renderTotals(); renderTabs();
    });
    $('terms').addEventListener('input', e => { q.terms = e.target.value; touch(); renderTotalsSoon(); });
    $('laborCost').addEventListener('input', e => {
      settings.laborCost = Math.max(0, Number(e.target.value) || 0); store(KEY_SETTINGS, settings); renderTotals();
    });

    // Totals nudges
    $('totals').addEventListener('click', e => {
      if (e.target.id === 'btnAddTrip') { curOpt().lines.unshift(lineFromSku('TRIP')); touch(); renderLines(); renderTotals(); renderTabs(); }
    });

    // Toolbar
    $('btnNew').addEventListener('click', () => {
      persist();
      q = blankQuote(nextNumber());
      quotes.unshift(q); touch(); renderAll();
      window.scrollTo({ top: $('builder').offsetTop - 8, behavior: 'smooth' });
      $('custName').focus({ preventScroll: true });
      toast(`Started ${q.number}. Pick a customer and a quick-start job.`);
    });

    // Send
    ['btnPrint', 'btnPrint2'].forEach(id => $(id).addEventListener('click', () => window.print()));
    ['btnCopyLink', 'btnCopyLink2'].forEach(id => $(id).addEventListener('click', copyLink));

    // Saved list
    $('savedFilter').addEventListener('click', e => { const b = e.target.closest('.pchip'); if (!b) return; savedFilter = b.dataset.f; renderSaved(); });
    $('savedList').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.closest('.sq').dataset.id; const x = quotes.find(z => z.id === id); if (!x) return;
      if (b.dataset.act === 'open') { persist(); q = x; store(KEY_CURRENT, q.id); renderAll(); window.scrollTo({ top: $('builder').offsetTop - 8, behavior: 'smooth' }); toast(`Opened ${x.number}.`); }
      if (b.dataset.act === 'dup') {
        persist();
        const d = clone(x); Object.assign(d, { id: uid(), number: nextNumber(), status: 'draft', approval: null, declined: null, createdAt: Date.now(), updatedAt: Date.now(), date: todayIso, validUntil: addDays(todayIso, 14) });
        d.options.forEach(o => { o.id = uid(); o.lines.forEach(l => l.id = uid()); });
        quotes.unshift(d); q = d; touch(); renderAll();
        window.scrollTo({ top: $('builder').offsetTop - 8, behavior: 'smooth' });
        toast(`Duplicated ${x.number} as ${d.number}.`);
      }
      if (b.dataset.act === 'del') {
        const i = quotes.indexOf(x); quotes.splice(i, 1);
        const wasCurrent = x === q;
        if (!quotes.length) quotes.push(blankQuote(nextNumber(x.number)));
        if (wasCurrent) q = quotes[0];
        store(KEY_QUOTES, quotes); store(KEY_CURRENT, q.id); renderAll();
        toast(`Deleted ${x.number}.`, () => { quotes.splice(i, 0, x); if (wasCurrent) q = x; store(KEY_QUOTES, quotes); store(KEY_CURRENT, q.id); renderAll(); });
      }
    });

    // Approvals made in another tab show up here.
    window.addEventListener('storage', e => {
      if (e.key !== KEY_APPROVALS) return;
      mergeApprovals(); store(KEY_QUOTES, quotes); renderAll();
      toast('A customer responded to a quote.');
    });

    renderAll();
  }

  let soonTimer = null;
  function renderTotalsSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(renderTotals, 120); }
  function markPresets() {
    document.querySelectorAll('#discPresets .pchip').forEach(b => {
      const p = DISCOUNT_PRESETS[+b.dataset.i]; const on = q.discount.type === p.type && Number(q.discount.value) === p.value;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    });
  }
  function templateTotal(t) {
    return M.calc(templateLines(t, false), { discountType: 'none', taxRate: co.taxRate }).total;
  }
  function nextNumber(extra) {
    const nums = quotes.map(x => parseInt(String(x.number).replace(/\D/g, ''), 10) || 0);
    if (extra) nums.push(parseInt(String(extra).replace(/\D/g, ''), 10) || 0);
    return 'Q-' + String(Math.max(1041, ...nums) + 1).padStart(4, '0');
  }
  function setStatus(s) {
    q.status = s;
    if (s !== 'approved') q.approval = null;
    if (s === 'approved' && !q.approval) q.approval = { name: q.customer.name || 'Customer', at: Date.now(), option: q.gbb ? q.active : 0, manual: true };
    if (s === 'declined') q.declined = q.declined || { at: Date.now() }; else q.declined = null;
  }
  function setAfterHours(on) {
    q.afterHours = on;
    const from = PB[on ? 'LAB-STD' : 'LAB-AH'], to = PB[on ? 'LAB-AH' : 'LAB-STD'];
    q.options.forEach(o => o.lines.forEach(l => {
      if (l.type !== 'labor') return;
      if (l.sku === from.sku || Number(l.price) === from.price) {
        if (l.sku === from.sku || !l.sku) { l.sku = to.sku; if (l.desc === from.name || !l.desc) l.desc = to.name; }
        if (Number(l.price) === from.price) l.price = to.price;
      }
    }));
    toast(on ? `Labor switched to $${co.afterHoursRate}/hr after-hours rate.` : `Labor back to $${co.laborRate}/hr standard rate.`);
  }

  /* ---------- price book picker ---------- */
  const GROUPS = [
    { key: 'labor', title: 'Labor', test: p => p.type === 'labor' },
    { key: 'fee', title: 'Fees', test: p => p.type === 'fee' },
    { key: 'HVAC', title: 'Parts · HVAC', test: p => p.type === 'part' && p.trade === 'HVAC' },
    { key: 'Plumbing', title: 'Parts · Plumbing', test: p => p.type === 'part' && p.trade === 'Plumbing' },
    { key: 'Appliance', title: 'Parts · Appliance', test: p => p.type === 'part' && p.trade === 'Appliance' },
  ];
  function openPicker() {
    const d = $('picker');
    $('pickerSearch').value = '';
    pickerTrade = 'all';
    renderPicker();
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    $('pickerSearch').focus();
  }
  function renderPicker() {
    const tabs = [['all', 'All'], ['labor', 'Labor & fees'], ['HVAC', 'HVAC'], ['Plumbing', 'Plumbing'], ['Appliance', 'Appliance']];
    $('pickerTabs').innerHTML = tabs.map(([k, t]) => `<button type="button" class="pchip${pickerTrade === k ? ' on' : ''}" aria-pressed="${pickerTrade === k}" data-k="${k}">${t}</button>`).join('');
    const term = $('pickerSearch').value.trim().toLowerCase();
    const words = term.split(/\s+/).filter(Boolean);
    const match = p => words.every(w => (p.name + ' ' + p.sku + ' ' + (p.trade || '') + ' ' + p.type).toLowerCase().includes(w));
    const inTab = g => pickerTrade === 'all' || g.key === pickerTrade || (pickerTrade === 'labor' && (g.key === 'labor' || g.key === 'fee'));
    let html = '', count = 0;
    GROUPS.filter(inTab).forEach(g => {
      let items = S.priceBook.filter(g.test).filter(match);
      if (!items.length) return;
      count += items.length;
      html += `<div class="pk-group"><div class="pk-title">${g.title}</div>${items.map(p => {
        return `<button type="button" class="pk-item" data-sku="${p.sku}">
          <span class="pk-name">${esc(p.name)}<small class="mono">${esc(p.sku)}</small></span>
          <span class="pk-price mono">${money(M.cents(p.price))}<small>/${esc(p.unit)}${p.cost != null ? ' · cost ' + money(M.cents(p.cost)) : ''}</small></span>
        </button>`;
      }).join('')}</div>`;
    });
    $('pickerList').innerHTML = html || `<div class="empty"><b>Nothing matches “${esc(term)}”.</b><span>Close this and add a custom line instead.</span></div>`;
    $('pickerList').setAttribute('aria-label', count + ' items');
  }
  $('pickerSearch').addEventListener('input', renderPicker);
  $('pickerSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = document.querySelector('#pickerList .pk-item'); if (first) first.click(); }
  });
  $('pickerTabs').addEventListener('click', e => { const b = e.target.closest('.pchip'); if (!b) return; pickerTrade = b.dataset.k; renderPicker(); });
  $('pickerList').addEventListener('click', e => {
    const b = e.target.closest('.pk-item'); if (!b) return;
    let sku = b.dataset.sku;
    if (sku === 'LAB-STD' && q.afterHours) sku = 'LAB-AH';
    const l = lineFromSku(sku, 1);
    curOpt().lines.push(l);
    touch(); renderLines(); renderTotals(); renderTabs();
    b.classList.add('added');
    toast(`Added ${l.desc}.`);
  });
  $('picker').addEventListener('click', e => { if (e.target === $('picker')) $('picker').close(); });

  /* ---------- approval link ---------- */
  function linkPayload(quote) {
    // Costs, margin and internal notes are NOT included: the customer only gets prices.
    return {
      v: 1, n: quote.number, c: quote.customer, i: quote.issue,
      t: (S.byId(S.techs, quote.techId) || {}).name || '', d: quote.date, u: quote.validUntil, ah: quote.afterHours ? 1 : 0,
      ds: quote.discount.type === 'none' ? null : [quote.discount.type, quote.discount.value, quote.discount.label],
      o: visibleOptions(quote).map(o => [o.name, o.title, o.lines.map(l => [l.type, l.desc, l.qty, l.unit, l.price])]),
      tm: quote.terms,
    };
  }
  function quoteFromPayload(p) {
    const opts = (p.o || []).map(([name, title, lines]) => ({ name, title, lines: (lines || []).map(([type, desc, qty, unit, price]) => ({ type, desc, qty, unit, price })) }));
    return {
      number: String(p.n || 'Q-0000'), customer: Object.assign({ name: '', phone: '', address: '', zip: '' }, p.c || {}),
      issue: p.i || '', techName: p.t || '', date: p.d || todayIso, validUntil: p.u || addDays(todayIso, 14), afterHours: !!p.ah,
      discount: p.ds ? { type: p.ds[0], value: p.ds[1], label: p.ds[2] } : { type: 'none', value: 0, label: '' },
      gbb: opts.length > 1, options: opts.length ? opts : [{ name: 'Good', title: '', lines: [] }], terms: p.tm || DEFAULT_TERMS,
      approval: null, declined: null,
    };
  }
  function buildLink(quote) {
    const base = location.href.split('#')[0];
    return base + '#q=' + M.encode(linkPayload(quote));
  }
  async function copyLink() {
    persist();
    const url = buildLink(q);
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) { copied = false; }
    $('linkBox').hidden = false;
    $('linkOut').value = url;
    $('linkOpen').href = url;
    $('linkMsg').textContent = copied ? 'Copied. Text or email it to the customer.' : 'Select and copy the link above.';
    if (!copied) $('linkOut').select();
    if (q.status === 'draft') { q.status = 'sent'; touch(); renderHeader(); }
    toast(copied ? `Approval link for ${q.number} copied. Marked as Sent.` : 'Link ready below. Marked as Sent.');
  }

  /* ================================================================ */
  /* Customer view (from #q=...)                                       */
  /* ================================================================ */
  let cq = null, cSel = 0, cMode = 'idle';
  function showCustomer(hash) {
    try { cq = quoteFromPayload(M.decode(hash.slice(3))); }
    catch (e) { cq = null; }
    document.body.classList.add('is-customer');
    $('builder-view').hidden = true;
    $('customer-view').hidden = false;
    document.title = cq ? `Quote ${cq.number} · ${co.name}` : 'Quote not found';
    if (!cq) {
      $('custDoc').innerHTML = `<div class="empty big"><b>This quote link is incomplete.</b><span>Ask ${esc(co.name)} to send it again, or call ${esc(co.phone)}.</span></div>`;
      $('custPanel').innerHTML = ''; return;
    }
    const a = load(KEY_APPROVALS, {})[cq.number];
    if (a && a.status === 'approved') { cq.approval = { name: a.name, at: a.at, option: a.option }; cMode = 'approved'; }
    else if (a && a.status === 'declined') { cq.declined = { at: a.at }; cMode = 'declined'; }
    else cMode = 'idle';
    cSel = cq.gbb ? Math.min(1, cq.options.length - 1) : 0;
    renderCustomer();
  }
  function renderCustomer() {
    $('custDoc').innerHTML = docHTML(cq, { mode: 'customer', techName: cq.techName, selected: cSel });
    const multi = cq.options.length > 1;
    const sel = cq.options[cSel];
    const tot = M.calc(sel.lines, { discountType: cq.discount.type, discountValue: cq.discount.value, taxRate: co.taxRate }).total;
    const p = $('custPanel');
    if (cMode === 'approved') {
      const ap = cq.approval; const o = cq.options[ap.option] || sel;
      const t = M.calc(o.lines, { discountType: cq.discount.type, discountValue: cq.discount.value, taxRate: co.taxRate }).total;
      p.innerHTML = `<div class="card cp-done good" tabindex="-1" id="cpFocus"><div class="cp-icon" aria-hidden="true">✓</div><h2>Quote approved</h2>
        <p>Thanks, ${esc(ap.name)}. ${esc(co.name)} has your approval for ${multi ? '<b>' + esc(o.name + ': ' + (o.title || '')) + '</b> at ' : ''}<b>${money(t)}</b>.</p>
        <dl class="cp-meta"><div><dt>Quote</dt><dd class="mono">${esc(cq.number)}</dd></div><div><dt>Approved</dt><dd>${esc(fmtStamp(ap.at))}</dd></div></dl>
        <p class="muted small">The office will call to schedule. Questions: ${esc(co.phone)}.</p>
        <p class="demo-note">Demo: this approval is saved in this browser only (localStorage). In a real system it would update the job and notify the office.</p>
        <button type="button" class="btn ghost small" id="cpPrint">Print / Save PDF</button></div>`;
    } else if (cMode === 'declined') {
      p.innerHTML = `<div class="card cp-done" tabindex="-1" id="cpFocus"><h2>Quote declined</h2><p>Thanks for letting us know. If anything changes, call ${esc(co.phone)} and we will pick it back up.</p>
        <p class="demo-note">Demo: saved in this browser only.</p><button type="button" class="btn ghost small" id="cpUndo">I changed my mind</button></div>`;
    } else if (cMode === 'question') {
      p.innerHTML = `<div class="card"><h2>Ask a question</h2>
        <form id="qForm" class="cp-form">
          <div><label for="qName">Your name</label><input id="qName" required value="${esc(cq.customer.name)}" autocomplete="name"></div>
          <div><label for="qText">Question</label><textarea id="qText" rows="4" required placeholder="e.g. Can you do Thursday morning? Is the fan motor really needed?"></textarea></div>
          <button class="btn" type="submit">Send question</button>
          <button class="btn ghost" type="button" id="qCancel">Back</button>
        </form><p class="demo-note">Demo: nothing is actually sent.</p></div>`;
    } else if (cMode === 'asked') {
      p.innerHTML = `<div class="card cp-done" tabindex="-1" id="cpFocus"><div class="cp-icon" aria-hidden="true">✉</div><h2>Question sent</h2><p>${esc(co.name)} usually replies within one business hour. You can still approve the quote any time before ${esc(fmtDate(cq.validUntil))}.</p>
        <p class="demo-note">Demo: nothing was actually sent.</p><button type="button" class="btn ghost small" id="qBack">Back to quote</button></div>`;
    } else {
      p.innerHTML = `<div class="card cp">
        <div class="cp-kicker">Quote ${esc(cq.number)} · valid until ${esc(fmtDate(cq.validUntil))}</div>
        <h2>Ready to go ahead?</h2>
        ${multi ? `<p class="small muted">Selected: <b>${esc(sel.name)}${sel.title ? ': ' + esc(sel.title) : ''}</b>. Tap an option on the quote to change it.</p>` : ''}
        <div class="cp-total"><span>Total</span><b class="mono">${money(tot)}</b></div>
        <form id="apForm" class="cp-form">
          <div><label for="apName">Your full name</label><input id="apName" required autocomplete="name" value="${esc(cq.customer.name)}"></div>
          <label class="check"><input type="checkbox" id="apAgree" required> <span>I approve this quote and agree to the terms.</span></label>
          <button class="btn" type="submit" id="apBtn">Approve quote</button>
        </form>
        <div class="cp-alt">
          <button type="button" class="btn ghost" id="askBtn">Ask a question</button>
          <button type="button" class="linkbtn muted" id="declineBtn">Decline quote</button>
        </div>
        <p class="demo-note">Demo: approvals are stored in this browser only.</p>
      </div>`;
    }
    const f = $('cpFocus'); if (f) f.focus();
  }
  function saveResponse(rec) {
    const all = load(KEY_APPROVALS, {});
    all[cq.number] = rec;
    store(KEY_APPROVALS, all);
    // Same browser as the builder? Update the saved quote too.
    const qs = load(KEY_QUOTES, []);
    const x = Array.isArray(qs) && qs.find(z => z.number === cq.number);
    if (x) {
      if (rec.status === 'approved') { x.status = 'approved'; x.approval = { name: rec.name, at: rec.at, option: rec.option }; x.declined = null; }
      else if (rec.status === 'declined') { x.status = 'declined'; x.declined = { at: rec.at }; x.approval = null; }
      else { x.status = 'sent'; x.approval = null; x.declined = null; }
      x.updatedAt = Date.now();
      store(KEY_QUOTES, qs);
    }
  }
  function initCustomer() {
    $('customer-view').addEventListener('click', e => {
      const ch = e.target.closest('[data-choose]');
      const card = e.target.closest('.doc-opt');
      if ((ch || card) && cMode === 'idle' && cq && cq.options.length > 1) { cSel = +(ch ? ch.dataset.choose : card.dataset.opt); renderCustomer(); const b = document.querySelector(`[data-choose="${cSel}"]`); if (b) b.focus(); return; }
      const id = e.target.id;
      if (id === 'askBtn') { cMode = 'question'; renderCustomer(); $('qText').focus(); }
      if (id === 'qCancel' || id === 'qBack') { cMode = 'idle'; renderCustomer(); }
      if (id === 'declineBtn') { const rec = { status: 'declined', at: Date.now() }; saveResponse(rec); cq.declined = rec; cMode = 'declined'; renderCustomer(); }
      if (id === 'cpUndo') { saveResponse({ status: 'sent', at: Date.now() }); cq.declined = null; cMode = 'idle'; renderCustomer(); }
      if (id === 'cpPrint') window.print();
    });
    $('customer-view').addEventListener('submit', e => {
      e.preventDefault();
      if (e.target.id === 'apForm') {
        const name = $('apName').value.trim();
        if (!name) { $('apName').focus(); return; }
        const rec = { status: 'approved', name, at: Date.now(), option: cSel };
        saveResponse(rec);
        cq.approval = rec; cMode = 'approved'; renderCustomer();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      if (e.target.id === 'qForm') { cMode = 'asked'; renderCustomer(); }
    });
  }

  /* ---------- routing ---------- */
  let builderReady = false, inCustomer = false;
  function route() {
    if (location.hash.startsWith('#q=')) { inCustomer = true; showCustomer(location.hash); return; }
    const wasCustomer = inCustomer; inCustomer = false;
    if (builderReady && !wasCustomer) return; // in-page anchor like #saved
    document.body.classList.remove('is-customer');
    $('customer-view').hidden = true;
    $('builder-view').hidden = false;
    document.title = 'Quote Builder · Ted Kelly';
    if (!builderReady) { builderReady = true; initBuilder(); }
    else { quotes = load(KEY_QUOTES, quotes); mergeApprovals(); q = quotes.find(x => x.id === q.id) || quotes[0]; renderAll(); }
  }
  initCustomer();
  window.addEventListener('hashchange', route);
  route();
})();
