/*
 * 1st FP OS — shared client runtime. One place for: the OS context (identity, office, period),
 * the canonical metric/trend/drill-down data contracts, formatting, reusable render helpers, the
 * freshness strip, and the drill-down drawer. Pages include /os.css + /os.js and compose from these
 * instead of reinventing office state, KPI cards, tables, or drill behavior. No framework.
 *
 * Backend authorization is always authoritative; this is convenience + consistency only.
 */
(function (w) {
  'use strict';
  var OS = w.OS = w.OS || {};
  var ctx = { me: null, ready: false };
  var changeCbs = [];

  OS.PERIODS = [['today','Today'],['week','Week'],['month','Month'],['last_month','Last month'],['quarter','Quarter'],['year','Year']];

  /* ---------- context / state ---------- */
  function readLS(k, d){ try { return localStorage.getItem(k) || d; } catch(_){ return d; } }
  OS.office = function(){ return readLS('fpos_office','all') || 'all'; };
  OS.period = function(){ return readLS('fpos_period','month') || 'month'; };
  OS.setPeriod = function(p){ try{ localStorage.setItem('fpos_period', p); }catch(_){} fire(); try{ w.parent.postMessage({type:'fp-period',period:p},'*'); }catch(_){} };
  OS.me = function(){ return ctx.me; };
  function fire(){ changeCbs.forEach(function(cb){ try{ cb(); }catch(_){} }); }
  OS.onChange = function(cb){ changeCbs.push(cb); };

  // office/period changes broadcast from the shell
  w.addEventListener('message', function(e){
    var d = e.data || {};
    if (d.type === 'fp-office' || d.type === 'fp-period') { fire(); }
  });

  OS.ready = function(cb){
    if (ctx.ready) { cb(ctx.me); return; }
    fetch('/api/me').then(function(r){ return r.json(); }).then(function(m){
      ctx.me = m; ctx.ready = true; cb(m);
    }).catch(function(){ ctx.me = null; ctx.ready = true; cb(null); });
  };
  OS.officeLabel = function(){ var o = OS.office(); if (o==='all') return 'All offices';
    var m = ctx.me && (ctx.me.offices||[]).filter(function(x){return x.key===o;})[0]; return m ? m.label : o; };
  OS.periodLabel = function(){ var p = OS.period(); var f = OS.PERIODS.filter(function(x){return x[0]===p;})[0]; return f ? f[1] : p; };

  /* ---------- data contracts ---------- */
  function qs(extra){
    var p = new URLSearchParams(); p.set('office', OS.office()); p.set('period', OS.period());
    if (extra) Object.keys(extra).forEach(function(k){ if (extra[k]!=null) p.set(k, extra[k]); });
    return p.toString();
  }
  OS.metric = function(key, opts){ opts = opts||{}; return fetch('/api/metrics/'+encodeURIComponent(key)+'?'+qs({compare:opts.compare?1:null}))
    .then(function(r){return r.json();}).then(function(d){return d.ok?d.metric:null;}).catch(function(){return null;}); };
  OS.metrics = function(keys, opts){ return Promise.all(keys.map(function(k){return OS.metric(k,opts);})); };
  OS.trend = function(key){ return fetch('/api/metrics/'+encodeURIComponent(key)+'/trend?'+qs())
    .then(function(r){return r.json();}).catch(function(){return {supported:false,points:[]};}); };
  OS.drill = function(key, opts){ opts=opts||{}; return fetch('/api/drilldown/'+encodeURIComponent(key)+'?'+qs({limit:opts.limit,offset:opts.offset}))
    .then(function(r){return r.json();}).catch(function(){return {ok:false};}); };
  OS.sources = function(){ return fetch('/api/sources').then(function(r){return r.json();}).catch(function(){return {sources:[]};}); };

  /* ---------- formatting ---------- */
  OS.esc = function(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  OS.money = function(n){ n=Number(n)||0; var s=n<0?'-':''; n=Math.abs(n); return s+'$'+(n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':Math.round(n)); };
  OS.num = function(n){ return (Number(n)||0).toLocaleString('en-US'); };
  OS.fmt = function(v, unit){ return unit==='usd'||unit==='money'?OS.money(v):unit==='percent'?(v+'%'):OS.num(v); };
  OS.date = function(iso){ if(!iso) return ''; var d=new Date(iso); if(isNaN(d)) return String(iso).slice(0,10);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}); };
  OS.ago = function(iso){ if(!iso) return ''; var s=(Date.now()-new Date(iso).getTime())/1000;
    if(s<90) return 'just now'; var m=s/60; if(m<90) return Math.round(m)+'m ago'; var h=m/60; if(h<36) return Math.round(h)+'h ago'; return Math.round(h/24)+'d ago'; };

  /* ---------- render helpers (return HTML strings) ---------- */
  OS.pill = function(text, tone){ return '<span class="os-pill '+(tone||'neutral')+'">'+OS.esc(text)+'</span>'; };
  OS.ownerTag = function(owner){ return '<span class="os-tag owner-'+OS.esc(owner)+'">'+OS.esc(owner)+'</span>'; };
  OS.officeTag = function(label){ return label?'<span class="os-tag office">'+OS.esc(label)+'</span>':''; };

  // KPI card from the canonical metric-card contract
  OS.kpi = function(card, opts){ opts=opts||{};
    if(!card) return '<div class="os-kpi"><div class="lab">—</div><div class="val">—</div></div>';
    var cmp='';
    if(card.comparison){ var c=card.comparison; var arrow=c.changeAbs>0?'▲':c.changeAbs<0?'▼':'—';
      var chgTxt=(c.changePct!=null?(Math.abs(c.changePct)+'%'):OS.fmt(Math.abs(c.changeAbs),card.format));
      cmp='<span class="chg '+c.tone+'">'+arrow+' '+chgTxt+' <span class="src">vs '+OS.esc(c.periodLabel)+'</span></span>'; }
    var src = card.companyWide?'<span class="src cw">Company-wide</span>':'<span class="src">'+OS.esc(card.source||'')+'</span>';
    var est = card.projected?'<span class="est">Projected</span>':'';
    var click = (opts.drill!==false && card.drillable) ? ' click' : (opts.onClick?' click':'');
    var attr = card.drillable&&opts.drill!==false ? ' data-drill="'+OS.esc(card.key)+'" data-drill-label="'+OS.esc(card.label)+'"' : (opts.tab?' data-tab="'+OS.esc(opts.tab)+'"':'');
    return '<div class="os-kpi'+click+'"'+attr+'><div class="lab">'+OS.esc(card.label)+'</div>'+
      '<div class="val">'+OS.fmt(card.value, card.format)+'</div>'+
      '<div class="meta">'+cmp+(cmp?'':src)+est+'</div></div>';
  };
  OS.kpiRow = function(cards, opts){ return '<div class="os-kpis">'+cards.map(function(c){return OS.kpi(c,opts);}).join('')+'</div>'; };

  OS.attn = function(a){ // {title, why, tone|severity, amount?, amountProjected?, count?, meta?, tab?, office?}
    var tone = a.tone||a.severity||'neutral';
    var meta = a.amount!=null ? (a.amountProjected?'~':'')+OS.money(a.amount)+(a.amountProjected?' projected':'')
      : (a.count!=null? OS.num(a.count)+' '+(a.unitLabel||'item'+(a.count===1?'':'s')):'');
    var tags = (a.ownerTag?OS.ownerTag(a.ownerTag):'')+(a.officeLabel?OS.officeTag(a.officeLabel):'');
    var btn = a.tab?'<button class="go" data-tab="'+OS.esc(a.tab)+'"'+(a.office?' data-office="'+OS.esc(a.office)+'"':'')+'>'+(a.action||'View')+'</button>':'';
    return '<div class="os-acard '+tone+'"><div class="t">'+OS.esc(a.title)+'</div>'+
      (a.why?'<div class="why">'+OS.esc(a.why)+'</div>':'')+
      '<div class="row"><span class="meta">'+meta+' '+tags+'</span>'+btn+'</div></div>';
  };
  OS.attnGrid = function(items, emptyMsg){ if(!items||!items.length) return '<div class="os-empty">'+OS.esc(emptyMsg||'Nothing needs attention right now.')+'</div>';
    return '<div class="os-attn">'+items.map(OS.attn).join('')+'</div>'; };

  // Table from a column spec + rows
  OS.table = function(columns, rows, opts){ opts=opts||{};
    if(!rows||!rows.length) return '<div class="os-empty">'+OS.esc(opts.empty||'No records.')+'</div>';
    var head = columns.map(function(c){return '<th'+(c.kind==='money'||c.kind==='num'?' class="num"':'')+'>'+OS.esc(c.label)+'</th>';}).join('');
    var body = rows.map(function(r,i){
      var cells = columns.map(function(c){
        var v = r[c.as!=null?c.as:c.key];
        var cls = (c.kind==='money'||c.kind==='num')?' class="num"':(c.strong?' class="strong"':'');
        var disp = c.kind==='money'?OS.money(v):c.kind==='date'?OS.date(v):c.render?c.render(v,r):OS.esc(v==null?'':v);
        return '<td'+cls+'>'+disp+'</td>';
      }).join('');
      return '<tr'+(opts.onRow?' class="click" data-row="'+i+'"':'')+'>'+cells+'</tr>';
    }).join('');
    return '<div class="os-tablewrap"><div class="os-tablescroll"><table class="os-table"><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div></div>';
  };

  // Horizontal comparison bars from [{label, value}] (for office/category comparisons).
  OS.bars = function(rows, opts){ opts=opts||{};
    if(!rows||!rows.length) return OS.empty(opts.empty||'No data.');
    var max=Math.max.apply(null,rows.map(function(r){return r.value;}))||1;
    var fmt=opts.money?OS.money:OS.num;
    return '<div>'+rows.map(function(r){
      return '<div style="display:grid;grid-template-columns:130px 1fr auto;gap:10px;align-items:center;margin:7px 0"'+(r.office?' class="click" data-tab="'+OS.esc(opts.tab||'')+'" data-office="'+OS.esc(r.office)+'"':'')+'>'+
        '<span style="font-weight:650;font-size:12.5px;color:var(--ink-2);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+OS.esc(r.label)+'</span>'+
        '<span style="height:14px;background:var(--fill);border-radius:7px;overflow:hidden"><span style="display:block;height:100%;border-radius:7px;background:var(--os-accent);width:'+Math.round((r.value/max)*100)+'%"></span></span>'+
        '<span style="font-weight:700;font-size:12.5px;color:var(--ink);font-variant-numeric:tabular-nums">'+fmt(r.value)+'</span></div>';
    }).join('')+'</div>';
  };
  // Minimal SVG line chart from [{bucket, value}]. theme-aware via currentColor.
  OS.lineChart = function(points, opts){ opts=opts||{};
    if(!points||points.length<2) return OS.empty(opts.empty||'Not enough history yet to draw a trend.');
    var W=640,H=180,pad=28,padB=26;
    var vals=points.map(function(p){return p.value;}); var max=Math.max.apply(null,vals)||1, min=Math.min.apply(null,vals,0);
    var x=function(i){return pad+(i/(points.length-1))*(W-pad-8);};
    var y=function(v){return pad-4+(1-(v-min)/((max-min)||1))*(H-pad-padB);};
    var pts=points.map(function(p,i){return x(i)+','+y(p.value);}).join(' ');
    var area='M'+x(0)+','+(H-padB)+' L'+points.map(function(p,i){return x(i)+','+y(p.value);}).join(' L')+' L'+x(points.length-1)+','+(H-padB)+' Z';
    var last=points[points.length-1];
    var labels=points.map(function(p,i){ if(points.length>8 && i%2) return ''; return '<text x="'+x(i)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="var(--muted)">'+OS.esc(p.bucket.slice(2))+'</text>'; }).join('');
    return '<div class="os-tablewrap" style="padding:12px 14px"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+OS.esc(opts.label||'trend')+'" style="width:100%;height:auto;color:var(--os-accent)">'+
      '<path d="'+area+'" fill="currentColor" opacity="0.08"/>'+
      '<polyline points="'+pts+'" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>'+
      '<circle cx="'+x(points.length-1)+'" cy="'+y(last.value)+'" r="3.6" fill="currentColor"/>'+
      '<text x="'+x(points.length-1)+'" y="'+(y(last.value)-9)+'" font-size="11" font-weight="700" text-anchor="end" fill="var(--ink)">'+OS.esc(opts.money?OS.money(last.value):OS.num(last.value))+'</text>'+
      labels+'</svg></div>';
  };
  OS.empty = function(msg, icon){ return '<div class="os-empty">'+(icon?'<div class="ico">'+icon+'</div>':'')+OS.esc(msg||'Nothing here.')+'</div>'; };
  OS.skeletonKpis = function(n){ var s=''; for(var i=0;i<(n||4);i++) s+='<div class="os-skel os-skel-kpi"></div>'; return '<div class="os-kpis">'+s+'</div>'; };
  OS.errorBox = function(msg, onRetry){ return '<div class="os-err"><span>'+OS.esc(msg||'Could not load.')+'</span>'+(onRetry?'<button data-retry="1">Retry</button>':'')+'</div>'; };

  /* ---------- freshness strip ---------- */
  OS.freshness = function(el){ if(!el) return; OS.sources().then(function(d){
    el.className='os-sources';
    el.innerHTML=(d.sources||[]).map(function(s){
      var when = s.status==='fresh'&&s.lastSyncedAt?OS.ago(s.lastSyncedAt)
        : s.status==='stale'?'stale'+(s.lastSyncedAt?' · '+OS.ago(s.lastSyncedAt):'')
        : s.status==='no_sync'?'no sync':'not connected';
      return '<span class="os-src '+s.status+'" title="'+OS.esc(s.detail||'')+'"><span class="d '+s.status+'"></span>'+OS.esc(s.label)+' · '+OS.esc(when)+'</span>';
    }).join('');
  }); };

  /* ---------- navigation ---------- */
  OS.go = function(tab, opts){ opts=opts||{}; try{
    if(opts.office){ w.parent.postMessage({type:'set-office',office:opts.office},'*'); }
    w.parent.postMessage({type:'app-navigate',tab:tab,param:opts.param},'*');
  }catch(_){} };

  /* ---------- drill-down drawer ---------- */
  var drawerState = null;
  OS.openDrill = function(key, label){
    if(drawerState) OS.closeDrill();
    var scrim=document.createElement('div'); scrim.className='os-scrim';
    scrim.innerHTML='<div class="os-drawer" role="dialog" aria-label="Records"><div class="dh"><div><h2>'+OS.esc(label||key)+'</h2>'+
      '<div class="sub">'+OS.esc(OS.officeLabel())+' · '+OS.esc(OS.periodLabel())+'</div></div>'+
      '<button class="x" aria-label="Close">✕</button></div>'+
      '<div class="db" id="os-drill-body">'+OS.skeletonRows()+'</div>'+
      '<div class="df"><span id="os-drill-count">Loading…</span><span><button id="os-drill-prev" disabled>Prev</button> <button id="os-drill-next" disabled>Next</button></span></div></div>';
    document.body.appendChild(scrim);
    drawerState={key:key, label:label, offset:0, limit:50, el:scrim};
    requestAnimationFrame(function(){ scrim.classList.add('on'); });
    scrim.addEventListener('click',function(e){ if(e.target===scrim||e.target.closest('.x')) OS.closeDrill(); });
    scrim.querySelector('#os-drill-prev').addEventListener('click',function(){ if(drawerState.offset>0){drawerState.offset-=drawerState.limit; loadDrill();} });
    scrim.querySelector('#os-drill-next').addEventListener('click',function(){ if(drawerState.offset+drawerState.limit<drawerState.total){drawerState.offset+=drawerState.limit; loadDrill();} });
    scrim.addEventListener('keydown',function(e){ if(e.key==='Escape') OS.closeDrill(); });
    loadDrill();
  };
  OS.closeDrill = function(){ if(!drawerState) return; var el=drawerState.el; el.classList.remove('on'); setTimeout(function(){ el.remove(); },200); drawerState=null; };
  function loadDrill(){
    var s=drawerState; if(!s) return;
    OS.drill(s.key,{limit:s.limit,offset:s.offset}).then(function(d){
      if(!drawerState) return;
      var body=document.getElementById('os-drill-body'), count=document.getElementById('os-drill-count');
      if(!d||!d.ok){ if(body) body.innerHTML='<div style="padding:24px">'+OS.errorBox('You may not have access to these records, or none exist.')+'</div>'; if(count) count.textContent=''; return; }
      s.total=d.total;
      if(body) body.innerHTML=OS.table(d.columns, d.rows, {empty:'No records behind this number.'});
      if(count) count.textContent=d.total+' record'+(d.total===1?'':'s')+(d.total>d.limit?(' · showing '+(d.offset+1)+'–'+Math.min(d.offset+d.limit,d.total)):'');
      var prev=document.getElementById('os-drill-prev'), next=document.getElementById('os-drill-next');
      if(prev) prev.disabled = s.offset<=0;
      if(next) next.disabled = s.offset+s.limit>=d.total;
    });
  }
  OS.skeletonRows = function(){ var r=''; for(var i=0;i<8;i++) r+='<div class="os-skel" style="height:16px;margin:14px 20px"></div>'; return r; };

  /* ---------- global delegation: KPI drill clicks + attention/nav buttons ---------- */
  document.addEventListener('click', function(e){
    var drill=e.target.closest('[data-drill]');
    if(drill){ OS.openDrill(drill.getAttribute('data-drill'), drill.getAttribute('data-drill-label')); return; }
    var nav=e.target.closest('[data-tab]');
    if(nav && nav.getAttribute('data-tab')){ OS.go(nav.getAttribute('data-tab'), {office:nav.getAttribute('data-office')||null}); return; }
  });

  /* ---------- period control (renders a period button row into an element) ---------- */
  OS.periodControl = function(el){ if(!el) return;
    function paint(){ el.innerHTML=OS.PERIODS.map(function(p){ return '<button class="os-fb'+(p[0]===OS.period()?' on':'')+'" data-period="'+p[0]+'">'+p[1]+'</button>'; }).join(''); }
    el.addEventListener('click',function(e){ var b=e.target.closest('[data-period]'); if(b){ OS.setPeriod(b.getAttribute('data-period')); paint(); } });
    OS.onChange(paint); paint();
  };
})(window);
