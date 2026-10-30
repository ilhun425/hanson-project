/* 카톡 발주 내역 가져오기 — 단체카톡방 대화 내보내기(txt)에서 발주·재고출고·납품·신규 프로젝트를 찾아 '카톡 확인 대기'로 보여 줌
 * 화면이 txt를 읽어 메시지로 나누고(전화번호·계좌번호는 지움) 올리면, 여기서 중복을 거르고 저장한 뒤
 * 규칙으로 문장을 해석합니다 (유료 API를 쓰지 않음). 사람이 화면에서 [맞음]을 눌러야만 발주·납품 시트에 기록됩니다. */

const KAKAO_KINDS = ['발주', '재고출고', '납품', '신규프로젝트'];
// 해석할 만한 메시지 (발주·출고·수량 표현). 나머지는 '해석 안 함'으로 두고, 현장명을 찾을 때 앞뒤 문맥으로만 씀
const KAKAO_HINT = /발주|오더|출고|입고|납품|발송|배송|택배|신규|재고|정정|추가|취소|반품|회수|구매|세트|\d\s*(개|ea|set|조|본|매|짝|롤|장|ctn|박스|m\b)|\bX\)/i;

/* ---------------- 메시지 올리기 ---------------- */

function kakaoKey(m) {
  const s = [m.date, m.time, m.sender, String(m.text).replace(/\s+/g, ' ').trim()].join('|');
  return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)).slice(0, 32);
}

function kakaoUpload(messages) {
  if (!Array.isArray(messages) || !messages.length) fail('invalid', '올릴 메시지가 없습니다.');
  if (messages.length > 20000) fail('invalid', '메시지가 너무 많습니다. 기간을 나눠서 내보내 주세요.');
  const have = new Set(readAll('kmsg').map((m) => m.key));
  const t = now(), add = [];
  let dup = 0;
  messages.forEach((m) => {
    const msg = { date: clip(m && m.date, 10), time: clip(m && m.time, 5), sender: clip(m && m.sender, 60), text: clip(m && m.text, 4000) };
    if (!isDate(msg.date) || !/^\d\d:\d\d$/.test(msg.time) || !msg.sender || !msg.text) return;
    const key = kakaoKey(msg);
    if (have.has(key)) { dup++; return; }
    have.add(key);
    add.push(Object.assign({ id: newId(), key, state: KAKAO_HINT.test(msg.text) ? '대기' : '해석 안 함', claimedAt: '', uploadedAt: t }, msg));
  });
  if (add.length) appendRows('kmsg', add);
  return { added: add.length, dup, waiting: add.filter((m) => m.state === '대기').length, counts: kakaoCounts() };
}

function kakaoCounts() {
  const c = {};
  readAll('kmsg').forEach((m) => { c[m.state] = (c[m.state] || 0) + 1; });
  return c;
}

// 메시지 상태 칸만 한꺼번에 바꿈
function kakaoSetState(ids, st) {
  if (!ids.length) return;
  const def = SHEETS.kmsg, sh = sheet('kmsg'), n = sh.getLastRow() - 1;
  if (n < 1) return;
  const ci = def.cols.findIndex((c) => c[0] === 'state');
  const idv = sh.getRange(2, 1, n, 1).getValues(), rg = sh.getRange(2, ci + 1, n, 2), cur = rg.getValues();
  const want = new Set(ids.map(String)), t = st === '해석중' ? now() : '';
  idv.forEach((r, i) => { if (want.has(String(r[0]))) { cur[i][0] = st; cur[i][1] = t; } });
  rg.setNumberFormats(cur.map(() => ['@', '@']));
  rg.setValues(cur.map((r) => [String(r[0] == null ? '' : r[0]), String(r[1] == null ? '' : r[1])]));
}

const byWhen = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

/* ---------------- 해석 ---------------- */

