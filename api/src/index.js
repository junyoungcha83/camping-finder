// 캠핑장 찾기 — 미래 운행 소요시간 프록시 (개인용)
//
//  POST /api/times   { origin:{lng,lat}, when:'YYYYMMDDHHmm', dests:[{id,lng,lat}, ..최대 30] }
//                    → { when, times:{ id:{min,km} | null }, cached, called }
//                    카카오모빌리티 '미래 운행 정보 길찾기'(/v1/future/directions) — 출발 시각 기준 예측 소요시간.
//  GET  /api/gocamping?op=basedList&pageNo=&numOfRows=   고캠핑 원문 프록시(데이터 파일 만들 때만, GOCAMPING_KEY 시크릿)
//  GET  /api/gear              준비물 목록 { items, rev } (없으면 { items:null, rev:0 })
//  PUT  /api/gear              { items } 저장 → { rev }  (나중에 저장한 쪽이 이김)
//  GET|PUT|DELETE /api/gear/img/<id>   준비물 사진(JPEG, 최대 5MB)
//  GET  /api/health
//
// Secrets:  KAKAO_REST_KEY (카카오 개발자 REST API 키 — 주유비교앱과 같은 키)
//           APP_TOKEN      (앱 ⚙︎ 설정에 넣는 토큰. 없으면 /api/times 를 막는다)
// KV:       CACHE          같은 출발지(약 100m 단위)·목적지·출발 시각 결과를 3일 보관해 쿼터를 아낀다.

const ALLOWED = ['https://junyoungcha83.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
const MAX_DESTS = 30;
const PARALLEL = 6;
const TTL = 3 * 86400;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (b, s, c) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...c } });

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const authed = (req, env) => !!env.APP_TOKEN && safeEqual(req.headers.get('X-App-Token') || '', env.APP_TOKEN);

const okLL = (p) => p && isFinite(p.lng) && isFinite(p.lat) && p.lng > 124 && p.lng < 132 && p.lat > 33 && p.lat < 39;

