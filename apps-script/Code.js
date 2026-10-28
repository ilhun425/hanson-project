/* 핸썬 프로젝트 관리 — 구글 스프레드시트를 저장소로 쓰는 Apps Script 웹 앱 (API)
 * 화면(GitHub Pages)이 text/plain POST로 {action, token, ...}을 보내고 JSON을 받습니다.
 * 공동 비밀번호는 스프레드시트 메뉴 [핸썬 관리 > 공동 비밀번호 정하기]로 정하며, 해시만 Script Properties에 저장합니다. */

// 현 상황 선택지. 바꾸려면 이 줄을 고치거나, 프로젝트 설정 > 스크립트 속성에 STATUSES 를 '영업중,견적,…' 처럼 넣으면 됩니다.
const STATUSES_DEFAULT = ['영업중', '견적', '수주', '진행중', '준공', '보류'];

const TOKEN_DAYS = 30;          // 로그인 유지 기간
const MAX_FAILS = 5;            // 이 횟수만큼 틀리면
const FAIL_WINDOW_S = 600;      // (10분 안에)
const LOCK_S = 600;             // 10분 동안 잠금
const HASH_ROUNDS = 300;

const SHEETS = {
  project: { name: '프로젝트', cols: [
    ['id', 'id'], ['status', '현상황'], ['site', '현장명'], ['designer', '설계사'], ['builder', '시공사'],
    ['clientManager', '업체담당자'], ['hansonManager', '핸썬담당자'], ['dueDate', '준공예정일'], ['total', '총금액', 'num'],
    ['createdAt', '등록일시'], ['updatedAt', '수정일시']] },
  hw: { name: '하드웨어', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['seq', '순번'], ['name', '제품명'], ['model', '모델명'], ['unit', '단위'],
    ['qty', '수량', 'num'], ['amount', '금액', 'num'], ['createdAt', '등록일시']] },
  order: { name: '발주', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['hwId', '하드웨어id'], ['date', '날짜'], ['qty', '수량', 'num'], ['createdAt', '등록일시']] },
  delivery: { name: '납품', cols: [
    ['id', 'id'], ['projectId', '프로젝트id'], ['hwId', '하드웨어id'], ['date', '날짜'], ['qty', '수량', 'num'], ['createdAt', '등록일시']] },
};

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
  if (req.action === 'login') return login(req.password);
  checkToken(req.token);
  switch (req.action) {
    case 'list': return listProjects();
    case 'project': return getProject(req.id);
    case 'saveProject': return withLock(() => saveProject(req.project || {}));
    case 'deleteProject': return withLock(() => deleteProject(req.id));
    case 'uploadHardware': return withLock(() => uploadHardware(req.projectId, req.items, req.mode));
    case 'addRecord': return withLock(() => addRecord(req.kind, req.hwId, req.date, req.qty));
    case 'deleteRecord': return withLock(() => deleteRecord(req.kind, req.id));
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

function login(pw) {
  const p = props(), cache = CacheService.getScriptCache();
  const until = Number(cache.get('lockUntil') || 0);
  if (until > Date.now()) fail('locked', `비밀번호를 여러 번 틀려 잠시 잠겼습니다. ${Math.ceil((until - Date.now()) / 60000)}분 뒤 다시 시도해 주세요.`);
  const hash = p.getProperty('PASS_HASH'), salt = p.getProperty('PASS_SALT');
  if (!hash || !salt) fail('no_password', '아직 공동 비밀번호가 정해지지 않았습니다. 관리자에게 알려 주세요.');
  if (typeof pw !== 'string' || !pw || pw.length > 200 || !safeEq(hashPass(pw, salt), hash)) {
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
  return { token: makeToken(), statuses: statuses() };
}

// 토큰 = 만료시각.서명. 비밀번호를 바꾸면 서명 키가 바뀌어 모든 기기가 다시 로그인해야 함
function signingKey() {
  const p = props();
  let s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s + '|' + (p.getProperty('PASS_HASH') || '');
}
const sign = (s) => Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, signingKey()));
function makeToken() { const exp = String(Date.now() + TOKEN_DAYS * 864e5); return exp + '.' + sign(exp); }
function checkToken(t) {
  const m = /^(\d{10,16})\.([\w\-=]+)$/.exec(String(t || ''));
  if (!m || Number(m[1]) < Date.now() || !props().getProperty('PASS_HASH') || !safeEq(sign(m[1]), m[2])) fail('auth', '다시 로그인해 주세요.');
}

/* ---------------- 시트 읽기·쓰기 ---------------- */

function book() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  const id = props().getProperty('SHEET_ID');
  if (!id) fail('server', '스프레드시트를 찾지 못했습니다. 관리자가 [핸썬 관리 > 시트 준비]를 한 번 실행해 주세요.');
  return SpreadsheetApp.openById(id);
}

function sheet(key) {
  const def = SHEETS[key], ss = book();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map((c) => c[1])]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
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
        else if (v instanceof Date) o[k] = Utilities.formatDate(v, tz(), k === 'dueDate' || k === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
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
  return { projects, statuses: statuses() };
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
  const total = Number(String(p.total == null ? '' : p.total).replace(/,/g, '')) || 0;
  const rec = { status, site, designer: clip(p.designer), builder: clip(p.builder), clientManager: clip(p.clientManager),
    hansonManager: clip(p.hansonManager), dueDate, total, updatedAt: now() };
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
    if (!isFinite(qty) || qty < 0) fail('invalid', `수량이 숫자가 아닌 품목이 있습니다: ${clip(it.name || it.model, 40)}`);
    return { id: newId(), projectId, seq: clip(it.seq, 20), name: clip(it.name), model: clip(it.model), unit: clip(it.unit, 20), qty, amount: Number(it.amount) || 0, createdAt: t };
  });
  if (mode === 'replace') ['order', 'delivery', 'hw'].forEach((k) => deleteWhere(k, (r) => r.projectId === projectId));
  appendRows('hw', rows);
  return getProject(projectId);
}

function addRecord(kind, hwId, date, qty) {
  if (kind !== 'order' && kind !== 'delivery') fail('bad_request', '알 수 없는 기록 종류입니다.');
  const it = readAll('hw').find((h) => h.id === String(hwId || ''));
  if (!it) fail('not_found', '품목을 찾지 못했습니다. 다른 사람이 품목을 바꿨을 수 있습니다.');
  date = clip(date, 10);
  if (!isDate(date)) fail('invalid', '날짜를 입력해 주세요.');
  qty = Number(qty);
  if (!isFinite(qty) || qty <= 0) fail('invalid', '수량은 0보다 큰 숫자로 입력해 주세요.');
  appendRows(kind, [{ id: newId(), projectId: it.projectId, hwId: it.id, date, qty, createdAt: now() }]);
  return getProject(it.projectId);
}

function deleteRecord(kind, id) {
  if (kind !== 'order' && kind !== 'delivery') fail('bad_request', '알 수 없는 기록 종류입니다.');
  const rec = readAll(kind).find((r) => r.id === String(id || ''));
  if (!rec) fail('not_found', '기록을 찾지 못했습니다. 이미 지워졌을 수 있습니다.');
  deleteWhere(kind, (r) => r.id === rec.id);
  return getProject(rec.projectId);
}

/* ---------------- 관리자 메뉴 (스프레드시트에서) ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('핸썬 관리')
    .addItem('공동 비밀번호 정하기', 'setPasswordPrompt')
    .addItem('시트 준비', 'setup')
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
