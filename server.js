const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.MM_PORT || 4002;
const DATA_FILE = process.env.MM_DATA || path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 数据存取 ──
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return {
      products: d.products || [],
      accounts: d.accounts || [],
      bins: d.bins || [],
      hqBins: d.hqBins || []
    };
  } catch (e) {
    return { products: [], accounts: [], bins: [], hqBins: [] };
  }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
function genId(p) {
  return p + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// ═══════════════════════════════════════════════
// 商品管理 (商品名称 / 官网地址 / 多个 BIN)
// ═══════════════════════════════════════════════

// 商品列表 (支持 ?q= 搜索)
app.get('/api/products', (req, res) => {
  const d = loadData();
  let list = d.products;
  if (req.query.q) {
    const q = req.query.q.toString().toLowerCase();
    list = list.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.site || '').toLowerCase().includes(q) ||
      (p.bins || []).join(',').toLowerCase().includes(q)
    );
  }
  // 附加每个商品的账号数
  const out = list.map(p => ({
    ...p,
    accountCount: d.accounts.filter(a => a.productId === p.id || a.product === p.name).length
  }));
  res.json(out);
});

// 添加/更新商品
// body: { id?, name, site, bins: [..], note }
app.post('/api/products', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.json({ success: false, error: 'name required' });
  if (b.id) {
    const p = d.products.find(x => x.id === b.id);
    if (!p) return res.json({ success: false, error: 'product not found' });
    p.name = b.name.trim();
    p.site = (b.site || '').trim();
    p.note = b.note || '';
    let parsedBins = null;
    if (Array.isArray(b.bins)) {
      parsedBins = normalizeBins(b.bins);
      p.bins = parsedBins.map(x => x.bin);
    }
    const syncedBins = syncBinsToLibrary(d, p, parsedBins);  // BIN 自动入库
    saveData(d);
    return res.json({ success: true, product: p, syncedBins });
  }
  const parsedBins = normalizeBins(b.bins);
  const prod = {
    id: genId('P'),
    name: b.name.trim(),
    site: (b.site || '').trim(),
    bins: parsedBins.map(x => x.bin),
    note: b.note || '',
    createdAt: Date.now()
  };
  d.products.push(prod);
  const syncedBins = syncBinsToLibrary(d, prod, parsedBins);  // BIN 自动入库 (分类=商品来源)
  saveData(d);
  res.json({ success: true, product: prod, syncedBins });
});

// 删除商品
app.delete('/api/products/:id', (req, res) => {
  const d = loadData();
  const before = d.products.length;
  d.products = d.products.filter(p => p.id !== req.params.id);
  saveData(d);
  res.json({ success: true, removed: before - d.products.length });
});

// 商品加 BIN (支持单个或多个, 自动识别 卡号|MM|YY|CVV 格式)
app.post('/api/products/:id/bins', (req, res) => {
  const d = loadData();
  const p = d.products.find(x => x.id === req.params.id);
  if (!p) return res.json({ success: false, error: 'product not found' });
  if (!Array.isArray(p.bins)) p.bins = [];
  let bins = [];
  if (Array.isArray(req.body.bins)) bins = req.body.bins;
  else if (typeof req.body.bin === 'string') bins = [req.body.bin];
  const parsed = normalizeBins(bins);
  let added = 0;
  for (const x of parsed) {
    if (!p.bins.includes(x.bin)) { p.bins.push(x.bin); added++; }
  }
  syncBinsToLibrary(d, p, parsed);  // 同步到 BIN 库
  saveData(d);
  res.json({ success: true, added, bins: p.bins });
});

// 商品删 BIN
app.delete('/api/products/:id/bins/:bin', (req, res) => {
  const d = loadData();
  const p = d.products.find(x => x.id === req.params.id);
  if (!p) return res.json({ success: false, error: 'product not found' });
  const bin = decodeURIComponent(req.params.bin);
  p.bins = (p.bins || []).filter(b => b !== bin);
  saveData(d);
  res.json({ success: true, bins: p.bins });
});

