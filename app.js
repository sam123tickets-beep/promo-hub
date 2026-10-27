/* PL Orders — app logic. Data lives in Supabase (or in memory in demo mode). */
(function () {
  'use strict';

  // ---------- helpers ----------
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
  var usdF = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
  var usd0 = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
  function fmt(v, kind) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) return '';
    switch (kind) {
      case 'usd': return usdF.format(v);
      case 'usd0': return usd0.format(v);
      case 'susd': return (v > 0 ? '+' : '') + usdF.format(v);
      case 'pct': return (v * 100).toFixed(1) + '%';
      case 'spct': return (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
      case 'int': return Math.round(v).toLocaleString('en-US');
      case 'date': return v instanceof Date ? v.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : String(v);
      case 'datetime': return v instanceof Date ? v.toLocaleString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : String(v);
      default: return String(v);
    }
  }
  function signClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
  function ymd(d) { return d ? tt_dayKey(d) : null; }
  function monthLabel(k) {
    if (!k) return '';
    var p = k.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
  }
  function toast(msg, isErr) {
    if (!isErr) return;               // success/info messages stay quiet; results show on the page itself
    var t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast'; }, isErr ? 8000 : 4000);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  // ---------- row mapping ----------
  var ORDER_FIELDS = ['order_number', 'email', 'event_name', 'event_date_raw', 'seats', 'quantity', 'buyer', 'date_bought_raw', 'card', 'total', 'price_per_ticket', 'site'];
  // Matches the PL sheet's column names, tolerant of small wording differences.
  function headerKey(h) {
    h = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (/order/.test(h) && /(number|#|no\b|id)/.test(h)) return 'order_number';
    if (/^event( name)?$|event name|^show$|^artist$/.test(h)) return 'event_name';
    if (/event date|show date|^date$/.test(h)) return 'event_date_raw';
    if (/email/.test(h) && !/cc/.test(h)) return 'email';
    if (/section|seat/.test(h)) return 'seats';
    if (/^(quantity|qty)$/.test(h)) return 'quantity';
    if (/^buyer/.test(h)) return 'buyer';
    if (/date bought|purchase date|bought on|^purchased/.test(h)) return 'date_bought_raw';
    if (/last 4|card|^cc/.test(h)) return 'card';
    if (/per ticket/.test(h)) return 'price_per_ticket';
    if (/total/.test(h)) return 'total';
    if (/^site$|platform/.test(h)) return 'site';
    return null;
  }
  function csvRowToOrder(obj) {
    var r = {};
    Object.keys(obj).forEach(function (h) {
      var k = headerKey(h);
      if (k && r[k] === undefined) r[k] = obj[h] === undefined || obj[h] === null ? '' : String(obj[h]).trim();
    });
    if (!r.order_number) return null;
    // If the event name looks like a date and the date column does not, they were swapped.
    if (tt_looksLikeDate(r.event_name) && r.event_date_raw && !tt_looksLikeDate(r.event_date_raw)) {
      var tmp = r.event_name; r.event_name = r.event_date_raw; r.event_date_raw = tmp;
    }
    ORDER_FIELDS.forEach(function (f) { if (r[f] === undefined || r[f] === '') r[f] = null; });
    r.quantity = r.quantity ? (parseInt(parseFloat(r.quantity), 10) || null) : null;
    r.total = r.total ? tt_money(r.total) : null;
    return r;
  }
  function orderSig(r) { return ORDER_FIELDS.map(function (f) { var v = r[f]; return v === null || v === undefined ? '' : String(typeof v === 'number' ? +v.toFixed(2) : v); }).join('\u0001'); }
  function orderForBuild(r) {
    return {order: r.order_number, email: r.email || '', event: r.event_name || '', eventDateRaw: r.event_date_raw || '', seats: r.seats || '',
      qty: Number(r.quantity) || 0, buyer: r.buyer || '', dateBought: r.date_bought_raw || '', card: r.card || '', total: Number(r.total) || 0,
      ppt: r.price_per_ticket || '', site: r.site || ''};
  }
  function saleToDb(s) {
    return {sale_key: s.key, sold_at: s.soldAt ? s.soldAt.toISOString() : null, sold_raw: s.soldRaw || null, result: s.result || null,
      event: s.event, event_date: ymd(s.eventDate), venue: s.venue || null, section: s.section, row_name: s.row, qty: s.qty,
      total: s.total, profit: s.profit, roi: s.roi, cost_per: s.costPer, sold_per: s.soldPer,
      purchased_at: s.purchased ? s.purchased.toISOString() : null, time_to_sell: s.timeToSell || null, marketplace: s.marketplace || null,
      public_notes: s.publicNotes || null, order_numbers: s.orders || [], internal_notes: s.internalNotes || null};
  }
  function saleFromDb(r) {
    return {key: r.sale_key, soldAt: r.sold_at ? new Date(r.sold_at) : null, soldRaw: r.sold_raw || '', result: r.result || '', event: r.event || '',
      eventDate: r.event_date ? tt_parseDate(String(r.event_date)) : null, venue: r.venue || '', section: r.section || '', row: r.row_name || '',
      qty: Number(r.qty) || 0, total: Number(r.total) || 0, profit: Number(r.profit) || 0, roi: Number(r.roi) || 0,
      costPer: Number(r.cost_per) || 0, soldPer: Number(r.sold_per) || 0, purchased: r.purchased_at ? new Date(r.purchased_at) : null,
      timeToSell: r.time_to_sell || '', marketplace: r.marketplace || '', publicNotes: r.public_notes || '',
      orders: r.order_numbers || [], internalNotes: r.internal_notes || ''};
  }

  // ---------- stores ----------
  function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

  function SupabaseStore(client) {
    this.sb = client; this.demo = false;
  }
  SupabaseStore.prototype.userId = async function () {
    var r = await this.sb.auth.getUser();
    if (r.error || !r.data.user) throw new Error('You are signed out. Please sign in again.');
    return r.data.user.id;
  };
  var PKEY = {orders: 'order_number', sales: 'sale_key', artist_overrides: 'raw_name'};
  SupabaseStore.prototype.pageAll = async function (table) {
    var out = [], from = 0, size = 1000;
    for (;;) {
      var r = await this.sb.from(table).select('*').order(PKEY[table]).range(from, from + size - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < size) break;
      from += size;
    }
    return out;
  };
  SupabaseStore.prototype.loadAll = async function () {
    var res = await Promise.all([this.pageAll('orders'), this.pageAll('sales'), this.pageAll('artist_overrides')]);
    return {orders: res[0], sales: res[1], overrides: res[2]};
  };
  SupabaseStore.prototype.upsertOrders = async function (rows) {
    var uid = await this.userId(), now = new Date().toISOString(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('orders').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid, updated_at: now}); }), {onConflict: 'user_id,order_number'});
      if (r.error) throw r.error;
    }
  };
  SupabaseStore.prototype.insertSales = async function (rows) {
    var uid = await this.userId(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('sales').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid}); }), {onConflict: 'user_id,sale_key', ignoreDuplicates: true});
      if (r.error) throw r.error;
    }
  };
  SupabaseStore.prototype.replaceSales = async function (rows, oldKeys) {   // repair: write corrected rows, then drop the old copies
    var uid = await this.userId(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('sales').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid}); }), {onConflict: 'user_id,sale_key'});
      if (r.error) throw r.error;
    }
    var plain = oldKeys.filter(function (k) { return k.indexOf('"') < 0; }), quoted = oldKeys.filter(function (k) { return k.indexOf('"') >= 0; });
    for (var ks of chunk(plain, 40)) {
      var d = await self.sb.from('sales').delete().in('sale_key', ks);
      if (d.error) throw d.error;
    }
    for (var q of quoted) {
      var d2 = await self.sb.from('sales').delete().eq('sale_key', q);
      if (d2.error) throw d2.error;
    }
  };
  SupabaseStore.prototype.setOverrides = async function (rows) {
    var uid = await this.userId();
    var r = await this.sb.from('artist_overrides').upsert(rows.map(function (x) { return {user_id: uid, raw_name: x.raw_name, artist: x.artist}; }), {onConflict: 'user_id,raw_name'});
    if (r.error) throw r.error;
  };
  SupabaseStore.prototype.deleteSale = async function (key) {
    var r = await this.sb.from('sales').delete().eq('sale_key', key);
    if (r.error) throw r.error;
  };

  function MemoryStore() { this.o = {}; this.s = {}; this.m = {}; this.demo = true; }
  MemoryStore.prototype.loadAll = async function () {
    var self = this;
    return {orders: Object.keys(this.o).map(function (k) { return Object.assign({}, self.o[k]); }),
      sales: Object.keys(this.s).map(function (k) { return Object.assign({}, self.s[k]); }),
      overrides: Object.keys(this.m).map(function (k) { return {raw_name: k, artist: self.m[k]}; })};
  };
  MemoryStore.prototype.upsertOrders = async function (rows) { var self = this; rows.forEach(function (r) { self.o[r.order_number] = Object.assign({}, self.o[r.order_number] || {}, r); }); };
  MemoryStore.prototype.insertSales = async function (rows) { var self = this; rows.forEach(function (r) { if (!self.s[r.sale_key]) self.s[r.sale_key] = r; }); };
  MemoryStore.prototype.replaceSales = async function (rows, oldKeys) { var self = this; rows.forEach(function (r) { self.s[r.sale_key] = Object.assign({}, self.s[r.sale_key] || {}, r); }); oldKeys.forEach(function (k) { delete self.s[k]; }); };
  MemoryStore.prototype.setOverrides = async function (rows) { var self = this; rows.forEach(function (r) { self.m[r.raw_name] = r.artist; }); };
  MemoryStore.prototype.deleteSale = async function (key) { delete this.s[key]; };

  // ---------- state ----------
  var S = {store: null, raw: {orders: [], sales: [], overrides: []}, R: null, tab: 'overview', year: null, month: null,
    pendingOrders: null, pendingSales: null, sort: {}, search: {}, invStatus: 'all'};

  function rebuild() {
    var ov = {};
    S.raw.overrides.forEach(function (r) { ov[tt_norm(r.raw_name)] = r.artist; });
    S.R = tt_build(S.raw.orders.map(orderForBuild), S.raw.sales.map(saleFromDb), ov, new Date());
    S.orderIndex = {};
    S.raw.orders.forEach(function (r) { S.orderIndex[r.order_number] = r; });
    S.saleIndex = {};
    S.raw.sales.forEach(function (r) { S.saleIndex[r.sale_key] = true; });
    derive();
    if (!S.period) {
      var cur = tt_monthKey(new Date());
      S.period = S.R.monthly.some(function (m) { return m.month === cur && m.sales; }) ? 'this-month' : 'all';
    }
  }

  // Sales saved by the earlier version have a timestamp as the artist and the result label as the venue.
  // Every sale still has its order number, so take the artist + show date from the matching PL order.
  var TIER_RE = /^(MASSIVE SALE|FANTASTIC SALE|PROFITABLE|EHH SALE|BREAK EVEN|LOSS)$/i;
  function isScrambled(r) { return tt_notAName(r.event) || TIER_RE.test(String(r.venue || '').trim()); }   // tt_notAName also catches tier labels used as artist
  function repairsFromOrders() {
    var byOrder = {};
    S.R.orders.forEach(function (o) { byOrder[o.order] = o; });
    var out = [];
    S.raw.sales.forEach(function (r) {
      if (!isScrambled(r)) return;
      var fix = {sale_key: r.sale_key};
      var o = (r.order_numbers || []).map(function (n) { return byOrder[n]; }).filter(Boolean)[0];
      if (tt_notAName(r.event) && o && o.event && !tt_notAName(o.event)) { fix.event = o.event; fix.event_date = o.eventDate ? tt_dayKey(o.eventDate) : r.event_date; }
      if (TIER_RE.test(String(r.venue || '').trim())) { fix.result = String(r.venue).trim(); fix.venue = null; }
      if (Object.keys(fix).length > 1) out.push(fix);
    });
    return out;
  }
  async function reload(noRepair) {
    $('#loading').hidden = false;
    try {
      S.raw = await S.store.loadAll();
      rebuild();
      var fixes = noRepair ? [] : repairsFromOrders();
      if (fixes.length) {
        await S.store.replaceSales(fixes, []);
        S.raw = await S.store.loadAll();
        rebuild();

      }
      render();
    } catch (e) {
      toast('Could not load your data: ' + (e.message || e), true);
    } finally {
      $('#loading').hidden = true;
    }
  }

  // Quietly fetch the latest data and redraw only if something changed (keeps your place on the page).
  function dataSig(raw) {
    var last = '', sum = 0;
    raw.sales.forEach(function (r) { if ((r.sold_at || '') > last) last = r.sold_at || ''; sum += Number(r.profit) || 0; });
    return [raw.sales.length, raw.orders.length, (raw.overrides || []).length, last, sum.toFixed(2)].join('|');
  }
  var refreshing = false;
  async function quietRefresh(manual) {
    if (refreshing || !S.store || !S.R) return;
    var a = document.activeElement;
    if (!manual && a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;   // don't redraw while you're typing
    refreshing = true;
    var btn = $('#refreshBtn'); if (btn) btn.classList.add('spin');
    try {
      var raw = await S.store.loadAll();
      if (manual || dataSig(raw) !== dataSig(S.raw)) {
        var y = window.scrollY;
        S.raw = raw; rebuild(); render(); window.scrollTo(0, y);
      }
      S.lastRefresh = Date.now();
      var up = $('#updated'); if (up) up.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
    } catch (e) { if (manual) toast('Could not refresh: ' + (e.message || e), true); }
    finally { refreshing = false; if (btn) setTimeout(function () { btn.classList.remove('spin'); }, 400); }
  }
  function startAutoRefresh() {
    var rb = $('#refreshBtn'); if (rb) rb.onclick = function () { quietRefresh(true); };
    setInterval(function () { if (!document.hidden) quietRefresh(false); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - (S.lastRefresh || 0) > 15000) quietRefresh(false); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) quietRefresh(false); });
  }

  // ---------- generic table ----------
  function table(id, cols, rows, opts) {
    opts = opts || {};
    var st = S.sort[id] || opts.sort || null;
    var q = (S.search[id] || '').toLowerCase().trim();
    var list = rows;
    if (q) list = rows.filter(function (r) { return cols.some(function (c) { return String(fmt(c.get(r), c.fmt)).toLowerCase().indexOf(q) >= 0 || String(c.get(r) || '').toLowerCase().indexOf(q) >= 0; }); });
    if (st) {
      var col = cols.filter(function (c) { return c.label === st.label; })[0];
      if (col) list = list.slice().sort(function (a, b) {
        var x = col.get(a), y = col.get(b);
        if (x instanceof Date) x = +x; if (y instanceof Date) y = +y;
        if (x === null || x === undefined || x === '') return 1; if (y === null || y === undefined || y === '') return -1;
        var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return st.dir === 'asc' ? r : -r;
      });
    }
    var limit = opts.limit || 400, shown = list.slice(0, limit);
    var head = cols.map(function (c) {
      var arrow = st && st.label === c.label ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return '<th class="' + (c.num ? 'num' : '') + '" data-sort="' + esc(c.label) + '">' + esc(c.label) + arrow + '</th>';
    }).join('') + (opts.actions ? '<th></th>' : '');
    var body = shown.map(function (r, i) {
      return '<tr>' + cols.map(function (c) {
        var v = c.get(r), cls = (c.num ? 'num ' : '') + (c.signed ? signClass(v) : '') + (c.cls ? ' ' + c.cls : '');
        var shownV = esc(fmt(v, c.fmt)), href = c.link ? c.link(r) : null;
        if (href && shownV) shownV = '<a href="' + esc(href) + '">' + shownV + '</a>';
        return '<td class="' + cls + '"' + (c.wrap ? '' : ' style="white-space:nowrap"') + '>' + shownV + '</td>';
      }).join('') + (opts.actions ? '<td class="act">' + opts.actions(r, i) + '</td>' : '') + '</tr>';
    }).join('');
    var tools = '<div class="tabletools">' +
      (opts.searchable === false ? '' : '<input type="search" class="' + (opts.bigSearch ? 'big' : '') + '" placeholder="' + esc(opts.bigSearch || 'Search…') + '" data-search="' + id + '" value="' + esc(S.search[id] || '') + '">') +
      (opts.extraTools || '') +
      '<span class="count">' + (list.length > limit ? 'Showing ' + limit + ' of ' : '') + list.length.toLocaleString() + ' rows</span>' +
      (opts.nocsv ? '' : '<button class="ghost" data-csv="' + id + '">Download CSV</button>') + '</div>';
    S._tables = S._tables || {};
    S._tables[id] = {cols: cols, rows: list};
    return tools + '<div class="tablewrap"><table data-table="' + id + '"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="' + (cols.length + 1) + '" class="empty">' + esc(opts.empty || 'Nothing here yet.') + '</td></tr>') + '</tbody></table></div>';
  }
  function wireTables(root) {
    root.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var id = th.closest('table').dataset.table, label = th.dataset.sort, cur = S.sort[id];
        S.sort[id] = {label: label, dir: cur && cur.label === label && cur.dir === 'desc' ? 'asc' : 'desc'};
        render();
      };
    });
    root.querySelectorAll('input[data-search]').forEach(function (inp) {
      inp.oninput = function () {
        S.search[inp.dataset.search] = inp.value;
        var pos = inp.selectionStart; render();
        var again = $('input[data-search="' + inp.dataset.search + '"]');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      };
    });
    root.querySelectorAll('[data-csv]').forEach(function (b) {
      b.onclick = function () {
        var t = S._tables[b.dataset.csv];
        var lines = [t.cols.map(function (c) { return c.label; })].concat(t.rows.map(function (r) {
          return t.cols.map(function (c) { var v = c.get(r); return v instanceof Date ? fmt(v, c.fmt) : (v === null || v === undefined ? '' : v); });
        }));
        var csv = lines.map(function (l) { return l.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
        a.download = b.dataset.csv + '.csv'; a.click();
      };
    });
  }

  // ---------- derived data (artists, venues, shows) ----------
  function splitVenue(v) {
    var p = String(v || '').split(/\s+•\s+/);
    return {name: (p[0] || '').trim(), city: p.slice(1).join(', ').trim()};
  }
  function showKey(artist, d) { return artist + '|' + (d ? tt_dayKey(d) : ''); }
  function derive() {
    var D = {artists: {}, venues: {}, showVenue: {}};
    S.R.sales.forEach(function (s) { if (s.venue) D.showVenue[showKey(s.artist, s.eventDate)] = s.venue; });
    // Older sales were saved without a venue: borrow it from any other sale of the same show.
    S.R.sales.forEach(function (s) { if (!s.venue) { var v = D.showVenue[showKey(s.artist, s.eventDate)]; if (v) { s.venue = v; s.venueGuessed = true; } } });
    function A(n) { return D.artists[n] || (D.artists[n] = {name: n, orders: [], sales: []}); }
    function V(full) { var v = splitVenue(full); return D.venues[v.name] || (D.venues[v.name] = {name: v.name, city: v.city, orders: [], sales: []}); }
    S.R.orders.forEach(function (o) {
      o.venueFull = D.showVenue[showKey(o.artist, o.eventDate)] || '';
      A(o.artist).orders.push(o);
      if (o.venueFull) V(o.venueFull).orders.push(o);
    });
    S.R.sales.forEach(function (s) {
      A(s.artist).sales.push(s);
      if (s.venue) V(s.venue).sales.push(s);
    });
    S.D = D;
  }
  function holding(orders) {   // tickets still in hand for upcoming shows
    var t = 0, c = 0;
    orders.forEach(function (o) { if (!/passed/.test(o.status)) { t += o.remaining; c += o.unsoldCost; } });
    return {tickets: t, cost: c};
  }
  function artistLink(n) { return '#artist/' + encodeURIComponent(n); }
  function venueLink(n) { return n ? '#venue/' + encodeURIComponent(n) : null; }

  // ---------- kept helpers ----------
  function groupSales(list, keyFn) {
    var by = {};
    list.forEach(function (s) { var k = keyFn(s); (by[k] = by[k] || []).push(s); });
    return Object.keys(by).map(function (k) { var a = aggSales(by[k]); a.key = k; a.list = by[k]; return a; });
  }
  // ---------- import handling (auto-save) ----------
  function logImport(text) {
    S.importLog = S.importLog || [];
    S.importLog.push({when: new Date().toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}), text: text});
  }
  async function importOrders(name, rows) {
    var seen = {}, skipped = 0;
    rows.forEach(function (obj) { var r = csvRowToOrder(obj); if (!r) { skipped++; return; } seen[r.order_number] = r; });
    var fresh = [], changed = [], same = 0;
    Object.keys(seen).forEach(function (k) {
      var r = seen[k], cur = S.orderIndex[r.order_number];
      if (!cur) fresh.push(r); else if (orderSig(cur) !== orderSig(r)) changed.push(r); else same++;
    });
    var rowsToSave = fresh.concat(changed);
    if (rowsToSave.length) await S.store.upsertOrders(rowsToSave);
    var msg = name + ': ' + fresh.length + ' new orders, ' + changed.length + ' updated, ' + same + ' already saved' + (skipped ? ', ' + skipped + ' blank rows skipped' : '') + '.';
    logImport(msg);
    if (rowsToSave.length) await reload(); else render();
    toast(msg);
    return {added: fresh.length, updated: changed.length, same: same};
  }
  async function importSales(text) {
    var parsed = tt_parseDiscord(text || ''), seen = {}, fresh = [], fixes = [], dupes = 0;
    if (!parsed.length) { toast('No sales found in that text. Make sure it includes the full sale messages.', true); return {parsed: 0, added: 0, dupes: 0}; }
    // Match against what is saved using the stable key (time, seats, qty, total, site, order #) —
    // so a sale saved earlier with a scrambled artist/venue gets repaired instead of duplicated.
    var saved = {}, loose = {};
    function looseKey(x) { var d = x.soldAt; return [d ? tt_dayKey(d) + ' ' + d.getHours() + ':' + d.getMinutes() : '', normSecKey(x.section), String(x.row || '').trim(), x.qty, Number(x.total).toFixed(2)].join('|'); }
    function normSecKey(v) { return String(v || '').toUpperCase().replace(/^(SECTION|SEC)\.?\s+/, '').trim(); }
    S.raw.sales.forEach(function (r) {
      var o = saleFromDb(r); saved[tt_saleKey(o)] = r;
      var lk = looseKey(o); loose[lk] = loose[lk] === undefined ? r : null;   // null = ambiguous, don't use
    });
    parsed.forEach(function (s) {
      if (seen[s.key]) { dupes++; return; }
      seen[s.key] = 1;
      var cur = saved[s.key] || loose[looseKey(s)] || null;
      if (!cur) fresh.push(s);
      else if (cur.sale_key !== s.key || (cur.event || '') !== s.event || (cur.venue || '') !== (s.venue || '') ||
        String(cur.event_date || '') !== String(ymd(s.eventDate) || '') || (cur.result || '') !== (s.result || '')) fixes.push({old: cur.sale_key, s: s});
      else dupes++;
    });
    if (fresh.length) await S.store.insertSales(fresh.map(saleToDb));
    if (fixes.length) await S.store.replaceSales(fixes.map(function (f) { return saleToDb(f.s); }),
      fixes.filter(function (f) { return f.old !== f.s.key; }).map(function (f) { return f.old; }));
    var profit = fresh.reduce(function (t, s) { return t + s.profit; }, 0);
    var unmatched = fresh.filter(function (s) { return !s.orders.some(function (o) { return S.orderIndex[o]; }); }).length;
    var msg = 'Discord: ' + fresh.length + ' new sales' + (fresh.length ? ' (' + fmt(profit, 'susd') + ')' : '') +
      (fixes.length ? ', ' + fixes.length + ' repaired' : '') + ', ' + dupes + ' already saved' +
      (unmatched ? ', ' + unmatched + ' not found in PL orders yet (add the newest CSV)' : '') + '.';
    logImport(msg);
    if (fresh.length || fixes.length) await reload(); else render();
    toast(msg);
    var byArt = {};
    fresh.forEach(function (x) { var k = x.event || 'Unknown'; var b = byArt[k] || (byArt[k] = {artist: k, sales: 0, profit: 0}); b.sales++; b.profit += x.profit; });
    var items = Object.keys(byArt).map(function (k) { return byArt[k]; }).sort(function (x, y) { return Math.abs(y.profit) - Math.abs(x.profit); }).slice(0, 6);
    items.forEach(function (it) { it.artist = tt_baseArtist(it.artist); });
    return {parsed: parsed.length, added: fresh.length, fixed: fixes.length, dupes: dupes, unmatched: unmatched, profit: Math.round(profit * 100) / 100,
      tickets: fresh.reduce(function (t, x) { return t + x.qty; }, 0), items: items};
  }
  function readCsvFile(file) {
    Papa.parse(file, {header: true, skipEmptyLines: true, complete: function (res) {
      var keys = (res.meta.fields || []).map(headerKey);
      if (keys.indexOf('order_number') < 0) { toast('That CSV has no "Order Number" column — is it the PL orders export?', true); return; }
      importOrders(file.name, res.data).catch(function (e) { toast('Save failed: ' + (e.message || e), true); });
    }, error: function (e) { toast('Could not read CSV: ' + e.message, true); }});
  }

  // ---------- period: one picker (Day / Month / Year / All) with ‹ › to step ----------
  function monthKeyOffset(k, n) { var p = k.split('-'); var d = new Date(+p[0], +p[1] - 1 + n, 1); return tt_monthKey(d); }
  function curMonth() { return tt_monthKey(new Date()); }
  function normPeriod() {
    var p = S.period || 'this-month', cur = curMonth();
    if (p === 'this-month' || p === 'last-3') p = 'm:' + cur;
    else if (p === 'last-month') p = 'm:' + monthKeyOffset(cur, -1);
    else if (p === 'this-year') p = 'y:' + cur.slice(0, 4);
    S.period = p;
    return p;
  }
  function pmode() { var p = normPeriod(); return p === 'all' ? 'all' : p.charAt(0) === 'r' ? 'range' : p.charAt(0) === 'd' ? 'day' : p.charAt(0) === 'y' ? 'year' : 'month'; }
  function periodRange() {
    var p = normPeriod();
    if (p === 'all') return {from: '0000-00', to: '9999-99'};
    if (p.charAt(0) === 'r') return {from: tt_monthKey(rangeStart(+p.slice(2))), to: curMonth()};
    if (p.charAt(0) === 'y') return {from: p.slice(2) + '-01', to: p.slice(2) + '-12'};
    if (p.charAt(0) === 'd') return {from: p.slice(2, 9), to: p.slice(2, 9)};
    return {from: p.slice(2), to: p.slice(2)};
  }
  function inPeriod(d) {
    if (!d) return false;
    var p = normPeriod();
    if (p.charAt(0) === 'd') return tt_dayKey(d) === p.slice(2);
    if (p.charAt(0) === 'r') return d >= rangeStart(+p.slice(2));
    var k = tt_monthKey(d), r = periodRange();
    return k >= r.from && k <= r.to;
  }
  function monthLong(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-US', {month: 'long', year: 'numeric'}); }
  function dayDate(k) { var a = k.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function dayLabel(k) { var d = dayDate(k), n = daysUntil(d); return (n === 0 ? 'Today, ' : n === -1 ? 'Yesterday, ' : '') + d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined}); }
  function periodLabel() {
    var p = normPeriod();
    if (p === 'all') return 'All time';
    if (p.charAt(0) === 'r') return 'Last ' + p.slice(2) + ' days';
    if (p.charAt(0) === 'y') return p.slice(2);
    if (p.charAt(0) === 'd') return dayLabel(p.slice(2));
    return monthLong(p.slice(2));
  }
  function allMonths() {
    var set = {};
    S.R.monthly.forEach(function (m) { if (m.month) set[m.month] = 1; });
    set[curMonth()] = 1;
    return Object.keys(set).sort();
  }
  function dataYears() { var ys = {}; allMonths().forEach(function (m) { ys[m.slice(0, 4)] = 1; }); return Object.keys(ys).sort(); }
  function stepTarget(dir) {
    var p = normPeriod(), m = pmode(), cur = curMonth();
    if (m === 'month') { var k = monthKeyOffset(p.slice(2), dir), ms = allMonths(); return k < ms[0] || k > cur ? null : 'm:' + k; }
    if (m === 'year') { var y = String(+p.slice(2) + dir), ys = dataYears(); return y < ys[0] || y > ys[ys.length - 1] ? null : 'y:' + y; }
    if (m === 'day') {
      var d = dayDate(p.slice(2)); d.setDate(d.getDate() + dir); var dk = tt_dayKey(d);
      return dk > tt_dayKey(new Date()) || dk.slice(0, 7) < allMonths()[0] ? null : 'd:' + dk;
    }
    return null;
  }
  function modeTarget(mode) {
    var r = periodRange(), cur = curMonth(), anchor = r.to > cur || r.to === '9999-99' ? cur : r.to;
    if (mode === 'all') return 'all';
    if (mode === 'year') return 'y:' + anchor.slice(0, 4);
    if (mode === 'month') return 'm:' + (pmode() === 'year' && anchor.slice(0, 4) === cur.slice(0, 4) ? cur : anchor);
    // day: today if we're looking at this month, otherwise the last day of that month with a sale
    if (anchor === cur) return 'd:' + tt_dayKey(new Date());
    var by = dailyStats(), days = Object.keys(by).filter(function (k) { return k.slice(0, 7) === anchor; }).sort();
    return 'd:' + (days.length ? days[days.length - 1] : anchor + '-01');
  }
  function periodPicker() {
    var m = pmode(), prev = stepTarget(-1), next = stepTarget(1);
    return '<div class="pp"><div class="seg" role="group" aria-label="Period">' +
      [['day', 'Day'], ['month', 'Month'], ['year', 'Year'], ['all', 'All']].map(function (o) { return '<button data-pmode="' + o[0] + '" class="' + (m === o[0] ? 'on' : '') + '" aria-pressed="' + (m === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div>' +
      (m === 'all' ? '' : '<div class="step"><button data-pgo="' + esc(prev || '') + '"' + (prev ? '' : ' disabled') + ' aria-label="Previous">‹</button><span>' + esc(periodLabel()) + '</span><button data-pgo="' + esc(next || '') + '"' + (next ? '' : ' disabled') + ' aria-label="Next">›</button></div>') + '</div>';
  }
  function prevOf() {   // the period before this one, for the "vs" line
    var p = normPeriod(), m = pmode();
    if (m === 'month') { var k = monthKeyOffset(p.slice(2), -1); return {label: monthLong(k), test: function (d) { return d && tt_monthKey(d) === k; }}; }
    if (m === 'year') { var y = String(+p.slice(2) - 1); return {label: y, test: function (d) { return d && String(d.getFullYear()) === y; }}; }
    if (m === 'range') { var n = +p.slice(2), a0 = rangeStart(n, 1), a1 = rangeStart(n); return {label: 'previous ' + n + ' days', test: function (d) { return d && d >= a0 && d < a1; }}; }
    if (m === 'day') { var dd = dayDate(p.slice(2)); dd.setDate(dd.getDate() - 1); var dk = tt_dayKey(dd); return {label: 'the day before', test: function (d) { return d && tt_dayKey(d) === dk; }}; }
    return null;
  }

  function aggSales(list) {
    var a = {sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0, wins: 0};
    list.forEach(function (s) { a.sales++; a.tickets += s.qty; a.revenue += s.total; a.cost += s.total - s.profit; a.profit += s.profit; if (s.profit > 0) a.wins++; });
    a.roi = a.cost ? a.profit / a.cost : null; a.winRate = a.sales ? a.wins / a.sales : null;
    return a;
  }
  function dailyStats() {
    if (S._daily) return S._daily;
    var by = {};
    S.R.sales.forEach(function (s) { if (!s.soldAt) return; var k = tt_dayKey(s.soldAt); var d = by[k] || (by[k] = {day: k, sales: 0, tickets: 0, revenue: 0, profit: 0, arts: {}}); d.sales++; d.tickets += s.qty; d.revenue += s.total; d.profit += s.profit; d.arts[s.artist] = (d.arts[s.artist] || 0) + s.profit; });
    return (S._daily = by);
  }

  // ---------- chart: bars follow the period (days of a month, months of a year, years) ----------
  function chartSeries() {
    var m = pmode(), p = normPeriod(), out = [];
    if (m === 'month' || m === 'day') {
      var mk = periodRange().from, a = mk.split('-'), n = new Date(+a[0], +a[1], 0).getDate(), by = dailyStats(), sel = m === 'day' ? p.slice(2) : null, today = tt_dayKey(new Date());
      for (var i = 1; i <= n; i++) {
        var k = mk + '-' + (i < 10 ? '0' : '') + i, d = by[k] || {};
        out.push({go: 'd:' + k, label: (i === 1 || i % 5 === 0) ? String(i) : '', title: dayLabel(k), v: d.profit || 0, sales: d.sales || 0, tickets: d.tickets || 0, dim: sel && sel !== k, today: k === today});
      }
      return {items: out, title: 'Profit by day'};
    }
    var bym = {}; S.R.monthly.forEach(function (x) { bym[x.month] = x; });
    if (m === 'year' || dataYears().length < 2) {
      var months = m === 'year' ? (function () { var y = p.slice(2), r = []; for (var j = 1; j <= 12; j++) r.push(y + '-' + (j < 10 ? '0' : '') + j); return r; })() : allMonths();
      months.forEach(function (k) { var x = bym[k] || {}; out.push({go: 'm:' + k, label: monthLabel(k).split(' ')[0], title: monthLong(k), v: x.profit || 0, sales: x.sales || 0, tickets: x.tickets || 0}); });
      return {items: out, title: 'Profit by month'};
    }
    dataYears().forEach(function (y) {
      var t = {profit: 0, sales: 0, tickets: 0}; S.R.monthly.forEach(function (x) { if (x.month.slice(0, 4) === y) { t.profit += x.profit || 0; t.sales += x.sales || 0; t.tickets += x.tickets || 0; } });
      out.push({go: 'y:' + y, label: y, title: y, v: t.profit, sales: t.sales, tickets: t.tickets});
    });
    return {items: out, title: 'Profit by year'};
  }
  function drawCharts(root) {
    root.querySelectorAll('div.chart').forEach(function (box) {
      var ser = chartSeries(), items = ser.items, W = Math.max(280, Math.round(box.clientWidth)), H = window.innerWidth < 700 ? 170 : 210;
      var vals = items.map(function (x) { return x.v; }), max = Math.max(0, Math.max.apply(null, vals)), min = Math.min(0, Math.min.apply(null, vals));
      if (max === min) max = 1;
      var padL = 52, padR = 4, padT = 8, padB = 22, iw = W - padL - padR, ih = H - padT - padB, bw = iw / items.length;
      var y = function (v) { return padT + (max - v) / (max - min) * ih; };
      var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ser.title) + '">';
      [max, 0, min].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (t) {
        s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="' + (t === 0 ? 'axis' : 'grid') + '"/><text x="' + (padL - 8) + '" y="' + (y(t) + 4) + '" class="tick" text-anchor="end">' + esc(fmt(t, 'usd0')) + '</text>';
      });
      items.forEach(function (x, i) {
        var bx = padL + i * bw, w = Math.max(2, Math.min(28, bw * 0.62)), cx = bx + (bw - w) / 2, top = y(Math.max(x.v, 0)), h = Math.max(x.v ? 2 : 0, Math.abs(y(x.v) - y(0)));
        if (x.v) s += '<rect x="' + cx + '" y="' + (x.v > 0 ? top : y(0)) + '" width="' + w + '" height="' + h + '" rx="' + Math.min(3, w / 2) + '" class="bar ' + (x.v > 0 ? 'up' : 'down') + (x.dim ? ' dim' : '') + '"/>';
        if (x.label) s += '<text x="' + (bx + bw / 2) + '" y="' + (H - 6) + '" class="tick' + (x.today ? ' today' : '') + '" text-anchor="middle">' + esc(x.label) + '</text>';
        s += '<rect x="' + bx + '" y="' + padT + '" width="' + bw + '" height="' + ih + '" class="hit" data-i="' + i + '"/>';
      });
      box.innerHTML = s + '</svg><div class="tip" hidden></div>';
      var tip = box.querySelector('.tip');
      box.querySelectorAll('.hit').forEach(function (r) {
        var x = items[+r.dataset.i];
        r.onmousemove = function (e) {
          tip.innerHTML = '<b>' + esc(x.title) + '</b><span class="' + signClass(x.v) + '">' + esc(fmt(x.v, 'susd')) + '</span><small>' + pl(x.sales, 'sale') + ' · ' + pl(x.tickets, 'ticket') + '</small>';
          tip.hidden = false;
          var b = box.getBoundingClientRect(), left = e.clientX - b.left + 14; if (left > b.width - 170) left = e.clientX - b.left - 170;
          tip.style.left = left + 'px'; tip.style.top = Math.max(0, e.clientY - b.top - 30) + 'px';
        };
        r.onmouseleave = function () { tip.hidden = true; };
        r.onclick = function () { setPeriod(x.go); };
      });
    });
  }
  if (!window.__ttRs) { window.__ttRs = 1; var rst; window.addEventListener('resize', function () { clearTimeout(rst); rst = setTimeout(function () { var m = document.getElementById('view'); if (m && !m.classList.contains('legacy')) drawCharts(m); }, 120); }); }

  // ---------- small building blocks ----------
  function pl(n, w) { return (n || 0).toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  function money(v, cls) { return '<span class="' + (cls || '') + ' ' + signClass(v) + '">' + esc(fmt(v, 'susd')) + '</span>'; }
  function today0() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function daysUntil(d) { return d ? Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today0()) / 864e5) : null; }
  function whenText(d) {
    var n = daysUntil(d); if (n === null) return 'Date unknown';
    if (n === 0) return 'Today'; if (n === 1) return 'Tomorrow'; if (n === -1) return 'Yesterday';
    if (n > 1 && n < 14) return 'In ' + n + ' days'; if (n < -1 && n > -14) return n * -1 + ' days ago';
    return fmt(d, 'date');
  }
  function dateY(d) { return d ? d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : '—'; }
  function dateS(d) { return d ? d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined}) : '—'; }
  function timeS(d) { return d ? d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}) : ''; }
  function matches(id, text) { var q = (S.search[id] || '').toLowerCase().trim(); return !q || String(text).toLowerCase().indexOf(q) >= 0; }
  function limitFor(id, base) { return (S.limit && S.limit[id]) || base; }
  function moreBtn(id, shown, total) { return total > shown ? '<button class="more" data-more="' + id + '" data-base="' + shown + '">Show ' + Math.min(100, total - shown) + ' more · ' + (total - shown).toLocaleString() + ' left</button>' : ''; }
  function empty(msg, action) { return '<div class="empty"><p>' + esc(msg) + '</p>' + (action || '') + '</div>'; }
  function searchBox(id, ph) { return '<label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" data-q="' + id + '" placeholder="' + esc(ph) + '" value="' + esc(S.search[id] || '') + '" aria-label="' + esc(ph) + '"></label>'; }
  function seg(id, opts, cur) { return '<div class="seg" role="group">' + opts.map(function (o) { return '<button data-sortchip="' + id + '" data-v="' + esc(o[0]) + '" class="' + (cur === o[0] ? 'on' : '') + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>'; }
  function pageHead(title, right, opts) {
    opts = opts || {};
    return '<header class="ph"><div class="ph-l">' + (opts.back ? '<a class="back" href="' + opts.back[0] + '">‹ ' + esc(opts.back[1]) + '</a>' : '') +
      '<h1>' + esc(title) + (opts.after || '') + '</h1>' + (opts.sub ? '<p class="ph-sub">' + opts.sub + '</p>' : '') + '</div>' + (right ? '<div class="ph-r">' + right + '</div>' : '') + '</header>';
  }
  function card(title, action, body, cls) {
    return '<section class="card' + (cls ? ' ' + cls : '') + '">' + (title ? '<header class="card-h"><h2>' + title + '</h2>' + (action || '') + '</header>' : '') + body + '</section>';
  }
  function fact(label, value, sub, cls) { return '<div class="fact"><dt>' + esc(label) + '</dt><dd class="' + (cls || '') + '">' + esc(value) + '</dd>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; }
  function hero(label, value, cls, under, facts, extra) {
    return '<section class="hero"><div class="hero-main"><div class="eyebrow">' + esc(label) + '</div><div class="big ' + (cls || '') + '">' + esc(value) + '</div>' + (under ? '<div class="under">' + under + '</div>' : '') + (extra || '') + '</div>' +
      '<dl class="facts">' + facts.join('') + '</dl></section>';
  }
  function bar(part, whole, cls) { var p = whole ? Math.max(0, Math.min(100, Math.round(part / whole * 100))) : 0; return '<span class="mbar ' + (cls || '') + '"><i style="width:' + p + '%"></i></span>'; }
  function listItem(href, title, sub, value, valCls, valSub) {
    return '<a class="li" href="' + esc(href) + '"><span class="li-m"><b>' + esc(title) + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="li-v"><b class="' + (valCls || '') + '">' + value + '</b>' + (valSub ? '<small>' + valSub + '</small>' : '') + '</span></a>';
  }

  // Generic table. cols: [key, label, width, flags] flags: n=number, p=primary (phone title), v=value (phone right), md=hide on smaller screens, s=sortKey
  function table(cols, body, opts) {
    opts = opts || {};
    var full = cols.map(function (c) { return c[2]; }).join(' '), md = cols.filter(function (c) { return !(c[3] || {}).md; }).map(function (c) { return c[2]; }).join(' ');
    var head = opts.noHead ? '' : '<div class="tr th-row" aria-hidden="true">' + cols.map(function (c) {
      var f = c[3] || {}, cls = 'td' + (f.n ? ' n' : '') + (f.md ? ' md' : '');
      if (f.s && opts.sortId) {
        var on = (S.sort[opts.sortId] || opts.sortDefault) === f.s, rev = !!S.sort[opts.sortId + 'Rev'];
        return '<span class="' + cls + '"><button class="th' + (on ? ' on' : '') + '" data-sortchip="' + opts.sortId + '" data-v="' + f.s + '" title="Sort (click again to flip)">' + esc(c[1]) + (on ? (rev ? ' ↑' : ' ↓') : '') + '</button></span>';
      }
      return '<span class="' + cls + '">' + esc(c[1]) + '</span>';
    }).join('') + '</div>';
    return '<div class="tbl' + (opts.cls ? ' ' + opts.cls : '') + '" style="--cols:' + full + ';--cols-md:' + md + '">' + head + body + '</div>';
  }
  // one row: cells = {key: html}; tag/attrs make it clickable
  function trow(cols, cells, o) {
    o = o || {};
    var tag = o.href ? 'a' : 'div';
    return '<' + tag + ' class="tr' + (o.cls ? ' ' + o.cls : '') + '"' + (o.href ? ' href="' + esc(o.href) + '"' : '') + (o.attrs || '') + (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' +
      cols.map(function (c) { var f = c[3] || {}; return '<span class="td c-' + c[0] + (f.n ? ' n' : '') + (f.p ? ' p' : '') + (f.v ? ' v' : '') + (f.md ? ' md' : '') + '">' + (cells[c[0]] === undefined ? '' : cells[c[0]]) + '</span>'; }).join('') +
      (o.meta ? '<span class="td-meta">' + o.meta + '</span>' : '') + '</' + tag + '>';
  }
  function tgroup(label, sub, right) { return '<div class="tg"><b>' + esc(label) + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + (right ? '<span class="tg-r">' + right + '</span>' : '') + '</div>'; }
  function two(b, small, cls) { return '<b class="' + (cls || '') + '">' + b + '</b>' + (small ? '<small>' + small + '</small>' : ''); }
  function sortRows(rows, id, def, sorters) {
    var mode = S.sort[id] || def, dir = S.sort[id + 'Rev'] ? -1 : 1, fn = sorters[mode] || sorters[def];
    rows.sort(function (a, b) { return dir * fn(a, b); });
    return rows;
  }

  // ---------- shows (artist + date), from PL orders plus sales ----------
  function allShows() {
    if (S._shows) return S._shows;
    var by = {};
    function SH(artist, d) {
      var k = showKey(artist, d);
      return by[k] || (by[k] = {key: k, artist: artist, date: d, venue: '', bought: 0, sold: 0, left: 0, spent: 0, leftCost: 0, orders: [], sales: []});
    }
    S.R.orders.forEach(function (o) {
      var x = SH(o.artist, o.eventDate);
      x.bought += o.qty; x.sold += o.soldQty; x.left += o.remaining; x.spent += o.total; x.leftCost += o.unsoldCost; x.orders.push(o);
      if (o.venueFull && !x.venue) x.venue = o.venueFull;
    });
    var byNum = {}; S.R.orders.forEach(function (o) { byNum[o.order] = o; });
    S.R.sales.forEach(function (s) {
      // 1) the show on the sale itself, 2) the show of the order it came from, 3) a show of that artist within a day
      var x = by[showKey(s.artist, s.eventDate)];
      if (!x) { var o = null; (s.orders || []).some(function (n) { return (o = byNum[n]) && o.artist === s.artist; }); if (o) x = by[showKey(o.artist, o.eventDate)]; }
      if (!x && s.eventDate) Object.keys(by).some(function (k) { var y = by[k]; if (y.artist === s.artist && y.date && Math.abs(y.date - s.eventDate) < 36e5 * 36) { x = y; return true; } });
      if (!x) x = SH(s.artist, s.eventDate);
      x.sales.push(s); if (s.venue && !x.venue) x.venue = s.venue;
    });
    S._shows = Object.keys(by).map(function (k) { var x = by[k]; x.p = aggSales(x.sales); x.sold = x.p.tickets; x.bought = x.sold + x.left; return x; });
    return S._shows;
  }
  // When the tickets were bought: from the Discord alert, or else from the linked PL order.
  function boughtDate(s) {
    if (s.purchased) return s.purchased;
    if (!S._byOrderNum) { S._byOrderNum = {}; S.R.orders.forEach(function (o) { S._byOrderNum[o.order] = o; }); }
    var o = null; (s.orders || []).some(function (n) { return (o = S._byOrderNum[n]) && o.bought; });
    return o ? o.bought : null;
  }

  // ---------- sales table: one line per sale, grouped by the day it sold ----------
  function salesTable(list, opts) {
    opts = opts || {};
    var cols = [['time', opts.noGroup ? 'Sold' : 'Time', opts.noGroup ? '92px' : '68px']];
    if (!opts.noArtist) cols.push(['art', 'Artist', 'minmax(120px,1fr)', {p: 1}]);
    if (!opts.noVenue) cols.push(['ven', 'Venue', 'minmax(120px,1.15fr)']);
    if (!opts.noShowDate) cols.push(['show', 'Show', '100px']);
    cols.push(['bought', 'Bought', '100px', {md: 1}], ['sec', 'Section', 'minmax(80px,.7fr)', opts.noArtist ? {p: 1} : null], ['row', 'Row', '50px'], ['qty', 'Qty', '40px', {n: 1}],
      ['sold', 'Sold each', '96px', {n: 1}], ['pl', 'Profit', '104px', {n: 1, v: 1}]);
    function row(s) {
      var v = splitVenue(s.venue);
      var tip = [s.marketplace ? 'Sold on ' + s.marketplace : '', s.timeToSell ? s.timeToSell + ' to sell' : '', s.orders && s.orders.length ? 'Order ' + s.orders.join(', ') : ''].filter(Boolean).join(' · ');
      var meta = [opts.noGroup ? dateS(s.soldAt) : timeS(s.soldAt), (opts.noArtist ? (s.row ? 'Row ' + esc(s.row) : '') : 'Sec ' + esc(s.section) + (s.row ? ' · Row ' + esc(s.row) : '')), s.qty + ' × ' + esc(fmt(s.soldPer, 'usd0'))].filter(Boolean).concat(!opts.noVenue && v.name ? [esc(v.name)] : []).join(' · ');
      return trow(cols, {
        time: opts.noGroup ? two(esc(dateS(s.soldAt)), esc(timeS(s.soldAt))) : '<span class="dim2">' + esc(timeS(s.soldAt)) + '</span>',
        art: '<a href="' + esc(artistLink(s.artist)) + '" class="strong">' + esc(s.artist) + '</a>',
        ven: v.name ? '<a href="' + esc(venueLink(v.name)) + '" class="soft">' + esc(v.name) + '</a>' : '<span class="dim">—</span>',
        show: '<span class="soft">' + esc(dateY(s.eventDate)) + '</span>',
        bought: '<span class="soft">' + esc(dateY(boughtDate(s))) + '</span>',
        sec: '<b>' + esc(s.section) + '</b>', row: '<span class="soft">' + esc(s.row || '—') + '</span>', qty: String(s.qty),
        sold: two(esc(fmt(s.soldPer, 'usd')), 'paid ' + esc(fmt(s.costPer, 'usd'))),
        pl: two(esc(fmt(s.profit, 'susd')), esc(fmt(s.roi, 'spct')), signClass(s.profit))
      }, {title: tip, meta: meta, cls: opts.noArtist ? 'noart' : ''});
    }
    var body;
    if (opts.noGroup) body = list.map(row).join('');
    else {
      var groups = [], cur = null;
      list.forEach(function (s) { var k = s.soldAt ? tt_dayKey(s.soldAt) : ''; if (!cur || cur.k !== k) { cur = {k: k, d: s.soldAt, items: []}; groups.push(cur); } cur.items.push(s); });
      body = groups.map(function (g) {
        var a = aggSales(g.items), n = daysUntil(g.d), full = g.d ? g.d.toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric', year: g.d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined}) : 'Unknown date';
        return tgroup(n === 0 ? 'Today · ' + full : n === -1 ? 'Yesterday · ' + full : full, pl(a.sales, 'sale') + ' · ' + pl(a.tickets, 'ticket'), money(a.profit)) + g.items.map(row).join('');
      }).join('');
    }
    return table(cols, body, {cls: 'sales'});
  }

  // ---------- sections: which sections sold, for how much ----------
  function normSec(x) { return String(x || '').toUpperCase().replace(/^(SECTION|SEC)\.?\s+/, '').replace(/\s+/g, ' ').trim(); }
  function orderSections(seats) {
    var out = [], re = /Sec(?:tion)?\.?\s+([A-Za-z0-9][A-Za-z0-9 \-]*?)(?=\s*(?:,|•|\bRow\b|$))/gi, m;
    while ((m = re.exec(String(seats || ''))) !== null) { var k = normSec(m[1]); if (k && out.indexOf(k) < 0) out.push(k); }
    return out;
  }
  function sectionRows(sales, orders) {
    var by = {};
    function B(k) { return by[k] || (by[k] = {sec: k, sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0, lo: null, hi: null, left: 0, paid: 0}); }
    sales.forEach(function (s) {
      var b = B(normSec(s.section) || '?');
      b.sales++; b.tickets += s.qty; b.revenue += s.total; b.cost += s.total - s.profit; b.profit += s.profit;
      b.lo = b.lo === null ? s.soldPer : Math.min(b.lo, s.soldPer); b.hi = b.hi === null ? s.soldPer : Math.max(b.hi, s.soldPer);
    });
    (orders || []).forEach(function (o) {
      if (!o.remaining) return;
      var secs = orderSections(o.seats);
      if (secs.length === 1) { var b = B(secs[0]); b.left += o.remaining; b.paid = b.paid || (o.qty ? o.total / o.qty : 0); }
    });
    return Object.keys(by).map(function (k) { var b = by[k]; b.avgSold = b.tickets ? b.revenue / b.tickets : null; b.avgPaid = b.tickets ? b.cost / b.tickets : (b.paid || null); b.roi = b.cost ? b.profit / b.cost : null; b.gain = b.avgSold !== null && b.avgPaid !== null ? b.avgSold - b.avgPaid : null; return b; });
  }
  function sectionTable(sales, orders, sortId) {
    var rows = sectionRows(sales, orders);
    if (!rows.length) return empty('No sections yet.');
    var sold = sortRows(rows.filter(function (r) { return r.tickets; }), sortId, 'profit', {
      profit: function (a, b) { return b.profit - a.profit; }, price: function (a, b) { return (b.avgSold || 0) - (a.avgSold || 0); }, sold: function (a, b) { return b.tickets - a.tickets; },
      name: function (a, b) { return a.sec.localeCompare(b.sec, undefined, {numeric: true}); }, gain: function (a, b) { return (b.gain || 0) - (a.gain || 0); }, paid: function (a, b) { return (b.avgPaid || 0) - (a.avgPaid || 0); }});
    var un = rows.filter(function (r) { return !r.tickets; });
    var cols = [['sec', 'Section', 'minmax(90px,1fr)', {p: 1, s: 'name'}], ['sold', 'Sold', 'minmax(140px,1.2fr)', {s: 'sold'}], ['paid', 'Paid', '90px', {n: 1, s: 'paid', md: 1}],
      ['each', 'Sold for', '120px', {n: 1, s: 'price'}], ['pl', 'Profit', '130px', {n: 1, v: 1, s: 'profit'}]];
    var body = sold.map(function (r) {
      return trow(cols, {
        sec: '<b>' + esc(r.sec) + '</b>',
        sold: '<span class="soldcell">' + bar(r.tickets, r.tickets + r.left) + '<span>' + r.tickets + ' of ' + (r.tickets + r.left) + (r.left ? ' · <em class="warn">' + r.left + ' left</em>' : '') + '</span></span>',
        paid: r.avgPaid === null ? '—' : esc(fmt(r.avgPaid, 'usd0')),
        each: two(esc(fmt(r.avgSold, 'usd0')), r.lo !== r.hi ? esc(fmt(r.lo, 'usd0')) + '–' + esc(fmt(r.hi, 'usd0')) : ''),
        pl: two(esc(fmt(r.profit, 'susd')), pl(r.sales, 'sale') + (r.roi === null ? '' : ' · ' + esc(fmt(r.roi, 'spct'))), signClass(r.profit))
      }, {meta: r.tickets + ' of ' + (r.tickets + r.left) + ' sold · ' + esc(fmt(r.avgSold, 'usd0')) + ' each, paid ' + esc(fmt(r.avgPaid, 'usd0'))});
    }).join('');
    var tail = un.length ? '<div class="unsold"><span>Not sold yet</span>' + un.map(function (r) { return '<span class="tag"><b>' + esc(r.sec) + '</b> ' + r.left + ' left' + (r.avgPaid ? ' · paid ' + esc(fmt(r.avgPaid, 'usd0')) : '') + '</span>'; }).join('') + '</div>' : '';
    return (sold.length ? table(cols, body, {sortId: sortId, sortDefault: 'profit'}) : '') + tail;
  }

  // ---------- views ----------
  function artistRows() {
    return Object.keys(S.D.artists).map(function (n) {
      var A = S.D.artists[n];
      var a = aggSales(A.sales.filter(function (s) { return inPeriod(s.soldAt); }));
      var h = holding(A.orders), last = null;
      A.sales.forEach(function (s) { if (s.soldAt && (!last || s.soldAt > last)) last = s.soldAt; });
      a.name = n; a.left = h.tickets; a.last = last;
      return a;
    });
  }
  function showLink(x) { return '#show/' + encodeURIComponent(x.key); }
  function showsTable(shows) {
    var withSales = shows.filter(function (x) { return x.p.sales; }).sort(function (x, y) { return (y.date || 0) - (x.date || 0); });
    var unsold = shows.filter(function (x) { return !x.p.sales; }).sort(function (x, y) { return (x.date || 0) - (y.date || 0); });
    var cols = [['date', 'Show', '170px', {p: 1}], ['ven', 'Venue', 'minmax(160px,1.4fr)'], ['sold', 'Sold', 'minmax(150px,1fr)', {md: 1}], ['pl', 'Profit', '130px', {n: 1, v: 1}], ['go', '', '20px']];
    function row(x) {
      var v = splitVenue(x.venue), n = daysUntil(x.date), past = n !== null && n < 0, has = x.p.sales > 0, wt = x.date ? whenText(x.date) : '';
      var sub = x.date ? x.date.toLocaleDateString('en-US', {weekday: 'long'}) + (/\d{4}/.test(wt) ? '' : ' · ' + wt) : '';
      var soldTxt = (x.sold ? x.sold + ' sold' : '') + (x.left ? (x.sold ? ' · ' : '') + '<em class="' + (past ? 'neg' : 'warn') + '">' + x.left + (past ? ' unsold' : ' left') + '</em>' : (x.sold ? ' · all sold' : ''));
      return trow(cols, {
        date: two(esc(dateY(x.date)), esc(sub), !past && n !== null && n <= 7 && x.left ? 'warn' : ''),
        ven: v.name ? two(esc(v.name), esc(v.city)) : '<span class="dim">—</span>',
        sold: '<span class="soldcell">' + bar(x.sold, x.sold + x.left) + '<span>' + soldTxt + '</span></span>',
        pl: has ? two(esc(fmt(x.p.profit, 'susd')), pl(x.p.sales, 'sale') + (x.p.roi === null ? '' : ' · ' + esc(fmt(x.p.roi, 'spct'))), signClass(x.p.profit)) : (x.leftCost ? two('<span class="soft">' + esc(fmt(x.leftCost, 'usd0')) + '</span>', 'paid') : ''),
        go: '<span class="chev">›</span>'
      }, {href: showLink(x), meta: (v.name ? esc(v.name) + ' · ' : '') + soldTxt});
    }
    return table(cols, withSales.map(row).join('') + (unsold.length ? tgroup('Nothing sold yet', pl(unsold.length, 'show') + ' · ' + unsold.reduce(function (t, x) { return t + x.left; }, 0) + ' tickets') + unsold.map(row).join('') : ''), {cls: 'shows'});
  }

  // One show (artist + date): headline numbers, then sections, then each sale.
  function viewShow(key) {
    var x = allShows().filter(function (y) { return y.key === key; })[0];
    if (!x) return pageHead('Show', '', {back: ['#artists', 'Artists']}) + empty('This show could not be found.');
    var v = splitVenue(x.venue), a = x.p, n = daysUntil(x.date), past = n !== null && n < 0, wt = x.date ? whenText(x.date) : '';
    var when = x.date ? x.date.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'}) + (/\d{4}/.test(wt) ? '' : ' · ' + wt) : 'Date unknown';
    var paidEach = a.tickets ? a.cost / a.tickets : (x.bought ? x.spent / Math.max(1, x.bought) : null);
    var sales = x.sales.slice().sort(function (p, q) { return (q.soldAt || 0) - (p.soldAt || 0); });
    return pageHead(x.artist, '<a class="btn ghost" href="' + esc(artistLink(x.artist)) + '">All ' + esc(x.artist) + ' shows</a>', {back: [artistLink(x.artist), x.artist],
        sub: esc(when) + (v.name ? ' · <a class="soft" href="' + esc(venueLink(v.name)) + '">' + esc(v.name) + '</a>' + (v.city ? ', ' + esc(v.city) : '') : '')}) +
      hero('Profit on this show', a.sales ? fmt(a.profit, 'susd') : '—', signClass(a.profit), a.sales ? pl(a.sales, 'sale') + (a.roi === null ? '' : ' · ' + fmt(a.roi, 'spct') + ' return') : 'Nothing sold yet',
        [fact('Tickets sold', x.sold + ' of ' + (x.sold + x.left), bar(x.sold, x.sold + x.left)),
         fact('Sold for', a.tickets ? fmt(a.revenue / a.tickets, 'usd0') : '—', 'average per ticket'),
         fact('Paid', paidEach ? fmt(paidEach, 'usd0') : '—', 'average per ticket'),
         fact(past ? 'Never sold' : 'Still to sell', x.left.toLocaleString(), x.left ? esc(fmt(x.leftCost, 'usd0')) + ' paid' : 'all sold', x.left ? (past ? 'neg' : 'warn') : '')]) +
      card('Sections', '<span class="hint">Prices are per ticket · tap a column to sort</span>', sectionTable(x.sales, x.orders, 'secsort')) +
      card('Sales', '<span class="hint">Newest first</span>', sales.length ? salesTable(sales, {noArtist: true, noVenue: true, noShowDate: true, noGroup: true}) : empty('No sales for this show yet.'));
  }
  function viewArtist(name) {
    var A = S.D.artists[name];
    if (!A) return pageHead(name, '', {back: ['#artists', 'Artists']}) + empty('No data for this artist.');
    var a = aggSales(A.sales), bought = 0, spent = 0;
    A.orders.forEach(function (o) { bought += o.qty; spent += o.total; });
    var h = holding(A.orders), shows = allShows().filter(function (x) { return x.artist === name; });
    var best = A.sales.slice().sort(function (x, y) { return y.profit - x.profit; })[0], worst = A.sales.slice().sort(function (x, y) { return x.profit - y.profit; })[0];
    var tab = S.artistTab || 'shows', body;
    if (tab === 'sales') {
      var ss = A.sales.slice().sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); }), lim = limitFor('asales', 50);
      body = ss.length ? salesTable(ss.slice(0, lim), {noArtist: true}) + moreBtn('asales', lim, ss.length) : empty('No sales logged for this artist yet.');
    } else if (tab === 'inventory') {
      var held = A.orders.filter(function (o) { return o.remaining > 0; }).sort(function (x, y) { return (x.eventDate || 0) - (y.eventDate || 0); });
      var venueOf = {}; allShows().forEach(function (x) { if (x.artist === name && x.venue) venueOf[x.key] = x.venue; });
      var oc = [['seats', 'Seats', 'minmax(220px,1fr)', {p: 1}], ['order', 'Order', 'minmax(160px,.8fr)', {md: 1}], ['left', 'Left', '100px', {n: 1, v: 1}], ['cost', 'Paid for left', '110px', {n: 1, md: 1}]];
      var groups = [], cur = null;
      held.forEach(function (o) { var k = showKey(name, o.eventDate); if (!cur || cur.k !== k) { cur = {k: k, d: o.eventDate, items: []}; groups.push(cur); } cur.items.push(o); });
      body = held.length ? table(oc, groups.map(function (g) {
        var v = splitVenue(venueOf[g.k] || g.items[0].venueFull || ''), left = 0, cost = 0, past = /passed/.test(g.items[0].status);
        g.items.forEach(function (o) { left += o.remaining; cost += o.unsoldCost; });
        var title = dateY(g.d) + ' · ' + (v.name ? v.name + (v.city ? ', ' + v.city : '') : 'Venue not known yet');
        return tgroup(title, esc(whenText(g.d)), '<span class="' + (past ? 'neg' : 'warn') + '">' + left + (past ? ' unsold' : ' left') + '</span> · ' + esc(fmt(cost, 'usd0'))) +
          g.items.map(function (o) {
            var seats = o.seats.replace(/\s*[\r\n]+\s*/g, ' / ');
            return trow(oc, {seats: '<span class="wrap">' + esc(seats) + '</span>', order: two(esc(o.order), 'bought ' + esc(dateY(o.bought)) + (o.site ? ' · ' + esc(o.site) : '')),
              left: '<b class="' + (past ? 'neg' : 'warn') + '">' + o.remaining + ' of ' + o.qty + '</b>', cost: esc(fmt(o.unsoldCost, 'usd0'))}, {meta: 'Order ' + esc(o.order) + ' · ' + esc(fmt(o.unsoldCost, 'usd0')) + ' paid'});
          }).join('');
      }).join('')) : empty('Everything for this artist has sold.');
    } else body = showsTable(shows);
    var tabs = [['shows', 'Shows', shows.length], ['sales', 'Sales', A.sales.length], ['inventory', 'Tickets left', h.tickets]];
    return pageHead(name, '<button class="btn ghost" data-rename="' + esc(name) + '">Rename or merge</button>', {back: ['#artists', 'Artists']}) +
      hero('Profit · all time', fmt(a.profit, 'susd'), signClass(a.profit), pl(a.sales, 'sale') + ' · ' + pl(a.tickets, 'ticket'),
        [fact('Revenue', fmt(a.revenue, 'usd0'), a.tickets ? fmt(a.revenue / a.tickets, 'usd0') + ' per ticket' : ''),
         fact('Return on cost', a.roi === null ? '—' : fmt(a.roi, 'pct'), a.winRate === null ? '' : fmt(a.winRate, 'pct') + ' of sales profitable'),
         fact('Spent', fmt(spent, 'usd0'), pl(bought, 'ticket') + ' bought'),
         fact('Still to sell', h.tickets.toLocaleString(), esc(fmt(h.cost, 'usd0')) + ' paid', 'warn')],
        best ? '<div class="extremes"><span>Best sale ' + money(best.profit) + ' · sec ' + esc(best.section) + ' · ' + esc(dateS(best.soldAt)) + '</span>' + (worst && worst.profit < 0 ? '<span>Worst ' + money(worst.profit) + ' · sec ' + esc(worst.section) + ' · ' + esc(dateS(worst.soldAt)) + '</span>' : '') + '</div>' : '') +
      '<nav class="tabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" aria-selected="' + (tab === t[0]) + '" class="' + (tab === t[0] ? 'on' : '') + '" data-atab="' + t[0] + '">' + t[1] + ' <span>' + t[2].toLocaleString() + '</span></button>'; }).join('') + '</nav>' +
      card('', '', body);
  }

  function viewVenue(name) {
    var V = S.D.venues[name];
    if (!V) return pageHead(name, '', {back: ['#venues', 'Venues']}) + empty('No data for this venue.');
    var a = aggSales(V.sales);
    var arts = groupSales(V.sales, function (s) { return s.artist; }).map(function (r) {
      var d = {}; r.list.forEach(function (s) { if (s.eventDate) d[tt_dayKey(s.eventDate)] = s.eventDate; });
      r.dates = Object.keys(d).sort().map(function (k) { return d[k]; });
      var left = 0; V.orders.forEach(function (o) { if (o.artist === r.key) left += o.remaining; });
      r.left = left; r.avg = r.tickets ? r.revenue / r.tickets : null;
      return r;
    }).sort(function (x, y) { return y.profit - x.profit; });
    var pick = S.sort.vart || 'all';
    if (pick !== 'all' && !arts.some(function (r) { return r.key === pick; })) pick = 'all';
    var sales = V.sales.filter(function (s) { return pick === 'all' || s.artist === pick; }).sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); });
    var orders = V.orders.filter(function (o) { return pick === 'all' || o.artist === pick; }), lim = limitFor('vsales', 50);
    var cols = [['name', 'Artist', 'minmax(200px,1.6fr)', {p: 1}], ['shows', 'Shows', '64px', {n: 1, md: 1}], ['tix', 'Sold', '70px', {n: 1}], ['avg', 'Avg / ticket', '100px', {n: 1, md: 1}], ['left', 'Left', '64px', {n: 1}], ['pl', 'Profit', '130px', {n: 1, v: 1}]];
    var arow = arts.map(function (r) {
      var dates = r.dates.map(dateY);
      return trow(cols, {name: two(esc(r.key), esc(dates.slice(0, 3).join(', ') + (dates.length > 3 ? ' +' + (dates.length - 3) : ''))), shows: String(r.dates.length), tix: r.tickets.toLocaleString(),
        avg: r.avg === null ? '—' : esc(fmt(r.avg, 'usd0')), left: r.left ? '<b class="warn">' + r.left + '</b>' : '<span class="dim">—</span>',
        pl: two(esc(fmt(r.profit, 'susd')), r.roi === null ? '' : esc(fmt(r.roi, 'spct')), signClass(r.profit))},
        {cls: 'click' + (pick === r.key ? ' sel' : ''), attrs: ' role="button" tabindex="0" data-vart="' + esc(pick === r.key ? 'all' : r.key) + '"', meta: pl(r.tickets, 'ticket') + ' · ' + esc(dates.slice(0, 2).join(', '))});
    }).join('');
    var sel = pick === 'all' ? null : pick, sa = aggSales(sales);
    return pageHead(name, '', {back: ['#venues', 'Venues'], sub: esc(V.city)}) +
      hero('Profit here · all time', fmt(a.profit, 'susd'), signClass(a.profit), pl(a.sales, 'sale') + ' · ' + pl(arts.length, 'artist'),
        [fact('Revenue', fmt(a.revenue, 'usd0')), fact('Tickets sold', a.tickets.toLocaleString(), a.tickets ? fmt(a.revenue / a.tickets, 'usd0') + ' per ticket' : ''),
         fact('Return on cost', a.roi === null ? '—' : fmt(a.roi, 'pct')), fact('Still to sell', holding(V.orders).tickets.toLocaleString(), 'upcoming', 'warn')]) +
      card('Artists here', '<span class="hint">Tap an artist to filter below</span>', table(cols, arow)) +
      '<div class="focus"><h2>' + (sel ? esc(sel) + ' at ' + esc(name) : 'All artists at ' + esc(name)) + '</h2><span class="soft">' + pl(sa.sales, 'sale') + ' · ' + money(sa.profit) + '</span>' +
        (sel ? '<button class="btn ghost" data-vart="all">Show all</button><a class="btn ghost" href="' + esc(artistLink(sel)) + '">Artist page ›</a>' : '') + '</div>' +
      card('Sections', '<span class="hint">per ticket</span>', sectionTable(sales, orders, 'vsecsort')) +
      card('Sales', '', sales.length ? salesTable(sales.slice(0, lim), {noVenue: true, noArtist: !!sel}) + moreBtn('vsales', lim, sales.length) : empty('No sales.'));
  }

  // ================= PL Orders v2: header period + tabs =================
  function rangeDays() { var p = normPeriod(); return p.charAt(0) === 'r' ? +p.slice(2) : 0; }
  function rangeStart(n, back) { var t = today0(); t.setDate(t.getDate() - (n - 1) - (back || 0) * n); return t; }
  function periodOptions() {
    var p = normPeriod(), out = [['r:7', 'Last 7 days'], ['r:30', 'Last 30 days']];
    allMonths().slice().reverse().forEach(function (m) { out.push(['m:' + m, monthLong(m)]); });
    dataYears().slice().reverse().forEach(function (y) { out.push(['y:' + y, 'All of ' + y]); });
    out.push(['all', 'All time']);
    if (p.charAt(0) === 'd') out.unshift([p, dayLabel(p.slice(2))]);
    return out.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === p ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function hrsToSell(s) {
    var m = String(s.timeToSell || '').match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60;
    var b = boughtDate(s); return b && s.soldAt ? Math.max(0, (s.soldAt - b) / 36e5) : null;
  }
  function daysToSell(s) { var h = hrsToSell(s); return h === null ? null : h / 24; }
  function stats(list) {
    var a = aggSales(list), d = 0, n = 0;
    list.forEach(function (s) { var x = daysToSell(s); if (x !== null) { d += x; n++; } });
    a.avgDays = n ? d / n : null; a.avgSold = a.tickets ? a.revenue / a.tickets : null;
    return a;
  }
  function groupStats(list, keyFn) {
    var by = {};
    list.forEach(function (s) { var k = keyFn(s); if (k === null || k === undefined || k === '') return; (by[k] = by[k] || []).push(s); });
    return Object.keys(by).map(function (k) { var a = stats(by[k]); a.key = k; a.list = by[k]; return a; });
  }
  function periodSales() { return S.R.sales.filter(function (s) { return inPeriod(s.soldAt); }); }
  function prevSales() { var pv = prevOf(); return pv ? S.R.sales.filter(function (s) { return pv.test(s.soldAt); }) : null; }

  // ---------- small UI pieces ----------
  function kcard(label, value, cls, delta, sub, lead) {
    return '<div class="kc' + (lead ? ' lead' : '') + '"><span>' + esc(label) + '</span><b class="' + (cls || '') + '">' + esc(value) + '</b>' + (delta || '') + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
  }
  function delta(cur, prev, kind, label) {   // kind: 'pct' change in % ; 'pts' change in points
    if (prev === null || prev === undefined || cur === null || cur === undefined) return '';
    var v, txt;
    if (kind === 'pts') { v = (cur - prev) * 100; if (!isFinite(v)) return ''; txt = Math.abs(v).toFixed(1) + ' pts'; }
    else { if (!prev) return ''; v = (cur - prev) / Math.abs(prev) * 100; txt = Math.abs(v).toFixed(0) + '%'; }
    return '<em class="dl ' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '▲ ' : '▼ ') + txt + (label ? ' <i>' + esc(label) + '</i>' : '') + '</em>';
  }
  function pbar(v, top) { return '<span class="pb"><i class="' + (v < 0 ? 'neg' : 'pos') + '" style="width:' + Math.max(3, Math.round(Math.abs(v) / (top || 1) * 100)) + '%"></i></span>'; }
  function badge(result) {
    var r = String(result || '').toUpperCase().replace(/[^A-Z ]/g, '').trim(); if (!r) return '';
    var c = /LOSS/.test(r) ? 'bad' : /BREAK|EHH/.test(r) ? 'meh' : 'good';
    return '<span class="bdg ' + c + '">' + esc(r) + '</span>';
  }
  function inBadge(n) { if (n === null) return ''; return '<span class="bdg ' + (n <= 3 ? 'bad' : n <= 14 ? 'meh' : 'plain') + '">' + n + 'd</span>'; }
  function d1(v) { return v === null || v === undefined ? '—' : v.toFixed(1); }
  function rankList(rows, link, max) {
    return '<ol class="rl">' + rows.slice(0, max || 5).map(function (r, i) {
      return '<li><a href="' + esc(link(r.key)) + '"><span class="rn">' + (i + 1) + '</span><span class="rm"><b>' + esc(r.key) + '</b><small>' + pl(r.sales, 'sale') + ' · ' + r.tickets + ' tix · ROI ' + esc(r.roi === null ? '—' : fmt(r.roi, 'pct')) + '</small></span><span class="rv ' + signClass(r.profit) + '">' + esc(fmt(r.profit, 'usd')) + '</span></a></li>';
    }).join('') + '</ol>';
  }
  function cardH(title, right, body, cls) { return '<section class="card' + (cls ? ' ' + cls : '') + '"><header class="card-h"><h2>' + title + '</h2>' + (right || '') + '</header>' + body + '</section>'; }

  // ---------- profit chart (Daily / Monthly / Yearly) ----------
  try { if (!S.cmode) S.cmode = localStorage.getItem('tt_cmode') || 'month'; } catch (e) { S.cmode = 'month'; }
  if (['day', 'month', 'year'].indexOf(S.cmode) < 0) S.cmode = 'month';
  function chartAnchor() {
    var r = periodRange(), cur = curMonth(), m = r.to > cur || r.to === '9999-99' ? cur : r.to;
    if (S.cmode === 'day') return S.cMonth || m;
    return S.cYear || m.slice(0, 4);
  }
  function chartItems() {
    var out = [], mode = S.cmode, a = chartAnchor();
    if (mode === 'day') {
      var p = a.split('-'), n = new Date(+p[0], +p[1], 0).getDate(), by = dailyStats(), today = tt_dayKey(new Date());
      for (var i = 1; i <= n; i++) {
        var k = a + '-' + (i < 10 ? '0' : '') + i, d = by[k] || {};
        out.push({k: k, go: 'd:' + k, label: (i === 1 || i % 5 === 0) ? String(i) : '', title: dayLabel(k), v: d.profit || 0, sales: d.sales || 0, tickets: d.tickets || 0, on: inPeriod(dayDate(k)), today: k === today});
      }
      return out;
    }
    var bym = {}, r = periodRange(); S.R.monthly.forEach(function (x) { bym[x.month] = x; });
    if (mode === 'month') {
      for (var j = 1; j <= 12; j++) {
        var mk = a + '-' + (j < 10 ? '0' : '') + j, x = bym[mk] || {};
        out.push({k: mk, go: 'm:' + mk, label: monthLabel(mk).split(' ')[0], title: monthLong(mk), v: x.profit || 0, sales: x.sales || 0, tickets: x.tickets || 0, on: rangeDays() ? true : mk >= r.from && mk <= r.to});
      }
      return out;
    }
    dataYears().forEach(function (y) {
      var t = {profit: 0, sales: 0, tickets: 0}; S.R.monthly.forEach(function (x) { if (x.month.slice(0, 4) === y) { t.profit += x.profit || 0; t.sales += x.sales || 0; t.tickets += x.tickets || 0; } });
      out.push({k: y, go: 'y:' + y, label: y, title: y, v: t.profit, sales: t.sales, tickets: t.tickets, on: rangeDays() ? true : y >= r.from.slice(0, 4) && y <= r.to.slice(0, 4)});
    });
    return out;
  }
  function chartCard() {
    var mode = S.cmode, a = chartAnchor(), nav = '';
    if (mode === 'day') {
      var ms = allMonths(), pv = monthKeyOffset(a, -1), nx = monthKeyOffset(a, 1);
      nav = '<div class="cnav"><button data-cnav="' + pv + '"' + (pv < ms[0] ? ' disabled' : '') + '>‹</button><b>' + esc(monthLong(a)) + '</b><button data-cnav="' + nx + '"' + (nx > curMonth() ? ' disabled' : '') + '>›</button></div>';
    } else if (mode === 'month') {
      var ys = dataYears();
      nav = '<div class="cnav"><button data-cnav="' + (+a - 1) + '"' + (String(+a - 1) < ys[0] ? ' disabled' : '') + '>‹</button><b>' + a + '</b><button data-cnav="' + (+a + 1) + '"' + (String(+a + 1) > ys[ys.length - 1] ? ' disabled' : '') + '>›</button></div>';
    }
    var items = chartItems(), best = items.slice().sort(function (x, y) { return y.v - x.v; })[0];
    var hint = best && best.v > 0 ? '<span class="hint">Best ' + (mode === 'day' ? 'day' : mode) + ': ' + esc(best.title) + ' (' + esc(fmt(best.v, 'usd0')) + ')</span>' : '';
    return cardH('Profit by ' + mode, '<div class="cctl">' + nav + '<div class="seg"><button data-cmode="day" class="' + (mode === 'day' ? 'on' : '') + '">Daily</button><button data-cmode="month" class="' + (mode === 'month' ? 'on' : '') + '">Monthly</button><button data-cmode="year" class="' + (mode === 'year' ? 'on' : '') + '">Yearly</button></div></div>',
      '<div class="chart2"></div><div class="cfoot">' + hint + '<span class="hint">Click a bar to open it</span></div>', 'chartcard');
  }
  function drawChart(root) {
    root.querySelectorAll('.chart2').forEach(function (box) {
      var items = chartItems(), W = Math.max(280, Math.round(box.clientWidth)), H = window.innerWidth < 760 ? 200 : 260;
      var vals = items.map(function (x) { return x.v; }), max = Math.max(0, Math.max.apply(null, vals)), min = Math.min(0, Math.min.apply(null, vals));
      if (max === min) max = 1;
      var padL = 58, padR = 6, padT = 10, padB = 24, iw = W - padL - padR, ih = H - padT - padB, bw = iw / items.length;
      var y = function (v) { return padT + (max - v) / (max - min) * ih; };
      var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
      var steps = 4, span = max - min; for (var g = 0; g <= steps; g++) { var t = max - span * g / steps;
        s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="gl"/><text x="' + (padL - 8) + '" y="' + (y(t) + 4) + '" class="tk" text-anchor="end">' + esc(fmt(t, 'usd0')) + '</text>'; }
      s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="ax"/>';
      items.forEach(function (x, i) {
        var bx = padL + i * bw, w = Math.max(3, Math.min(36, bw * 0.64)), cx = bx + (bw - w) / 2, top = y(Math.max(x.v, 0)), h = Math.max(x.v ? 2 : 0, Math.abs(y(x.v) - y(0)));
        if (x.v) s += '<rect x="' + cx + '" y="' + (x.v > 0 ? top : y(0)) + '" width="' + w + '" height="' + h + '" rx="' + Math.min(4, w / 2) + '" class="br ' + (x.v > 0 ? 'up' : 'dn') + (x.on ? '' : ' dim') + '"/>';
        if (x.label) s += '<text x="' + (bx + bw / 2) + '" y="' + (H - 6) + '" class="tk' + (x.today ? ' td' : '') + '" text-anchor="middle">' + esc(x.label) + '</text>';
        s += '<rect x="' + bx + '" y="' + padT + '" width="' + bw + '" height="' + ih + '" class="hit" data-i="' + i + '"/>';
      });
      box.innerHTML = s + '</svg><div class="tip" hidden></div>';
      var tip = box.querySelector('.tip');
      box.querySelectorAll('.hit').forEach(function (r) {
        var x = items[+r.dataset.i];
        r.onmousemove = function (e) {
          tip.innerHTML = '<b>' + esc(x.title) + '</b><span class="' + signClass(x.v) + '">' + esc(fmt(x.v, 'susd')) + '</span><small>' + pl(x.sales, 'sale') + ' · ' + pl(x.tickets, 'ticket') + '</small>';
          tip.hidden = false;
          var b = box.getBoundingClientRect(), left = e.clientX - b.left + 14; if (left > b.width - 170) left = e.clientX - b.left - 170;
          tip.style.left = left + 'px'; tip.style.top = Math.max(0, e.clientY - b.top - 30) + 'px';
        };
        r.onmouseleave = function () { tip.hidden = true; };
        r.onclick = function () { setPeriod(x.go); window.scrollTo(0, 0); };
      });
    });
  }
  if (!window.__ttRs2) { window.__ttRs2 = 1; var rs2; window.addEventListener('resize', function () { clearTimeout(rs2); rs2 = setTimeout(function () { var m = document.getElementById('view'); if (m) drawChart(m); }, 120); }); }

  // ---------- sales log table ----------
  function salesLog(list, opts) {
    opts = opts || {};
    var cols = [['sold', 'Sold', '96px', {s: opts.sortId ? 'sold' : null}], ['ev', 'Event', 'minmax(200px,2fr)', {p: 1}], ['seat', 'Seats', 'minmax(90px,.8fr)'], ['res', 'Result', '118px', {md: 1}],
      ['qty', 'Qty', '40px', {n: 1, s: opts.sortId ? 'qty' : null}], ['each', 'Sold each', '100px', {n: 1, s: opts.sortId ? 'each' : null}], ['pl', 'Profit', '104px', {n: 1, v: 1, s: opts.sortId ? 'profit' : null}],
      ['roi', 'ROI', '70px', {n: 1, md: 1, s: opts.sortId ? 'roi' : null}], ['days', 'Days', '56px', {n: 1, md: 1, s: opts.sortId ? 'days' : null}], ['bought', 'Bought', '96px', {md: 1}]];
    cols.forEach(function (c) { if (c[3] && !c[3].s) delete c[3].s; });
    if (opts.noEvent) cols = cols.filter(function (c) { return c[0] !== 'ev'; });
    if (opts.noEvent) cols[1][3] = {p: 1};
    var body = list.map(function (s) {
      var v = splitVenue(s.venue), dd = daysToSell(s);
      var tip = [s.marketplace ? 'Sold on ' + s.marketplace : '', s.orders && s.orders.length ? 'Order ' + s.orders.join(', ') : ''].filter(Boolean).join(' · ');
      return trow(cols, {
        sold: two(esc(dateS(s.soldAt)), esc(timeS(s.soldAt))),
        ev: '<b><a href="' + esc(artistLink(s.artist)) + '">' + esc(s.artist) + '</a></b><small>' + (v.name ? '<a href="' + esc(venueLink(v.name)) + '">' + esc(v.name) + '</a>' + (v.city ? ' · ' + esc(v.city) : '') + ' · ' : '') + 'show ' + esc(dateY(s.eventDate)) + '</small>',
        seat: '<b>' + esc(s.section) + '</b>' + (s.row ? '<small>Row ' + esc(s.row) + '</small>' : ''),
        res: badge(s.result), qty: String(s.qty),
        each: two(esc(fmt(s.soldPer, 'usd')), 'paid ' + esc(fmt(s.costPer, 'usd'))),
        pl: '<b class="' + signClass(s.profit) + '">' + esc(fmt(s.profit, 'susd')) + '</b>',
        roi: '<span class="' + signClass(s.roi) + '">' + esc(fmt(s.roi, 'pct')) + '</span>',
        days: esc(d1(dd)), bought: '<span class="soft">' + esc(dateY(boughtDate(s))) + '</span>'
      }, {title: tip, meta: (opts.noEvent ? '' : esc(dateS(s.soldAt)) + ' ' + esc(timeS(s.soldAt)) + ' · ') + 'Sec ' + esc(s.section) + (s.row ? ' · Row ' + esc(s.row) : '') + ' · ' + s.qty + ' × ' + esc(fmt(s.soldPer, 'usd0')) + (opts.noEvent || !v.name ? '' : ' · ' + esc(v.name)) + (s.result ? ' ' + badge(s.result) : '')});
    }).join('');
    return table(cols, body, {sortId: opts.sortId, sortDefault: 'sold', cls: 'log'});
  }

  // ================= pages =================
  function stepper() {
    var prev = stepTarget(-1), next = stepTarget(1), m = pmode();
    if (m === 'all' || rangeDays()) return '<h1 class="ptitle">' + esc(periodLabel()) + '</h1>';
    return '<div class="ptitle-row"><button class="stp" ' + (prev ? 'data-go="' + esc(prev) + '"' : 'disabled') + ' aria-label="Previous">‹</button><h1 class="ptitle">' + esc(periodLabel()) + '</h1><button class="stp" ' + (next ? 'data-go="' + esc(next) + '"' : 'disabled') + ' aria-label="Next">›</button></div>';
  }
  function viewOverview() {
    var sales = periodSales(), a = stats(sales), ps = prevSales(), b = ps ? stats(ps) : null, pv = prevOf();
    var vs = pv ? 'vs ' + pv.label : '';
    var held = holding(S.R.orders);
    var arts = groupStats(sales, function (s) { return s.artist; });
    var top = arts.slice().sort(function (x, y) { return y.profit - x.profit; }), bot = arts.filter(function (r) { return r.profit < 0; }).sort(function (x, y) { return x.profit - y.profit; });
    var ven = groupStats(sales, function (s) { return splitVenue(s.venue).name; }).sort(function (x, y) { return y.profit - x.profit; });
    var soon = allShows().filter(function (x) { var n = daysUntil(x.date); return x.left > 0 && n !== null && n >= 0 && n <= 14; }).sort(function (x, y) { return x.date - y.date; });
    var latest = sales.slice().sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); }).slice(0, 8);
    var B = function (f) { return b && b.sales ? f(b) : null; };
    return stepper() +
      '<div class="kcards">' +
        kcard('Total profit', fmt(a.profit, 'susd'), signClass(a.profit), delta(a.profit, B(function (x) { return x.profit; }), 'pct', vs), '', true) +
        kcard('Revenue', fmt(a.revenue, 'usd0'), '', delta(a.revenue, B(function (x) { return x.revenue; }), 'pct')) +
        kcard('Cost', fmt(a.cost, 'usd0'), '', delta(a.cost, B(function (x) { return x.cost; }), 'pct')) +
        kcard('ROI', a.roi === null ? '—' : fmt(a.roi, 'pct'), signClass(a.roi), delta(a.roi, B(function (x) { return x.roi; }), 'pts')) +
        kcard('Sales', a.sales.toLocaleString(), '', delta(a.sales, B(function (x) { return x.sales; }), 'pct')) +
        kcard('Tickets sold', a.tickets.toLocaleString(), '', delta(a.tickets, B(function (x) { return x.tickets; }), 'pct')) +
        kcard('Win rate', a.winRate === null ? '—' : fmt(a.winRate, 'pct'), '', delta(a.winRate, B(function (x) { return x.winRate; }), 'pts')) +
        kcard('Avg profit / sale', a.sales ? fmt(a.profit / a.sales, 'susd') : '—', signClass(a.profit), delta(a.sales ? a.profit / a.sales : null, B(function (x) { return x.profit / x.sales; }), 'pct')) +
        kcard('Avg days to sell', d1(a.avgDays)) +
        kcard('Still to sell', held.tickets.toLocaleString(), 'warn', '', esc(fmt(held.cost, 'usd0')) + ' paid') +
      '</div>' +
      cardH('Latest sales', '<a class="see" href="#sales">See all →</a>', latest.length ? salesLog(latest) : empty('No sales in ' + periodLabel() + '.')) +
      chartCard() +
      '<div class="g2">' +
        cardH('Top 5 artists', '<a class="see" href="#artists">See all →</a>', top.length ? rankList(top, artistLink) : empty('No sales yet.')) +
        cardH('Bottom 5 artists', '<a class="see" href="#artists">See all →</a>', bot.length ? rankList(bot, artistLink) : empty('No artist lost money in this period.')) +
        cardH('Top 5 venues', '<a class="see" href="#venues">See all →</a>', ven.length ? rankList(ven, venueLink) : empty('No venue info for these sales.')) +
        cardH('Sell soon', '<a class="see" href="#inventory">Inventory →</a>', soon.length ? '<ol class="rl">' + soon.slice(0, 5).map(function (x) {
          var v = splitVenue(x.venue);
          return '<li><a href="' + esc(showLink(x)) + '"><span class="rn">' + inBadge(daysUntil(x.date)) + '</span><span class="rm"><b>' + esc(x.artist) + '</b><small>' + esc(dateY(x.date)) + (v.name ? ' · ' + esc(v.name) : '') + '</small></span><span class="rv warn">' + x.left + ' left</span></a></li>';
        }).join('') + '</ol>' : empty('Nothing left to sell in the next 2 weeks.')) +
      '</div>';
  }

  function viewInsights() {
    var sales = periodSales();
    if (!sales.length) return stepper() + cardH('Insights', '', empty('No sales in ' + periodLabel() + '.'));
    var arts = groupStats(sales, function (s) { return s.artist; }), vens = groupStats(sales, function (s) { var v = splitVenue(s.venue); return v.name ? v.name + (v.city ? ' · ' + v.city : '') : ''; });
    var days = groupStats(sales, function (s) { return s.soldAt ? tt_dayKey(s.soldAt) : ''; });
    function pick(list, min, fn, dir) { var l = list.filter(function (r) { return r.sales >= min && fn(r) !== null; }).sort(function (x, y) { return dir * (fn(y) - fn(x)); }); return l[0]; }
    var topP = pick(arts, 1, function (r) { return r.profit; }, 1), roiA = pick(arts, 3, function (r) { return r.roi; }, 1), cons = pick(arts, 5, function (r) { return r.winRate + r.sales / 1e6; }, 1);
    var fast = pick(arts, 3, function (r) { return r.avgDays; }, -1), slow = pick(arts, 3, function (r) { return r.avgDays; }, 1);
    var bestV = pick(vens, 1, function (r) { return r.profit; }, 1), worstV = pick(vens, 1, function (r) { return r.profit; }, -1), loser = pick(arts, 1, function (r) { return r.profit; }, -1);
    var bestD = pick(days, 1, function (r) { return r.profit; }, 1), bestS = sales.slice().sort(function (x, y) { return y.profit - x.profit; })[0];
    function hc(color, label, title, sub, href) { return '<a class="hc ' + color + '"' + (href ? ' href="' + esc(href) + '"' : '') + '><span>' + esc(label) + '</span><b>' + esc(title || '—') + '</b><small>' + (sub || '') + '</small></a>'; }
    var cards = [
      topP && hc('g', 'Top performer', topP.key, esc(fmt(topP.profit, 'usd')) + ' profit · ' + pl(topP.sales, 'sale'), artistLink(topP.key)),
      roiA && hc('p', 'Best ROI artist (3+ sales)', roiA.key, esc(fmt(roiA.roi, 'pct')) + ' ROI · ' + esc(fmt(roiA.profit, 'usd0')), artistLink(roiA.key)),
      cons && hc('b', 'Most consistent (5+ sales)', cons.key, esc(fmt(cons.winRate, 'pct')) + ' win rate · ' + pl(cons.sales, 'sale'), artistLink(cons.key)),
      fast && hc('g', 'Fastest seller (3+ sales)', fast.key, d1(fast.avgDays) + ' days avg to sell', artistLink(fast.key)),
      bestV && hc('g', 'Best venue', bestV.key, esc(fmt(bestV.profit, 'usd')) + ' · ' + pl(bestV.sales, 'sale'), venueLink(bestV.key.split(' · ')[0])),
      bestD && hc('p', 'Best day', dayLabel(bestD.key), esc(fmt(bestD.profit, 'usd')) + ' · ' + pl(bestD.sales, 'sale'), '#'),
      bestS && hc('g', 'Best single sale', bestS.artist, esc(fmt(bestS.profit, 'usd')) + ' · ' + bestS.qty + ' tix · sec ' + esc(bestS.section), artistLink(bestS.artist)),
      slow && hc('o', 'Slowest mover (3+ sales)', slow.key, d1(slow.avgDays) + ' days avg to sell', artistLink(slow.key)),
      loser && loser.profit < 0 && hc('r', 'Biggest loser', loser.key, esc(fmt(loser.profit, 'usd')) + ' · ' + pl(loser.sales, 'sale'), artistLink(loser.key)),
      worstV && worstV.profit < 0 && hc('r', 'Worst venue', worstV.key, esc(fmt(worstV.profit, 'usd')) + ' · ' + pl(worstV.sales, 'sale'), venueLink(worstV.key.split(' · ')[0]))
    ].filter(Boolean).join('');
    if (bestD) cards = cards.replace('href="#"', 'data-go="d:' + bestD.key + '" href="javascript:void 0"');
    var TIERS = ['MASSIVE SALE', 'FANTASTIC SALE', 'GREAT SALE', 'GOOD SALE', 'PROFITABLE', 'EHH SALE', 'BREAK EVEN', 'LOSS'];
    var tiers = groupStats(sales, function (s) { return String(s.result || '').toUpperCase().replace(/[^A-Z ]/g, '').trim(); }).sort(function (x, y) { var i = TIERS.indexOf(x.key), j = TIERS.indexOf(y.key); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var dow = groupStats(sales, function (s) { return s.soldAt ? String(s.soldAt.getDay()) : ''; }).sort(function (x, y) { return +x.key - +y.key; }); dow.forEach(function (r) { r.label = DOW[+r.key]; });
    var BUCK = [['< 1 day', 0, 1], ['1–3 days', 1, 3], ['3–7 days', 3, 7], ['1–2 weeks', 7, 14], ['2–4 weeks', 14, 30], ['1–3 months', 30, 90], ['3+ months', 90, 1e9]];
    var tts = groupStats(sales, function (s) { var d = daysToSell(s); if (d === null) return ''; for (var i = 0; i < BUCK.length; i++) if (d < BUCK[i][2]) return String(i); return ''; }).sort(function (x, y) { return +x.key - +y.key; }); tts.forEach(function (r) { r.label = BUCK[+r.key][0]; });
    function st(rows) {
      var topv = 1; rows.forEach(function (r) { topv = Math.max(topv, Math.abs(r.profit)); });
      var cols = [['name', 'Name', 'minmax(110px,1.2fr)', {p: 1}], ['sales', 'Sales', '54px', {n: 1}], ['tix', 'Tix', '50px', {n: 1, md: 1}], ['pl', 'Profit', 'minmax(150px,1.4fr)', {n: 1, v: 1}], ['roi', 'ROI', '64px', {n: 1}], ['win', 'Win %', '64px', {n: 1, md: 1}], ['days', 'Avg days', '70px', {n: 1, md: 1}]];
      return table(cols, rows.map(function (r) {
        return trow(cols, {name: '<b>' + esc(r.label || r.key) + '</b>', sales: String(r.sales), tix: String(r.tickets), pl: '<span class="pcell">' + pbar(r.profit, topv) + '<b class="' + signClass(r.profit) + '">' + esc(fmt(r.profit, 'usd')) + '</b></span>',
          roi: '<span class="' + signClass(r.roi) + '">' + esc(fmt(r.roi, 'pct')) + '</span>', win: esc(fmt(r.winRate, 'pct')), days: esc(d1(r.avgDays))}, {meta: pl(r.sales, 'sale') + ' · ROI ' + esc(fmt(r.roi, 'pct'))});
      }).join(''));
    }
    return stepper() + '<div class="hcards">' + cards + '</div>' +
      '<div class="g2">' + cardH('By result', '', st(tiers)) + cardH('By time to sell', '', st(tts)) + cardH('By day of week', '', st(dow)) +
        cardH('By weekday sold, best venues', '', st(vens.sort(function (x, y) { return y.profit - x.profit; }).slice(0, 7).map(function (r) { r.label = r.key.split(' · ')[0]; return r; }))).replace('By weekday sold, best venues', 'Top venues') + '</div>';
  }

  function bigTable(kind) {
    var sales = periodSales(), isA = kind === 'artists', id = kind, q = S.search[id];
    var rows = groupStats(sales, isA ? function (s) { return s.artist; } : function (s) { return splitVenue(s.venue).name; });
    var city = {}; if (!isA) sales.forEach(function (s) { var v = splitVenue(s.venue); if (v.name && v.city) city[v.name] = v.city; });
    var leftBy = {}; if (isA) Object.keys(S.D.artists).forEach(function (n) { leftBy[n] = holding(S.D.artists[n].orders).tickets; });
    rows = rows.filter(function (r) { return matches(id, r.key + ' ' + (city[r.key] || '')); });
    sortRows(rows, id, 'profit', {profit: function (x, y) { return y.profit - x.profit; }, sales: function (x, y) { return y.sales - x.sales; }, tix: function (x, y) { return y.tickets - x.tickets; },
      rev: function (x, y) { return y.revenue - x.revenue; }, roi: function (x, y) { return (y.roi || 0) - (x.roi || 0); }, win: function (x, y) { return (y.winRate || 0) - (x.winRate || 0); },
      days: function (x, y) { return (y.avgDays || 0) - (x.avgDays || 0); }, az: function (x, y) { return x.key.localeCompare(y.key); }, left: function (x, y) { return (leftBy[y.key] || 0) - (leftBy[x.key] || 0); }});
    var topv = 1; rows.forEach(function (r) { topv = Math.max(topv, Math.abs(r.profit)); });
    var lim = limitFor(id, 50);
    var cols = [['rk', '#', '30px', {md: 1}], ['name', isA ? 'Name' : 'Venue', 'minmax(170px,2fr)', {p: 1, s: 'az'}]];
    if (!isA) cols.push(['city', 'City', 'minmax(110px,1fr)', {md: 1}]);
    cols.push(['sales', 'Sales', '56px', {n: 1, s: 'sales'}], ['tix', 'Tix', '52px', {n: 1, s: 'tix', md: 1}], ['rev', 'Revenue', '92px', {n: 1, s: 'rev', md: 1}], ['pl', 'Profit', 'minmax(160px,1.4fr)', {n: 1, v: 1, s: 'profit'}],
      ['roi', 'ROI', '68px', {n: 1, s: 'roi'}], ['win', 'Win %', '66px', {n: 1, s: 'win', md: 1}], ['days', 'Avg days', '72px', {n: 1, s: 'days', md: 1}]);
    if (isA) cols.push(['left', 'Left', '56px', {n: 1, s: 'left', md: 1}]);
    var body = rows.slice(0, lim).map(function (r, i) {
      return trow(cols, {rk: '<span class="dim">' + (i + 1) + '</span>', name: '<b>' + esc(r.key) + '</b>', city: '<span class="soft">' + esc(city[r.key] || '') + '</span>', sales: String(r.sales), tix: String(r.tickets), rev: esc(fmt(r.revenue, 'usd0')),
        pl: '<span class="pcell">' + pbar(r.profit, topv) + '<b class="' + signClass(r.profit) + '">' + esc(fmt(r.profit, 'usd')) + '</b></span>', roi: '<span class="' + signClass(r.roi) + '">' + esc(fmt(r.roi, 'pct')) + '</span>',
        win: esc(fmt(r.winRate, 'pct')), days: esc(d1(r.avgDays)), left: leftBy[r.key] ? '<b class="warn">' + leftBy[r.key] + '</b>' : '<span class="dim">—</span>'},
        {href: isA ? artistLink(r.key) : venueLink(r.key), meta: (city[r.key] ? esc(city[r.key]) + ' · ' : '') + pl(r.sales, 'sale') + ' · ROI ' + esc(fmt(r.roi, 'pct'))});
    }).join('');
    return stepper() + cardH((isA ? 'All artists' : 'All venues') + ' <span class="cnt2">' + rows.length + '</span>', searchBox(id, isA ? 'Search artists…' : 'Search venues or cities…'),
      rows.length ? table(cols, body, {sortId: id, sortDefault: 'profit'}) + moreBtn(id, lim, rows.length) : empty(q ? 'Nothing matches “' + q + '”.' : 'No sales in ' + periodLabel() + '.', '<button class="btn" data-go="all">See all time</button>'));
  }
  function viewArtists() { return bigTable('artists'); }
  function viewVenues() { return bigTable('venues'); }

  function viewInventory() {
    var all = allShows(), w = S.sort.inv || 'up';
    var up = all.filter(function (x) { var n = daysUntil(x.date); return x.left > 0 && (n === null || n >= 0); });
    var dead = all.filter(function (x) { var n = daysUntil(x.date); return x.left > 0 && n !== null && n < 0; });
    var sum = function (l, f) { return l.reduce(function (t, x) { return t + x[f]; }, 0); };
    var wk = up.filter(function (x) { var n = daysUntil(x.date); return n !== null && n <= 7; });
    var linked = S.R.sales.filter(function (s) { return (s.orders || []).some(function (n) { return S.orderIndex[n]; }); }).length;
    var rows = (w === 'past' ? dead : up).filter(function (x) { return matches('inv', x.artist + ' ' + x.venue); })
      .sort(function (x, y) { return w === 'past' ? (y.date || 0) - (x.date || 0) : (x.date || 9e15) - (y.date || 9e15); });
    var lim = limitFor('inv', 60);
    var cols = [['ev', 'Event', 'minmax(220px,2fr)', {p: 1}], ['date', 'Date', '104px'], ['in', 'In', '56px', {n: 1}], ['ord', 'Orders', '64px', {n: 1, md: 1}], ['sold', 'Sold', '56px', {n: 1, md: 1}], ['left', 'Tix left', '70px', {n: 1, v: 1}], ['cost', 'Cost tied up', '110px', {n: 1}]];
    var body = rows.slice(0, lim).map(function (x) {
      var v = splitVenue(x.venue), n = daysUntil(x.date);
      return trow(cols, {ev: '<b>' + esc(x.artist) + '</b><small>' + (v.name ? esc(v.name) + (v.city ? ' · ' + esc(v.city) : '') : 'Venue not known yet') + '</small>', date: esc(dateY(x.date)),
        in: n === null ? '' : n < 0 ? '<span class="bdg plain">' + (-n) + 'd ago</span>' : inBadge(n), ord: String(x.orders.length), sold: String(x.sold),
        left: '<b class="' + (n !== null && n < 0 ? 'neg' : 'warn') + '">' + x.left + '</b>', cost: esc(fmt(x.leftCost, 'usd'))},
        {href: showLink(x), meta: esc(dateY(x.date)) + ' · ' + (v.name ? esc(v.name) + ' · ' : '') + esc(fmt(x.leftCost, 'usd0')) + ' tied up'});
    }).join('');
    return '<h1 class="ptitle">Inventory</h1><div class="kcards">' +
      kcard('Unsold tickets (upcoming)', sum(up, 'left').toLocaleString(), 'warn', '', pl(up.length, 'event'), true) +
      kcard('Cost tied up', fmt(sum(up, 'leftCost'), 'usd0')) +
      kcard('Events in next 7 days', String(wk.length), wk.length ? 'neg' : '', '', sum(wk, 'left') + ' tix · ' + esc(fmt(sum(wk, 'leftCost'), 'usd0'))) +
      kcard('Unsold, event passed', sum(dead, 'left').toLocaleString(), 'neg', '', esc(fmt(sum(dead, 'leftCost'), 'usd0')) + ' cost') +
      kcard('Sales linked to orders', linked.toLocaleString() + ' / ' + S.R.sales.length.toLocaleString(), '', '', S.R.orders.length.toLocaleString() + ' order rows') +
      '</div>' +
      cardH(w === 'past' ? 'Unsold · event passed' : 'Unsold inventory · upcoming events', '<div class="cctl">' + seg('inv', [['up', 'Upcoming'], ['past', 'Event passed']], w) + searchBox('inv', 'Search events…') + '</div>',
        rows.length ? table(cols, body) + moreBtn('inv', lim, rows.length) : empty('Nothing here.'));
  }

  function viewSales() {
    var f = S.sort.salesf || 'all', q = S.search.sales;
    var rows = periodSales().filter(function (s) {
      if (f === 'win' && s.profit < 0) return false;
      if (f === 'loss' && s.profit >= 0) return false;
      return matches('sales', [s.artist, s.venue, s.section, 'row ' + s.row, s.result, s.marketplace, (s.orders || []).join(' ')].join(' '));
    });
    sortRows(rows, 'salesl', 'sold', {sold: function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); }, profit: function (x, y) { return y.profit - x.profit; }, roi: function (x, y) { return (y.roi || 0) - (x.roi || 0); },
      qty: function (x, y) { return y.qty - x.qty; }, each: function (x, y) { return y.soldPer - x.soldPer; }, days: function (x, y) { return (daysToSell(y) || 0) - (daysToSell(x) || 0); }});
    var a = aggSales(rows), lim = limitFor('sales', 60);
    S._csv = rows;
    return stepper() + cardH('Sales log <span class="cnt2">' + rows.length + '</span>', '<div class="cctl">' + seg('salesf', [['all', 'All'], ['win', 'Profitable'], ['loss', 'Losses']], f) + searchBox('sales', 'Search event, venue, section…') + '</div>',
      '<div class="sumline"><span>' + pl(a.tickets, 'ticket') + ' · profit ' + money(a.profit) + '</span><button class="link" id="csvBtn">Download CSV</button></div>' +
      (rows.length ? salesLog(rows.slice(0, lim), {sortId: 'salesl'}) + moreBtn('sales', lim, rows.length) : empty(q ? 'Nothing matches “' + q + '”.' : 'No sales match.')));
  }

  function viewImport() {
    var log = (S.importLog || []).slice(-8).reverse().map(function (l) { return '<li><b>' + esc(l.when) + '</b> ' + esc(l.text) + '</li>'; }).join('');
    return '<h1 class="ptitle">Import</h1><p class="lead2">Add either one whenever you like. It saves as soon as you drop or paste, and anything already saved is skipped.</p>' +
      '<div class="g2">' +
      cardH('PL orders CSV', '', '<p class="hint">In the PL Orders sheet: File › Download › Comma-separated values. You can also use the <b>Orders CSV</b> button at the top.</p><label class="drop" id="csvDrop"><input type="file" id="csvFile" accept=".csv,text/csv"><span>Drop the CSV here, or click to choose it</span></label>') +
      cardH('Discord sales', '', '<p class="hint">The Sales Grabber extension does this for you. You can also paste sale messages here.</p><textarea id="discordText" placeholder="Paste sale messages here"></textarea>') +
      '</div>' + cardH('This session', '', log ? '<ul class="log2">' + log + '</ul>' : '<p class="hint">Nothing imported yet.</p>');
  }

  function setPeriod(p) { S.period = p; S.limit = {}; S.cMonth = S.cYear = null; if (S.detail) { location.hash = S.tab === 'artists' || S.tab === 'venues' ? S.tab : 'overview'; return; } render(); }

  // ---------- global search ----------
  function globalResults(q) {
    q = q.toLowerCase().trim(); if (!q) return [];
    var out = [];
    Object.keys(S.D.artists).forEach(function (n) { if (n.toLowerCase().indexOf(q) >= 0) { var A = S.D.artists[n]; out.push({href: artistLink(n), label: n, kind: 'Artist', sub: pl(A.sales.length, 'sale'), score: n.toLowerCase().indexOf(q) === 0 ? 0 : 1}); } });
    Object.keys(S.D.venues).forEach(function (n) { var V = S.D.venues[n]; if ((n + ' ' + V.city).toLowerCase().indexOf(q) >= 0) out.push({href: venueLink(n), label: n, kind: 'Venue', sub: V.city, score: 2}); });
    if (q.length >= 3) S.R.orders.forEach(function (o) { if (o.order.toLowerCase().indexOf(q) >= 0) out.push({href: artistLink(o.artist), label: o.order, kind: 'Order', sub: o.artist + ', ' + fmt(o.eventDate, 'date'), score: 3}); });
    return out.sort(function (a, b) { return a.score - b.score || a.label.localeCompare(b.label); }).slice(0, 8);
  }
  function wireGlobalSearch() {
    var inp = $('#gsearch'), box = $('#gresults'); if (!inp || inp._wired) return; inp._wired = true;
    var sel = 0, res = [];
    function draw() {
      res = globalResults(inp.value);
      box.hidden = !inp.value.trim();
      box.innerHTML = res.length ? res.map(function (r, i) { return '<a href="' + esc(r.href) + '" class="gres' + (i === sel ? ' on' : '') + '"><span class="kind">' + r.kind + '</span><b>' + esc(r.label) + '</b><span class="muted">' + esc(r.sub || '') + '</span></a>'; }).join('') : '<div class="gres none">Nothing matches “' + esc(inp.value) + '”</div>';
    }
    inp.oninput = function () { sel = 0; draw(); };
    inp.onkeydown = function (e) {
      if (e.key === 'ArrowDown') { sel = Math.min(res.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && res[sel]) { location.hash = res[sel].href; inp.value = ''; box.hidden = true; inp.blur(); }
      else if (e.key === 'Escape') { inp.value = ''; box.hidden = true; inp.blur(); }
    };
    box.onmousedown = function (e) { e.preventDefault(); };
    box.onclick = function () { inp.value = ''; box.hidden = true; };
    inp.onblur = function () { setTimeout(function () { box.hidden = true; }, 150); };
    document.addEventListener('keydown', function (e) { if (e.key === '/' && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) < 0) { e.preventDefault(); inp.focus(); } });
  }

  // ---------- routing + render ----------
  var TABS = ['overview', 'insights', 'artists', 'venues', 'inventory', 'sales', 'import'];
  function route() {
    var h = decodeURIComponent(location.hash.replace(/^#/, ''));
    var m = h.match(/^(artist|venue|show)\/(.+)$/);
    if (m) { if (!S.detail || S.detail.name !== m[2]) { S.artistTab = 'shows'; S.sort.vart = 'all'; } S.tab = m[1] === 'show' ? 'artists' : m[1] + 's'; S.detail = {type: m[1], name: m[2]}; }
    else { S.detail = null; S.tab = TABS.indexOf(h) >= 0 ? h : (S.tab || 'overview'); }
    render();
    window.scrollTo(0, 0);
  }
  function downloadCsv(rows) {
    var head = ['Sold on', 'Artist', 'Show date', 'Venue', 'City', 'Section', 'Row', 'Qty', 'Paid per ticket', 'Sold per ticket', 'Total sale', 'Profit', 'ROI', 'Sold on site', 'Time to sell', 'Order #s'];
    var lines = [head].concat(rows.map(function (s) {
      var v = splitVenue(s.venue);
      return [fmt(s.soldAt, 'datetime'), s.artist, fmt(s.eventDate, 'date'), v.name, v.city, s.section, s.row, s.qty, s.costPer, s.soldPer, s.total, s.profit, s.roi, s.marketplace, s.timeToSell, (s.orders || []).join(' ')];
    }));
    var csv = lines.map(function (l) { return l.map(function (v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'})); a.download = 'sales.csv'; a.click();
  }
  function render() {
    if (!S.R) return;
    if (!S.D) derive();
    S._shows = null; S._byOrderNum = null; S._daily = null;
    var held = holding(S.R.orders);
    var counts = {inventory: held.tickets, artists: Object.keys(S.D.artists).filter(function (n) { return S.D.artists[n].sales.length; }).length,
      venues: Object.keys(S.D.venues).filter(function (n) { return S.D.venues[n].sales.length; }).length, sales: S.R.sales.length};
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      var on = b.dataset.tab === S.tab;
      b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      var c = b.querySelector('.cnt'); if (c) c.textContent = counts[b.dataset.tab] ? counts[b.dataset.tab].toLocaleString() : '';
    });
    var hasVenues = counts.venues > 0;
    var vbtn = document.querySelector('[data-tab="venues"]'); if (vbtn) vbtn.hidden = !hasVenues;
    if (!hasVenues && S.tab === 'venues' && !S.detail) { location.hash = 'overview'; return; }
    var main = $('#view'), html;
    if (S.detail) html = S.detail.type === 'artist' ? viewArtist(S.detail.name) : S.detail.type === 'show' ? viewShow(S.detail.name) : viewVenue(S.detail.name);
    else html = ({overview: viewOverview, insights: viewInsights, inventory: viewInventory, artists: viewArtists, venues: viewVenues, sales: viewSales, import: viewImport}[S.tab] || viewOverview)();
    main.innerHTML = html;
    drawChart(main); drawCharts(main);
    var ps = $('#periodSel'); if (ps) { ps.innerHTML = periodOptions(); ps.disabled = !!S.detail; ps.onchange = function () { setPeriod(ps.value); }; }
    var up = $('#updated'); if (up) up.textContent = 'Updated ' + new Date(S.lastRefresh || Date.now()).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
    main.querySelectorAll('[data-cmode]').forEach(function (b) { b.onclick = function () { S.cmode = b.dataset.cmode; S.cMonth = S.cYear = null; try { localStorage.setItem('tt_cmode', S.cmode); } catch (e) {} render(); }; });
    main.querySelectorAll('[data-cnav]').forEach(function (b) { b.onclick = function () { if (S.cmode === 'day') S.cMonth = b.dataset.cnav; else S.cYear = b.dataset.cnav; render(); }; });
    wireGlobalSearch();
    function keep(fn) { return function () { var y = window.scrollY; fn.apply(this, arguments); window.scrollTo(0, y); }; }
    function press(el, fn) { el.onclick = fn; el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } }; }
    main.querySelectorAll('[data-pmode]').forEach(function (b) { b.onclick = function () { setPeriod(modeTarget(b.dataset.pmode)); }; });
    main.querySelectorAll('[data-pgo]').forEach(function (b) { b.onclick = function () { if (b.dataset.pgo) setPeriod(b.dataset.pgo); }; });
    main.querySelectorAll('[data-go]').forEach(function (b) { press(b, function () { setPeriod(b.dataset.go); window.scrollTo(0, 0); }); });
    main.querySelectorAll('[data-sortchip]').forEach(function (b) { b.onclick = keep(function () {
      var k = b.dataset.sortchip;
      if (b.classList.contains('th') && (S.sort[k] || '') === b.dataset.v) S.sort[k + 'Rev'] = !S.sort[k + 'Rev'];   // same column again: flip the order
      else if (b.classList.contains('th') && !S.sort[k] && b.classList.contains('on')) S.sort[k + 'Rev'] = !S.sort[k + 'Rev'];
      else { S.sort[k] = b.dataset.v; S.sort[k + 'Rev'] = false; }
      S.limit = {}; render();
    }); });
    main.querySelectorAll('[data-vart]').forEach(function (b) { press(b, keep(function (e) { if (e && e.target && e.target.closest && e.target.closest('a')) return; S.sort.vart = b.dataset.vart; S.limit = {}; render(); })); });
    main.querySelectorAll('[data-atab]').forEach(function (b) { b.onclick = function () { S.artistTab = b.dataset.atab; render(); }; });
    main.querySelectorAll('[data-more]').forEach(function (b) { b.onclick = keep(function () { S.limit = S.limit || {}; S.limit[b.dataset.more] = +b.dataset.base + 100; render(); }); });
    main.querySelectorAll('[data-showall]').forEach(function (b) { b.onclick = keep(function () { var on = b.dataset.showall === '1'; S.openShow = {}; if (on) allShows().forEach(function (x) { if (S.detail && x.artist === S.detail.name && x.p.sales) S.openShow[x.key] = true; }); render(); }); });
    main.querySelectorAll('[data-show]').forEach(function (b) { press(b, keep(function (e) { if (e && e.target && e.target.closest && e.target.closest('a')) return; S.openShow = S.openShow || {}; S.openShow[b.dataset.show] = !S.openShow[b.dataset.show]; render(); })); });
    main.querySelectorAll('input[data-q]').forEach(function (inp) {
      inp.oninput = function () {
        var id = inp.dataset.q, pos = inp.selectionStart;
        S.search[id] = inp.value; S.limit = {}; render();
        var again = $('input[data-q="' + id + '"]'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      };
    });
    var ss = $('#siteSel'); if (ss) ss.onchange = function () { S.sort.site = ss.value; S.limit = {}; render(); };
    var cb = $('#csvBtn'); if (cb) cb.onclick = function () { downloadCsv(S._csv || []); };
    main.querySelectorAll('[data-rename]').forEach(function (b) {
      b.onclick = async function () {
        var old = b.dataset.rename, nn = window.prompt('Rename "' + old + '" to (type an existing artist name to merge them):', old);
        if (!nn || !nn.trim() || nn.trim() === old) return;
        var rows = S.R.artistMap.filter(function (m) { return m.artist === old; }).map(function (m) { return {raw_name: m.raw, artist: nn.trim()}; });
        if (!rows.length) rows = [{raw_name: tt_norm(old), artist: nn.trim()}];
        try { await S.store.setOverrides(rows); await reload(); location.hash = artistLink(nn.trim()); toast('Renamed to ' + nn.trim()); } catch (e) { toast('Rename failed: ' + (e.message || e), true); }
      };
    });
    if (S.tab === 'import' && !S.detail) {
      $('#csvFile').onchange = function (e) { if (e.target.files[0]) readCsvFile(e.target.files[0]); e.target.value = ''; };
      var drop = $('#csvDrop');
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = function () { drop.classList.remove('over'); };
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readCsvFile(e.dataTransfer.files[0]); };
      var ta = $('#discordText'), t;
      ta.oninput = function () { clearTimeout(t); t = setTimeout(function () { var v = ta.value; if (!v.trim()) return; importSales(v).catch(function (e) { toast('Couldn’t save: ' + (e.message || e), true); }); }, 700); };
    }
    $('#status').textContent = (S.store.demo ? 'Demo · nothing is saved. ' : '') + S.R.orders.length.toLocaleString() + ' orders · ' + S.R.sales.length.toLocaleString() + ' sales';
  }

  // ---------- auth / boot ----------
  function cfg() {
    var c = window.TRACKER_CONFIG || {};
    var url = String(c.supabaseUrl || lsGet('tt_url') || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/i, '').replace(/\/+$/, '');
    return {url: url, key: String(c.supabaseAnonKey || lsGet('tt_key') || '').trim()};
  }
  function showScreen(id) { ['#setup', '#login', '#app'].forEach(function (s) { $(s).hidden = s !== id; }); }

  async function startApp(store) {
    S.store = store;
    showScreen('#app');
    if (store.demo) { $('#signOut').textContent = 'Exit demo'; $('#signOut').onclick = function () { location.href = location.pathname; }; }
    document.querySelectorAll('nav [data-tab]').forEach(function (b) { b.onclick = function () { location.hash = b.dataset.tab; }; });
    window.addEventListener('hashchange', route);
    await reload();
    S.lastRefresh = Date.now(); startAutoRefresh();
    var hc = $('#hdrCsv'); if (hc) hc.onchange = function (e) { if (e.target.files[0]) readCsvFile(e.target.files[0]); e.target.value = ''; };
    var mb = $('#menuBtn'), mp = $('#menuPop');
    if (mb) { mb.onclick = function (e) { e.stopPropagation(); mp.hidden = !mp.hidden; }; document.addEventListener('click', function (e) { if (!mp.hidden && !mp.contains(e.target)) mp.hidden = true; }); mp.addEventListener('click', function (e) { if (e.target.closest('a')) mp.hidden = true; }); }
    if (!location.hash && !S.raw.orders.length && !S.raw.sales.length) location.hash = 'import';
    else route();
  }

  async function boot() {
    $('#demoBtn').onclick = $('#demoBtn2').onclick = function () { startApp(new MemoryStore()); };
    if (/[?&]demo\b/.test(location.search)) return startApp(new MemoryStore());
    var c = cfg();
    if (!c.url || !c.key) {
      showScreen('#setup');
      if (c.url && !$('#sbUrl').value) $('#sbUrl').value = c.url;
      $('#setupForm').onsubmit = async function (e) {
        e.preventDefault();
        var url = $('#sbUrl').value.trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/i, '').replace(/\/+$/, ''), key = $('#sbKey').value.trim();
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) { toast('Project URL should look like https://abcdefgh.supabase.co (copy it from Supabase → Settings → Data API).', true); return; }
        var ok = false, status = 0;
        try { var res = await fetch(url + '/auth/v1/settings', {headers: {apikey: key}}); status = res.status; ok = res.ok; } catch (err) { status = -1; }
        if (status === -1) { toast('Could not reach ' + url + ' — the Project URL is probably mistyped (or Supabase is down). Copy it again from Supabase → Settings → Data API.', true); return; }
        if (!ok) { toast('Supabase rejected that key (error ' + status + '). Use the "anon public" key from the Legacy API keys tab.', true); return; }
        lsSet('tt_url', url); lsSet('tt_key', key);
        boot();
      };
      return;
    }
    if (!window.supabase) { toast('Could not load Supabase. Check your internet connection.', true); return; }
    var client = window.supabase.createClient(c.url, c.key);
    var sess = await client.auth.getSession();
    $('#signOut').onclick = async function () { await client.auth.signOut(); location.reload(); };
    $('#resetConn').onclick = function () { lsSet('tt_url', null); lsSet('tt_key', null); location.reload(); };
    if (sess.data && sess.data.session) return startApp(new SupabaseStore(client));
    showScreen('#login');
    $('#loginForm').onsubmit = async function (e) {
      e.preventDefault();
      var b = $('#loginBtn'); b.disabled = true;
      var r = await client.auth.signInWithPassword({email: $('#email').value.trim(), password: $('#password').value});
      b.disabled = false;
      if (r.error) {
        var msg = r.error.message || String(r.error);
        if (/fetch/i.test(msg)) msg = 'Could not reach your Supabase project (' + c.url + '). Click "Change Supabase connection" and re-enter the Project URL.';
        else if (/invalid login/i.test(msg)) msg = 'Wrong email or password.';
        else if (/not confirmed/i.test(msg)) msg = 'This user is not confirmed yet — confirm it in Supabase → Authentication → Users.';
        toast(msg, true); return;
      }
      startApp(new SupabaseStore(client));
    };
  }

  window.TT_APP = {S: S, MemoryStore: MemoryStore, SupabaseStore: SupabaseStore, csvRowToOrder: csvRowToOrder, saleToDb: saleToDb, saleFromDb: saleFromDb,
    ready: function () { return !!(S.R && S.store); }, reload: function () { return reload(); },
    importSales: function (text) { return importSales(text); },   // used by the Sales Grabber extension
    latestSaleMs: function () { var m = 0; (S.R ? S.R.sales : []).forEach(function (s) { if (s.soldAt && +s.soldAt > m) m = +s.soldAt; }); return m || null; }};
  function wireTheme() {
    var cur = lsGet('tt_theme') === 'light' ? 'light' : 'dark';
    function apply(t) {
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
      document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.classList.toggle('on', b.dataset.themeSet === t); b.setAttribute('aria-pressed', b.dataset.themeSet === t); });
      var tb2 = $('#themeBtn'); if (tb2) { var d = t !== 'light';
        tb2.innerHTML = d ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
        tb2.innerHTML += '<span>' + (d ? 'Light mode' : 'Dark mode') + '</span>';
        tb2.title = d ? 'Switch to light mode' : 'Switch to dark mode'; tb2.setAttribute('aria-label', tb2.title); }
    }
    var tb = $('#themeBtn');
    if (tb) tb.onclick = function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      lsSet('tt_theme', next); apply(next); if (S.R) render();
    };
    document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.onclick = function () { lsSet('tt_theme', b.dataset.themeSet === 'auto' ? null : b.dataset.themeSet); apply(b.dataset.themeSet); if (S.R) render(); }; });
    apply(cur);
  }
  document.addEventListener('DOMContentLoaded', function () { wireTheme(); boot(); });
})();
