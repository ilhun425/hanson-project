/* 카톡 발주 내역 가져오기 — 단체카톡방 대화 내보내기(txt)에서 발주·재고출고·납품·신규 프로젝트를 찾아 '카톡 확인 대기'로 보여 줌
 * 화면이 txt를 읽어 메시지로 나누고(전화번호·계좌번호는 지움) 올리면, 여기서 중복을 거르고 저장한 뒤
 * Claude API로 문장을 해석합니다. 사람이 화면에서 [맞음]을 눌러야만 발주·납품 시트에 기록됩니다.
 * Claude API 키는 스프레드시트 메뉴 [핸썬 관리 > 카톡 해석용 Claude API 키 등록]으로 스크립트 속성에만 저장합니다. */

const KAKAO_MODEL = 'claude-opus-5-5';
const KAKAO_KINDS = ['발주', '재고출고', '납품', '신규프로젝트'];
// 해석할 만한 메시지 (발주·출고·수량 표현). 나머지는 '해석 안 함'으로 두고, 앞뒤 문맥으로만 Claude에 보여 줌
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

/* ---------------- Claude로 해석 ---------------- */

// 메시지 size개씩 해석. 화면이 남은 메시지가 없을 때까지 여러 번 부름
function kakaoParse(size) {
  size = Math.min(40, Math.max(5, Number(size) || 25));
  const apiKey = props().getProperty('CLAUDE_API_KEY');
  if (!apiKey) fail('no_api_key', '카톡 해석용 Claude API 키가 아직 없습니다. 관리자가 스프레드시트 메뉴 [핸썬 관리 > 카톡 해석용 Claude API 키 등록]을 해 주세요.');
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
  try { entries = kakaoAsk(apiKey, job); }
  catch (e) {
    withLock(() => kakaoSetState(ids, e.code === 'ai_failed' ? '실패' : '대기'));
    throw e;
  }
  // 2) 결과를 '카톡 확인 대기'에 저장
  const added = withLock(() => { const n = kakaoStore(job, entries); kakaoSetState(ids, '해석함'); return n; });
  const counts = kakaoCounts();
  return { parsed: ids.length, added, left: counts['대기'] || 0, counts };
}