// 메시지 size개씩 해석. 화면이 남은 메시지가 없을 때까지 여러 번 부름
function kakaoParse(size) {
  size = Math.min(500, Math.max(5, Number(size) || 300));
  // 1) 해석할 메시지를 '해석중'으로 잡아 둠 (여러 사람이 동시에 눌러도 같은 메시지를 두 번 해석하지 않도록)
  const job = withLock(() => {
    const all = readAll('kmsg').map((m, i) => Object.assign(m, { i })).sort((a, b) => byWhen(a, b) || a.i - b.i);
    const stale = Date.now() - 10 * 60 * 1000;
    const stuck = all.filter((m) => m.state === '해석중' && (!m.claimedAt || new Date(m.claimedAt.replace(' ', 'T') + '+09:00').getTime() < stale));
    stuck.forEach((m) => { m.state = '대기'; });
    kakaoSetState(stuck.map((m) => m.id), '대기');
    const first = all.findIndex((m) => m.state === '대기');
    if (first < 0) return null;
    const targets = [];
    let last = first;
    for (let i = first; i < all.length && targets.length < size; i++) if (all[i].state === '대기') { targets.push(all[i]); last = i; }
    kakaoSetState(targets.map((m) => m.id), '해석중');
    return { targets, window: all.slice(Math.max(0, first - 8), last + 1) };
  });
  if (!job) return { parsed: 0, left: 0, counts: kakaoCounts() };
  const ids = job.targets.map((m) => m.id);
  let entries;
  try { entries = kakaoRules(job); }
  catch (e) { console.error(e && e.stack || e); withLock(() => kakaoSetState(ids, '실패')); fail('parse_failed', '메시지를 해석하다 문제가 생겼습니다. [해석 못 한 메시지 다시 해석]을 눌러 주세요.'); }
  // 2) 결과를 '카톡 확인 대기'에 저장
  const added = withLock(() => { const n = kakaoStore(job, entries); kakaoSetState(ids, '해석함'); return n; });
  const counts = kakaoCounts();
  return { parsed: ids.length, added, left: counts['대기'] || 0, counts };
}

/* ---------------- 규칙으로 해석 ---------------- */
// 비용 없이 규칙만으로 읽음. 형식이 특이한 글은 놓치거나 틀릴 수 있어, 사람이 확인 화면에서 고치고 [맞음]을 누름

