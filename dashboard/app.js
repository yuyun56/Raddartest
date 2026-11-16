// Token Launch Radar — the page. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders three views from it: the ranked board, a detail view per protocol, the live-token
// set aside, and the methodology. No network: every byte it shows is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var view = document.getElementById('view');
  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var cats = {};
  var chainSet = {};
  DATA.rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    r.chains.forEach(function (c) { chainSet[c] = 1; });
  });
  var state = { q: '', cat: '', chain: '', seg: 'all', band: '', sort: 'implied', shown: 60 };
  // A filtered board is a shareable link: ?cat=Lending&seg=watch&q=… opens the board pre-filtered.
  (function () {
    var params = new URLSearchParams(window.location.search);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('cat')) state.cat = params.get('cat');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('seg')) state.seg = params.get('seg');
    if (params.get('band')) state.band = params.get('band');
    if (params.get('sort')) state.sort = params.get('sort');
  })();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    if (v == null) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function pct(v) {
    if (v == null) return '<span class="flat">n/a</span>';
    var cls = v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'flat';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function ageFmt(days) {
    if (days == null) return 'untracked';
    if (days >= 730) return (days / 365.25).toFixed(1) + ' yrs';
    if (days >= 60) return Math.round(days / 30.4) + ' mo';
    return days + ' d';
  }
  function mult(v) { return v.toFixed(2) + '×'; }

  function header(active) {
    var tabs = [['', 'The board'], ['live', 'Live tokens, set aside'], ['method', 'How the model works']];
    var tabHtml = tabs.map(function (t) {
      var href = t[0] === '' ? '#/' : '#/' + t[0];
      return '<a href="' + href + '"' + (active === t[0] ? ' class="on"' : '') + '>' + t[1] + '</a>';
    }).join('');
    return '<header class="top"><div class="top-in"><div class="ring" aria-hidden="true"></div><div>' +
      '<h1>Token Launch Radar <span class="thin">— who has not launched yet, and what it could be worth</span></h1>' +
      '<p class="tagline">Every protocol in the sealed DefiLlama snapshot that records no token, screened for ' +
      'exchanges, bridges and wrapped or staked products, then ranked by an implied launch value derived ' +
      'from the snapshot itself — its TVL, its seven-day growth, its years without a token, and what the ' +
      'market already pays per TVL dollar for its category.</p>' +
      '<div class="chips">' +
      '<span class="chip">snapshot <b>' + esc(DATA.as_of) + '</b></span>' +
      '<span class="chip"><b>' + DATA.board_size + '</b> protocols ranked</span>' +
      '<span class="chip">watchlist <b>' + DATA.watchlist_size + '/' + DATA.watchlist_size + '</b> covered</span>' +
      '<span class="chip"><b>' + DATA.early_size + '</b> early finds below the $50M floor</span>' +
      '<span class="chip">board implies <b>' + money(DATA.board_implied_total) + '</b> in total</span>' +
      '<span class="chip">model <b>' + esc(DATA.model_version) + '</b></span>' +
      '</div></div></div><nav class="tabs">' + tabHtml + '</nav></header>';
  }

  function strip() {
    return '<div class="strip"><b>The model, in one line:</b> implied value = TVL × <b>category peer multiple</b> ' +
      '(the median market-cap/TVL of the same category\u2019s live tokens, shrunk toward the global median of <code>' + mult(DATA.peer_global.multiple) + '</code> when a category\u2019s evidence is thin) ' +
      '× a <b>growth</b> factor from 7-day TVL change × a <b>maturity</b> factor for years tracked with no token × a small ' +
      '<b>reach</b> factor for chains served. Together the board implies <b>' + money(DATA.board_implied_total) + '</b> of launch value; ' +
      'the median row implies <b>' + money(DATA.board_median_implied) + '</b>. Every row shows its own arithmetic in its detail view. ' +
      '<a href="#/method">Full methodology</a></div>';
  }

  function filtered() {
    var rows = DATA.rows.filter(function (r) {
      if (state.seg === 'watch' && !r.watchlist) return false;
      if (state.seg === 'early' && r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.band === 'big' && r.tvl_usd < 1e8) return false;
      if (state.band === 'mid' && (r.tvl_usd < 1e7 || r.tvl_usd >= 1e8)) return false;
      if (state.band === 'small' && r.tvl_usd >= 1e7) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      implied: function (r) { return -r.implied_value_usd; },
      tvl: function (r) { return -r.tvl_usd; },
      growth: function (r) { return -(r.change_7d == null ? -999 : r.change_7d); },
      age: function (r) { return -(r.age_days == null ? -1 : r.age_days); },
      multiple: function (r) { return -r.peer_multiple; }
    }[state.sort];
    rows.sort(function (a, b) { return key(a) - key(b) || a.rank - b.rank; });
    return rows;
  }

  function boardView() {
    var rows = filtered();
    var maxImpl = DATA.rows[0].implied_value_usd;
    var catOpts = '<option value="">All categories</option>' + Object.keys(cats).sort().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="">All chains</option>' + Object.keys(chainSet).sort().map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var sortOpts = [['implied', 'Implied value'], ['tvl', 'TVL'], ['growth', '7-day growth'], ['age', 'Age without token'], ['multiple', 'Peer multiple']].map(function (o) {
      return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    var segBtn = function (id, label) {
      return '<button data-seg="' + id + '"' + (state.seg === id ? ' class="on"' : '') + '>' + label + '</button>';
    };
    var bandOpts = [['', 'Any TVL size'], ['big', 'TVL ≥ $100M'], ['mid', 'TVL $10M–$100M'], ['small', 'TVL under $10M']].map(function (o) {
      return '<option value="' + o[0] + '"' + (state.band === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    var body = rows.slice(0, state.shown).map(function (r) {
      var w = Math.max(2, Math.round((r.implied_value_usd / maxImpl) * 100));
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0" role="link" aria-label="' + esc(r.name) + ' detail">' +
        '<td class="rank' + (r.rank <= 3 ? ' top' : '') + '">' + r.rank + '</td>' +
        '<td class="l name"><span class="nm">' + esc(r.name) + '</span><span class="cat">' + esc(r.category || 'Uncategorised') + '</span>' +
        (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge early">EARLY</span>') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td>' + money(r.tvl_usd) + '</td>' +
        '<td>' + pct(r.change_7d) + '</td>' +
        '<td>' + ageFmt(r.age_days) + '</td>' +
        '<td>' + mult(r.peer_multiple) + '</td>' +
        '<td class="impl">' + money(r.implied_value_usd) + '<div class="bar"><i style="width:' + w + '%"></i></div></td></tr>';
    }).join('');
    view.innerHTML = header('') + '<div class="wrap">' + strip() +
      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search protocols\u2026" value="' + esc(state.q) + '" aria-label="Search protocols">' +
      '<select id="cat" aria-label="Filter by category">' + catOpts + '</select>' +
      '<select id="chain" aria-label="Filter by chain">' + chainOpts + '</select>' +
      '<span class="seg">' + segBtn('all', 'All rows') + segBtn('watch', 'Watchlist') + segBtn('early', 'Early finds') + '</span>' +
      '<select id="band" aria-label="Filter by TVL size">' + bandOpts + '</select>' +
      '<select id="sort" aria-label="Sort the board">' + sortOpts + '</select>' +
      '<span class="count">' + rows.length + ' shown</span></div>' +
      '<table class="board"><thead><tr><th class="l">#</th><th class="l">Protocol</th><th class="l chains">Chains</th>' +
      '<th>TVL</th><th>7d</th><th>Age</th><th>Peer ×</th><th>Implied value</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="8" class="l">No protocol matches that filter.</td></tr>') + '</tbody></table>' +
      (rows.length > state.shown ? '<button class="more" id="more">Show more rows</button>' : '') +
      footer() + '</div>';
    wire();
  }

  function footer() {
    return '<footer>Data: the sealed snapshot at <b>' + esc(DATA.as_of) + '</b> (' + esc(DATA.source) + '). ' +
      '“Records no token” is DefiLlama\u2019s record, not a guarantee a token does not exist. An implied value is this ' +
      'board\u2019s own model output — what a launch could be worth if the record held — not a prediction that a token ' +
      'will be issued. Farm plans are starting points; costs move with network fees.</footer>';
  }

  function wire() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; state.shown = 60; boardView(); var nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.cat = cat.value; state.shown = 60; boardView(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; state.shown = 60; boardView(); });
    var sort = document.getElementById('sort');
    if (sort) sort.addEventListener('change', function () { state.sort = sort.value; boardView(); });
    var band = document.getElementById('band');
    if (band) band.addEventListener('change', function () { state.band = band.value; state.shown = 60; boardView(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-seg]'), function (b) {
      b.addEventListener('click', function () { state.seg = b.getAttribute('data-seg'); state.shown = 60; boardView(); });
    });
    var more = document.getElementById('more');
    if (more) more.addEventListener('click', function () { state.shown += 80; boardView(); });
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-slug]'), function (tr) {
      var go = function () { window.location.hash = '#/p/' + tr.getAttribute('data-slug'); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function detailView(slug) {
    var r = bySlug[slug];
    if (!r) { boardView(); return; }
    var base = r.tvl_usd * r.peer_multiple;
    var after1 = base * r.growth_multiplier;
    var after2 = after1 * r.maturity_multiplier;
    var stat = function (k, v, cls) { return '<div class="stat"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>'; };
    var wrow = function (label, val, op) {
      return '<div class="row"><span>' + label + '</span><span>' + (op ? '<span class="op">' + op + '</span> ' : '') + val + '</span></div>';
    };
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var peers = DATA.peer_stats.filter(function (s) { return s.category === r.category; })[0];
    var peerLine = r.peer_source === 'category' && peers
      ? 'Its multiple starts from the median of ' + peers.peers + ' live ' + esc(r.category || '') + ' peers in the same snapshot (' + mult(r.peer_raw_multiple) + '), then shrinks toward the global median (' + mult(DATA.peer_global.multiple) + ') by a prior of ' + DATA.model.shrink_prior + ' phantom peers, landing at ' + mult(r.peer_multiple) + ' — the market\u2019s own price for a TVL dollar in this category, steadied against thin evidence.'
      : 'Its category has fewer than three live peers with a market cap in the snapshot, so the global median multiple (' + mult(DATA.peer_global.multiple) + ' across ' + DATA.peer_global.peers + ' live protocols) stands in.';
    var boardPeers = DATA.rows.filter(function (x) { return x.category === r.category && x.slug !== r.slug; }).slice(0, 5);
    var livePeers = DATA.live.filter(function (x) { return x.category === r.category; }).slice(0, 5);
    var peerTables = '';
    if (boardPeers.length || livePeers.length) {
      peerTables = '<div class="panel"><h3>Standing in ' + esc(r.category || 'its category') + '</h3>' +
        '<p class="note">' + esc(r.name) + ' ranks <b>#' + r.category_rank + ' of ' + r.category_size + '</b> pre-token ' + esc(r.category || '') + ' rows on this board.</p>';
      if (boardPeers.length) {
        peerTables += '<table class="peers"><thead><tr><th class="l">Pre-token peers on the board</th><th>TVL</th><th>Implied value</th></tr></thead><tbody>' +
          boardPeers.map(function (x) { return '<tr><td class="l"><a href="#/p/' + esc(x.slug) + '">' + esc(x.name) + '</a> <span class="cat">#' + x.rank + '</span></td><td>' + money(x.tvl_usd) + '</td><td>' + money(x.implied_value_usd) + '</td></tr>'; }).join('') + '</tbody></table>';
      }
      if (livePeers.length) {
        peerTables += '<table class="peers"><thead><tr><th class="l">Live peers — the market\u2019s own prices</th><th>Market cap</th><th>MCap / TVL</th></tr></thead><tbody>' +
          livePeers.map(function (x) { return '<tr><td class="l">' + esc(x.name) + '</td><td>' + money(x.mcap_usd) + '</td><td>' + (x.multiple == null ? '—' : mult(x.multiple)) + '</td></tr>'; }).join('') + '</tbody></table>' +
          '<p class="note">Live peers are shown from the board\u2019s set-aside list (the largest by market cap); the multiple itself is learned from every live protocol in the snapshot, not only these.</p>';
      }
      peerTables += '</div>';
    }
    view.innerHTML = header('') + '<div class="wrap">' +
      '<a class="back" href="#/">&larr; Back to the board</a>' +
      '<div class="dhead"><h2>' + esc(r.name) + '</h2><span class="cat">' + esc(r.category || 'Uncategorised') + ' · rank #' + r.rank + ' of ' + DATA.board_size + '</span>' +
      (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge early">EARLY FIND</span>') + '</div>' +
      '<p class="note">' + esc(r.name) + ' records no token in the snapshot. It has been tracked for ' + ageFmt(r.age_days) +
      ' across ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ' (' + esc(r.chains.join(', ')) + ') without one. ' +
      'If it launched at the value its category\u2019s live peers already trade at, the model below prices that launch.</p>' +
      '<div class="stats">' +
      stat('Implied value', money(r.implied_value_usd), 'amber') +
      stat('TVL', money(r.tvl_usd)) +
      stat('7-day TVL change', (r.change_7d == null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%')) +
      stat('Tracked, no token', ageFmt(r.age_days)) +
      stat('Peer multiple', mult(r.peer_multiple)) +
      stat('Implied / TVL', (r.implied_value_usd / r.tvl_usd).toFixed(2) + '×') +
      '</div>' +
      '<div class="panel"><h3>How this value is derived</h3><div class="water">' +
      wrow('TVL (snapshot)', money(r.tvl_usd), '') +
      wrow('Category peer multiple', money(base), '× ' + mult(r.peer_multiple)) +
      wrow('Growth factor — 7-day TVL momentum', money(after1), '× ' + r.growth_multiplier.toFixed(3)) +
      wrow('Maturity factor — time tracked with no token', money(after2), '× ' + r.maturity_multiplier.toFixed(3)) +
      wrow('Reach factor — chains served', money(r.implied_value_usd), '× ' + r.reach_multiplier.toFixed(3)) +
      '<div class="row tot"><span>Implied launch value</span><span>' + money(r.implied_value_usd) + '</span></div>' +
      '</div><p class="note">' + peerLine + '</p></div>' +
      peerTables +
      '<div class="panel"><h3>The farm plan</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="note">Costs are stated at typical network fees and move with congestion; the plan assumes a fresh wallet used only for pre-token farming, so its history stays attributable.</p></div>' +
      footer() + '</div>';
    window.scrollTo(0, 0);
  }

  function liveView() {
    var body = DATA.live.map(function (p, i) {
      return '<tr><td class="rank">' + (i + 1) + '</td>' +
        '<td class="l name"><span class="nm">' + esc(p.name) + '</span><span class="cat">' + esc(p.category || 'Uncategorised') + '</span></td>' +
        '<td class="chains">' + esc(p.chains.slice(0, 3).join(', ')) + '</td>' +
        '<td>' + money(p.tvl_usd) + '</td><td>' + pct(p.change_7d) + '</td>' +
        '<td>' + money(p.mcap_usd) + '</td><td class="impl">' + (p.multiple == null ? '—' : mult(p.multiple)) + '</td></tr>';
    }).join('');
    view.innerHTML = header('live') + '<div class="wrap">' +
      '<div class="strip"><b>Set aside, not ranked.</b> These protocols already have a token that trades, so the board shows the ' +
      'market\u2019s own value for them instead of a model\u2019s. Their market-cap/TVL multiples are also the evidence the model ' +
      'learns each category\u2019s peer multiple from — the largest ' + DATA.live_size + ' by market cap are listed here.</div>' +
      '<table class="board"><thead><tr><th class="l">#</th><th class="l">Protocol</th><th class="l chains">Chains</th><th>TVL</th><th>7d</th><th>Market cap</th><th>MCap / TVL</th></tr></thead><tbody>' + body + '</tbody></table>' +
      footer() + '</div>';
  }

  function methodView() {
    var m = DATA.model;
    var stats = DATA.peer_stats.map(function (s) {
      return '<tr><td class="l">' + esc(s.category) + '</td><td>' + s.peers + '</td><td>' + mult(s.raw_multiple) + '</td><td>' + mult(s.multiple) + '</td></tr>';
    }).join('');
    view.innerHTML = header('method') + '<div class="wrap">' +
      '<div class="panel"><h3>The question</h3><p class="note">A protocol\u2019s launch is the token it may issue one day. This radar asks what that token ' +
      'would be worth if the protocol\u2019s record stayed as it is, and what a reader should do to farm the protocol before it issues one. ' +
      'It does not predict whether or when a token is issued, and an implied value is this board\u2019s own claim, never a promise.</p></div>' +
      '<div class="panel"><h3>The screen</h3><p class="note">From the snapshot\u2019s ' + '758' + ' protocols, a candidate must record no token ' +
      '(no market cap, no CoinGecko id, no symbol) and must not be a wrapped, staked or bridged product of a token that already trades: ' +
      'categories Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX are out, as are versioned names ' +
      '(a trailing V2, 2.0 and the like), names carrying the words wrapped, staked or staking, and names beginning with an exchange\u2019s. ' +
      'All ' + DATA.watchlist_size + ' watchlist protocols are carried; below the $50M floor the same screen admits early candidates, ' +
      'ranked until the board holds ' + DATA.board_size + ' rows. Protocols already trading are never ranked — they are set aside on the Live view.</p></div>' +
      '<div class="panel"><h3>The value model — ' + esc(DATA.model_version) + '</h3><div class="water">' +
      '<div class="row"><span>base</span><span>TVL × peer multiple</span></div>' +
      '<div class="row"><span>peer multiple</span><span>median market-cap/TVL of the category\u2019s live protocols, shrunk toward the global median by a prior of ' + m.shrink_prior + ' phantom peers — (n × category median + ' + m.shrink_prior + ' × global median) / (n + ' + m.shrink_prior + ') — then clamped to [' + m.multiple_floor + ', ' + m.multiple_cap + ']; global median below ' + m.min_peers + ' peers</span></div>' +
      '<div class="row"><span>growth factor</span><span>1 + clamp(7-day change, ' + m.growth_floor + '%, +' + m.growth_cap + '%) × ' + m.growth_weight + '</span></div>' +
      '<div class="row"><span>maturity factor</span><span>' + m.maturity_floor + ' + ' + m.maturity_range + ' × min(age, ' + m.maturity_days + ' days) / ' + m.maturity_days + '; unknown listing day counts ' + m.unknown_age_days + '</span></div>' +
      '<div class="row"><span>reach factor</span><span>1 + ' + m.reach_per_chain + ' × min(chains − 1, ' + m.reach_max_chains + ')</span></div>' +
      '<div class="row tot"><span>implied value</span><span>round(base × growth × maturity × reach)</span></div></div>' +
      '<p class="note">One function scores every row; no protocol name is special-cased. Each detail view repeats the row\u2019s own arithmetic in full.</p></div>' +
      '<div class="panel"><h3>Peer multiples by category</h3><table class="peers"><thead><tr><th class="l">Category</th><th>Live peers</th><th>Raw median</th><th>After shrinkage</th></tr></thead><tbody>' +
      stats + '<tr><td class="l"><b>Global fallback</b></td><td>' + DATA.peer_global.peers + '</td><td>' + mult(DATA.peer_global.raw_multiple) + '</td><td>' + mult(DATA.peer_global.multiple) + '</td></tr>' +
      '</tbody></table></div>' +
      '<div class="panel"><h3>Farm plans</h3><p class="note">Every row carries a seven-step plan written from its category\u2019s playbook and its own figures: ' +
      'where to start (on the cheapest of its chains to farm on, chosen from a stated cost table), what to deposit, trade or hold, the position size its TVL depth supports, ' +
      'one step written from the protocol\u2019s own record — its current momentum, its decline, its years without a token, or its spread across chains — ' +
      'the weekly rhythm that makes usage attributable, what each action costs at typical fees, and how long the plan runs. A plan without costs and time would be a slogan; these carry both.</p></div>' +
      footer() + '</div>';
  }

  function route() {
    var hash = window.location.hash.replace(/^#\/?/, '');
    view.setAttribute('aria-busy', 'true');
    if (hash.indexOf('p/') === 0) detailView(decodeURIComponent(hash.slice(2)));
    else if (hash === 'live') liveView();
    else if (hash === 'method') methodView();
    else boardView();
    view.setAttribute('aria-busy', 'false');
  }
  window.addEventListener('hashchange', route);
  route();
})();
