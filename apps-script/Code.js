/* 핸썬 프로젝트 관리 — 구글 스프레드시트를 저장소로 쓰는 Apps Script 웹 앱 (API)
 * 화면(GitHub Pages)이 text/plain POST로 {action, token, ...}을 보내고 JSON을 받습니다.
 * 공동 비밀번호는 스프레드시트 메뉴 [핸썬 관리 > 공동 비밀번호 정하기]로 정하며, 해시만 Script Properties에 저장합니다. */

// 현 상황 선택지. 바꾸려면 이 줄을 고치거나, 프로젝트 설정 > 스크립트 속성에 STATUSES 를 '영업중,견적,…' 처럼 넣으면 됩니다.
const STATUSES_DEFAULT = ['영업중', '설계', '견적', '수주', '진행중', '준공', '보류'];

const TOKEN_DAYS = 30;          // 로그인 유지 기간
const MAX_FAILS = 5;            // 이 횟수만큼 틀리면
const FAIL_WINDOW_S = 600;      // (10분 안에)
const LOCK_S = 600;             // 10분 동안 잠금
const HASH_ROUNDS = 300;

const SHEETS = {
  project: { name: '프로젝트', cols: [
    ['id', 'id'], ['status', '현상황'], ['site', '현장명'], ['designer', '설계사'], ['builder', '시공사'],
    ['clientManager', '시공담당자'], ['hansonManager', '핸썬담당자'], ['dueDate', '준공예정일'], ['total', '총금액', 'num'],
    ['createdAt', '등록일시'], ['updatedAt', '수정일시'], ['designManager', '설계담당자'], ['deliveryDate', '납품예정일'], ['siteAlias', '현장별칭']] },
  hw: { name: '하드웨어', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['seq', '순번'], ['name', '제품명'], ['model', '모델명'], ['unit', '단위'],
    ['qty', '수량', 'num'], ['amount', '금액', 'num'], ['createdAt', '등록일시'],
    ['maker', '매입처'], ['erpCode', 'ERP품목코드'], ['erpState', '품목코드상태'],
    ['memo', '적요'], ['stockManual', '재고수기'], ['stockManualAt', '재고수기일시'], ['stockConv', '재고전환', 'num']] },
  // 출처: 카톡에서 확인한 기록이면 '카톡 날짜 시각 보낸 사람'. 재고에서: 핸썬 재고에서 나간 납품이면 Y
  order: { name: '발주', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['hwId', '하드웨어id'], ['date', '날짜'], ['qty', '수량', 'num'], ['createdAt', '등록일시'],
    ['source', '출처'], ['fromStock', '재고에서'], ['kakaoId', '카톡확인id']] },
  delivery: { name: '납품', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['hwId', '하드웨어id'], ['date', '날짜'], ['qty', '수량', 'num'], ['createdAt', '등록일시'],
    ['source', '출처'], ['fromStock', '재고에서'], ['kakaoId', '카톡확인id']] },
  // 카톡 대화 내보내기에서 읽은 메시지 (전화번호·계좌번호는 화면에서 지우고 올림). 상태: 대기 / 해석중 / 해석함 / 해석 안 함 / 실패
  kmsg: { name: '카톡 메시지', cols: [
    ['id', 'id'], ['key', '중복확인'], ['date', '날짜'], ['time', '시각'], ['sender', '보낸 사람'], ['text', '내용'], ['state', '상태'],
    ['claimedAt', '해석시작'], ['uploadedAt', '올린 일시']] },
  // 메시지에서 뽑은 발주·출고·납품·신규 프로젝트 한 건씩. 사람이 [맞음]을 눌러야 발주·납품 시트에 기록됨
  kitem: { name: '카톡 확인 대기', cols: [
    ['id', 'id'], ['msgId', '메시지id'], ['kind', '종류'], ['date', '날짜'], ['site', '현장 (카톡)'], ['projectId', '프로젝트id'],
    ['supplier', '매입처'], ['designer', '설계사'], ['builder', '시공사'], ['name', '제품명 (카톡)'], ['model', '모델명 (카톡)'], ['aka', '다른 이름'],
    ['qty', '수량'], ['unit', '단위'], ['fromStock', '재고에서'], ['dest', '보낸 곳'], ['purpose', '용도'], ['corrects', '정정 대상'],
    ['newProject', '신규 프로젝트'], ['note', '메모'], ['status', '상태'], ['hwId', '하드웨어id'], ['recKind', '기록 종류'], ['recId', '기록id'],
    ['doneAt', '처리 일시'], ['createdAt', '등록일시']] },
  // 품목 별칭 사전: 견적 모델명(별칭) → ERP 품목코드. 프로젝트 관리와 재고 확인이 함께 씀
  alias: { name: '별칭 사전', cols: [
    ['code', '품목코드'], ['erpName', 'ERP 품목명'], ['erpSpec', 'ERP 규격'], ['supplier', '매입처'], ['alias', '별칭 (견적 모델명)'],
    ['quoteName', '견적 품명'], ['rel', '관계'], ['status', '확인 상태'], ['reason', '근거'], ['source', '출처 (견적 시트 / POS)'],
    ['count', '등장 횟수', 'num'], ['others', '같은 규격의 다른 품목코드'], ['addedAt', '등록일시'], ['addedBy', '등록한 곳']] },
  // 이카운트 전체 품목 (매칭할 때 찾아볼 목록)
  item: { name: '전체 품목', cols: [
    ['code', '품목코드'], ['name', '품목명'], ['spec', '규격'], ['unit', '단위'], ['supplier', '매입처'], ['search', '검색창내용']] },
};
const SURE = '확실', UNSURE = '확인 필요';
// 기호 무시 비교 (두 화면과 같은 규칙). 헤펠레 8자리 코드도 숫자는 그대로 남으므로 숫자가 하나라도 다르면 다른 별칭
const normModel = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase().replace(/[\s\-_.·'"`’()\[\]]/g, '');

/* ---------------- 입구 ---------------- */

function doGet() {
  return json({ ok: true, app: 'hanson-project' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad_request', message: '요청을 읽지 못했습니다.' }); }
  try {
    return json(Object.assign({ ok: true }, handle(req || {})));
  } catch (err) {
    if (err && err.code) return json({ ok: false, error: err.code, message: err.message });
    console.error(err && err.stack || err);
    return json({ ok: false, error: 'server', message: '서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
}

function handle(req) {
  if (req.action === 'login') return login(req.password, req.scope, req.auto);
  const scope = checkToken(req.token);
  if (/^(dict|addAlias|catalog|setErp)$/.test(req.action)) ensureSeed();
  // 사전 전용 토큰(재고 확인)은 사전 읽기·추가만 할 수 있음
  switch (req.action) {
    case 'dict': return { aliases: aliasList() };
    case 'addAlias': return withLock(() => ({ added: addAliases(req.pairs, '재고 확인'), aliases: aliasList() }));
  }
  if (scope !== 'full') fail('forbidden', '이 비밀번호로는 할 수 없는 일입니다.');
  switch (req.action) {
    case 'catalog': return { aliases: aliasList(), items: catalogItems() };
    case 'stockKey': {
      const k = props().getProperty('STOCK_PASS');
      if (!k) fail('no_stock_password', '재고 앱 암호가 아직 서버에 없습니다. 관리자가 스프레드시트 메뉴 [핸썬 관리 > 재고 확인 암호 등록]을 한 번 더 해 주세요.');
      return { pass: k };
    }
    case 'setErp': return withLock(() => setErp(req.changes, req.addAlias));
    case 'list': return listProjects();
    case 'project': return getProject(req.id);
    case 'saveProject': return withLock(() => saveProject(req.project || {}));
    case 'deleteProject': return withLock(() => deleteProject(req.id));
    case 'uploadHardware': return withLock(() => uploadHardware(req.projectId, req.items, req.mode));
    case 'addItem': return withLock(() => uploadHardware(req.projectId, [req.item || {}], 'append'));
    case 'updateItem': return withLock(() => updateItem(req.hwId, req.patch || {}));
    case 'deleteItem': return withLock(() => deleteItem(req.hwId));
    case 'addRecord': return withLock(() => addRecord(req.kind, req.hwId, req.date, req.qty));
    case 'deleteRecord': return withLock(() => deleteRecord(req.kind, req.id));
    case 'kakaoUpload': return withLock(() => kakaoUpload(req.messages));
    case 'kakaoParse': return kakaoParse(req.size);
    case 'kakaoList': return kakaoList();
    case 'kakaoDone': return withLock(() => kakaoDone(req.id, req.do, req.data || {}));
    case 'kakaoRetry': return withLock(() => kakaoRetry());
  }
  fail('bad_request', '알 수 없는 요청입니다.');
}

const json = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
function fail(code, message) { const e = new Error(message); e.code = code; throw e; }

// 여러 사람이 동시에 저장해도 한 번에 하나씩만 씀
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail('busy', '다른 사람이 저장하는 중입니다. 잠시 뒤 다시 시도해 주세요.');
  try { const out = fn(); SpreadsheetApp.flush(); return out; } finally { lock.releaseLock(); }
}

/* ---------------- 비밀번호·로그인 ---------------- */

const props = () => PropertiesService.getScriptProperties();

function statuses() {
  const s = String(props().getProperty('STATUSES') || '').split(',').map((x) => x.trim()).filter(Boolean);
  return s.length ? s : STATUSES_DEFAULT;
}

function hashPass(pw, salt) {
  let h = salt + '|' + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) h = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt, Utilities.Charset.UTF_8));
  return h;
}
const hex = (bytes) => bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// scope 'dict' = 재고 확인 화면. 공동 비밀번호 또는 [재고 확인 암호 등록]으로 넣은 암호로 사전만 열 수 있음
// auto = 재고 확인이 재고 암호로 자동 연결해 보는 것. 재고 확인 암호가 아직 없으면 비교하지 않고(실패로 세지 않고) 바로 알림
function login(pw, scope, auto) {
  const p = props(), cache = CacheService.getScriptCache();
  const dict = scope === 'dict';
  const dHash = p.getProperty('DICT_PASS_HASH'), dSalt = p.getProperty('DICT_PASS_SALT');
  if (dict && auto && !dHash) fail('no_dict_password', '재고 확인 암호가 아직 사전에 등록되지 않았습니다.');
  const until = Number(cache.get('lockUntil') || 0);
  if (until > Date.now()) fail('locked', `비밀번호를 여러 번 틀려 잠시 잠겼습니다. ${Math.ceil((until - Date.now()) / 60000)}분 뒤 다시 시도해 주세요.`);
  const hash = p.getProperty('PASS_HASH'), salt = p.getProperty('PASS_SALT');
  if (!hash || !salt) fail('no_password', '아직 공동 비밀번호가 정해지지 않았습니다. 관리자에게 알려 주세요.');
  const okPw = typeof pw === 'string' && pw && pw.length <= 200;
  const good = okPw && (safeEq(hashPass(pw, salt), hash) || (dict && dHash && dSalt && safeEq(hashPass(pw, dSalt), dHash)));
  if (!good) {
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    let locked = false;
    try {
      const n = Number(cache.get('fails') || 0) + 1;
      if (n >= MAX_FAILS) { cache.put('lockUntil', String(Date.now() + LOCK_S * 1000), LOCK_S); cache.remove('fails'); locked = true; }
      else cache.put('fails', String(n), FAIL_WINDOW_S);
    } finally { lock.releaseLock(); }
    Utilities.sleep(800);
    if (locked) fail('locked', `비밀번호를 ${MAX_FAILS}번 틀려 ${LOCK_S / 60}분 동안 잠겼습니다.`);
    fail('bad_password', '비밀번호가 맞지 않습니다.');
  }
  cache.remove('fails');
  if (dict) { ensureSeed(); return { token: makeToken('dict'), aliases: aliasList() }; }
  return { token: makeToken(), statuses: statuses() };
}

// 토큰 = 만료시각.서명 (전체) 또는 만료시각.dict.서명 (사전만). 비밀번호를 바꾸면 서명 키가 바뀌어 모든 기기가 다시 로그인해야 함
// (재고 확인 암호를 바꾸면 사전 전용 토큰만 무효)
function signingKey(dict) {
  const p = props();
  let s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s + '|' + (p.getProperty('PASS_HASH') || '') + (dict ? '|' + (p.getProperty('DICT_PASS_HASH') || '') : '');
}
const sign = (s) => Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, signingKey(/\.dict$/.test(s))));
function makeToken(scope) {
  const exp = String(Date.now() + (scope === 'dict' ? 1 : TOKEN_DAYS) * 864e5);
  const body = scope === 'dict' ? exp + '.dict' : exp;
  return body + '.' + sign(body);
}
function checkToken(t) {
  const m = /^(\d{10,16})(\.dict)?\.([\w\-=]+)$/.exec(String(t || ''));
  if (!m || Number(m[1]) < Date.now() || !props().getProperty('PASS_HASH') || !safeEq(sign(m[1] + (m[2] || '')), m[3])) fail('auth', '다시 로그인해 주세요.');
  return m[2] ? 'dict' : 'full';
}

/* ---------------- 시트 읽기·쓰기 ---------------- */

function book() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  const id = props().getProperty('SHEET_ID');
  if (!id) fail('server', '스프레드시트를 찾지 못했습니다. 관리자가 [핸썬 관리 > 시트 준비]를 한 번 실행해 주세요.');
  return SpreadsheetApp.openById(id);
}