// ═══════════════════════════════════════════════
// 账号管理 (批量导入 / 删除 / 搜索)
// ═══════════════════════════════════════════════

// 账号列表 (?q= 搜索, ?product= 筛选, ?status= 筛选)
app.get('/api/accounts', (req, res) => {
  const d = loadData();
  let list = d.accounts;
  if (req.query.product) {
    list = list.filter(a => a.product === req.query.product || a.productId === req.query.product);
  }
  if (req.query.status) {
    list = list.filter(a => (a.status || '') === req.query.status);
  }
  if (req.query.q) {
    const q = req.query.q.toString().toLowerCase();
    list = list.filter(a =>
      (a.email || '').toLowerCase().includes(q) ||
      (a.password || '').toLowerCase().includes(q) ||
      (a.product || '').toLowerCase().includes(q) ||
      (a.note || '').toLowerCase().includes(q)
    );
  }
  res.json(list);
});

// 添加单个账号
// body: { product, productId?, email, password, status, expireAt, note }
app.post('/api/accounts', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  if (!b.email) return res.json({ success: false, error: 'email required' });
  const acct = {
    id: genId('A'),
    product: b.product || '',
    productId: b.productId || '',
    email: b.email.trim(),
    password: b.password || '',
    status: b.status || 'member',
    expireAt: b.expireAt || '',
    note: b.note || '',
    createdAt: Date.now()
  };
  d.accounts.push(acct);
  saveData(d);
  res.json({ success: true, account: acct });
});

// 批量导入账号
// body: { product, productId?, status?, text }
// text 每行: email|password 或 email,password 或 email
app.post('/api/accounts/batch', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const text = (b.text || '').toString();
  if (!text.trim()) return res.json({ success: false, error: 'empty text' });

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let added = 0, dup = 0;
  for (const line of lines) {
    // 支持 email|password / email,password / email\tpassword / email password
    const parts = line.split(/[|,\t]+/).map(s => s.trim());
    const email = parts[0] || '';
    if (!email || !email.includes('@')) continue;
    const password = parts[1] || '';
    // 去重 (同商品下同邮箱)
    if (d.accounts.find(a => a.email === email && (a.product === (b.product || '') || a.productId === (b.productId || '')))) {
      dup++; continue;
    }
    d.accounts.push({
      id: genId('A'),
      product: b.product || '',
      productId: b.productId || '',
      email,
      password,
      status: b.status || 'member',
      expireAt: '',
      note: '',
      createdAt: Date.now()
    });
    added++;
  }
  saveData(d);
  res.json({ success: true, added, duplicates: dup, total: d.accounts.length });
});

// 更新账号
app.put('/api/accounts/:id', (req, res) => {
  const d = loadData();
  const a = d.accounts.find(x => x.id === req.params.id);
  if (!a) return res.json({ success: false, error: 'account not found' });
  const b = req.body || {};
  for (const k of ['email', 'password', 'product', 'productId', 'status', 'expireAt', 'note']) {
    if (b[k] !== undefined) a[k] = b[k];
  }
  saveData(d);
  res.json({ success: true, account: a });
});

// 删除单个账号
app.delete('/api/accounts/:id', (req, res) => {
  const d = loadData();
  const before = d.accounts.length;
  d.accounts = d.accounts.filter(a => a.id !== req.params.id);
  saveData(d);
  res.json({ success: true, removed: before - d.accounts.length });
});

// 批量删除 (body: { ids: [...] }) 或按商品清空 (body: { product })
app.post('/api/accounts/delete-batch', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const before = d.accounts.length;
  if (Array.isArray(b.ids) && b.ids.length) {
    const set = new Set(b.ids);
    d.accounts = d.accounts.filter(a => !set.has(a.id));
  } else if (b.product) {
    d.accounts = d.accounts.filter(a => a.product !== b.product && a.productId !== b.product);
  } else if (b.all) {
    d.accounts = [];
  }
  saveData(d);
  res.json({ success: true, removed: before - d.accounts.length });
});

