# 审计 B：云函数 + 云库数据（cloudfunctions/**、cloud-data/**）

- 审计对象：`bread-main/cloudfunctions/**`、`bread-main/cloud-data/**`、`bread-main/config/delivery.js`、`bread-main/shop-config.js`，并交叉核对 `utils/api-map.js`、`utils/data-source.js`、`pages/pay`、`pages/order-view/scan-result`、`pages/my`、`tests/**`、`docs/云开发初始化清单.md`
- 审计方式：**只读**。逐行读代码 + 用 `node` 内联脚本加载 `handlers.js`（不依赖 `wx-server-sdk`）配内存 db 做探针复现 + 用官方文档核对云开发 API 语义
- 纪律：凡"云端是否已建集合/已部署/权限实际值"一律进「三、待验证清单」，不写成已确认缺陷
- 本文所有探针均在内存 db 上跑通，输出见对应小节；**内存 db 不代表真实云库**（见 §2.4）

---

## 一、结论摘要

**分级计数：P0 = 4，P1 = 6，P2 = 10，P3 = 8，合计 28 项。**

最致命的 5 条：

1. **B-P0-1 支付回调可被任意用户伪造**：`index.js:123` 只要客户端在 `callFunction` 的 `data` 里塞 `{outTradeNo, resultCode:'SUCCESS'}` 就直接进入 `handlePayCallback`，无签名、无来源校验、无金额校验，可把任意订单改成"已支付/制作中"。而今天**根本不存在真实的回调来源**（全项目无 `cloudPay.unifiedOrder` 调用），这条分支目前唯一能被触发的途径就是伪造。
2. **B-P0-2 核销接口零鉴权 + 不校验订单状态**：`orderHx`（`handlers.js:747-755`）只查 `hxNumber` 存在，不看调用者是谁、不看订单是否付款。顾客自己下单（不需要付款）→ 自己核销 → 订单变"交易成功"。`adminOpenids` 白名单只写在客户端（`pages/my/index.js:110`），服务端从未读取。
3. **B-P0-3 下单金额/库存完全信任前端 `number`**：`orderCreate` 只对 `price` 做了服务端重算，没有校验数量。探针实测：`number: -5` → 订单金额 **-440 元**、库存 20→**25**（凭空加库存）；`number: "abc"` → 金额 `NaN`；同一请求里放两行 `number: 20`（库存 20）→ **单请求即超卖到 -20**。
4. **B-P0-4 支付闭环不存在但订单已能核销**：`wxpay` 固定返回 501（`handlers.js:449-451`），`pages/pay/index.js:373` 下单后必失败 → 所有订单永久停在"待支付"，但核销照样成功，商家按"待支付"订单出货、收不到钱。当前 AppID 为个人主体（`docs/云开发初始化清单.md:105` 自述"个人主体办不了商户号"）→ **上线前必须做产品决策**：要么接通支付，要么明确关掉线上下单/核销。
5. **B-P1-2 库存无事务、非原子**：扣减/回补都是"先读再写覆盖"（`handlers.js:607-610`、`728-731`），真实云库上并发下单必然超卖、并发取消会重复回补（内存模测不出）。

**已核实通过（第一阶段报告的相关结论已过期，现已修复）**：

- **路由表三方一致**：`handlers.js` 末尾实际注册 **24 个 action**（用 `Object.keys(require(...).handlers)` 取真实键）；`cloudfunctions/README.md` 的接口表恰好 24 个，表里有/代码没有 = 0，代码有/表里没有 = 0；`utils/api-map.js` 实际调用 23 个 action，**全部已注册，无 404**。**`fetchShops`/`shopSubdetail` 已注册**（`handlers.js:465-476` 定义、`987-988` 注册，README:66-67 声明），第一阶段报告 §"路由表残留不一致"已被修复。唯一"已注册但前端不调用"的是 `importData`（设计上从控制台跑）——但见 B-P1-3。
- **身份绑定正确**：`ctx.openid` 一律来自 `cloud.getWXContext().OPENID`（`index.js:127-134`），订单/购物车/用户资料都以它为准；探针在 payload 里塞 `uid/openid/token:'victim'` 被完全忽略，订单 `_openid` 仍是真实调用者。`orderDetail`/`orderClose`/`orderDelete` 均有 `_openid` 二次校验（`699`、`724`、`739`）；`cart*` 全部按 `_openid` 过滤。
- **商品价格确实服务端重算**：`calcPrice` 只读数据库商品与 `priceDelta`（`handlers.js:39-61`），前端传 `price:0.01` 被忽略（`tests/test-cloud-api.js:307-314` 已覆盖）；配送费也服务端重算（`handlers.js:584-599`）。
- **种子数据与 `cloud-data/*.jsonl` 当前完全一致**：脚本比对 `CATEGORIES/BANNERS/APP_CONFIG/GOODS` 与 4 个 jsonl，**0 差异**（26/2/3/5 条）。字段名（`categoryId`/`enabled`/`picUrl`/`priceDelta`/`key`+`value`）与 `handlers.js` 的查询字段一致，未发现"字段拼错查不到数据"。
- **前端没有任何 `wx.cloud.database()` 直连**（全仓 grep 仅命中 `api-map.js` 的 `callFunction`）→ 集合权限规则当前不是安全边界，**安全边界 100% 落在 `handlers.js`**，这正是 P0-2/P1-3 的要害。

---

## 二、缺陷清单

### 2.1 汇总表