const checkedHeads = {};
function sheet(key) {
  const def = SHEETS[key], ss = book();
  let sh = ss.getSheetByName(def.name);
  const heads = def.cols.map((c) => c[1]);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, heads.length).setValues([heads]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!checkedHeads[key]) {
    // 새 버전에서 열이 늘었으면 머리글을 채움 (기존 열 순서는 그대로, 새 열은 오른쪽에 더함)
    const cur = sh.getRange(1, 1, 1, heads.length).getValues()[0];
    if (cur.some((v, i) => String(v) !== heads[i])) sh.getRange(1, 1, 1, heads.length).setValues([heads]).setFontWeight('bold');
  }
  checkedHeads[key] = true;
  return sh;
}

const tz = () => Session.getScriptTimeZone() || 'Asia/Seoul';
const now = () => Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
const newId = () => Utilities.getUuid().replace(/-/g, '').slice(0, 16);

function readAll(key) {
  const def = SHEETS[key], sh = sheet(key), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, def.cols.length).getValues()
    .filter((r) => r[0] !== '' && r[0] != null)
    .map((r) => {
      const o = {};
      def.cols.forEach(([k, , t], i) => {
        const v = r[i];
        if (t === 'num') o[k] = typeof v === 'number' ? v : (Number(String(v).replace(/,/g, '')) || 0);
        else if (v instanceof Date) o[k] = Utilities.formatDate(v, tz(), k === 'dueDate' || k === 'deliveryDate' || k === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
        else o[k] = v == null ? '' : String(v);
      });
      return o;
    });
}

