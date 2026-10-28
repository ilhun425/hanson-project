/* 핸썬 프로젝트 관리 — 화면 (데이터는 Apps Script 웹 앱을 거쳐 구글 스프레드시트에 저장) */
(() => {
  'use strict';
  const CFG = window.HP_CONFIG || {};
  // 내 PC(localhost)에서 API 주소 없이 열면 Apps Script 코드를 브라우저 안에서 그대로 돌려 시험함
  const MOCK = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !CFG.API_URL;
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const fmt = (n) => (n == null || n === '' ? '–' : Number(n).toLocaleString('ko-KR'));
  const won = (n) => (n ? fmt(n) + '원' : '–');
  const toNum = (v) => { if (typeof v === 'number') return isFinite(v) ? v : null; const s = String(v == null ? '' : v).replace(/[,\s원]/g, ''); return s !== '' && !isNaN(+s) ? +s : null; };
  const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const pct = (r) => (r == null ? '–' : (r >= 1 && r < 1.0005 ? 100 : r >= 1 ? Math.round(r * 100) : Math.floor(r * 100)) + '%');

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(text, cls, onclick) { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; if (onclick) b.onclick = onclick; return b; }

  const TKEY = 'hp-token';
  const store = { get() { try { return localStorage.getItem(TKEY); } catch { return null; } }, set(v) { try { localStorage.setItem(TKEY, v); } catch {} }, del() { try { localStorage.removeItem(TKEY); } catch {} } };
  const state = { token: store.get(), statuses: [], list: null, filter: null, q: '', sort: 'recent', detail: null, open: new Set() };

  /* ---------- 서버 ---------- */
  async function api(action, data) {
    const body = JSON.stringify(Object.assign({ action, token: state.token }, data || {}));
    let j;
    try {
      if (MOCK) { await new Promise((r) => setTimeout(r, 200)); j = JSON.parse(window.__gasPost(body)); }
      else {
        if (!CFG.API_URL) throw new Error('no url');
        const r = await fetch(CFG.API_URL, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        j = await r.json();
      }
    } catch (e) {
      throw Object.assign(new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'), { code: 'network' });
    }
    if (!j.ok) {
      if (j.error === 'auth') lock(j.message);
      throw Object.assign(new Error(j.message || '문제가 생겼습니다.'), { code: j.error });
    }
    if (j.statuses) state.statuses = j.statuses;
    return j;
  }
  function lock(msg) { store.del(); state.token = null; state.list = null; state.detail = null; renderLogin(msg); }

  // 버튼을 잠시 막고 서버 일을 한 뒤, 실패하면 알림
  async function run(button, fn) {
    if (button) button.disabled = true;
    try { return await fn(); }
    catch (e) { if (e.code !== 'auth') toast(e.message); return undefined; }
    finally { if (button && button.isConnected) button.disabled = false; }
  }

  let tt = null;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; }, 3200); }

  /* ---------- 계산 (수량 기준) ---------- */
  function calc(d) {
    const sum = (rows) => rows.reduce((m, r) => m.set(r.hwId, (m.get(r.hwId) || 0) + r.qty), new Map());
    const by = (rows) => rows.reduce((m, r) => { (m.get(r.hwId) || m.set(r.hwId, []).get(r.hwId)).push(r); return m; }, new Map());
    const O = sum(d.orders), D = sum(d.deliveries), OL = by(d.orders), DL = by(d.deliveries);
    let qty = 0, ord = 0, dlv = 0;
    const items = d.items.map((it) => {
      const o = O.get(it.id) || 0, v = D.get(it.id) || 0;
      qty += it.qty; ord += Math.min(it.qty, o); dlv += Math.min(it.qty, v);
      return { it, ordered: o, delivered: v, orderLeft: it.qty - o, deliveryLeft: it.qty - v,
        orderRate: it.qty ? o / it.qty : null, deliveryRate: it.qty ? v / it.qty : null,
        orderList: (OL.get(it.id) || []).sort(byDate), deliveryList: (DL.get(it.id) || []).sort(byDate) };
    });
    return { items, qty, ordered: ord, delivered: dlv, orderRate: qty ? ord / qty : null, deliveryRate: qty ? dlv / qty : null };
  }
  const byDate = (a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date));

  function meter(rate, sub) {
    const m = el('div', 'meter' + (rate != null && rate > 1 ? ' over' : rate != null && rate >= 1 ? ' done' : ''));
    m.append(el('span', 'pct', pct(rate)));
    const tr = el('div', 'track'), f = el('div', 'fill'); f.style.width = Math.min(100, (rate || 0) * 100) + '%'; tr.append(f); m.append(tr);
    if (sub) m.append(sub);
    return m;
  }
  function statusPill(s) { const i = state.statuses.indexOf(s); return el('span', 'pill' + (i >= 0 ? ' s' + (i % 6) : ''), s || '–'); }

  /* ---------- 화면 전환 ---------- */
  function route() {
    $('dlg').open && $('dlg').close();
    if (!state.token) return renderLogin();
    $('logout').hidden = false;
    const h = location.hash.replace(/^#\/?/, '');
    let m;
    if ((m = /^p\/(\w+)$/.exec(h))) return viewDetail(m[1]);
    if (h === 'new') return viewEdit(null);
    if ((m = /^edit\/(\w+)$/.exec(h))) return viewEdit(m[1]);
    return viewList();
  }
  addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
  $('logout').onclick = () => { if (confirm('이 기기에서 잠글까요? 다시 열 때 공동 비밀번호가 필요합니다.')) lock('잠갔습니다. 다시 열려면 공동 비밀번호를 입력해 주세요.'); };

  /* ---------- 로그인 ---------- */
  function renderLogin(msg) {
    $('logout').hidden = true;
    const f = el('form', 'panel login');
    const pw = el('input'); pw.type = 'password'; pw.autocomplete = 'current-password'; pw.placeholder = '공동 비밀번호'; pw.setAttribute('aria-label', '공동 비밀번호'); pw.required = true;
    const go = el('button', 'btn primary', '확인'); go.type = 'submit';
    const row = el('div', 'row2'); row.append(pw, go);
    const err = el('p', 'err', msg || ''); err.style.margin = '0'; err.hidden = !msg;
    if (msg && /잠갔습니다/.test(msg)) err.className = 'note';
    f.append(el('h1', null, '프로젝트 관리'), el('p', 'lede', '공동 비밀번호를 아는 분만 볼 수 있습니다.'), row, err);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!pw.value) return;
      go.disabled = true; err.hidden = false; err.className = 'busy'; err.textContent = '확인하는 중…';
      try {
        const j = await api('login', { password: pw.value });
        state.token = j.token; store.set(j.token); route();
      } catch (ex) { err.className = 'err'; err.textContent = ex.message; pw.select(); }
      finally { go.disabled = false; }
    };
    app.replaceChildren(f);
    setTimeout(() => pw.focus(), 0);
  }

  /* ---------- 목록 ---------- */
  function viewList() {
    const head = el('header', 'top');
    const ttl = el('div'); ttl.append(el('h1', null, '프로젝트 관리'), el('p', 'lede', '프로젝트를 누르면 하드웨어 발주·납품 내역을 볼 수 있습니다.'));
    const tools = el('div', 'tools');
    const reload = btn('새로 고침', null, () => load(reload));
    const add = el('a', 'btn primary', '새 프로젝트'); add.href = '#/new';
    tools.append(reload, add); head.append(ttl, tools);

    const bar = el('div', 'bar');
    const chips = el('div', 'chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', '현 상황별 보기');
    const find = el('div', 'find');
    const q = el('input'); q.type = 'search'; q.placeholder = '현장명·설계사·시공사·담당자 찾기'; q.setAttribute('aria-label', '찾기'); q.value = state.q;
    q.oninput = () => { state.q = q.value; draw(); };
    const sort = el('select'); sort.setAttribute('aria-label', '정렬');
    [['recent', '최근 수정순'], ['due', '준공 예정일순'], ['name', '현장명순']].forEach(([v, t]) => { const o = new Option(t, v); o.selected = state.sort === v; sort.append(o); });
    sort.onchange = () => { state.sort = sort.value; draw(); };
    find.append(q, sort);
    bar.append(chips, find);

    const msg = el('p', 'busy', '불러오는 중…');
    const tbl = el('div', 'table'); tbl.setAttribute('role', 'table'); tbl.setAttribute('aria-label', '프로젝트 목록');
    app.replaceChildren(head, bar, msg, tbl);

    function draw() {
      const list = state.list;
      if (!list) { tbl.hidden = true; return; }
      msg.hidden = true; tbl.hidden = false;
      const counts = new Map(state.statuses.map((s) => [s, 0]));
      list.forEach((p) => counts.set(p.status, (counts.get(p.status) || 0) + 1));
      chips.replaceChildren();
      const all = el('button', 'chip'); all.type = 'button'; all.append(el('span', null, '전체'), el('span', 'n', String(list.length)));
      all.setAttribute('aria-pressed', String(state.filter == null)); all.onclick = () => { state.filter = null; draw(); };
      chips.append(all);
      [...counts.keys()].forEach((s) => {
        const i = state.statuses.indexOf(s);
        const b = el('button', 'chip' + (i >= 0 ? ' s' + (i % 6) : '')); b.type = 'button';
        b.append(el('span', 'dot'), el('span', null, s), el('span', 'n', String(counts.get(s))));
        b.setAttribute('aria-pressed', String(state.filter === s));
        b.onclick = () => { state.filter = state.filter === s ? null : s; draw(); };
        chips.append(b);
      });
      const kw = state.q.trim().toLowerCase();
      let rows = list.filter((p) => (state.filter == null || p.status === state.filter) &&
        (!kw || [p.site, p.designer, p.builder, p.clientManager, p.hansonManager].join(' ').toLowerCase().includes(kw)));
      const cmp = { recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        due: (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.site.localeCompare(b.site, 'ko'),
        name: (a, b) => a.site.localeCompare(b.site, 'ko') }[state.sort];
      rows = rows.slice().sort(cmp);
      const hd = el('div', 'prow head'); hd.setAttribute('role', 'row');
      ['현 상황', '현장명 · 설계사 · 시공사', '담당자', '준공 예정일', '총 금액', '발주율', '납품율'].forEach((t, k) => { const c = el('div', k >= 4 ? 'num' : '', t); c.setAttribute('role', 'columnheader'); hd.append(c); });
      tbl.replaceChildren(hd);
      if (!rows.length) { tbl.append(el('div', 'empty', list.length ? '조건에 맞는 프로젝트가 없습니다.' : '아직 등록한 프로젝트가 없습니다. [새 프로젝트]를 눌러 등록해 주세요.')); return; }
      rows.forEach((p) => tbl.append(listRow(p)));
    }
    async function load(b) {
      await run(b, async () => { const j = await api('list'); state.list = j.projects; draw(); });
      if (!state.list) { msg.className = 'err'; msg.textContent = '목록을 불러오지 못했습니다. [새로 고침]을 눌러 주세요.'; }
    }
    if (state.list) draw();
    load(reload);
  }

  function listRow(p) {
    const r = el('a', 'prow'); r.href = '#/p/' + p.id; r.setAttribute('role', 'row');
    const st = el('div', 'c-st'); st.append(statusPill(p.status));
    const site = el('div', 'c-site'); site.append(el('div', 'site', p.site));
    const sub = [p.designer && '설계 ' + p.designer, p.builder && '시공 ' + p.builder].filter(Boolean).join(' · ');
    if (sub) site.append(el('div', 'sub2', sub));
    const who = el('div', 'c-who sub2');
    if (p.clientManager) who.append(el('div', null, '업체 ' + p.clientManager));
    if (p.hansonManager) who.append(el('div', null, '핸썬 ' + p.hansonManager));
    if (!who.childNodes.length) who.textContent = '–';
    const due = el('div', 'c-due'); due.append(el('span', 'lbl', '준공 예정'), document.createTextNode(p.dueDate || '–'));
    const amt = el('div', 'c-amt num'); amt.append(el('span', 'lbl', '총 금액'), document.createTextNode(won(p.total)));
    const s = p.summary || {};
    const mk = (cls, label, rate) => { const c = el('div', cls); const m = meter(rate); m.querySelector('.pct').prepend(el('span', 'lbl', label)); c.append(m); return c; };
    r.append(st, site, who, due, amt, mk('c-ord num', '발주', s.qty ? s.orderRate : null), mk('c-dlv num', '납품', s.qty ? s.deliveryRate : null));
    return r;
  }

  /* ---------- 상세 ---------- */
  async function viewDetail(id) {
    const back = el('a', 'btn link back', '← 프로젝트 목록'); back.href = '#/';
    if (state.detail && state.detail.project.id === id) renderDetail();
    else app.replaceChildren(back, el('p', 'busy', '불러오는 중…'));
    try { state.detail = await api('project', { id }); if (location.hash === '#/p/' + id) renderDetail(); }
    catch (e) { if (e.code !== 'auth' && location.hash === '#/p/' + id) app.replaceChildren(back, el('p', 'err', e.message)); }
  }

  function renderDetail() {
    const d = state.detail, p = d.project, c = calc(d);
    const back = el('a', 'btn link back', '← 프로젝트 목록'); back.href = '#/';

    const head = el('header', 'top');
    const ttl = el('div'); const h1 = el('h1', null, p.site + ' '); h1.append(statusPill(p.status)); ttl.append(h1);
    const tools = el('div', 'tools');
    const edit = el('a', 'btn', '개요 수정'); edit.href = '#/edit/' + p.id;
    tools.append(edit); head.append(ttl, tools);

    const ov = el('dl', 'panel ov');
    [['현 상황', p.status], ['설계사', p.designer], ['시공사', p.builder], ['업체담당자', p.clientManager], ['핸썬담당자', p.hansonManager],
      ['준공 예정일', p.dueDate], ['총 금액', won(p.total)], ['마지막 수정', p.updatedAt]].forEach(([k, v]) => {
      const g = el('div'); g.append(el('dt', null, k), el('dd', null, v || '–')); ov.append(g);
    });

    const stats = el('section', 'stats'); stats.setAttribute('aria-label', '프로젝트 전체 진행률');
    const stat = (k, rate, done) => {
      const s = el('div', 'panel stat'); s.append(el('span', 'k', k));
      s.append(meter(c.qty ? rate : null, el('span', 'sub', c.qty ? `${fmt(done)} / 전체 ${fmt(c.qty)} (품목 ${fmt(c.items.length)}개)` : '품목을 올리면 계산합니다.')));
      return s;
    };
    stats.append(stat('전체 발주율', c.orderRate, c.ordered), stat('전체 납품율', c.deliveryRate, c.delivered));

    const hwHead = el('div', 'top');
    const ht = el('div'); ht.append(el('h2', null, `하드웨어 품목 ${c.items.length ? fmt(c.items.length) + '개' : ''}`));
    const up = el('div', 'tools');
    const fileIn = el('input', 'file-in'); fileIn.type = 'file'; fileIn.id = 'hw-file'; fileIn.accept = '.xlsx,.xlsm,.xls,.csv';
    const upBtn = el('label', 'btn primary', '엑셀로 품목 올리기'); upBtn.htmlFor = 'hw-file';
    fileIn.onchange = () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) openUpload(f); };
    up.append(upBtn, fileIn); hwHead.append(ht, up);

    const tbl = el('div', 'table'); tbl.setAttribute('role', 'table'); tbl.setAttribute('aria-label', '하드웨어 품목별 발주·납품');
    if (!c.items.length) tbl.append(el('div', 'empty', '아직 품목이 없습니다. 견적서나 스펙 엑셀을 올려 주세요.'));
    else {
      const hd = el('div', 'irow head'); hd.setAttribute('role', 'row');
      ['순번', '제품명 · 모델명', '단위', '수량', '금액', '발주 (누계 · 남음)', '납품 (누계 · 남음)', ''].forEach((t, k) => { const x = el('div', k >= 3 && k <= 4 ? 'num' : '', t); x.setAttribute('role', 'columnheader'); hd.append(x); });
      tbl.append(hd);
      c.items.forEach((x) => tbl.append(itemRow(x)));
    }
    const note = el('p', 'note', '발주율·납품율은 수량 기준입니다. 프로젝트 전체 비율은 품목마다 전체 수량을 넘는 몫을 빼고 계산합니다. 엑셀은 머리글에 순번(NO)·제품명(품명, DESCRIPTION)·모델명(MODEL)·단위(UNIT)·수량(Q\'TY)·금액(AMOUNT)이 있으면 읽습니다.');
    app.replaceChildren(back, head, ov, stats, hwHead, tbl, note);
  }

  function leftText(left, word) {
    return left < 0 ? el('span', 'over', `${fmt(-left)} 초과`) : document.createTextNode(`남음 ${fmt(left)}`);
  }

  function itemRow(x) {
    const it = x.it, open = state.open.has(it.id);
    const wrap = el('div', 'item' + (open ? ' open' : ''));
    const r = el('div', 'irow'); r.setAttribute('role', 'row');
    const seq = el('div', 'c-seq seq', it.seq || '–');
    const name = el('div', 'c-name'); name.append(el('div', 'nm', (it.seq ? '' : '') + (it.name || '(제품명 없음)')));
    if (it.model) name.append(el('div', 'model', it.model));
    const unit = el('div', 'c-unit', it.unit || '–');
    const qty = el('div', 'c-qty num'); qty.append(el('span', 'lbl', '수량'), document.createTextNode(fmt(it.qty)));
    if (it.unit) { const u = el('span', 'lbl', ' ' + it.unit); u.style.marginLeft = '4px'; qty.append(u); }
    const amt = el('div', 'c-amt num'); amt.append(el('span', 'lbl', '금액'), document.createTextNode(won(it.amount)));
    const mk = (cls, label, rate, done, left) => {
      const sub = el('span', 'sub'); sub.append(document.createTextNode(`누계 ${fmt(done)} · `), leftText(left));
      const m = meter(rate, sub); m.querySelector('.pct').prepend(el('span', 'lbl', label));
      const cell = el('div', cls); cell.append(m); return cell;
    };
    const ord = mk('c-ord', '발주', x.orderRate, x.ordered, x.orderLeft);
    const dlv = mk('c-dlv', '납품', x.deliveryRate, x.delivered, x.deliveryLeft);
    const n = x.orderList.length + x.deliveryList.length;
    const rec = el('div', 'c-rec');
    const tg = btn(open ? '닫기' : `기록${n ? ' ' + n : ''}`, null, () => { open ? state.open.delete(it.id) : state.open.add(it.id); renderDetail(); });
    tg.setAttribute('aria-expanded', String(open));
    if (matchMedia('(max-width: 1100px)').matches) tg.textContent = open ? '닫기' : `발주·납품 기록${n ? ' ' + n + '건' : ''} 보기·입력`;
    rec.append(tg);
    r.append(seq, name, unit, qty, amt, ord, dlv, rec);
    wrap.append(r);
    if (open) {
      const recs = el('div', 'recs');
      recs.append(recPanel(x, 'order', '발주', x.orderList), recPanel(x, 'delivery', '납품', x.deliveryList));
      wrap.append(recs);
    }
    return wrap;
  }

  function recPanel(x, kind, word, list) {
    const it = x.it;
    const box = el('section', 'rec'); box.append(el('h3', null, `${word} 기록`));
    if (!list.length) box.append(el('p', 'none', `아직 ${word} 기록이 없습니다.`));
    else {
      const ul = el('ul');
      list.forEach((r) => {
        const li = el('li'); li.append(el('span', 'd', r.date), el('span', 'q', fmt(r.qty) + (it.unit ? ' ' + it.unit : '')));
        li.append(btn('삭제', 'danger', (e) => {
          if (!confirm(`${r.date} ${word} ${fmt(r.qty)}${it.unit ? ' ' + it.unit : ''} 기록을 지울까요?`)) return;
          run(e.currentTarget, async () => { state.detail = await api('deleteRecord', { kind, id: r.id }); renderDetail(); toast(`${word} 기록을 지웠습니다.`); });
        }));
        ul.append(li);
      });
      box.append(ul);
    }
    const f = el('form', 'addf');
    const dt = el('input'); dt.type = 'date'; dt.value = today(); dt.required = true; dt.setAttribute('aria-label', `${word} 날짜`);
    const q = el('input'); q.type = 'text'; q.inputMode = 'decimal'; q.placeholder = '수량'; q.setAttribute('aria-label', `${word} 수량`);
    const left = kind === 'order' ? x.orderLeft : x.deliveryLeft;
    if (left > 0) q.placeholder = `남음 ${fmt(left)}`;
    const go = el('button', 'btn primary', '추가'); go.type = 'submit';
    f.append(dt, q, go);
    f.onsubmit = (e) => {
      e.preventDefault();
      const n = toNum(q.value);
      if (!dt.value) { toast('날짜를 입력해 주세요.'); dt.focus(); return; }
      if (!(n > 0)) { toast('수량을 0보다 큰 숫자로 입력해 주세요.'); q.focus(); return; }
      if (kind === 'order' && x.ordered + n > it.qty && !confirm(`발주 누계가 전체 수량(${fmt(it.qty)})보다 많아집니다. 그래도 저장할까요?`)) return;
      if (kind === 'delivery' && x.delivered + n > x.ordered && !confirm(`납품 누계가 발주 누계(${fmt(x.ordered)})보다 많아집니다. 그래도 저장할까요?`)) return;
      run(go, async () => { state.detail = await api('addRecord', { kind, hwId: it.id, date: dt.value, qty: n }); state.open.add(it.id); renderDetail(); toast(`${word} ${fmt(n)}을(를) 저장했습니다.`); });
    };
    box.append(f);
    return box;
  }

  /* ---------- 개요 등록·수정 ---------- */
  async function viewEdit(id) {
    let p = { status: '', site: '', designer: '', builder: '', clientManager: '', hansonManager: '', dueDate: '', total: '' };
    if (id) {
      if (!state.detail || state.detail.project.id !== id) {
        app.replaceChildren(el('p', 'busy', '불러오는 중…'));
        try { state.detail = await api('project', { id }); } catch (e) { if (e.code !== 'auth') app.replaceChildren(el('p', 'err', e.message)); return; }
      }
      p = Object.assign({}, state.detail.project);
    } else if (!state.statuses.length) {
      try { await api('list').then((j) => { state.list = j.projects; }); } catch (e) { return; }
    }
    const back = el('a', 'btn link back', id ? '← 프로젝트로 돌아가기' : '← 프로젝트 목록'); back.href = id ? '#/p/' + id : '#/';
    const head = el('header'); head.append(el('h1', null, id ? '프로젝트 개요 수정' : '새 프로젝트'), el('p', 'lede', '입력한 뒤 [확인]을 누르면 저장됩니다.'));

    const f = el('form', 'panel form'); f.noValidate = true;
    const fs = el('fieldset', 'field'); fs.append(el('legend', null, '현 상황'));
    const radios = el('div', 'radios');
    state.statuses.forEach((s, i) => {
      const lb = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'status'; r.value = s; r.checked = p.status === s;
      const ch = el('span', 'chip s' + (i % 6)); ch.append(el('span', 'dot'), document.createTextNode(s));
      lb.append(r, ch); radios.append(lb);
    });
    if (p.status && !state.statuses.includes(p.status)) {
      const lb = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'status'; r.value = p.status; r.checked = true;
      lb.append(r, el('span', 'chip', p.status)); radios.append(lb);
    }
    fs.append(radios);

    const fields = el('div', 'fields');
    const inputs = {};
    const field = (key, label, opts) => {
      const lb = el('label', 'field'); const t = el('span', null, label);
      if (!(opts && opts.required)) t.append(el('span', 'opt', ' (선택)'));
      // 현장명은 길어도 다 보이도록 줄이 늘어나는 칸
      const inp = opts && opts.grow ? el('textarea') : el('input'); inp.name = key;
      if (opts && opts.grow) { inp.rows = 1; inp.addEventListener('input', () => grow(inp)); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); f.requestSubmit(); } }); }
      else inp.type = (opts && opts.type) || 'text';
      inp.value = key === 'total' ? (p.total ? fmt(p.total) : '') : (p[key] || '');
      if (opts && opts.mode) inp.inputMode = opts.mode;
      if (opts && opts.ph) inp.placeholder = opts.ph;
      inp.maxLength = 200; inp.autocomplete = 'off';
      lb.append(t, inp); fields.append(lb); inputs[key] = inp; return inp;
    };
    const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
    field('site', '현장명', { required: true, grow: true });
    field('designer', '설계사'); field('builder', '시공사');
    field('clientManager', '업체담당자'); field('hansonManager', '핸썬담당자');
    field('dueDate', '준공 예정일', { type: 'date' });
    const total = field('total', '총 금액 (원)', { mode: 'numeric', ph: '예: 12,500,000' });
    total.onblur = () => { const n = toNum(total.value); if (n != null) total.value = fmt(n); };

    const err = el('p', 'err'); err.hidden = true; err.style.margin = '0';
    const acts = el('div', 'actions');
    const ok = el('button', 'btn primary', '확인'); ok.type = 'submit';
    const cancel = el('a', 'btn', '취소'); cancel.href = back.href;
    acts.append(ok, cancel, el('span', 'grow'));
    if (id) acts.append(btn('프로젝트 삭제', 'danger', (e) => {
      const ans = prompt(`프로젝트와 하드웨어 품목, 발주·납품 기록이 모두 지워지고 되돌릴 수 없습니다.\n지우려면 현장명 "${p.site}"을(를) 그대로 입력해 주세요.`);
      if (ans == null) return;
      if (ans.trim() !== p.site) { toast('현장명이 같지 않아 지우지 않았습니다.'); return; }
      run(e.currentTarget, async () => { await api('deleteProject', { id }); state.detail = null; state.list = null; toast('프로젝트를 지웠습니다.'); location.hash = '#/'; });
    }));
    f.append(fs, fields, err, acts);
    f.onsubmit = (e) => {
      e.preventDefault();
      const chosen = f.querySelector('input[name=status]:checked');
      const showErr = (m, focus) => { err.textContent = m; err.hidden = false; if (focus) focus.focus(); };
      if (!chosen) return showErr('현 상황을 골라 주세요.', radios.querySelector('input'));
      if (!inputs.site.value.trim()) return showErr('현장명을 입력해 주세요.', inputs.site);
      const tv = inputs.total.value.trim(), tn = toNum(tv);
      if (tv && tn == null) return showErr('총 금액은 숫자로 입력해 주세요.', inputs.total);
      err.hidden = true;
      const body = { id: id || '', updatedAt: id ? p.updatedAt : '', status: chosen.value, total: tn || 0 };
      ['site', 'designer', 'builder', 'clientManager', 'hansonManager', 'dueDate'].forEach((k) => { body[k] = inputs[k].value.trim(); });
      run(ok, async () => {
        try {
          const j = await api('saveProject', { project: body });
          state.detail = j; state.list = null;
          toast(id ? '수정한 내용을 저장했습니다.' : '새 프로젝트를 저장했습니다.');
          if (id) location.hash = '#/p/' + j.project.id; else location.replace('#/p/' + j.project.id);
        } catch (ex) {
          if (ex.code === 'conflict') { state.detail = null; showErr(ex.message); const rl = btn('새로 불러오기', null, () => viewEdit(id)); err.append(' ', rl); return; }
          throw ex;
        }
      });
    };
    app.replaceChildren(back, head, f);
    grow(inputs.site);
    if (!id) inputs.site.focus();
  }

  /* ---------- 엑셀로 품목 올리기 ---------- */
  const txt = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
  const normH = (v) => txt(v).replace(/\(.*?\)|\[.*?\]/g, '').replace(/[’‘`´]/g, "'").replace(/[\s.:]/g, '').toUpperCase();
  const HEADS = [
    ['seq', '순번', /^(NO|순번|번호|SEQ)$/],
    ['name', '제품명', /^(품명|제품명|품목|품목명|DESCRIPTION|DESC|ITEM|ITEMNAME|PRODUCT)$/],
    ['model', '모델명', /^(MODEL|MODELNO|모델|모델명|규격)$/],
    ['unit', '단위', /^(UNIT|단위)$/],
    ['qty', '수량', /^(Q'?TY|QUANTITY|수량|TOTALQ'?TY)$/],
    ['amount', '금액', /^(AMOUNT|금액|합계금액|공급가액|TOTALAMOUNT)$/],
  ];
  const SKIP = /^(TOTAL|SUBTOTAL|SUB-TOTAL|합계|소계|총계|계)$/i;

  function parseHardware(wb) {
    const out = [];
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: true });
      for (let h = 0; h < Math.min(rows.length, 30); h++) {
        const hdr = (rows[h] || []).map(normH);
        const col = {}, label = {};
        HEADS.forEach(([k, , re]) => { const i = hdr.findIndex((s) => re.test(s)); if (i >= 0) { col[k] = i; label[k] = txt(rows[h][i]); } });
        if (col.qty == null || (col.name == null && col.model == null)) continue;
        const items = []; let blanks = 0;
        for (let i = h + 1; i < rows.length; i++) {
          const r = rows[i] || [];
          const g = (k) => (col[k] == null ? null : r[col[k]]);
          const name = txt(g('name')), model = txt(g('model')), seq = txt(g('seq'));
          if (!name && !model) { if (++blanks > 5) break; continue; }
          blanks = 0;
          if (SKIP.test(seq.replace(/\s/g, '')) || SKIP.test(name.replace(/\s/g, '')) || SKIP.test(model.replace(/\s/g, ''))) continue;
          const qty = toNum(g('qty'));
          if (qty == null) continue; // 구분 제목 행 (예: "1. DOOR HARDWARE")
          items.push({ seq, name, model, unit: txt(g('unit')), qty, amount: toNum(g('amount')) || 0 });
        }
        if (items.length) out.push({ sheet: sheetName, row: h + 1, col, label, items });
        break;
      }
    }
    return out.sort((a, b) => b.items.length - a.items.length);
  }

  async function openUpload(file) {
    const dlg = $('dlg');
    const box = el('form', 'dlg'); box.method = 'dialog';
    box.append(el('h2', null, '엑셀로 품목 올리기'), el('div', 'fname', file.name), el('p', 'busy', '읽는 중…'));
    dlg.replaceChildren(box); if (!dlg.open) dlg.showModal();
    let cands;
    try {
      if (!window.XLSX) throw new Error('엑셀 읽기 도구를 아직 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
      cands = parseHardware(wb);
      if (!cands.length) throw new Error('품목 표를 찾지 못했습니다. 머리글에 수량(Q\'TY)과 제품명(품명·DESCRIPTION) 또는 모델명(MODEL)이 있어야 합니다.');
    } catch (e) {
      box.replaceChildren(el('h2', null, '엑셀로 품목 올리기'), el('div', 'fname', file.name), el('p', 'err', e.message || '파일을 읽지 못했습니다.'));
      const a = el('div', 'actions'); a.append(btn('닫기', null, () => dlg.close())); box.append(a);
      return;
    }
    const existing = state.detail.items.length, recCount = state.detail.orders.length + state.detail.deliveries.length;
    let ci = 0;
    const draw = () => {
      const c = cands[ci];
      box.replaceChildren(el('h2', null, '엑셀로 품목 올리기'), el('div', 'fname', file.name));
      if (cands.length > 1) {
        const sel = el('select'); sel.setAttribute('aria-label', '읽을 시트');
        cands.forEach((cd, i) => { const o = new Option(`${cd.sheet} 시트 (품목 ${cd.items.length}개)`, String(i)); o.selected = i === ci; sel.append(o); });
        sel.onchange = () => { ci = +sel.value; draw(); };
        box.append(sel);
      }
      const maps = el('div', 'maps');
      HEADS.forEach(([k, name]) => maps.append(c.col[k] != null ? el('span', null, `${name} ← ${c.label[k]}`) : el('span', 'miss', `${name} 열 없음`)));
      box.append(maps);
      const sumQ = c.items.reduce((s, it) => s + it.qty, 0), sumA = c.items.reduce((s, it) => s + it.amount, 0);
      box.append(el('p', 'note', `${c.sheet} 시트 ${c.row}행 머리글 · 품목 ${fmt(c.items.length)}개 · 수량 합계 ${fmt(sumQ)}` + (sumA ? ` · 금액 합계 ${won(sumA)}` : '')));
      const prev = el('div', 'prev');
      c.items.forEach((it, i) => {
        const r = el('div', 'pi');
        const nm = el('div'); nm.append(el('div', 'nm', it.name || '(제품명 없음)')); if (it.model) nm.append(el('div', 'model', it.model));
        r.append(el('div', 'seq', it.seq || String(i + 1)), nm, el('div', 'num', fmt(it.qty) + (it.unit ? ' ' + it.unit : '')));
        prev.append(r);
      });
      box.append(prev);
      let modeBox = null;
      if (existing) {
        modeBox = el('div', 'mode');
        const opt = (v, t, chk) => { const lb = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'mode'; r.value = v; r.checked = chk; lb.append(r, el('span', null, t)); return lb; };
        modeBox.append(el('span', 'muted', `이 프로젝트에는 이미 품목 ${fmt(existing)}개가 있습니다.`),
          opt('append', '기존 품목 뒤에 더하기', true),
          opt('replace', `기존 품목을 모두 지우고 바꾸기` + (recCount ? ` (발주·납품 기록 ${fmt(recCount)}건도 함께 지워집니다)` : ''), false));
        box.append(modeBox);
      }
      const acts = el('div', 'actions');
      const ok = el('button', 'btn primary', '확인'); ok.type = 'button';
      ok.onclick = () => {
        const mode = modeBox ? box.querySelector('input[name=mode]:checked').value : 'append';
        if (mode === 'replace' && !confirm(`기존 품목 ${fmt(existing)}개` + (recCount ? `와 발주·납품 기록 ${fmt(recCount)}건` : '') + '을 지우고 새 품목으로 바꿀까요? 되돌릴 수 없습니다.')) return;
        run(ok, async () => {
          state.detail = await api('uploadHardware', { projectId: state.detail.project.id, items: c.items, mode });
          dlg.close(); renderDetail(); toast(`품목 ${fmt(c.items.length)}개를 저장했습니다.`);
        });
      };
      acts.append(ok, btn('취소', null, () => dlg.close()));
      box.append(acts);
    };
    draw();
  }

  /* ---------- 시작 ---------- */
  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.append(s); }); }
  (async () => {
    if (MOCK) {
      await loadScript('dev/mock-gas.js'); await loadScript('apps-script/Code.js');
      window.__mockReady();
    } else if (!CFG.API_URL) {
      app.replaceChildren(el('p', 'banner bad', '아직 서버 주소가 설정되지 않았습니다. 관리자에게 알려 주세요.'));
      return;
    }
    route();
  })();
})();
