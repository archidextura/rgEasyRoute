// 덜 지치는 서울길 — 로컬 서버
// 키를 서버에만 두고 브라우저 요청을 대신 전달한다. 외부 의존성 없음 (Node 18+).
//   키는 같은 폴더의 .env 파일에 적는다 (.env.example 참고). 실행: node server.js → http://localhost:8787
//   ODSAY_KEY가 없으면 데모 데이터로 동작한다. 장소 검색은 카카오 → TMAP → OpenStreetMap 순서로 쓸 수 있는 것을 쓴다.
//   TMAP_APP_KEY가 있으면 지도 표시와 실제 보행자 경로(골목길 좌표)를 쓴다.

const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 읽기. Windows에서 흔한 실수(.env.txt로 저장, UTF-16 인코딩, .env.example에 직접 입력)도 받아 준다.
// 파일에 값이 있으면 터미널 환경변수보다 우선한다.
const KNOWN = ['ODSAY_KEY', 'TMAP_APP_KEY', 'KAKAO_REST_KEY', 'PORT'];
const ALIAS = { TMAP_KEY: 'TMAP_APP_KEY', TMAP_APPKEY: 'TMAP_APP_KEY', ODSAY_API_KEY: 'ODSAY_KEY', KAKAO_KEY: 'KAKAO_REST_KEY', KAKAO_REST_API_KEY: 'KAKAO_REST_KEY' };
const envReport = { file: null, notes: [], unknown: [] };

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) { envReport.notes.push('파일이 UTF-16으로 저장돼 있어 변환해서 읽었습니다.'); return buf.slice(2).toString('utf16le'); }
  if (buf[0] === 0xfe && buf[1] === 0xff) { envReport.notes.push('파일이 UTF-16 BE로 저장돼 있어 변환해서 읽었습니다.'); const b = Buffer.from(buf.slice(2)); b.swap16(); return b.toString('utf16le'); }
  return buf.toString('utf8').replace(/^﻿/, '');
}

function loadEnv() {
  const cands = ['.env', '.env.txt', 'env', 'env.txt', '.env.example'].map(n => path.join(__dirname, n));
  for (const file of cands) {
    if (!fs.existsSync(file)) continue;
    const vals = {};
    for (const raw of readText(file).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/);
      if (!m) continue;
      let k = m[1].toUpperCase(); k = ALIAS[k] || k;
      const v = m[2].replace(/\s+#.*$/, '').trim().replace(/^['"“”‘’]|['"“”‘’]$/g, '').trim();
      if (!KNOWN.includes(k)) { envReport.unknown.push(m[1]); continue; }
      if (v) vals[k] = v;
    }
    const name = path.basename(file);
    if (name === '.env.example' && !Object.keys(vals).length) continue;  // 빈 양식은 건너뜀
    if (name !== '.env') envReport.notes.push(`'.env'가 없어 '${name}'에서 키를 읽었습니다. 파일 이름을 '.env'로 바꾸는 것을 권장합니다.`);
    for (const [k, v] of Object.entries(vals)) process.env[k] = v;
    envReport.file = file;
    return;
  }
}
loadEnv();
const mask = v => (v ? `${v.length}자, ${v.slice(0, 4)}…${v.slice(-2)}` : '비어 있음');

const PORT = Number(process.env.PORT) || 8787;
const KEY = process.env.ODSAY_KEY || '';
const KAKAO_REST = process.env.KAKAO_REST_KEY || '';
const TMAP = process.env.TMAP_APP_KEY || '';
const PUBLIC = path.join(__dirname, 'public');
// 역 엘리베이터·에스컬레이터 (tools/import-facilities.js로 만든 파일)
const FAC_FILE = path.join(__dirname, 'data', 'station-facilities.json');
let FAC = null;
try { if (fs.existsSync(FAC_FILE)) FAC = JSON.parse(fs.readFileSync(FAC_FILE, 'utf8')); } catch (e) { console.error('! 역 시설 파일을 읽지 못했습니다: ' + e.message); }
const facStations = FAC ? new Set(Object.values(FAC.stations).map(s => s.name)).size : 0;
const FIXTURE = path.join(__dirname, 'fixtures', 'odsay-sample.json');
const UA = 'seoul-easy-route/0.1 (local prototype)';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`응답이 JSON이 아닙니다 (HTTP ${r.status}): ${text.slice(0, 200)}`); }
}

const num = v => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