const KAKAO_PROMPT = `당신은 도어 하드웨어 유통 회사 핸썬(Hanson)의 업무 기록 담당입니다.
회사 단체카톡방 메시지에서 하드웨어 발주, 재고출고, 납품, 신규 프로젝트 소식을 찾아 JSON으로 정리합니다.
사람이 나중에 하나씩 확인하므로, 확실하지 않은 것도 찾아서 note에 의문점을 적어 주세요. 다만 없는 내용을 지어내지는 마세요.

종류(kind):
- 발주: 핸썬이 매입처(제조사·대리점)에 물건을 주문함. "발주완료", "오더완료", "OO에 발주", "추가발주". supplier에 매입처(예: 헤펠레, 큐브텍, 이노, 세한루체, 금동, 현대정밀).
- 재고출고: 핸썬이 가진 재고에서 꺼내 현장이나 고객에게 보냄. "재고출고", "(재고)", "재고 + ..." 등. 품목마다 fromStock=true.
- 납품: 물건이 현장이나 고객에게 감. "납품", "납품완료", "현장 출고", "퀵출고", "OO 매입분 출고". 핸썬 재고에서 나간 품목은 fromStock=true, 매입해서 바로 보낸 품목은 false.
  한 메시지에 재고출고 품목과 매입분 품목이 섞여 있으면 kind는 납품으로 하고 품목마다 fromStock을 구분하세요.
  다른 회사(매입처)의 재고에서 나간 것("무진금속 재고 출고")은 핸썬 재고가 아니므로 fromStock=false.
- 신규프로젝트: "신규 프로젝트", "신규현장" 소식. newProject에 현장명, 설계사, 설계담당자, 시공사(발주처), 시공담당자, 금액(원).
결제 요청, 계산서, 입금, 차량, 인사, 일정 같은 메시지는 건너뜁니다. 단순 사진 설명이나 주소도 건너뜁니다.

규칙:
- date: 일이 일어난 날. 본문에 "(10/1일 라브르27 납품)"처럼 날짜가 있으면 그 날짜(연도는 메시지 날짜의 연도), 없으면 메시지 날짜. YYYY-MM-DD.
- site: 본문에 적힌 현장명 그대로 (예: "라브르27", "현대차 납양기숙사"). 회사명만 있고 현장이 없으면 빈 문자열.
- projectId: 프로젝트 목록 중 같은 현장이 분명하면 그 id. 오타·줄임말·띄어쓰기 차이("현대차 납양기숙사" = "현대차 남양 기숙사", "라브르" = "두양 라브르")도 같은 현장으로 봅니다. 애매하면 빈 문자열.
- items: 품목마다 하나. name은 적힌 제품명(예: "엔터 모티스락", "키뭉치"), model은 적힌 모델·코드(예: "SGM55AL24CN", "911.02.145", "pck67") 그대로.
  aka에는 같은 제품을 가리키는 다른 표기를 확실할 때만 적습니다 (예: "텍투스340" → "TECTUS TE340", "플로어힌지 .320" → "932.79.320", "액티브스탑" → "ACTIVE STOP").
  헤펠레 8자리 코드(000.00.000)는 숫자 하나만 달라도 다른 제품이니 추측해서 바꾸지 마세요.
  qty는 숫자(모르면 null). unit은 적힌 단위(개, 세트, EA 등).
- 한 메시지에 현장이 여러 개면 현장마다 entry를 나눕니다.
- 같은 내용이 품목 목록 메시지와 그 뒤의 정리 메시지에 두 번 나오면, 더 자세한 쪽 하나만 entry로 만듭니다 (msg는 그 메시지).
- 정정: "A 1개 (B 1개 X)"처럼 앞에서 말한 품목·수량을 고치는 메시지는, 고친 내용으로 entry를 만들고 corrects에 고쳐진 원래 메시지(msg)와 틀렸던 모델명(model)을 적습니다.
- purpose: 샘플 제출용이면 "샘플", 하자보수용이면 "하자보수", 아니면 빈 문자열.
- dest: 보내는 곳이 현장이면 "현장", "사무실입고"·"핸썬 택배"처럼 사무실·창고면 "사무실·창고", 모르면 빈 문자열.
- msg에는 아래 '해석할 메시지'의 번호(m1, m2 …)만 씁니다. '앞뒤 문맥' 메시지(c1, c2 …)는 참고만 하고 entry로 만들지 않습니다 (정정 대상 corrects.msg로는 쓸 수 있음).
- 해당하는 메시지가 없으면 entries를 빈 배열로 둡니다.`;

const KAKAO_SCHEMA = (() => {
  const S = { type: 'string' }, N = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
  const item = obj({ name: S, model: S, aka: { type: 'array', items: S }, qty: N, unit: S, fromStock: { type: 'boolean' } });
  const np = obj({ site: S, designer: S, designManager: S, builder: S, clientManager: S, amount: N });
  const entry = obj({
    msg: S, kind: { type: 'string', enum: KAKAO_KINDS }, date: S, site: S, projectId: S, supplier: S, designer: S, builder: S,
    purpose: { type: 'string', enum: ['', '샘플', '하자보수'] }, dest: { type: 'string', enum: ['', '현장', '사무실·창고'] },
    items: { type: 'array', items: item },
    newProject: { anyOf: [np, { type: 'null' }] },
    corrects: { anyOf: [obj({ msg: S, model: S }), { type: 'null' }] },
    note: S,
  });
  return obj({ entries: { type: 'array', items: entry } });
})();

