'use strict';
/* 캠핑장 찾기
 *
 * 데이터: data/camps.json — 공공데이터포털 15037499 「한국관광공사 전국 야영장 등록 현황」 + 카카오 주소검색 좌표.
 * 이동시간: ① 직선거리 추정식(아래 MODEL) 으로 후보를 고르고
 *           ② 화면에 보이는 곳부터 camping-api(카카오 미래 운행 길찾기)로 실제 예측 소요시간을 받아 바꾼다.
 * 날씨: Open-Meteo (키 없음) — 출발일(금/토) 하루 예보.
 */

const API = 'https://camping-api.junyoung-cha83.workers.dev';
const KAKAO_JS = '019b97d0c76fb5348823c510c2961cea'; // 카카오 JS 키 — 등록된 도메인에서만 동작(주유비교앱과 같은 키)

// 직선거리(km) → 예측 소요시간(분). tools/calib.json: 서울·대전·부산 출발, 직선 0~230km 야영장 149곳 ×
// 금 15:00 / 토 10:00 카카오 미래 운행 길찾기 298건으로 맞춘 직선식. 80% 가 실제의 ±17% 안.
const MODEL = { fri: { a: 34.9, b: 0.883 }, sat: { a: 37.8, b: 0.915 } };
const CAND_RATIO = 0.8; // 추정 × 0.8 이 제한 이내면 후보 — 실제가 추정보다 빠른 곳(하위 10% ≈ 0.84)을 놓치지 않게

const SLOTS = { fri: { day: 5, h: 15, label: '금' }, sat: { day: 6, h: 10, label: '토' } };
const TYPES = ['일반야영장', '오토캠핑', '글램핑', '카라반', '개인카라반 사이트'];
const TYPE_SHORT = ['일반', '오토', '글램핑', '카라반', '개인카라반'];
const PETS = ['반려동물 불가', '소형견 가능', '반려동물 가능'];
const PAGE = 40;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nice = (s) => s.replace('마트.편의점', '마트·편의점').replace('트렘폴린', '트램폴린');

/* ───────────── 상태 ───────────── */
const DEF = {
  origin: null, saved: [], slot: 'fri', limit: 120, sort: 'time', view: 'card', tab: 'map', token: '',
  f: { types: [], fac: [], env: [], pet: 0, sido: [] }, favs: {},
};
let S = load();
function load() {
  try { const v = JSON.parse(localStorage.getItem('camp-state') || '{}'); return { ...DEF, ...v, f: { ...DEF.f, ...(v.f || {}) } }; }
  catch { return structuredClone(DEF); }
}
function save() { try { localStorage.setItem('camp-state', JSON.stringify(S)); } catch {} }

let CAMPS = [], META = null, ENV = [], SIDOS = [];
const RT = {};          // 실제 예측시간 { rtKey: { id: {min,km}|null } }
const PENDING = new Set(), FAIL = new Set();
const WX = {};          // 날씨 { 'date:lat,lng': {c,mx,mn,pp} | null }
let shown = PAGE, autoBudget = 0, tokenBad = false;