// 글자 칸은 '일반 텍스트'로 먼저 지정하고 씀 (모델명 '3-4'가 날짜로 바뀌는 것 방지)
function writeRows(key, startRow, objs) {
  if (!objs.length) return;
  const def = SHEETS[key], sh = sheet(key);
  const rg = sh.getRange(startRow, 1, objs.length, def.cols.length);
  rg.setNumberFormats(objs.map(() => def.cols.map((c) => (c[2] === 'num' ? '#,##0.##' : '@'))));
  rg.setValues(objs.map((o) => def.cols.map(([k, , t]) => (t === 'num' ? Number(o[k]) || 0 : String(o[k] == null ? '' : o[k])))));
}
const appendRows = (key, objs) => writeRows(key, sheet(key).getLastRow() + 1, objs);

function rowIndexOf(key, id) {
  const sh = sheet(key), n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

// 조건에 맞는 행을 지우고 나머지를 다시 씀. 지운 개수를 돌려줌
function deleteWhere(key, pred) {
  const all = readAll(key), keep = all.filter((o) => !pred(o));
  if (keep.length === all.length) return 0;
  const sh = sheet(key), last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, SHEETS[key].cols.length).clearContent();
  writeRows(key, 2, keep);
  return all.length - keep.length;
}

/* ---------------- 계산 ---------------- */