const routes = {
  // 대중교통 경로: ODsay searchPubTransPathT
  async '/api/route'(q) {
    const [SX, SY, EX, EY] = ['SX', 'SY', 'EX', 'EY'].map(k => num(q.get(k)));
    if ([SX, SY, EX, EY].includes(null)) return [400, { error: { msg: 'SX, SY, EX, EY(경도·위도)가 필요합니다.' } }];
    if (!KEY) {
      const demo = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
      return [200, { ...demo, demo: true }];
    }
    const url = 'https://api.odsay.com/v1/api/searchPubTransPathT?' +
      new URLSearchParams({ SX, SY, EX, EY, OPT: '0', lang: '0' }) + '&apiKey=' + encodeURIComponent(KEY);
    return [200, await getJSON(url)];
  },

  // 장소 이름 → 좌표: 카카오 로컬 (키워드 → 주소 순서), 키가 없으면 OpenStreetMap Nominatim
  async '/api/geo'(q) {
    const text = (q.get('q') || '').trim();
    if (!text) return [400, { error: { msg: '검색어가 비었습니다.' } }];
    if (KAKAO_REST) return kakaoGeo(text);
    if (TMAP) return tmapGeo(text);
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: text, format: 'json', limit: '1', countrycodes: 'kr', 'accept-language': 'ko',
      viewbox: '126.76,37.70,127.19,37.41', bounded: '1',
    });
    const list = await getJSON(url);
    if (!list.length) return [404, { error: { msg: `'${text}'의 위치를 찾지 못했습니다. 더 구체적으로 쓰거나 "37.55,126.97"처럼 좌표를 넣어 보세요.` } }];
    return [200, { lat: +list[0].lat, lon: +list[0].lon, name: list[0].display_name }];
  },

  // 고도: Open-Meteo Elevation (Copernicus 90m DEM, 키 불필요, 한 번에 최대 100점)
  async '/api/elev'(q) {
    const lat = q.get('lat') || '', lon = q.get('lon') || '';
    if (!lat || lat.split(',').length > 100) return [400, { error: { msg: '좌표는 1~100개까지 보낼 수 있습니다.' } }];
    return [200, await getJSON('https://api.open-meteo.com/v1/elevation?' + new URLSearchParams({ latitude: lat, longitude: lon }))];
  },

  async '/api/status'() {
    return [200, { demo: !KEY, geo: KAKAO_REST ? 'kakao' : TMAP ? 'tmap' : 'osm', tmap: !!TMAP, facStations }];
  },

  async '/api/facilities'() {
    return [200, FAC || { stations: {}, types: [], labelsTransfer: false }];
  },

  // 보행자 경로: TMAP routes/pedestrian (실제 골목길 좌표)
  async '/api/walk'(q) {
    if (!TMAP) return [400, { error: { msg: 'TMAP_APP_KEY가 없습니다.' } }];
    const [sx, sy, ex, ey] = ['sx', 'sy', 'ex', 'ey'].map(k => num(q.get(k)));
    if ([sx, sy, ex, ey].includes(null)) return [400, { error: { msg: 'sx, sy, ex, ey가 필요합니다.' } }];
    const r = await fetch('https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1', {
      method: 'POST',
      headers: { appKey: TMAP, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ startX: sx, startY: sy, endX: ex, endY: ey, startName: '출발', endName: '도착',
        reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.features) return [502, { error: { msg: tmapError(j, r.status) } }];
    const coords = [];
    for (const f of j.features) if (f.geometry?.type === 'LineString') for (const c of f.geometry.coordinates) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
    const p = j.features[0]?.properties || {};
    return [200, { coords, distance: p.totalDistance, time: p.totalTime }];
  },
};

async function tmapGeo(text) {
  const r = await fetch('https://apis.openapi.sk.com/tmap/pois?' + new URLSearchParams({
    version: '1', searchKeyword: text, count: '1', centerLat: '37.5665', centerLon: '126.9780',
    searchtypCd: 'A', reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO' }), { headers: { appKey: TMAP, Accept: 'application/json', 'User-Agent': UA } });
  if (r.status === 204) return [404, { error: { msg: `'${text}'을(를) TMAP 장소 검색에서 찾지 못했습니다.` } }];
  const j = await r.json().catch(() => ({}));
  const poi = j.searchPoiInfo?.pois?.poi?.[0];
  if (!poi) return [502, { error: { msg: tmapError(j, r.status) } }];
  return [200, { lat: +(poi.frontLat || poi.noorLat), lon: +(poi.frontLon || poi.noorLon), name: poi.name }];
}

function tmapError(j, status) {
  const e = j.error || {};
  if (status === 401 || status === 403 || /appKey|INVALID_API_KEY/i.test(e.code || e.message || ''))
    return 'TMAP 키가 올바르지 않거나 해당 API 사용 신청이 안 되어 있습니다. SK open API 콘솔에서 앱 키와 상품(보행자 경로, POI 검색, Web 지도) 사용 설정을 확인해 주세요.';
  if (status === 429) return 'TMAP 하루 무료 호출량을 넘었습니다.';
  return `TMAP 오류 (HTTP ${status}): ${e.message || e.code || JSON.stringify(j).slice(0, 200)}`;
}

async function kakaoGeo(text) {
  const headers = { Authorization: `KakaoAK ${KAKAO_REST}` };
  // 서울시청 기준 거리 가중치를 주되, 정확도 순으로 정렬
  const kw = await getJSON('https://dapi.kakao.com/v2/local/search/keyword.json?' +
    new URLSearchParams({ query: text, x: '126.9780', y: '37.5665', sort: 'accuracy', size: '1' }), headers);
  if (kw.errorType || kw.code) return [502, { error: { msg: kakaoError(kw) } }];
  let d = kw.documents?.[0];
  if (d) return [200, { lat: +d.y, lon: +d.x, name: `${d.place_name} (${d.road_address_name || d.address_name})` }];
  const ad = await getJSON('https://dapi.kakao.com/v2/local/search/address.json?' + new URLSearchParams({ query: text, size: '1' }), headers);
  d = ad.documents?.[0];
  if (d) return [200, { lat: +d.y, lon: +d.x, name: d.address_name }];
  return [404, { error: { msg: `'${text}'을(를) 카카오 장소 검색에서 찾지 못했습니다. 더 구체적으로 써 보세요.` } }];
}

function kakaoError(j) {
  const m = j.message || j.msg || '';
  if (/disabled|OPEN_MAP_AND_LOCAL/i.test(m)) return '카카오 로컬 API가 꺼져 있습니다. 카카오 디벨로퍼스 > 내 애플리케이션 > 카카오맵(또는 제품 설정)에서 사용 설정을 켜 주세요.';
  if (/appkey|key/i.test(m) || j.code === -401) return 'KAKAO_REST_KEY가 올바르지 않습니다. JavaScript 키가 아니라 REST API 키를 넣었는지 확인해 주세요.';
  return `카카오 API 오류: ${m || JSON.stringify(j)}`;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (routes[u.pathname]) {
      const [code, body] = await routes[u.pathname](u.searchParams);
      return send(res, code, body);
    }
    const file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    let body = fs.readFileSync(file);
    if (file.endsWith('index.html') && TMAP)  // TMAP SDK는 document.write를 써서 페이지에 직접 넣어야 한다
      body = body.toString().replace('<!--TMAP_SDK-->', `<script src="https://apis.openapi.sk.com/tmap/jsv2?version=1&appKey=${encodeURIComponent(TMAP)}"></script>`);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 502, { error: { msg: e.message } });
  }
}).listen(PORT, () => {
  console.log(`덜 지치는 서울길: http://localhost:${PORT}\n`);
  console.log('설정 파일: ' + (envReport.file || `없음 (찾은 위치: ${__dirname})`));
  envReport.notes.forEach(n => console.log('  ! ' + n));
  if (envReport.unknown.length) console.log(`  ! 알 수 없는 키 이름: ${envReport.unknown.join(', ')} (ODSAY_KEY, TMAP_APP_KEY, KAKAO_REST_KEY 중 하나로 고쳐 주세요)`);
  console.log(`  ODSAY_KEY      ${mask(KEY)}`);
  console.log(`  TMAP_APP_KEY   ${mask(TMAP)}`);
  console.log(`  KAKAO_REST_KEY ${mask(KAKAO_REST)}\n`);
  console.log(KEY ? '✔ ODsay 키 사용 중' : '✘ ODSAY_KEY가 없어 데모 데이터로 동작합니다.');
  console.log('✔ 장소 검색: ' + (KAKAO_REST ? '카카오' : TMAP ? 'TMAP' : 'OpenStreetMap'));
  console.log(facStations ? `✔ 역 엘리베이터·에스컬레이터 정보: ${facStations}개 역` : '✘ 역 시설 정보가 없어 모든 역에 에스컬레이터가 있다고 가정합니다. (data/raw에 CSV를 넣고 node tools/import-facilities.js)');
  console.log(TMAP ? '✔ TMAP 지도·보행자 경로 사용 중' : '✘ TMAP_APP_KEY가 없어 지도 없이, 걷는 길은 직선으로 추정합니다.');
});
