// 데이터 파일 만들기: node tools/build.mjs
//
//  입력  tools/rows.json       공공데이터포털 15037499 「한국관광공사 전국 야영장 등록 현황」 CSV 를 JSON 으로
//        tools/geo.json        rows 순번 → 카카오 주소검색 좌표 {x,y,m}  (m='area' 면 읍·면 단위 대략)
//        tools/gocamping.json  한국관광공사 고캠핑 basedList 전체 (camping-api /api/gocamping 으로 받음)
//  출력  data/camps.json       목록·지도·필터에 쓰는 가벼운 데이터
//        data/detail.json      상세 화면에서만 쓰는 소개글 등 (열 때 한 번 받음)
//
// 짝짓기: 2km 안에서 이름 유사도(2글자 묶음 Dice)가 가장 높은 곳, 주소가 같으면 가산, 점수 높은 순 1:1.
// 짝이 맞으면 이름·좌표·연락처는 고캠핑(최신) 을 쓰고, 등록 이름이 다르면 rn 에 남긴다.
import fs from 'fs';
const R = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const rows = R('./rows.json'), geo = R('./geo.json'), go = R('./gocamping.json');

const FAC = ['전기', '온수', '무선인터넷', '장작판매', '마트.편의점', '놀이터', '트렘폴린', '물놀이장', '산책로', '운동시설', '운동장', '덤프스테이션'];
const THEME = ['여름물놀이', '가을단풍명소', '봄꽃여행', '겨울눈꽃명소', '걷기길', '일몰명소', '일출명소', '낚시', '수상레저', '액티비티', '스키', '항공레저'];
const NEAR = ['계곡 물놀이', '강/물놀이', '해수욕', '산책로', '낚시', '수상레저', '수영장', '어린이놀이시설', '운동장', '농어촌체험시설', '청소년체험시설'];
const LCT = ['산', '숲', '계곡', '강', '호수', '해변', '섬', '도심'];
const PET = { '불가능': 0, '가능(소형견)': 1, '가능': 2 };
const BRAZ = ['개별', '공동취사장', '불가'];
const tags = (s, lst) => [...new Set((s || '').split(',').map((t) => lst.indexOf(t.trim())).filter((i) => i >= 0))];
const n = (v) => { const x = parseInt(v, 10); return isFinite(x) ? x : 0; };
const url = (s) => { s = (s || '').trim(); if (!s) return ''; return /^https?:\/\//i.test(s) ? s : 'http://' + s; };
const union = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y);

/* 1) 공공데이터 → 기본 항목 */
const base = [];
rows.forEach((r, i) => {
  const g = geo[i]; if (!g) return;
  const z = [];
  for (const k of [1, 2, 3]) { const w = n(r[`사이트 크기${k} 가로`]), h = n(r[`사이트 크기${k} 세로`]), q = n(r[`사이트 크기${k} 수량`]); if (w && h) z.push([w, h, q]); }
  const c = {
    n: r['야영장명'].trim(), s: r['도'].trim(), g: r['시군구'].trim(), a: r['주소'].trim(),
    x: +g.x.toFixed(5), y: +g.y.toFixed(5),
    t: [n(r['주요시설 일반야영장']), n(r['주요시설 자동차야영장']), n(r['주요시설 글램핑']), n(r['주요시설 카라반']), n(r['주요시설 개인 카라반']), 0],
    f: tags(r['부대시설'], FAC), th: tags(r['테마환경'], THEME), nb: tags(r['주변이용가능시설'], NEAR), l: [],
  };
  if (g.m === 'area') c.ap = 1;
  if (r['반려동물출입'] in PET) c.p = PET[r['반려동물출입']];
  if (z.length) c.z = z;
  if (r['인허가일자']) c.d = r['인허가일자'];
  base.push(c);
});