// 발주율·납품율은 수량 기준. 프로젝트 전체는 품목마다 전체 수량을 넘는 몫을 빼고 더함
function summarize(items, orders, deliveries) {
  const sumBy = (rows) => rows.reduce((m, r) => m.set(r.hwId, (m.get(r.hwId) || 0) + r.qty), new Map());
  const o = sumBy(orders), d = sumBy(deliveries);
  let qty = 0, ord = 0, dlv = 0;
  items.forEach((it) => { qty += it.qty; ord += Math.min(it.qty, o.get(it.id) || 0); dlv += Math.min(it.qty, d.get(it.id) || 0); });
  return { itemCount: items.length, qty, ordered: ord, delivered: dlv, orderRate: qty ? ord / qty : null, deliveryRate: qty ? dlv / qty : null };
}

/* ---------------- 동작 ---------------- */

function listProjects() {
  const projects = readAll('project'), hw = readAll('hw'), orders = readAll('order'), dels = readAll('delivery');
  const group = (rows) => rows.reduce((m, r) => { (m.get(r.projectId) || m.set(r.projectId, []).get(r.projectId)).push(r); return m; }, new Map());
  const H = group(hw), O = group(orders), D = group(dels);
  projects.forEach((p) => { p.summary = summarize(H.get(p.id) || [], O.get(p.id) || [], D.get(p.id) || []); });
  return { projects, statuses: statuses(), kakaoWaiting: readAll('kitem').filter((k) => k.status === '대기').length };
}

function getProject(id) {
  const project = readAll('project').find((p) => p.id === String(id));
  if (!project) fail('not_found', '프로젝트를 찾지 못했습니다. 다른 사람이 지웠을 수 있습니다.');
  const mine = (r) => r.projectId === project.id;
  return { project, items: readAll('hw').filter(mine), orders: readAll('order').filter(mine), deliveries: readAll('delivery').filter(mine), statuses: statuses() };
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));

