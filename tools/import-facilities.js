// 지하철역 엘리베이터·에스컬레이터 CSV → data/station-facilities.json
//   사용법: 내려받은 CSV를 data/raw/ 폴더에 넣고  node tools/import-facilities.js
//           (파일이나 폴더를 직접 줄 수도 있다: node tools/import-facilities.js 파일1.csv 폴더/)
//   열 이름은 자동으로 찾는다. 인코딩은 UTF-8 또는 EUC-KR(CP949).
//   종류 열이 없는 파일은 파일 이름(엘리베이터/에스컬레이터)으로 종류를 정하거나 --type=elev|esc 로 지정한다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'station-facilities.json');

// ---------- 인자 ----------
const args = process.argv.slice(2);
const forceType = (args.find(a => a.startsWith('--type=')) || '').split('=')[1] || null;
let inputs = args.filter(a => !a.startsWith('--'));
if (!inputs.length) inputs = [path.join(ROOT, 'data', 'raw')];
const files = inputs.flatMap(p => {
  if (!fs.existsSync(p)) { console.error(`! 없는 경로: ${p}`); return []; }
  return fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter(f => /\.(csv|txt)$/i.test(f)).map(f => path.join(p, f))
    : [p];
});
if (!files.length) {
  console.error('CSV 파일이 없습니다. 내려받은 파일을 data/raw/ 폴더에 넣고 다시 실행하세요.');
  console.error('엑셀(.xlsx) 파일이면 엑셀에서 "다른 이름으로 저장 → CSV UTF-8"로 바꿔 주세요.');
  process.exit(1);
}

// ---------- 읽기 ----------
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return ['UTF-8', buf.slice(3).toString('utf8')];
  if (buf[0] === 0xff && buf[1] === 0xfe) return ['UTF-16', buf.slice(2).toString('utf16le')];
  try { return ['UTF-8', new TextDecoder('utf-8', { fatal: true }).decode(buf)]; }
  catch { return ['EUC-KR', new TextDecoder('euc-kr').decode(buf)]; }
}

function parseCSV(text) {
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}

// ---------- 정규화 ----------
const TYPE_RULES = [
  ['lift', /휠체어\s*리프트|리프트|W\/?L/i],
  ['walk', /무빙\s*워크|수평\s*보행/],
  ['esc', /에스컬|에스커|E\/?S\b|\bES\b/i],
  ['elev', /엘리베이터|엘레베이터|승강기|E\/?V\b|\bEV\b/i],
];
const typeOf = text => (TYPE_RULES.find(([, re]) => re.test(text)) || [null])[0];

function normLine(s) {
  if (!s) return '';
  const m = String(s).match(/(\d+)\s*호선/) || String(s).match(/^\s*0*(\d)\s*$/);
  return m ? `${+m[1]}호선` : String(s).replace(/\s/g, '');
}
// "서울역(1호선)", "총신대입구(이수)", "서울 역" → 기본 이름과 다른 이름
function stationNames(raw) {
  const s = String(raw).replace(/\s/g, '');
  const alts = [...s.matchAll(/\(([^)]*)\)/g)].map(m => m[1]).filter(a => a && !/호선/.test(a));
  const lineInName = (s.match(/\((\d+)호선\)/) || [])[1];
  const base = s.replace(/\([^)]*\)/g, '').replace(/역$/, '');
  return { base, alts: alts.map(a => a.replace(/역$/, '')), line: lineInName ? `${lineInName}호선` : '' };
}

// 위치 문구 → 어느 구간의 시설인가
function sectionOf(text) {
  if (/환승/.test(text)) return 'transfer';
  const street = /출입구|출구|지상|외부|도로|보도/.test(text);
  if (/승강장|플랫폼/.test(text)) return street ? 'both' : 'platform';   // 지상↔승강장 직통 엘리베이터
  if (/출입구|출구|지상|외부|도로|보도|지하\s*1\s*층\s*-\s*지상/.test(text)) return 'street';
  return '?';
}
const exitOf = text => (String(text).match(/(\d+(?:-\d+)?)\s*번?\s*(?:출입구|출구)/) || String(text).match(/(?:출입구|출구)\s*(\d+(?:-\d+)?)/) || [])[1] || '';