function kakaoAsk(apiKey, job) {
  const labels = new Map(), back = new Map();
  let m = 0, c = 0;
  const targetIds = new Set(job.targets.map((t) => t.id));
  job.window.forEach((x) => { const l = targetIds.has(x.id) ? 'm' + (++m) : 'c' + (++c); labels.set(x.id, l); back.set(l, x.id); });
  const line = (x) => `[${labels.get(x.id)}] ${x.date} ${x.time} ${x.sender}: ${x.text}`;
  const ctx = job.window.filter((x) => !targetIds.has(x.id));
  const user = (ctx.length ? '앞뒤 문맥 (참고만):\n' + ctx.map(line).join('\n') + '\n\n' : '') +
    '해석할 메시지:\n' + job.targets.map(line).join('\n');
  const projects = readAll('project').map((p) => [p.id, p.site, p.siteAlias, p.designer, p.builder, p.status].join(' | ')).join('\n');
  const body = {
    model: KAKAO_MODEL, max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: KAKAO_SCHEMA } },
    system: [{ type: 'text', text: KAKAO_PROMPT }, { type: 'text', text: '프로젝트 목록 (id | 현장명 | 현장 별칭 | 설계사 | 시공사 | 현 상황):\n' + (projects || '(아직 없음)') }],
    messages: [{ role: 'user', content: user }],
  };
  // 안전 분류기가 거절하면 서버에서 다른 모델로 다시 시도 (fallbacks). 이 옵션을 받지 않으면 빼고 한 번 더
  let res = kakaoFetch(apiKey, Object.assign({ fallbacks: 'default', cache_control: { type: 'ephemeral' } }, body), 'server-side-fallback-2026-07-01');
  if (res.code === 400) res = kakaoFetch(apiKey, body, '');
  if (res.code === 401 || res.code === 403) fail('ai_key', 'Claude API 키가 맞지 않습니다. 관리자가 [핸썬 관리 > 카톡 해석용 Claude API 키 등록]을 다시 해 주세요.');
  if (res.code === 429 || res.code >= 500) fail('ai_busy', 'Claude 서버가 바쁩니다. 잠시 뒤 [해석 이어 하기]를 눌러 주세요.');
  if (res.code !== 200) {
    console.error(res.text);
    let why = ''; try { why = JSON.parse(res.text).error.message || ''; } catch (e) {}
    fail('ai_error', 'Claude API 요청이 거절되었습니다 (' + res.code + (why ? ': ' + clip(why, 160) : '') + '). 관리자에게 알려 주세요.');
  }
  const out = JSON.parse(res.text);
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (out.stop_reason === 'refusal' || out.stop_reason === 'max_tokens' || !text) fail('ai_failed', '이 메시지들은 해석하지 못했습니다. [해석 못 한 메시지 다시 해석]으로 다시 시도할 수 있습니다.');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { fail('ai_failed', '해석 결과를 읽지 못했습니다.'); }
  return (parsed.entries || []).map((e) => Object.assign(e, { msg: back.get(e.msg) || '', corrects: e.corrects && back.get(e.corrects.msg) ? { msg: back.get(e.corrects.msg), model: e.corrects.model } : null }))
    .filter((e) => targetIds.has(e.msg));
}

function kakaoFetch(apiKey, body, beta) {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' };
  if (beta) headers['anthropic-beta'] = beta;
  let r;
  try { r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', { method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true }); }
  catch (e) { console.error(e); fail('ai_busy', 'Claude 서버에서 답이 늦습니다. 잠시 뒤 [해석 이어 하기]를 눌러 주세요.'); }
  return { code: r.getResponseCode(), text: r.getContentText() };
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

/* ---------------- 관리자 메뉴 ---------------- */

function setClaudeKeyPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('카톡 해석용 Claude API 키 등록', 'Anthropic 콘솔(console.anthropic.com)에서 만든 API 키(sk-ant-로 시작)를 붙여 넣어 주세요. 키는 이 스크립트의 속성에만 저장되고 화면으로는 보내지 않습니다. 비워 두고 확인을 누르면 키를 지웁니다.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!key) { props().deleteProperty('CLAUDE_API_KEY'); ui.alert('Claude API 키를 지웠습니다.'); return; }
  if (!/^sk-ant-/.test(key)) { ui.alert('sk-ant-로 시작하는 API 키가 아닙니다. 다시 확인해 주세요.'); return; }
  props().setProperty('CLAUDE_API_KEY', key);
  ui.alert('Claude API 키를 저장했습니다.');
}
