// 一次性迁移: 修复超长 BIN (卡号|月|年|CVV 被拼接成串的历史数据)
// 用法: node scripts/fix-long-bins.js
// 运行前自动备份 data.json → data.backup-<时间戳>.json
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));

// ── 与 server.js 保持一致的解析逻辑 ──
function matchCardFormat(s) {
  const t = String(s || '').trim();
  if (/:\/\//.test(t)) return null;
  const m = t.match(/^([\dxX*]{6,25})[|,\t ]+(\d{1,2})[|,\t ]+(\d{2,4})(?:[|,\t ]+(\d{3,4}))?$/);
  if (!m) return null;
  const bin = m[1].replace(/\D/g, '').slice(0, 12);
  const mm = parseInt(m[2], 10);
  const yy = m[3].length === 2 ? '20' + m[3] : m[3];
  if (!bin || bin.length < 4) return null;
  if (mm < 1 || mm > 12) return null;
  if (!/^\d{4}$/.test(yy) || +yy < 2020 || +yy > 2099) return null;
  return { bin, expireAt: yy + '-' + String(mm).padStart(2, '0') };
}
function parseBinToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /:\/\//.test(s)) return null;
  const card = matchCardFormat(s);
  if (card) return card;
  const first = s.split(/[|,\t]/)[0] || '';
  const bin = (first.replace(/\D/g, '') || s.replace(/\D/g, '')).slice(0, 12);
  return bin ? { bin, expireAt: '' } : null;
}

// ── 0) 备份 ──
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BAK = path.join(ROOT, 'data.backup-' + ts + '.json');
fs.writeFileSync(BAK, JSON.stringify(d, null, 2));

// ── 1) 修复 BIN 库超长条目 (>12 位) ──
const changes = [];
for (const b of d.bins) {
  if (String(b.bin).length <= 12) continue;
  const old = b.bin;
  const noteCard = matchCardFormat(b.note);  // note 里记录了原文的, 按原文还原
  if (noteCard) {
    b.bin = noteCard.bin;
    if (!b.expireAt) b.expireAt = noteCard.expireAt;
    changes.push(`  ${old} → ${b.bin} (按备注原文还原, 有效期 ${b.expireAt})`);
  } else {
    b.bin = String(b.bin).slice(0, 12);
    changes.push(`  ${old} → ${b.bin} (截取前 12 位)`);
  }
}

// ── 2) 修复商品 bins 字段 (URL 移入备注, 其余重新解析) ──
const prodChanges = [];
for (const p of d.products) {
  if (!Array.isArray(p.bins) || !p.bins.length) continue;
  const urls = [];
  const newBins = [];
  const expMap = {};
  const seen = new Set();
  for (const raw of p.bins) {
    const s = String(raw).trim();
    if (!s) continue;
    if (/:\/\//.test(s)) { urls.push(s); continue; }
    const r = parseBinToken(s);
    if (!r || !r.bin || r.bin.length < 4) {
      prodChanges.push(`  [${p.name}] 丢弃无效值: ${s}`);
      continue;
    }
    if (seen.has(r.bin)) continue;
    seen.add(r.bin);
    newBins.push(r.bin);
    if (r.expireAt) expMap[r.bin] = r.expireAt;
  }
  if (urls.length) {
    p.note = ((p.note || '').trim() + (p.note ? '\n' : '') + 'BIN 来源链接: ' + urls.join(' , ')).trim();
    prodChanges.push(`  [${p.name}] ${urls.length} 个链接移入备注`);
  }
  if (JSON.stringify(p.bins) !== JSON.stringify(newBins)) {
    prodChanges.push(`  [${p.name}] bins: ${JSON.stringify(p.bins)} → ${JSON.stringify(newBins)}`);
  }
  p.bins = newBins;
  // 解析出的有效期回填 BIN 库
  for (const entry of d.bins) {
    if (expMap[entry.bin] && !entry.expireAt) entry.expireAt = expMap[entry.bin];
  }
}

// ── 3) 按 bin 值去重合并 (保留较早条目, 非空字段优先) ──
const byBin = new Map();
let merged = 0;
for (const b of d.bins) {
  const exist = byBin.get(b.bin);
  if (!exist) { byBin.set(b.bin, b); continue; }
  const keep = (exist.createdAt || 0) <= (b.createdAt || 0) ? exist : b;
  const other = keep === exist ? b : exist;
  for (const k of ['brand', 'bank', 'category', 'note', 'expireAt']) {
    if (!keep[k] && other[k]) keep[k] = other[k];
  }
  byBin.set(keep.bin, keep);
  merged++;
}
d.bins = [...byBin.values()];

fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
console.log('备份: ' + path.basename(BAK));
console.log(`\n修复超长 BIN ${changes.length} 条:`);
changes.forEach(c => console.log(c));
console.log('\n商品 bins 修复:');
prodChanges.forEach(c => console.log(c));
console.log(`\n去重合并 ${merged} 条`);
console.log(`BIN 总数: ${d.bins.length}`);