function saveProject(p) {
  const site = clip(p.site);
  if (!site) fail('invalid', '현장명을 입력해 주세요.');
  const status = clip(p.status);
  if (!statuses().includes(status)) fail('invalid', '현 상황을 골라 주세요.');
  const dueDate = clip(p.dueDate, 10);
  if (dueDate && !isDate(dueDate)) fail('invalid', '준공 예정일을 날짜로 입력해 주세요.');
  const deliveryDate = clip(p.deliveryDate, 10);
  if (deliveryDate && !isDate(deliveryDate)) fail('invalid', '납품 예정일을 날짜로 입력해 주세요.');
  const total = Number(String(p.total == null ? '' : p.total).replace(/,/g, '')) || 0;
  const rec = { status, site, designer: clip(p.designer), builder: clip(p.builder), designManager: clip(p.designManager), clientManager: clip(p.clientManager),
    hansonManager: clip(p.hansonManager), deliveryDate, dueDate, total, siteAlias: clip(p.siteAlias, 500), updatedAt: now() };
  if (p.id) {
    const row = rowIndexOf('project', p.id);
    if (row < 0) fail('not_found', '프로젝트를 찾지 못했습니다. 다른 사람이 지웠을 수 있습니다.');
    const cur = readAll('project').find((x) => x.id === String(p.id));
    if (p.updatedAt && cur.updatedAt !== p.updatedAt) fail('conflict', '그사이 다른 사람이 이 프로젝트를 수정했습니다. 새로 불러온 내용을 확인한 뒤 다시 저장해 주세요.');
    Object.assign(cur, rec);
    writeRows('project', row, [cur]);
    return getProject(cur.id);
  }
  const created = Object.assign({ id: newId(), createdAt: rec.updatedAt }, rec);
  appendRows('project', [created]);
  return getProject(created.id);
}

function deleteProject(id) {
  id = String(id || '');
  if (rowIndexOf('project', id) < 0) fail('not_found', '프로젝트를 찾지 못했습니다.');
  ['order', 'delivery', 'hw'].forEach((k) => deleteWhere(k, (r) => r.projectId === id));
  deleteWhere('project', (r) => r.id === id);
  return {};
}

function uploadHardware(projectId, items, mode) {
  projectId = String(projectId || '');
  if (rowIndexOf('project', projectId) < 0) fail('not_found', '프로젝트를 찾지 못했습니다.');
  if (!Array.isArray(items) || !items.length) fail('invalid', '올릴 품목이 없습니다.');
  if (items.length > 3000) fail('invalid', '품목이 너무 많습니다 (3,000개까지).');
  const t = now();
  const rows = items.map((it) => {
    const qty = Number(it.qty);
    if (!clip(it.name) && !clip(it.model)) fail('invalid', '제품명이나 모델명을 입력해 주세요.');
    if (!isFinite(qty) || qty < 0) fail('invalid', `수량이 숫자가 아닌 품목이 있습니다: ${clip(it.name || it.model, 40)}`);
    return { id: newId(), projectId, seq: clip(it.seq, 20), name: clip(it.name), model: clip(it.model), unit: clip(it.unit, 20), qty, amount: Number(it.amount) || 0, createdAt: t,
      maker: clip(it.maker, 60), erpCode: clip(it.erpCode, 40), erpState: ERP_STATES.includes(it.erpState) && it.erpCode ? it.erpState : '',
      memo: clip(it.memo, 1000), stockManual: '', stockManualAt: '', stockConv: Math.max(0, Number(it.stockConv) || 0) };
  });
  if (mode === 'replace') ['order', 'delivery', 'hw'].forEach((k) => deleteWhere(k, (r) => r.projectId === projectId));
  appendRows('hw', rows);
  return getProject(projectId);
}

// 품목 하나 고치기 (수기 수정, 적요, 재고 수기). patch에 들어온 칸만 바꿈
const ITEM_EDIT = { seq: 20, name: 200, model: 200, maker: 60, unit: 20, memo: 1000 };
function updateItem(hwId, patch) {
  const row = rowIndexOf('hw', hwId);
  if (row < 0) fail('not_found', '품목을 찾지 못했습니다. 다른 사람이 품목을 지웠을 수 있습니다.');
  const it = readAll('hw').find((h) => h.id === String(hwId));
  Object.keys(ITEM_EDIT).forEach((k) => { if (k in patch) it[k] = clip(patch[k], ITEM_EDIT[k]); });
  if (!it.name && !it.model) fail('invalid', '제품명이나 모델명을 입력해 주세요.');
  ['qty', 'amount', 'stockConv'].forEach((k) => {
    if (!(k in patch)) return;
    const raw = String(patch[k] == null ? '' : patch[k]).replace(/,/g, '').trim(), n = raw === '' ? 0 : Number(raw);
    if (!isFinite(n) || n < 0) fail('invalid', { qty: '현장수량은 0 이상의 숫자로 입력해 주세요.', amount: '금액은 숫자로 입력해 주세요.', stockConv: '재고 전환 수량은 0 이상의 숫자로 입력해 주세요.' }[k]);
    it[k] = n;
  });
  if ('erpCode' in patch || 'erpState' in patch) {
    const st = ERP_STATES.includes(patch.erpState) ? patch.erpState : '';
    it.erpCode = st && st !== 'none' ? clip(patch.erpCode, 40) : ''; it.erpState = st && (st === 'none' || it.erpCode) ? st : '';
  }
  // 재고 수기: 숫자면 저장, 빈 값이면 지우고 자동(ERP 재고)으로 되돌림
  if ('stockManual' in patch) {
    const v = String(patch.stockManual == null ? '' : patch.stockManual).replace(/,/g, '').trim();
    if (v === '') { it.stockManual = ''; it.stockManualAt = ''; }
    else {
      const n = Number(v);
      if (!isFinite(n) || n < 0) fail('invalid', '재고는 0 이상의 숫자로 입력해 주세요.');
      it.stockManual = String(n); it.stockManualAt = now();
    }
  }
  writeRows('hw', row, [it]);
  return getProject(it.projectId);
}

