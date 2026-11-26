'use strict';
/* 준비물 탭 — app.js 다음에 읽힌다($, esc, toast, openSheet, closeSheet 를 같이 쓴다).
 *
 * 목록: localStorage 'camp-gear' = { items:[{ id, cat, name, qty, note, imgs:[이미지id], done }], rev, dirty, editAt, fresh, upq, delq }
 * 그림: IndexedDB 'camp-gear' / 'img' (id → Blob). 긴 변 1280px JPEG 로 줄여 넣는다.
 * 동기화: ⚙︎ 앱 토큰이 있으면 camping-api /api/gear(R2)와 맞춘다 — 나중에 고친 쪽이 이긴다(editAt vs 서버 rev).
 *   처음 연결하는 기기는 서버에 목록이 있으면 서버 것을 받는다(기기 목록은 'camp-gear-backup' 에 남김).
 *   사진은 올릴 것(upq)·지울 것(delq)을 모았다가 목록 저장 전에 처리, 없는 사진은 볼 때 서버에서 받는다.
 * 평소: 첫 열 체크 → 그 행이 회색. ✏️ 수정 누르면 추가·삭제·내용 수정·그림 추가/삭제.
 */

const gid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const GEAR_CATS = ['텐트/기본류', '침구류', '주방류', '옷/세면', '전기류', '상비약', '놀이', '기타'];
const GEAR_SEED_V = 2; // 기본 목록 판 — 올리면 손대지 않은 옛 기본 항목을 새 목록으로 바꾼다
const GEAR_SEED = [
  ['텐트/기본류', '텐트 (그라운드시트 포함)'], ['텐트/기본류', '타프 / 쉘터'], ['텐트/기본류', '팩 / 망치'], ['텐트/기본류', '랜턴걸이 / 폴대'],
  ['텐트/기본류', '의자'], ['텐트/기본류', '테이블'], ['텐트/기본류', '방수포'],
  ['침구류', '침낭'], ['침구류', '에어매트 / 매트리스 / 야전침대'], ['침구류', '베개'], ['침구류', '이불 / 담요'], ['침구류', '담요커버 / 매트커버'],
  ['주방류', '버너 / 강염버너'], ['주방류', '그릴'], ['주방류', '가스(부탄/프로판)'], ['주방류', '코펠 / 냄비 / 프라이팬'], ['주방류', '주전자'],
  ['주방류', '도마 / 칼 / 가위 / 집게'], ['주방류', '라이터 / 성냥'], ['주방류', '접시 / 컵 / 수저'], ['주방류', '식탁 매트 / 테이블보'],
  ['주방류', '보냉백 / 아이스박스'], ['주방류', '생수 / 물통'], ['주방류', '키친타올 / 행주'], ['주방류', '수세미 / 세제'],
  ['주방류', '물티슈 / 일반티슈'], ['주방류', '쓰레기봉투'],
  ['옷/세면', '여벌 옷 / 속옷'], ['옷/세면', '수건'], ['옷/세면', '세면도구 (칫솔, 치약)'], ['옷/세면', '슬리퍼 / 샌들'], ['옷/세면', '선크림 / 립밤'],
  ['옷/세면', '캠핑용 건조대'], ['옷/세면', '빨래집게'],
  ['전기류', '랜턴 (메인, 테이블, 휴대용)'], ['전기류', '건전지 / 충전기'], ['전기류', '전기릴선 / 멀티탭'], ['전기류', '헤드랜턴'],
  ['상비약', '구급약 / 상비약'], ['상비약', '벌레퇴치제 / 모기향 / 버물리'], ['상비약', '반창고'],
  ['놀이', '배드민턴 / 공'], ['놀이', '보드게임 / 카드게임'], ['놀이', '아이들 장난감 / 책'], ['놀이', '자전거 (가능 시)'],
  ['기타', '온열패드 (계절용)'], ['기타', '우비 / 우산'], ['기타', '캠핑용 가방 / 캐리어'],
];
// 1판 기본 목록(손대지 않은 항목을 알아보는 데만 쓴다)과 옛 분류 → 새 분류
const GEAR_SEED_V1 = new Set(['텐트|텐트', '텐트|타프', '텐트|팩·망치', '텐트|그라운드시트', '침구류|침낭', '침구류|매트', '침구류|베개',
  '주방류|버너·가스', '주방류|코펠·냄비', '주방류|수저·컵', '주방류|아이스박스', '음식|물', '음식|고기·반찬', '난방류|화로대', '난방류|난로',
  '전자|랜턴', '전자|릴선(전기)', '전자|보조배터리', '놀이|보드게임', '옷/세면|여벌옷', '옷/세면|세면도구', '옷/세면|수건']);