// ---------- 열 찾기 ----------
const COLS = {
  station: /역\s*명|역사\s*명|역\s*이름|STATN_?NM|STATION|^역$/i,
  line: /호선|노선|LINE/i,
  type: /구분|종류|시설|장비|기기|TYPE|EQP/i,
  loc: /위치|설치|구간|상세|운행|층|출입구|출구|LOC|PSTN|비고/i,
};
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (rows[i].some(c => COLS.station.test(c))) return i;
  return -1;
}

// ---------- 처리 ----------
const stations = {};
const typesSeen = new Set();
let labelsTransfer = false;

for (const file of files) {
  const [enc, text] = decode(fs.readFileSync(file));
  const rows = parseCSV(text);
  const h = findHeader(rows);
  console.log(`\n■ ${path.basename(file)}  (${enc}, ${rows.length}줄)`);
  if (h < 0) { console.log('  ! 역 이름 열을 찾지 못해 건너뜁니다. 첫 줄: ' + (rows[0] || []).join(' | ')); continue; }
  const head = rows[h];
  const idx = re => head.map((c, i) => (re.test(c) ? i : -1)).filter(i => i >= 0);
  const stCol = idx(COLS.station)[0];
  const lineCol = idx(COLS.line).find(i => i !== stCol);
  const locCols = idx(COLS.loc).filter(i => i !== stCol && i !== lineCol);
  const typeCols = idx(COLS.type).filter(i => i !== stCol);
  const fileType = forceType || typeOf(path.basename(file));
  console.log(`  열: 역=${head[stCol]}, 호선=${lineCol != null ? head[lineCol] : '(없음)'}, 위치=${locCols.map(i => head[i]).join('+') || '(없음)'}, 종류=${typeCols.map(i => head[i]).join('+') || '(파일 이름: ' + (fileType || '알 수 없음') + ')'}`);

  const count = { elev: 0, esc: 0, lift: 0, walk: 0, skip: 0 };
  const secCount = { street: 0, platform: 0, both: 0, transfer: 0, '?': 0 };
  for (const r of rows.slice(h + 1)) {
    const rawName = r[stCol]; if (!rawName) { count.skip++; continue; }
    const loc = locCols.map(i => r[i]).filter(Boolean).join(' / ');
    const type = typeOf(typeCols.map(i => r[i]).join(' ')) || fileType || typeOf(r.join(' '));
    if (!type) { count.skip++; continue; }
    const { base, alts, line: nameLine } = stationNames(rawName);
    const line = normLine(lineCol != null ? r[lineCol] : '') || nameLine;
    const sec = sectionOf(loc);
    if (sec === 'transfer') labelsTransfer = true;
    const fac = { type, line, sec, exit: exitOf(loc), loc };
    for (const key of [base, ...alts]) {
      const s = stations[key] ||= { name: base, fac: [] };
      s.fac.push(fac);
    }
    typesSeen.add(type); count[type]++; secCount[sec]++;
  }
  console.log(`  엘리베이터 ${count.elev} · 에스컬레이터 ${count.esc} · 휠체어리프트 ${count.lift} · 무빙워크 ${count.walk} · 건너뜀 ${count.skip}`);
  console.log(`  구간 분류: 지상↔대합실 ${secCount.street} · 대합실↔승강장 ${secCount.platform} · 지상↔승강장 직통 ${secCount.both} · 환승 ${secCount.transfer} · 미분류 ${secCount['?']}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = { generated: new Date().toISOString(), sources: files.map(f => path.basename(f)), types: [...typesSeen], labelsTransfer, stations };
fs.writeFileSync(OUT, JSON.stringify(out));
const n = new Set(Object.values(stations).map(s => s.name)).size;
console.log(`\n완료: 역 ${n}곳 → ${path.relative(ROOT, OUT)}`);
if (!typesSeen.has('elev') || !typesSeen.has('esc'))
  console.log('! 엘리베이터와 에스컬레이터 중 한쪽만 들어왔습니다. 없는 쪽은 "정보 없음"으로 처리돼 계단으로 판정하지 않습니다.');
console.log('서버를 다시 시작하면 반영됩니다.');