| 编号 | 级别 | 标题 | 位置 | 一句话影响 |
|---|---|---|---|---|
| B-P0-1 | P0 | 支付回调通道可被客户端伪造 | `api/index.js:121-125, 100-119` | 任意订单可被改成"已支付"，无签名/无金额校验 |
| B-P0-2 | P0 | `orderHx` 无调用者鉴权、不校验订单状态 | `api/handlers.js:747-755` | 任何人可核销他人/未支付/已取消订单，白名单只在客户端 |
| B-P0-3 | P0 | `orderCreate` 不校验 `number` | `api/handlers.js:519-561, 607-610` | 负金额订单、`NaN` 金额、凭空加库存、单请求超卖 |
| B-P0-4 | P0 | 支付未接入但订单可下单并核销 | `handlers.js:449-451`、`pages/pay/index.js:373` | 订单永远"待支付"，却可核销出餐，商家收不到钱 |
| B-P1-1 | P1 | 下单可绕过购物车/规格必选/上架校验 | `handlers.js:142-162, 490-561` | 只选部分规格、非法规格值、已下架商品都能下单 |
| B-P1-2 | P1 | 库存扣减/回补无事务、非原子 | `handlers.js:607-610, 720-733` | 真实云库并发超卖、并发取消重复回补 |
| B-P1-3 | P1 | `importData` 无鉴权 | `handlers.js:784-968`（路由 `983`） | 任意用户可写入种子数据、枚举 user/cart/order 记录数、全表扫描 |
| B-P1-4 | P1 | `dbAdapter.find` 的 `skip>2000` 静默截断 | `api/index.js:40-49` | 超 2100 条的集合静默丢数据，`total` 失真 |
| B-P1-5 | P1 | 无 `config.json`：超时/内存/权限未声明 + 多轮往返 | `cloudfunctions/api/`（无 config.json） | 默认超时下可能超时，超时后副作用不一致且被降级掩盖 |
| B-P1-6 | P1 | 扫码核销结果页在云模式下必失败 | `api-map.js:286-291` + `handlers.js:694-696` | `orderDetail` 忽略 `hxNumber` → "缺少订单 id"，商家扫码见空白页 |
| B-P2-1 | P2 | 三副本一致性仅由测试 7/27 键守护 | `tests/test-delivery.js:342-401` | 20 个配置键（含 `area.keywords`）漂移不报警 |
| B-P2-2 | P2 | `mallName` 三来源不一致 | `api/shop-config.js:23-30` + `handlers.js:372` | 云函数副本没有 `name`，改 `shop-config.js` 门店名不生效 |
| B-P2-3 | P2 | `appConfig` 下发核销白名单给所有用户 | `handlers.js:378, 369-395` | 商家 openid 泄露 + 造成"前端门控=已鉴权"假象 |
| B-P2-4 | P2 | 购物车价格快照 vs 结算价不一致 | `handlers.js:167-203` vs `533` | 购物车显示 108 元、结算 400 元（探针实测） |
| B-P2-5 | P2 | `updateUser` 字段名与前端不一致 | `handlers.js:316-322` | 前端传 `gender/city/province` 被丢弃，性别永不保存 |
| B-P2-6 | P2 | `removeWhere` 逐条删除 + 注释错误 | `api/index.js:85-92` | N 次往返（叠加 find 截断），官方其实支持条件删除 |
| B-P2-7 | P2 | 无索引声明 + 权限文档误导 | `cloud-data/**`、README:129-146 | 索引全靠控制台手建；文档暗示集合权限是安全边界（实为 admin 绕过） |
| B-P2-8 | P2 | `02-schema-goods.js` 示例字段 `price` ≠ 生效字段 `priceDelta` | `cloud-data/02-schema-goods.js:86-104, 113` | 照示例录商品 → 所有尺寸同价；`pics` 还有两种形态 |
| B-P2-9 | P2 | "运费待确认"按 0 计入应付金额 | `handlers.js:592` | 3km 外订单金额不含运费，与文案矛盾，商家可能漏收 |
| B-P2-10 | P2 | `orderDelete` 不校验订单状态 | `handlers.js:735-742` | 已核销/已支付订单可被顾客永久删除，丢失凭证 |
| B-P3-1 | P3 | 死代码 | `api/index.js:27`；`handlers.js:922-927` | 未使用的 `_`；两分支完全相同的 if/else |
| B-P3-2 | P3 | 副本文件头注释"自指" | `api/delivery-config.js:7`、`api/delivery-calc.js:7` | "改两处"提醒失效（写成"与本文件是两份副本"） |
| B-P3-3 | P3 | 文档数字/清单不符 | `docs/云开发初始化清单.md:170`、`cloud-data/README.md:51-56` | 写"23 个 action"（实际 24）；26 个分类只列了 25 个 |
| B-P3-4 | P3 | `cart_structure` 已过期且缺字段 | `cloud-data/02-schema-goods.js:119-128` | 缺 `key`/`price`，且称"购物车存在 api工厂 服务器" |
| B-P3-5 | P3 | `wx-server-sdk` 版本落后、无 `engines` | `api/package.json:6-8` | 钉在 `~2.6.3`（npm 最新 4.0.2），运行时未声明 |
| B-P3-6 | P3 | 内部异常原文回传客户端 | `handlers.js:1023` | 泄露集合名/错误码等内部结构 |
| B-P3-7 | P3 | `shop-config.js` 注释与实现相反 | `api/shop-config.js:16-17, 36` | 注释说"留空=不限制"，实现是"入口不显示且服务端不校验" |
| B-P3-8 | P3 | 核销码无唯一性约束 | `handlers.js:613-614, 640, 750` | 同毫秒碰撞 → 核销错单；`findOne` 无排序取任意一条 |

---

### 2.2 P0 详情

#### B-P0-1 支付回调通道可被客户端伪造（`api/index.js:121-125`、`100-119`）

```js
exports.main = async (event, context) => {
  // 支付回调分支：由微信支付触发，不带 action
  if (event && event.outTradeNo && event.resultCode) {
    return handlePayCallback(event)
  }
```
```js
async function handlePayCallback(event) {
  const outTradeNo = event.outTradeNo
  const resultCode = event.resultCode
  if (resultCode !== 'SUCCESS') return { errcode: 0, errmsg: 'ignored' }
  const res = await db.collection('order').where({ orderNumber: outTradeNo }).limit(1).get()
  const order = res.data[0]
  if (order) {
    await db.collection('order').doc(order._id)
      .update({ data: { status: 1, statusStr: '制作中', payTime: Date.now() } })
  }
```

- **影响**：任意小程序用户只要知道订单号（自己下单即可获得，`orderCreate` 就返回 `orderNumber`），构造 `wx.cloud.callFunction({name:'api', data:{outTradeNo:'<自己的订单号>', resultCode:'SUCCESS'}})`，即可把自己的订单标记为"已支付/制作中"，而**没有任何真实扣款**。这正是第一阶段报告称"已删除 orderPay 假支付"后遗留的等价后门。
- **触发条件**：`wx.cloud.callFunction` 的 `data` 会原样成为云函数 `event`，字段名撞上 `outTradeNo`/`resultCode` 即命中该分支；不需要登录态、不需要任何白名单。
- **佐证"当前不存在真实来源"**：全仓 grep `cloudPay|unifiedOrder` 只命中注释与 README 文案（`index.js:97`、`handlers.js:445,450`、`README.md:207`），**没有任何调用方**；`wxpay` action 固定返回 501（`handlers.js:450`）。
- **建议改法**：
  1. 短期：删掉/关闭这个事件分支（加 `ENABLE_PAY_CALLBACK` 开关，默认 false）；把回调逻辑迁到独立的、不暴露给客户端的事件入口（云开发支付回调本身带 `returnCode/payTime/totalFee` 等字段与签名语境）。
  2. 接入真实支付时必须：用商户平台证书/云开发支付回调机制验签；校验 `totalFee` 与订单 `amountReal` 一致；用 `outTradeNo` 而非业务订单号做幂等键；回调里写 `status:1` 前先校验当前状态为 0。
  3. 不要用"客户端可见的订单号"作为回调支付凭证。
