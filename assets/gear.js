'use strict';
/* 준비물 탭 — app.js 다음에 읽힌다($, esc, toast, openSheet, closeSheet 를 같이 쓴다).
 *
 * 목록: localStorage 'camp-gear' = { items:[{ id, cat, name, qty, note, imgs:[이미지id], done }] } — 기기별 저장.
 * 그림: IndexedDB 'camp-gear' / 'img' (id → Blob). 긴 변 1280px JPEG 로 줄여 넣는다.
 * 평소: 첫 열 체크 → 그 행이 회색. ✏️ 수정 누르면 추가·삭제·내용 수정·그림 추가/삭제.
 */

const GEAR_CATS = ['텐트', '침구류', '주방류', '음식', '난방류', '전자', '놀이', '옷/세면'];
const GEAR_SEED = [
  ['텐트', '텐트', 1, ''], ['텐트', '타프', 1, ''], ['텐트', '팩·망치', 1, ''], ['텐트', '그라운드시트', 1, ''],
  ['침구류', '침낭', 4, ''], ['침구류', '매트', 4, ''], ['침구류', '베개', 4, ''],
  ['주방류', '버너·가스', 1, ''], ['주방류', '코펠·냄비', 1, ''], ['주방류', '수저·컵', 4, ''], ['주방류', '아이스박스', 1, ''],
  ['음식', '물', 1, ''], ['음식', '고기·반찬', 1, ''],
  ['난방류', '화로대', 1, ''], ['난방류', '난로', 1, '겨울'],
  ['전자', '랜턴', 2, ''], ['전자', '릴선(전기)', 1, ''], ['전자', '보조배터리', 1, ''],
  ['놀이', '보드게임', 1, ''],
  ['옷/세면', '여벌옷', 4, ''], ['옷/세면', '세면도구', 1, ''], ['옷/세면', '수건', 4, ''],
];

const gid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let G = loadGear();
let gearEdit = false;

function loadGear() {
  try {
    const v = JSON.parse(localStorage.getItem('camp-gear') || 'null');
    if (v && Array.isArray(v.items)) return v;
  } catch {}
  return { items: GEAR_SEED.map(([cat, name, qty, note]) => ({ id: gid(), cat, name, qty, note, imgs: [], done: false })) };
}
function saveGear() { try { localStorage.setItem('camp-gear', JSON.stringify(G)); } catch { toast('저장 공간이 부족해요'); } }
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
  const b = await imgGet(id).catch(() => null);
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
  G.items = G.items.filter((x) => x.id !== id); saveGear();
  for (const im of it.imgs) { dropURL(im); imgDel(im).catch(() => {}); }
  renderGear();
}
async function gearAddImgs(id, files) {
  const it = gItem(id); if (!it || !files.length) return;
  toast('그림 넣는 중…');
  let ok = 0;
  for (const f of files) {
    try { const im = gid(); await imgPut(im, await shrink(f)); it.imgs.push(im); ok++; } catch {}
  }
  saveGear(); renderGear();
  toast(ok ? `그림 ${ok}장 추가했어요` : '그림을 넣지 못했어요');
}
async function gearDelImg(id, im) {
  const it = gItem(id); if (!it) return;
  if (!confirm('이 그림을 삭제할까요?')) return;
  it.imgs = it.imgs.filter((x) => x !== im); saveGear();
  dropURL(im); imgDel(im).catch(() => {});
  renderGear();
}
function gearViewImgs(id) {
  const it = gItem(id); if (!it?.imgs.length) return;
  openSheet(it.name || '그림', it.imgs.map((im) => `<img class="g-big" data-gimg="${im}" alt="">`).join(''), fillImgs);
}

$('btnGearEdit').onclick = () => {
  if (gearEdit) { // 완료 — 이름 빈 항목은 정리
    const empty = G.items.filter((x) => !x.name.trim() && !x.imgs.length);
    if (empty.length) { G.items = G.items.filter((x) => !empty.includes(x)); saveGear(); }
  }
  gearEdit = !gearEdit; renderGear();
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