// ═══════════════════════════════════════════════
// BIN 卡头管理 (独立库: 品牌识别 / 分类 / 批量导入)
// ═══════════════════════════════════════════════

// BIN 品牌自动识别
function detectBrand(bin) {
  const b = String(bin || '').replace(/\D/g, '');
  if (!b) return 'Unknown';
  const p1 = b[0], p2 = b.substring(0, 2), p4 = b.substring(0, 4);
  if (p2 === '34' || p2 === '37') return 'Amex';
  if (p4 >= '3528' && p4 <= '3589') return 'JCB';
  if (p1 === '4') return 'Visa';
  if (p2 >= '51' && p2 <= '55') return 'Mastercard';
  if (p4 >= '2221' && p4 <= '2720') return 'Mastercard';
  if (p2 === '62') return 'UnionPay';
  if (p1 === '6') return 'Discover';
  if (p1 === '2') return 'Mir';
  if (p1 === '3') return 'DinersClub';
  return 'Unknown';
}

const BRANDS = ['Amex', 'Visa', 'Mastercard', 'Discover', 'JCB', 'UnionPay', 'Mir', 'DinersClub'];
function isBrandName(s) {
  return BRANDS.some(x => x.toLowerCase() === String(s || '').toLowerCase());
}

// 识别卡号格式: 卡号|MM|YY 或 卡号|MM|YY|CVV (分隔符支持 | , tab 空格, 卡号段支持 x/* 掩码)
// 如 532655525512|03|29|000 → { bin: '532655525512', expireAt: '2029-03' }
function matchCardFormat(s) {
  const t = String(s || '').trim();
  if (/:\/\//.test(t)) return null;  // URL 不是 BIN
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

// 解析单个 BIN 输入 (单个添加 / 商品 BIN 字段): 返回 {bin, expireAt} 或 null
function parseBinToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /:\/\//.test(s)) return null;
  const card = matchCardFormat(s);
  if (card) return card;
  // 非卡号格式: 只取第一段的数字, 避免各段被拼接成长串; BIN 最长 12 位
  const first = s.split(/[|,\t]/)[0] || '';
  const bin = (first.replace(/\D/g, '') || s.replace(/\D/g, '')).slice(0, 12);
  return bin ? { bin, expireAt: '' } : null;
}

// 批量导入行解析: 卡号格式 / bin / bin|分类 / bin|分类|备注 / bin|品牌|银行|分类|备注
function parseBinLine(line, defaultCategory) {
  const s = String(line || '').trim();
  if (!s || /:\/\//.test(s)) return null;
  const card = matchCardFormat(s);
  if (card) {
    return { bin: card.bin, brand: detectBrand(card.bin), bank: '', category: defaultCategory || '', note: '', expireAt: card.expireAt, cardFmt: true };
  }
  const parts = s.split(/[|,\t]+/).map(x => x.trim());
  const bin = ((parts[0] || '').replace(/\D/g, '')).slice(0, 12);
  if (!bin || bin.length < 4) return null;
  let brand = '', bank = '', category = '', note = '';
  if (parts.length === 2) {
    if (isBrandName(parts[1])) brand = parts[1]; else category = parts[1];
  } else if (parts.length === 3) {
    if (isBrandName(parts[1])) { brand = parts[1]; category = parts[2]; }
    else { category = parts[1]; note = parts[2]; }
  } else if (parts.length >= 4) {
    brand = parts[1] || ''; bank = parts[2] || ''; category = parts[3] || ''; note = parts.slice(4).join('|');
  }
  return { bin, brand: brand || detectBrand(bin), bank, category: category || defaultCategory || '', note, expireAt: '', cardFmt: false };
}

// bins 数组归一化: 解析卡号格式、过滤无效值、去重保序
function normalizeBins(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    const r = parseBinToken(raw);
    if (!r || !r.bin || r.bin.length < 4 || seen.has(r.bin)) continue;
    seen.add(r.bin);
    out.push(r);
  }
  return out;
}

// 有效期归一化: 2029-3 / 2029/03 / 2029年3 → 2029-03
function normExpire(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})[-/年](\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + m[2].padStart(2, '0');
}