- **待验证**：见 §3"云控制台确认"第 8 项（确认线上部署版本的 `index.js` 是否已包含该分支及其版本时间）。

#### B-P0-2 `orderHx` 无调用者鉴权、不校验订单状态（`api/handlers.js:747-755`）

```js
async function orderHx(payload, ctx) {
  const hxNumber = payload && payload.hxNumber
  if (!hxNumber) return fail('缺少核销码')
  const o = await ctx.db.findOne('order', { hxNumber })
  if (!o) return fail('核销码无效')
  if (o.status === 3) return fail('该订单已核销')
  await ctx.db.update('order', o._id, { status: 3, statusStr: '交易成功' })
  return ok({ id: o._id, orderNumber: o.orderNumber })
}
```

- **问题 1：无身份校验**。`ctx.openid` 完全没用到；`cloudfunctions/api/shop-config.js:36` 的 `adminOpenids: []` 白名单**只被 `appConfig` 用作下发给前端的展示开关**（`handlers.js:378` → `pages/my/index.js:106-110` 计算 `canHX`），服务端没有任何一处读取它。前端 `canHX` 只是控制按钮显示，改本地 storage 即可绕过。
- **问题 2：不校验订单状态**。仅拦截 `status === 3`。因此 `status: 0`（待支付）和 `status: -1`（已取消）都能被改成"交易成功"。
- **问题 3：`findOne` 无排序/无唯一约束**（见 B-P3-8）。
- **探针实测**（内存 db，逻辑路径与真实云库一致）：
  ```
  下单后 status = 0 : 待支付
  陌生人核销未支付订单: {"code":0,...,"msg":"success"}
  核销后 status = 3 : 交易成功 ; 订单里有 payTime 吗 = undefined
  非管理员用户核销他人订单: {"code":0,...,"msg":"success"}
  ```
- **触发条件**：任何已登录用户（不需要是商家）知道/拿到任意 `hxNumber` 后直接调用 `orderHx`；或顾客直接核销自己的未支付订单。
- **影响**：a) 顾客零付款取得"交易成功"订单；b) 顾客可核销他人订单（拿到核销码即可，例如订单详情页/二维码被转发、截图）；c) 商家侧无法区分"已核销"与"已付款"；d) 已取消订单被复活为成功订单。
- **建议改法**：
  1. `orderHx` 开头校验 `ctx.openid` 属于管理员白名单（把 `adminOpenids` 移到服务端读取，并加 `enabled` 开关），不在白名单直接 `fail('无核销权限')`。
  2. 只允许 `status === 1`（已支付/制作中）的订单核销；限定合法的前置状态集合。
  3. 用条件更新保证幂等：`db.collection('order').where({_id, status:1}).update({status:3})` 并检查 `stats.updated === 1`。
  4. 核销写审计字段（`hxBy: ctx.openid`、`hxTime`）。
  5. 核销码改成不可猜测的服务端随机串（与订单号解耦）。

#### B-P0-3 `orderCreate` 不校验 `number`（`api/handlers.js:519-561`、`607-610`）

```js
for (const row of goodsJson) {
  const goods = await ctx.db.get('goods', row.goodsId)
  if (!goods) return fail('商品不存在：' + row.goodsId)
  if (goods.stores < row.number) return fail(goods.name + ' 库存不足')   // ← 负数/NaN 都能过
  ...
  const price = calcPrice(goods, sku)
  items.push({ ..., number: row.number, amount: Math.round(price * row.number * 100) / 100, ... })
```
```js
// 扣库存：逐条 get + 覆盖写，且每行都以「同一份快照 stores」判库存
for (const it of items) {
  const goods = await ctx.db.get('goods', it.goodsId)
  await ctx.db.update('goods', goods._id, { stores: goods.stores - it.number })
}
```

- **探针实测**：
  | 输入 | 结果 |
  |---|---|
  | `number: -5` | `code:0`，`amountReal: -440`，库存 20 → **25** |
  | `number: "abc"` | `code:0`，`amountReal: null`（`NaN`），库存写成一个非数字 |
  | 同一请求两行各 `number: 20`（库存 20） | `code:0`，`amountReal: 3520`，库存 → **-20** |
- **影响**：负金额订单、库存被恶意追加（可无限刷库存后再让商家备货）、`NaN` 金额订单导致对账/展示异常、**单个请求即可超卖**（不需要并发）。
- **触发条件**：`goodsJsonStr` 是前端可控字符串（`ctx` 侧只做 `JSON.parse`，`handlers.js:500-505`），任何用户都能直连 `orderCreate` 传任意 `number`。
- **建议改法**：`number` 必须 `Number.isInteger(n) && n > 0 && n <= 上限(如 99)`，否则 `fail`；金额用整数分计算避免浮点；同一 `goodsId+sku` 在请求内先去重合并再校验总数量；库存扣减改为原子条件更新（见 B-P1-2）。

#### B-P0-4 支付闭环不存在，但订单能下单并核销（`handlers.js:449-451`、`pages/pay/index.js:339-373`）

```js
async function wxpay(payload, ctx) {
  return fail('云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）', 501)
}
```
```js
const res = await API.orderCreate(postData)
if (res.code != 0) { ... return }
...
wxpay.wxpay('order', res.data.amountReal, res.data.id, "/pages/current-order/index");
```

- **影响**：下单成功（已扣库存、已建 status:0 订单、已清购物车）→ 紧接着支付必失败 → 订单永久停在"待支付"。而 B-P0-2 使核销不受付款约束 → 商家看到"待支付"订单却可能已被核销成"交易成功"，资金必然收不到。
- **客观约束**：`docs/云开发初始化清单.md:105` 自述"个人主体办不了商户号"，`utils/data-source.js:56-61` 的 AppID/环境是个人测试主体（`wx5b0e027deafefc01`）。
- **建议改法（三选一，需业务决策）**：
  - A. 上线前完成企业主体 + 商户号 + `cloudPay.unifiedOrder` 接线 + 回调验签（正解，工作量最大）；
  - B. 明确产品形态为"线上下单、线下当面收款"，则**移除核销即成功**的语义、订单加"待收款"状态，并在页面明确文案；
  - C. 暂时关闭线上支付入口与核销入口，只保留浏览/加购，避免产生不可兑付订单。

---

### 2.3 P1 详情

#### B-P1-1 下单可绕过购物车/规格必选/上架校验（`handlers.js:490-561`、`142-162`）