/* ───────────── 시간·거리 ───────────── */
function slotDate(slot = S.slot) {
  const s = SLOTS[slot], now = new Date(), d = new Date(now);
  d.setHours(s.h, 0, 0, 0);
  d.setDate(d.getDate() + ((s.day - d.getDay() + 7) % 7));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const whenStr = (slot = S.slot) => { const d = slotDate(slot); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}00`; };
const rtKey = (slot = S.slot) => S.origin ? `${whenStr(slot)}|${S.origin.lng.toFixed(3)},${S.origin.lat.toFixed(3)}` : '';

function hav(lng1, lat1, lng2, lat2) {
  const t = (x) => x * Math.PI / 180, R = 6371;
  const h = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const estMin = (km, slot = S.slot) => Math.round(MODEL[slot].a + MODEL[slot].b * km);
function fmtMin(m) {
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
// 캠핑장 하나의 이동 정보. real 이 있으면 카카오 예측값, 없으면 직선식 추정.
function trip(c, slot = S.slot) {
  if (!S.origin) return null;
  const line = hav(S.origin.lng, S.origin.lat, c.x, c.y);
  const tbl = RT[rtKey(slot)] || {};
  if (c.id in tbl) {
    const r = tbl[c.id];
    return r ? { min: r.min, km: r.km, real: true, line } : { min: null, km: null, real: true, none: true, line };
  }
  return { min: estMin(line, slot), km: line, real: false, line };
}
function inLimit(t) {
  if (!S.limit || !t) return true;
  if (t.real) return !t.none && t.min <= S.limit;
  return t.min * CAND_RATIO <= S.limit;
}

/* ───────────── 필터 ───────────── */
const favKey = (c) => c.n + '|' + c.a;
const isFav = (c) => !!S.favs[favKey(c)];
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
function envOf(c) {
  if (!c._env) c._env = new Set([...c.th.map((i) => META.theme[i]), ...c.nb.map((i) => META.near[i])]);
  return c._env;
}
function passFilters(c) {
  const f = S.f;
  if (f.types.length && !f.types.some((i) => c.t[i] > 0)) return false;
  if (f.fac.length && !f.fac.every((i) => c.f.includes(i))) return false;
  if (f.env.length && !f.env.some((l) => envOf(c).has(l))) return false;
  if (f.pet === 1 && !(c.p >= 1)) return false;
  if (f.pet === 2 && c.p !== 2) return false;
  if (f.sido.length && !f.sido.includes(c.s)) return false;
  return true;
}
function filterCount() { const f = S.f; return f.types.length + f.fac.length + f.env.length + (f.pet ? 1 : 0) + f.sido.length; }

// 지금 화면 기준 결과: [{c, t}] — 즐겨찾기 탭은 거리·필터를 무시하고 즐겨찾기 전부
function results() {
  const q = norm($('q').value || '');
  const fav = S.tab === 'fav';
  const out = [];
  for (const c of CAMPS) {
    if (fav ? !isFav(c) : !passFilters(c)) continue;
    if (q && !c._q.includes(q)) continue;
    const t = trip(c);
    if (!fav && !inLimit(t)) continue;
    out.push({ c, t });
  }
  const by = {
    time: (a, b) => (a.t?.min ?? 1e9) - (b.t?.min ?? 1e9),
    dist: (a, b) => (a.t?.km ?? 1e9) - (b.t?.km ?? 1e9),
    name: (a, b) => a.c.n.localeCompare(b.c.n, 'ko'),
    region: (a, b) => (a.c.s + a.c.g).localeCompare(b.c.s + b.c.g, 'ko') || a.c.n.localeCompare(b.c.n, 'ko'),
  };
  const sort = !S.origin && (S.sort === 'time' || S.sort === 'dist') ? 'region' : S.sort;
  out.sort(by[sort]);
  return out;
}

/* ───────────── 실제 예측시간 (camping-api) ───────────── */
async function ensureTimes(list) {
  if (!S.token || tokenBad || !S.origin) return 0;
  const k = rtKey(), tbl = RT[k] || (RT[k] = {});
  const need = list.filter((c) => !(c.id in tbl) && !PENDING.has(c.id) && !FAIL.has(k + c.id)).slice(0, 30);
  if (!need.length) return 0;
  need.forEach((c) => PENDING.add(c.id));
  try {
    const r = await fetch(API + '/api/times', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token },
      body: JSON.stringify({ origin: { lng: S.origin.lng, lat: S.origin.lat }, when: whenStr(), dests: need.map((c) => ({ id: c.id, lng: c.x, lat: c.y })) }),
    });
    if (r.status === 401) { tokenBad = true; toast('API 토큰이 맞지 않아요. ⚙︎ 설정에서 확인해 주세요'); return 0; }
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (rtKey() !== k) return 0; // 그사이 기준점·출발시간이 바뀜
    for (const c of need) { if (c.id in j.times) tbl[c.id] = j.times[c.id]; else FAIL.add(k + c.id); }
    return need.length;
  } catch (e) {
    need.forEach((c) => FAIL.add(k + c.id));
    toast('실제 이동시간을 못 받았어요 — 추정치로 보여줍니다');
    return 0;
  } finally {
    need.forEach((c) => PENDING.delete(c.id));
    scheduleRender();
  }
}

/* ───────────── 날씨 (Open-Meteo) ───────────── */
const WMO = (c) => c == null ? '' : c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 57 ? '🌦️' : c <= 67 ? '🌧️' : c <= 77 ? '🌨️' : c <= 82 ? '🌧️' : c <= 86 ? '🌨️' : '⛈️';
const wxKey = (c, date) => `${date}:${c.y.toFixed(1)},${c.x.toFixed(1)}`;
const WX_PENDING = new Set();
async function ensureWeather(list) {
  const date = ymd(slotDate());
  const need = [], seen = new Set();
  for (const c of list) {
    const k = wxKey(c, date);
    if (k in WX || WX_PENDING.has(k) || seen.has(k)) continue;
    seen.add(k); need.push({ k, lat: +c.y.toFixed(1), lng: +c.x.toFixed(1) });
  }
  for (let i = 0; i < need.length; i += 50) {
    const part = need.slice(i, i + 50);
    part.forEach((p) => WX_PENDING.add(p.k));
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${part.map((p) => p.lat).join(',')}&longitude=${part.map((p) => p.lng).join(',')}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&start_date=${date}&end_date=${date}`;
      const r = await fetch(u);
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      part.forEach((p, n) => {
        const d = arr[n]?.daily;
        WX[p.k] = d && d.weather_code?.[0] != null
          ? { c: d.weather_code[0], mx: Math.round(d.temperature_2m_max[0]), mn: Math.round(d.temperature_2m_min[0]), pp: d.precipitation_probability_max?.[0] }
          : null; // 예보 범위 밖 등
      });
    } catch { part.forEach((p) => { WX[p.k] = null; }); }
    finally { part.forEach((p) => WX_PENDING.delete(p.k)); }
  }
  if (need.length) scheduleRender();
}
function wxText(c) {
  const w = WX[wxKey(c, ymd(slotDate()))];
  if (w === undefined) return '…';
  if (!w) return '-';
  const pp = w.pp != null ? ` 💧${w.pp}%` : '';
  return `${WMO(w.c)} ${w.mn}°/${w.mx}°${pp}`;
}

