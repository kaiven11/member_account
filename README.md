# MemberManager 会员账号管理平台

统一管理「商品 · BIN · 会员账号」。项目位于 `D:\project\member_manager`。

## 功能

### 1. 商品管理
- 商品名称
- 官网地址（网址对应 BIN）
- **BIN 列表**（一个商品支持多个 BIN，可增删）
- 商品搜索

### 2. 账号管理
- **批量导入**（粘贴文本，每行 `email|password`）
- **删除**（单个 / 批量选中 / 按商品清空）
- **搜索**（邮箱 / 密码 / 商品 / 备注）
- 按商品 / 状态筛选
- 复制账号（email|password）、批量复制选中、导出 CSV
- 状态标记：会员 / 免费 / 已过期（行内直接切换）
- **编辑账号**（邮箱 / 密码 / 商品 / 状态 / 到期时间 / 备注）

### 3. BIN 卡头管理（独立库）
- BIN 号（卡头）
- **品牌自动识别**（Amex / Visa / Mastercard / Discover / JCB / UnionPay / Mir / DinersClub）
- **分类**（如 试用卡头 / 免3DS / Amex卡头）
- 银行、备注、添加日期
- **有效期管理**：支持 `卡号|月|年|CVV` 导入自动提取有效期；可手动设置
- 按 有效 / 即将过期 / 已过期 筛选与高亮，过期 BIN 置灰
- **批量导入**（多种格式，见下）
- 搜索 + 按品牌/分类/有效性筛选
- 单个 / 批量删除、批量复制选中
- **编辑 BIN**（可手动纠正品牌识别错误）

**批量导入格式**（每行一个，自动智能识别）：
```
559888                       → 品牌自动识别
559888|试用卡头               → 分类
559888|试用卡头|备注          → 分类+备注
559999|Mastercard|Chase|免3DS|好卡头   → 品牌|银行|分类|备注
379550|Amex                  → 品牌（识别为品牌名时）
532655525512|03|29|000      → 卡号|月|年|CVV（自动提取卡号段 + 有效期 2029-03）
```

### 4. 统计
- 商品数、账号数、BIN 总数、HQ 卡头数
- 账号状态分布（会员可用 / 免费 / 已过期），点击卡片可跳转对应筛选
- BIN 有效期分布（有效 / 即将过期 / 已过期 / 未设置），点击可快速筛选

### 5. HQ 卡头管理（高质量卡头参考库）
- 独立库，用于记录去 cc shop 购买卡片时可参考的高质量卡头
- 字段：BIN、CVV、来源链接、评分（S/A/B/C）、成功率、状态（有效/无效/待验证）、备注
- 批量导入格式：`BIN|CVV|来源链接|评分|成功率|备注`，仅 BIN 必填
  ```
  532655525512|000|https://ccshop.example.com/item/1|A|85%|备注
  532655525512|000|https://ccshop.example.com/item/2|B|70%
  532655525512||https://ccshop.example.com/item/3|S
  ```
- 按状态、评分筛选
- 编辑、单条/批量删除、复制

## 启动

双击 `start.bat`，或：
```bash
cd D:\project\member_manager
node server.js
```

访问：**http://localhost:4002**

## 目录结构

```
member_manager/
├── server.js          # Express 后端 (端口 4002)
├── public/index.html  # 前端界面
├── data.json          # 数据 (products / accounts)
├── package.json
└── start.bat
```

## API

### 商品
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/products?q=` | 商品列表（含账号数）|
| POST | `/api/products` | 添加/更新 `{id?, name, site, bins:[], note}` |
| DELETE | `/api/products/:id` | 删除商品 |
| POST | `/api/products/:id/bins` | 加 BIN `{bins:[..]}` 或 `{bin:".."}` |
| DELETE | `/api/products/:id/bins/:bin` | 删 BIN |

### 账号
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts?q=&product=&status=` | 账号列表（搜索/筛选）|
| POST | `/api/accounts` | 添加单个 |
| POST | `/api/accounts/batch` | 批量导入 `{product, productId?, status?, text}` |
| PUT | `/api/accounts/:id` | 更新 |
| DELETE | `/api/accounts/:id` | 删除单个 |
| POST | `/api/accounts/delete-batch` | 批量删除 `{ids:[]}` / `{product}` / `{all:true}` |

### BIN 卡头
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bins?q=&brand=&category=` | BIN 列表（搜索/筛选）|
| GET | `/api/bins/categories` | 分类列表 |
| POST | `/api/bins` | 添加/更新 `{id?, bin, category?, bank?, note?}` |
| POST | `/api/bins/batch` | 批量导入 `{text, category?}` |
| DELETE | `/api/bins/:id` | 删除单个 |
| POST | `/api/bins/delete-batch` | 批量删除 `{ids:[]}` / `{all:true}` |

### 其他
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 统计 |
| GET | `/api/health` | 健康检查 |

## 数据模型

```jsonc
// 商品
{
  "id": "P_...",
  "name": "OpenArt Starter",
  "site": "https://openart.ai",
  "bins": ["3795500", "3795500365"],   // 一个商品多个 BIN
  "note": "",
  "createdAt": 1789492748995
}

// 账号
{
  "id": "A_...",
  "product": "OpenArt Starter",   // 关联商品名
  "productId": "P_...",           // 关联商品 ID
  "email": "xxx@cmzw.cloud",
  "password": "Aa@123456789",
  "status": "member",             // member | free | expired
  "expireAt": "",
  "note": "",
  "createdAt": 1789492748995
}
```

## 端口
默认 **4002**（可用环境变量 `MM_PORT` 覆盖）。
