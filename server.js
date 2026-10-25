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
      hqBins: d.hqBins || [],
      paycheckRecords: d.paycheckRecords || []
    };
  } catch (e) {
    return { products: [], accounts: [], bins: [], hqBins: [], paycheckRecords: [] };
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
      if (p.activeBin && !p.bins.includes(p.activeBin)) delete p.activeBin;  // 生效 BIN 已被移除 → 清空
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

// 服务(商品)设置「当前生效 BIN」— 生效是服务维度的, 不是 BIN 全局的
// bin 为空 = 取消生效; bin 不在服务 BIN 池时自动加入池并同步入 BIN 库
app.post('/api/products/:id/active-bin', (req, res) => {
  const d = loadData();
  const p = d.products.find(x => x.id === req.params.id);
  if (!p) return res.json({ success: false, error: 'product not found' });
  const bin = ((req.body && req.body.bin) || '').toString().trim();
  if (!bin) {
    delete p.activeBin;
    saveData(d);
    return res.json({ success: true, product: p });
  }
  if (!Array.isArray(p.bins)) p.bins = [];
  if (!p.bins.includes(bin)) {
    p.bins.push(bin);
    syncBinsToLibrary(d, p, normalizeBins([bin]));  // 同时进 BIN 库
  }
  p.activeBin = bin;
  saveData(d);
  res.json({ success: true, product: p });
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
  if (p.activeBin === bin) delete p.activeBin;  // 删掉的恰是生效 BIN → 清空
  saveData(d);
  res.json({ success: true, bins: p.bins });
});

// ═══════════════════════════════════════════════
// 账号管理 (批量导入 / 删除 / 搜索)
// ═══════════════════════════════════════════════

// 账号列表 (?q= 搜索, ?product= 筛选, ?status= 筛选)
// ?archived=1 只看已归档; 默认只显示未归档 (归档数据不删除, 仍保留在 data.json)
app.get('/api/accounts', (req, res) => {
  const d = loadData();
  let list = d.accounts;
  if (req.query.archived === '1' || req.query.archived === 'true') {
    list = list.filter(a => a.archived === true);
  } else {
    list = list.filter(a => !a.archived);
  }
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
    archived: false,
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
      archived: false,
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

// 批量归档 (body: { ids: [...] } 或 { expired: true } → 归档全部已过期)
// 归档仅打标记, 不删除数据; 在「已归档」筛选中可查看/恢复
app.post('/api/accounts/archive', (req, res) => {
  const d = loadData();
  const b = req.body || {};
  const now = Date.now();
  let count = 0;
  if (Array.isArray(b.ids) && b.ids.length) {
    const set = new Set(b.ids);
    for (const a of d.accounts) {
      if (set.has(a.id) && !a.archived) { a.archived = true; a.archivedAt = now; count++; }
    }
  } else if (b.expired) {
    for (const a of d.accounts) {
      if (!a.archived && (a.status || 'member') === 'expired') { a.archived = true; a.archivedAt = now; count++; }
    }
  }
  saveData(d);
  res.json({ success: true, archived: count });
});

// 批量恢复归档 (body: { ids: [...] })
app.post('/api/accounts/unarchive', (req, res) => {
  const d = loadData();
  const ids = new Set((req.body || {}).ids || []);
  let count = 0;
  for (const a of d.accounts) {
    if (ids.has(a.id) && a.archived) { a.archived = false; delete a.archivedAt; count++; }
  }
  saveData(d);
  res.json({ success: true, restored: count });
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
// 如 532655525512|03|29|000 → { bin: '532655525512', expireAt: '2029-03', cvv: '000' }
// ★ cvv 保留不丢 (bin|mm|yy|cvv 完整卡格式), BIN 库存 cvv 字段
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
  const cvv = m[4] || '';
  return { bin, expireAt: yy + '-' + String(mm).padStart(2, '0'), cvv };
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
// 卡号格式 bin|mm|yy|cvv → cvv 保留到 BIN 库
function parseBinLine(line, defaultCategory) {
  const s = String(line || '').trim();
  if (!s || /:\/\//.test(s)) return null;
  const card = matchCardFormat(s);
  if (card) {
    return { bin: card.bin, brand: detectBrand(card.bin), bank: '', category: defaultCategory || '', note: '', expireAt: card.expireAt, cvv: card.cvv || '', cardFmt: true };
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
  return { bin, brand: brand || detectBrand(bin), bank, category: category || defaultCategory || '', note, expireAt: '', cvv: '', cardFmt: false };
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
// ★ 卡号格式 bin|mm|yy|cvv 完整保留: cvv 存库, 不再拆碎
function syncBinsToLibrary(d, product, parsedBins) {
  const source = product.name || '';
  const meta = {};
  for (const x of (parsedBins || [])) {
    if (x.expireAt || x.cvv) meta[x.bin] = { expireAt: x.expireAt || '', cvv: x.cvv || '' };
  }
  let added = 0;
  for (const raw of (product.bins || [])) {
    const b = String(raw).replace(/\D/g, '');
    if (!b || b.length < 4) continue;
    const exist = d.bins.find(x => x.bin === b);
    const m = meta[b] || {};
    if (exist) {
      // 已存在但没分类 → 补上来源
      if (!exist.category) exist.category = source;
      if (!exist.expireAt && m.expireAt) exist.expireAt = m.expireAt;
      if (!exist.cvv && m.cvv) exist.cvv = m.cvv;
    } else {
      d.bins.push({
        id: genId('B'),
        bin: b,
        brand: detectBrand(b),
        bank: '',
        category: source,     // 分类 = 商品来源
        note: '',
        expireAt: m.expireAt || '',
        cvv: m.cvv || '',
        createdAt: Date.now()
      });
      added++;
    }
  }
  return added;
}

// BIN 列表 (?q= 搜索, ?brand= 筛选, ?category= 筛选, ?validity= 有效性筛选)
// 生效标志是「服务(产品)→BIN」维度的: 每条产品记录有 activeBin, 本接口反推出 BIN 被哪些产品生效
app.get('/api/bins', (req, res) => {
  const d = loadData();
  const activeFor = {};  // bin -> [{id, name}]
  for (const p of d.products) {
    if (p.activeBin) (activeFor[p.activeBin] = activeFor[p.activeBin] || []).push({ id: p.id, name: p.name });
  }
  let list = d.bins;
  if (req.query.brand) list = list.filter(x => x.brand === req.query.brand);
  if (req.query.category) list = list.filter(x => x.category === req.query.category);
  if (req.query.validity) list = list.filter(x => binValidity(x) === req.query.validity);
  if (req.query.active === '1') list = list.filter(x => (activeFor[x.bin] || []).length > 0);
  if (req.query.isNew === '1') list = list.filter(x => isBinNew(x));
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
  // 派生标志: active(被≥1个服务设为生效) / activeFor(具体哪些服务) / isNew(7 天内导入或更新)
  res.json(list.map(x => ({ ...x, active: (activeFor[x.bin] || []).length > 0, activeFor: activeFor[x.bin] || [], isNew: isBinNew(x) })));
});

// 新 BIN 判定: 7 天内导入/更新
function isBinNew(b) {
  const t = b.updatedAt || b.createdAt;
  if (!t) return false;
  return (Date.now() - t) < 7 * 24 * 3600 * 1000;
}

// BIN 分类列表
app.get('/api/bins/categories', (req, res) => {
  const d = loadData();
  res.json([...new Set(d.bins.map(b => b.category).filter(Boolean))]);
});

// ★ BIN 一键导出 (复制用): ?format=card(卡号|mm|yy|cvv) / plain(纯BIN) / full(全字段TSV)
//   筛选参数与 /api/bins 相同 (q/brand/category/validity)
app.get('/api/bins/export', (req, res) => {
  const d = loadData();
  const activeFor = {};
  for (const p of d.products) {
    if (p.activeBin) (activeFor[p.activeBin] = activeFor[p.activeBin] || []).push({ id: p.id, name: p.name });
  }
  let list = d.bins;
  if (req.query.brand) list = list.filter(x => x.brand === req.query.brand);
  if (req.query.category) list = list.filter(x => x.category === req.query.category);
  if (req.query.validity) list = list.filter(x => binValidity(x) === req.query.validity);
  if (req.query.active === '1') list = list.filter(x => (activeFor[x.bin] || []).length > 0);
  if (req.query.isNew === '1') list = list.filter(x => isBinNew(x));
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
  const fmt = (req.query.format || 'card').toString();
  let out = [];
  for (const x of list) {
    if (fmt === 'plain') {
      out.push(x.bin);
    } else if (fmt === 'full') {
      out.push([x.bin, x.brand || '', x.bank || '', x.category || '', x.expireAt || '', x.cvv || '', binValidity(x), x.note || ''].join('\t'));
    } else {
      // card: bin|mm|yy|cvv (有有效期的才带 mm|yy)
      const m = String(x.expireAt || '').match(/^(\d{4})-(\d{2})/);
      if (m) {
        const yy = m[1].slice(2);
        const cvv = x.cvv || '';
        out.push(cvv ? `${x.bin}|${m[2]}|${yy}|${cvv}` : `${x.bin}|${m[2]}|${yy}`);
      } else {
        out.push(x.bin);
      }
    }
  }
  res.json({ success: true, count: out.length, format: fmt, text: out.join('\n') });
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
    if (parsed.cvv) x.cvv = parsed.cvv;
    if (b.cvv !== undefined) x.cvv = b.cvv || '';
    x.updatedAt = Date.now();  // 编辑刷新 → 重新计入「新 BIN」
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
    cvv: b.cvv || parsed.cvv || '',
    active: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
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
    d.bins.push({ id: genId('B'), bin: r.bin, brand: r.brand, bank: r.bank, category: r.category, note: r.note, expireAt: r.expireAt, cvv: r.cvv || '', active: false, createdAt: Date.now(), updatedAt: Date.now() });
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
  let archived = 0;
  for (const a of d.accounts) {
    const p = a.product || '(未分类)';
    byProduct[p] = (byProduct[p] || 0) + 1;
    if (a.archived) { archived++; continue; }
    const st = a.status || 'member';
    if (statusCounts[st] === undefined) statusCounts[st] = 0;
    statusCounts[st]++;
  }
  const binCounts = { valid: 0, soon: 0, expired: 0, unknown: 0 };
  for (const b of d.bins) binCounts[binValidity(b)]++;
  const activeBinSet = new Set(d.products.map(p => p.activeBin).filter(Boolean));  // 服务维度生效的 BIN
  const binFlags = { active: 0, isNew: 0, activeProducts: 0 };
  for (const b of d.bins) { if (activeBinSet.has(b.bin)) binFlags.active++; if (isBinNew(b)) binFlags.isNew++; }
  binFlags.activeProducts = [...d.products].filter(p => p.activeBin).length;
  res.json({
    products: d.products.length,
    accounts: d.accounts.length,
    bins: d.bins.length,
    hqBins: d.hqBins.length,
    byProduct,
    statusCounts,
    archived,
    binCounts,
    binFlags
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

// ═══════════════════════════════════════════════
// 支付链路校验 (paycheck) — BIN 针对具体服务的可用性分析
// 数据源: binlist.net (免费, 6位) / binlist.io (免费, 含 3DS) / NeutrinoAPI (用户自带 key, 8位)
// ═══════════════════════════════════════════════

// BIN 基础档案: 多源聚合, 前端统一展示. 免费源经常挂/被墙, 全部失败时返回 success+空
app.get('/api/paycheck/lookup/:bin', async (req, res) => {
  const bin = req.params.bin.replace(/\D/g, '');
  if (bin.length < 4) return res.json({ success: false, error: '需要 4-8 位 BIN' });
  const results = {};
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36', Accept: 'application/json' };
  await Promise.all([
    (async () => {
      try {
        const r = await fetch(`https://binlist.net/lookup/${bin}?format=json`, { headers: UA, signal: AbortSignal.timeout(10000) });
        const t = await r.text();
        try { results.binlist = JSON.parse(t); } catch (e) { results.binlist = { error: 'HTML 返回 (可能被 CDN 拦截), 源不可用' }; }
      } catch (e) { results.binlist = { error: e.message }; }
    })(),
    (async () => {
      try {
        const r = await fetch(`https://api.binlist.io/v2/bin?number=${bin}`, { headers: UA, signal: AbortSignal.timeout(10000) });
        if (r.ok) results.binlistio = await r.json();
        else results.binlistio = { notFound: true, status: r.status };
      } catch (e) { results.binlistio = { error: e.message }; }
    })()
  ]);
  res.json({ success: true, bin, results });
});

// 默认走 madleets 免费源 (6/8 位都支持); 传 key 时走 NeutrinoAPI
// MADLEETS_KEY: madleets.me 的 Supabase anon key (该网站公开前端密钥, 免费 BIN 查询)
// 可从 https://madleets.me 页面 JS 中提取; 若失效请设环境变量 MADLEETS_KEY 覆盖
const MADLEETS_KEY = process.env.MADLEETS_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqc2JxY2VxYWt3d2pwdGtndnZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0NTQ0NzYsImV4cCI6MjEwMjAzMDQ3Nn0.jLdB6QH-7NGFH8lqegBRfDJWnsan_DquNfy8khBP9P4';

// 8 位前缀枚举: 379191 → 37919100..37919199
// 默认用 madleets 免费源 (6/8 位都支持); 传 key 时走 NeutrinoAPI
// chunk 0-9: 每次查 10 个, 前端分块调用避免超时
app.post('/api/paycheck/scan8', async (req, res) => {
  const base = ((req.body && req.body.bin) || '').replace(/\D/g, '');
  const key = ((req.body && req.body.key) || '').trim();
  const chunk = Math.min(9, Math.max(0, parseInt(req.body.chunk, 10) || 0));
  if (base.length !== 6) return res.json({ success: false, error: '需要 6 位基础 BIN' });
  const out = { found: [], missing: [], errors: [], authFail: false, source: key ? 'neutrino' : 'madleets' };
  const UA = { 'User-Agent': 'Mozilla/5.0', 'x-api-key': key, Accept: 'application/json' };
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    const n = chunk * 10 + i;
    const b8 = base + String(n).padStart(2, '0');
    jobs.push((async () => {
      if (key) {
        // NeutrinoAPI 路径
        for (const u of [`https://neutrinoapi.com/api/bin-lookup/${b8}`, `https://neutrinoapi.com/api/lookup/${b8}`]) {
          try {
            const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(10000) });
            if (r.status === 401 || r.status === 403) { out.authFail = true; out.errors.push(b8 + '(401/403)'); return; }
            if (r.status === 400 && /ENDPOINT/i.test(await r.text())) continue;
            if (r.ok) { out.found.push({ bin: b8, ...(await r.json()) }); }
            else out.missing.push(b8);
            return;
          } catch (e) { /* 网络错误, 试下一个路径 */ }
        }
        out.errors.push(b8 + '(无可用端点)');
      } else {
        // madleets 免费源
        try {
          const r = await fetch(`https://fjsbqceqakwwjptkgvvs.supabase.co/functions/v1/bin-lookup?bin=${b8}`, {
            headers: { 'apikey': MADLEETS_KEY, 'Authorization': 'Bearer ' + MADLEETS_KEY },
            signal: AbortSignal.timeout(12000)
          });
          if (r.ok) {
            const j = await r.json();
            out.found.push({ bin: b8, ...j });
          } else {
            out.missing.push(b8);
          }
        } catch (e) { out.errors.push(b8 + '(' + (e.cause ? e.cause.code || e.cause.message : e.message) + ')'); }
      }
    })());
  }
  await Promise.all(jobs);
  if (out.authFail) return res.json({ success: false, error: 'key 无效或无权限 (401/403), 请检查 NeutrinoAPI key' });
  res.json({ success: true, chunk, out });
});

// ccbins.co BIN 查询 (如果本地网络可达该站; 端点格式: /api/bin/{bin} 或页面内嵌数据)
// 当前环境直连超时, 保留端点供网络恢复后使用
app.get('/api/paycheck/ccbins/:bin', async (req, res) => {
  const bin = req.params.bin.replace(/\D/g, '');
  if (bin.length < 4) return res.json({ success: false, error: '需要 BIN' });
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36', Accept: 'application/json, text/html' };
  const candidates = [
    `https://ccbins.co/api/bin/${bin}`,
    `https://ccbins.co/api/bins/${bin}`,
    `https://ccbins.co/bin/${bin}`
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(12000) });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('json')) {
        const j = await r.json();
        return res.json({ success: true, url: u, data: j });
      }
      if (r.ok && ct.includes('html')) {
        // 页面内可能嵌了 JSON 数据, 提取
        const t = await r.text();
        const m = t.match(/\{[^{}]*"bin"\s*:\s*["0-9]+[^{}]*\}/);
        if (m) return res.json({ success: true, url: u, data: JSON.parse(m[0]), embedded: true });
      }
    } catch (e) { /* 下一候选 */ }
  }
  res.json({ success: false, error: 'ccbins.co 不可达或无匹配端点 (网络超时), 请确认本机到 ccbins.co 的连通性' });
});

// madleets.me BIN 查询 (Supabase edge function, 免费匿名 key, 支持 6/8 位)
// 返回: { bin, scheme, type, country: {name, alpha2}, bank }
app.get('/api/paycheck/madleets/:bin', async (req, res) => {
  const bin = req.params.bin.replace(/\D/g, '');
  if (bin.length < 6) return res.json({ success: false, error: '需要 6 位 BIN' });
  try {
    const r = await fetch(`https://fjsbqceqakwwjptkgvvs.supabase.co/functions/v1/bin-lookup?bin=${bin}`, {
      headers: {
        'apikey': MADLEETS_KEY,
        'Authorization': 'Bearer ' + MADLEETS_KEY
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return res.json({ success: false, error: `madleets ${r.status}: ${(await r.text()).slice(0, 200)}` });
    const j = await r.json();
    res.json({ success: true, data: j });
  } catch (e) {
    res.json({ success: false, error: 'madleets.me 请求失败: ' + e.message });
  }
});

// NeutrinoAPI BIN 档案 (6/8 位, 含发卡行/国家/卡类型/3DS)
// 认证: user-id + api-key 通过环境变量 NEUTRINO_UID / NEUTRINO_KEY 提供
// (key 不硬编码进代码, 避免泄露; 没有 key 时返回提示)
app.get('/api/paycheck/neutrino/:bin', async (req, res) => {
  const bin = req.params.bin.replace(/\D/g, '');
  const uid = process.env.NEUTRINO_UID || '';
  const key = process.env.NEUTRINO_KEY || '';
  if (!uid || !key) {
    return res.json({ success: false, error: '未配置 Neutrino key。请在启动时设置环境变量: NEUTRINO_UID=xxx NEUTRINO_KEY=xxx node server.js' });
  }
  if (bin.length < 6) return res.json({ success: false, error: '需要 6 位 BIN' });
  try {
    const r = await fetch(`https://neutrinoapi.net/bin-lookup?bin-number=${bin}&user-id=${uid}&api-key=${key}`, {
      signal: AbortSignal.timeout(15000)
    });
    const t = await r.text();
    let j;
    try { j = JSON.parse(t); } catch (e) { return res.json({ success: false, error: '响应非 JSON: ' + t.slice(0, 200) }); }
    if (!r.ok || j.apiError) return res.json({ success: false, error: j.apiErrorMsg || `Neutrino ${r.status}` });
    // 兼容 kebab-case / camelCase / snake_case 三种字段命名
    const norm = {}
    norm.bin = j['bin-number'] || j.binNumber || j.bin;
    norm.valid = j.valid;
    norm.brand = j['card-brand'] || j.cardBrand || j.brand;
    norm.country = j.country || j['country-code'] || j.countryCode;
    norm.countryCode = j['country-code'] || j.countryCode;
    norm.issuer = j.issuer || j['issuer-name'] || j['bin-issuer'] || j.issuerName;
    norm.type = j['card-type'] || j.cardType || j.type;
    norm.threeDSecure = j['three-d-secure'] ?? j.threeDSecure ?? j['3ds'] ?? j['three_ds'] ?? j.threeDs ?? j['3ds-enrolled'] ?? null;
    res.json({ success: true, data: norm, raw: j });
  } catch (e) { res.json({ success: false, error: 'Neutrino 请求失败: ' + e.message }); }
});
app.post('/api/paycheck/adyen', async (req, res) => {
  const bin = ((req.body && req.body.bin) || '').replace(/\D/g, '');
  const key = ((req.body && req.body.key) || '').trim();
  const merchant = ((req.body && req.body.merchant) || '').trim();
  const cluster = ((req.body && req.body.cluster) || 'live').trim();
  if (bin.length < 4 || !key) return res.json({ success: false, error: '需要 BIN 和 Adyen API key' });
  try {
    const r = await fetch(`https://${cluster}.${['au','br','ap'].includes(cluster) ? cluster : 'eu'}.adyen.com/binlookup/v51/bins/${bin}${bin.length >= 8 ? '?request.threeDSecure=true' : ''}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'merchant-account': merchant, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin, request: { threeDSecure: true } }),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ success: false, error: `Adyen ${r.status}: ${j.message || j.errorType || ''}`.trim(), code: r.status });
    res.json({ success: true, data: j });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 校验记录 (历史存档, 不敏感: 只存结论, 不存完整卡号/CVV)
app.get('/api/paycheck/records', (req, res) => {
  const d = loadData();
  const list = (d.paycheckRecords || []).slice().reverse();
  res.json(list);
});
app.post('/api/paycheck/records', (req, res) => {
  const d = loadData();
  if (!d.paycheckRecords) d.paycheckRecords = [];
  const r = req.body || {};
  const rec = {
    id: genId('PC'),
    bin: String(r.bin || '').slice(0, 8),
    service: String(r.service || '').slice(0, 60),
    gateway: String(r.gateway || '').slice(0, 40),
    amountUsd: Number(r.amountUsd) || 0,
    signals: r.signals || {},          // { ipCountry, billCountry, cardCountry }
    threesds: !!r.threesds,          // BIN 是否 3DS 支持
    declineCodes: Array.isArray(r.declineCodes) ? r.declineCodes.map(x => String(x).slice(0, 40)) : [],
    verdict: String(r.verdict || '').slice(0, 300),
    notes: String(r.notes || '').slice(0, 500),
    ts: Date.now()
  };
  d.paycheckRecords.push(rec);
  // 只保留最近 100 条
  if (d.paycheckRecords.length > 100) d.paycheckRecords = d.paycheckRecords.slice(-100);
  saveData(d);
  res.json({ success: true, record: rec });
});
app.delete('/api/paycheck/records/:id', (req, res) => {
  const d = loadData();
  const before = (d.paycheckRecords || []).length;
  d.paycheckRecords = (d.paycheckRecords || []).filter(x => x.id !== req.params.id);
  saveData(d);
  res.json({ success: true, removed: before - d.paycheckRecords.length });
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