const GEAR_CAT_OLD = { '텐트': '텐트/기본류', '음식': '주방류', '난방류': '기타', '전자': '전기류' };
const seedItems = () => GEAR_SEED.map(([cat, name]) => ({ id: gid(), cat, name, qty: 1, note: '', imgs: [], done: false }));
// 옛 분류를 새 분류로 옮기고, 옛 기본 목록 그대로인 항목은 새 기본 목록으로 바꾼다(고친 항목·추가한 항목은 그대로 둔다)
function migrateGear(items) {
  const keep = items.filter((x) => !(GEAR_SEED_V1.has(`${x.cat}|${x.name}`) && !x.imgs.length && !x.note));
  for (const x of keep) x.cat = GEAR_CAT_OLD[x.cat] || x.cat;
  const have = new Set(keep.map((x) => x.name));
  return [...keep, ...seedItems().filter((x) => !have.has(x.name))];
}

let G = loadGear();
let gearEdit = false;

function loadGear() {
  try {
    const v = JSON.parse(localStorage.getItem('camp-gear') || 'null');
    if (v && Array.isArray(v.items)) {
      if ((v.seedV || 1) < GEAR_SEED_V) { // 새 기본 목록 반영
        v.seedV = GEAR_SEED_V;
        if (v.fresh) v.items = seedItems();
        else { v.items = migrateGear(v.items); v.dirty = true; v.editAt = Date.now(); }
        try { localStorage.setItem('camp-gear', JSON.stringify(v)); } catch {}
      }
      if (v.rev == null) { // 동기화 전 버전에서 고친 목록 — 올릴 대상
        Object.assign(v, { rev: 0, dirty: true, editAt: Date.now(), fresh: false, upq: v.items.flatMap((x) => x.imgs), delq: [] });
      }
      return v;
    }
  } catch {}
  return { items: seedItems(), seedV: GEAR_SEED_V,
    rev: 0, dirty: false, editAt: 0, fresh: true, upq: [], delq: [] };
}
function storeGear() { try { localStorage.setItem('camp-gear', JSON.stringify(G)); } catch { toast('저장 공간이 부족해요'); } }
let editSeq = 0;
function saveGear() { // 사용자가 고친 것 — 저장하고 잠시 뒤 서버로
  G.dirty = true; G.fresh = false; G.editAt = Date.now(); editSeq++;
  storeGear(); schedulePush();
}
const gItem = (id) => G.items.find((x) => x.id === id);

