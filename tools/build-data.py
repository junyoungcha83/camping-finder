# tools/rows.json(공공데이터 CSV 를 JSON 으로) + tools/geo.json(카카오 좌표) → data/camps.json
# 출처: 공공데이터포털 15037499 「한국관광공사 전국 야영장 등록 현황」
import json, os
D = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(f'{D}/rows.json')); geo = json.load(open(f'{D}/geo.json'))
FAC = ['전기','온수','무선인터넷','장작판매','마트.편의점','놀이터','트렘폴린','물놀이장','산책로','운동시설','운동장','덤프스테이션']
THEME = ['여름물놀이','가을단풍명소','봄꽃여행','겨울눈꽃명소','걷기길','일몰명소','일출명소','낚시','수상레저','액티비티','스키','항공레저']
NEAR = ['계곡 물놀이','강/물놀이','해수욕','산책로','낚시','수상레저','수영장','어린이놀이시설','운동장','농어촌체험시설','청소년체험시설']
PET = {'불가능':0,'가능(소형견)':1,'가능':2}
def tags(s, lst): return [lst.index(t.strip()) for t in (s or '').split(',') if t.strip() in lst]
def n(v):
    try: return int(float(v))
    except: return 0
out = []
for i, r in enumerate(rows):
    g = geo.get(str(i))
    if not g: continue
    sizes = []
    for k in (1,2,3):
        w, h, q = n(r[f'사이트 크기{k} 가로']), n(r[f'사이트 크기{k} 세로']), n(r[f'사이트 크기{k} 수량'])
        if w and h: sizes.append([w, h, q])
    c = {'n': r['야영장명'].strip(), 's': r['도'].strip(), 'g': r['시군구'].strip(), 'a': r['주소'].strip(),
         'x': round(g['x'], 5), 'y': round(g['y'], 5),
         't': [n(r['주요시설 일반야영장']), n(r['주요시설 자동차야영장']), n(r['주요시설 글램핑']), n(r['주요시설 카라반']), n(r['주요시설 개인 카라반'])],
         'f': tags(r['부대시설'], FAC), 'th': tags(r['테마환경'], THEME), 'nb': tags(r['주변이용가능시설'], NEAR)}
    if g['m'] == 'area': c['ap'] = 1
    if r['반려동물출입'] in PET: c['p'] = PET[r['반려동물출입']]
    if sizes: c['z'] = sizes
    if r['인허가일자']: c['d'] = r['인허가일자']
    out.append(c)
out.sort(key=lambda c: (c['s'], c['g'], c['n']))
for i, c in enumerate(out): c['id'] = i
meta = {'source': '공공데이터포털 15037499 한국관광공사 전국 야영장 등록 현황', 'count': len(out),
        'fac': FAC, 'theme': THEME, 'near': NEAR}
json.dump({'meta': meta, 'camps': out}, open(f'{D}/../data/camps.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(out), os.path.getsize(f'{D}/../data/camps.json'))