function deleteItem(hwId) {
  const it = readAll('hw').find((h) => h.id === String(hwId || ''));
  if (!it) fail('not_found', '품목을 찾지 못했습니다. 이미 지워졌을 수 있습니다.');
  ['order', 'delivery'].forEach((k) => deleteWhere(k, (r) => r.hwId === it.id));
  deleteWhere('hw', (r) => r.id === it.id);
  return getProject(it.projectId);
}

function addRecord(kind, hwId, date, qty) {
  return getProject(addRecordRow(kind, hwId, date, qty, {}).projectId);
}
// 기록 한 줄 더하기. extra: { source, fromStock, kakaoId } (카톡에서 확인한 기록)
function addRecordRow(kind, hwId, date, qty, extra) {
  if (kind !== 'order' && kind !== 'delivery') fail('bad_request', '알 수 없는 기록 종류입니다.');
  const it = readAll('hw').find((h) => h.id === String(hwId || ''));
  if (!it) fail('not_found', '품목을 찾지 못했습니다. 다른 사람이 품목을 바꿨을 수 있습니다.');
  date = clip(date, 10);
  if (!isDate(date)) fail('invalid', '날짜를 입력해 주세요.');
  qty = Number(qty);
  if (!isFinite(qty) || qty <= 0) fail('invalid', '수량은 0보다 큰 숫자로 입력해 주세요.');
  const rec = { id: newId(), projectId: it.projectId, hwId: it.id, date, qty, createdAt: now(),
    source: clip(extra.source, 100), fromStock: extra.fromStock ? 'Y' : '', kakaoId: clip(extra.kakaoId, 40) };
  appendRows(kind, [rec]);
  return rec;
}

function deleteRecord(kind, id) {
  if (kind !== 'order' && kind !== 'delivery') fail('bad_request', '알 수 없는 기록 종류입니다.');
  const rec = readAll(kind).find((r) => r.id === String(id || ''));
  if (!rec) fail('not_found', '기록을 찾지 못했습니다. 이미 지워졌을 수 있습니다.');
  deleteWhere(kind, (r) => r.id === rec.id);
  return getProject(rec.projectId);
}

/* ---------------- 품목 별칭 사전 ---------------- */

// 품목코드 상태: dict = 사전('확실')으로 붙임, guess = 기호 무시 비교로 추정, ok = 사람이 확인, none = 사람이 'ERP에 없음'으로 확인
const ERP_STATES = ['dict', 'guess', 'ok', 'none'];

function aliasList() {
  return readAll('alias').map((a) => ({ code: a.code, alias: a.alias, status: a.status === SURE ? SURE : UNSURE,
    erpName: a.erpName, erpSpec: a.erpSpec, supplier: a.supplier, quoteName: a.quoteName, rel: a.rel }));
}
function catalogItems() {
  return readAll('item').map((i) => [i.code, i.name, i.spec, i.unit, i.supplier, i.search]);
}