- `cartAdd` 有完整规格必选校验（`handlers.js:222-232`：每组必选、选项必须存在），但**真正落单的 `orderCreate` 没有**：它只把 `propertyChildIds` 解析成 `sku` 后交给 `calcPrice`，缺组、选项不存在都不会报错。
- **探针实测**：
  | 输入 | 结果 |
  |---|---|
  | 商品有两组规格（磅数+口味），只传 `size:s6` | `code:0`，订单 `property:"6寸"`（口味缺失） |
  | `propertyChildIds: 'size:NOT_EXIST,flavor:FAKE'` | `code:0`，`amountReal: 54`，订单 `property:""` |
  | 商品 `enabled:false`（列表接口正确返回 0 条） | `orderCreate` 仍 `code:0` 成功下单并扣库存 |
- **影响**：规格缺失/非法的订单落到商家（无法备货、无法区分尺寸），`enabled:false` 的下架商品可被继续下单（绕过运营下架），`propertyChildIds` 完全不受信。
- **触发条件**：直接调用 `orderCreate`（不看购物车，`goodsJsonStr` 自造）。
- **建议改法**：`orderCreate` 复用 `cartAdd` 的同一套校验函数（每组必选 + 选项必须属于该商品 + 解析出的 sku 与请求一致）；校验 `goods.enabled !== false`；校验 `goodsId` 去重与数量上限。

#### B-P1-2 库存扣减/回补无事务、非原子（`handlers.js:607-610`、`720-733`）

```js
// 下单：先 get 再覆盖写
for (const it of items) {
  const goods = await ctx.db.get('goods', it.goodsId)
  await ctx.db.update('goods', goods._id, { stores: goods.stores - it.number })
}
// 取消：先 get 再覆盖写回补
for (const it of o.goods || []) {
  const goods = await ctx.db.get('goods', it.goodsId)
  if (goods) await ctx.db.update('goods', goods._id, { stores: goods.stores + it.number })
}
```

- **影响（真实云库才暴露，内存模测不出）**：
  1. 并发下单：两个请求都读到 `stores: 1` → 都通过校验 → 覆盖写后库存为 0/-1 → 超卖；
  2. 并发取消同一订单：两次都读到 `status:0`（校验与写入非原子，`725-726`）→ 库存回补两次；
  3. `orderCreate` 是"校验→扣减→建单→清购物车"四段非事务流程，中途任一步抛错（超时/网络抖动）会留下"已扣库存但无订单"或"有订单但购物车未清"的脏状态。
- **建议改法**：
  - 单商品条件更新（推荐先落地）：`db.collection('goods').where({_id, stores: _.gte(n)}).update({data:{stores: _.inc(-n)}})`，检查 `stats.updated===1`，否则回滚已扣项并失败；云数据库 `command.inc` 是原子操作。
  - 多商品用云开发事务（`db.startTransaction()`），把"库存校验+扣减+建单+清购物车"放同一事务，取消同理。
  - 状态流转用条件更新：`where({_id, status:0}).update({status:-1})` 保证只取消一次。
- 注：`index.js:27` 已 `const _ = db.command` 但从未使用（见 B-P3-1），做原子更新正好需要它。

#### B-P1-3 `importData` 无任何鉴权（`handlers.js:784-968`，路由 `983`）

```js
const checkOnly = !!(payload && payload.checkOnly)
...
const COLLECTIONS = ['category','goods','banner','app_config','user','cart','order']
for (const col of COLLECTIONS) {
  try { const rows = await ctx.db.find(col, {}, {}) ; report.collections[col] = { exists:true, count: rows.length } }
  catch (e) { ... }
}
if (checkOnly) return ok(report)
... report.seed.category = await seed('category', CATEGORIES, '_id') ...
```

- **影响**：这个"初始化用、控制台手动跑"的 action 被注册进了公开路由，**dispatch 不做任何限制**（`handlers.js:1017-1025`）：
  1. 不带 payload 调用 = `checkOnly:false` → **真的写数据**（插入 26 分类/5 商品/2 轮播/3 配置，已有同 `_id` 才跳过）；
  2. `checkOnly:true` → 返回 `user/cart/order` 三个**用户数据集合的记录数**与集合是否存在（探针实测返回完整 `collections` 结构）；
  3. 每次调用都对 7 个集合做全量 `find`（分页最多 21 次往返/集合，见 B-P1-4），无鉴权即可被反复触发 → 配额消耗。
- **触发条件**：`wx.cloud.callFunction({name:'api', data:{action:'importData'}})`（任意用户）。
- **建议改法**：把 `importData` 从公开路由中移除（改由云开发控制台「云端测试」直接调用导出函数，或用 `ctx.openid` 与管理员白名单比对后再放行）；`checkOnly` 之外禁止默认写入；`count` 用 `db.collection().count()` 而不是全量 find。

#### B-P1-4 `dbAdapter.find` 的 `skip>2000` 静默截断（`api/index.js:40-49`）

```js
const MAX = 100
let all = []
let skip = 0
while (true) {
  const res = await q.skip(skip).limit(MAX).get()
  all = all.concat(res.data)
  if (res.data.length < MAX) break
  skip += MAX
  if (skip > 2000) break // 兜底，避免死循环
}
return all
```

- **影响**：单次查询最多返回 **2100 条**，超出部分**静默丢弃、不报错**。命中路径：
  - `goodsList`（`handlers.js:101`）先取全量再 `slice`，`total = docs.length`（`103`）→ 商品超 2100 时**列表不全且 total 错误**（前端分页依据失真）；
  - `orderList`（`665`）取用户全量订单后在内存按 `statusBatch` 过滤（`667-672`）→ 订单超 2100 的老用户"最近订单"丢失；
  - `importData` 自检计数（`939`）、`removeWhere`（`87`）同样被截断。