/* ───────────── 링크·복사 ───────────── */
const clean = (s) => s.replace(/[,/]/g, ' ');
const kakaoMap = (c) => `https://map.kakao.com/link/map/${encodeURIComponent(clean(c.n))},${c.y},${c.x}`;
const kakaoTo = (c) => `https://map.kakao.com/link/to/${encodeURIComponent(clean(c.n))},${c.y},${c.x}`;
const goCamping = (c) => `https://www.gocamping.or.kr/bsite/camp/info/list.do?searchKrwd=${encodeURIComponent(c.n)}`;
const naver = (c) => `https://search.naver.com/search.naver?query=${encodeURIComponent(c.n + ' ' + c.g)}`;
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch {}
    t.remove();
  }
  toast('주소를 복사했어요');
}
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200); }

/* ───────────── 목록 렌더 ───────────── */
function timeHTML(t) {
  if (!t) return '';
  if (t.none) return `<span class="tm over">길찾기 결과 없음</span>`;
  const over = S.limit && t.min > S.limit;
  return `<span class="tm${t.real ? '' : ' est'}${over ? ' over' : ''}">${t.real ? '' : '~'}${fmtMin(t.min)} <small>${t.real ? '예측' : '추정'}</small></span>`;
}
function distHTML(t) {
  if (!t || t.none) return '';
  return `<span class="dist">${Math.round(t.km)}km <small>${t.real ? '도로' : '직선'}</small></span>`;
}
function typeTags(c) {
  const t = c.t.map((n, i) => n > 0 ? `<span class="tag t">${TYPE_SHORT[i]}</span>` : '').join('');
  return (t || '<span class="tag">유형 미기재</span>') +
    (c.p != null ? `<span class="tag p">${c.p === 0 ? '🐾✕' : c.p === 1 ? '🐾소형견' : '🐾가능'}</span>` : '');
}
function actsHTML(c) {
  return `<div class="acts">
    <button data-copy="${c.id}">📋 주소복사</button>
    <a href="${kakaoMap(c)}" target="_blank" rel="noopener">🗺️ 지도</a>
    <a href="${kakaoTo(c)}" target="_blank" rel="noopener">🧭 길찾기</a>
    <a href="${goCamping(c)}" target="_blank" rel="noopener">⛺ 고캠핑</a>
  </div>`;
}
function cardHTML({ c, t }) {
  return `<div class="card">
    <div class="card-h"><button class="nm" data-open="${c.id}">${esc(c.n)}</button><button class="star${isFav(c) ? ' on' : ''}" data-fav="${c.id}" aria-label="즐겨찾기">★</button></div>
    <div class="rg">${esc(c.s)} ${esc(c.g)}${c.ap ? ' · <span class="warn">위치 대략</span>' : ''}</div>
    <div class="facts">${timeHTML(t)}${distHTML(t)}<span class="wx">${wxText(c)}</span></div>
    <div class="tags">${typeTags(c)}</div>
    ${actsHTML(c)}
  </div>`;
}
function tableHTML(list) {
  const rows = list.map(({ c, t }) => `<tr>
    <td><button class="star${isFav(c) ? ' on' : ''}" data-fav="${c.id}" aria-label="즐겨찾기">★</button></td>
    <td class="nm"><button data-open="${c.id}">${esc(c.n)}</button></td>
    <td>${esc(c.s.replace(/(특별자치도|특별자치시|특별시|광역시|통합특별시|도)$/, ''))} ${esc(c.g)}</td>
    <td>${t ? timeHTML(t) : '-'}</td><td>${t ? distHTML(t) : '-'}</td>
    <td>${wxText(c)}</td>
    <td>${c.t.map((n, i) => n > 0 ? TYPE_SHORT[i] : '').filter(Boolean).join('·')}</td>
    <td>${c.p == null ? '-' : ['✕', '소형견', '가능'][c.p]}</td>
    <td><button class="mini" data-copy="${c.id}">복사</button></td>
  </tr>`).join('');
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>★</th><th>이름</th><th>지역</th><th>이동시간</th><th>거리</th><th>날씨</th><th>유형</th><th>반려견</th><th>주소</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

function renderHeader() {
  $('originName').textContent = S.origin ? S.origin.name : '기준점을 정해 주세요';
  document.querySelectorAll('#segSlot button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.slot));
  document.querySelectorAll('#segLimit button').forEach((b) => b.classList.toggle('on', +b.dataset.v === S.limit));
  document.querySelectorAll('#segView button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('sortSel').value = S.sort;
  const n = filterCount(); $('filterCount').hidden = !n; $('filterCount').textContent = n;
  const d = slotDate();
  $('whenNote').textContent = `출발 ${d.getMonth() + 1}/${d.getDate()}(${SLOTS[S.slot].label}) ${pad(d.getHours())}:00 기준 · 날씨도 이날 예보` +
    (S.token && !tokenBad ? '' : ' · 이동시간은 추정치(⚙︎ 토큰 넣으면 실제 예측)');
  $('tabMap').hidden = S.tab !== 'map';
  $('tabList').hidden = S.tab === 'map';
}

function render() {
  renderHeader();
  const res = results();
  if (S.tab === 'map') { renderMap(res); return; }
  const list = res.slice(0, shown);
  const fav = S.tab === 'fav';
  const real = res.filter((r) => r.t?.real).length;
  $('listCount').textContent = fav ? `즐겨찾기 ${res.length}곳`
    : `${res.length.toLocaleString()}곳` + (S.origin && S.limit ? ` (실제 확인 ${real.toLocaleString()})` : '');
  if (!res.length) {
    $('listBody').innerHTML = `<div class="empty">${fav ? '아직 즐겨찾기가 없어요.<br>목록이나 지도에서 ★을 눌러 추가하세요.' : '조건에 맞는 캠핑장이 없어요.<br>필터나 시간 제한을 바꿔 보세요.'}</div>`;
  } else {
    $('listBody').innerHTML = S.view === 'table' ? tableHTML(list) : list.map(cardHTML).join('');
  }
  $('btnMore').hidden = res.length <= shown;
  $('btnMore').textContent = `더 보기 (${Math.min(PAGE, res.length - shown)}곳 더)`;
  const unchecked = S.origin && S.token && !tokenBad && !fav ? res.filter((r) => r.t && !r.t.real).length : 0;
  $('btnCheckAll').hidden = !unchecked;
  $('btnCheckAll').textContent = `전체 실제 이동시간 확인 (${unchecked.toLocaleString()}곳 남음)`;
  ensureWeather(list.map((r) => r.c));
  // 보이는 곳 중 아직 추정인 곳을 실제 예측으로. 예측이 제한을 넘어 빠지면 아래 곳이 올라와 다시 확인 —
  // 그 연쇄가 끝없이 돌지 않게 요청 횟수(autoBudget)로 끊는다. 다시 그리기만 하는 경우엔 깎지 않는다.
  const k = rtKey();
  const todo = list.filter((r) => r.t && !r.t.real && !PENDING.has(r.c.id) && !FAIL.has(k + r.c.id)).map((r) => r.c);
  if (autoBudget > 0 && todo.length && S.token && !tokenBad) {
    autoBudget--;
    ensureTimes(todo);
  }
}

/* ───────────── 지도 (카카오맵) ───────────── */
let map = null, clusterer = null, originMk = null, markers = new Map(), mapFailed = false;
function loadKakao() {
  return new Promise((ok, no) => {
    if (window.kakao?.maps) return kakao.maps.load(ok);
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS}&libraries=services,clusterer&autoload=false`;
    s.onload = () => (window.kakao?.maps ? kakao.maps.load(ok) : no(new Error('sdk')));
    s.onerror = () => no(new Error('sdk'));
    document.head.appendChild(s);
  });
}
const dot = (fill) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="8" fill="${fill}" stroke="#fff" stroke-width="2.5"/></svg>`);
let IMG = null;
function initMap() {
  map = new kakao.maps.Map($('map'), { center: new kakao.maps.LatLng(36.4, 127.8), level: 12 });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  clusterer = new kakao.maps.MarkerClusterer({
    map, averageCenter: true, minLevel: 9, gridSize: 50,
    styles: [{ width: '38px', height: '38px', background: 'rgba(47,93,70,.85)', color: '#fff', borderRadius: '19px', textAlign: 'center', lineHeight: '38px', fontWeight: '700', fontSize: '12px', border: '2px solid #fff' }],
  });
  const sz = new kakao.maps.Size(22, 22), op = { offset: new kakao.maps.Point(11, 11) };
  IMG = { real: new kakao.maps.MarkerImage(dot('#2f5d46'), sz, op), est: new kakao.maps.MarkerImage(dot('#8a978f'), sz, op), fav: new kakao.maps.MarkerImage(dot('#f2b01e'), sz, op) };
}
let mapSig = '';
function renderMap(res) {
  if (mapFailed) return;
  if (!map) { $('mapMsg').hidden = false; $('mapMsg').textContent = '지도 불러오는 중…'; return; }
  map.relayout();
  // 같은 결과면 마커를 다시 만들지 않는다
  const sig = rtKey() + '|' + S.limit + '|' + res.length + '|' + res.map((r) => r.c.id + (r.t?.real ? 'r' : '') + (isFav(r.c) ? 'f' : '')).join(',');
  if (sig !== mapSig) {
    mapSig = sig;
    clusterer.clear();
    const mk = res.map(({ c, t }) => {
      const m = new kakao.maps.Marker({ position: new kakao.maps.LatLng(c.y, c.x), image: isFav(c) ? IMG.fav : t?.real ? IMG.real : IMG.est, title: c.n });
      kakao.maps.event.addListener(m, 'click', () => openCamp(c.id));
      return m;
    });
    clusterer.addMarkers(mk);
  }
  if (originMk) originMk.setMap(null);
  if (S.origin) {
    originMk = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(S.origin.lat, S.origin.lng), content: `<div class="mk-o">📍 ${esc(S.origin.name)}</div>`, yAnchor: 1.3 });
    originMk.setMap(map);
  }
  $('mapMsg').hidden = false;
  $('mapMsg').textContent = !S.origin ? `전국 ${res.length.toLocaleString()}곳 · 위의 📍에서 기준점을 정하세요`
    : `${res.length.toLocaleString()}곳 · 초록=실제 예측, 회색=추정, 노랑=즐겨찾기`;
}
function fitOrigin() {
  if (!map || !S.origin) return;
  map.setCenter(new kakao.maps.LatLng(S.origin.lat, S.origin.lng));
  map.setLevel(S.limit === 90 ? 11 : S.limit === 120 ? 11 : 12);
}

/* ───────────── 시트 ───────────── */
let sheetOpen = false;
function openSheet(title, html, onReady) {
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = html;
  $('sheet').hidden = false;
  if (!sheetOpen) { history.pushState({ sheet: 1 }, ''); sheetOpen = true; }
  onReady?.($('sheetBody'));
}
function closeSheet(fromPop) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('sheet').hidden = true;
  if (!fromPop && history.state?.sheet) history.back();
}
addEventListener('popstate', () => closeSheet(true));
$('sheetClose').onclick = () => closeSheet();
document.querySelector('.sheet-bg').onclick = () => closeSheet();

/* 캠핑장 상세 */
function openCamp(id) {
  const c = CAMPS[id];
  const paint = () => {
    const t = trip(c), o = S.slot === 'fri' ? 'sat' : 'fri', t2 = trip(c, o);
    const sizes = (c.z || []).map(([w, h, q]) => `${w}×${h}m${q ? ` ${q}면` : ''}`).join(', ');
    const env = [...envOf(c)];
    const html = `
      <div class="sec"><div class="rg">${esc(c.s)} ${esc(c.g)}</div>
        <div class="facts">${timeHTML(t)}${distHTML(t)}<span class="wx">${wxText(c)}</span></div>
        ${t2 ? `<div class="rg">${SLOTS[o].label} ${pad(SLOTS[o].h)}:00 출발이면 ${t2.none ? '길찾기 결과 없음' : (t2.real ? '' : '~') + fmtMin(t2.min) + (t2.real ? ' (예측)' : ' (추정)')}</div>` : ''}
        <div class="acts" style="margin-top:.4rem"><button class="star${isFav(c) ? ' on' : ''}" data-fav="${c.id}" style="flex:none;font-size:1.1rem">★ 즐겨찾기</button></div>
      </div>
      <dl class="info">
        <dt>주소</dt><dd class="addr-row"><span>${esc(c.a) || '-'}${c.ap ? ' <span class="warn">(지도 위치는 읍·면 단위 대략)</span>' : ''}</span><button class="mini" data-copy="${c.id}">복사</button></dd>
        <dt>유형</dt><dd>${c.t.map((n, i) => n > 0 ? `${TYPES[i]} ${n}면` : '').filter(Boolean).join(', ') || '등록 자료에 미기재'}</dd>
        <dt>사이트 크기</dt><dd>${sizes || '-'}</dd>
        <dt>부대시설</dt><dd>${c.f.map((i) => nice(META.fac[i])).join(', ') || '-'}</dd>
        <dt>환경·주변</dt><dd>${env.join(', ') || '-'}</dd>
        <dt>반려동물</dt><dd>${c.p == null ? '정보 없음' : PETS[c.p]}</dd>
        <dt>등록일</dt><dd>${esc(c.d || '-')}</dd>
      </dl>
      ${actsHTML(c)}
      <div class="acts"><a href="${naver(c)}" target="_blank" rel="noopener">🔎 네이버 검색 (홈페이지·예약·전화)</a></div>
      <p class="sec note">홈페이지·예약·전화번호는 공공데이터에 없어서 고캠핑·네이버 검색으로 연결합니다. 등록 현황 기준이라 실제 운영 여부는 예약 전에 확인하세요.</p>`;
    $('sheetBody').innerHTML = html;
  };
  openSheet(c.n, '', paint);
  const k = rtKey();
  Promise.all([ensureTimes([c]), ensureWeather([c])]).then(() => { if (sheetOpen && $('sheetTitle').textContent === c.n && rtKey() === k) paint(); });
}

/* 기준점 */
function openOrigin() {
  const saved = S.saved.map((o, i) => `<li><button class="pick" data-saved="${i}">⭐ ${esc(o.name)}<small>${esc(o.addr || '')}</small></button><button class="del" data-del="${i}">삭제</button></li>`).join('');
  openSheet('기준점 선택', `
    <div class="sec"><button class="btn wide" id="oGps">📡 현재 위치로</button></div>
    <div class="sec"><h4>장소·주소 검색</h4>
      <div class="srch"><input id="oQ" type="search" placeholder="예: 우리집 주소, 강남역, 판교" autocomplete="off"><button id="oGo">검색</button></div>
      <ul class="olist" id="oRes"></ul></div>
    <div class="sec"><h4>저장한 기준점</h4>${saved ? `<ul class="olist">${saved}</ul>` : '<p class="note">검색 결과에서 ‘저장’을 누르면 여기에 남아요.</p>'}</div>`, (b) => {
    b.querySelector('#oGps').onclick = gps;
    const go = () => searchPlace(b.querySelector('#oQ').value.trim(), b.querySelector('#oRes'));
    b.querySelector('#oGo').onclick = go;
    b.querySelector('#oQ').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}
function setOrigin(o) {
  S.origin = { name: o.name, lng: +o.lng, lat: +o.lat, addr: o.addr || '' };
  save(); resetView(); closeSheet(); fitOrigin(); render();
}
function gps() {
  if (!navigator.geolocation) return toast('이 기기는 위치를 쓸 수 없어요');
  toast('현재 위치 확인 중…');
  navigator.geolocation.getCurrentPosition((p) => {
    const lng = p.coords.longitude, lat = p.coords.latitude;
    const done = (name) => setOrigin({ name: '현재 위치' + (name ? ` (${name})` : ''), lng, lat, addr: name });
    if (window.kakao?.maps?.services) new kakao.maps.services.Geocoder().coord2RegionCode(lng, lat, (r, st) => done(st === 'OK' ? r[0]?.address_name : ''));
    else done('');
  }, () => toast('위치 권한이 필요해요'), { enableHighAccuracy: false, timeout: 10000 });
}
function searchPlace(q, ul) {
  if (!q) return;
  if (!window.kakao?.maps?.services) { ul.innerHTML = '<li class="note">지도 서비스를 못 불러와 검색할 수 없어요.</li>'; return; }
  const show = (items) => {
    ul.innerHTML = items.length ? items.map((p, i) => `<li><button class="pick" data-r="${i}">${esc(p.name)}<small>${esc(p.addr)}</small></button><button class="del" data-keep="${i}">저장</button></li>`).join('')
      : '<li class="note">결과가 없어요.</li>';
    ul.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => setOrigin(items[+b.dataset.r]); });
    ul.querySelectorAll('[data-keep]').forEach((b) => {
      b.onclick = () => {
        const p = items[+b.dataset.keep];
        if (!S.saved.some((s) => s.lng === +p.lng && s.lat === +p.lat)) S.saved.push({ name: p.name, lng: +p.lng, lat: +p.lat, addr: p.addr });
        save(); setOrigin(p); toast('기준점을 저장했어요');
      };
    });
  };
  new kakao.maps.services.Places().keywordSearch(q, (r, st) => {
    if (st === kakao.maps.services.Status.OK && r.length) return show(r.slice(0, 10).map((p) => ({ name: p.place_name, addr: p.road_address_name || p.address_name, lng: p.x, lat: p.y })));
    new kakao.maps.services.Geocoder().addressSearch(q, (r2, st2) => {
      show(st2 === kakao.maps.services.Status.OK ? r2.slice(0, 10).map((p) => ({ name: p.address_name, addr: p.road_address?.address_name || '', lng: p.x, lat: p.y })) : []);
    });
  });
}

/* 필터 */
function openFilter() {
  const f = structuredClone(S.f);
  const chip = (grp, v, label, on) => `<button class="chip${on ? ' on' : ''}" data-g="${grp}" data-v="${esc(v)}">${esc(label)}</button>`;
  const body = () => `
    <div class="sec"><h4>유형 (하나라도 있으면)</h4><div class="chips">${TYPES.map((l, i) => chip('types', i, l, f.types.includes(i))).join('')}</div>
      <p class="note">바베큐장은 공공데이터 항목에 없어서 필터로 고를 수 없어요.</p></div>
    <div class="sec"><h4>시설 (모두 있는 곳)</h4><div class="chips">${META.fac.map((l, i) => chip('fac', i, nice(l), f.fac.includes(i))).join('')}</div></div>
    <div class="sec"><h4>환경·주변 (하나라도 있으면)</h4><div class="chips">${ENV.map((l) => chip('env', l, l, f.env.includes(l))).join('')}</div></div>
    <div class="sec"><h4>반려동물</h4><div class="chips">${['상관없음', '소형견 이상 가능', '대형견도 가능'].map((l, i) => chip('pet', i, l, f.pet === i)).join('')}</div></div>
    <div class="sec"><h4>지역</h4><div class="chips">${SIDOS.map((s) => chip('sido', s, s, f.sido.includes(s))).join('')}</div></div>
    <div class="sheet-foot"><button id="fReset">초기화</button><button class="pri" id="fApply">적용</button></div>`;
  openSheet('필터', body(), function wire(b) {
    b.querySelectorAll('.chip').forEach((el) => {
      el.onclick = () => {
        const g = el.dataset.g, raw = el.dataset.v, v = g === 'types' || g === 'fac' || g === 'pet' ? +raw : raw;
        if (g === 'pet') f.pet = v;
        else { const a = f[g], i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); }
        b.innerHTML = body(); wire(b);
      };
    });
    b.querySelector('#fReset').onclick = () => { Object.assign(f, structuredClone(DEF.f)); b.innerHTML = body(); wire(b); };
    b.querySelector('#fApply').onclick = () => { S.f = f; save(); resetView(); closeSheet(); render(); };
  });
}