// 사람이 확인한 짝을 사전에 더함. 같은 품목코드·같은 별칭(기호 무시)이 있으면 '확실'로 올리고, 이미 확실이면 등장 횟수만 늘림
function addAliases(pairs, by) {
  if (!Array.isArray(pairs) || !pairs.length) fail('invalid', '사전에 넣을 짝이 없습니다.');
  if (pairs.length > 500) fail('invalid', '한 번에 500개까지 넣을 수 있습니다.');
  const def = SHEETS.alias, sh = sheet('alias'), n = Math.max(0, sh.getLastRow() - 1);
  const raw = n ? sh.getRange(2, 1, n, def.cols.length).getValues() : [];
  const ci = (k) => def.cols.findIndex((c) => c[0] === k);
  const C = { code: ci('code'), alias: ci('alias'), status: ci('status'), reason: ci('reason'), count: ci('count'), rel: ci('rel'), addedAt: ci('addedAt'), addedBy: ci('addedBy') };
  const items = new Map(readAll('item').map((i) => [i.code, i]));
  const t = now(), add = [], touched = new Set();
  let added = 0, raised = 0;
  pairs.forEach((p) => {
    const code = clip(p && p.code, 40), alias = clip(p && p.alias), key = normModel(alias);
    if (!code || !key) return;
    const i = raw.findIndex((r) => String(r[C.code]) === code && normModel(r[C.alias]) === key);
    if (i >= 0) {
      const r = raw[i];
      if (r[C.status] !== SURE) { r[C.status] = SURE; r[C.rel] = '같은 제품 (사람이 확인)'; r[C.reason] = by + '에서 사람이 확인'; r[C.addedAt] = t; r[C.addedBy] = by; raised++; }
      else r[C.count] = (Number(r[C.count]) || 0) + 1;
      touched.add(i);
      return;
    }
    if (add.some((a) => a.code === code && normModel(a.alias) === key)) return;
    const it = items.get(code) || {};
    add.push({ code, erpName: it.name || clip(p.erpName), erpSpec: it.spec || clip(p.erpSpec), supplier: it.supplier || clip(p.supplier, 60), alias,
      quoteName: clip(p.quoteName), rel: '같은 제품 (사람이 확인)', status: SURE, reason: by + '에서 사람이 확인', source: clip(p.source),
      count: 1, others: '', addedAt: t, addedBy: by });
    added++;
  });
  const asObj = (r) => { const o = {}; def.cols.forEach(([k], j) => { o[k] = r[j] instanceof Date ? Utilities.formatDate(r[j], tz(), 'yyyy-MM-dd HH:mm:ss') : r[j]; }); return o; };
  touched.forEach((i) => writeRows('alias', i + 2, [asObj(raw[i])]));
  if (add.length) appendRows('alias', add);
  return { added, raised };
}

// 하드웨어 품목에 ERP 품목코드를 붙이거나 바꿈. addAlias면 사람이 확인한(ok) 짝을 사전에도 더함
function setErp(changes, addAlias) {
  if (!Array.isArray(changes) || !changes.length) fail('invalid', '바꿀 품목이 없습니다.');
  if (changes.length > 3000) fail('invalid', '품목이 너무 많습니다.');
  const def = SHEETS.hw, sh = sheet('hw'), n = sh.getLastRow() - 1;
  if (n < 1) fail('not_found', '품목을 찾지 못했습니다.');
  const all = sh.getRange(2, 1, n, def.cols.length).getValues();
  const ci = (k) => def.cols.findIndex((c) => c[0] === k);
  const I = { id: ci('id'), pid: ci('projectId'), name: ci('name'), model: ci('model'), code: ci('erpCode'), st: ci('erpState') };
  const at = new Map(all.map((r, i) => [String(r[I.id]), i]));
  const pairs = [];
  let projectId = '';
  changes.forEach((c) => {
    const i = at.get(String(c && c.hwId));
    if (i == null) fail('not_found', '품목을 찾지 못했습니다. 다른 사람이 품목을 바꿨을 수 있습니다.');
    const code = clip(c.erpCode, 40), st = ERP_STATES.includes(c.erpState) ? c.erpState : '';
    if (st && st !== 'none' && !code) fail('invalid', '품목코드가 비어 있습니다.');
    all[i][I.code] = st === 'none' || !st ? '' : code; all[i][I.st] = st;
    projectId = projectId || String(all[i][I.pid]);
    if (addAlias && st === 'ok' && String(all[i][I.model]).trim()) pairs.push({ code, alias: all[i][I.model], quoteName: all[i][I.name] });
  });
  const rg = sh.getRange(2, I.code + 1, n, 2);
  rg.setNumberFormats(all.map(() => ['@', '@']));
  rg.setValues(all.map((r) => [String(r[I.code] == null ? '' : r[I.code]), String(r[I.st] == null ? '' : r[I.st])]));
  let dict = null;
  if (pairs.length) {
    const site = (readAll('project').find((p) => p.id === projectId) || {}).site || '';
    pairs.forEach((p) => { p.source = '프로젝트 관리 / ' + site; });
    dict = addAliases(pairs, '프로젝트 관리');
  }
  return Object.assign(getProject(projectId), { dict, aliases: aliasList() });
}