/* ───── 그림 저장소(IndexedDB) ───── */
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((ok, no) => {
    const r = indexedDB.open('camp-gear', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  return idbP;
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((ok, no) => {
    const tx = db.transaction('img', mode), st = tx.objectStore('img');
    const req = fn(st);
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = () => no(tx.error);
  });
}
const imgPut = (id, blob) => idbDo('readwrite', (s) => s.put(blob, id));
const imgDel = (id) => idbDo('readwrite', (s) => s.delete(id));
const imgGet = (id) => idbDo('readonly', (s) => s.get(id));

const URLS = new Map(); // 이미지id → objectURL
async function imgURL(id) {
  if (URLS.has(id)) return URLS.get(id);
  let b = await imgGet(id).catch(() => null);
  if (!b && canSync()) { // 다른 기기에서 넣은 사진 — 서버에서 받아 이 기기에도 둔다
    try {
      const r = await fetch(`${API}/api/gear/img/${id}`, { headers: { 'X-App-Token': S.token } });
      if (r.ok) { b = await r.blob(); imgPut(id, b).catch(() => {}); }
    } catch {}
  }
  if (!b) return '';
  const u = URL.createObjectURL(b); URLS.set(id, u); return u;
}
function dropURL(id) { const u = URLS.get(id); if (u) { URL.revokeObjectURL(u); URLS.delete(id); } }

async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  return new Promise((ok) => cv.toBlob((b) => ok(b || file), 'image/jpeg', 0.82));
}
/* ───── 동기화 ───── */
const canSync = () => !!S.token && !tokenBad;
let syncState = '', pushT = 0, pushing = null, lastPull = 0;
function setSync(st) { syncState = st; const el = $('gearSync'); if (el) el.textContent = syncLabel(); }
function syncLabel() {
  if (!S.token) return '📱 이 기기에만 저장 (⚙︎ 토큰 넣으면 동기화)';
  if (tokenBad) return '⚠️ 토큰이 맞지 않아 이 기기에만 저장';
  return { busy: '⏳ 동기화 중…', ok: '☁️ 동기화됨', off: '⚠️ 연결 안 됨 — 나중에 다시 올려요' }[syncState] || (G.dirty ? '⏳ 올릴 내용 있음' : '☁️ 동기화됨');
}
const hdr = (extra) => ({ 'X-App-Token': S.token, ...extra });
async function api(path, opt = {}) {
  const r = await fetch(API + path, { ...opt, headers: hdr(opt.headers) });
  if (r.status === 401) { tokenBad = true; throw new Error('401'); }
  if (!r.ok) throw new Error('http' + r.status);
  return r.json();
}
function schedulePush() { clearTimeout(pushT); if (canSync()) pushT = setTimeout(pushGear, 1200); setSync(''); }
async function pushGear() {
  clearTimeout(pushT);
  if (!canSync() || !G.dirty) return;
  if (pushing) { await pushing; if (G.dirty) schedulePush(); return; }
  pushing = (async () => {
    const seq = editSeq;
    setSync('busy');
    try {
      for (const im of [...G.upq]) { // 사진 먼저 — 목록이 가리키는 사진이 서버에 없지 않게
        const b = await imgGet(im).catch(() => null);
        if (b) await api(`/api/gear/img/${im}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: b });
        G.upq = G.upq.filter((x) => x !== im); storeGear();
      }
      for (const im of [...G.delq]) {
        await api(`/api/gear/img/${im}`, { method: 'DELETE' }).catch((e) => { if (e.message === '401') throw e; });
        G.delq = G.delq.filter((x) => x !== im); storeGear();
      }
      const { rev } = await api('/api/gear', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: G.items }) });
      G.rev = rev; if (seq === editSeq) G.dirty = false;
      storeGear(); setSync('ok');
    } catch { setSync('off'); if (tokenBad) toast('API 토큰이 맞지 않아요. ⚙︎ 설정에서 확인해 주세요'); }
  })();
  await pushing; pushing = null;
  if (G.dirty && syncState === 'ok') schedulePush(); // 올리는 동안 또 고친 것
}
function adoptRemote(rm) {
  const keep = new Set(rm.items.flatMap((x) => x.imgs));
  for (const it of G.items) for (const im of it.imgs) if (!keep.has(im)) { dropURL(im); imgDel(im).catch(() => {}); } // 서버에서 지워진 사진 정리
  for (const x of rm.items) x.cat = GEAR_CAT_OLD[x.cat] || x.cat;
  G.items = rm.items; G.rev = rm.rev; G.dirty = false; G.fresh = false; G.upq = []; G.delq = [];
  storeGear();
}
async function pullGear(force) {
  if (!canSync() || pushing || gearEdit) return; // 수정 중엔 화면을 바꾸지 않는다
  if (!force && Date.now() - lastPull < 5000) return;
  lastPull = Date.now();
  setSync('busy');
  try {
    const rm = await api('/api/gear');
    if (gearEdit) { setSync('ok'); return; }
    if (!rm.items) { G.dirty = true; storeGear(); setSync(''); await pushGear(); return; } // 서버가 비어 있으면 이 기기 목록을 올린다
    let changed = false;
    if (!G.rev && !G.fresh) { // 처음 연결하는 기기 — 서버 목록을 받고, 이 기기 목록은 백업
      try { localStorage.setItem('camp-gear-backup', JSON.stringify({ at: Date.now(), items: G.items })); } catch {}
      adoptRemote(rm); changed = true;
      toast('다른 기기의 준비물 목록을 받아왔어요');
    } else if (G.dirty && G.editAt > rm.rev) { setSync(''); await pushGear(); return; } // 여기서 더 나중에 고침
    else if (rm.rev !== G.rev || G.fresh) { adoptRemote(rm); changed = true; }
    setSync('ok');
    if (changed && S.tab === 'gear') renderGear();
  } catch { setSync('off'); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pushGear();
  else if (S.tab === 'gear') pullGear();
});
addEventListener('online', () => { pushGear().then(() => pullGear(true)); });
function gearSyncNow() { lastPull = 0; setSync(''); pushGear().then(() => pullGear(true)); } // ⚙︎ 토큰 저장 뒤

// 화면에 그려진 <img data-gimg="id"> 들에 실제 그림을 채운다
function fillImgs(root) {
  root.querySelectorAll('img[data-gimg]').forEach(async (el) => { el.src = await imgURL(el.dataset.gimg); });
}

/* ───── 그리기 ───── */
const catOpts = (sel) => GEAR_CATS.map((c) => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');

function gearRowView(it) {
  const pics = it.imgs.length
    ? `<button class="g-pic" data-gview="${it.id}" aria-label="그림 보기"><img data-gimg="${it.imgs[0]}" alt="">${it.imgs.length > 1 ? `<i>${it.imgs.length}</i>` : ''}</button>` : '';
  return `<tr class="${it.done ? 'done' : ''}" data-gid="${it.id}">
    <td class="g-ck"><input type="checkbox" data-gcheck="${it.id}"${it.done ? ' checked' : ''} aria-label="체크"></td>
    <td class="g-cat">${esc(it.cat)}</td>
    <td class="g-nm"><span>${esc(it.name)}</span>${pics}</td>
    <td class="g-qty">${esc(it.qty)}</td>
    <td class="g-note">${esc(it.note)}</td>
  </tr>`;
}
// 수정 모드는 폰 폭에 맞게 항목당 2줄: 위 삭제·분류·품목·갯수 / 아래 비고·그림
function gearRowEdit(it) {
  const pics = it.imgs.map((im) =>
    `<span class="g-thumb"><img data-gimg="${im}" alt="" data-gview="${it.id}"><button data-gimgdel="${it.id}|${im}" aria-label="그림 삭제">✕</button></span>`).join('');
  return `<tr class="g-r1" data-gid="${it.id}">
    <td class="g-ck" rowspan="2"><button class="g-del" data-gdel="${it.id}" aria-label="삭제">🗑</button></td>
    <td class="g-cat"><select data-gf="cat" aria-label="분류">${catOpts(it.cat)}</select></td>
    <td class="g-nm"><input data-gf="name" value="${esc(it.name)}" placeholder="품목"></td>
    <td class="g-qty"><input data-gf="qty" type="number" min="0" inputmode="numeric" value="${esc(it.qty)}" aria-label="갯수"></td>
  </tr><tr class="g-r2" data-gid="${it.id}">
    <td colspan="3"><div class="g-r2in"><input data-gf="note" value="${esc(it.note)}" placeholder="비고">
      <span class="g-imgs">${pics}<label class="g-add-img" aria-label="그림 추가">📷+<input type="file" accept="image/*" multiple data-gimgadd="${it.id}" hidden></label></span></div></td>
  </tr>`;
}
const catRank = (c) => { const i = GEAR_CATS.indexOf(c); return i < 0 ? 99 : i; };

function renderGear() {
  const box = $('gearBody');
  $('gearSync').textContent = syncLabel();
  pullGear();
  const n = G.items.length, d = G.items.filter((x) => x.done).length;
  $('gearCount').textContent = gearEdit ? `수정 중 · ${n}개` : `${d} / ${n} 챙김`;
  $('btnGearEdit').textContent = gearEdit ? '✔ 완료' : '✏️ 수정';
  $('btnGearEdit').classList.toggle('on', gearEdit);
  $('btnGearReset').hidden = gearEdit || !d;
  $('btnGearAdd').hidden = !gearEdit;
  if (!n && !gearEdit) {
    box.innerHTML = '<div class="empty">준비물이 없어요.<br>✏️ 수정을 눌러 추가하세요.</div>';
    return;
  }
  box.innerHTML = `<div class="tbl-wrap"><table class="tbl gear${gearEdit ? ' edit' : ''}">
    <thead><tr><th class="g-ck">${gearEdit ? '삭제' : '체크'}</th><th>분류</th><th>품목</th><th class="g-qty">갯수</th>${gearEdit ? '' : '<th>비고</th>'}</tr>
      ${gearEdit ? '<tr><th></th><th colspan="3" class="g-sub">비고 · 그림</th></tr>' : ''}</thead>
    <tbody>${gearEdit ? G.items.map(gearRowEdit).join('')
      : G.items.map((it, i) => [it, i]).sort((a, b) => catRank(a[0].cat) - catRank(b[0].cat) || a[1] - b[1]).map(([it]) => gearRowView(it)).join('')}</tbody>
  </table></div>`;
  fillImgs(box);
}

/* ───── 동작 ───── */
function gearAdd() {
  const last = G.items[G.items.length - 1];
  const it = { id: gid(), cat: last?.cat || GEAR_CATS[0], name: '', qty: 1, note: '', imgs: [], done: false };
  G.items.push(it); saveGear(); renderGear();
  const inp = $('gearBody').querySelector(`tr[data-gid="${it.id}"] input[data-gf="name"]`);
  inp?.scrollIntoView({ block: 'center' }); inp?.focus();
}
async function gearDelete(id) {
  const it = gItem(id); if (!it) return;
  if (!confirm(`‘${it.name || '(이름 없음)'}’ 항목을 삭제할까요?${it.imgs.length ? `\n그림 ${it.imgs.length}장도 함께 지워져요.` : ''}`)) return;
  G.items = G.items.filter((x) => x.id !== id);
  for (const im of it.imgs) forgetImg(im);
  saveGear();
  renderGear();
}
async function gearAddImgs(id, files) {
  const it = gItem(id); if (!it || !files.length) return;
  toast('그림 넣는 중…');
  let ok = 0;
  for (const f of files) {
    try { const im = gid(); await imgPut(im, await shrink(f)); it.imgs.push(im); G.upq.push(im); ok++; } catch {}
  }
  saveGear(); renderGear();
  toast(ok ? `그림 ${ok}장 추가했어요` : '그림을 넣지 못했어요');
}
async function gearDelImg(id, im) {
  const it = gItem(id); if (!it) return;
  if (!confirm('이 그림을 삭제할까요?')) return;
  it.imgs = it.imgs.filter((x) => x !== im);
  forgetImg(im); saveGear();
  renderGear();
}
function forgetImg(im) { // 아직 안 올린 사진이면 올릴 목록에서만 빼고, 올린 사진이면 서버에서도 지운다
  if (G.upq.includes(im)) G.upq = G.upq.filter((x) => x !== im); else G.delq.push(im);
  dropURL(im); imgDel(im).catch(() => {});
}
function gearViewImgs(id) {
  const it = gItem(id); if (!it?.imgs.length) return;
  openSheet(it.name || '그림', it.imgs.map((im) => `<img class="g-big" data-gimg="${im}" alt="">`).join(''), fillImgs);
}

$('btnGearEdit').onclick = () => {
  if (gearEdit) { // 완료 — 이름 빈 항목은 정리하고 바로 올린다
    const empty = G.items.filter((x) => !x.name.trim() && !x.imgs.length);
    if (empty.length) { G.items = G.items.filter((x) => !empty.includes(x)); saveGear(); }
    gearEdit = false; renderGear(); pushGear();
    return;
  }
  gearEdit = true; renderGear();
};
$('btnGearAdd').onclick = gearAdd;
$('btnGearReset').onclick = () => {
  if (!confirm('체크를 모두 해제할까요?')) return;
  G.items.forEach((x) => { x.done = false; }); saveGear(); renderGear();
};

const gearBox = $('gearBody');
gearBox.addEventListener('change', (e) => {
  const el = e.target, row = el.closest('tr[data-gid]'); if (!row) return;
  const it = gItem(row.dataset.gid); if (!it) return;
  if (el.dataset.gcheck != null) { it.done = el.checked; row.classList.toggle('done', it.done); saveGear(); renderGearCount(); }
  else if (el.dataset.gimgadd != null) { gearAddImgs(it.id, [...el.files]); el.value = ''; }
  else if (el.dataset.gf) { it[el.dataset.gf] = el.dataset.gf === 'qty' ? Math.max(0, parseInt(el.value, 10) || 0) : el.value.trim(); saveGear(); }
});
gearBox.addEventListener('input', (e) => { // 입력 도중 앱이 꺼져도 남도록
  const el = e.target; if (!el.dataset.gf || el.dataset.gf === 'cat') return;
  const it = gItem(el.closest('tr[data-gid]')?.dataset.gid); if (!it) return;
  it[el.dataset.gf] = el.dataset.gf === 'qty' ? Math.max(0, parseInt(el.value, 10) || 0) : el.value; saveGear();
});
gearBox.addEventListener('click', (e) => {
  const el = e.target.closest('[data-gdel],[data-gimgdel],[data-gview]'); if (!el) return;
  if (el.dataset.gdel != null) gearDelete(el.dataset.gdel);
  else if (el.dataset.gimgdel != null) { const [id, im] = el.dataset.gimgdel.split('|'); gearDelImg(id, im); }
  else if (el.dataset.gview != null) gearViewImgs(el.dataset.gview);
});
function renderGearCount() {
  const n = G.items.length, d = G.items.filter((x) => x.done).length;
  $('gearCount').textContent = `${d} / ${n} 챙김`;
  $('btnGearReset').hidden = !d;
}