// 수량: "8개", "1EA", "2세트", "5개발주"(붙어 쓴 것). 괄호 속 "(재고9개)"처럼 남은 재고 수량은 뺌
const KR_QTY = /(\d+(?:\.\d+)?)\s*(개|ea|세트|set|조|본|매|짝|장|롤|박스|ctn)(?![A-Za-z])/gi;
const KR_NOISE = /(추가\s*)?발주(완료|합니다|건입니다|건)?|오더(\s*완료)?|재고\s*출고|출고|납품(완료|용)?|구매(건)?|입니다|합니다|완료|선불|착불|퀵|택배|화물|발송|직납|부탁드립니다|부탁합니다|\S+님(?=\s|$)/g;
// 현장 후보로 쓰지 않을 줄: 주소, 전화번호, 경로(A>B), 키:값, 운송·결제 안내
const KR_NOT_SITE = /\[(전화번호|번호)\]|[>→]|:|\d+(번길|길|로)\s*\d|[가-힣]+(구|시|군|읍|면)\s+[가-힣]+(동|로|길|리|읍|면)|택배|화물|퀵|발송|오더|발주|출고|납품|입고|예약|계산서|결제|^\*|^-|\?$/;
const KR_MODEL = /[A-Za-z0-9][A-Za-z0-9.\-\/#]*\d[A-Za-z0-9.\-]*/;
const KR_GENERIC = /^(현장|주택|단독주택|기숙사|사옥|오피스|빌딩|센터|병원|호텔|리테일|신축|공사|레지던스|하드웨어)$/;
const KR_SUPPLIERS = ['헤펠레', '큐브텍', '이노', '세한루체', '루체', '금동', '현대정밀', '도무스메탈', '도무스', '스카이하드웨어', '에스엠', '성동', '보성정밀', '코아스', '까마', '범진', '문앤문', '메탈사이트', '메탈싸이트', '남선', '무진금속', '도르마', '스탠리', '게제', '가와준', '얼리젼'];

function kakaoRules(job) {
  const projects = readAll('project');
  // 프로젝트 이름표: 현장명·별칭 전체, 숫자 뺀 이름, 3글자 이상 조각
  const names = [];
  projects.forEach((p) => {
    [p.site].concat(String(p.siteAlias || '').split(',')).map((s) => s.trim()).filter(Boolean).forEach((n) => {
      const k = siteKey(n);
      if (k.length >= 2) names.push({ p, n, k, w: 3 });
      const bare = k.replace(/\d+/g, '');
      if (bare.length >= 3 && bare !== k) names.push({ p, n, k: bare, w: 2 });
      n.split(/[\s,·()\/\-]+/).map(siteKey).filter((x) => x.length >= 3 && !KR_GENERIC.test(x) && x !== k).forEach((x) => names.push({ p, n, k: x, w: 1 }));
    });
  });
  const findProject = (text) => {
    const key = siteKey(text);
    let best = null;
    names.forEach((x) => { if (key.includes(x.k) && (!best || x.w > best.w || (x.w === best.w && x.k.length > best.k.length))) best = x; });
    return best;
  };
  const targetIds = new Set(job.targets.map((t) => t.id));
  const out = [];
  let last = null; // 바로 앞 메시지에서 찾은 현장 (현장명 없이 이어 쓴 글에 씀)
  job.window.forEach((m) => {
    const res = kakaoRuleOne(m, findProject, job.window);
    if (res.site) last = { site: res.site, projectId: res.projectId, at: m.date + m.time, date: m.date, mins: kakaoMins(m.time) };
    if (!targetIds.has(m.id)) return;
    res.entries.forEach((e) => {
      if (!e.site && e.kind !== '신규프로젝트' && last && last.date === m.date && kakaoMins(m.time) - last.mins <= 60 && last.site) {
        e.site = last.site; e.projectId = last.projectId; e.note = clip(('현장명이 없어 바로 앞 메시지의 현장으로 추정했습니다. ' + e.note).trim(), 500);
      }
      out.push(Object.assign({ msg: m.id }, e));
    });
  });
  return out;
}
const kakaoMins = (t) => { const a = String(t).split(':'); return Number(a[0]) * 60 + Number(a[1]); };

// 메시지 하나 → { site, projectId, entries }
function kakaoRuleOne(m, findProject, win) {
  const text = String(m.text), lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const none = { site: '', projectId: '', entries: [] };
  if (!lines.length) return none;
  const base = { kind: '', date: m.date, site: '', projectId: '', supplier: '', designer: '', builder: '', purpose: '', dest: '', items: [], newProject: null, corrects: null, note: '' };
  // 신규 프로젝트
  if (/신규\s*(프로젝트|현장)/.test(text)) {
    const at = lines.findIndex((l) => /신규\s*(프로젝트|현장)/.test(l));
    const np = kakaoNewProject(lines.slice(at + 1), lines[at]);
    if (np.site || np.designer || np.amount) {
      const hit = np.site ? findProject(np.site) : null;
      return { site: np.site, projectId: hit ? hit.p.id : '', entries: [Object.assign({}, base, { kind: '신규프로젝트', site: np.site, designer: np.designer, builder: np.builder, newProject: np })] };
    }
    return none;
  }
  if (/계산서|결제\s*\d+\s*건|거래명세서/.test(text) || (lines.length === 1 && /\?\s*$/.test(text))) return none;
  // 날짜: "(10/1일 라브르27 납품)"
  let date = m.date, dsite = '';
  const dm = /(\d{1,2})\s*\/\s*(\d{1,2})\s*일?\s*([^()\n]*?)\s*(납품|출고|발주)/.exec(text);
  if (dm) {
    const d = m.date.slice(0, 4) + '-' + String(dm[1]).padStart(2, '0') + '-' + String(dm[2]).padStart(2, '0');
    if (isDate(d)) date = d;
    dsite = dm[3].replace(/^HW\w+_/, '').trim();
  }
  // 정정: "A 1개 (B 1개 X)"
  let corrects = null, body = text;
  const cm = /\(([^()]*?)\s*[Xx×]\s*\)/.exec(text);
  if (cm) {
    const wrong = (cm[1].match(/[A-Za-z0-9][A-Za-z0-9.\-\/]*\d[A-Za-z0-9.\-]*/) || [cm[1].replace(KR_QTY, '').trim()])[0];
    const prev = win.filter((x) => (x.date + x.time) <= (m.date + m.time) && x.id !== m.id && wrong && normModel(x.text).includes(normModel(wrong))).pop();
    if (prev) corrects = { msg: prev.id, model: wrong, prevText: prev.text };
    body = text.replace(cm[0], ' ');
  }
  const kindText = corrects ? corrects.prevText + '\n' + body : body;
  const isOrder = /발주|오더|구매/.test(kindText) && !/재고\s*출고|납품\s*완료/.test(kindText);
  const isOut = /납품|출고|입고|발송|배송|퀵|직납/.test(kindText);
  if (!isOrder && !isOut) return none;
  const allStock = /재고\s*출고|재고출고|-\s*재고\s*-/.test(kindText) && !/매입|발주/.test(kindText);
  // 품목 줄
  const items = [];
  body.split('\n').forEach((line) => {
    if (/\d\s*원|만원|부가세|계산서|입금|@|\[번호\]|예약/.test(line)) return;
    const ln = line.replace(/^\s*(?:[-*·•]\s*|\d+[.)]\s+)/, '');
    const hits = [];
    let q;
    KR_QTY.lastIndex = 0;
    while ((q = KR_QTY.exec(ln))) {
      const before = ln.slice(Math.max(0, q.index - 6), q.index);
      if (/(잔여)?재고\s*$/.test(before) || /\((잔여)?재고\s*$/.test(before)) continue;
      hits.push({ i: q.index, end: q.index + q[0].length, qty: Number(q[1]), unit: q[2] });
    }
    hits.forEach((h, j) => {
      let seg = ln.slice(j ? hits[j - 1].end : 0, h.i);
      const after = ln.slice(h.end, j + 1 < hits.length ? hits[j + 1].i : ln.length);
      if (!seg.replace(/[\s\-:,·]/g, '')) seg = after.split(/\s{2,}|[,(]/)[0];
      const stock = allStock || /재고\s*출고|\(\s*재고|재고\s*\+|재고\s*\)|\(재고\)/.test(seg + ' ' + after);
      const isite = /:\s*(.+)$/.exec(after);
      const it = kakaoItem(seg);
      // 괄호 속 모델 (수량 뒤에 적은 "(911.02.145)"도)
      if (!it.model) { const pm = /\(([^()]*)\)/.exec(seg + ' ' + after); const mm = pm && KR_MODEL.exec(pm[1]); if (mm && !/^\d+$/.test(mm[0])) it.model = mm[0]; }
      const sv = isite && isite[1].replace(/\(.*$/, '').trim();
      items.push(Object.assign(it, { qty: h.qty, unit: h.unit, fromStock: !!stock, site: sv && sv.length <= 30 && !/\[/.test(sv) ? sv : '' }));
    });
  });
  const kept = items.filter((x) => x.name || x.model);
  if (!kept.length) return none;
  const kind = isOrder ? '발주' : kept.every((x) => x.fromStock) ? '재고출고' : '납품';
  // 현장: 프로젝트 이름 → 날짜 줄 → 첫 줄(머리) → "OO 현장"
  let site = '', projectId = '';
  const hit = findProject(text);
  if (hit) { site = hit.n; projectId = hit.p.id; }
  else if (dsite) site = dsite;
  else {
    // "현장명 : OO", "현장면-OO" 줄
    const lm = /(?:^|\n)\s*현장\s*(?:명|면)?\s*[-:：]\s*([^\n]+)/.exec(text);
    if (lm) site = kakaoClean(lm[1]);
    // "OO 현장"이라고 쓴 곳이 있으면 같은 줄의 그 앞 낱말 1~2개 (한글이 든 것만)
    const hm = !site && /([가-힣A-Za-z0-9]{2,}(?:[ \t]+[가-힣A-Za-z0-9]{2,})?)[ \t]*현장(?!사무실)/.exec(text.replace(/\d+(?:\.\d+)?\s*(개|ea|세트|set|조|본|매|짝|장|롤|박스|ctn)/gi, ' ').replace(/[^\s]*[>→][^\s]*/g, ' '));
    if (hm && /[가-힣]/.test(hm[1]) && !/^(으로|에|로)$/.test(hm[1])) site = kakaoClean(hm[1]);
    // 아니면 수량·주소·운송 안내가 없는 줄 (보통 첫 줄). "시공사-현장"이면 나눔
    if (!site) for (const l of lines) {
      KR_QTY.lastIndex = 0;
      if (KR_QTY.test(l) || KR_NOT_SITE.test(l) || l.length > 40 || KR_MODEL.test(l.replace(/\d+[-.]\d+$/, ''))) continue;
      const parts = l.split(/\s*[-–]\s*/);
      const two = parts.length === 2 && parts.every((p) => /[가-힣]{2}/.test(p));
      const cand = kakaoClean(two ? parts[1] : l);
      if (cand.length >= 2 && !/^(재고|신규)/.test(cand)) { site = cand; if (two) base.builder = kakaoClean(parts[0]); break; }
    }
  }
  KR_QTY.lastIndex = 0;
  // 매입처: "헤펠레>핸썬", "OO에 발주", 아는 매입처 이름
  // 매입처: "헤펠레>핸썬", "OO에 발주", 아니면 아는 매입처가 하나만 나올 때
  const known = KR_SUPPLIERS.filter((x) => text.includes(x) && !KR_SUPPLIERS.some((y) => y !== x && y.includes(x) && text.includes(y)));
  const supplier = (/([가-힣A-Za-z]+)\s*[>→]/.exec(text) || [])[1] || (/([가-힣A-Za-z]+)에\s*발주/.exec(text) || [])[1] || (known.length === 1 ? known[0] : '');
  const dest = /사무실\s*(입고|배송)|[>→]\s*(핸썬|사무실)|창고\s*입고/.test(text) ? '사무실·창고' : /현장/.test(text) ? '현장' : '';
  const purpose = /샘플/.test(text) ? '샘플' : /하자/.test(text) ? '하자보수' : '';
  const note = [/취소/.test(text) && '취소라는 말이 있습니다. 내용을 확인해 주세요.', cm && !corrects && '정정 표시(X)가 있지만 고친 원래 메시지를 찾지 못했습니다.'].filter(Boolean).join(' ');
  // 품목에 따로 적힌 현장(예: "DB300 5개 : 디아키즈건설 이태원현장")이 있으면 현장마다 나눔
  const groups = new Map();
  kept.forEach((x) => { const s = x.site || ''; (groups.get(s) || groups.set(s, []).get(s)).push(x); });
  // 품목 이름에 섞인 현장명·시공사 이름은 뺌
  const strip = [site, base.builder, hit && hit.n].filter((x) => x && x.length >= 2);
  kept.forEach((x) => { strip.forEach((w) => { x.name = x.name.split(w).join(' '); }); x.name = x.name.replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim(); });
  const entries = [...groups.entries()].map(([s, its]) => {
    const h2 = s ? findProject(s) : null;
    return Object.assign({}, base, { kind, date, site: s ? (h2 ? h2.n : kakaoClean(s)) : site, projectId: s ? (h2 ? h2.p.id : '') : projectId,
      supplier, dest, purpose, note, corrects: corrects ? { msg: corrects.msg, model: corrects.model } : null,
      items: its.map((x) => ({ name: x.name, model: x.model, aka: [], qty: x.qty, unit: x.unit, fromStock: x.fromStock })) });
  });
  return { site, projectId, entries };
}

// 품목 글 → 제품명 / 모델명 (영문·숫자가 섞인 조각을 모델명으로)
function kakaoItem(seg) {
  const s = String(seg).replace(/\([^)]*\)/g, ' ').replace(KR_NOISE, ' ').replace(/[>→].*$/, ' ').replace(/[\s\-:,·]+$|^[\s\-:,·]+/g, '').replace(/\s+/g, ' ').trim();
  const models = [], words = [];
  s.split(' ').forEach((t) => {
    const c = t.replace(/^[\-:,]+|[\-:,]+$/g, '');
    if (!c) return;
    if (/^[A-Za-z0-9][A-Za-z0-9.\-\/#]*$/.test(c) && /\d/.test(c) && c.length >= 3) models.push(c);
    else if (/^\.\d{3}$/.test(c)) models.push(c); // 헤펠레 끝자리만 적은 것 (.320)
    else words.push(c.replace(/-(?=[A-Za-z0-9.]*\d)/, ' ').trim());
  });
  // "레버핸들-900.92.487" 처럼 붙여 쓴 모델
  const name = words.join(' ').replace(/\s+/g, ' ').trim();
  const glued = /^(.*?[가-힣])[-\s]?([A-Za-z0-9][A-Za-z0-9.\-]*\d[A-Za-z0-9.\-]*)$/.exec(name);
  if (glued && !models.length) return { name: glued[1].trim(), model: glued[2] };
  return { name, model: models.join(' ') };
}
const kakaoClean = (s) => clip(String(s || '').replace(/^HW\w+_/, '').replace(/\(.*?\)/g, ' ').replace(KR_NOISE, ' ').replace(/[>→].*$/, ' ').replace(/\s+/g, ' ').replace(/^[\s\-:,]+|[\s\-:,]+$/g, ''), 60);

// 신규 프로젝트 글: "설계사 : 구도" 같은 줄, 또는 현장명 / "간삼건축 - 안해영수석" / "61,000,000" 순서의 줄
function kakaoNewProject(lines, head) {
  const np = { site: '', designer: '', designManager: '', builder: '', clientManager: '', amount: null };
  const rest = [];
  const headRest = String(head || '').replace(/신규\s*(프로젝트|현장)(입니다)?/, '').replace(/^[\s\/:,\-]+/, '').trim();
  if (headRest) rest.push(headRest);
  lines.forEach((l) => {
    const kv = /^(.+?)\s*[:：]\s*(.+)$/.exec(l);
    if (kv) {
      const k = kv[1].replace(/\s/g, ''), v = kv[2].trim();
      if (/현장/.test(k)) np.site = v;
      else if (/설계/.test(k)) np.designer = v;
      else if (/담당/.test(k)) np.designManager = v;
      else if (/발주처|시공|건설/.test(k)) np.builder = v;
      else if (/금액|예산/.test(k)) np.amount = Number(v.replace(/[^\d]/g, '')) || null;
      return;
    }
    rest.push(l);
  });
  rest.forEach((l) => {
    const digits = l.replace(/[,\s원]/g, '');
    if (/^\d{5,}$/.test(digits)) { if (np.amount == null) np.amount = Number(digits); return; }
    const dash = /^(.+?)\s*[-–]\s*(.+)$/.exec(l);
    if (dash && !np.designer) { np.designer = dash[1].trim(); np.designManager = np.designManager || dash[2].trim(); return; }
    if (!np.site) np.site = l;
  });
  ['site', 'designer', 'designManager', 'builder', 'clientManager'].forEach((k) => { np[k] = clip(np[k], 100); });
  return np;
}

// 해석 결과 → '카톡 확인 대기' 행. 정정 메시지는 아직 확인 전인 원래 건을 '정정됨'으로 돌림
function kakaoStore(job, entries) {
  const msgs = new Map(job.window.map((x) => [x.id, x]));
  const projects = new Set(readAll('project').map((p) => p.id));
  const t = now(), rows = [];
  const old = readAll('kitem'), touched = [], fixes = [];
  entries.forEach((e) => {
    const from = rows.length;
    const msg = msgs.get(e.msg);
    const date = isDate(e.date) ? e.date : msg.date;
    const base = { msgId: msg.id, kind: KAKAO_KINDS.includes(e.kind) ? e.kind : '납품', date, site: clip(e.site), projectId: projects.has(e.projectId) ? e.projectId : '',
      supplier: clip(e.supplier, 60), designer: clip(e.designer), builder: clip(e.builder), dest: clip(e.dest, 20), purpose: clip(e.purpose, 20),
      corrects: e.corrects ? e.corrects.msg + '|' + clip(e.corrects.model, 100) : '', newProject: '', note: clip(e.note, 500), status: '대기',
      hwId: '', recKind: '', recId: '', doneAt: '', createdAt: t };
    if (e.corrects) fixes.push({ e, rows: () => rows.slice(from, from + (e.items || []).length || 1) });
    if (base.kind === '신규프로젝트') {
      const np = e.newProject || {};
      rows.push(Object.assign({}, base, { id: newId(), site: clip(np.site || e.site), newProject: JSON.stringify({ site: clip(np.site || e.site), designer: clip(np.designer || e.designer),
        designManager: clip(np.designManager), builder: clip(np.builder || e.builder), clientManager: clip(np.clientManager), amount: Number(np.amount) || 0 }),
        name: '', model: '', aka: '', qty: '', unit: '', fromStock: '' }));
      return;
    }
    const items = (e.items || []).length ? e.items : [{ name: '', model: '', aka: [], qty: null, unit: '', fromStock: e.kind === '재고출고' }];
    items.forEach((it) => rows.push(Object.assign({}, base, { id: newId(), name: clip(it.name), model: clip(it.model), aka: (it.aka || []).map((a) => clip(a, 100)).join(' | '),
      qty: it.qty == null || !isFinite(Number(it.qty)) ? '' : String(Number(it.qty)), unit: clip(it.unit, 20), fromStock: it.fromStock || base.kind === '재고출고' ? 'Y' : '' })));
  });
  // 정정: 고쳐진 원래 건이 아직 확인 전이면 '정정됨'으로 (같은 묶음에서 방금 만든 건도 포함). 이미 기록했으면 정정 건에 알림을 붙임
  fixes.forEach(({ e, rows: mine }) => {
    const wrong = normModel(e.corrects.model);
    if (!wrong) return;
    const hit = (k) => k.msgId === e.corrects.msg && (normModel(k.model) === wrong || normModel(k.name).includes(wrong));
    old.filter(hit).concat(rows.filter(hit)).forEach((k) => {
      if (k.status === '대기') { k.status = '정정됨'; k.note = clip(('뒤 메시지에서 정정됨. ' + k.note).trim(), 500); k.doneAt = t; if (old.includes(k)) touched.push(k); }
      else if (k.status === '확인') mine().forEach((r) => { r.note = clip(('이미 기록한 "' + (k.model || k.name) + '"을(를) 고치는 메시지입니다. 그 기록을 지울지 확인해 주세요. ' + r.note).trim(), 500); });
    });
  });
  touched.forEach((k) => writeRows('kitem', rowIndexOf('kitem', k.id), [k]));
  if (rows.length) appendRows('kitem', rows);
  return rows.length;
}

// 해석에 실패한 메시지를 다시 '대기'로
function kakaoRetry() {
  kakaoSetState(readAll('kmsg').filter((m) => m.state === '실패').map((m) => m.id), '대기');
  return { counts: kakaoCounts() };
}

/* ---------------- 확인 화면 ---------------- */

// 확인 화면에 필요한 것: 확인 대기 건, 원문, 프로젝트·품목·기록 (매칭과 '이미 있는 기록' 비교용)
function kakaoList() {
  const all = readAll('kitem');
  const wait = all.filter((k) => k.status === '대기'), rest = all.filter((k) => k.status !== '대기').slice(-300);
  const items = wait.concat(rest);
  const need = new Set(items.map((k) => k.msgId));
  const msgs = {};
  readAll('kmsg').forEach((m) => { if (need.has(m.id)) msgs[m.id] = { date: m.date, time: m.time, sender: m.sender, text: m.text }; });
  const pick = (o, ks) => ks.reduce((r, k) => { r[k] = o[k]; return r; }, {});
  return {
    items, msgs, counts: kakaoCounts(), statuses: statuses(),
    projects: readAll('project').map((p) => pick(p, ['id', 'site', 'siteAlias', 'status', 'designer', 'builder', 'hansonManager'])),
    hw: readAll('hw').map((h) => pick(h, ['id', 'projectId', 'seq', 'name', 'model', 'unit', 'qty', 'maker', 'erpCode', 'erpState', 'stockConv'])),
    records: readAll('order').map((r) => Object.assign(pick(r, ['id', 'hwId', 'date', 'qty', 'source', 'fromStock', 'kakaoId']), { kind: 'order' }))
      .concat(readAll('delivery').map((r) => Object.assign(pick(r, ['id', 'hwId', 'date', 'qty', 'source', 'fromStock', 'kakaoId']), { kind: 'delivery' }))),
  };
}

// 확인 대기 한 건 처리. do: confirm(맞음) / same(이미 있는 기록과 같음) / skip(건너뛰기) / reopen(되돌리기)
function kakaoDone(id, act, data) {
  const row = rowIndexOf('kitem', id);
  if (row < 0) fail('not_found', '확인할 건을 찾지 못했습니다. 다른 사람이 처리했을 수 있습니다.');
  const k = readAll('kitem').find((x) => x.id === String(id));
  const t = now();
  if (act === 'reopen') {
    if (k.status !== '건너뜀') fail('invalid', '건너뛴 건만 되돌릴 수 있습니다.');
    Object.assign(k, { status: '대기', doneAt: '' });
  } else {
    if (k.status !== '대기') fail('conflict', '이미 처리된 건입니다. 화면을 새로 불러와 주세요.');
    if (act === 'skip') Object.assign(k, { status: '건너뜀', doneAt: t });
    else if (act === 'same') Object.assign(k, { status: '확인', recId: clip(data.recId, 40), note: clip(('이미 있던 기록과 같음. ' + k.note).trim(), 500), doneAt: t });
    else if (act === 'confirm') {
      const p = readAll('project').find((x) => x.id === String(data.projectId || ''));
      if (!p) fail('invalid', '프로젝트를 골라 주세요.');
      k.projectId = p.id;
      if (k.kind !== '신규프로젝트') {
        const it = readAll('hw').find((h) => h.id === String(data.hwId || ''));
        if (!it || it.projectId !== p.id) fail('invalid', '이 프로젝트의 품목을 골라 주세요.');
        const recKind = data.recKind === 'order' ? 'order' : 'delivery';
        const msg = readAll('kmsg').find((m) => m.id === k.msgId) || {};
        const rec = addRecordRow(recKind, it.id, data.date, data.qty, { source: ['카톡', msg.date, msg.time, msg.sender].filter(Boolean).join(' '), fromStock: recKind === 'delivery' && data.fromStock, kakaoId: k.id });
        Object.assign(k, { hwId: it.id, recKind, recId: rec.id });
        if (data.dictPair && data.dictPair.code && data.dictPair.alias) addAliases([{ code: data.dictPair.code, alias: data.dictPair.alias, quoteName: k.name, source: '카톡 / ' + p.site }], '카톡 확인');
      }
      if (data.remember) kakaoAddSiteAlias(p, k.site);
      Object.assign(k, { status: '확인', doneAt: t });
    } else fail('bad_request', '알 수 없는 처리입니다.');
  }
  writeRows('kitem', row, [k]);
  return kakaoList();
}

// 카톡에 적힌 현장명을 프로젝트의 현장 별칭으로 쌓음 (띄어쓰기만 다른 것은 같은 이름으로 봄)
const siteKey = (s) => String(s || '').replace(/[\s()\[\]·,.\-]/g, '').toUpperCase();
function kakaoAddSiteAlias(p, name) {
  name = clip(name, 60);
  if (!name) return;
  const list = String(p.siteAlias || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (siteKey(name) === siteKey(p.site) || list.some((a) => siteKey(a) === siteKey(name))) return;
  list.push(name);
  p.siteAlias = clip(list.join(', '), 500);
  writeRows('project', rowIndexOf('project', p.id), [p]);
}