async function future(env, o, d, when) {
  const q = `origin=${o.lng},${o.lat}&destination=${d.lng},${d.lat}&departure_time=${when}&summary=true`;
  const r = await fetch(`https://apis-navi.kakaomobility.com/v1/future/directions?${q}`, {
    headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` },
  });
  if (!r.ok) throw new Error('kakao_http_' + r.status);
  const rt = (await r.json())?.routes?.[0];
  if (!rt || rt.result_code !== 0) return null; // 경로 없음(섬 등) — 실패가 아니라 '길 없음'
  return { min: Math.round(rt.summary.duration / 60), km: Math.round(rt.summary.distance / 100) / 10 };
}

async function times(req, env, c) {
  if (!env.KAKAO_REST_KEY) return json({ error: 'no_kakao_key' }, 500, c);
  const b = await req.json().catch(() => null);
  const when = String(b?.when || '');
  if (!/^\d{12}$/.test(when) || !okLL(b?.origin) || !Array.isArray(b?.dests)) return json({ error: 'bad_request' }, 400, c);
  const dests = b.dests.filter((d) => okLL(d) && d.id != null).slice(0, MAX_DESTS);
  const o = { lng: +(+b.origin.lng).toFixed(3), lat: +(+b.origin.lat).toFixed(3) };
  const key = (d) => `t:${when}:${o.lng},${o.lat}:${(+d.lng).toFixed(4)},${(+d.lat).toFixed(4)}`;

  const out = {};
  let cached = 0, called = 0, failed = 0;
  const todo = [];
  await Promise.all(dests.map(async (d) => {
    const v = env.CACHE ? await env.CACHE.get(key(d), 'json') : null;
    if (v) { out[d.id] = v.none ? null : v; cached++; } else todo.push(d);
  }));
  for (let i = 0; i < todo.length; i += PARALLEL) {
    await Promise.all(todo.slice(i, i + PARALLEL).map(async (d) => {
      try {
        const v = await future(env, o, d, when);
        called++;
        out[d.id] = v;
        if (env.CACHE) await env.CACHE.put(key(d), JSON.stringify(v || { none: 1 }), { expirationTtl: TTL });
      } catch (e) { failed++; } // 결과에 id 가 없으면 앱은 추정치를 유지한다
    }));
  }
  return json({ when, times: out, cached, called, failed }, 200, c);
}

// 고캠핑 목록 원문 한 페이지 — 앱이 직접 부르지 않고, tools/ 에서 데이터 파일을 만들 때만 쓴다.
// 키를 서버에만 두려고 프록시한다. 키가 Encoding(%2B 등) 이든 Decoding 이든 받도록 한 번 풀어서 다시 인코딩.
async function gocamping(url, env, c) {
  if (!env.GOCAMPING_KEY) return json({ error: 'no_gocamping_key' }, 500, c);
  const op = url.searchParams.get('op') || 'basedList';
  if (!['basedList', 'imageList'].includes(op)) return json({ error: 'bad_op' }, 400, c);
  let key = env.GOCAMPING_KEY.trim();
  try { if (/%[0-9A-Fa-f]{2}/.test(key)) key = decodeURIComponent(key); } catch {}
  const q = new URLSearchParams({ MobileOS: 'ETC', MobileApp: 'camping-finder', _type: 'json' });
  for (const k of ['pageNo', 'numOfRows', 'contentId']) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
  const r = await fetch(`https://apis.data.go.kr/B551011/GoCamping/${op}?serviceKey=${encodeURIComponent(key)}&${q}`);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/plain', 'Cache-Control': 'no-store', ...c } });
}

// 준비물 동기화 — 기기들이 같은 목록·사진을 본다. 앱 토큰이 곧 동기화 비밀번호.
async function gear(req, url, env, c) {
  if (!env.GEAR) return json({ error: 'no_bucket' }, 500, c);
  if (url.pathname === '/api/gear') {
    if (req.method === 'GET') {
      const o = await env.GEAR.get('gear/list.json');
      return o ? new Response(o.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...c } })
        : json({ items: null, rev: 0 }, 200, c);
    }
    if (req.method === 'PUT') {
      const b = await req.json().catch(() => null);
      if (!Array.isArray(b?.items) || b.items.length > 2000) return json({ error: 'bad_request' }, 400, c);
      const items = b.items.map((x) => ({
        id: String(x.id || '').slice(0, 40), cat: String(x.cat || '').slice(0, 20), name: String(x.name || '').slice(0, 100),
        qty: Math.max(0, Math.min(9999, parseInt(x.qty, 10) || 0)), note: String(x.note || '').slice(0, 300),
        imgs: (Array.isArray(x.imgs) ? x.imgs : []).map(String).filter((i) => /^[a-z0-9]{6,40}$/.test(i)).slice(0, 20), done: !!x.done, trip: !!x.trip,
      })).filter((x) => x.id);
      const rev = Date.now();
      await env.GEAR.put('gear/list.json', JSON.stringify({ items, rev }), { httpMetadata: { contentType: 'application/json' } });
      return json({ rev }, 200, c);
    }
  }
  const m = url.pathname.match(/^\/api\/gear\/img\/([a-z0-9]{6,40})$/);
  if (m) {
    const key = `gear/img/${m[1]}`;
    if (req.method === 'GET') {
      const o = await env.GEAR.get(key);
      if (!o) return json({ error: 'not_found' }, 404, c);
      return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', ...c } });
    }
    if (req.method === 'PUT') {
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 5 * 1024 * 1024) return json({ error: 'bad_size' }, 400, c);
      await env.GEAR.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
      return json({ ok: true }, 200, c);
    }
    if (req.method === 'DELETE') { await env.GEAR.delete(key); return json({ ok: true }, 200, c); }
  }
  return json({ error: 'not_found' }, 404, c);
}

export default {
  async fetch(req, env) {
    const c = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/' || url.pathname === '/api/health')
        return json({ ok: true, kakao: !!env.KAKAO_REST_KEY, kv: !!env.CACHE, gear: !!env.GEAR, auth: env.APP_TOKEN ? 'on' : 'missing' }, 200, c);
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, c);
      if (url.pathname === '/api/times' && req.method === 'POST') return await times(req, env, c);
      if (url.pathname === '/api/gocamping' && req.method === 'GET') return await gocamping(url, env, c);
      if (url.pathname.startsWith('/api/gear')) return await gear(req, url, env, c);
      return json({ error: 'not_found' }, 404, c);
    } catch (e) {
      return json({ error: 'server', detail: String(e).slice(0, 200) }, 500, c);
    }
  },
};