- **触发条件**：集合记录数 > 2100（商品图/订单量正常的店铺 1-2 年就会到）。
- **建议改法**：把分页/过滤下推到数据库：`goodsList` 用 `where(enabled, categoryId).orderBy('sort').skip((page-1)*pageSize).limit(pageSize)` + `count()` 取总数；`orderList` 用 `where({_openid, status: _.in([...])})`；把硬上限改成显式报错（`fail('数据量过大，请缩小范围')`）而不是静默截断；官方 `count()` API 已可用（[collection.count](https://developers.weixin.qq.com/miniprogram/en/dev/wxcloud/reference-server-api/database/collection.count.html)）。

#### B-P1-5 无 `config.json`：超时/内存/权限未声明 + 多轮往返（`cloudfunctions/api/`）

- 事实：`cloudfunctions/` 下**没有任何 `config.json`**（`glob cloudfunctions/**/*.json` 无结果，仅有 `api/package.json`）。因此云函数的超时、内存、运行环境、`openapi` 权限全部依赖控制台默认值，**代码里不可见、不可复现、无法评审**。
- 结合代码的往返次数：
  - `orderCreate`：每个商品行 1 次 `get` + 扣库存阶段再 1 次 `get` + 1 次 `update`，10 行商品 ≈ 30 次串行往返；
  - `find` 每 100 条一次往返（`index.js:43-49`），`goodsList`/`importData` 大集合可达 21 次/集合；
  - `cartSummary` 对每个 `goodsId` 单独 `get`（`handlers.js:186-190`）→ N+1。
- **影响**：默认超时（社区与官方实践常为 3 秒，[官方社区帖](https://developers.weixin.qq.com/community/minihome/doc/000604d679c310fb00246188a6bc00)）下，多行下单/大集合列表可能超时；超时发生在"已扣库存、未建单"或"已建单、未清购物车"之间 → 脏状态；客户端只看到 `code:500`，而 `api-map.js:99-111` 会因 `code===500` 触发 legacy 降级弹窗（`api-map.js:105`），把"云函数超时"显示成"云开发不可用，已临时降级"，误导排查方向。
- **建议改法**：补 `cloudfunctions/api/config.json`（显式 `timeout`/`memorySize`/`permissions`，如 `{"timeout": 20}` 视套餐）；减少往返（批量 `_.in(ids)` 查商品、`count()` 取总数、事务内完成扣减+建单）；把"可预期的业务失败"与"系统异常"用不同 code 区分，避免 500 触发降级。

#### B-P1-6 扫码核销结果页在云模式下必失败（`api-map.js:286-291` + `handlers.js:694-696`）

```js
// utils/api-map.js
orderDetail: pick(
  (token, orderId, hxNumber) => callCloud('orderDetail', { id: orderId, hxNumber }),
  (token, orderId, hxNumber) => LEGACY.orderDetail(token, orderId, hxNumber)
),
```
```js
// pages/order-view/scan-result.js:41
const res = await API.orderDetail(wx.getStorageSync('token'), '', this.data.hxNumber)
```
```js
// handlers.js
async function orderDetail(payload, ctx) {
  const id = payload && payload.id                 // ← 完全忽略 payload.hxNumber
  if (!id) return fail('缺少订单 id')
```

- **探针实测**：`dispatch('orderDetail', { id:'', hxNumber:'<真实核销码>' })` → `{"code":1,"msg":"缺少订单 id"}`。
- **影响**：商家扫码进入 `pages/order-view/scan-result` 后 `res.code!==0`，页面**没有任何错误提示**（`scan-result.js:42-47` 只在成功分支 `setData`），界面空白；后续「核销完成」按钮仍可点（`doneHx` 走 `orderHXV2`，能成功），但商家看不到待核销订单的内容（商品、地址、金额）——**盲核销**。
- **建议改法**：`orderDetail` 支持 `hxNumber` 查询（与原 api工厂 语义一致："订单 id 和核销码同时传的话，核销码优先"，见 `node_modules/apifm-wxapi/instructions.md:1826`），并对非本人订单要求调用者具备核销权限（与 B-P0-2 同一鉴权函数）；页面补失败提示。

---

### 2.4 P2 详情

#### B-P2-1 三副本一致性只被测试覆盖 7/27 个键（`tests/test-delivery.js:342-401`）
- 实测两副本当前状态：`utils/delivery-range.js` vs `cloudfunctions/api/delivery-calc.js` = **仅 4 行差异（都是 require 路径）**，逻辑完全一致；`config/delivery.js` vs `cloudfunctions/api/delivery-config.js` = **0 行差异**。当前**没有漂移**。
- 但 `config/delivery.js` 有 **27 个叶子配置键**，第 13 节一致性断言只比较其中 **7 个**：`distance.freeWithinKm`、`freight.withinFreeAmount`、`freight.withinFee`、`cake.enabled`、`cake.minSizeInch`、`cake.overrideThreshold`、`advance.minHours`。**20 个键无守护**，其中包含直接影响钱和履约的：
  `area.mode`、`area.keywords`（配送区域关键词！）、`area.maxSaneKm`、`freight.beyondEnabled`、`freight.beyondFee`、`cake.freeWithinKm`、`cake.sizeSpecName`、`advance.applyToAll`、`advance.slotMinutes` 等。
- 「靠测试防漂移」不足的另外两点：a) 只比较“值”，不比较**逻辑函数**（仅抽样 3 个场景：`calcQuote` 两例 + `calcDistanceKm` 一例，`checkAdvanceTime`/`buildTimeSlots`/`isCakeGoods` 完全没比对）；b) 依赖开发者自觉跑 `npm test`，项目无 Git、无 CI（见审计 D）。
- **更稳的方案（按推荐度）**：
  1. **构建期生成（推荐）**：建立唯一源 `shared/delivery/*.js`，在 `npm test`/上传前跑 `npm run sync:cloud`（脚本把唯一源 + 改写 require 路径后写到 `cloudfunctions/api/`），并把一致性断言改成**全量键 + 深度字符串比较**（含函数体）——即"源改了但没同步"直接测试失败。
  2. **运行时单一源**：把配送规则放进云数据库 `app_config`（如 `delivery_config` 一条 JSON），前端启动时读取、云函数下单时读取 → 物理上消除副本（代价：多一次读、离线不可用、规则改动需审计）。
  3. 云函数 `require` 主包文件不可行（独立打包），排除。
- 另外把 `cloudfunctions/api/delivery-config.js:7` 的注释改为指向 `config/delivery.js`（现为自指，见 B-P3-2）。

#### B-P2-2 `mallName` 存在三个来源且互不同步（`api/shop-config.js:23-30` + `handlers.js:372`）
```js
// cloudfunctions/api/shop-config.js —— shop 里没有 name！
module.exports = { shop: { latitude: 24.9195, longitude: 102.4840, openingHours: '09:00-22:00' }, ... }
// handlers.js
mallName: (SHOP.shop && SHOP.shop.name) || '卿欢蛋糕',
```
- 云函数副本刻意不含 `name`，`SHOP.shop.name` 恒为 `undefined`，`mallName` 实际来自**硬编码字面量 `'卿欢蛋糕'`**（或 `app_config` 集合覆盖）。而根目录 `shop-config.js:29` 的 `name: '卿欢蛋糕'` 才是"门店名唯一来源"的注释所宣称的地方（`api/shop-config.js:8` "必须与根目录 shop-config.js 的 shop 字段保持一致"）。
- **影响**：商家在 `shop-config.js` 改名 → 首页导航标题不变（云函数仍返回旧值/硬编码值）；改 `app_config` 集合才生效，但没人知道。文档/注释与实际不符。
- **建议**：`mallName` 单一来源（推荐直接用云库 `app_config`，其次在云函数副本里也放 `name` 并纳入一致性断言）。