// BIN 有效性: expired=已过期 / soon=当前月或下月到期 / valid=有效 / unknown=未设置
function binValidity(b) {
  const m = String(b.expireAt || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return 'unknown';
  const now = new Date();
  const cur = now.getFullYear() * 12 + now.getMonth();
  const exp = parseInt(m[1], 10) * 12 + (parseInt(m[2], 10) - 1);
  if (exp < cur) return 'expired';
  if (exp - cur <= 1) return 'soon';
  return 'valid';
}

// 把商品的 BIN 同步到 BIN 库 (分类 = 商品来源/商品名)
function syncBinsToLibrary(d, product, parsedBins) {
  const source = product.name || '';
  const expMap = {};
  for (const x of (parsedBins || [])) if (x.expireAt) expMap[x.bin] = x.expireAt;
  let added = 0;
  for (const raw of (product.bins || [])) {
    const b = String(raw).replace(/\D/g, '');
    if (!b || b.length < 4) continue;
    const exist = d.bins.find(x => x.bin === b);
    if (exist) {
      // 已存在但没分类 → 补上来源
      if (!exist.category) exist.category = source;
      if (!exist.expireAt && expMap[b]) exist.expireAt = expMap[b];
    } else {
      d.bins.push({
        id: genId('B'),
        bin: b,
        brand: detectBrand(b),
        bank: '',
        category: source,     // 分类 = 商品来源
        note: '',
        expireAt: expMap[b] || '',
        createdAt: Date.now()
      });
      added++;
    }
  }
  return added;
}

// BIN 列表 (?q= 搜索, ?brand= 筛选, ?category= 筛选, ?validity= 有效性筛选)
app.get('/api/bins', (req, res) => {
  const d = loadData();
  let list = d.bins;
  if (req.query.brand) list = list.filter(x => x.brand === req.query.brand);
  if (req.query.category) list = list.filter(x => x.category === req.query.category);
  if (req.query.validity) list = list.filter(x => binValidity(x) === req.query.validity);
  if (req.query.q) {
    const q = req.query.q.toString().toLowerCase();
    list = list.filter(x =>
      (x.bin || '').toLowerCase().includes(q) ||
      (x.brand || '').toLowerCase().includes(q) ||
      (x.bank || '').toLowerCase().includes(q) ||
      (x.category || '').toLowerCase().includes(q) ||
      (x.note || '').toLowerCase().includes(q)
    );
  }
  res.json(list.map(x => ({ ...x, validity: binValidity(x) })));
});

// BIN 分类列表
app.get('/api/bins/categories', (req, res) => {
  const d = loadData();
  res.json([...new Set(d.bins.map(b => b.category).filter(Boolean))]);
});

// 添加/更新 BIN
// body: { id?, bin, category?, bank?, note?, expireAt? }
// bin 支持粘贴 卡号|MM|YY|CVV 格式, 自动提取卡号段和有效期
app.post('/api/bins', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const parsed = parseBinToken(b.bin);
  const bin = parsed ? parsed.bin : '';
  if (!bin || bin.length < 4) return res.json({ success: false, error: 'bin required (>=4 digits)' });
  if (b.id) {
    const x = d.bins.find(y => y.id === b.id);
    if (!x) return res.json({ success: false, error: 'bin not found' });
    x.bin = bin;
    x.brand = b.brand || detectBrand(bin);
    x.bank = b.bank || '';
    x.category = b.category || '';
    x.note = b.note || '';
    x.expireAt = (b.expireAt !== undefined && b.expireAt !== null && String(b.expireAt).trim() !== '')
      ? normExpire(b.expireAt)
      : (x.expireAt || parsed.expireAt || '');
    saveData(d);
    return res.json({ success: true, bin: x });
  }
  if (d.bins.find(x => x.bin === bin)) return res.json({ success: false, error: 'bin already exists', duplicate: true });
  const item = {
    id: genId('B'),
    bin,
    brand: b.brand || detectBrand(bin),
    bank: b.bank || '',
    category: b.category || '',
    note: b.note || '',
    expireAt: normExpire(b.expireAt) || parsed.expireAt || '',
    createdAt: Date.now()
  };
  d.bins.push(item);
  saveData(d);
  res.json({ success: true, bin: item });
});

