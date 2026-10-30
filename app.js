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
  const state = { token: store.get(), statuses: [], list: null, filter: null, q: '', sort: 'recent', detail: null, open: new Set(), erpOpen: new Set(), stock: null, memoEdit: null };

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
  const ST_COLOR = { 영업중: 0, 설계: 6, 견적: 1, 수주: 2, 진행중: 3, 준공: 4, 보류: 5 };
  const stCls = (s) => { if (s in ST_COLOR) return ' s' + ST_COLOR[s]; const i = state.statuses.indexOf(s); return i >= 0 ? ' s' + (i % 7) : ''; };
  function statusPill(s) { return el('span', 'pill' + stCls(s), s || '–'); }

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
        const b = el('button', 'chip' + stCls(s)); b.type = 'button';
        b.append(el('span', 'dot'), el('span', null, s), el('span', 'n', String(counts.get(s))));
        b.setAttribute('aria-pressed', String(state.filter === s));
        b.onclick = () => { state.filter = state.filter === s ? null : s; draw(); };
        chips.append(b);
      });
      const kw = state.q.trim().toLowerCase();
      let rows = list.filter((p) => (state.filter == null || p.status === state.filter) &&
        (!kw || [p.site, p.designer, p.builder, p.designManager, p.clientManager, p.hansonManager].join(' ').toLowerCase().includes(kw)));
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
    if (p.designManager) who.append(el('div', null, '설계 ' + p.designManager));
    if (p.clientManager) who.append(el('div', null, '시공 ' + p.clientManager));
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
    catch (e) { if (e.code !== 'auth' && location.hash === '#/p/' + id) app.replaceChildren(back, el('p', 'err', e.message)); return; }
    // ERP 품목명을 보여 주려고 품목 목록을 한 번 불러 둠 (실패해도 화면은 그대로)
    if (!state.cat && state.detail.items.length) ensureCatalog().then(() => { if (location.hash === '#/p/' + id) renderDetail(); }).catch(() => {});
    if (state.detail.items.some((it) => it.erpCode)) ensureStock().then(() => { if (location.hash === '#/p/' + id) renderDetail(); });
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
    [['현 상황', p.status], ['설계사', p.designer], ['시공사', p.builder], ['설계담당자', p.designManager], ['시공담당자', p.clientManager], ['핸썬담당자', p.hansonManager],
      ['납품 예정일', p.deliveryDate], ['준공 예정일', p.dueDate], ['총 금액', won(p.total)], ['마지막 수정', p.updatedAt]].forEach(([k, v]) => {
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
    const todo = d.items.filter((it) => it.erpState === 'guess' || !it.erpState);
    if (todo.length) {
      ht.append(el('p', 'lede', `품목코드 확인이 필요한 품목 ${fmt(todo.length)}개 (추정 ${fmt(todo.filter((it) => it.erpState === 'guess').length)} · 없음 ${fmt(todo.filter((it) => !it.erpState).length)})`));
      // 사전이 늘었을 수 있으니, 품목코드가 없는 품목만 다시 찾아 붙임 (사람이 확인한 것은 건드리지 않음)
      const again = btn('품목코드 다시 찾기', null, () => run(again, async () => {
        await ensureCatalog();
        const changes = d.items.filter((it) => !it.erpState).map((it) => ({ it, m: matchErp(it) })).filter((x) => x.m.code)
          .map((x) => ({ hwId: x.it.id, erpCode: x.m.code, erpState: x.m.state }));
        if (!changes.length) { toast('새로 찾은 품목코드가 없습니다.'); return; }
        state.detail = await api('setErp', { changes }); setAliases(state.detail.aliases); renderDetail();
        toast(`품목 ${fmt(changes.length)}개에 품목코드를 붙였습니다.`);
      }));
      if (todo.some((it) => !it.erpState)) up.append(again);
    }
    // 핸썬 재고 기준 시각 (품목코드가 붙은 품목이 있을 때만)
    if (d.items.some((it) => it.erpCode)) {
      const st = state.stock, line = el('p', 'lede stockline');
      if (stockLoading || !st) line.textContent = '핸썬 재고를 불러오는 중…';
      else if (st.error) { line.classList.add('bad'); line.textContent = '핸썬 재고: ' + st.error; }
      else line.textContent = `핸썬 재고: ${st.time || '시각 모름'} 기준 가용 수량 (반입재 + 상용재고)`;
      if (st && !stockLoading) {
        const re = btn('재고 새로 불러오기', 'link sm', () => { re.disabled = true; ensureStock(true).then(() => { if (state.detail === d) renderDetail(); }); });
        line.append(' ', re);
      }
      ht.append(line);
    }
    const fileIn = el('input', 'file-in'); fileIn.type = 'file'; fileIn.id = 'hw-file'; fileIn.accept = '.xlsx,.xlsm,.xls,.csv';
    const upBtn = el('label', 'btn primary', '엑셀로 품목 올리기'); upBtn.htmlFor = 'hw-file';
    fileIn.onchange = () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) openUpload(f); };
    up.append(btn('품목 직접 입력', null, () => openItem(null)), upBtn, fileIn); hwHead.append(ht, up);

    const tbl = el('div', 'table'); tbl.setAttribute('role', 'table'); tbl.setAttribute('aria-label', '하드웨어 품목별 발주·납품');
    if (!c.items.length) tbl.append(el('div', 'empty', '아직 품목이 없습니다. 견적서나 스펙 엑셀을 올리거나 [품목 직접 입력]으로 넣어 주세요.'));
    else {
      const hd = el('div', 'irow head'); hd.setAttribute('role', 'row');
      ['순번', '제품명 · 모델명', '단위', '현장수량', '재고', '금액', '발주 (누계 · 남음)', '납품 (누계 · 남음)', ''].forEach((t, k) => { const x = el('div', k >= 3 && k <= 5 ? 'num' : '', t); x.setAttribute('role', 'columnheader'); hd.append(x); });
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
    // 품목코드·재고 수기·품목 고치기는 평소에 숨기고 [자세히 보기]로 펼침
    const more = state.erpOpen.has(it.id);
    const tgl = btn(more ? '접기' : '자세히 보기', 'link more', () => { more ? state.erpOpen.delete(it.id) : state.erpOpen.add(it.id); renderDetail(); });
    tgl.setAttribute('aria-expanded', String(more));
    const links = el('div', 'links'); links.append(tgl);
    if (!it.memo && state.memoEdit !== it.id) links.append(btn('적요 쓰기', 'link more', () => { state.memoEdit = it.id; renderDetail(); }));
    name.append(links);
    if (more) { const box = el('div', 'more-box'); box.append(erpLine(it), stockLine(it, x)); const t = el('div'); t.append(btn('품목 고치기·지우기', 'sm', () => openItem(it))); box.append(t); name.append(box); }
    const unit = el('div', 'c-unit', it.unit || '–');
    const qty = el('div', 'c-qty num'); qty.append(el('span', 'lbl', '현장수량'), document.createTextNode(fmt(it.qty)));
    if (it.unit) { const u = el('span', 'lbl', ' ' + it.unit); u.style.marginLeft = '4px'; qty.append(u); }
    const stk = el('div', 'c-stk num'); stk.append(el('span', 'lbl', '재고'));
    const s = state.stock, code = it.erpState === 'none' ? '' : it.erpCode;
    if (hasManual(it)) {
      stk.append(document.createTextNode(fmt(Number(it.stockManual))), el('span', 'sub2 tag-man', '수기'));
      stk.title = '수기로 고친 재고 (' + it.stockManualAt + ')';
    } else if (!code) stk.append(document.createTextNode('–'));
    else if (!s || !s.map) stk.append(document.createTextNode(s && s.error ? '–' : '…'));
    else {
      const v = s.map.get(code);
      stk.append(document.createTextNode(fmt(v ? v.avail : 0)));
      if (it.erpState === 'guess') stk.append(el('span', 'sub2 tag-guess', '추정'));
      if (v && v.defQ) stk.append(el('span', 'sub2', `반재 ${fmt(v.defQ)}`));
      stk.title = `${code} · 가용 ${fmt(v ? v.avail : 0)}` + (v ? '' : ' (재고현황에 없음)');
    }
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
    const tg = btn(null, null, () => { open ? state.open.delete(it.id) : state.open.add(it.id); renderDetail(); });
    tg.setAttribute('aria-expanded', String(open));
    // 표(넓은 화면)에는 짧은 글자, 카드(좁은 화면)에는 긴 글자. 창 폭이 바뀌어도 CSS가 알맞은 쪽을 보여 줌
    if (open) tg.textContent = '닫기';
    else tg.append(el('span', 't-wide', `기록${n ? ' ' + n : ''}`), el('span', 't-narrow', `발주·납품 기록${n ? ' ' + n + '건' : ''} 보기·입력`));
    rec.append(tg);
    r.append(seq, name, unit, qty, stk, amt, ord, dlv, rec);
    wrap.append(r);
    if (state.memoEdit === it.id || it.memo) wrap.append(memoLine(it));
    if (open) {
      const recs = el('div', 'recs');
      recs.append(recPanel(x, 'order', '발주', x.orderList), recPanel(x, 'delivery', '납품', x.deliveryList));
      wrap.append(recs);
    }
    return wrap;
  }

  const hasManual = (it) => it.stockManual !== '' && it.stockManual != null;
  async function patchItem(button, it, patch, msg) {
    const j = await run(button, () => api('updateItem', { hwId: it.id, patch }));
    if (!j) return false;
    state.detail = j; renderDetail(); if (msg) toast(msg);
    return true;
  }

  // 재고 수기: ERP 누락·오표기일 때 이 품목의 재고 숫자를 직접 고침. 비우면 다시 ERP 재고
  function stockLine(it) {
    const f = el('form', 'stockf');
    const code = it.erpState === 'none' ? '' : it.erpCode, s = state.stock;
    const auto = !code ? '품목코드 없음' : s && s.map ? 'ERP 재고 ' + fmt((s.map.get(code) || { avail: 0 }).avail) : 'ERP 재고 불러오는 중';
    const lb = el('label', null, '재고 수기');
    const inp = el('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = hasManual(it) ? fmt(Number(it.stockManual)) : ''; inp.placeholder = '숫자';
    inp.setAttribute('aria-label', '재고 수기 입력'); lb.append(inp);
    const go = el('button', 'btn sm', '저장'); go.type = 'submit';
    f.append(lb, go);
    if (hasManual(it)) f.append(btn('ERP 재고로 되돌리기', 'sm', (e) => patchItem(e.currentTarget, it, { stockManual: '' }, 'ERP 재고로 되돌렸습니다.')));
    f.append(el('span', 'muted', auto + (hasManual(it) ? ' · ' + it.stockManualAt.slice(0, 10) + ' 수기' : '')));
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (v === '') { if (hasManual(it)) patchItem(go, it, { stockManual: '' }, 'ERP 재고로 되돌렸습니다.'); return; }
      const n = toNum(v);
      if (n == null || n < 0) { toast('재고는 0 이상의 숫자로 입력해 주세요.'); inp.focus(); return; }
      patchItem(go, it, { stockManual: n }, '재고를 ' + fmt(n) + '(으)로 고쳤습니다.');
    };
    return f;
  }

  // 품목 아래 적요 (특이사항 메모)
  function memoLine(it) {
    const box = el('div', 'memo');
    if (state.memoEdit !== it.id) {
      box.append(el('span', 'k', '적요'), el('span', 'v', it.memo), btn('수정', 'link sm', () => { state.memoEdit = it.id; renderDetail(); }));
      return box;
    }
    const f = el('form', 'memof');
    const ta = el('textarea'); ta.value = it.memo || ''; ta.maxLength = 1000; ta.rows = 2; ta.placeholder = '특이사항 (예: 색상 변경 요청, 부분 납품 일정)';
    ta.setAttribute('aria-label', '적요');
    const acts = el('div', 'actions');
    const ok = el('button', 'btn primary sm', '저장'); ok.type = 'submit';
    acts.append(ok, btn('취소', 'sm', () => { state.memoEdit = null; renderDetail(); }));
    f.append(el('span', 'k', '적요'), ta, acts);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = ta.value.trim();
      if (v === (it.memo || '')) { state.memoEdit = null; renderDetail(); return; }
      state.memoEdit = null;
      if (!(await patchItem(ok, it, { memo: v }, v ? '적요를 저장했습니다.' : '적요를 지웠습니다.'))) state.memoEdit = it.id;
    };
    box.append(f);
    setTimeout(() => ta.focus(), 0);
    return box;
  }

  // 품목 직접 입력 (it 없음) 또는 고치기·지우기
  async function openItem(it) {
    const dlg = $('dlg'), isNew = !it;
    const box = el('form', 'dlg'); box.noValidate = true;
    box.append(el('h2', null, isNew ? '품목 직접 입력' : '품목 고치기'));
    const grid = el('div', 'fields'), inp = {};
    const field = (k, label, opt) => {
      const lb = el('label', 'field'); const t = el('span', null, label);
      if (!(opt && opt.req)) t.append(el('span', 'opt', ' (선택)'));
      const i = el(opt && opt.area ? 'textarea' : 'input'); if (!(opt && opt.area)) i.type = 'text'; else i.rows = 2;
      i.value = it ? (opt && opt.num ? (it[k] ? fmt(it[k]) : (k === 'qty' ? '0' : '')) : it[k] || '') : '';
      if (opt && opt.num) i.inputMode = 'decimal';
      if (opt && opt.ph) i.placeholder = opt.ph;
      i.maxLength = (opt && opt.max) || 200; i.autocomplete = 'off';
      lb.append(t, i); if (opt && opt.wide) lb.classList.add('wide'); grid.append(lb); inp[k] = i;
    };
    field('name', '제품명', { req: true, ph: '제품명이나 모델명 중 하나는 꼭' }); field('model', '모델명');
    field('maker', '매입처'); field('seq', '순번', { max: 20 }); field('unit', '단위', { max: 20, ph: '예: EA' });
    field('qty', '현장수량', { req: true, num: true }); field('amount', '금액 (원)', { num: true });
    if (isNew) field('memo', '적요', { area: true, max: 1000, wide: true });
    const err = el('p', 'err'); err.hidden = true; err.style.margin = '0';
    const acts = el('div', 'actions');
    const ok = el('button', 'btn primary', '확인'); ok.type = 'submit';
    acts.append(ok, btn('취소', null, () => dlg.close()), el('span', 'grow'));
    if (!isNew) {
      const recN = state.detail.orders.filter((r) => r.hwId === it.id).length + state.detail.deliveries.filter((r) => r.hwId === it.id).length;
      acts.append(btn('품목 지우기', 'danger', (e) => {
        if (!confirm(`"${it.name || it.model}" 품목` + (recN ? `과 발주·납품 기록 ${recN}건` : '') + '을 지울까요? 되돌릴 수 없습니다.')) return;
        run(e.currentTarget, async () => { state.detail = await api('deleteItem', { hwId: it.id }); dlg.close(); renderDetail(); toast('품목을 지웠습니다.'); });
      }));
    }
    box.append(grid, err, acts);
    box.onsubmit = async (e) => {
      e.preventDefault();
      const v = (k) => inp[k] ? inp[k].value.trim() : '';
      const showErr = (m, i) => { err.textContent = m; err.hidden = false; if (i) i.focus(); };
      if (!v('name') && !v('model')) return showErr('제품명이나 모델명을 입력해 주세요.', inp.name);
      const q = toNum(v('qty')); if (q == null || q < 0) return showErr('현장수량을 0 이상의 숫자로 입력해 주세요.', inp.qty);
      const a = v('amount') ? toNum(v('amount')) : 0; if (a == null) return showErr('금액은 숫자로 입력해 주세요.', inp.amount);
      err.hidden = true;
      const item = { name: v('name'), model: v('model'), maker: v('maker'), seq: v('seq'), unit: v('unit'), qty: q, amount: a };
      // 품목코드: 새 품목이나 모델·제품명이 바뀐 자동 붙임(사전·추정·없음)은 다시 찾음. 사람이 확인한 것은 그대로
      const changed = !it || ['name', 'model', 'maker'].some((k) => item[k] !== (it[k] || ''));
      if (changed && (!it || it.erpState !== 'ok' && it.erpState !== 'none')) {
        try { await ensureCatalog(); const m = matchErp(item); item.erpCode = m.code; item.erpState = m.state; } catch {}
      }
      if (isNew) item.memo = v('memo');
      const done = await run(ok, () => isNew ? api('addItem', { projectId: state.detail.project.id, item }) : api('updateItem', { hwId: it.id, patch: item }));
      if (!done) return;
      state.detail = done; dlg.close(); renderDetail();
      toast(isNew ? '품목을 더했습니다.' + (item.erpCode ? ' 품목코드 ' + item.erpCode + '(' + ERP_LABEL[item.erpState] + ')를 붙였습니다.' : '') : '품목을 고쳤습니다.');
    };
    dlg.replaceChildren(box); if (!dlg.open) dlg.showModal();
    setTimeout(() => inp.name.focus(), 0);
  }

  // 품목 아래 ERP 품목코드 한 줄: 코드 · ERP 품목명 · 상태, 그리고 확인 버튼
  function erpLine(it) {
    const e = el('div', 'erp');
    if (it.erpState === 'none') e.append(el('span', 'pill e-none', ERP_LABEL.none));
    else if (it.erpCode) {
      e.append(el('span', 'code', it.erpCode));
      const t = erpText(it.erpCode); if (t) e.append(document.createTextNode(' ' + t));
      e.append(document.createTextNode(' '), el('span', 'pill e-' + (it.erpState || 'guess'), ERP_LABEL[it.erpState] || '추정'));
    } else e.append(el('span', 'muted', '품목코드 없음'));
    const acts = el('span', 'erp-acts');
    if (it.erpState === 'guess') {
      const yes = btn('맞음', 'sm', () => saveErp(yes, it, it.erpCode, true));
      yes.title = '이 품목코드가 맞으면 누르세요. 별칭 사전에도 더합니다.';
      acts.append(yes);
    }
    acts.append(btn(it.erpCode || it.erpState === 'none' ? '바꾸기' : '품목코드 찾기', 'sm', () => openErp(it)));
    e.append(acts);
    return e;
  }

  async function saveErp(button, it, code, toDict) {
    const ok = await run(button, async () => {
      const j = await api('setErp', { changes: [{ hwId: it.id, erpCode: code, erpState: code ? 'ok' : 'none' }], addAlias: !!(toDict && code) });
      state.detail = j; setAliases(j.aliases);
      return j;
    });
    if (!ok) return false;
    if ($('dlg').open) $('dlg').close();
    renderDetail();
    toast(code ? '품목코드를 저장했습니다.' + (ok.dict ? (ok.dict.added || ok.dict.raised ? ' 별칭 사전에도 더했습니다.' : ' 사전에 이미 있는 짝입니다.') : '') : 'ERP에 없는 품목으로 표시했습니다.');
    return true;
  }

  // 품목코드 고르기: 후보(사전 → 기호 무시 → 품명·매입처) + 전체 품목에서 찾기 + ERP에 없음
  async function openErp(it) {
    const dlg = $('dlg');
    const box = el('form', 'dlg'); box.method = 'dialog';
    box.append(el('h2', null, '품목코드 확인'), el('p', 'busy', '품목 목록을 불러오는 중…'));
    dlg.replaceChildren(box); if (!dlg.open) dlg.showModal();
    try { await ensureCatalog(); } catch (e) {
      box.replaceChildren(el('h2', null, '품목코드 확인'), el('p', 'err', e.message));
      const a = el('div', 'actions'); a.append(btn('닫기', null, () => dlg.close())); box.append(a); return;
    }
    const m = matchErp(it);
    let pick = it.erpState === 'none' ? '' : (it.erpCode || m.code || null);
    const q0 = el('div', 'quote');
    q0.append(el('div', 'nm', it.name || '(제품명 없음)'));
    if (it.model) q0.append(el('div', 'model', it.model));
    if (it.maker) q0.append(el('div', 'muted', '매입처 ' + it.maker));
    const list = el('div', 'clist'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', '품목코드 후보');
    const found = el('div', 'clist');
    const chk = el('input'); chk.type = 'checkbox'; chk.checked = !!it.model;
    const chkL = el('label', 'tick'); chkL.append(chk, el('span', null, '이 모델명과 품목코드를 별칭 사전에 더하기 (다음부터 자동으로 붙습니다)'));
    const opt = (code, why, group) => {
      const lb = el('label', 'copt');
      const r = el('input'); r.type = 'radio'; r.name = 'erp'; r.value = code; r.checked = pick === code;
      r.onchange = () => { pick = code; chk.disabled = !code || !it.model; };
      const t = el('span', 't');
      if (code) { const ci = state.cat.byCode.get(code); t.append(el('span', 'code', code + ' '), document.createTextNode(ci ? ci.full : '(전체 품목에 없음)')); if (ci && ci.supplier) t.append(el('span', 'muted', ' · ' + ci.supplier)); }
      else t.append(document.createTextNode('ERP에 없는 품목 (품목코드 비움)'));
      if (why) t.append(el('span', 'why', ' · ' + why));
      lb.append(r, t); group.append(lb);
    };
    const cands = m.cands.slice();
    if (it.erpCode && !cands.some((c) => c.code === it.erpCode)) cands.unshift({ code: it.erpCode, why: '지금 붙어 있는 코드' });
    if (cands.length) cands.forEach((c) => opt(c.code, c.why, list));
    else list.append(el('p', 'none', '자동으로 찾은 후보가 없습니다. 아래에서 찾아 주세요.'));
    opt('', '', list);
    const q = el('input'); q.type = 'search'; q.placeholder = '품목코드·품목명·규격·매입처로 찾기'; q.setAttribute('aria-label', '전체 품목에서 찾기');
    const search = () => {
      const k = normM(q.value); found.replaceChildren();
      if (k.length < 2) return;
      const hits = state.cat.items.filter((x) => normM(x.code + ' ' + x.full + ' ' + x.supplier).includes(k));
      hits.slice(0, 30).forEach((x) => opt(x.code, '', found));
      found.append(el('p', 'note', hits.length ? (hits.length > 30 ? `${fmt(hits.length)}개 중 30개만 보입니다. 더 자세히 적어 주세요.` : `${fmt(hits.length)}개`) : '맞는 품목이 없습니다.'));
    };
    q.oninput = search;
    q.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
    chk.disabled = !pick || !it.model;
    const acts = el('div', 'actions');
    const ok = el('button', 'btn primary', '확인'); ok.type = 'button';
    ok.onclick = () => { if (pick == null) { toast('품목코드를 골라 주세요.'); return; } saveErp(ok, it, pick, chk.checked); };
    acts.append(ok, btn('취소', null, () => dlg.close()));
    box.replaceChildren(el('h2', null, '품목코드 확인'), q0, el('h3', null, '후보'), list, el('h3', null, '전체 품목에서 찾기'), q, found, chkL, acts);
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
    let p = { status: '', site: '', designer: '', builder: '', designManager: '', clientManager: '', hansonManager: '', deliveryDate: '', dueDate: '', total: '' };
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
      const ch = el('span', 'chip' + stCls(s)); ch.append(el('span', 'dot'), document.createTextNode(s));
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
    field('designManager', '설계담당자'); field('clientManager', '시공담당자'); field('hansonManager', '핸썬담당자');
    field('deliveryDate', '납품 예정일', { type: 'date' });
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
      ['site', 'designer', 'builder', 'designManager', 'clientManager', 'hansonManager', 'deliveryDate', 'dueDate'].forEach((k) => { body[k] = inputs[k].value.trim(); });
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
    ['maker', '매입처', /^(매입처|구매처|브랜드|제조사|BRAND|MAKER|MANUFACTURER|SUPPLIER)$/, true], // 있으면 매칭에 씀
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
          items.push({ seq, name, model, unit: txt(g('unit')), qty, amount: toNum(g('amount')) || 0, maker: txt(g('maker')) });
        }
        if (items.length) out.push({ sheet: sheetName, row: h + 1, col, label, items });
        break;
      }
    }
    return out.sort((a, b) => b.items.length - a.items.length);
  }

  /* ---------- ERP 품목코드 붙이기: 별칭 사전 → 기호 무시 비교 → 품명·매입처 비교 ---------- */
  // 사전 '확실'만 자동으로 붙이고(dict), 기호 무시 비교로 하나만 맞으면 추정(guess)으로 붙임. 나머지는 후보로만 보여 주고 사람이 고름
  const ERP_LABEL = { dict: '사전', guess: '추정', ok: '확인함', none: 'ERP에 없음' };
  const normM = (s) => txt(s).toUpperCase().replace(/[\s\-_.·'"`’()\[\]]/g, '');
  const CATS = [
    ['BUTT HINGE', /BUTTE?\s*HINGE|^HINGES?\b/i], ['PIVOT', /PIVOT/i], ['PIN HINGE', /PIN\s*HINGE/i], ['CONCEALED HINGE', /CONCEALED\s*HINGE|3D\s*ADJ/i],
    ['CONTINUOUS HINGE', /CONTINUOUS\s*HINGE/i], ['AUTO POWER HINGE', /POWER\s*HINGE/i], ['GLASS HINGE', /GLASS\s*HINGE|SHOWER/i],
    ['FLOOR HINGE', /FLOOR\s*(HINGE|SPRING)/i], ['DOOR CLOSER', /CLOSER/i], ['COORDINATOR', /COORDINATOR/i],
    ['PANIC', /PANIC|EXIT\s*DEVICE/i], ['OUT-TRIM', /OUT.?TRIM/i], ['DEAD LOCK', /DEAD\s*LOCK|DEADBOLT|DEAD\s*BOLT/i],
    ['MORTISE LOCK', /MORTISE|LOCK\s*BODY|\bLOCK\b/i], ['CYLINDER', /CYLINDER|THUMB\s*TURN/i], ['LEVER', /LEVER/i],
    ['PUSH PULL PLATE', /PUSH|PULL\s*PLATE/i], ['PULL HANDLE', /PULL\s*HANDLE|DOOR\s*PULL/i], ['FLUSH HANDLE', /FLUSH\s*(RING\s*)?HANDLE|CUP|컵/i],
    ['FLUSH BOLT', /FLUSH\s*BOLT/i], ['DUST PROOF', /DUST|먼지/i], ['DOOR STOP', /STOP(PER)?\b|STOPPER|STOPER/i], ['DOOR CATCH', /CATCH/i],
    ['DOOR GUARD', /GUARD/i], ['VIEWER', /VIEWER/i], ['DIGITAL LOCK', /DIGITAL|DOOR\s*LOCK/i], ['SLIDING', /SLIDING/i],
    ['PATCH', /PATCH/i], ['DOOR SEAL', /SEAL|씰|실$/i],
  ];
  const catOf = (s) => { for (const [k, re] of CATS) if (re.test(s || '')) return k; return null; };
  // 매입처 이름이 회사마다 다르게 적히는 것 (게제코리아 = GEZE 등)
  const BRANDS = [['STANLEY', /STANLEY|스탠리/i], ['GEZE', /GEZE|게제/i], ['DORMA', /DORMA|도르마/i], ['HAFELE', /HAFELE|HÄFELE|헤펠레|해펠레/i],
    ['DLINE', /D\s*LINE|디라인/i], ['ASSA', /ASSA|아싸/i], ['S&G', /S\s*[&＆]\s*G/i], ['KOAS', /KOAS|코아스/i]];
  const brandsIn = (s) => BRANDS.filter(([, re]) => re.test(s || '')).map(([k]) => k);
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

  function prepCatalog(j) {
    const items = j.items.map(([code, name, spec, unit, supplier, search]) => {
      const seq = [spec, search, name].join(' ').split(/[\s\[\](),\/+]+/).map(normM).filter(Boolean);
      const joined = [];
      for (let a = 0; a < seq.length; a++) for (let b = a + 2; b <= Math.min(seq.length, a + 3); b++) joined.push(seq.slice(a, b).join(''));
      const sup = normM(supplier);
      return { code, name, spec, unit, supplier, full: name + (spec ? ' [' + spec + ']' : ''), tokens: new Set(seq.filter((t) => t.length >= 2)), joined: new Set(joined),
        cat: catOf(name + ' ' + spec), brands: brandsIn(supplier + ' ' + search + ' ' + spec), sup: sup.length >= 2 ? sup : '' };
    });
    state.cat = { items, byCode: new Map(items.map((i) => [i.code, i])) };
    setAliases(j.aliases);
  }
  function setAliases(list) {
    if (!state.cat) return;
    const m = new Map();
    (list || []).forEach((a) => { const k = normM(a.alias); if (k) (m.get(k) || m.set(k, []).get(k)).push(a); });
    state.cat.alias = m;
  }
  let catLoading = null;
  function ensureCatalog() {
    if (state.cat) return Promise.resolve(state.cat);
    if (!catLoading) catLoading = api('catalog').then((j) => { prepCatalog(j); return state.cat; }).finally(() => { catLoading = null; });
    return catLoading;
  }

  // 한 품목 → { code, state, cands: [{ code, why, kind }] }
  function matchErp(hw) {
    const C = state.cat, out = { code: '', state: '', cands: [] };
    if (!C) return out;
    const add = (code, why, kind) => { if (code && !out.cands.some((c) => c.code === code)) out.cands.push({ code, why, kind }); };
    const model = txt(hw.model);
    const keys = [...new Set([model, ...model.split(/\s*[\/,]\s*/)].map(normM).filter((k) => k.length >= 2))];
    // 1) 별칭 사전
    const hits = keys.flatMap((k) => C.alias.get(k) || []);
    const sure = [...new Set(hits.filter((a) => a.status === '확실').map((a) => a.code))];
    sure.forEach((c) => add(c, '별칭 사전', 'dict'));
    hits.filter((a) => a.status !== '확실').forEach((a) => add(a.code, '사전 후보 (확인 필요)', 'dictq'));
    if (sure.length === 1) { out.code = sure[0]; out.state = 'dict'; }
    else if (sure.length > 1) { out.code = sure[0]; out.state = 'guess'; }
    // 2) 기호 무시 비교 — 기호를 뺀 모델이 완전히 같을 때만 (헤펠레 8자리 코드는 숫자가 하나라도 다르면 다른 제품)
    const exact = [];
    // 숫자가 든 조각만 모델로 봄 ('스탠리'처럼 매입처 이름만 같은 품목이 붙지 않도록)
    for (const k of keys) {
      if (k.length < 3 || !/\d/.test(k)) continue;
      C.items.forEach((it) => { if (it.tokens.has(k) || (k.length >= 5 && it.joined.has(k))) exact.push(it.code); });
    }
    const ex = [...new Set(exact)];
    ex.forEach((c) => add(c, '모델 일치 (기호 무시)', 'model'));
    // 사전 후보(확인 필요)가 따로 있으면 사람이 고르도록 비워 둠
    const dq = hits.filter((a) => a.status !== '확실').map((a) => a.code);
    if (!out.code && ex.length === 1 && (!dq.length || dq.includes(ex[0]))) { out.code = ex[0]; out.state = 'guess'; }
    // 3) 품명·매입처 비교 → 후보만
    const qcat = catOf(hw.name) || catOf(model);
    const qtext = [hw.maker, model, hw.name].join(' '), qn = normM(qtext), qb = brandsIn(qtext);
    // 비슷함 비교는 매입처 이름을 뺀 모델 조각 중 숫자가 든 가장 긴 것으로 (STANLEY.SGH2B4540SS/스탠리 → SGH2B4540SS)
    const bare = BRANDS.reduce((s, [, re]) => s.replace(new RegExp(re.source, 'gi'), ' '), model);
    const k0 = bare.split(/[\/,]+/).map(normM).filter((k) => /\d/.test(k)).sort((a, b) => b.length - a.length)[0] || '';
    const scored = [];
    // 헤펠레 8자리 코드가 있는 품목은, 다른 8자리 코드를 가진 ERP 품목을 후보에서도 뺌 (숫자가 다르면 다른 제품)
    const haf = keys.find((k) => /^\d{8}$/.test(k));
    C.items.forEach((it) => {
      if (out.cands.some((c) => c.code === it.code)) return;
      if (haf && [...it.tokens].some((t) => /^\d{8}$/.test(t) && t !== haf)) return;
      const supOk = (it.sup && qn.includes(it.sup)) || it.brands.some((b) => qb.includes(b));
      let sim = 0;
      if (k0.length >= 4 && !/^\d+$/.test(k0)) for (const t of it.tokens) { const p = commonPrefix(t, k0); if (p >= 4 && p > sim) sim = p; }
      const catOk = qcat && it.cat === qcat;
      if ((catOk && supOk) || (sim >= 4 && (catOk || supOk))) scored.push({ it, s: (supOk ? 3 : 0) + (catOk ? 2 : 0) + sim, why: [catOk && '같은 분류', supOk && '같은 매입처', sim && '모델 비슷함'].filter(Boolean).join(' · ') });
    });
    scored.sort((a, b) => b.s - a.s).slice(0, 8).forEach((x) => add(x.it.code, x.why, 'name'));
    return out;
  }
  /* ---------- 핸썬 재고 (재고 확인 앱이 30분마다 올리는 잠긴 재고 파일) ---------- */
  // 재고 앱 암호는 공동 비밀번호로 로그인한 사람에게만 서버가 건네주고, 이 화면은 기기에 저장하지 않음
  const STOCK_SOURCES = [
    { url: 'https://api.github.com/repos/ilhun425/hanson-stock-check/contents/data/stock.json?ref=main', headers: { Accept: 'application/vnd.github.raw+json' } },
    { url: 'https://raw.githubusercontent.com/ilhun425/hanson-stock-check/main/data/stock.json', bust: true },
  ];
  async function unlockStock(box, pass) {
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), subtle = crypto.subtle;
    const base = await subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(box.salt), iterations: Number(box.iter) }, base, 512));
    const iv = b64(box.iv), ct = b64(box.ct), mac = b64(box.mac);
    const macKey = await subtle.importKey('raw', bits.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
    if (!(await subtle.verify('HMAC', macKey, mac, signed))) throw new Error('서버에 저장된 재고 앱 암호가 맞지 않습니다. 관리자가 [핸썬 관리 > 재고 확인 암호 등록]을 다시 해 주세요.');
    const encKey = await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt']);
    return subtle.decrypt({ name: 'AES-CBC', iv }, encKey, ct);
  }
  // 재고현황 엑셀 → 품목코드별 가용(반입재 + 상용재고)과 반재
  function parseStock(wb) {
    const name = wb.SheetNames.find((n) => /재고/.test(n)) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const h = rows.slice(0, 10).findIndex((r) => (r || []).map(txt).includes('품목코드'));
    if (h < 0) throw new Error('재고 파일에서 품목코드 머리글을 찾지 못했습니다.');
    const hd = rows[h].map(txt), col = (n) => hd.indexOf(n);
    const C = { code: col('품목코드'), inQ: col('반입재'), defQ: col('반재'), regQ: col('상용재고'), qty: col('재고수량') };
    const num = (r, i) => (i >= 0 ? toNum(r[i]) || 0 : 0);
    const map = new Map();
    rows.slice(h + 1).forEach((r) => {
      const code = txt((r || [])[C.code]);
      if (!code || /합계/.test(code)) return;
      const hasSplit = C.inQ >= 0 || C.regQ >= 0;
      map.set(code, { avail: hasSplit ? num(r, C.inQ) + num(r, C.regQ) : num(r, C.qty), defQ: num(r, C.defQ) });
    });
    return map;
  }
  let stockLoading = null;
  // 10분 안에 불러온 재고는 다시 쓰고, 그보다 오래되면 새로 불러옴
  function ensureStock(force) {
    if (state.stock && state.stock.map && !force && Date.now() - state.stock.at < 600000) return Promise.resolve(state.stock);
    if (!stockLoading) stockLoading = (async () => {
      try {
        if (!window.XLSX) throw new Error('엑셀 읽기 도구를 아직 불러오지 못했습니다.');
        const { pass } = await api('stockKey');
        let box = null;
        for (const s of STOCK_SOURCES) {
          try { const r = await fetch(s.bust ? s.url + '?t=' + Date.now() : s.url, { cache: 'no-store', headers: s.headers || {} }); if (r.ok) { box = await r.json(); break; } } catch {}
        }
        if (!box) throw new Error('재고 파일을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
        const buf = await unlockStock(box, pass);
        state.stock = { map: parseStock(XLSX.read(new Uint8Array(buf), { type: 'array' })), time: box.time || '', at: Date.now() };
      } catch (e) {
        state.stock = { error: e.message || '재고를 불러오지 못했습니다.', at: Date.now() };
      } finally { stockLoading = null; }
      return state.stock;
    })();
    return stockLoading;
  }

  const erpText = (code) => { const it = state.cat && state.cat.byCode.get(code); return it ? it.full : ''; };

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
    let catErr = '';
    await ensureCatalog().catch((e) => { catErr = e.message; });
    let ci = 0;
    const draw = () => {
      const c = cands[ci];
      if (!c.erp) c.erp = c.items.map(matchErp);
      box.replaceChildren(el('h2', null, '엑셀로 품목 올리기'), el('div', 'fname', file.name));
      if (cands.length > 1) {
        const sel = el('select'); sel.setAttribute('aria-label', '읽을 시트');
        cands.forEach((cd, i) => { const o = new Option(`${cd.sheet} 시트 (품목 ${cd.items.length}개)`, String(i)); o.selected = i === ci; sel.append(o); });
        sel.onchange = () => { ci = +sel.value; draw(); };
        box.append(sel);
      }
      const maps = el('div', 'maps');
      HEADS.forEach(([k, name, , optional]) => { if (c.col[k] != null) maps.append(el('span', null, `${name} ← ${c.label[k]}`)); else if (!optional) maps.append(el('span', 'miss', `${name} 열 없음`)); });
      box.append(maps);
      const sumQ = c.items.reduce((s, it) => s + it.qty, 0), sumA = c.items.reduce((s, it) => s + it.amount, 0);
      box.append(el('p', 'note', `${c.sheet} 시트 ${c.row}행 머리글 · 품목 ${fmt(c.items.length)}개 · 수량 합계 ${fmt(sumQ)}` + (sumA ? ` · 금액 합계 ${won(sumA)}` : '')));
      const nDict = c.erp.filter((m) => m.state === 'dict').length, nGuess = c.erp.filter((m) => m.state === 'guess').length;
      box.append(el('p', catErr ? 'err' : 'note', catErr ? `ERP 품목코드는 붙이지 못했습니다 (${catErr}). 품목은 그대로 올릴 수 있습니다.`
        : `ERP 품목코드: 사전으로 붙임 ${fmt(nDict)} · 추정 ${fmt(nGuess)} · 못 찾음 ${fmt(c.items.length - nDict - nGuess)}. 추정과 못 찾은 품목은 올린 뒤 품목마다 확인할 수 있습니다.`));
      const prev = el('div', 'prev');
      c.items.forEach((it, i) => {
        const r = el('div', 'pi');
        const nm = el('div'); nm.append(el('div', 'nm', it.name || '(제품명 없음)')); if (it.model) nm.append(el('div', 'model', it.model));
        const m = c.erp[i];
        if (!catErr) {
          const e = el('div', 'erp');
          if (m.code) e.append(el('span', 'code', m.code), document.createTextNode(' ' + erpText(m.code) + ' '), el('span', 'pill e-' + m.state, ERP_LABEL[m.state]));
          else e.append(el('span', 'muted', m.cands.length ? `품목코드 후보 ${m.cands.length}개` : '품목코드 못 찾음'));
          nm.append(e);
        }
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
          const items = c.items.map((it, i) => Object.assign({}, it, { erpCode: c.erp[i].code, erpState: c.erp[i].state }));
          state.detail = await api('uploadHardware', { projectId: state.detail.project.id, items, mode });
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
      await loadScript('dev/mock-gas.js'); await loadScript('apps-script/Seed.js').catch(() => {}); await loadScript('apps-script/Code.js');
      window.__mockReady();
    } else if (!CFG.API_URL) {
      app.replaceChildren(el('p', 'banner bad', '아직 서버 주소가 설정되지 않았습니다. 관리자에게 알려 주세요.'));
      return;
    }
    route();
  })();
})();