#### B-P2-3 `appConfig` 把核销白名单下发给所有用户（`handlers.js:378`）
- `order_hx_uids: (SHOP.adminOpenids || []).join(',')` 会随 `appConfig` 返回给**每一个用户**（`pages/my/index.js:106` 从 storage 读取）。商家 openid 属个人信息，且这套"前端判断是否显示核销入口"的设计让人误以为有权限控制，实际服务端不校验（B-P0-2）。
- **建议**：服务端返回布尔能力位（如 `{key:'can_hx', value:true/false}` 针对当前 openid 计算），不下发白名单原文；真正鉴权在 `orderHx`。

#### B-P2-4 购物车价格快照 vs 结算价不一致（`handlers.js:167-203`）
- `cartAdd` 把当时算出的 `price` 存进 cart 文档（`235, 244-252`），`cartItemsOf` 直接展示该快照（`176`）；`orderCreate` 则**重新按数据库现价计算**（`533`）。
- **探针实测**：加购 2 件（54 元/件，购物车显示 108）→ 商家把 `minPrice` 改为 200 → 购物车仍显示 `price:54 / 总数 108`，而 `orderCreate` 的 `amountReal = 400`。顾客看到 108、实付 400。
- **建议**：`cartSummary` 每次用当前商品价重算（快照只用于展示"加购时价格"并显式提示变化），或下单前返回价格变更提示让顾客确认。

#### B-P2-5 `updateUser` 字段名与前端不一致（`handlers.js:316-322`）
```js
const allow = ['nick', 'avatarUrl', 'sex', 'birthday', 'mobile']
```
- `pages/my/index.js:133-141` 提交的是 `gender/city/province`；`gender` 不在白名单 → 被静默丢弃。`getUser` 又用 `gender: user.gender ?? user.sex` 返回（`301`），因 `sex` 从未写入 → **用户性别永远是 0**。
- **探针实测**：`updateUser({nick:'小明', gender:1, city:'昆明市', province:'云南省'})` → 返回 `base: {nick:'小明', sex:0, gender:0}`。
- **建议**：统一字段名（建议后端收敛为 `gender`，白名单加 `gender`；保留 `sex` 兼容读取），`city/province` 要么接收要么从文档中移除。

