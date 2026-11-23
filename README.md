# 캠핑장 찾기

기준점에서 금 15:00 / 토 10:00 출발 시 자가용 1.5시간·2시간 안에 갈 수 있는 전국 캠핑장을 지도·목록으로 찾는 PWA.

- 데이터: 공공데이터 「한국관광공사 전국 야영장 등록 현황」(15037499, CSV) + 고캠핑 정보 조회서비스(15101933) → `data/camps.json`·`data/detail.json`
  - 다시 만들기: `node tools/build.mjs` (`tools/rows.json` 원본, `tools/geo.json` 카카오 좌표, `tools/gocamping.json` 은 camping-api `/api/gocamping` 으로 받은 고캠핑 전체)
- 이동시간: 직선거리 추정식(`tools/calib.json` 298건으로 맞춤)으로 후보 → `api/`(Cloudflare Worker `camping-api`)가
  카카오모빌리티 미래 운행 길찾기로 실제 예측 소요시간을 받아 KV 에 3일 보관
- 날씨: Open-Meteo 일 예보
- 지도: 카카오맵 JS SDK (등록 도메인에서만 동작하는 JS 키)

토큰·키 값은 `LOCAL.md`(git 제외)에만 둔다.