// 批量导入 BIN
// text 每行: bin / bin|分类 / bin|分类|备注 / bin|品牌|银行|分类|备注 / 卡号|MM|YY|CVV (自动提取有效期)
app.post('/api/bins/batch', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const text = (b.text || '').toString();
  if (!text.trim()) return res.json({ success: false, error: 'empty text' });
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let added = 0, dup = 0, cardFmt = 0;
  for (const line of lines) {
    const r = parseBinLine(line, b.category);
    if (!r) continue;
    if (d.bins.find(x => x.bin === r.bin)) { dup++; continue; }
    d.bins.push({ id: genId('B'), bin: r.bin, brand: r.brand, bank: r.bank, category: r.category, note: r.note, expireAt: r.expireAt, createdAt: Date.now() });
    if (r.cardFmt) cardFmt++;
    added++;
  }
  saveData(d);
  res.json({ success: true, added, duplicates: dup, cardFormat: cardFmt, total: d.bins.length });
});

// 删除单个 BIN
app.delete('/api/bins/:id', (req, res) => {
  const d = loadData();
  const before = d.bins.length;
  d.bins = d.bins.filter(x => x.id !== req.params.id);
  saveData(d);
  res.json({ success: true, removed: before - d.bins.length });
});

// 批量删除 BIN
app.post('/api/bins/delete-batch', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const before = d.bins.length;
  if (Array.isArray(b.ids) && b.ids.length) {
    const set = new Set(b.ids);
    d.bins = d.bins.filter(x => !set.has(x.id));
  } else if (b.all) {
    d.bins = [];
  }
  saveData(d);
  res.json({ success: true, removed: before - d.bins.length });
});

// ═══════════════════════════════════════════════
// 统计
// ═══════════════════════════════════════════════

app.get('/api/stats', (req, res) => {
  const d = loadData();
  const byProduct = {};
  const statusCounts = { member: 0, free: 0, expired: 0 };
  for (const a of d.accounts) {
    const p = a.product || '(未分类)';
    byProduct[p] = (byProduct[p] || 0) + 1;
    const st = a.status || 'member';
    if (statusCounts[st] === undefined) statusCounts[st] = 0;
    statusCounts[st]++;
  }
  const binCounts = { valid: 0, soon: 0, expired: 0, unknown: 0 };
  for (const b of d.bins) binCounts[binValidity(b)]++;
  res.json({
    products: d.products.length,
    accounts: d.accounts.length,
    bins: d.bins.length,
    hqBins: d.hqBins.length,
    byProduct,
    statusCounts,
    binCounts
  });
});

// ═══════════════════════════════════════════════
// HQ 卡头管理 (高质量卡头参考库)
// 格式: BIN|CVV|来源链接|评分|成功率|备注
// ═══════════════════════════════════════════════

const HQ_STATUSES = ['valid', 'invalid', 'pending'];
const HQ_SCORES = ['S', 'A', 'B', 'C'];

function normHqStatus(s) {
  const t = String(s || '').toLowerCase();
  if (['valid', 'ok', '可用', '有效'].includes(t)) return 'valid';
  if (['invalid', 'no', '无效', '不可用', 'failed'].includes(t)) return 'invalid';
  if (['pending', '待验证', '待测试'].includes(t)) return 'pending';
  return '';
}
function normHqScore(s) {
  const t = String(s || '').toUpperCase();
  if (HQ_SCORES.includes(t)) return t;
  return '';
}

function parseHqLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const parts = s.split(/[|]+/).map(x => x.trim());
  const bin = (parts[0] || '').replace(/\D/g, '');
  if (!bin || bin.length < 4) return null;
  const cvv = parts[1] || '';
  let source = parts[2] || '';
  // 未提供来源时, 如果第二段是 URL, 兼容 BIN|来源 格式
  if (!cvv && /^https?:\/\//.test(parts[1])) {
    source = parts[1];
  }
  const score = normHqScore(parts[3] || parts[1]);
  const successRate = parts[4] || '';
  const note = parts[5] || '';
  return { bin, cvv, source, score, successRate, note };
}

app.get('/api/hq-bins', (req, res) => {
  const d = loadData();
  let list = d.hqBins || [];
  if (req.query.status) list = list.filter(x => x.status === req.query.status);
  if (req.query.score) list = list.filter(x => x.score === req.query.score);
  if (req.query.q) {
    const q = req.query.q.toString().toLowerCase();
    list = list.filter(x =>
      (x.bin || '').toLowerCase().includes(q) ||
      (x.source || '').toLowerCase().includes(q) ||
      (x.note || '').toLowerCase().includes(q) ||
      (x.score || '').toLowerCase().includes(q)
    );
  }
  res.json(list);
});

app.post('/api/hq-bins/batch', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const text = (b.text || '').toString();
  if (!text.trim()) return res.json({ success: false, error: 'empty text' });
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let added = 0, dup = 0, invalid = 0;
  for (const line of lines) {
    const r = parseHqLine(line);
    if (!r) { invalid++; continue; }
    if (d.hqBins.find(x => x.bin === r.bin && x.cvv === r.cvv && x.source === r.source)) { dup++; continue; }
    d.hqBins.push({
      id: genId('H'),
      bin: r.bin,
      cvv: r.cvv,
      source: r.source,
      score: r.score,
      successRate: r.successRate,
      status: normHqStatus(b.status) || 'pending',
      note: r.note,
      createdAt: Date.now()
    });
    added++;
  }
  saveData(d);
  res.json({ success: true, added, duplicates: dup, invalid, total: d.hqBins.length });
});

app.put('/api/hq-bins/:id', (req, res) => {
  const d = loadData();
  const x = d.hqBins.find(y => y.id === req.params.id);
  if (!x) return res.json({ success: false, error: 'not found' });
  const b = req.body || {};
  if (b.bin !== undefined) x.bin = String(b.bin || '').replace(/\D/g, '');
  if (b.cvv !== undefined) x.cvv = b.cvv;
  if (b.source !== undefined) x.source = b.source;
  if (b.score !== undefined) x.score = normHqScore(b.score);
  if (b.successRate !== undefined) x.successRate = b.successRate;
  if (b.status !== undefined) x.status = HQ_STATUSES.includes(b.status) ? b.status : 'pending';
  if (b.note !== undefined) x.note = b.note;
  saveData(d);
  res.json({ success: true, hqBin: x });
});

app.delete('/api/hq-bins/:id', (req, res) => {
  const d = loadData();
  const idx = d.hqBins.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.json({ success: false, error: 'not found' });
  const removed = d.hqBins.splice(idx, 1)[0];
  saveData(d);
  res.json({ success: true, removed });
});

app.post('/api/hq-bins/batch-delete', (req, res) => {
  const d = loadData();
  const ids = (req.body || {}).ids || [];
  const before = d.hqBins.length;
  d.hqBins = d.hqBins.filter(x => !ids.includes(x.id));
  saveData(d);
  res.json({ success: true, removed: before - d.hqBins.length });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'MemberManager', version: '1.0.0', port: PORT });
});

const server = app.listen(PORT, () => {
  console.log('══════════════════════════════════════');
  console.log('  MemberManager 会员账号管理平台');
  console.log('  端口: http://localhost:' + PORT);
  console.log('  数据: ' + DATA_FILE);
  console.log('══════════════════════════════════════');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[启动失败] 端口 ' + PORT + ' 已被其它程序占用。');
    console.error('  排查: netstat -ano | findstr :' + PORT);
    console.error('  解决: 关闭占用程序，或换端口启动，例如: set MM_PORT=4003 && node server.js');
  } else {
    console.error('[启动失败] ' + err.message);
  }
  process.exit(1);
});