/* 설정 */
function openSettings() {
  openSheet('설정', `
    <div class="sec"><h4>실제 이동시간 (카카오 미래 운행 길찾기)</h4>
      <label class="field">API 토큰<input id="sTok" type="password" value="${esc(S.token)}" placeholder="camp로 시작하는 토큰" autocomplete="off"></label>
      <button class="btn" id="sSave">저장·연결 확인</button> <span id="sMsg" class="note"></span>
      <p class="note">토큰이 없으면 직선거리로 추정한 시간만 보여요. 토큰은 이 기기에만 저장됩니다.</p></div>
    <div class="sec"><h4>이동시간 계산 방식</h4>
      <p class="note">① 기준점→캠핑장 직선거리로 시간을 추정해 후보를 고릅니다(금 15:00 ≈ 35분 + 직선 1km당 0.88분, 토 10:00 ≈ 38분 + 0.92분 — 서울·대전·부산 출발 실제 예측 298건으로 맞춘 식, 80%가 ±17% 안).<br>
      ② 목록에 보이는 곳부터 카카오내비의 그 날짜·시각 출발 예측 소요시간으로 바꿉니다(‘예측’ 표시). 예측이 제한을 넘으면 목록에서 빠집니다.<br>
      거리도 예측 전엔 직선, 예측 후엔 도로 거리입니다.</p></div>
    <div class="sec"><h4>데이터</h4>
      <p class="note">${esc(META.source)} — ${META.count.toLocaleString()}곳. 좌표는 카카오 주소 검색으로 붙였고, 주소로 못 찾은 몇 곳은 ‘위치 대략’으로 표시됩니다.<br>
      날씨: Open-Meteo 일 예보(출발일 하루, 최저/최고·강수확률). 약 16일 이후는 ‘-’.</p></div>`, (b) => {
    b.querySelector('#sSave').onclick = async () => {
      S.token = b.querySelector('#sTok').value.trim(); tokenBad = false; save();
      const msg = b.querySelector('#sMsg'); msg.textContent = '확인 중…';
      try {
        const r = await fetch(API + '/api/times', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': S.token }, body: '{}' });
        msg.textContent = r.status === 401 ? '❌ 토큰이 맞지 않아요' : '✅ 연결됨';
        if (r.status === 401) tokenBad = true;
      } catch { msg.textContent = '❌ 서버에 연결하지 못했어요'; }
      resetView(); render();
    };
  });
}

/* ───────────── 이벤트 ───────────── */
function resetView() { shown = PAGE; autoBudget = 8; $('tabList').scrollTop = 0; }
$('btnOrigin').onclick = openOrigin;
$('btnFilter').onclick = openFilter;
$('btnSettings').onclick = openSettings;
const seg = (id, key, conv) => document.querySelectorAll(`#${id} button`).forEach((b) => {
  b.onclick = () => { S[key] = conv(b.dataset.v); save(); resetView(); if (key === 'limit') fitOrigin(); render(); };
});
seg('segSlot', 'slot', String);
seg('segLimit', 'limit', Number);
seg('segView', 'view', String);
$('sortSel').onchange = (e) => { S.sort = e.target.value; save(); resetView(); render(); };
let qT;
$('q').oninput = () => { clearTimeout(qT); qT = setTimeout(() => { resetView(); render(); }, 200); };
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => { S.tab = b.dataset.tab; save(); resetView(); render(); };
});
$('btnMore').onclick = () => { shown += PAGE; autoBudget = 8; render(); };
$('btnCheckAll').onclick = async () => {
  const left = results().filter((r) => r.t && !r.t.real).map((r) => r.c);
  if (left.length > 300 && !confirm(`${left.length.toLocaleString()}곳을 확인합니다(카카오 하루 사용량을 씁니다). 계속할까요?`)) return;
  const btn = $('btnCheckAll'); btn.disabled = true;
  for (let i = 0; i < left.length; i += 30) {
    btn.textContent = `확인 중… ${Math.min(i + 30, left.length)}/${left.length}`;
    await ensureTimes(left.slice(i, i + 30));
    if (tokenBad) break;
  }
  btn.disabled = false; render();
};
// 목록·시트 안의 버튼(복사·즐겨찾기·상세)
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-copy],[data-fav],[data-open],[data-saved],[data-del]');
  if (!el) return;
  if (el.dataset.copy != null) copy(CAMPS[+el.dataset.copy].a);
  else if (el.dataset.fav != null) {
    const c = CAMPS[+el.dataset.fav], k = favKey(c);
    if (S.favs[k]) delete S.favs[k]; else S.favs[k] = 1;
    save();
    document.querySelectorAll(`[data-fav="${c.id}"]`).forEach((s) => s.classList.toggle('on', !!S.favs[k]));
    toast(S.favs[k] ? '즐겨찾기에 추가했어요' : '즐겨찾기에서 뺐어요');
    if (S.tab !== 'list') { mapSig = ''; if (!sheetOpen) render(); }
  } else if (el.dataset.open != null) openCamp(+el.dataset.open);
  else if (el.dataset.saved != null) setOrigin(S.saved[+el.dataset.saved]);
  else if (el.dataset.del != null) { S.saved.splice(+el.dataset.del, 1); save(); openOrigin(); } // 열린 시트 내용만 바꾼다
});

/* ───────────── 시작 ───────────── */
(async function start() {
  const r = await fetch('data/camps.json');
  const j = await r.json();
  META = j.meta; CAMPS = j.camps;
  for (const c of CAMPS) c._q = norm(c.n + c.s + c.g + c.a);
  ENV = [...new Set([...META.theme, ...META.near])];
  SIDOS = [...new Set(CAMPS.map((c) => c.s))].sort((a, b) => a.localeCompare(b, 'ko'));
  resetView();
  render();
  loadKakao().then(() => { initMap(); fitOrigin(); render(); })
    .catch(() => {
      mapFailed = true;
      $('mapMsg').hidden = false;
      $('mapMsg').textContent = '지도를 불러오지 못했어요 — 📋 목록 탭을 이용하세요';
    });
  if (!S.origin) setTimeout(openOrigin, 300);
})();

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