#### B-P2-6 `removeWhere` 逐条删除 + 注释与官方语义矛盾（`api/index.js:85-92`）
```js
async removeWhere(collection, where) {
  // 云开发不支持条件删除，需先查出再逐条删
  const docs = await this.find(collection, where, {})
  for (const d of docs) { await db.collection(collection).doc(d._id).remove() }
  return { removed: docs.length }
}
```
- 官方**云函数端支持 `Query.remove()`**，示例即 `db.collection('todos').where({done:true}).remove()`（[Collection.remove / Query.remove](https://developers.weixin.qq.com/miniprogram/en/dev/wxcloud/reference-server-api/database/collection.remove.html)）。当前实现是 O(n) 次往返，且受 `find` 的 2100 条截断影响 → 清空购物车（`orderCreate:648`、`cartRemoveAll:281`）在极端情况下**删不干净**。
- **建议**：`return db.collection(collection).where(where).remove()` 取 `stats.removed`。

#### B-P2-7 无索引声明 + 集合权限文档误导（`cloud-data/**`、`cloudfunctions/README.md:129-146`）
- 代码仓库中**没有任何索引定义或建议**（`grep 索引` 在 `cloud-data/**`、`docs/**` 均无命中）。按当前查询形态，需要在控制台建：
  | 集合 | 建议索引（复合，字段顺序即查询顺序） | 对应查询 |
  |---|---|---|
  | `goods` | `enabled(asc) + categoryId(asc) + sort(asc)` | `goodsList`（`handlers.js:97-101`） |
  | `category` | `enabled(asc) + sort(asc)` | `categoryList`（`77`） |
  | `banner` | `enabled(asc) + sort(asc)` | `banners`（`342`） |
  | `order` | `_openid(asc) + dateAdd(desc)`；另建 `hxNumber(asc)`；建议 `orderNumber` 唯一 | `orderList`（`665`）、`orderHx`（`750`） |
  | `cart` | `_openid(asc) + key(asc)` | `findOne`/`removeWhere`（`237,260,281`） |
  | `user` | `_openid(asc)` | `getUser`（`293`） |
  | `app_config` | `key(asc)` 唯一 | `appConfig`（`386`） |
- 权限文档问题：README:129-146 与 `docs/云开发初始化清单.md:44-55` 都强调集合权限"必须是仅创建者可读写，否则顾客互相看到购物车/订单"。这条本身没错（防客户端直连），但**读起来像"安全边界"**。已核实：全项目**没有 `wx.cloud.database()` 直连**，云函数以 admin 权限运行、完全绕过安全规则 → **集合权限对当前架构不是安全边界，`handlers.js` 才是**。文档需要明确这一点，否则会继续产生 B-P0-2 那样"前端门控即安全"的误判。
- **建议**：把索引清单写进 `cloud-data/README.md` 与 `docs/云开发初始化清单.md`，权限说明补一句"云函数走 admin 权限，权限规则只防客户端直连；所有鉴权必须在 handlers 内实现"。

#### B-P2-8 `02-schema-goods.js` 示例字段 `price` ≠ 代码生效字段 `priceDelta`（`cloud-data/02-schema-goods.js:86-104, 113`）
```js
// 示例（86-104）用 price（且语义是"绝对价"）
childsCurGoods: [ { id: 'size_4', name: '4寸', price: 54 }, { id: 'size_6', name: '6寸', price: 88 } ]
// 同文件 113 行却明确说
'childsCurGoods[].priceDelta': '该选项的【加价】（0 表示不加价）。★ 实际生效字段，选它就对了',
```
- 而 `handlers.js:39-42` 只读 `priceDelta`，`calcPrice` 也是"基础价 + 加价"（`49-61`）。**照 `example_goods` 录商品 → 所有尺寸同价**（`price` 被忽略）。
- 同时 `pics` 在示例里是字符串数组（`73-76`），而 `importData` 种子与 `handlers.js` 用的是 `[{pic}]` 对象数组（`829`、`158`）；前端 `pages/goods-details/index.wxml:15` 注释说"兼容两种"，但两套模板并存本身就是录入陷阱。
- **建议**：示例改用 `priceDelta` 并给出"最终价 = minPrice + Δ"的算式；`pics` 统一一种形态并同步改 wxml 与所有种子。

#### B-P2-9 "运费待确认"按 0 计入应付金额（`handlers.js:592`）
```js
freight = quote.freight === null ? 0 : quote.freight
```
- 3km 外/无坐标场景 `quote.freight === null`（`delivery-calc.js:307,319`），订单 `amountReal` 不含任何运费，而订单里同时保存了 `freightText:'运费待确认'`（`629-634`）。对账时"应收金额"与"待确认运费"分离，商家容易漏收（尤其 `pages/pay` 展示的金额也没有运费项）。
- **建议**：待确认订单单独状态/字段（如 `freightPending:true`、`amountReal` 只记商品额），页面明确"运费线下另计"，或禁止 3km 外线上下单（`freight.beyondEnabled=false`）。

#### B-P2-10 `orderDelete` 不校验订单状态（`handlers.js:735-742`）
- 只校验归属，不校验状态 → 顾客可删除**已核销（status:3）/已支付**的订单记录（真实删除，非软删），商家侧凭证与对账依据丢失；`orderList` 也不会再显示。删除不回补库存（设计上合理），但与 `orderClose` 的语义差异没有文档说明。
- **建议**：仅允许删除终态且未核销的订单，或改软删除（`deleted:true`）保留凭证。

---

### 2.5 P3 详情

| 编号 | 证据 | 说明与建议 |
|---|---|---|
| B-P3-1 | `api/index.js:27` `const _ = db.command`（全文再无引用）；`handlers.js:922-927` `if (collection==='app_config') { add } else { add }` 两分支完全相同 | 删除未使用变量；if/else 合并（且正是 P1-2 原子更新要用的 `_`） |
| B-P3-2 | `api/delivery-config.js:7` 与 `api/delivery-calc.js:7` 的"⚠️ 与 X 是两份副本"里 X 指向**自己**（实测两份 config 文件 113 行 0 差异，因此云函数副本的自指是复制粘贴错误） | 改为指向 `config/delivery.js` / `utils/delivery-range.js`，否则"改两处"的提醒在云函数侧失效 |
| B-P3-3 | `docs/云开发初始化清单.md:170` 写"云函数 23 个 action"（实际 24，含 `wxpay`）；`cloud-data/README.md:51-56` 的 26 个分类清单只列了 25 个（漏"生日蛋糕"，而 `categories.jsonl:1` 与 `docs:80` 都有它） | 文档数字与清单需与代码/数据对齐；建议 action 数量改为"见 handlers.js 路由表"避免再次漂移 |
| B-P3-4 | `cloud-data/02-schema-goods.js:119-128` 的 `cart_structure` 缺 `key`/`price`/`dateAdd` 的完整说明，且写"当前购物车存在 api工厂 服务器"（阶段二已迁云库；实际结构见 `handlers.js:244-252` 与 `makeCartKey:66-71`） | 更新结构与归属描述 |
| B-P3-5 | `api/package.json:6-8` `"wx-server-sdk": "~2.6.3"`，无 `engines` | npm 最新为 **4.0.2**（[registry](https://registry.npmjs.org/wx-server-sdk/latest)）。落后两个大版本意味着缺修复；建议先评估再升级并回归 `cloud.getWXContext`/`db` 行为，不要盲升；同时补 `engines`（如 `"node": ">=18"`）与运行时说明 |
| B-P3-6 | `handlers.js:1023` `return fail('服务异常：' + e.message, 500)` | 探针实测客户端收到 `"服务异常：collection not exists: order (errCode -502005)"` → 泄露集合名与内部错误码。建议对外统一文案、详情写日志 |
| B-P3-7 | `api/shop-config.js:16-17` 注释"留空数组表示'不限制'"，`:36` `adminOpenids: []`；实现（`handlers.js:378` + `pages/my/index.js:110`）是"入口不显示（canHX 恒 false）"，且服务端**从不校验** | 注释与实现相反，是 B-P0-2 的认知根源，必须改 |
| B-P3-8 | `handlers.js:613-614` `orderNo = String(Date.now()) + 4 位随机`；`640` `hxNumber = orderNo`；`750` `findOne('order',{hxNumber})` 无排序 | 同毫秒内 1/9000 概率碰撞（无唯一索引）；一旦碰撞，`findOne` 取回任意一条 → 核销错单。建议核销码用独立高熵随机串 + 唯一索引，`findOne` 前先 `count()` 校验唯一性 |

---

## 三、待验证清单

> 以下均**未**确认为缺陷，需在云控制台/开发者工具核对后回填。

### A. 云控制台确认（无法从代码判断）

| # | 要确认什么 | 为什么 / 怎么确认 | 若不符的后果 |
|---|---|---|---|
| 1 | 7 个集合是否已建、集合名是否精确为 `category`/`goods`/`banner`/`app_config`/`user`/`cart`/`order` | 数据库 → 集合管理逐一看；注意 `app_config` 带下划线 | 集合名拼错 → `collection not exists`（`docs:102` 已列出该现象） |
| 2 | 各集合权限实际值（尤其 `user`/`cart`/`order` 是否"仅创建者可读写"） | 数据库 → 集合 → 权限设置 | 若为"所有人可读写"，客户端仍无直连（已 grep 确认），但任何未来直连都是全量泄露；属纵深防御缺口 |
| 3 | 索引是否已建（§2.4 B-P2-7 清单） | 集合 → 索引管理；特别看 `order.hxNumber`、`order._openid+dateAdd`、`goods.enabled+categoryId+sort` | 无索引 → 全表扫描 + 分页 skip 性能劣化，配合默认超时可能超时 |
| 4 | `api` 云函数是否已部署、部署时间/版本是否含当前 `handlers.js`（24 个 action） | 云函数 → api → 版本与更新时间；控制台「云端测试」跑 `{action:'fetchShops'}` 应返回 `code:0,data:[]`（若返回 404 说明线上是旧版） | 线上旧版 → 前端 404/缺接口 |
| 5 | 云函数运行时 Node 版本、超时、内存实际配置值 | 云函数 → api → 配置 | 超时过短 → B-P1-5 的超时脏状态；无 `config.json` 时无法从代码追溯 |
| 6 | 环境 ID `cloud1-d7g2txuxpf22bb979` 是否存在、是否与 `project.config.json` 的 AppID 同主体 | 云开发 → 环境设置；对照 `utils/data-source.js:56-61` | 环境不存在/不同主体 → 全部调用失败，触发 legacy 降级弹窗 |
| 7 | `app_config` 集合中 `mallName`/`order_remark_msg`/`order_hx_uids` 的实际值；`shop-config.js` 的 `adminOpenids` 是否已填并**重新部署** | 数据库 → app_config；对照 `docs:119-128` 的填写步骤 | 空值会被 `handlers.js:387` 的 `!== ''` 判空逻辑忽略 → 一直用默认值；`adminOpenids` 为空则任何正确实现的核销鉴权都会锁死所有人 |
| 8 | 线上 `index.js` 是否包含 `handlePayCallback` 事件分支，以及该分支是否真的可被客户端 `callFunction` 触发（B-P0-1 的最终确认） | 云函数 → api → 云端测试，构造 `{"outTradeNo":"<测试订单号>","resultCode":"SUCCESS"}` 观察订单是否变 `status:1` **（务必用测试数据，勿用真实订单）** | 若可触发 → P0 成立，必须立刻关闭该分支 |
| 9 | 个人主体 AppID 能否开通微信支付商户号（`docs:105` 称不能） | 微信支付商户平台申请入口 | 不能 → 线上支付永远不可用，必须做产品决策（B-P0-4） |
| 10 | `add` 是否保留了自定义 `_id`（`importData` 的幂等与 `goods.categoryId` 关联依赖它） | 跑一次 `importData` 后查 `category` 的 `_id` 是否为 `cat_birthday` 等；官方文档说明 `_id` 可选自定义（[CloudBase 插入数据](https://cloud.tencent.com/document/product/876/19362)），需实测一次 | 若被自动生成 → `goods.categoryId` 全部失配、商品列表为空、`importData` 反复插入重复数据 |
| 11 | 云端日志中是否有 `[orderCreate] 配送费不一致` 告警（`handlers.js:597`）与超时错误 | 云函数 → 日志，按 `orderCreate` 过滤 | 有告警说明前后端配送规则实际在漂移（当前配置已一致，疑似历史数据/环境不同） |
| 12 | 云函数调用量/费用是否因 `importData` 可被任意调用而异常 | 云开发 → 用量统计 | 异常 → 证实 B-P1-3 被利用 |

### B. 开发者工具确认

| # | 要确认什么 | 关联 |
|---|---|---|
| 1 | 云函数未部署/出错时是否弹出"云开发不可用，已临时降级"（`api-map.js:88-92`），以及降级后 legacy 是否因未 `init` 而立即失败 | B-P1-5；与审计 A 的降级结论交叉 |
| 2 | 下单后支付提示是否为"云开发支付尚未接入…"（`handlers.js:450` 的 501 文案能否透传到页面） | B-P0-4 |
| 3 | 商家扫码核销页是否空白（B-P1-6）、核销二维码 canvas 渲染是否正常 | 与审计 C 交叉 |
| 4 | `goodsDetail.pics` 两种形态（字符串数组 / `{pic}`）在详情页轮播是否都渲染 | B-P2-8 |
| 5 | 四个测试脚本实跑断言数（`test-cloud-api` 74 / `test-spec` 27 / `test-address` 33 / `test-delivery` 103，README:184 声明）是否仍全部通过 | 文档一致性（审计 D） |

### C. 本次审计的验证边界（诚实声明）

- 内存 db 的 `find` **忽略 `skip`/`limit`**（`tests/test-cloud-api.js:18-31`），因此 B-P1-4 的分页截断、B-P1-2 的并发问题、索引缺失的性能影响在测试里**永远测不出来**；`get` 对不存在文档返回 `null` 而非抛错，与真实云库 `doc().get()` 抛错的行为也不同（`index.js:60-67` 的 fallback 分支从未被测过）。
- `tests/test-cloud-api.js` **未覆盖** 13 个 action：`getUser`、`updateUser`、`bindMobile`、`appConfig`、`cmsPage`、`importData`、`banners`、`fetchShops`、`shopSubdetail`、`cartRemoveItem`、`cartRemoveAll`、`orderDelete`、`wxpay`；核销测试只在**同一用户**下验证了"重复核销被拒"，没有任何"非管理员核销"的断言——这正是 B-P0-2 长期未被发现的原因。
- 本文用 `node -` 内联脚本复现探针，未新建/修改 `bread-main` 下任何文件。

---

## 四、建议修复顺序

**第 0 步（上线前必须，1-2 天，全部为 P0）**
1. 关闭/删除 `index.js:123-125` 的支付回调分支（或加 `ENABLE_PAY_CALLBACK=false` 开关），接入真实支付前不允许存在该入口。→ B-P0-1
2. `orderHx` 加服务端管理员鉴权 + 只允许已支付状态核销 + 条件更新幂等 + 记录核销人。→ B-P0-2
3. `orderCreate` 校验 `number`（正整数、上限、请求内去重合并）；商品与规格合法性校验；库存改原子条件更新。→ B-P0-3、B-P1-1、B-P1-2
4. 就"支付"做产品决策：接通企业主体+商户号，或明确线下收款语义并调整状态机。→ B-P0-4

**第 1 步（紧随其后，2-3 天，P1）**
5. `importData` 移出公开路由或加管理员白名单（同时 `checkOnly` 专用化）。→ B-P1-3
6. 修 `orderDetail` 支持 `hxNumber`（核销页可用），并补页面错误提示。→ B-P1-6
7. 补 `cloudfunctions/api/config.json`（超时/内存/权限），减少每单往返次数；把系统异常与业务失败分码，避免误触发降级。→ B-P1-5
8. `goodsList`/`orderList` 用数据库分页 + `count()`，取消 `skip>2000` 静默截断（改为显式报错）。→ B-P1-4

**第 2 步（上线后一周内，P2）**
9. 副本一致性改为"唯一源 + 构建期同步 + 全量键/深度比较断言"；修自指注释。→ B-P2-1、B-P3-2
10. 建索引（§2.4 表）；文档补"云函数 admin 权限 ≠ 权限边界"。→ B-P2-7
11. `mallName` 单一来源；`appConfig` 不再下发白名单；`cartSummary` 实时算价；`updateUser` 字段名统一。→ B-P2-2/3/4/5
12. `removeWhere` 改条件删除；运费待确认的金额语义；`orderDelete` 状态限制；`02-schema-goods.js` 示例改 `priceDelta` 并统一 `pics`。→ B-P2-6/8/9/10

**第 3 步（整理，P3）**
13. 清死代码、修文档数字与清单、统一注释、评估 `wx-server-sdk` 升级、异常信息不外泄、核销码高熵化。→ B-P3-1~8
14. 补齐测试盲区：为 13 个未覆盖 action 加断言；新增"非管理员核销必失败""负数/NaN 数量必被拒""并发扣库存"（可用事务或条件更新后加确定性断言）等回归用例。