// 처음 사전 자료(Seed.js — 회사 자료라 공개 저장소에는 없고 Apps Script에만 올림)를 시트로 옮김
function ensureSeed() {
  if (typeof SEED_ALIAS === 'undefined') return;
  const ss = book(), a = ss.getSheetByName(SHEETS.alias.name), i = ss.getSheetByName(SHEETS.item.name);
  if (a && i && a.getLastRow() > 1 && i.getLastRow() > 1) return;
  withLock(() => importSeed(false));
}
// 별칭 사전은 비어 있을 때만 채움 (사람이 더한 줄을 지우지 않도록). 전체 품목은 replaceItems면 새 목록으로 바꿈
function importSeed(replaceItems) {
  if (typeof SEED_ALIAS === 'undefined') { sheet('alias'); sheet('item'); return '가져올 자료(Seed.js)가 없습니다.'; }
  const toObj = (cols, r) => { const o = {}; cols.forEach(([k], i) => { o[k] = r[i]; }); return o; };
  const msg = [];
  if (sheet('alias').getLastRow() < 2) {
    appendRows('alias', SEED_ALIAS.map((r) => toObj(SHEETS.alias.cols, r)));
    msg.push('별칭 사전 ' + SEED_ALIAS.length + '줄');
  }
  const ish = sheet('item');
  if (replaceItems || ish.getLastRow() < 2) {
    if (ish.getLastRow() > 1) ish.getRange(2, 1, ish.getLastRow() - 1, SHEETS.item.cols.length).clearContent();
    writeRows('item', 2, SEED_ITEMS.map((r) => toObj(SHEETS.item.cols, r)));
    msg.push('전체 품목 ' + SEED_ITEMS.length + '개 (' + SEED_NAME + ')');
  }
  return msg.length ? msg.join(', ') + '를 가져왔습니다.' : '이미 들어 있어 바꾸지 않았습니다.';
}

/* ---------------- 관리자 메뉴 (스프레드시트에서) ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('핸썬 관리')
    .addItem('공동 비밀번호 정하기', 'setPasswordPrompt')
    .addItem('시트 준비', 'setup')
    .addSeparator()
    .addItem('재고 확인 암호 등록 (사전 연결·재고 보기용)', 'setDictPasswordPrompt')
    .addItem('별칭 사전·전체 품목 가져오기', 'importSeedMenu')
    .addToUi();
}

// 처음 한 번: 시트 네 개를 만들고 스프레드시트 id를 기억 (권한 승인도 이때 받음)
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) props().setProperty('SHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(sheet);
  const blank = book().getSheetByName('시트1') || book().getSheetByName('Sheet1');
  if (blank && book().getSheets().length > 4 && blank.getLastRow() === 0) book().deleteSheet(blank);
  signingKey();
  return '시트를 준비했습니다.';
}

function setPasswordPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('공동 비밀번호 정하기', '새 공동 비밀번호를 입력해 주세요 (8자 이상). 바꾸면 모든 기기에서 다시 로그인해야 합니다.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const pw = r.getResponseText();
  if (pw.length < 8) { ui.alert('8자 이상으로 정해 주세요.'); return; }
  const salt = Utilities.getUuid();
  props().setProperties({ PASS_SALT: salt, PASS_HASH: hashPass(pw, salt) });
  CacheService.getScriptCache().removeAll(['fails', 'lockUntil']);
  ui.alert('공동 비밀번호를 저장했습니다. 동료들에게 알려 주세요.');
}

// 재고 확인 화면의 '앱 암호'를 등록해 두면, 재고 확인이 그 암호로 별칭 사전에 자동 연결됨 (사전 읽기·추가만 가능)
function setDictPasswordPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('재고 확인 암호 등록', '재고 확인 화면에서 쓰는 앱 암호를 입력해 주세요. 재고 확인은 이 암호로 별칭 사전에 연결하고, 프로젝트 관리는 이 암호로 핸썬 재고를 엽니다 (공동 비밀번호로 로그인한 사람만). 비워 두고 확인을 누르면 등록을 지웁니다.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const pw = r.getResponseText();
  if (!pw) { ['DICT_PASS_HASH', 'DICT_PASS_SALT', 'STOCK_PASS'].forEach((k) => props().deleteProperty(k)); ui.alert('재고 확인 암호 등록을 지웠습니다.'); return; }
  const salt = Utilities.getUuid();
  // STOCK_PASS: 프로젝트 관리 화면이 잠긴 재고 파일을 열 때 씀 (공동 비밀번호로 로그인한 사람에게만 전달)
  props().setProperties({ DICT_PASS_SALT: salt, DICT_PASS_HASH: hashPass(pw, salt), STOCK_PASS: pw });
  CacheService.getScriptCache().removeAll(['fails', 'lockUntil']);
  ui.alert('재고 확인 암호를 등록했습니다.');
}

function importSeedMenu() {
  SpreadsheetApp.getUi().alert(withLock(() => importSeed(true)));
}
