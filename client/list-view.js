/*
 * ListView — the shared list component (v2 P0). One vanilla module that renders a searchable,
 * filterable, sortable, paginated list against any endpoint built on the server-side list
 * contract ({ <dataKey>:[], counts, total, page, pageSize, pages, live }). No build step.
 *
 * Usage:
 *   ListView({
 *     mount, endpoint:'/api/accounts', dataKey:'accounts', noun:'customers',
 *     searchPlaceholder:'Search customers…',
 *     filters:[['all','All'],['risk','At risk']],
 *     sortDefaults:{ name:'asc', balance:'desc' }, defaultSort:'name',
 *     columns:[ { label:'Customer', sort:'name', cell:function(a){return html;} }, ... ],
 *     onRow:function(row){ ...navigate... }
 *   });
 */
(function () {
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function num(n) { return (n == null ? 0 : n).toLocaleString('en-US'); }

  function ListView(opts) {
    var mount = opts.mount;
    var dataKey = opts.dataKey;
    var sortDefaults = opts.sortDefaults || {};
    var state = {
      q: '',
      filter: (opts.filters && opts.filters[0] && opts.filters[0][0]) || 'all',
      sort: opts.defaultSort || null,
      order: opts.defaultOrder || (opts.defaultSort ? (sortDefaults[opts.defaultSort] || 'asc') : 'asc'),
      page: 1,
      pageSize: opts.pageSize || 50,
    };
    var data = { rows: [], counts: {}, total: 0, page: 1, pageSize: state.pageSize, pages: 1, live: false };

    mount.innerHTML =
      '<div class="lv-bar">' +
        '<label class="lv-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/></svg>' +
        '<input type="text" placeholder="' + esc(opts.searchPlaceholder || 'Search…') + '" autocomplete="off" /></label>' +
        '<div class="lv-filters"></div>' +
      '</div>' +
      '<div class="card card-clip">' +
        '<table class="lv-table"><thead><tr>' +
          opts.columns.map(function (c) {
            var cls = (c.align === 'right' ? 'right ' : '') + (c.sort ? 'lv-sortable' : '');
            return '<th class="' + cls.trim() + '"' + (c.sort ? ' data-sort="' + esc(c.sort) + '"' : '') + '>' +
              esc(c.label) + (c.sort ? ' <span class="lv-arw" data-arw="' + esc(c.sort) + '"></span>' : '') + '</th>';
          }).join('') +
        '</tr></thead><tbody class="lv-rows"></tbody></table>' +
        '<div class="lv-empty-slot"></div>' +
        '<div class="card-foot lv-foot"><span class="lv-count"></span>' +
          '<span class="lv-page"><button class="btn-pg lv-prev">‹ Prev</button>' +
          '<span class="lv-pageinfo"></span><button class="btn-pg lv-next">Next ›</button></span></div>' +
      '</div>';

    var input = mount.querySelector('.lv-search input');
    var filtersEl = mount.querySelector('.lv-filters');
    var rowsEl = mount.querySelector('.lv-rows');
    var emptyEl = mount.querySelector('.lv-empty-slot');
    var countEl = mount.querySelector('.lv-count');
    var pageinfoEl = mount.querySelector('.lv-pageinfo');
    var prevBtn = mount.querySelector('.lv-prev');
    var nextBtn = mount.querySelector('.lv-next');

    function qs() {
      var p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      p.set('filter', state.filter);
      if (state.sort) { p.set('sort', state.sort); p.set('order', state.order); }
      p.set('page', state.page); p.set('pageSize', state.pageSize);
      return p.toString();
    }
    function load() {
      fetch(opts.endpoint + '?' + qs()).then(function (r) { return r.json(); }).then(function (d) {
        d = d || {};
        data = { rows: d[dataKey] || [], counts: d.counts || {}, total: d.total || 0,
          page: d.page || 1, pageSize: d.pageSize || state.pageSize, pages: d.pages || 1, live: !!d.live };
        render();
      });
    }
    function livePill() {
      return '<span class="lv-sync' + (data.live ? '' : ' demo') + '">' +
        (data.live ? '<span class="dot live"></span>' + esc(opts.liveLabel || 'ServiceTrade · live')
                   : esc(opts.demoLabel || 'demo data')) + '</span>';
    }
    function renderFilters() {
      if (!opts.filters) { filtersEl.innerHTML = livePill(); return; }
      filtersEl.innerHTML = opts.filters.map(function (f) {
        var n = data.counts[f[0]];
        return '<button class="chip' + (state.filter === f[0] ? ' on' : '') + '" data-f="' + esc(f[0]) + '">' +
          esc(f[1]) + (n != null ? ' ' + num(n) : '') + '</button>';
      }).join('') + livePill();
      filtersEl.querySelectorAll('.chip').forEach(function (b) {
        b.onclick = function () { state.filter = b.getAttribute('data-f'); state.page = 1; load(); };
      });
    }
    function arrows() {
      mount.querySelectorAll('[data-arw]').forEach(function (s) {
        var k = s.getAttribute('data-arw');
        s.textContent = state.sort === k ? (state.order === 'asc' ? '▲' : '▼') : '';
      });
    }
    function render() {
      renderFilters(); arrows();
      rowsEl.innerHTML = data.rows.map(function (row) {
        return '<tr>' + opts.columns.map(function (c) {
          return '<td' + (c.align === 'right' ? ' class="right"' : '') + '>' + (c.cell ? c.cell(row) : '') + '</td>';
        }).join('') + '</tr>';
      }).join('');
      emptyEl.innerHTML = data.rows.length ? '' : '<div class="lv-empty">No ' + esc(opts.noun || 'results') + ' match “' + esc(state.q) + '”.</div>';

      var total = data.total, from = total ? ((data.page - 1) * data.pageSize + 1) : 0, to = Math.min(data.page * data.pageSize, total);
      countEl.textContent = total ? ('Showing ' + num(from) + '–' + num(to) + ' of ' + num(total) + (opts.noun ? ' ' + opts.noun : '')) : '';
      pageinfoEl.textContent = 'Page ' + data.page + ' of ' + data.pages;
      prevBtn.disabled = data.page <= 1;
      nextBtn.disabled = data.page >= data.pages;

      if (opts.onRow) {
        var trs = rowsEl.querySelectorAll('tr');
        for (var i = 0; i < trs.length; i++) {
          (function (tr, row) { tr.onclick = function () { opts.onRow(row); }; })(trs[i], data.rows[i]);
        }
      }
    }

    mount.querySelectorAll('th.lv-sortable').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.order = state.order === 'asc' ? 'desc' : 'asc';
        else { state.sort = k; state.order = sortDefaults[k] || 'asc'; }
        state.page = 1; load();
      };
    });
    var t = null;
    input.addEventListener('input', function (e) {
      clearTimeout(t); var v = e.target.value;
      t = setTimeout(function () { state.q = v.trim(); state.page = 1; load(); }, 280);
    });
    prevBtn.onclick = function () { if (state.page > 1) { state.page--; load(); } };
    nextBtn.onclick = function () { if (state.page < data.pages) { state.page++; load(); } };

    load();
    return { reload: load };
  }

  ListView.esc = esc;
  window.ListView = ListView;
})();