/* 2) 짝짓기 */
const hv = (a, b, c, d) => { const t = (x) => x * Math.PI / 180; const h = Math.sin(t(d - b) / 2) ** 2 + Math.cos(t(b)) * Math.cos(t(d)) * Math.sin(t(c - a) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const nn = (s) => (s || '').replace(/\(.*?\)|주식회사|\(주\)|㈜|농업회사법인|영농조합법인|유한회사/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase();
const core = (s) => nn(s).replace(/(오토캠핑장|캠핑장|야영장|글램핑장|글램핑|카라반|캠핑|캠프|오토)$/g, '') || nn(s);
const bi = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
const dice = (a, b) => {
  if (!a || !b) return 0; if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? .8 : 0;
  const A = bi(a), B = bi(b); let k = 0; for (const [x, v] of A) k += Math.min(v, B.get(x) || 0);
  return 2 * k / (a.length - 1 + b.length - 1);
};
const na = (s) => (s || '').replace(/\s+/g, '').replace(/(특별자치도|특별자치시|광역시|특별시|통합특별시)/g, '');
const grid = new Map(), gk = (x, y) => `${Math.floor(x * 50)},${Math.floor(y * 50)}`;
base.forEach((c, i) => { const k = gk(c.x, c.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
const near = (x, y) => { const o = [], X = Math.floor(x * 50), Y = Math.floor(y * 50); for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) o.push(...(grid.get(`${X + i},${Y + j}`) || [])); return o; };
const pairs = [];
for (const g of go) {
  const x = +g.mapX, y = +g.mapY; if (!x || !y) { pairs.push({ g, best: null }); continue; }
  let best = null;
  for (const i of near(x, y)) {
    const c = base[i], d = hv(x, y, c.x, c.y); if (d > 2) continue;
    const s = Math.max(dice(nn(g.facltNm), nn(c.n)), dice(core(g.facltNm), core(c.n)));
    const addr = na(g.addr1) && na(g.addr1) === na(c.a) ? .35 : 0;
    const sc = s + addr - d * .05;
    if (!best || sc > best.sc) best = { i, sc, s, d, addr };
  }
  pairs.push({ g, best });
}
pairs.sort((a, b) => (b.best?.sc ?? -1) - (a.best?.sc ?? -1));
const used = new Set(), extra = [];
let matched = 0;
const BBQ = /바베큐|바비큐|bbq/i;
const detail = [];
for (const { g, best } of pairs) {
  const good = best && (best.s >= .5 || (best.addr && best.s >= .2) || (best.d < .15 && best.s >= .3)) && !used.has(best.i);
  let c;
  if (good) { used.add(best.i); c = base[best.i]; matched++; }
  else {
    if (!+g.mapX || !+g.mapY) continue;
    c = { n: g.facltNm.trim(), s: g.doNm, g: g.sigunguNm, a: [g.addr1, g.addr2].filter(Boolean).join(' ').trim(), x: 0, y: 0, t: [0, 0, 0, 0, 0, 0], f: [], th: [], nb: [], l: [] };
    extra.push(c);
  }
  // 이름·좌표: 고캠핑 우선
  const gn = g.facltNm.trim();
  if (good && nn(gn) !== nn(c.n)) c.rn = c.n;
  c.n = gn;
  c.x = +(+g.mapX).toFixed(5); c.y = +(+g.mapY).toFixed(5); delete c.ap;
  if (!c.a) c.a = [g.addr1, g.addr2].filter(Boolean).join(' ').trim();
  // 유형: 등록 현황에 없으면 고캠핑 면수, 캠프닉은 고캠핑에만 있음
  const gt = [n(g.gnrlSiteCo), n(g.autoSiteCo), n(g.glampSiteCo), n(g.caravSiteCo), n(g.indvdlCaravSiteCo)];
  if (c.t.slice(0, 5).every((v) => !v)) for (let i = 0; i < 5; i++) c.t[i] = gt[i];
  const ind = g.induty || '';
  ['일반야영장', '자동차야영장', '글램핑', '카라반'].forEach((k, i) => { if (ind.includes(k) && !c.t[i]) c.t[i] = -1; }); // -1 = 있음(면수 모름)
  if (ind.includes('캠프닉')) c.t[5] = -1;
  c.f = union(c.f, tags(g.sbrsCl, FAC));
  c.th = union(c.th, tags(g.themaEnvrnCl, THEME));
  c.nb = union(c.nb, tags(g.posblFcltyCl, NEAR));
  c.l = tags(g.lctCl, LCT);
  if (c.p == null && g.animalCmgCl in PET) c.p = PET[g.animalCmgCl];
  // 연락처·링크·사진
  c.ci = g.contentId;
  if (g.tel) c.tel = g.tel.trim();
  if (url(g.homepage)) c.hp = url(g.homepage);
  if (url(g.resveUrl)) c.rv = url(g.resveUrl);
  if (g.resveCl) c.rc = g.resveCl;
  if (g.firstImageUrl) c.img = g.firstImageUrl;
  if (g.lineIntro) c.li = g.lineIntro.trim();
  // 휴장: 고캠핑 표시가 갱신 안 된 곳이 많아 종료일이 지났으면 앱에서 휴장으로 보지 않는다(ce 로 판단)
  if (g.manageSttus === '휴장') { c.cl = 1; if (g.hvofEnddle) c.ce = g.hvofEnddle; }
  if (BRAZ.includes(g.brazierCl)) c.br = BRAZ.indexOf(g.brazierCl);
  if (BBQ.test([g.facltNm, g.lineIntro, g.intro, g.featureNm, g.sbrsEtc, g.posblFcltyEtc, g.tooltip, c.rn].join(' '))) c.bq = 1;
  if (g.operPdCl) c.op = g.operPdCl;
  if (g.operDeCl) c.od = g.operDeCl;
  detail.push([c, {
    intro: (g.intro || '').trim(), feat: (g.featureNm || '').trim(), tip: (g.tooltip || '').trim(), dir: (g.direction || '').trim(),
    etc: [g.sbrsEtc, g.posblFcltyEtc].filter(Boolean).join(', '), lend: g.eqpmnLendCl || '',
    glamp: g.glampInnerFclty || '', carav: g.caravInnerFclty || '',
    wc: n(g.toiletCo), sw: n(g.swrmCo), wt: n(g.wtrplCo), hvof: [g.hvofBgnde, g.hvofEnddle].filter(Boolean).join('~'),
    trl: g.trlerAcmpnyAt === 'Y', crv: g.caravAcmpnyAt === 'Y', mod: (g.modifiedtime || '').slice(0, 10),
  }]);
}
// 공공데이터 이름에 바베큐가 들어간 곳도 표시
for (const c of base) if (!c.bq && BBQ.test(c.n + (c.rn || ''))) c.bq = 1;

const camps = [...base, ...extra];
camps.sort((a, b) => (a.s + a.g + a.n).localeCompare(b.s + b.g + b.n, 'ko'));
camps.forEach((c, i) => { c.id = i; if (!c.l.length) delete c.l; });
const det = {};
for (const [c, d] of detail) { for (const k of Object.keys(d)) if (d[k] === '' || d[k] === 0 || d[k] === false) delete d[k]; det[c.id] = d; }

const meta = {
  source: '공공데이터포털 「한국관광공사 전국 야영장 등록 현황」(15037499) + 한국관광공사 고캠핑 정보 조회서비스(15101933)',
  built: new Date().toISOString().slice(0, 10), count: camps.length, gocamping: go.length, matched, added: extra.length,
  fac: FAC, theme: THEME, near: NEAR, lct: LCT, braz: BRAZ,
};
const out = new URL('../data/', import.meta.url);
fs.writeFileSync(new URL('camps.json', out), JSON.stringify({ meta, camps }));
fs.writeFileSync(new URL('detail.json', out), JSON.stringify(det));
console.log(JSON.stringify({ count: camps.length, matched, added: extra.length, bbq: camps.filter((c) => c.bq).length, closed: camps.filter((c) => c.cl).length, approx: camps.filter((c) => c.ap).length,
  noType: camps.filter((c) => c.t.every((v) => !v)).length }));
for (const f of ['camps.json', 'detail.json']) console.log(f, fs.statSync(new URL(f, out)).size);
