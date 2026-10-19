/**
 * 业务逻辑（与云开发环境无关，纯函数 + 注入的 db）
 * ---------------------------------------------------------------------------
 * 这样拆分的原因：本文件不 require wx-server-sdk，因此可以在本地用假数据
 * 直接跑测试（见 tests/test-cloud-api.js），不需要云环境、不需要 AppID。
 *
 * 约定：每个 handler 接收 (payload, ctx)，返回 { code, data } 或抛出错误。
 *       code 0 = 成功；非 0 为失败，msg 为提示文案。
 *       ctx.db 由入口注入（云开发用真实数据库，本地测试用假数据）。
 *
 * 数据库集合：
 *   category  分类
 *   goods     商品
 *   cart      购物车（按 _openid 区分用户）
 *   order     订单（按 _openid 区分用户）
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto')

// ===== 工具 =====
function ok(data, msg) {
  return { code: 0, data, msg: msg || 'success' }
}

function fail(msg, code) {
  return { code: code || 1, msg: msg || '操作失败' }
}

/**
 * 配送规则计算（服务端副本）
 * ⚠️ 这是 config/delivery.js 与 utils/delivery-range.js 的副本，
 *    微信云函数独立打包无法引用主包，因此复制。改动需同步，有测试守着一致性。
 */
const delivery = require('./delivery-calc')

/**
 * 读取并装入配送规则（阶段 8 新增）
 * ---------------------------------------------------------------------------
 * 规则来源：app_config 集合里 key = 'delivery_rule' 的 value（对象）。
 *   - 取到了 → 覆盖代码默认值（config/delivery.js）里 area / distance / freight / cake 四节
 *   - 取不到 / 不是对象 / 查询失败 → 用代码默认值
 *
 * ⚠️ 两条纪律（都是踩过的坑）：
 *   1) **无论成功失败都要装一次**：云函数容器会被复用，不装就可能沿用到
 *      "上一个请求装进来的规则"（跨请求污染），这比读不到配置危险得多；
 *   2) 前端也要用同一份规则：本函数返回的完整规则由 appConfig action 下发给前端，
 *      前端结算页据此显示运费 —— 否则会出现"屏显运费 ≠ 实付"。
 *
 * @param {object} ctx 云函数上下文（含 db）
 * @returns {object} 生效后的完整规则
 */
async function loadDeliveryRule(ctx) {
  let rule = null
  try {
    const doc = await ctx.db.findOne('app_config', { key: 'delivery_rule' })
    if (doc && doc.value && typeof doc.value === 'object') {
      rule = doc.value
    }
  } catch (e) {
    // 集合不存在 / 查询失败：回退代码默认值，不影响下单。
    // 2026-10-14 审查修复：**必须记日志** —— 否则云库规则读不到时，
    // 服务端会悄悄按代码默认阶梯收运费（店主已改价的钱对不上），而日志里毫无痕迹。
    console.error('[loadDeliveryRule] 读取云库配送规则失败，回退代码默认值：' +
      (e && e.message ? e.message : e))
  }
  return delivery.setDeliveryRule(rule)
}

/**
 * 取规格选项的加价
 * 价格规则（用户 2026-02-14 确认）：选项是「加价」，最终价 = 商品基础价 + 各选中项加价
 */
function getDelta(option) {
  const d = option && option.priceDelta
  return typeof d === 'number' ? d : 0
}

/**
 * 计算某组规格选项组合的最终单价
 * @param {object} goods 商品文档
 * @param {Array} sku [{ optionId, optionValueId }]
 * @param {'delivery'|'pickup'|undefined} channel 配送方式（阶段 9）：
 *        只有**显式**传 'pickup' 才应用「自取立减」goods.pickupDiscount；
 *        不传或传 'delivery' = 不区分渠道（列表价，与历史行为完全一致）。
 *        默认关闭是刻意的：老客户端不传 deliveryMode 时金额一分不变。
 */
function calcPrice(goods, sku, channel) {
  let price = typeof goods.minPrice === 'number' ? goods.minPrice : 0
  if (sku && sku.length && goods.properties) {
    goods.properties.forEach((group) => {
      const picked = sku.find((s) => String(s.optionId) === String(group.id))
      if (!picked) return
      const opt = (group.childsCurGoods || []).find(
        (c) => String(c.id) === String(picked.optionValueId)
      )
      price += getDelta(opt)
    })
  }
  // 阶段 9：自取立减（元/件）。未配置 / 配 0 → 完全不影响价格。
  // 减到 0 为止，绝不出现负价（数据校验在 build-goods.js 里也有兜底）。
  if (String(channel) === 'pickup') {
    const discount = Number(goods.pickupDiscount) || 0
    if (discount > 0) price = Math.max(0, price - discount)
  }
  return Math.round(price * 100) / 100
}

/**
 * 每件打包费（元）（阶段 9）。默认 0 = 不收，金额与历史行为一致。
 */
function packingFeeOf(goods) {
  const v = Number(goods && goods.packingFee)
  return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0
}

/**
 * 最少购买份数（阶段 9）。默认 1 = 不限制（只有 > 1 才算"有起购量"）。
 */
function minBuyNumberOf(goods) {
  const v = Number(goods && goods.minBuyNumber)
  return Number.isInteger(v) && v > 1 ? v : 1
}

/**
 * 解析期望时间（2026-10-14；2026-10-19 上线收尾 P0-2 时区修复）
 * 接受 'YYYY-MM-DD HH:mm'（结算页存进 storage 的绝对时间格式）与 ISO 串；
 * 其它（如"今天 22:00"这种可读文案）返回 null，由调用方决定是拒绝还是跳过。
 *
 * ★ 2026-10-19：'YYYY-MM-DD HH:mm' 必须按**北京时间**解释，不能按运行环境时区。
 *   云函数运行在 UTC，原来 `new Date(年, 月, 日, 时, 分)` 构造的是"UTC 的 22:00"，
 *   而顾客选的是"北京时间的 22:00"——服务端算出的时刻比真实时刻**晚 8 小时**，
 *   「蛋糕提前 3 小时」这条规则在服务端形同虚设（本地测试跑在 UTC+8，永远发现不了）。
 *   现在统一交给 delivery.parseBeijingTime（与 checkAdvanceTime 用同一套时区口径）。
 */
function parseExpectTime(s) {
  const str = String(s || '').trim()
  if (!str) return null
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(str)) {
    return delivery.parseBeijingTime(str)
  }
  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

/**
 * 从请求体解析配送方式（阶段 9 引入，2026-10-14 审查后与 orderCreate 对齐）。
 *
 * ⚠️ 缺省值必须与 orderCreate 一致，否则会出现"购物车按 A 渠道显示、下单按 B 渠道收费"：
 *   以前这里是 `只有显式传 'pickup' 才算自提`（缺省=不立减），
 *   而 orderCreate 是 `不是 'delivery' 就算自提`（缺省=应用自取立减）—— 两边正好相反，
 *   同一份缺 deliveryMode 的请求，购物车显示 108 元、下单实收 88 元。
 *   现在两边都按"App 的默认配送方式 = 自提"处理。
 */
function channelOf(payload) {
  return payload && payload.deliveryMode === 'delivery' ? 'delivery' : 'pickup'
}

/**
 * 解析 orderCreate 的配送方式（严格枚举 + 缺省推断）
 * - 'delivery' / 'pickup' → 原样返回
 * - 其它**非空**值 → null（调用方 fail）：避免 'DELIVERY' / 枚举改名之类被静默当成自提，
 *   那会把顾客填的收货地址**直接丢掉**、运费按 0 收
 * - 缺省（未传）→ 带收货地址按外送、否则按自提（"填了地址就是要送"的直觉，且不丢地址）
 */
function resolveDeliveryMode(payload) {
  const raw = payload ? payload.deliveryMode : undefined
  if (raw === 'delivery' || raw === 'pickup') return raw
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') return null
  return payload && payload.address ? 'delivery' : 'pickup'
}

// ===========================================================================
// P1-4 服务端入参加固（2026-10-19）
// ---------------------------------------------------------------------------
// 上线审查发现 orderCreate 仍有三处缺口：
//   ① 期望时间可以缺省（只 warn）→ 改过的客户端/直接调云函数可以绕过「蛋糕提前 3 小时」；
//   ② 联系电话完全不校验（回退读 extJson）→ 外送单可能没有可联系的电话；
//   ③ goodsJson 行数无上限、extJson / address 无大小与结构校验 →
//      恶意构造几千行可以放大数据库调用；超长 extJson/地址会污染订单与店主端响应体。
// 这里统一收口。原则：**校验失败的请求一律不落单**（错误发生在占券/生成单号之前）。
// ===========================================================================
const ORDER_GOODS_MAX_ROWS = 50
const ORDER_EXT_JSON_MAX_LEN = 4096
// 地址字段白名单 + 每项最大长度（前端 utils/address.js 的字段与此一致）
const ORDER_ADDRESS_FIELD_MAX = {
  name: 20,
  phone: 20,
  province: 20,
  city: 20,
  district: 20,
  detail: 120,
  tag: 10
}
const MOBILE_RE = /^1[3-9]\d{9}$/

/**
 * 校验并归一化收货地址：只保留白名单字段、逐项限长；坐标必须是合理数字。
 * 说明：坐标允许缺失/为 0（顾客手填地址或地图没取到时，配送规则降级为「运费待确认」），
 *      但一旦给了就必须是合法经纬度，避免 NaN/字符串进入运费计算。
 * @returns {{ok:true, address:object} | {ok:false, msg:string}}
 */
function validateOrderAddress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, msg: '收货地址格式不正确' }
  }
  const addr = {}
  for (const key of Object.keys(ORDER_ADDRESS_FIELD_MAX)) {
    const value = raw[key]
    if (value === undefined || value === null) {
      addr[key] = ''
      continue
    }
    if (typeof value !== 'string') return { ok: false, msg: '收货地址格式不正确' }
    const text = value.trim()
    if (text.length > ORDER_ADDRESS_FIELD_MAX[key]) return { ok: false, msg: '收货地址内容过长' }
    addr[key] = text
  }
  for (const key of ['latitude', 'longitude']) {
    const n = Number(raw[key] === undefined || raw[key] === null ? 0 : raw[key])
    if (!Number.isFinite(n) || Math.abs(n) > 180) {
      return { ok: false, msg: '收货地址坐标不正确' }
    }
    addr[key] = n
  }
  return { ok: true, address: addr }
}

/**
 * 订单是否需要店主先确认运费（P1-5，2026-10-19）
 * 场景：地址超出最后一档（beyond）或没有经纬度算不出距离（unknown_distance）时，
 *      下单的 freight 记 0、amountReal 不含运费；如果允许直接线上支付，就会漏收运费。
 * 规则：这类订单在店主「确认运费」（orderFreightConfirm 写入 freightConfirmed）之前，
 *      **不允许线上支付**；确认后金额已重算，可正常支付。
 */
function needsFreightConfirmOf(order) {
  if (!order || order.deliveryMode !== 'delivery') return false
  const q = order.deliveryQuote
  if (!q) return false
  const pending = q.reason === 'beyond' || q.reason === 'unknown_distance'
  return pending && q.freightConfirmed !== true
}

/**
 * 生成购物车项的唯一 key：同一商品 + 同一规格组合 视为同一项
 */
function makeCartKey(goodsId, sku) {
  const parts = (sku || [])
    .map((s) => String(s.optionId) + ':' + String(s.optionValueId))
    .sort()
  return String(goodsId) + (parts.length ? '|' + parts.join(',') : '')
}

/**
 * 由「谁 + 业务键」推出一个**稳定**的文档 _id（2026-10-14 新增，backlog：并发/幂等）
 * ---------------------------------------------------------------------------
 * 用途：并发下"先查没有、再插入"会插出**两行**（购物车两行同规格 / 同一令牌两张单）。
 *   把 _id 由业务键确定下来后，第二个请求的插入会撞主键 → 后端报错 →
 *   我们即可识别出"另一个请求刚建好这一行/这一单"，改为累加 / 直接返回那一单。
 * 取值：prefix + sha1(openid|seed) 前 24 位十六进制（96 bit，撞键概率可忽略）。
 *   前缀只为人眼排查方便：c = 购物车行，o = 订单。
 * ⚠️ 依赖云开发「add 时允许自定义 _id」（本项目 importData 导入种子数据同样依赖这一点）。
 *   若某个环境上不允许，调用方会**降级**为默认 _id（宁可退化为"无并发保护"，
 *   也不能让顾客加不了购 / 下不了单），见 cartAdd 与 orderCreate 的 catch 分支。
 */
function stableDocId(prefix, openid, seed) {
  const hash = crypto
    .createHash('sha1')
    .update(String(openid) + '|' + String(seed))
    .digest('hex')
  return prefix + hash.slice(0, 24)
}

// ===========================================================================
// 并发安全的「条件更新」（2026-10-19 上线收尾 P0-3 / P1-3 新增）
// ---------------------------------------------------------------------------
// 为什么必须有它：原实现（orderClose / cancelExpiredCore / orderFinish / 支付回调）
//   都是"先读出来判断状态，再整条 update 写回"——两步之间没有原子性。接入支付后
//   会出现最危险的一种并发：15 分钟超时取消与微信支付回调同时到达，
//   两个请求都读到 status=0，各自认为自己该改，最后可能是
//   "已支付却被写成已取消"（钱收了、单没了）。
//   `where({ _id, status: 期望值 }).update()` 由数据库端判断条件：
//   只有一行真正从期望值改成了新值时才返回 updated=1，天然幂等且不会互相覆盖。
//
// 适配器约定：
//   · 线上：cloudfunctions/api/index.js 的 dbAdapter.updateWhere（wx-server-sdk 的条件 update）；
//   · 本地测试 / 老适配器：没有该方法时降级为"先查后逐条改"。
//     ⚠️ 降级路径没有原子性，只用于单线程的测试环境；线上一定走真适配器。
//
// @returns {Promise<number>} 实际更新的行数（0 = 条件不匹配，什么都没改）
// ===========================================================================
async function updateWhere(ctx, collection, where, data) {
  if (ctx && ctx.db && typeof ctx.db.updateWhere === 'function') {
    const r = await ctx.db.updateWhere(collection, where, data)
    if (r && typeof r.updated === 'number') return r.updated
    if (r && r.stats && typeof r.stats.updated === 'number') return r.stats.updated
    return 0
  }
  const rows = await ctx.db.find(collection, where || {})
  let updated = 0
  for (const row of rows) {
    await ctx.db.update(collection, row._id, data)
    updated++
  }
  return updated
}

// ===========================================================================
// 订单号 / 取餐码生成（2026-10-10 重做）
// ---------------------------------------------------------------------------
// 旧实现（已废弃）：
//   orderNo = String(Date.now()) + 4 位随机数  →  例「17916238923573806」17 位数字
//   三个问题：
//     1) 太长又无语义：顾客报单号、店员对单都容易看错位；
//     2) 前 13 位就是下单的毫秒时刻，相当于把时间戳印在单号上；
//     3) hxNumber 直接等于 orderNumber —— 订单号是公开信息，核销码因此半公开；
//        且同毫秒有 1/9000 概率撞号（缺陷报告 D-09）。
//
// 新规则：
//   订单号 orderNumber = 'QH' + yyMMdd + '-' + 4 位随机数字   例：QH261010-8342
//   取餐码 pickupCode  = 订单号最后 4 位（自提叫号用）        例：8342
//   订单号写入前先查重（最多重试 6 次），撞号就换一个候选值。
//   因为订单号在「同一天内」不重复，同一天的取餐码自然也不会重复。
//
// 2026-10-10 二次改造：扫码核销整体下线（店主改为在订单里点「完成订单」），
//   因此不再生成核销码 hxNumber，也没有 hxNumber 的查重与存储。
//
// ⚠️ 并发下单时「先查再写」仍可能同时通过查重，最终防线是云库唯一索引：
//    在 order 集合给 orderNumber 建一条唯一索引
//    （见《实施步骤清单》阶段 5「云库集合权限与索引配置」）。
// ===========================================================================
const ORDER_NO_PREFIX = 'QH'
const ORDER_NO_TRIES = 6
const RETRY_STEP = 7919 // 质数：重试时叠加偏移，防止随机源异常时候选值原地打转

/** 数字左侧补零到指定长度（不用 padStart，避免云端 Node 版本差异） */
function pad(num, len) {
  let s = String(num)
  while (s.length < len) s = '0' + s
  return s
}

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive)
}

/** 订单号的日期段：yyMMdd（例：2026-10-10 → '261010'）
 *  2026-10-14 审查修复：云函数运行在 **UTC**，原来用本地时间取日期段，
 *  于是北京时间 00:00–08:00 下的单会被编号成**前一天**（店主对账时最容易懵）。
 *  这里显式按北京时间（UTC+8）取，不受运行时区影响。 */
const ORDER_TZ_OFFSET_MS = 8 * 60 * 60 * 1000
function orderNoDatePart(now) {
  const d = new Date(Number(now) + ORDER_TZ_OFFSET_MS)
  return pad(d.getUTCFullYear() % 100, 2) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2)
}

/**
 * 取餐码 = 订单号最后 4 位（自提叫号用：QH261010-8342 → '8342'）
 * 订单号已保证同一天内不重复，因此同一天的取餐码也不会重复。
 */
function pickupCodeOf(orderNo) {
  return String(orderNo || '').slice(-4)
}

/**
 * 生成一个在 order 集合里不重复的订单号。
 * @param {object} ctx 含 db
 * @param {string} field 字段名（当前只用于 'orderNumber'）
 * @param {number} tries 最多尝试次数
 * @param {(attempt:number)=>string} make 候选值工厂，attempt 从 0 开始
 * @returns {Promise<string>} 全部撞号时返回 ''（调用方必须 fail，绝不能发放重复值）
 */
async function generateUniqueOrderField(ctx, field, tries, make) {
  for (let i = 0; i < tries; i++) {
    const candidate = make(i)
    const dup = await ctx.db.findOne('order', { [field]: candidate })
    if (!dup) return candidate
  }
  return ''
}

// ===========================================================================
// 订单状态（阶段 4.1：状态机收敛，文案只有服务端这一份）
// ---------------------------------------------------------------------------
// 合法状态只有 4 个：-1 已取消 / 0 待支付 / 1 制作中 / 3 交易成功。
// 历史上出现过 2、4 两个从未被写入过的"幽灵状态"，前端已不再查询（见
// utils/order-status.js）。本表是状态文案的唯一出处：
//   - 写库时用它生成 statusStr；
//   - orderList / orderDetail 返回时也用它，覆盖库里可能过期的旧文案
//     （老订单、或人工在控制台改过 status 的记录也能显示正确）。
// ===========================================================================
const ORDER_STATUS = {
  CANCELLED: -1,
  UNPAID: 0,
  MAKING: 1,
  DONE: 3
}

const ORDER_STATUS_TEXT = {
  '-1': '已取消',
  '0': '待支付',
  '1': '制作中',
  '3': '交易成功'
}

/**
 * 状态数字 → 文案（未知状态不静默返回空串，方便排查脏数据）
 * @param {number} status
 * @returns {string}
 */
function statusTextOf(status) {
  const text = ORDER_STATUS_TEXT[String(status)]
  return text === undefined ? '未知状态(' + status + ')' : text
}

// ===========================================================================
// 安全：入参校验与鉴权（2026-10-09 阶段二新增）
// ===========================================================================
/**
 * 单行商品数量的上限。
 * 为什么需要：orderCreate 原先完全信任前端传来的 number，审计探针实测：
 *   number = -5   → 订单金额 -270 元（负数行直接抵扣总额）
 *   number = "abc"→ 金额 NaN
 *   同一请求两行各 99 → 拆行绕过单行上限，总额失控
 *
 * 2026-10-09：本店**没有库存概念**，这里只保留「数量必须是合理正整数」的校验，
 * 不再有任何库存上限（原来还有一条 stores 校验，已随库存整体删除）。
 */
const MAX_ITEM_NUMBER = 99

/**
 * 校验并归一化单行商品数量
 * @returns {{ok:true, number:number} | {ok:false, msg:string}}
 */
function normalizeOrderNumber(raw, goodsName) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, msg: (goodsName || '商品') + ' 的数量不正确' }
  }
  if (n <= 0) return { ok: false, msg: (goodsName || '商品') + ' 的数量必须大于 0' }
  if (n > MAX_ITEM_NUMBER) {
    return { ok: false, msg: (goodsName || '商品') + ' 单次最多购买 ' + MAX_ITEM_NUMBER + ' 件' }
  }
  return { ok: true, number: n }
}

/**
 * 校验规格选择，返回解析后的 sku 数组。
 * 与 cartAdd 的校验同一套语义（每个规格组必选、选项必须属于该商品），
 * 另外增加「不允许出现该商品没有的规格组」——防止用伪造的 optionId 影响计价。
 *
 * 为什么 orderCreate 必须自己校验：它能被直接调用（不经过购物车），
 * 而原实现只把 propertyChildIds 拆成 sku 就交给 calcPrice，缺组/非法值都不报错。
 * @returns {{ok:true, sku:Array} | {ok:false, msg:string}}
 */
function resolveOrderSku(goods, propertyChildIds) {
  const sku = []
  if (propertyChildIds !== undefined && propertyChildIds !== null && propertyChildIds !== '') {
    String(propertyChildIds)
      .split(',')
      .forEach((pair) => {
        const [optionId, optionValueId] = String(pair).split(':')
        if (optionId && optionValueId) sku.push({ optionId, optionValueId })
      })
  }

  const groups = goods.properties || []
  // 1) 该商品有规格组时，每组必须选中一个合法选项
  // 2026-10-14 审查修复（P1）：**每组只能选一项**。
  //   原来用 find 取第一个匹配项做校验，于是 `size:s4,size:s8` 也能下单：
  //   计价按第一个（4寸 54 元），而订单里的规格文字（店主做蛋糕看的字段）
  //   却是"4寸 / 8寸"；反过来 `size:s8,size:s4` 就按 8 寸收费、文字写"8寸 / 4寸"。
  //   这是"可伪造规格"的漏网：顾客付小规格的钱，店主按大规格做。
  for (const group of groups) {
    const pickedList = sku.filter((s) => String(s.optionId) === String(group.id))
    if (!pickedList.length) return { ok: false, msg: '请选择' + group.name }
    if (pickedList.length > 1) return { ok: false, msg: group.name + '只能选一项' }
    const picked = pickedList[0]
    const exists = (group.childsCurGoods || []).some(
      (c) => String(c.id) === String(picked.optionValueId)
    )
    if (!exists) return { ok: false, msg: group.name + '选择有误' }
  }
  // 2) 不允许出现商品没有的规格组（例如无规格商品却传了 fake:id）
  const validIds = groups.map((g) => String(g.id))
  for (const s of sku) {
    if (validIds.indexOf(String(s.optionId)) < 0) {
      return { ok: false, msg: '规格参数有误' }
    }
  }
  return { ok: true, sku }
}

/**
 * 当前调用者是否为商家管理员（完成订单等店主操作的鉴权依据）。
 * 白名单来源：cloudfunctions/api/shop-config.js 的 adminOpenids。
 *
 * ⚠️ 为什么不读前端传来的身份：前端只是"要不要显示按钮"的展示开关
 *    （依赖本地 storage，可篡改），**不能作为鉴权依据**。
 *    真正的鉴权必须在这里用云函数自动注入的 ctx.openid 判断。
 * 2026-10-17：前端不再接收 openid 白名单（见 appConfig），只接收这里算出的布尔标记。
 */
function isAdmin(ctx) {
  const SHOP = require('./shop-config')
  const list = (SHOP && SHOP.adminOpenids) || []
  return list.indexOf(ctx && ctx.openid) >= 0
}

function requireAdmin(ctx) {
  if (!isAdmin(ctx)) return fail('无操作权限（仅店主可执行）')
  return null
}

// ===========================================================================
// 分类
// ===========================================================================
async function categoryList(payload, ctx) {
  const docs = await ctx.db.find('category', { enabled: true }, { sort: 1, field: 'sort' })
  // 前端只读 name / id，这里补一个 id 字段（云数据库是 _id）
  const data = docs.map((d) => ({
    id: d._id,
    name: d.name,
    sort: d.sort
  }))
  return ok(data)
}

// ===========================================================================
// 商品
// ===========================================================================
/**
 * 商品列表
 * 前端用法：pages/orders/index.js → goodsCategory 之后按 categoryId 拉
 * categoryId 为空 或 '0' 时表示「全部商品」
 */
async function goodsList(payload, ctx) {
  const p = payload || {}
  // 2026-10-14 审查修复：分页参数做类型与上界校验。
  //   原来 `page/pageSize` 直接参与 slice：传 'abc' 时 slice(NaN, NaN) **不报错**而是返回全量，
  //   pageSize 缺省还是 1000。现在非法值一律回落到默认，且上限 100。
  const pageRaw = Number(p.page)
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
  const sizeRaw = Number(p.pageSize)
  const pageSize = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(Math.floor(sizeRaw), 100) : 100
  const categoryId = p.categoryId
  const where = { enabled: true }
  if (categoryId && categoryId !== '0' && categoryId !== 0) {
    where.categoryId = categoryId
  }
  let docs = await ctx.db.find('goods', where, { sort: 1, field: 'sort' })

  const total = docs.length
  const start = (page - 1) * pageSize
  docs = docs.slice(start, start + pageSize)

  const result = docs.map((g) => ({
    id: g._id,
    categoryId: g.categoryId,
    name: g.name,
    pic: g.pic,
    characteristic: g.characteristic || '',
    minPrice: g.minPrice,
    unit: g.unit || '个',
    // 2026-10-09：库存概念整体删除，不再返回 stores 字段
    // 改造：是否蛋糕，供前端计算配送规则（6寸以上免配送费、提前3小时）
    isCake: isCakeGoods(g),
    // 规格组随列表返回，前端据此解析蛋糕尺寸（磅数）
    properties: g.properties || []
  }))

  // 兼容前端 goodsv2 的读取方式：res.data.result
  return ok({ result, total })
}

/**
 * 判断商品是否蛋糕
 * 优先级：显式 isCake 字段 > 是否存在「磅数」这类尺寸规格（兜底）
 * 与 utils/delivery-range.js 的 isCakeGoods 保持同一语义
 */
function isCakeGoods(g) {
  if (!g) return false
  if (g.isCake === true) return true
  if (g.isCake === false) return false
  return (g.properties || []).some((p) => p && p.name === '磅数')
}

/**
 * 商品详情
 * 前端用法：pages/goods-details/index.js → res.data.basicInfo / .pics / .content / .properties
 */
async function goodsDetail(payload, ctx) {
  const id = payload && (payload.id || payload.goodsId)
  if (!id) return fail('缺少商品 id')
  const g = await ctx.db.get('goods', id)
  if (!g) return fail('商品不存在')
  return ok({
    basicInfo: {
      id: g._id,
      name: g.name,
      minPrice: g.minPrice,
      unit: g.unit || '个',
      // 2026-10-09：库存概念整体删除，不再返回 stores 字段
      purchaseNotes: g.purchaseNotes || '',
      // 改造：是否蛋糕，供前端配送规则（免配送费 / 提前3小时）判断
      isCake: isCakeGoods(g),
      // ===== 阶段 9：这三个字段只用于**展示提示**，不参与前端算钱 =====
      // （真正算钱的地方是 cartSummary 与 orderCreate，都在服务端，同一口径）
      //   pickupDiscount 自取立减（元/件）→ 详情页提示「自取立减 ¥10」
      //   packingFee     打包费（元/件）  → 提示「打包费 ¥2/件」
      //   minBuyNumber   最少购买份数     → 提示「X 份起购」
      pickupDiscount: Number(g.pickupDiscount) || 0,
      packingFee: packingFeeOf(g),
      minBuyNumber: minBuyNumberOf(g)
    },
    pics: g.pics || [],
    content: g.content || '',
    properties: g.properties || []
  })
}

// ===========================================================================
// 店主端（阶段 10）：商品自助管理 / 配送规则 / 运费补录
// ---------------------------------------------------------------------------
// 四条硬性纪律（阶段二安全整改的教训，每个店主写接口都要做到）：
//   1) **第一行就是 requireAdmin(ctx)** —— 白名单在服务端比对（ctx.openid 由云函数
//      自动注入，前端改不掉）。前端只决定"入口显不显示"，绝不能当鉴权；
//   2) **入参白名单化**：只接受下面显式列出的字段与取值域，其它字段一律忽略；
//   3) **金额只认服务端**：商品价与运费都由服务端重算，不接受前端算好的总额；
//   4) **不物理删除**：下架 = enabled:false（历史订单是快照，不受影响）。
//
// 为什么口径是"云库 = 唯一事实源"：店主在 App 里改过商品之后，
//   `cloud-data/goods-real.source.json` 不能再"重跑脚本 + 重导"覆盖她的修改（见
//   cloud-data/README.md 与 tools/README.md 顶部的警告）。
// ===========================================================================
const GOODS_NAME_MAX = 40
const GOODS_SHORT_TEXT_MAX = 60
const GOODS_CONTENT_MAX = 5000
const GOODS_PIC_URL_MAX = 500
const GOODS_PICS_MAX = 5
const GOODS_SPEC_GROUPS_MAX = 8
const GOODS_SPEC_OPTIONS_MAX = 20
const GOODS_PRICE_MAX = 99999
const GOODS_FEE_MAX = 999
const GOODS_SORT_MAX = 9999
const GOODS_MIN_BUY_MAX = 99
const GOODS_SPEC_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

// 配送规则（deliveryRuleSave）
const DELIVERY_KEYWORD_MIN_LEN = 3 // 短词（如「西山」「太平」）会把片区外的地址也放进来
const DELIVERY_KEYWORD_MAX_LEN = 20
const DELIVERY_KEYWORDS_MAX = 30
const DELIVERY_TIERS_MAX = 6
const DELIVERY_KM_MAX = 100
const DELIVERY_TIP_MAX = 60

/** 是否显式传了该字段（区分"没传 = 沿用旧值"与"传了空 = 清空"） */
function hasField(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

/** 金额归一化：有限数、两位小数、区间校验 */
function normalizeMoney(raw, opts) {
  const o = opts || {}
  if (raw === undefined || raw === null || raw === '') {
    return o.optional ? { ok: true, value: undefined } : { ok: false, msg: o.msg || '请填写金额' }
  }
  const n = Number(raw)
  if (!isFinite(n)) return { ok: false, msg: o.msg || '金额必须是数字' }
  if (n < 0) return { ok: false, msg: o.msg || '金额不能为负数' }
  if (o.minExclusive !== undefined && n <= o.minExclusive) {
    return { ok: false, msg: o.msg || ('金额必须大于 ' + o.minExclusive) }
  }
  if (o.max !== undefined && n > o.max) return { ok: false, msg: o.msg || ('金额不能超过 ' + o.max) }
  return { ok: true, value: Math.round(n * 100) / 100 }
}

/** 非负整数归一化 */
function normalizeInt(raw, opts) {
  const o = opts || {}
  if (raw === undefined || raw === null || raw === '') {
    return o.optional ? { ok: true, value: undefined } : { ok: false, msg: o.msg || '请填写整数' }
  }
  const n = Number(raw)
  if (!isFinite(n) || Math.floor(n) !== n) return { ok: false, msg: o.msg || '必须是整数' }
  if (o.min !== undefined && n < o.min) return { ok: false, msg: o.msg || ('不能小于 ' + o.min) }
  if (o.max !== undefined && n > o.max) return { ok: false, msg: o.msg || ('不能大于 ' + o.max) }
  return { ok: true, value: n }
}

/** 文本归一化（长度上限 + 是否必填） */
function normalizeText(raw, opts) {
  const o = opts || {}
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return o.optional ? { ok: true, value: '' } : { ok: false, msg: o.msg || '不能为空' }
  if (o.max && s.length > o.max) return { ok: false, msg: o.msg || ('最多 ' + o.max + ' 个字') }
  return { ok: true, value: s }
}

/**
 * 图片地址归一化。
 * ★ 关键防呆：`wxfile://` / `http://tmp` / `blob:` 是**本地临时路径**，
 *   说明「还没上传成功」——写进库里顾客看到的就是裂图（与「我的」页头像同一类坑）。
 */
function normalizePicUrl(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return { ok: false, msg: '请先上传商品图片' }
  if (s.length > GOODS_PIC_URL_MAX) return { ok: false, msg: '图片地址过长' }
  if (/^(wxfile:|http:\/\/tmp|https:\/\/tmp|blob:)/i.test(s)) {
    return { ok: false, msg: '图片还没上传成功，请重新上传后再保存' }
  }
  return { ok: true, value: s }
}

/** 图片数组归一化（兼容字符串与 { pic } 两种历史结构） */
function normalizePicList(raw) {
  if (!Array.isArray(raw)) return { ok: false, msg: '图片列表格式不正确' }
  const out = []
  for (const item of raw) {
    const url = typeof item === 'string' ? item : (item && item.pic) || ''
    const s = String(url || '').trim()
    if (!s) continue
    if (out.indexOf(s) < 0) out.push(s)
  }
  if (out.length > GOODS_PICS_MAX) return { ok: false, msg: '最多上传 ' + GOODS_PICS_MAX + ' 张图片' }
  for (const s of out) {
    const r = normalizePicUrl(s)
    if (!r.ok) return r
  }
  if (!out.length) return { ok: false, msg: '请先上传商品图片' }
  return { ok: true, value: out }
}

/**
 * 规格组归一化（阶段 9 起支持任意多组：磅数 / 口味 / 夹心一 / 奶油类型…）
 * 校验点（每条都是"写坏了顾客就买错"的地方）：
 *   · 组 id / 选项 id 必须唯一且是安全字符（前端拼 sku 与计价都靠它）；
 *   · 每组至少 1 个选项、组名必填；
 *   · priceDelta 必须是不小于 0 的有限数（负数会算出负价）。
 */
function normalizeSpecGroups(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return { ok: false, msg: '规格组格式不正确' }
  if (raw.length > GOODS_SPEC_GROUPS_MAX) {
    return { ok: false, msg: '规格组最多 ' + GOODS_SPEC_GROUPS_MAX + ' 组' }
  }
  const groups = []
  const groupIds = {}
  for (const g of raw) {
    if (!g || typeof g !== 'object') return { ok: false, msg: '规格组格式不正确' }
    const gid = String(g.id === undefined || g.id === null ? '' : g.id).trim()
    if (!gid) return { ok: false, msg: '规格组缺少 id' }
    if (!GOODS_SPEC_ID_RE.test(gid)) {
      return { ok: false, msg: '规格组 id「' + gid + '」只能用字母/数字/下划线/短横线（最多 32 位）' }
    }
    if (groupIds[gid]) return { ok: false, msg: '规格组 id 重复：' + gid }
    groupIds[gid] = true
    const gname = normalizeText(g.name, { max: 20, msg: '请填写规格组名称（最多 20 字）' })
    if (!gname.ok) return gname
    const opts = Array.isArray(g.childsCurGoods) ? g.childsCurGoods : []
    if (!opts.length) return { ok: false, msg: '规格组「' + gname.value + '」至少要有 1 个选项' }
    if (opts.length > GOODS_SPEC_OPTIONS_MAX) {
      return { ok: false, msg: '规格组「' + gname.value + '」最多 ' + GOODS_SPEC_OPTIONS_MAX + ' 个选项' }
    }
    const childs = []
    const optIds = {}
    for (const o of opts) {
      if (!o || typeof o !== 'object') return { ok: false, msg: '规格选项格式不正确' }
      const oid = String(o.id === undefined || o.id === null ? '' : o.id).trim()
      if (!oid) return { ok: false, msg: '规格组「' + gname.value + '」里有选项缺少 id' }
      if (!GOODS_SPEC_ID_RE.test(oid)) {
        return { ok: false, msg: '选项 id「' + oid + '」只能用字母/数字/下划线/短横线（最多 32 位）' }
      }
      if (optIds[oid]) return { ok: false, msg: '规格组「' + gname.value + '」的选项 id 重复：' + oid }
      optIds[oid] = true
      const oname = normalizeText(o.name, { max: 20, msg: '规格组「' + gname.value + '」里有选项缺少名称' })
      if (!oname.ok) return oname
      const delta = normalizeMoney(
        o.priceDelta === undefined || o.priceDelta === null || o.priceDelta === '' ? 0 : o.priceDelta,
        { max: GOODS_PRICE_MAX, msg: '选项「' + oname.value + '」的加价必须是不小于 0 的数字' }
      )
      if (!delta.ok) return delta
      childs.push({ id: oid, name: oname.value, priceDelta: delta.value })
    }
    groups.push({ id: gid, name: gname.value, childsCurGoods: childs })
  }
  return { ok: true, value: groups }
}

/** 店主视图：编辑页需要的字段一次给全（含已下架商品） */
function goodsAdminView(g) {
  const pics = Array.isArray(g.pics)
    ? g.pics.map((x) => (typeof x === 'string' ? x : (x && x.pic) || '')).filter(Boolean)
    : []
  const pic = String(g.pic || pics[0] || '')
  const properties = Array.isArray(g.properties) ? g.properties : []
  // 价格区间：编辑页与列表页都要显示，避免店主自己心算
  let minTotal = Number(g.minPrice) || 0
  let maxTotal = minTotal
  properties.forEach((grp) => {
    const deltas = ((grp && grp.childsCurGoods) || []).map((c) => Number(c && c.priceDelta) || 0)
    if (!deltas.length) return
    maxTotal += Math.max.apply(null, deltas)
  })
  return {
    id: g._id,
    categoryId: g.categoryId,
    name: g.name,
    pic: pic,
    pics: pics.length ? pics : (pic ? [pic] : []),
    characteristic: g.characteristic || '',
    content: g.content || '',
    minPrice: Number(g.minPrice) || 0,
    maxPrice: Math.round(maxTotal * 100) / 100,
    unit: g.unit || '个',
    purchaseNotes: g.purchaseNotes || '',
    sort: Number(g.sort) || 0,
    enabled: g.enabled !== false,
    // 阶段 9 的三个可选开关（默认全关 = 与历史金额一致）
    pickupDiscount: Number(g.pickupDiscount) || 0,
    packingFee: packingFeeOf(g),
    minBuyNumber: minBuyNumberOf(g),
    properties,
    specGroupCount: properties.length,
    updTime: g.updTime || 0
  }
}

/**
 * 店主视角商品列表（含**已下架**商品）。
 * 与顾客端 goodsList 的区别：不过滤 enabled —— 否则店主下架一个商品后
 * 就再也找不到它、无法重新上架（"删除了就消失"）。
 * 参数：{ categoryId?, keyword? }
 */
async function goodsAdminList(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const categoryId = p.categoryId === undefined || p.categoryId === null ? '' : String(p.categoryId)
  const keyword = String(p.keyword || '').trim().toLowerCase()

  const docs = await ctx.db.find('goods', {}, { sort: 1, field: 'sort' })
  const cats = await ctx.db.find('category', {}, { sort: 1, field: 'sort' })
  const catName = {}
  cats.forEach((c) => { catName[c._id] = c.name })

  const list = docs
    .filter((g) => !categoryId || categoryId === '0' || String(g.categoryId) === categoryId)
    .filter((g) => !keyword || String(g.name || '').toLowerCase().indexOf(keyword) >= 0)
    .map((g) => Object.assign(goodsAdminView(g), { categoryName: catName[g.categoryId] || '' }))

  return ok({
    result: list,
    total: list.length,
    onSale: list.filter((x) => x.enabled).length,
    offSale: list.filter((x) => !x.enabled).length,
    categories: cats.map((c) => ({
      id: c._id,
      name: c.name,
      sort: c.sort,
      // ⚠️ 这里**返回全部**分类（含 enabled:false 的），由前端加"（已停用）"后缀。
      //   为什么不像顾客端那样过滤：如果某个商品属于已停用的分类，过滤后编辑页
      //   的 picker 找不到它 → 回落到第一项 → 店主**只改个价**就会把商品悄悄挪到
      //   别的分类去（顾客端直接看不到）。宁可让她看见"这个商品挂在一个停用分类下"。
      enabled: c.enabled !== false
    }))
  })
}

/**
 * 新增 / 编辑商品（店主端唯一写入口）
 * ---------------------------------------------------------------------------
 * 参数：{ id?, name?, categoryId?, minPrice?, unit?, pic?, pics?, characteristic?,
 *        content?, purchaseNotes?, sort?, enabled?, pickupDiscount?, packingFee?,
 *        minBuyNumber?, properties? }
 *   · 不带 id = 新增；带 id = 编辑；
 *   · **没传的字段沿用库里的旧值** —— 这样"只切上下架"只需传 { id, enabled }，
 *     不必把整个表单回传（少一个"回传途中把别的字段写坏"的机会）；
 *   · 新增时必填：name / categoryId / pic / minPrice。
 */
async function goodsUpsert(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const id = String(p.id || p._id || '').trim()
  const now = Date.now()

  let existing = null
  if (id) {
    existing = await ctx.db.get('goods', id)
    if (!existing) return fail('商品不存在（可能已被删除），请返回列表刷新')
  }
  const base = existing || {}
  const creating = !existing

  // ---- 只切上下架：走快速通道，**不重新校验其它字段** ----
  // 为什么必须留这条通道：下面的字段校验是"整份文档级"的，而云库是可以人工编辑的
  //   （文档里就让人去控制台改数据）。一旦某条商品的历史数据不满足现在的规则
  //   （例如以前手写的选项 id 是中文、自取立减 ≥ 价格），它就会被**永久卡死**：
  //   店主连"下架"都做不到，报错还指向一个她没动过的字段。
  //   所以只传 { id, enabled } 时只校验 id 存在 + 布尔值（与 goodsDelete 同口径）。
  if (existing) {
    const changed = Object.keys(p).filter((k) => k !== 'id' && k !== '_id')
    if (changed.length === 1 && changed[0] === 'enabled') {
      if (typeof p.enabled !== 'boolean') return fail('上下架状态不正确')
      await ctx.db.update('goods', existing._id, {
        enabled: p.enabled,
        updBy: ctx.openid,
        updTime: now
      })
      return ok({
        id: existing._id,
        created: false,
        goods: goodsAdminView(Object.assign({}, existing, { enabled: p.enabled, updTime: now }))
      })
    }
  }

  // ---- 名称 ----
  const nameRes = normalizeText(hasField(p, 'name') ? p.name : base.name, {
    max: GOODS_NAME_MAX,
    msg: '请填写商品名称（最多 ' + GOODS_NAME_MAX + ' 个字）'
  })
  if (!nameRes.ok) return fail(nameRes.msg)
  const name = nameRes.value

  // ---- 分类（必须真实存在，防止伪造 categoryId 让商品在顾客端凭空消失）----
  const categoryId = String(
    (hasField(p, 'categoryId') ? p.categoryId : base.categoryId) || ''
  ).trim()
  if (!categoryId) return fail('请选择商品分类')
  const cat = await ctx.db.get('category', categoryId)
  if (!cat) return fail('分类不存在，请重新选择')

  // ---- 图片 ----
  let pics
  if (hasField(p, 'pics') || hasField(p, 'pic')) {
    const rawList = hasField(p, 'pics')
      ? p.pics
      : [hasField(p, 'pic') ? p.pic : base.pic]
    const listRes = normalizePicList(rawList)
    if (!listRes.ok) return fail(listRes.msg)
    pics = listRes.value
  } else {
    const listRes = normalizePicList(Array.isArray(base.pics) && base.pics.length ? base.pics : [base.pic])
    if (!listRes.ok) return fail(listRes.msg)
    pics = listRes.value
  }
  const pic = pics[0]

  // ---- 价格 / 单位 / 排序 / 上下架 ----
  const priceRes = normalizeMoney(hasField(p, 'minPrice') ? p.minPrice : base.minPrice, {
    minExclusive: 0,
    max: GOODS_PRICE_MAX,
    msg: '价格必须大于 0 且不超过 ' + GOODS_PRICE_MAX + ' 元'
  })
  if (!priceRes.ok) return fail(priceRes.msg)

  const unitRes = normalizeText(hasField(p, 'unit') ? p.unit : (base.unit || '个'), {
    max: 6,
    msg: '单位最多 6 个字'
  })
  if (!unitRes.ok) return fail(unitRes.msg)

  const sortRes = normalizeInt(hasField(p, 'sort') ? p.sort : (base.sort === undefined ? 10 : base.sort), {
    min: 0,
    max: GOODS_SORT_MAX,
    optional: true,
    msg: '排序必须是 0 ~ ' + GOODS_SORT_MAX + ' 的整数'
  })
  if (!sortRes.ok) return fail(sortRes.msg)

  const enabledRaw = hasField(p, 'enabled') ? p.enabled : (creating ? true : base.enabled !== false)
  if (typeof enabledRaw !== 'boolean') return fail('上下架状态不正确')
  const enabled = enabledRaw

  // ---- 阶段 9 三个开关（默认 0 / 0 / 1 = 与历史金额完全一致）----
  const discountRes = normalizeMoney(
    hasField(p, 'pickupDiscount') ? p.pickupDiscount : (base.pickupDiscount || 0),
    { max: GOODS_FEE_MAX, msg: '自取立减必须是 0 ~ ' + GOODS_FEE_MAX + ' 元' }
  )
  if (!discountRes.ok) return fail(discountRes.msg)
  // 立减不能 ≥ 最低价：否则自提时每件都减到 0（服务端会兜底，但那是配置错误）
  if (discountRes.value >= priceRes.value) {
    return fail('自取立减不能大于等于商品价格（当前价 ' + priceRes.value + ' 元）')
  }

  const packingRes = normalizeMoney(
    hasField(p, 'packingFee') ? p.packingFee : (base.packingFee || 0),
    { max: GOODS_FEE_MAX, msg: '打包费必须是 0 ~ ' + GOODS_FEE_MAX + ' 元' }
  )
  if (!packingRes.ok) return fail(packingRes.msg)

  const minBuyRes = normalizeInt(
    hasField(p, 'minBuyNumber') ? p.minBuyNumber : (base.minBuyNumber === undefined ? 1 : base.minBuyNumber),
    { min: 1, max: GOODS_MIN_BUY_MAX, msg: '最少购买份数必须是 1 ~ ' + GOODS_MIN_BUY_MAX + ' 的整数' }
  )
  if (!minBuyRes.ok) return fail(minBuyRes.msg)

  // ---- 规格组 ----
  const specRes = normalizeSpecGroups(hasField(p, 'properties') ? p.properties : base.properties)
  if (!specRes.ok) return fail(specRes.msg)
  const properties = specRes.value === undefined
    ? (Array.isArray(base.properties) ? base.properties : [])
    : specRes.value

  // ---- 文案 ----
  const charRes = normalizeText(hasField(p, 'characteristic') ? p.characteristic : base.characteristic, {
    max: GOODS_SHORT_TEXT_MAX,
    optional: true,
    msg: '简介最多 ' + GOODS_SHORT_TEXT_MAX + ' 个字'
  })
  if (!charRes.ok) return fail(charRes.msg)
  const noteRes = normalizeText(hasField(p, 'purchaseNotes') ? p.purchaseNotes : base.purchaseNotes, {
    max: GOODS_SHORT_TEXT_MAX,
    optional: true,
    msg: '购买须知最多 ' + GOODS_SHORT_TEXT_MAX + ' 个字'
  })
  if (!noteRes.ok) return fail(noteRes.msg)
  const contentRes = normalizeText(hasField(p, 'content') ? p.content : base.content, {
    max: GOODS_CONTENT_MAX,
    optional: true,
    msg: '详情最多 ' + GOODS_CONTENT_MAX + ' 个字'
  })
  if (!contentRes.ok) return fail(contentRes.msg)
  // 详情以富文本存储（parser 组件渲染）：店主在 textarea 里写纯文字时补上段落标签，
  // 否则顾客端详情页会显示成一整行没有换行的文字。
  // ⚠️ 判断"是不是富文本"要看**有没有真实标签**，不能只看有没有 `<` ——
  //   店主完全可能写「6寸<8寸 都可以」这种比较符号，那种情况也要给她分段。
  let content = contentRes.value
  if (content && !/<(p|br|div|span|img|strong|em|ul|ol|li|h[1-6])\b[^>]*>/i.test(content)) {
    content = content
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => '<p>' + line + '</p>')
      .join('')
  }

  const doc = {
    categoryId,
    name,
    pic,
    pics,
    characteristic: charRes.value,
    content,
    minPrice: priceRes.value,
    unit: unitRes.value,
    purchaseNotes: noteRes.value,
    sort: sortRes.value,
    enabled,
    pickupDiscount: discountRes.value,
    packingFee: packingRes.value,
    minBuyNumber: minBuyRes.value,
    properties,
    updBy: ctx.openid,
    updTime: now
  }

  let saved
  if (creating) {
    doc.createBy = ctx.openid
    doc.createTime = now
    const added = await ctx.db.add('goods', doc)
    saved = Object.assign({}, doc, { _id: (added && added._id) || doc._id })
  } else {
    await ctx.db.update('goods', existing._id, doc)
    saved = Object.assign({}, existing, doc)
    saved._id = existing._id
  }

  return ok({
    id: saved._id,
    created: creating,
    goods: goodsAdminView(saved)
  })
}

/**
 * 下架商品（软删）。
 * ⚠️ 刻意**不做物理删除**：历史订单里存的是商品快照，物理删掉商品不影响历史订单，
 *    但会让"店主手滑删了"变成不可恢复；下架则随时能重新上架，且顾客端立即不可见。
 */
async function goodsDelete(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const id = payload && (payload.id || payload._id)
  if (!id) return fail('缺少商品 id')
  const g = await ctx.db.get('goods', id)
  if (!g) return fail('商品不存在')
  if (g.enabled === false) return ok({ id: g._id, name: g.name, enabled: false, already: true })

  await ctx.db.update('goods', g._id, {
    enabled: false,
    updBy: ctx.openid,
    updTime: Date.now()
  })
  return ok({ id: g._id, name: g.name, enabled: false })
}

// ===========================================================================
// 店主端：配送规则保存（阶段 8 的规则真正"上云可改"）
// ---------------------------------------------------------------------------
// 为什么不能把前端传来的对象直接塞进云库：
//   normalizeRule() 对非法值的行为是"逐项回退到代码默认值"——这对**读取**是对的
//   （半截规则不会把系统带偏），但对**写入**是危险的：店主明明保存了"5 公里 10 元"，
//   输入框写错成 'abc' 时会被静默忽略，她以为改了、实际没改（钱按旧规则收）。
//   所以这里**先显式校验、再归一化**：不合法就报错拒绝，绝不静默吞掉。
// ===========================================================================
function normalizeKeywordList(raw, label) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return { ok: false, msg: label + '格式不正确' }
  if (raw.length > DELIVERY_KEYWORDS_MAX) {
    return { ok: false, msg: label + '最多 ' + DELIVERY_KEYWORDS_MAX + ' 个' }
  }
  const out = []
  for (const item of raw) {
    const s = String(item === undefined || item === null ? '' : item).trim()
    if (!s) continue
    if (s.length < DELIVERY_KEYWORD_MIN_LEN) {
      return {
        ok: false,
        msg: label + '里的「' + s + '」太短（至少 ' + DELIVERY_KEYWORD_MIN_LEN +
          ' 个字）：短词会把范围外的地址也放进来，建议写完整的小区/道路名'
      }
    }
    if (s.length > DELIVERY_KEYWORD_MAX_LEN) {
      return { ok: false, msg: label + '里的「' + s.slice(0, 8) + '…」太长（最多 ' + DELIVERY_KEYWORD_MAX_LEN + ' 个字）' }
    }
    if (out.indexOf(s) < 0) out.push(s)
  }
  return { ok: true, value: out }
}

function normalizeTiersForSave(raw) {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, msg: '至少要有一档配送费' }
  if (raw.length > DELIVERY_TIERS_MAX) {
    return { ok: false, msg: '最多 ' + DELIVERY_TIERS_MAX + ' 档配送费' }
  }
  const out = []
  const seen = {}
  let openEnded = 0
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] || {}
    const no = i + 1
    let maxKm = null
    if (!(t.maxKm === null || t.maxKm === undefined || t.maxKm === '')) {
      const v = Number(t.maxKm)
      if (!isFinite(v) || v <= 0) {
        return { ok: false, msg: '第 ' + no + ' 档的距离上限必须大于 0（最后一段留空表示"不限"）' }
      }
      if (v > DELIVERY_KM_MAX) {
        return { ok: false, msg: '第 ' + no + ' 档的距离上限过大（最多 ' + DELIVERY_KM_MAX + ' 公里）' }
      }
      maxKm = Math.round(v * 100) / 100
    }
    const feeRes = normalizeMoney(t.fee, {
      optional: true,
      max: GOODS_FEE_MAX,
      msg: '第 ' + no + ' 档的运费必须是 0 ~ ' + GOODS_FEE_MAX + ' 元（留空 = 运费待确认）'
    })
    if (!feeRes.ok) return feeRes
    const freeRes = normalizeMoney(t.freeAmount, {
      optional: true,
      max: GOODS_PRICE_MAX,
      msg: '第 ' + no + ' 档的免运费门槛必须是 0 ~ ' + GOODS_PRICE_MAX + ' 元（留空 = 不设门槛）'
    })
    if (!freeRes.ok) return freeRes
    const tipRes = normalizeText(t.tip, {
      max: DELIVERY_TIP_MAX,
      optional: true,
      msg: '第 ' + no + ' 档的提示文案最多 ' + DELIVERY_TIP_MAX + ' 个字'
    })
    if (!tipRes.ok) return tipRes

    if (maxKm === null) {
      openEnded++
    } else if (seen[maxKm]) {
      return { ok: false, msg: '有两档的距离上限都是 ' + maxKm + ' 公里，请改掉一档' }
    } else {
      seen[maxKm] = true
    }
    out.push({
      maxKm,
      fee: feeRes.value === undefined ? null : feeRes.value,
      freeAmount: freeRes.value === undefined ? null : freeRes.value,
      tip: tipRes.value
    })
  }
  if (openEnded > 1) {
    return { ok: false, msg: '只能有一档"以上全部"（距离上限留空的那一档）' }
  }
  // 按距离升序，且"以上全部"必须排在最后
  out.sort((a, b) => (a.maxKm === null ? Infinity : a.maxKm) - (b.maxKm === null ? Infinity : b.maxKm))
  for (let i = 1; i < out.length; i++) {
    if (out[i].maxKm !== null && out[i].maxKm <= out[i - 1].maxKm) {
      return { ok: false, msg: '档位要按距离从小到大排列，第 ' + (i + 1) + ' 档的距离上限比上一档还小' }
    }
  }
  return { ok: true, value: out }
}

async function deliveryRuleSave(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const now = Date.now()
  const rule = {}

  // ---- 配送区域（白名单 / 黑名单 / 距离上限）----
  const areaIn = p.area && typeof p.area === 'object' ? p.area : null
  if (areaIn) {
    const area = {}
    const kw = normalizeKeywordList(areaIn.keywords, '配送范围关键词')
    if (!kw.ok) return fail(kw.msg)
    if (kw.value !== undefined) {
      // ★ 清空白名单 = 所有顾客都无法外送（checkArea 里 `keywords.some(...)` 永远不命中）。
      //   这是个"一点就整店不能外送"的开关，不能让它悄悄生效：明确拒绝并给出替代做法。
      if (!kw.value.length) {
        return fail('配送范围关键词不能为空（清空后所有顾客都无法外送）。' +
          '若只想做自提，请把「外送距离上限」设成一个很小的数字（例如 0.1 公里）')
      }
      area.keywords = kw.value
    }
    const ex = normalizeKeywordList(areaIn.excludeKeywords, '不送区域')
    if (!ex.ok) return fail(ex.msg)
    if (ex.value !== undefined) area.excludeKeywords = ex.value
    if (hasField(areaIn, 'forbidBeyondKm')) {
      if (areaIn.forbidBeyondKm === null || areaIn.forbidBeyondKm === '') {
        area.forbidBeyondKm = null // 显式关闭「超过 X 公里不送」
      } else {
        const v = Number(areaIn.forbidBeyondKm)
        if (!isFinite(v) || v <= 0 || v > DELIVERY_KM_MAX) {
          return fail('外送距离上限必须是 0 ~ ' + DELIVERY_KM_MAX + ' 公里之间的数字（留空 = 不限制）')
        }
        area.forbidBeyondKm = Math.round(v * 100) / 100
      }
    }
    for (const key of ['outOfAreaTip', 'excludedTip', 'beyondLimitTip', 'farAwayTip']) {
      if (!hasField(areaIn, key)) continue
      const r = normalizeText(areaIn[key], { max: DELIVERY_TIP_MAX, optional: true, msg: '提示文案最多 ' + DELIVERY_TIP_MAX + ' 个字' })
      if (!r.ok) return fail(r.msg)
      if (r.value) area[key] = r.value
    }
    rule.area = area
  }

  // ---- 距离阶梯运费（计费依据）----
  if (hasField(p, 'freight')) {
    const fIn = p.freight && typeof p.freight === 'object' ? p.freight : {}
    const tiersRes = normalizeTiersForSave(fIn.tiers)
    if (!tiersRes.ok) return fail(tiersRes.msg)
    const tiers = tiersRes.value
    const first = tiers[0]
    const last = tiers[tiers.length - 1]
    // 尾档语义：`beyondEnabled` 表示"超出所有上限之后还接不接单"。
    //   fee = null 是"运费待确认"（仍接单，店主电话确认后补录），**不是拒单** ——
    //   所以这里默认 true；要"超过 X 公里不接单"请用 area.forbidBeyondKm（页面上有这一项）。
    //   允许显式传布尔值覆盖（给控制台/将来的 UI 留一个开关）。
    const beyondEnabled = typeof fIn.beyondEnabled === 'boolean' ? fIn.beyondEnabled : true
    rule.freight = {
      tiers,
      // 镜像键（旧代码/旧配置读它们）：与 tiers 首档/尾档保持一致，避免两处口径漂移。
      // ⚠️ 注意：镜像值写 null 时 normalizeRule 会视为"未提供"→ 保留代码默认值
      //    （例如首档不设免运费门槛时 withinFreeAmount 仍是默认 35）。
      //    这不影响计费：**计费只读 tiers**（pickTier），镜像只在 tiers 缺失/非法时兜底。
      withinFreeAmount: first.freeAmount,
      withinFee: first.fee === null ? 0 : first.fee,
      beyondEnabled,
      beyondFee: last.maxKm === null ? last.fee : null,
      beyondTip: (last.maxKm === null && last.tip) || undefined
    }
    // distance.freeWithinKm 是 tiers 首档的兼容镜像（两者必须相等）
    rule.distance = { freeWithinKm: first.maxKm === null ? undefined : first.maxKm }
    for (const key of ['beyondTip', 'unknownTip']) {
      if (!hasField(fIn, key)) continue
      const r = normalizeText(fIn[key], { max: DELIVERY_TIP_MAX, optional: true })
      if (!r.ok) return fail(r.msg)
      if (r.value) rule.freight[key] = r.value
    }
  }

  // ---- 蛋糕免配送费规则 ----
  if (hasField(p, 'cake')) {
    const cIn = p.cake && typeof p.cake === 'object' ? p.cake : {}
    const cake = {}
    if (hasField(cIn, 'enabled')) {
      if (typeof cIn.enabled !== 'boolean') return fail('蛋糕免配送费开关状态不正确')
      cake.enabled = cIn.enabled
    }
    if (hasField(cIn, 'freeWithinKm')) {
      const r = normalizeMoney(cIn.freeWithinKm, { max: DELIVERY_KM_MAX, msg: '蛋糕免配送费距离必须是 0 ~ ' + DELIVERY_KM_MAX + ' 公里' })
      if (!r.ok) return fail(r.msg)
      cake.freeWithinKm = r.value
    }
    if (hasField(cIn, 'minSizeInch')) {
      const r = normalizeMoney(cIn.minSizeInch, { minExclusive: 0, max: 30, msg: '最小尺寸必须是大于 0 的寸数（最多 30）' })
      if (!r.ok) return fail(r.msg)
      cake.minSizeInch = r.value
    }
    if (hasField(cIn, 'overrideThreshold')) {
      if (typeof cIn.overrideThreshold !== 'boolean') return fail('「无条件免运费」开关状态不正确')
      cake.overrideThreshold = cIn.overrideThreshold
    }
    if (hasField(cIn, 'freeReasonText')) {
      const r = normalizeText(cIn.freeReasonText, { max: DELIVERY_TIP_MAX, optional: true })
      if (!r.ok) return fail(r.msg)
      if (r.value) cake.freeReasonText = r.value
    }
    rule.cake = cake
  }

  if (!Object.keys(rule).length) return fail('没有需要保存的配送设置')

  const normalized = delivery.normalizeRule(rule)
  const doc = await ctx.db.findOne('app_config', { key: 'delivery_rule' })
  if (doc && doc._id) {
    await ctx.db.update('app_config', doc._id, {
      key: 'delivery_rule',
      value: normalized,
      updBy: ctx.openid,
      updTime: now
    })
  } else {
    await ctx.db.add('app_config', {
      key: 'delivery_rule',
      value: normalized,
      // 新增也写 updBy/updTime：审计字段名统一，读的时候不用分两种情况
      createBy: ctx.openid,
      createTime: now,
      updBy: ctx.openid,
      updTime: now
    })
  }
  // 让本容器立即用上新规则（否则"保存后马上下一单"仍按旧规则算运费）
  delivery.setDeliveryRule(normalized)
  return ok({ rule: normalized })
}

// ===========================================================================
// 店主端：运费补录（「运费待确认」订单的补款入口）
// ---------------------------------------------------------------------------
// 背景（用户端审查报告 §三 backlog，属阶段 10 范围）：
//   距离超出最后一档 / 地址没有经纬度时，下单的运费是 `null`（"运费待确认"），
//   店主电话跟顾客谈好之后**没有任何入口把这个金额写进订单** ——
//   顾客端看到的实付金额永远不含这笔运费。
//
// 约束（每条都为了"钱不能被悄悄改"）：
//   1) 只有 requireAdmin 能调；
//   2) 只对**下单时运费待确认**（reason = beyond / unknown_distance）或已补录过的外送单开放 ——
//      已经算清的档位运费不允许在这里改（那是另一件事，不能藏在"补录"里）；
//   3) 金额由服务端重算 amountReal = goodsAmount + packingFee + freight
//      （只接受一个 freight 数字，不接受前端传来的总额）；
//   4) 写审计字段（freightConfirmBy / freightConfirmTime）。
// ===========================================================================
const FREIGHT_CONFIRM_MAX = GOODS_FEE_MAX

async function orderFreightConfirm(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const id = p.id
  if (!id) return fail('缺少订单 id')
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if ((o.deliveryMode || 'pickup') !== 'delivery') return fail('自提订单没有配送费可补录')

  const quote = o.deliveryQuote || {}
  const confirmable = quote.reason === 'beyond' ||
    quote.reason === 'unknown_distance' ||
    quote.freightConfirmed === true
  if (!confirmable) {
    return fail('该订单下单时运费已确定（' + (quote.freightText || '—') + '），无需补录')
  }

  const status = Number(o.status)
  if (status !== ORDER_STATUS.UNPAID && status !== ORDER_STATUS.MAKING) {
    return fail('该订单当前状态（' + statusTextOf(o.status) + '）不能改配送费')
  }

  const feeRes = normalizeMoney(p.freight, {
    max: FREIGHT_CONFIRM_MAX,
    msg: '配送费必须是 0 ~ ' + FREIGHT_CONFIRM_MAX + ' 元之间的数字'
  })
  if (!feeRes.ok) return fail(feeRes.msg)

  const freight = feeRes.value
  const goodsAmount = Number(o.goodsAmount) || 0
  const packingFee = Number(o.packingFee) || 0
  // 阶段 11：补录运费时**不能把优惠券抵扣丢掉**，否则店主一确认运费，
  // 顾客的实付金额就悄悄涨回去了（与阶段 5.1「屏显 ≠ 实付」同一类缺陷）。
  const couponAmount = Number(o.couponAmount) || 0
  const amountReal = Math.round(
    (Math.max(0, goodsAmount - couponAmount) + packingFee + freight) * 100
  ) / 100
  const now = Date.now()

  await ctx.db.update('order', o._id, {
    freight,
    amountReal,
    deliveryQuote: Object.assign({}, quote, {
      freightText: freight > 0 ? '¥' + freight : '免配送费',
      freightConfirmed: true,
      freightConfirmedTime: now
    }),
    freightConfirmBy: ctx.openid,
    freightConfirmTime: now
  })

  return ok({
    id: o._id,
    orderNumber: o.orderNumber,
    freight,
    goodsAmount,
    packingFee,
    amountReal
  })
}

// ===========================================================================
// 优惠券（阶段 11）
// ---------------------------------------------------------------------------
// 对应需求：R-01「可以发布优惠券活动吗？比如新客立减多少，满多少减多少」
//          +「想要我自己可以设置这个，有权限」→ 店主自己建券，顾客结算时用。
//
// 三条纪律（与阶段 5.1 的金额口径同一套）：
//   1) **券能不能用、能减多少，只由服务端算**：`couponUsableForCart` 只给结算页
//      做预览，`orderCreate` 落单前用同一批函数**重新校验并重算**最终金额 ——
//      前端传的 `couponId` 只是"想用哪张券"，改前端改不了优惠金额；
//   2) 优惠只作用于**商品金额**（不含打包费、不含运费），门槛也按商品金额判断：
//      `amountReal = max(0, 商品金额 - 优惠) + 打包费 + 运费`；
//   3) 一单最多用 **1 张**券（不叠加）。
//      下单时**原子占用**（防止同一张券并发下多单），订单取消/超时未支付时**退回**
//      （2026-10-19 上线收尾 P0-3 从"不退券"改为"退券"，见 cancelPendingOrder）；
//      支付成功后占用才最终生效（不是"支付成功才占用"，而是"取消才归还"）。
//
// 数据模型（集合 `coupon`，权限「仅创建者可读写」——顾客只经云函数访问）：
//   { _id, name, type: 'newCustomer' | 'threshold', threshold, amount,
//     startTime, endTime, totalLimit, perUserLimit, enabled, sort,
//     usedCount,            // 服务端维护：已被使用的次数（超发保护的条件）
//     createBy, createTime, updBy, updTime }
//   集合 `coupon_user`（每人已用次数，超发/限用的原子计数器）：
//   { _id, _openid, couponId, usedCount, createTime }
//
// 并发（与 backlog 的原子加购/幂等同一纪律）：
//   `usedCount` / `coupon_user.usedCount` 都用 `db.incField` 的**数据库端条件自增**
//   （自增后必须 ≤ 上限），条件不满足时一条都不改 → 并发下不会超发、不会突破每人限用。
//   两个计数器先抢占，再落单；落单失败则回滚（不白吃一次使用次数）。
// ===========================================================================
const COUPON_TYPE_NEW = 'newCustomer'
const COUPON_TYPE_THRESHOLD = 'threshold'
const COUPON_TYPE_TEXTS = {
  newCustomer: '新客立减',
  threshold: '满减'
}
const COUPON_NAME_MAX = 30
const COUPON_AMOUNT_MAX = 10000
const COUPON_THRESHOLD_MAX = 100000
const COUPON_LIMIT_MAX = 100000
const COUPON_PER_USER_MAX = 100
const COUPON_SORT_MAX = 9999
// 券的有效期只接受合理区间（防止把毫秒当秒之类的手滑写成 1970 / 5 万年后）
const COUPON_TIME_MIN = Date.UTC(2020, 0, 1)
const COUPON_TIME_MAX = Date.UTC(2100, 0, 1)
const COUPON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** 金额文案（去掉多余的 0：10.00 → '10'，10.50 → '10.5'） */
function moneyText(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100)
}

/** 券时间文案（按北京时间，不依赖运行时区；云函数运行在 UTC） */
function couponTimeText(ms) {
  const n = Number(ms)
  if (!isFinite(n) || n <= 0) return '—'
  const d = new Date(n + ORDER_TZ_OFFSET_MS)
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) +
    ' ' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2)
}

/**
 * 每人使用上限的**生效值**。
 * 新客券强制 1：新客券的语义就是"只给新顾客一次"，店主填 5 张反而会把
 * "新客立减"变成"前 5 单都减"（与她对活动的理解不一致）。
 */
function effectivePerUserLimitOf(c) {
  if (!c) return 0
  if (String(c.type) === COUPON_TYPE_NEW) return 1
  return Number(c.perUserLimit) || 0
}

/** 券当前状态（管理员列表与顾客端共用；now 由调用方传入便于测试） */
function couponStatusOf(c, now) {
  const t = Number(now) || Date.now()
  if (!c || c.enabled === false) return { key: 'disabled', text: '已停用' }
  if (t < Number(c.startTime)) return { key: 'pending', text: '未开始' }
  if (t > Number(c.endTime)) return { key: 'expired', text: '已结束' }
  if (Number(c.totalLimit) > 0 && Number(c.usedCount) >= Number(c.totalLimit)) {
    return { key: 'soldout', text: '已抢完' }
  }
  return { key: 'active', text: '进行中' }
}

/** 券面一句话说明（顾客与店主都看这一句，不要两处各写一份） */
function couponRuleText(c) {
  if (!c) return ''
  if (String(c.type) === COUPON_TYPE_NEW) return '新客立减 ¥' + moneyText(c.amount)
  return '满 ¥' + moneyText(c.threshold) + ' 减 ¥' + moneyText(c.amount)
}

/** 顾客视图：只给券面信息，不暴露 _openid 之类 */
function couponViewOf(c, now) {
  const status = couponStatusOf(c, now)
  return {
    id: c._id,
    name: c.name,
    type: c.type,
    typeText: COUPON_TYPE_TEXTS[String(c.type)] || '优惠券',
    threshold: Number(c.threshold) || 0,
    amount: Number(c.amount) || 0,
    ruleText: couponRuleText(c),
    startTime: Number(c.startTime) || 0,
    endTime: Number(c.endTime) || 0,
    validText: '有效期 ' + couponTimeText(c.startTime) + ' 至 ' + couponTimeText(c.endTime),
    statusKey: status.key,
    statusText: status.text
  }
}

/** 店主视图：券面 + 使用量（对账/停用要用） */
function couponAdminView(c, now) {
  const view = couponViewOf(c, now)
  const totalLimit = Number(c.totalLimit) || 0
  const usedCount = Number(c.usedCount) || 0
  return Object.assign(view, {
    totalLimit: totalLimit,
    perUserLimit: Number(c.perUserLimit) || 0,
    // 新客券的每人上限被服务端强制为 1，页面上照实显示，别让店主以为填的 5 生效了
    effectivePerUserLimit: effectivePerUserLimitOf(c),
    usedCount: usedCount,
    remainCount: totalLimit > 0 ? Math.max(0, totalLimit - usedCount) : null,
    usageText: totalLimit > 0
      ? usedCount + ' / ' + totalLimit + ' 已用'
      : usedCount + ' 次已用（不限量）',
    enabled: c.enabled !== false,
    sort: Number(c.sort) || 0,
    createTime: Number(c.createTime) || 0,
    updateTime: Number(c.updTime) || 0
  })
}

/** couponId 入参解析（空 = 不用券；非法值明确拒绝，别静默当没用券） */
function parseCouponId(raw) {
  if (raw === undefined || raw === null) return { ok: true, id: '' }
  const s = String(raw).trim()
  if (!s) return { ok: true, id: '' }
  if (!COUPON_ID_RE.test(s)) return { ok: false, id: '', msg: '优惠券参数不正确，请重新选择' }
  return { ok: true, id: s }
}

/**
 * 券时间归一化：接受毫秒时间戳（数字或 13 位字符串）、10 位秒字符串，
 * 以及 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DD'（**按北京时间**解析，不依赖云函数运行时区）。
 * @returns {number|null} 毫秒时间戳；解析不出来返回 null（调用方必须拒绝，不能兜底成"现在"）
 */
function normalizeCouponTime(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    return isFinite(raw) ? Math.round(raw) : null
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d{10}$/.test(s)) return Number(s) * 1000
  if (/^\d{13}$/.test(s)) return Number(s)
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  if (!m) return null
  const hour = m[4] === undefined ? 0 : Number(m[4])
  const minute = m[5] === undefined ? 0 : Number(m[5])
  // 云函数容器跑在 UTC：显式按 UTC+8 换算，否则北京时间 0~8 点的券会被算成前一天
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute) - ORDER_TZ_OFFSET_MS
}

/**
 * 该顾客是否有"已生效过"的历史订单（status >= 1：制作中 / 交易成功）。
 * 新客券的判定口径：待支付(0) 与已取消(-1) **不算**老客 ——
 * 否则顾客下了一单没付款就永远失去新客资格。
 */
async function hasPaidOrderHistory(ctx, openid) {
  try {
    const orders = await ctx.db.find('order', { _openid: openid }, {})
    return orders.some((o) => Number(o.status) >= ORDER_STATUS.MAKING)
  } catch (e) {
    // 查不到历史订单时按"老客"处理：宁可少发一张券，也不能把新客券发给老客
    console.error('[coupon] 查询历史订单失败，按老客处理：' + (e && e.message ? e.message : e))
    return true
  }
}

/** 该顾客在这张券上已经用掉的次数（coupon_user 集合） */
async function userCouponUsed(ctx, openid, couponId) {
  try {
    const doc = await ctx.db.findOne('coupon_user', { _openid: openid, couponId: String(couponId) })
    return doc ? Number(doc.usedCount) || 0 : 0
  } catch (e) {
    // 集合不存在（老环境还没建 coupon_user）时按 0 处理：
    // 下单路径上的原子累加仍会兜底（见 claimCouponUsage 的建行逻辑）
    return 0
  }
}

/** coupon_user 行的稳定 _id（并发下"先查没有再插入"会插出两行，靠主键挡住） */
function couponUserDocId(openid, couponId) {
  return stableDocId('cu', openid, 'coupon|' + String(couponId))
}

/**
 * 确保 (openid, couponId) 的用券记录存在。
 * 并发插入撞主键 / 环境不允许自定义 _id / 集合还没建，都要能给出可处理的结论
 * （返回 null 由调用方拒绝本次用券，而不是抛 500 让顾客看到"服务异常"）。
 */
async function ensureCouponUserRow(ctx, openid, couponId) {
  const cid = String(couponId)
  try {
    let row = await ctx.db.findOne('coupon_user', { _openid: openid, couponId: cid })
    if (row) return row
    const now = Date.now()
    try {
      await ctx.db.add('coupon_user', {
        _id: couponUserDocId(openid, cid),
        _openid: openid,
        couponId: cid,
        usedCount: 0,
        createTime: now
      })
      return { _id: couponUserDocId(openid, cid), _openid: openid, couponId: cid, usedCount: 0 }
    } catch (e) {
      // ① 并发插入撞主键 → 另一个请求刚建好这一行，重读一次
      row = await ctx.db.findOne('coupon_user', { _openid: openid, couponId: cid })
      if (row) return row
      // ② 该环境不允许自定义 _id → 用默认 _id 再插一次
      try {
        const added = await ctx.db.add('coupon_user', {
          _openid: openid, couponId: cid, usedCount: 0, createTime: now
        })
        return added
      } catch (e2) {
        console.error('[coupon] 创建用券记录失败（检查 coupon_user 集合是否已建）：' +
          (e2 && e2.message ? e2.message : e2))
        return null
      }
    }
  } catch (e) {
    console.error('[coupon] 读取用券记录失败（检查 coupon_user 集合是否已建）：' +
      (e && e.message ? e.message : e))
    return null
  }
}

/** 顾客视角的"为什么不能用"（管理员列表仍用 couponStatusOf 的短文案） */
const COUPON_UNAVAILABLE_REASONS = {
  disabled: '优惠券已停用',
  pending: '优惠券还没到开始时间',
  expired: '优惠券已过期',
  soldout: '优惠券已被抢完'
}

/** 顾客级资格（不含"购物车金额是否够门槛"——那是 couponUsableForCart / orderCreate 的事） */
async function couponUserEligibility(ctx, coupon, openid, now) {
  const status = couponStatusOf(coupon, now)
  if (status.key !== 'active') {
    return {
      ok: false,
      reason: COUPON_UNAVAILABLE_REASONS[status.key] || status.text,
      used: 0
    }
  }
  const type = String(coupon.type)
  if (type !== COUPON_TYPE_NEW && type !== COUPON_TYPE_THRESHOLD) {
    return { ok: false, reason: '券类型不正确', used: 0 }
  }
  const used = await userCouponUsed(ctx, openid, coupon._id)
  const perLimit = effectivePerUserLimitOf(coupon)
  if (perLimit > 0 && used >= perLimit) {
    return {
      ok: false,
      reason: perLimit === 1 ? '您已经用过这张券了' : '每人限用 ' + perLimit + ' 次（已用完）',
      used
    }
  }
  if (type === COUPON_TYPE_NEW && used === 0 && await hasPaidOrderHistory(ctx, openid)) {
    return { ok: false, reason: '仅限新顾客（您已有历史订单）', used }
  }
  return { ok: true, reason: '', used }
}

/** 顾客端可见的券：已启用 + 在有效期内 + 总量没领完（按店主排序） */
async function loadActiveCoupons(ctx, now) {
  try {
    const docs = await ctx.db.find('coupon', { enabled: true }, { sort: 1, field: 'sort' })
    return docs.filter((c) => c && couponStatusOf(c, now).key === 'active')
  } catch (e) {
    // 新环境还没建 coupon 集合时（部署清单里要求建），顾客端按"没有券"处理：
    // 不能让结算页/下单因为"优惠券功能没初始化"而整体失败。
    console.error('[coupon] 读取券失败（检查 coupon 集合是否已建）：' + (e && e.message ? e.message : e))
    return []
  }
}

/**
 * 只读接口：顾客端可见的券 + 该顾客自己的资格。
 * 用途：结算页显示"有 N 张券"；H5/后续"我的券"页面也用它。
 */
async function couponList(payload, ctx) {
  const now = Date.now()
  const docs = await loadActiveCoupons(ctx, now)
  const coupons = []
  for (const c of docs) {
    const elig = await couponUserEligibility(ctx, c, ctx.openid, now)
    coupons.push(Object.assign(couponViewOf(c, now), {
      eligible: elig.ok,
      reason: elig.reason
    }))
  }
  return ok({ coupons, serverNow: now })
}

/**
 * 只读接口：结算页的"可用券 + 预估优惠"。
 * 金额口径与 orderCreate **完全一致**（同一个 couponUserEligibility / 同样的门槛与封顶），
 * 前端只展示这里给的 discount，不自己算。
 */
async function couponUsableForCart(payload, ctx) {
  const now = Date.now()
  const summary = await cartSummary(ctx, ctx.openid, channelOf(payload))
  const cart = summary.data || {}
  const goodsAmount = Math.round((Number(cart.price) || 0) * 100) / 100
  const docs = await loadActiveCoupons(ctx, now)

  const coupons = []
  for (const c of docs) {
    const elig = await couponUserEligibility(ctx, c, ctx.openid, now)
    let usable = elig.ok
    let reason = elig.reason
    let discount = 0
    if (usable && String(c.type) === COUPON_TYPE_THRESHOLD) {
      const threshold = Number(c.threshold) || 0
      if (goodsAmount < threshold) {
        usable = false
        reason = '再买 ¥' + moneyText(Math.round((threshold - goodsAmount) * 100) / 100) + ' 可用'
      }
    }
    if (usable) {
      // 优惠不超过商品金额：否则会出现"优惠比商品还多"，实付金额算成负数
      discount = Math.round(Math.min(Number(c.amount) || 0, goodsAmount) * 100) / 100
      if (discount <= 0) {
        usable = false
        reason = '优惠金额为 0'
        discount = 0
      }
    }
    coupons.push(Object.assign(couponViewOf(c, now), {
      usable: usable,
      reason: reason,
      discount: discount
    }))
  }

  // 可用券按优惠金额从大到小（同额保持店主的排序）→ 结算页默认选第一张
  const usableCoupons = coupons.filter((x) => x.usable)
  usableCoupons.sort((a, b) => b.discount - a.discount)
  const best = usableCoupons[0] || null

  return ok({
    goodsAmount: goodsAmount,
    packingFee: Number(cart.packingFee) || 0,
    cartNumber: Number(cart.number) || 0,
    coupons: coupons,
    usableCoupons: usableCoupons,
    bestCouponId: best ? best.id : '',
    bestDiscount: best ? best.discount : 0,
    serverNow: now
  })
}

// ----- 写接口：店主建券 / 改券 / 停用（阶段 11 第 5 步）-----

async function couponAdminList(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied
  const now = Date.now()
  let docs = []
  try {
    docs = await ctx.db.find('coupon', {}, { sort: 1, field: 'sort' })
  } catch (e) {
    console.error('[coupon] 店主券列表读取失败（检查 coupon 集合是否已建）：' +
      (e && e.message ? e.message : e))
    return fail('优惠券读取失败：请先在云开发控制台新建 coupon 集合（见 docs/云开发初始化清单.md）')
  }
  const list = docs.map((c) => couponAdminView(c, now))
  const statusCounts = { active: 0, pending: 0, expired: 0, soldout: 0, disabled: 0 }
  list.forEach((c) => {
    if (statusCounts[c.statusKey] !== undefined) statusCounts[c.statusKey]++
  })
  return ok({ couponList: list, total: list.length, statusCounts, serverNow: now })
}

/**
 * 新增 / 编辑优惠券（店主）
 * 参数：{ id?, name?, type?, threshold?, amount?, startTime?, endTime?,
 *        totalLimit?, perUserLimit?, enabled?, sort? }
 *   · 不带 id = 新增；带 id = 编辑；
 *   · **没传的字段沿用旧值**（可只传 { id, enabled } 做启用/停用）；
 *   · `usedCount` 只由服务端维护，payload 里传了也不采纳。
 */
async function couponUpsert(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const id = String(p.id || p._id || '').trim()
  const now = Date.now()

  let existing = null
  if (id) {
    try {
      existing = await ctx.db.get('coupon', id)
    } catch (e) {
      console.error('[coupon] 读取券失败（检查 coupon 集合是否已建）：' + (e && e.message ? e.message : e))
      return fail('优惠券读取失败：请先在云开发控制台新建 coupon 集合（见部署清单）')
    }
    if (!existing) return fail('优惠券不存在（可能已被删除），请返回列表刷新')
  }
  const base = existing || {}
  const creating = !existing

  // 只切启用/停用：快速通道，不重新校验其它字段（与 goodsUpsert 同一理由 ——
  // 历史脏数据不能把"停用"这张安全操作卡死）
  if (existing) {
    const changed = Object.keys(p).filter((k) => k !== 'id' && k !== '_id')
    if (changed.length === 1 && changed[0] === 'enabled') {
      if (typeof p.enabled !== 'boolean') return fail('启用状态不正确')
      await ctx.db.update('coupon', existing._id, {
        enabled: p.enabled,
        updBy: ctx.openid,
        updTime: now
      })
      return ok({
        id: existing._id,
        created: false,
        coupon: couponAdminView(Object.assign({}, existing, { enabled: p.enabled, updTime: now }), now)
      })
    }
  }

  const nameRes = normalizeText(hasField(p, 'name') ? p.name : base.name, {
    max: COUPON_NAME_MAX,
    msg: '请填写优惠券名称（最多 ' + COUPON_NAME_MAX + ' 个字）'
  })
  if (!nameRes.ok) return fail(nameRes.msg)

  const typeRaw = String(hasField(p, 'type') ? p.type : (base.type || COUPON_TYPE_THRESHOLD))
  if (typeRaw !== COUPON_TYPE_NEW && typeRaw !== COUPON_TYPE_THRESHOLD) {
    return fail('优惠券类型不正确（只能是新客立减或满减）')
  }

  const amountRes = normalizeMoney(hasField(p, 'amount') ? p.amount : base.amount, {
    minExclusive: 0,
    max: COUPON_AMOUNT_MAX,
    msg: '优惠金额必须大于 0 且不超过 ' + COUPON_AMOUNT_MAX + ' 元'
  })
  if (!amountRes.ok) return fail(amountRes.msg)

  let threshold = 0
  if (typeRaw === COUPON_TYPE_THRESHOLD) {
    const thrRes = normalizeMoney(hasField(p, 'threshold') ? p.threshold : base.threshold, {
      minExclusive: 0,
      max: COUPON_THRESHOLD_MAX,
      msg: '满减门槛必须大于 0 且不超过 ' + COUPON_THRESHOLD_MAX + ' 元'
    })
    if (!thrRes.ok) return fail(thrRes.msg)
    threshold = thrRes.value
    // 优惠 ≥ 门槛 = 白送（顾客实付 0），这基本一定是填错了，直接拒绝
    if (amountRes.value >= threshold) {
      return fail('优惠金额必须小于满减门槛（当前门槛 ' + threshold + ' 元）')
    }
  }
  // 新客券没有门槛：threshold 恒为 0（传入值忽略，避免"新客券却要求满 X"的四不像）

  const startResStart = normalizeCouponTime(hasField(p, 'startTime') ? p.startTime : base.startTime)
  const endResEnd = normalizeCouponTime(hasField(p, 'endTime') ? p.endTime : base.endTime)
  if (startResStart === null) return fail('请选择开始时间')
  if (endResEnd === null) return fail('请选择结束时间')
  if (startResStart < COUPON_TIME_MIN || endResEnd > COUPON_TIME_MAX) {
    return fail('时间超出合理范围，请重新选择')
  }
  if (startResStart >= endResEnd) return fail('结束时间必须晚于开始时间')
  const startTime = startResStart
  const endTime = endResEnd

  const totalLimitRes = normalizeInt(
    hasField(p, 'totalLimit') ? p.totalLimit : (base.totalLimit === undefined ? 0 : base.totalLimit),
    { min: 0, max: COUPON_LIMIT_MAX, msg: '总量必须是 0 ~ ' + COUPON_LIMIT_MAX + ' 的整数（0 = 不限）' }
  )
  if (!totalLimitRes.ok) return fail(totalLimitRes.msg)

  const perLimitRes = normalizeInt(
    hasField(p, 'perUserLimit') ? p.perUserLimit : (base.perUserLimit === undefined ? 1 : base.perUserLimit),
    { min: 0, max: COUPON_PER_USER_MAX, msg: '每人限用必须是 0 ~ ' + COUPON_PER_USER_MAX + ' 的整数（0 = 不限）' }
  )
  if (!perLimitRes.ok) return fail(perLimitRes.msg)
  // 新客券的每人上限强制为 1：**存 1**，而不是"存店主填的 5、但实际只按 1 算" ——
  // 否则店主在编辑页看到 5，会以为能发 5 次（与 effectivePerUserLimitOf 同一口径）
  const perUserLimit = typeRaw === COUPON_TYPE_NEW ? 1 : perLimitRes.value

  const sortRes = normalizeInt(
    hasField(p, 'sort') ? p.sort : (base.sort === undefined ? 10 : base.sort),
    { min: 0, max: COUPON_SORT_MAX, optional: true, msg: '排序必须是 0 ~ ' + COUPON_SORT_MAX + ' 的整数' }
  )
  if (!sortRes.ok) return fail(sortRes.msg)

  const enabledRaw = hasField(p, 'enabled') ? p.enabled : (creating ? true : base.enabled !== false)
  if (typeof enabledRaw !== 'boolean') return fail('启用状态不正确')

  const doc = {
    name: nameRes.value,
    type: typeRaw,
    threshold: threshold,
    amount: amountRes.value,
    startTime: startTime,
    endTime: endTime,
    totalLimit: totalLimitRes.value,
    perUserLimit: perUserLimit,
    enabled: enabledRaw,
    sort: sortRes.value === undefined ? 10 : sortRes.value,
    updBy: ctx.openid,
    updTime: now
  }

  let saved
  if (creating) {
    doc.usedCount = 0
    doc.createBy = ctx.openid
    doc.createTime = now
    let added = null
    try {
      added = await ctx.db.add('coupon', doc)
    } catch (e) {
      console.error('[coupon] 新建券失败（检查 coupon 集合是否已建）：' + (e && e.message ? e.message : e))
      return fail('保存失败：请先在云开发控制台新建 coupon 集合后重试')
    }
    saved = Object.assign({}, doc, { _id: (added && added._id) || doc._id })
  } else {
    // usedCount 是服务端计数器：编辑时不写它（云库 update 只覆盖传入字段）
    await ctx.db.update('coupon', existing._id, doc)
    saved = Object.assign({}, existing, doc)
    saved._id = existing._id
  }

  return ok({ id: saved._id, created: creating, coupon: couponAdminView(saved, now) })
}

// ----- 下单时的原子占券（并发不超发 / 不突破每人限用）-----

/**
 * 抢占一次券使用名额：先总量、再每人，任一失败都会把已占的次数还回去。
 * @returns {Promise<{ok:boolean, msg?:string}>}
 */
async function claimCouponUsage(ctx, coupon, openid) {
  const totalLimit = Number(coupon.totalLimit) || 0
  // ① 总使用上限：inc 后必须 ≤ totalLimit（条件在数据库端判断，不先读后判）
  const totalRes = await ctx.db.incField(
    'coupon',
    { _id: coupon._id },
    'usedCount',
    1,
    totalLimit > 0 ? { max: totalLimit } : {}
  )
  if (totalLimit > 0 && (!totalRes || totalRes.updated <= 0)) {
    return { ok: false, msg: '这张优惠券已经被抢完了' }
  }

  // ② 每人上限：先确保计数行存在，再条件自增
  const row = await ensureCouponUserRow(ctx, openid, coupon._id)
  if (!row) {
    await ctx.db.incField('coupon', { _id: coupon._id }, 'usedCount', -1, { min: 0 })
    return { ok: false, msg: '用券记录创建失败，请稍后重试' }
  }
  const perLimit = effectivePerUserLimitOf(coupon)
  const userRes = await ctx.db.incField(
    'coupon_user',
    { _id: row._id, _openid: openid },
    'usedCount',
    1,
    perLimit > 0 ? { max: perLimit } : {}
  )
  if (perLimit > 0 && (!userRes || userRes.updated <= 0)) {
    // 没抢到每人名额 → 把刚占的总次数还回去（不能白吃一次）
    await ctx.db.incField('coupon', { _id: coupon._id }, 'usedCount', -1, { min: 0 })
    return {
      ok: false,
      msg: perLimit === 1 ? '这张券您已经用过了' : '这张券每人限用 ' + perLimit + ' 次'
    }
  }
  return { ok: true }
}

/** 回滚一次券使用名额（落单失败时用；失败也不影响主流程，只记日志） */
async function releaseCouponUsage(ctx, coupon, openid) {
  try {
    await ctx.db.incField('coupon', { _id: coupon._id }, 'usedCount', -1, { min: 0 })
    const row = await ctx.db.findOne('coupon_user', { _openid: openid, couponId: String(coupon._id) })
    if (row) {
      await ctx.db.incField('coupon_user', { _id: row._id, _openid: openid }, 'usedCount', -1, { min: 0 })
    }
  } catch (e) {
    console.error('[coupon] 回滚用券次数失败：' + (e && e.message ? e.message : e))
  }
}

// ===========================================================================
// 购物车
// ===========================================================================
/**
 * 组装购物车视图（阶段 5.1 / 缺陷 D-01 修复）
 * ---------------------------------------------------------------------------
 * 原实现直接把 cart 集合里存的 `it.price`（= **加购当时的价格快照**）返回给前端，
 * 而 orderCreate 是按**数据库现价**重算的 → 商家改价后会出现
 * 「购物车显示 108 元、下单实付 400 元」这种顾客可见与实扣不一致的缺陷。
 *
 * 现在统一用商品现价重算（calcPrice，与 orderCreate 同一函数），
 * 并额外返回 priceChanged 供前端提示「价格已变动」。
 *
 * ⚠️ 2026-10-12 复核整改（阶段 5.1 的边界，与 orderCreate 的拒绝条件一一对应）：
 *   只做到"金额用现价"还不够 —— 商品**已下架**、或购物车里的**规格已被商家改动**时，
 *   购物车会显示一个正常金额，顾客填完地址电话点「去支付」才被拒（云函数会说
 *   「已下架」/「磅数选择有误」），结算页又没有改规格入口 = 死路。
 *   因此这里复用 orderCreate 的 resolveOrderSku 做同一套判定，明确标出
 *   `unavailable` + `unavailableReason`，前端据此提示并禁止提交。
 *   （商品被删除时退回快照价，否则整个购物车都算不出价。）
 */
function cartItemsOf(items, goodsMap, channel) {
  // 组装前端需要的字段：key / goodsId / name / pic / price / number / sku / priceChanged / unavailable
  return items.map((it) => {
    const g = goodsMap[it.goodsId]
    const snapshotPrice = Number(it.price) || 0
    // 现价：与 orderCreate 用同一个 calcPrice（商品不存在时才退回快照）
    // 阶段 9：channel 为 'pickup' 时单价按「自取立减」算，与下单口径一致
    const currentPrice = g ? calcPrice(g, it.sku, channel) : snapshotPrice

    // 不可下单原因：与 orderCreate 的校验保持同一口径
    let unavailableReason = ''
    if (!g) {
      unavailableReason = '商品已下架'
    } else if (g.enabled === false) {
      unavailableReason = '商品已下架'
    } else {
      const propertyChildIds = (it.sku || [])
        .map((s) => s.optionId + ':' + s.optionValueId)
        .join(',')
      if (!resolveOrderSku(g, propertyChildIds).ok) {
        unavailableReason = '规格已变更，请重新选择'
      } else {
        // 阶段 9：商家后来调高了「最少购买份数」→ 购物车里这项已不可能下单，
        // 提前标出来（与 orderCreate 的拒绝条件一一对应，避免填完地址才被拒）
        const minBuy = minBuyNumberOf(g)
        if (Number(it.number) < minBuy) {
          unavailableReason = '最少购买 ' + minBuy + ' 份'
        }
      }
    }

    return {
      key: it.key,
      goodsId: it.goodsId,
      name: g ? g.name : '（商品已下架）',
      pic: g ? g.pic : '',
      price: currentPrice,
      // 加购时的价格快照：仅供前端展示「原价」/判断是否变动，不参与结算
      snapshotPrice,
      // 商家改过价（或规格加价被改过）时为 true。
      // 不可下单的项不再报"改价"（真正的原因是下架/规格失效，避免误导）。
      priceChanged: !!g && !unavailableReason && currentPrice !== snapshotPrice,
      number: it.number,
      sku: it.sku || [],
      // 阶段 9：每件打包费与最少购买份数（前端据此显示「打包费 ¥2/件」等提示）
      packingFee: g ? packingFeeOf(g) : 0,
      minBuyNumber: g ? minBuyNumberOf(g) : 1,
      // 阶段 5.1：能否下单（false 时前端必须提示并禁止提交）
      unavailable: !!unavailableReason,
      unavailableReason
    }
  })
}

async function cartSummary(ctx, openid, channel) {
  const items = await ctx.db.find('cart', { _openid: openid }, {})
  const goodsIds = [...new Set(items.map((i) => i.goodsId))]
  const goodsMap = {}
  for (const gid of goodsIds) {
    const g = await ctx.db.get('goods', gid)
    if (g) goodsMap[gid] = g
  }
  const view = cartItemsOf(items, goodsMap, channel)
  let price = 0
  let number = 0
  // 阶段 9：打包费合计（元）。没配 packingFee 的商品贡献 0 → 与历史行为一致
  let packingFee = 0
  let priceChanged = false
  let unavailable = false
  const priceChangedNames = []
  const unavailableNames = []
  view.forEach((v) => {
    // 金额一律用**现价**累加（v.price 已是现价），与 orderCreate 的口径一致
    price += v.price * v.number
    packingFee += (Number(v.packingFee) || 0) * (Number(v.number) || 0)
    number += v.number
    if (v.priceChanged) {
      priceChanged = true
      // 同一商品可能有多行（不同规格），去重后给前端做提示
      if (priceChangedNames.indexOf(v.name) < 0) priceChangedNames.push(v.name)
    }
    if (v.unavailable) {
      unavailable = true
      const label = v.name + '（' + v.unavailableReason + '）'
      if (unavailableNames.indexOf(label) < 0) unavailableNames.push(label)
    }
  })
  return ok({
    items: view,
    price: Math.round(price * 100) / 100,
    // 阶段 9：打包费合计（下单时 amountReal = 商品金额 + 打包费 + 运费）
    packingFee: Math.round(packingFee * 100) / 100,
    number,
    // 阶段 5.1：价格是否发生过变动（前端据此提示「以下为最新价格」）
    priceChanged,
    priceChangedNames,
    // 阶段 5.1：购物车里是否存在"不可能下单成功"的项
    unavailable,
    unavailableNames
  })
}

async function cartInfo(payload, ctx) {
  // 阶段 9：带上配送方式 → 自提时单价按「自取立减」算（与下单同一口径）
  return cartSummary(ctx, ctx.openid, channelOf(payload))
}

/**
 * 加入购物车
 * 前端用法：shippingCarInfoAddItemV2({ goodsId, number, sku })
 * 注意：同名同规格会累加数量，而不是新增一行
 *
 * ⚠️ 2026-10-12 复核整改：数量校验与 orderCreate 同口径（整数 1..MAX_ITEM_NUMBER），
 *   并且**累加后**也要在上限内。原因：
 *     · 原来完全不校验 → `number: "abc"` 能写进购物车，`price += price*number` 算成 NaN，
 *       页面 `Number(price) || 0` 就显示「¥0」；
 *     · 原来只挡下单不挡加购 → 购物车里可以有 150 件，合计 13200 元，
 *       但 orderCreate 拒绝"单次最多购买 99 件"，这张单永远下不了。
 *   本店仍然**没有库存概念**，这里限制的只是"单次下单件数"，与库存无关。
 */
async function cartAdd(payload, ctx) {
  const { goodsId, number = 1, sku = [] } = payload || {}
  if (!goodsId) return fail('缺少商品 id')

  const goods = await ctx.db.get('goods', goodsId)
  if (!goods) return fail('商品不存在')
  if (goods.enabled === false) return fail(goods.name + ' 已下架')

  const numRes = normalizeOrderNumber(number, goods.name)
  if (!numRes.ok) return fail(numRes.msg)
  const addNumber = numRes.number

  // 规格校验：复用 resolveOrderSku（2026-10-14 审查修复，与 orderCreate 完全同一口径）。
  //   原来这里只判"该商品有的组都选了"，不拒绝**多余的伪造 optionId**：
  //   `sku=[{size},{flavor},{fake}]` 能加购成功，但随后 cartItemsOf 判定 resolveOrderSku 失败
  //   → 该行被标成 unavailable「规格已变更」，而结算页看到 unavailable 会**拦下整单提交**
  //   → 顾客既下不了单、又没有改规格的入口（死路）。两处口径必须一致。
  const skuRes = resolveOrderSku(
    goods,
    (sku || []).map((s) => String(s.optionId) + ':' + String(s.optionValueId)).join(',')
  )
  if (!skuRes.ok) return fail(skuRes.msg)
  const normSku = skuRes.sku

  const key = makeCartKey(goodsId, normSku)
  const price = calcPrice(goods, normSku, channelOf(payload))

  // 阶段 9：最少购买份数（默认 1，只有 > 1 才拦）。按"累加后的总数"判断，
  // 避免"已经买够 2 份、再点一次 +1"这种正常操作被误拦。
  const minBuy = minBuyNumberOf(goods)
  // 这一行的稳定 _id（见 stableDocId 注释）：并发插入时靠主键挡掉第二行
  const docId = stableDocId('c', ctx.openid, key)

  // ===== 2026-10-14（backlog：并发）改造：写入路径改成"原子 + 条件" =====
  // 原来：findOne 读出旧数量 → 自己算 total → update 覆盖写。
  //   两个并发请求都可能读到 3、各自写回 4 → 顾客连点两次"+"，购物车里只有 4 件（丢数量）。
  // 现在：已有行走 incCartNumber（数据库端 _.inc + 上下限条件）；
  //   没有行则用**由 (openid,key) 决定**的 _id 插入，插入撞主键 = 另一个并发请求
  //   刚建好这一行 → 改为原子累加。两条路径都不会丢数量，也不会写出两行同规格。
  const existing = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (existing) {
    // 2026-10-09：库存概念已删除，同规格加购直接累加
    // 2026-10-12：但累加后的总数必须仍在单次下单上限内，否则购物车会出现"永远下不了单"的行
    const incRes = await incCartNumber(ctx, existing._id, ctx.openid, addNumber, goods.name, minBuy)
    if (!incRes.ok) return fail(incRes.msg)
  } else {
    if (addNumber < minBuy) {
      return fail(goods.name + ' 最少购买 ' + minBuy + ' 份')
    }
    const row = {
      _openid: ctx.openid,
      key,
      goodsId,
      price,
      number: addNumber,
      sku: normSku,
      dateAdd: Date.now()
    }
    try {
      await ctx.db.add('cart', Object.assign({ _id: docId }, row))
    } catch (e) {
      // 插入失败有两种可能：
      //   ① 并发请求刚插入了同一行（_id 撞主键）→ 改为原子累加，这才是正确语义（累加而不是两行）
      //   ② 该环境不允许自定义 _id（见 stableDocId 注释）→ 降级为默认 _id 插入
      const retry = await incCartNumber(ctx, docId, ctx.openid, addNumber, goods.name, minBuy)
      if (retry.ok) return cartSummary(ctx, ctx.openid, channelOf(payload))
      if (!retry.gone) return fail(retry.msg)
      console.warn('[cartAdd] 自定义 _id 插入失败，降级为默认 _id：' + (e && e.message))
      await ctx.db.add('cart', row)
    }
  }
  return cartSummary(ctx, ctx.openid, channelOf(payload))
}

/**
 * 原子累加一行购物车的数量（并发安全）
 * ---------------------------------------------------------------------------
 * 2026-10-14 新增（backlog：并发）。
 * 上下限条件全部由**数据库端**判断（不是先读后判），所以并发下不会出现
 * "两个请求都判定没超上限、各写各的"这种越界。
 *   · 累加后 > MAX_ITEM_NUMBER → 拒绝（否则购物车里会出现永远下不了单的行）
 *   · 累加后 < minBuy（起购量）→ 拒绝（与改造前的判定口径一致）
 * @param {number} rowId 目标行的 _id
 * @param {number} delta 本次要加的数量
 * @returns {{ok:boolean, msg?:string, gone?:boolean}}
 *   ok=false 且 gone=true 表示"这一行已经不存在"（并发删除 / 插入其实没插进去），
 *   调用方据此改走插入路径；其余情况的 msg 是给顾客看的原因。
 */
async function incCartNumber(ctx, rowId, openid, delta, goodsName, minBuy) {
  const res = await ctx.db.incField(
    'cart',
    { _id: rowId, _openid: openid },
    'number',
    delta,
    { min: minBuy, max: MAX_ITEM_NUMBER }
  )
  if (res && res.updated > 0) return { ok: true }

  // 没改成：要么并发改动后越界、要么这一行被删了 / 是历史脏数据 → 重读一次给确切结论
  const now = await ctx.db.findOne('cart', { _id: rowId, _openid: openid })
  if (!now) return { ok: false, gone: true, msg: '购物车项已不存在，请重新加入' }

  const n = Number(now.number)
  if (!Number.isFinite(n)) {
    // 历史脏数据：2026-10-12 之前的版本能把 'abc' 这类字符串写进 number（当时已修）。
    // 非数字字段参与不了 _.inc（条件不匹配），这里直接自愈成本次要加的数量。
    await ctx.db.update('cart', rowId, { number: delta })
    return { ok: true }
  }
  if (n + delta > MAX_ITEM_NUMBER) {
    return { ok: false, msg: goodsName + ' 单次最多购买 ' + MAX_ITEM_NUMBER + ' 件' }
  }
  if (n + delta < minBuy) {
    return { ok: false, msg: goodsName + ' 最少购买 ' + minBuy + ' 份' }
  }
  return { ok: false, msg: '购物车已变化，请重试' }
}

async function cartModifyNumber(payload, ctx) {
  const { key, number } = payload || {}
  if (!key) return fail('缺少购物车项 key')
  const item = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (!item) return fail('购物车项不存在')

  // 数量必须是合法整数（原来 `number <= 0` 对 'abc' 为 false → 直接把字符串写进库，
  // 之后 cartInfo 的合计变成 NaN，页面显示 ¥0）
  const raw = typeof number === 'string' && number.trim() !== '' ? Number(number) : number
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return fail('数量不正确')
  }
  // 0（或负数）= 删除该项（van-stepper 减到 0 走这条）
  if (raw <= 0) {
    await ctx.db.remove('cart', item._id)
    return cartSummary(ctx, ctx.openid, channelOf(payload))
  }
  // 与 orderCreate 同口径：单次最多 MAX_ITEM_NUMBER 件
  if (raw > MAX_ITEM_NUMBER) {
    const g = await ctx.db.get('goods', item.goodsId)
    return fail(((g && g.name) || '商品') + ' 单次最多购买 ' + MAX_ITEM_NUMBER + ' 件')
  }
  // 阶段 9：最少购买份数（默认 1）。减到低于起购量就明确拒绝，而不是让它变成"下不了单"的行
  {
    const g = await ctx.db.get('goods', item.goodsId)
    const minBuy = minBuyNumberOf(g)
    if (raw < minBuy) {
      return fail(((g && g.name) || '商品') + ' 最少购买 ' + minBuy + ' 份')
    }
  }
  // 2026-10-09：库存概念已删除，修改数量只校验数量本身
  await ctx.db.update('cart', item._id, { number: raw })
  return cartSummary(ctx, ctx.openid, channelOf(payload))
}

async function cartRemoveItem(payload, ctx) {
  const { key } = payload || {}
  if (!key) return fail('缺少购物车项 key')
  const item = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (item) await ctx.db.remove('cart', item._id)
  return cartSummary(ctx, ctx.openid, channelOf(payload))
}

async function cartRemoveAll(payload, ctx) {
  await ctx.db.removeWhere('cart', { _openid: ctx.openid })
  return cartSummary(ctx, ctx.openid, channelOf(payload))
}

// ===========================================================================
// 用户身份
// ---------------------------------------------------------------------------
// 云开发的关键优势：用户身份由 cloud.getWXContext().OPENID 自动提供，
// 不需要 api工厂 那套 code 换 token 的流程，也没有 token 过期问题。
// 用户资料存在 user 集合，用 _openid 作为唯一标识。
// ===========================================================================
async function getUser(payload, ctx) {
  const user = await ctx.db.findOne('user', { _openid: ctx.openid })
  const base = {
    id: ctx.openid,
    mobile: user ? user.mobile || '' : '',
    avatarUrl: user ? user.avatarUrl || '' : '',
    nick: user ? user.nick || '' : '',
    // 注意：pages 里 sex 与 gender 两种写法都出现过，这里都提供，避免漏字段
    sex: user ? user.sex || 0 : 0,
    gender: user ? (user.gender !== undefined ? user.gender : user.sex || 0) : 0,
    birthday: user ? user.birthday || '' : ''
  }
  // 2026-09-26 阶段二：已移除会员字段 cardNumber / amount / score / balance。
  // 会员卡与积分体系整体删除，不再返回也不再存储这些字段。
  return ok({
    base,
    id: ctx.openid
  })
}

/**
 * 更新用户资料
 * 前端用法：modifyUserInfoV2({ nick, avatarUrl, mobile, sex, birthday })
 *
 * 2026-10-17（阶段 12）：补上服务端入参校验。原来直接原样写库：
 *   · nick 可以是 10 万字（会把「我的」页 / 店主端订单撑爆）；
 *   · avatarUrl 可以写 `wxfile://` 这种本地临时路径（顾客端头像裂图）；
 *   · mobile 可以写任意字符串（订单联系不上人）。
 * 现在只接受白名单字段，逐个校验/归一化；payload 里的 openid / _id 等一律忽略。
 * 手机号与生日都允许传空字符串（清空），但**不允许前端传来的格式不合法**。
 */
async function updateUser(payload, ctx) {
  const p = payload || {}
  const patch = {}

  if (hasField(p, 'nick')) {
    const nickRes = normalizeText(p.nick, { max: 20, msg: '昵称不能为空，且最多 20 个字' })
    if (!nickRes.ok) return fail(nickRes.msg)
    patch.nick = nickRes.value
  }

  if (hasField(p, 'avatarUrl')) {
    const s = String(p.avatarUrl === undefined || p.avatarUrl === null ? '' : p.avatarUrl).trim()
    if (s) {
      if (s.length > 512) return fail('头像地址过长')
      // 本地临时路径写进库里，顾客端就是裂图（与商品图片同一类防呆）
      if (/^(wxfile:|blob:|https?:\/\/tmp)/i.test(s)) {
        return fail('头像还没上传成功，请重新选择')
      }
      patch.avatarUrl = s
    } else {
      patch.avatarUrl = ''
    }
  }

  if (hasField(p, 'mobile')) {
    const s = String(p.mobile === undefined || p.mobile === null ? '' : p.mobile).trim()
    if (s && !/^1\d{10}$/.test(s)) return fail('手机号格式不正确（需 11 位）')
    patch.mobile = s
  }

  if (hasField(p, 'sex')) {
    const n = Number(p.sex)
    if ([0, 1, 2].indexOf(n) < 0) return fail('性别参数不正确')
    patch.sex = n
  }

  if (hasField(p, 'birthday')) {
    const s = String(p.birthday === undefined || p.birthday === null ? '' : p.birthday).trim()
    if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return fail('生日格式不正确（应为 YYYY-MM-DD）')
    patch.birthday = s
  }

  if (!Object.keys(patch).length) return fail('没有需要更新的字段')

  const user = await ctx.db.findOne('user', { _openid: ctx.openid })
  if (user) {
    await ctx.db.update('user', user._id, patch)
  } else {
    // 2026-09-26 阶段二：不再写入 amount / score / balance（会员体系已删除）
    await ctx.db.add('user', Object.assign({ _openid: ctx.openid }, patch))
  }
  return getUser(payload, ctx)
}

// 2026-09-26 阶段二：已删除 scoreLogs（我的积分记录）及其 score_log 集合引用。
// 会员积分体系整体移除。

/**
 * 首页轮播图
 * 前端用法：pages/index → 读 res.data，每项需要 id 与 picUrl
 */
async function banners(payload, ctx) {
  const docs = await ctx.db.find('banner', { enabled: true }, { sort: 1, field: 'sort' })
  return ok(docs.map((d) => ({
    id: d._id,
    picUrl: d.picUrl,
    link: d.link || ''
  })))
}

// ===========================================================================
// 平台配置
// ===========================================================================
/**
 * 平台/店铺配置
 * 前端用法：app.js onLaunch → 把返回的每项写入 storage，键名即为 key
 *
 * 返回的键：
 *   mallName          店铺名（前台导航标题）
 *   order_remark_msg  下单备注快捷短语，pages/add-note 按 \n 拆分成列表
 *   isAdmin           '1' / '0'，**按当前调用者 ctx.openid 现场算出**的店主标记
 *                     （2026-10-17 安全整改：原来下发店主 openid 白名单，等于把店主的
 *                      openid 发给每一个顾客；现在前端只拿得到这个布尔标记）
 *   delivery_rule     完整生效的配送规则（阶段 8）
 *
 * 数据来源优先级：
 *   1) 云数据库 app_config 集合（key/value 结构；mallName / order_remark_msg 可覆盖）
 *   2) 本地配置兜底（shop-config.js）
 *   isAdmin / delivery_rule **不允许**被 app_config 覆盖：前者必须按调用者身份算，
 *   后者由 loadDeliveryRule() 合并成完整规则后下发。
 *
 * 返回结构与 api 工厂 一致：res.code === 0 时 res.data 为 [{ key, value }]
 */
async function appConfig(payload, ctx) {
  const SHOP = require('./shop-config')
  // 门店名的唯一出处是 shop-config.js（根目录 + 云函数副本，两者一致性由测试守着）。
  // 阶段 5.2（缺陷 D-06）：这里原来写的是 `... || '卿欢蛋糕'` 的字面量兜底，
  // 副本里没有 name 时永远走兜底分支 → 改根目录配置首页标题不变，且"门店名三个来源互不同步"。
  // 现在不再有字面量：副本漏填 name 会被 tests/test-stage5.js 直接测出来。
  const defaults = {
    mallName: (SHOP.shop && SHOP.shop.name) || '',
    // 下单备注快捷短语：当前为空（业务方第一版不提供，保留用户手动输入备注）。
    // 补充方式：改 cloudfunctions/api/shop-config.js 的 orderRemarkMsg，或写 app_config 集合覆盖。
    order_remark_msg: SHOP.orderRemarkMsg || ''
  }

  const data = []
  for (const key of Object.keys(defaults)) {
    let value = defaults[key]
    // 云数据库可覆盖默认值（集合不存在时会抛错，走默认值即可）
    try {
      const doc = await ctx.db.findOne('app_config', { key })
      if (doc && doc.value !== undefined && doc.value !== null && doc.value !== '') {
        value = doc.value
      }
    } catch (e) {
      // 集合不存在 / 查询失败：使用默认值，不影响主流程。
      // 2026-10-14：记一条日志（原来完全静默，出问题时无从下手）
      console.error('[appConfig] 读取 app_config 失败（key=' + key + '），使用默认值：' +
        (e && e.message ? e.message : e))
    }
    data.push({ key, value: value === undefined ? '' : value })
  }

  // 2026-10-17：店主标记按当前调用者现场计算，**绝不下发 openid 白名单**。
  // 前端只拿它决定「店主中心 / 完成订单」按钮显不显示；真正鉴权仍是 requireAdmin(ctx)。
  data.push({ key: 'isAdmin', value: isAdmin(ctx) ? '1' : '0' })

  // 阶段 8：配送规则下发给前端（结算页要用**同一份**规则算运费）
  // 注意这里的值永远是"完整的生效规则"（不是云库里的半截覆盖），
  // 前端拿到后原样使用即可，不必依赖自己那份默认值 —— 从根上排除两边漂移。
  data.push({ key: 'delivery_rule', value: await loadDeliveryRule(ctx) })

  return ok(data)
}

// ===========================================================================
// 内容单页（CMS）
// ===========================================================================
/**
 * 用户隐私协议 / 常见问题
 * 前端用法：pages/about-us/detail → 读 res.data.info.title / res.data.info.content
 * 内容来源：shop-config.js 的 cms 字段（本地文案，不依赖 api 工厂后台）
 */
async function cmsPage(payload, ctx) {
  const SHOP = require('./shop-config')
  const key = (payload && payload.key) || ''
  const cms = (SHOP.cms || {})[key]
  if (!cms) {
    return fail('未配置该内容页：' + (key || '(空 key)'))
  }
  return ok({
    info: {
      key,
      title: cms.title || '',
      content: cms.content || ''
    }
  })
}

// ===========================================================================
// 微信支付（上线收尾 P0-1，2026-10-19 接入）
// ---------------------------------------------------------------------------
// 背景：阶段 7 之前 `wxpay` 固定返回 501，订单只会停在「待支付」并被 15 分钟超时取消；
//   店主端也没有任何入口能把订单推进到「制作中」，真实经营开始不了。
//
// 设计要点（为什么是"服务端查单"而不是"信任回调参数"）：
//   1) 云开发支付（cloud.cloudPay）的回调是云函数事件，客户端可以用
//      `wx.cloud.callFunction({ data: { outTradeNo, resultCode: 'SUCCESS' } })`
//      伪造一份"支付成功"事件（这正是 index.js 原 ENABLE_PAY_CALLBACK 开关要防的洞）。
//      因此**回调里的任何字段都只当作线索**，真正的支付状态一律用
//      `cloud.cloudPay.queryOrder()` 向微信支付服务端查单确认，并校验金额；
//      伪造的事件查单只会得到 NOTPAY，不会推进订单。
//   2) 状态推进只走 `markOrderPaid` 的**数据库端条件更新**（status 0 → 1）：
//      重复回调幂等；与 15 分钟超时取消并发时，只有一方能成功，不会"钱收了单没了"。
//   3) 除回调外还提供两条路径：
//      · orderPayConfirm —— 顾客在 requestPayment 成功后主动向服务端确认
//        （回调可能延迟/漏投递，客户端确认能立刻让订单变「制作中」）；
//      · orderMarkPaid —— 店主确认线下收款（到店支付 / 转账）。
//        商户号没下来之前，这条路径就能让真实经营先跑起来，不再卡在「待支付」。
//   4) 退款（P1-8）依赖商户号与退款接口，本期只留 needRefund 标记与日志，不做资金操作。
//
// ⚠️ 配置：cloudfunctions/api/shop-config.js 的 pay 段（enabled / subMchId / envId）。
//    未配置时 wxpay 明确返回 501「线上支付尚未开通」，**绝不伪造支付成功**。
// ===========================================================================
const PAY_CALLBACK_FN_DEFAULT = 'api'

/**
 * 统一下单的 body（商户订单标题）。
 * ⚠️ 店名不在这里写字面量：唯一出处是 shop-config.js 的 shop.name
 *   （tests/test-stage5.js 有守卫：handlers.js 的**代码**里不得出现硬编码店名）。
 */
function payBodyOf(orderNumber) {
  const SHOP = require('./shop-config')
  const name = (SHOP && SHOP.shop && SHOP.shop.name) || '订单'
  return name + '-' + orderNumber
}

/** 支付配置（shop-config.js 的 pay 段；缺省为空对象 = 未开通） */
function payConfigOf() {
  const SHOP = require('./shop-config')
  return (SHOP && SHOP.pay) || {}
}

/**
 * 线上支付是否已正确配置：商户号 + 云环境 ID 都必须有值。
 * 只配了 enabled 但没填商户号时仍视为未开通（fail-closed，宁可提示到店支付，
 * 也不能发一个注定失败的统一下单让顾客看到"支付失败"）。
 */
function payConfigured() {
  const p = payConfigOf()
  return !!(p && p.enabled === true &&
    String(p.subMchId || '').trim() &&
    String(p.envId || '').trim())
}

/** 未配置时的统一文案（utils/pay.js 的 isPayNotReady 依赖 501 + 文案关键词） */
function payNotReadyResult() {
  return fail('线上支付尚未开通（云开发支付未配置商户号），请到店支付或联系门店', 501)
}

/** 随机串（微信支付 nonceStr / 查单 nonceStr） */
function payNonce() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 把一张「待支付」订单推进到「制作中」（微信支付成功 / 店主线下确认收款共用）
 *
 * 幂等与并发：`where({ _id, status: 0 }).update()` 是数据库端条件更新，
 *   只有真正把状态从 0 改成 1 的那一次调用返回 updated=1；
 *   重复回调、回调与超时取消并发都不会重复推进。
 *
 * @param {object} ctx
 * @param {object} order 订单（调用方已读取）
 * @param {object} payInfo 写入订单 payInfo 的支付信息
 * @param {object} opts { source: 'wxpay_callback'|'client_confirm'|'admin_offline' }
 * @returns {Promise<{paid:boolean, duplicated?:boolean, conflict?:string}>}
 */
async function markOrderPaid(ctx, order, payInfo, opts) {
  const now = Date.now()
  const info = Object.assign({ payTime: now }, payInfo || {})
  const updated = await updateWhere(
    ctx,
    'order',
    { _id: order._id, status: ORDER_STATUS.UNPAID },
    {
      status: ORDER_STATUS.MAKING,
      statusStr: statusTextOf(ORDER_STATUS.MAKING),
      payTime: now,
      payInfo: info,
      paySource: (opts && opts.source) || ''
    }
  )
  if (updated > 0) return { paid: true }
  // 没改到行：读一次当前状态，区分「已经付过（幂等重放）」与「状态冲突（已取消/已完成）」
  const cur = await ctx.db.get('order', order._id)
  if (cur && (cur.status === ORDER_STATUS.MAKING || cur.status === ORDER_STATUS.DONE)) {
    return { paid: true, duplicated: true }
  }
  return { paid: false, conflict: cur ? statusTextOf(cur.status) : '订单不存在' }
}

/**
 * 记录支付异常并标记需要人工退款（2026-10-19 审查补强）
 * ---------------------------------------------------------------------------
 * 适用两类"钱可能已经收了、但订单没能正常推进"的情况：
 *   ① 金额不一致（如支付期间店主补录了运费，amountReal 变了）；
 *   ② 订单已被超时取消却收到支付成功（调用方另写 payAfterCancel 快照）。
 * 只打日志会漏对账，所以统一落库 needRefund / refundStatus='pending'；
 * 本期不做资金操作（P1-8），由店主/开发在商户平台退款后手工把状态改成 done。
 */
async function recordPayAnomaly(ctx, order, info) {
  try {
    await ctx.db.update('order', order._id, {
      payAnomaly: Object.assign({ detectedAt: Date.now() }, info || {}),
      needRefund: true,
      refundStatus: 'pending'
    })
  } catch (e) {
    console.error('[payAnomaly] 记录支付异常失败：' + ((e && e.message) || e))
  }
}

/**
 * 微信支付统一下单
 * 前端用法：utils/pay.js → 期望 res.code === 0 且 res.data 含
 *          timeStamp / nonceStr / package / signType / paySign
 *
 * 金额纪律：totalFee **由服务端按订单 amountReal 重算**（分），绝不接受前端传来的金额。
 */
async function wxpay(payload, ctx) {
  if (!payConfigured()) return payNotReadyResult()

  const orderId = payload && (payload.orderId || payload.id)
  if (!orderId) return fail('缺少订单 id')
  const order = await ctx.db.get('order', orderId)
  if (!order) return fail('订单不存在')
  if (order._openid !== ctx.openid) return fail('无权支付该订单')
  if (!order.orderNumber) return fail('订单号缺失，无法发起支付')

  // 已支付：幂等返回，前端据此直接回订单页，不再重复拉起支付
  if (order.status === ORDER_STATUS.MAKING || order.status === ORDER_STATUS.DONE) {
    return ok({ alreadyPaid: true, orderId: order._id, orderNumber: order.orderNumber })
  }
  if (order.status !== ORDER_STATUS.UNPAID) return fail('订单已取消，不能支付')

  // 2026-10-19 P1-5：运费待确认的订单**不允许线上支付** ——
  //   这类订单下单时 freight 记 0、amountReal 不含运费；若直接支付，店主事后补录运费
  //   也收不回来（只能退款重来）。先让店主在店主端「确认运费」，金额重算后再付。
  if (needsFreightConfirmOf(order)) {
    return fail('该订单运费待确认，请先联系门店确认运费后再支付')
  }

  // 超时兜底：与定时触发器/读取兜底同一口径，先取消失效订单再拒绝支付
  const now = Date.now()
  if (Number(order.dateAdd) > 0 && now - Number(order.dateAdd) > orderTimeoutMs()) {
    const r = await cancelPendingOrder(ctx, order, { cancelReason: 'timeout', cancelTime: now })
    return fail(r && r.ok
      ? '订单已超过支付时限，已自动取消'
      : '订单已超时，当前状态不可支付，请刷新订单页')
  }

  const totalFee = Math.round(Number(order.amountReal) * 100)
  if (!Number.isFinite(totalFee) || totalFee <= 0) return fail('订单金额异常，无法发起支付')

  if (!ctx.pay || typeof ctx.pay.unifiedOrder !== 'function') {
    // 云函数入口没注入支付模块（例如只更新了 handlers.js、没重新部署 index.js）
    console.error('[wxpay] ctx.pay.unifiedOrder 缺失：请更新并重新部署云函数 api')
    return fail('线上支付暂时不可用（云函数未加载支付模块），请到店支付或联系门店', 501)
  }

  const conf = payConfigOf()
  const nonceStr = payNonce()
  let res
  try {
    res = await ctx.pay.unifiedOrder({
      body: payBodyOf(order.orderNumber),
      outTradeNo: order.orderNumber,
      spbillCreateIp: conf.spbillCreateIp || '127.0.0.1',
      subMchId: String(conf.subMchId),
      totalFee: totalFee,
      envId: String(conf.envId),
      functionName: conf.callbackFunction || PAY_CALLBACK_FN_DEFAULT,
      nonceStr: nonceStr
    })
  } catch (e) {
    console.error('[wxpay] 统一下单异常：' + (e && e.message ? e.message : e))
    return fail('微信支付下单失败，请稍后重试；订单已保存')
  }

  if (!res || res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS' || !res.payment) {
    // 只把可读原因给顾客，完整返回体只进日志（避免把支付接口细节暴露到前端）
    console.error('[wxpay] 统一下单失败：' + JSON.stringify({
      returnCode: res && res.returnCode,
      returnMsg: res && res.returnMsg,
      resultCode: res && res.resultCode,
      errCode: res && res.errCode,
      errCodeDes: res && res.errCodeDes
    }))
    const reason = (res && (res.errCodeDes || res.returnMsg)) || '未知原因'
    return fail('微信支付下单失败：' + reason + '，请稍后重试；订单已保存')
  }

  // 记录预支付信息：仅用于对账排查，**支付状态一律以查单/回调结果为准**
  try {
    await ctx.db.update('order', order._id, {
      prepayInfo: { totalFee: totalFee, nonceStr: nonceStr, prepayTime: now }
    })
  } catch (e) {
    console.error('[wxpay] 记录预支付信息失败（不影响支付）：' + (e && e.message ? e.message : e))
  }

  return ok(Object.assign({
    orderId: order._id,
    orderNumber: order.orderNumber,
    totalFee: totalFee
  }, res.payment))
}

/**
 * 微信支付结果回调核心（由 index.js 在 action 路由之前拦截调用）
 *
 * 安全：**不信任 event 里的任何支付结果字段**——它们可能来自伪造的客户端调用。
 *   唯一可信来源是 `ctx.pay.queryOrder()` 的查单结果（微信支付服务端返回）：
 *   · tradeState 必须是 SUCCESS；
 *   · 实付 totalFee（分）必须与订单 amountReal 完全一致；
 *   · 只有上述校验都通过，才把订单 0 → 1（数据库端条件更新，幂等）。
 * @returns {Promise<{errcode:number, errmsg:string}>} errcode=0 让微信停止重试
 */
async function payCallbackCore(event, ctx) {
  const e = event || {}
  const outTradeNo = String(e.outTradeNo || '').trim()
  if (!outTradeNo) return { errcode: 0, errmsg: 'ignored' }

  const order = await ctx.db.findOne('order', { orderNumber: outTradeNo })
  if (!order) {
    console.error('[payCallback] 找不到订单：outTradeNo=' + outTradeNo)
    // 返回 0：无法处理的单不要无限重试（保留日志供人工排查）
    return { errcode: 0, errmsg: 'order not found' }
  }
  // 已经付过：直接返回成功（幂等，避免微信反复重试）
  if (order.status === ORDER_STATUS.MAKING || order.status === ORDER_STATUS.DONE) {
    return { errcode: 0, errmsg: 'duplicated' }
  }
  if (!payConfigured() || !ctx.pay || typeof ctx.pay.queryOrder !== 'function') {
    console.error('[payCallback] 支付未配置或缺少查单能力，拒绝推进订单：' + outTradeNo)
    return { errcode: -1, errmsg: 'pay not configured' }
  }

  const conf = payConfigOf()
  let q
  try {
    q = await ctx.pay.queryOrder({
      subMchId: String(conf.subMchId),
      outTradeNo: outTradeNo,
      nonceStr: payNonce()
    })
  } catch (err) {
    console.error('[payCallback] 查单异常：' + (err && err.message ? err.message : err))
    return { errcode: -1, errmsg: 'query order failed' }
  }
  if (!q || q.resultCode !== 'SUCCESS' || q.tradeState !== 'SUCCESS') {
    console.warn('[payCallback] 查单未成功，不推进订单：outTradeNo=' + outTradeNo +
      ' tradeState=' + (q && q.tradeState))
    return { errcode: 0, errmsg: 'not paid' }
  }

  const paidFee = Number(q.totalFee)
  const expectFee = Math.round(Number(order.amountReal) * 100)
  if (!Number.isFinite(paidFee) || paidFee !== expectFee) {
    console.error('[payCallback] 金额不一致，拒绝推进：outTradeNo=' + outTradeNo +
      ' 实付分=' + paidFee + ' 应付分=' + expectFee)
    // 2026-10-19 审查补强：金额不一致也要留痕。典型场景：顾客发起支付后店主补录了运费
    //   （amountReal 变了）→ 顾客仍按旧金额付款。钱可能已经收了，只打日志会漏对账。
    await recordPayAnomaly(ctx, order, {
      type: 'amount_mismatch',
      outTradeNo: outTradeNo,
      paidFee: paidFee,
      expectFee: expectFee,
      transactionId: q.transactionId || '',
      timeEnd: q.timeEnd || ''
    })
    // 返回 -1 让微信重试一次，便于排查；但状态绝不推进
    return { errcode: -1, errmsg: 'amount mismatch' }
  }

  const advanced = await markOrderPaid(ctx, order, {
    payChannel: 'wxpay',
    outTradeNo: outTradeNo,
    transactionId: q.transactionId || '',
    totalFee: paidFee,
    cashFee: Number.isFinite(Number(q.cashFee)) ? Number(q.cashFee) : paidFee,
    timeEnd: q.timeEnd || ''
  }, { source: 'wxpay_callback' })
  if (advanced.paid) return { errcode: 0, errmsg: 'ok' }

  // 钱已经收到、订单却已取消/完成：钱货不一致，必须留痕人工退款（本期不做资金操作）
  console.error('[payCallback] 已支付但订单状态冲突（可能已超时取消），需人工退款：outTradeNo=' +
    outTradeNo + ' 当前状态=' + advanced.conflict)
  try {
    await ctx.db.update('order', order._id, {
      payAfterCancel: {
        outTradeNo: outTradeNo,
        transactionId: q.transactionId || '',
        totalFee: paidFee,
        timeEnd: q.timeEnd || '',
        detectedAt: Date.now()
      },
      needRefund: true,
      refundStatus: 'pending'
    })
  } catch (e2) {
    console.error('[payCallback] 记录退款标记失败：' + ((e2 && e2.message) || e2))
  }
  return { errcode: 0, errmsg: 'paid but order conflicted' }
}

/**
 * 顾客端支付确认（requestPayment 成功后立即调用）
 * 作用：不依赖支付回调是否及时到达，主动查单确认并推进订单状态。
 * 语义：查单未成功（NOTPAY 等）返回 paid:false + 原因，属正常情况，不算接口失败。
 */
async function orderPayConfirm(payload, ctx) {
  const id = payload && payload.id
  if (!id) return fail('缺少订单 id')
  const order = await ctx.db.get('order', id)
  if (!order) return fail('订单不存在')
  if (order._openid !== ctx.openid) return fail('无权查看该订单')

  if (order.status === ORDER_STATUS.MAKING || order.status === ORDER_STATUS.DONE) {
    return ok({
      paid: true,
      status: order.status,
      orderNumber: order.orderNumber,
      amountReal: order.amountReal
    })
  }
  if (!payConfigured() || !ctx.pay || typeof ctx.pay.queryOrder !== 'function') {
    return ok({ paid: false, status: order.status, reason: 'pay_not_configured' })
  }

  const conf = payConfigOf()
  let q
  try {
    q = await ctx.pay.queryOrder({
      subMchId: String(conf.subMchId),
      outTradeNo: order.orderNumber,
      nonceStr: payNonce()
    })
  } catch (e) {
    console.error('[orderPayConfirm] 查单异常：' + (e && e.message ? e.message : e))
    return ok({ paid: false, status: order.status, reason: 'query_failed' })
  }
  if (!q || q.resultCode !== 'SUCCESS' || q.tradeState !== 'SUCCESS') {
    return ok({ paid: false, status: order.status, reason: (q && q.tradeState) || 'NOTPAY' })
  }

  const paidFee = Number(q.totalFee)
  const expectFee = Math.round(Number(order.amountReal) * 100)
  if (!Number.isFinite(paidFee) || paidFee !== expectFee) {
    console.error('[orderPayConfirm] 金额不一致：outTradeNo=' + order.orderNumber +
      ' 实付分=' + paidFee + ' 应付分=' + expectFee)
    // 同 payCallbackCore：金额不一致必须留痕（钱可能已经付了，只是订单金额在支付期间变了）
    await recordPayAnomaly(ctx, order, {
      type: 'amount_mismatch',
      outTradeNo: order.orderNumber,
      paidFee: paidFee,
      expectFee: expectFee,
      transactionId: q.transactionId || '',
      timeEnd: q.timeEnd || ''
    })
    return ok({ paid: false, status: order.status, reason: 'amount_mismatch' })
  }

  const advanced = await markOrderPaid(ctx, order, {
    payChannel: 'wxpay',
    outTradeNo: order.orderNumber,
    transactionId: q.transactionId || '',
    totalFee: paidFee,
    cashFee: Number.isFinite(Number(q.cashFee)) ? Number(q.cashFee) : paidFee,
    timeEnd: q.timeEnd || ''
  }, { source: 'client_confirm' })
  if (!advanced.paid) {
    console.error('[orderPayConfirm] 已支付但订单状态冲突：outTradeNo=' + order.orderNumber +
      ' 当前状态=' + advanced.conflict)
    try {
      await ctx.db.update('order', order._id, {
        payAfterCancel: {
          outTradeNo: order.orderNumber,
          transactionId: q.transactionId || '',
          totalFee: paidFee,
          timeEnd: q.timeEnd || '',
          detectedAt: Date.now()
        },
        needRefund: true,
        refundStatus: 'pending'
      })
    } catch (e2) {
      console.error('[orderPayConfirm] 记录退款标记失败：' + ((e2 && e2.message) || e2))
    }
    return ok({ paid: false, status: order.status, reason: 'order_conflict' })
  }
  return ok({
    paid: true,
    status: ORDER_STATUS.MAKING,
    orderNumber: order.orderNumber,
    amountReal: order.amountReal
  })
}

/**
 * 店主确认线下收款（到店支付 / 微信转账 / 现金），把待支付订单推进到「制作中」。
 * 为什么需要：商户号审核周期 1~3 周，在线上支付开通之前，这条路径让真实经营可先跑；
 *   鉴权走 requireAdmin（服务端 openid 白名单），顾客调不动。
 * 流程：二次确认后由店主点「确认收款」→ 服务端只接受 0 → 1（条件更新，幂等）。
 */
async function orderMarkPaid(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied
  const id = payload && payload.id
  if (!id) return fail('缺少订单 id')
  const order = await ctx.db.get('order', id)
  if (!order) return fail('订单不存在')
  if (order.status === ORDER_STATUS.MAKING || order.status === ORDER_STATUS.DONE) {
    return fail('该订单已收款，无需重复确认')
  }
  if (order.status !== ORDER_STATUS.UNPAID) {
    return fail('该订单当前不可确认收款（当前状态：' + statusTextOf(order.status) + '）')
  }
  const advanced = await markOrderPaid(ctx, order, {
    payChannel: 'offline',
    confirmedBy: ctx.openid,
    remark: payload && payload.remark ? String(payload.remark).slice(0, 100) : ''
  }, { source: 'admin_offline' })
  if (!advanced.paid) {
    return fail('订单状态已变化（' + (advanced.conflict || '未知') + '），请刷新后重试')
  }
  console.log('[orderMarkPaid] 店主确认线下收款 openid=' + ctx.openid +
    ' 订单号=' + order.orderNumber + ' 金额=' + order.amountReal)
  return ok({
    id: order._id,
    orderNumber: order.orderNumber,
    status: ORDER_STATUS.MAKING,
    payChannel: 'offline'
  })
}

// ===========================================================================
// 门店（单店模式下的兼容桩）
// ---------------------------------------------------------------------------
// 2026-09-26 阶段二：多门店功能（含 pages/all-stores 页面）已整体删除，
// 因此前端已无任何调用方。按改造约定「保留云函数兼容桩」保留这两个接口，
// 以便将来恢复门店详情能力时无需重新接线。
// ===========================================================================
/**
 * 门店列表
 * 说明：本项目为「单店 + 固定配置」（见 shop-config.js），不按定位找门店。
 * 当前返回空数组。前端已无调用方（pages/all-stores 已删除）。
 */
async function fetchShops(payload, ctx) {
  return ok([])
}

/**
 * 门店详情
 * 单店模式下门店信息来自 shop-config.js，这里返回失败以避免页面覆盖本地配置。
 * 当前前端已无调用方（pages/current-order 的联系门店已改为直读 shop-config 的电话）。
 */
async function shopSubdetail(payload, ctx) {
  return fail('单店模式不使用门店详情接口')
}

// ===========================================================================
// 订单
// ===========================================================================
/**
 * 下单幂等键（clientOrderToken）的校验与归一化
 * ---------------------------------------------------------------------------
 * 2026-10-14 新增（backlog：幂等）。为什么需要：
 *   弱网下"请求其实已经到服务端、订单也写好了，只是响应丢了"时，顾客看到失败再点一次
 *   → 生成第二张单（真机上确实会发生）。前端每次下单意图生成一个随机串、重试时复用，
 *   服务端用 (openid, 该串) 认领"这一单是不是已经建过"。
 * 规则：
 *   · 不传（老版本客户端）→ 放行，token 为空，退化为无幂等（记日志，便于以后收紧）；
 *   · 传了但不合法（长度/字符集）→ 直接拒绝，避免"随便塞个坏值就绕过幂等"。
 */
const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/
function normalizeOrderToken(raw) {
  if (raw === undefined || raw === null) return { ok: true, token: '' }
  const t = String(raw).trim()
  if (!t) return { ok: true, token: '' }
  if (!ORDER_TOKEN_RE.test(t)) return { ok: false, token: '' }
  return { ok: true, token: t }
}

/**
 * 下单成功的统一返回体（首次创建与幂等重放共用，避免两处结构漂移）
 * @param {object} o 库里的订单记录
 * @param {boolean} duplicated 是否为幂等重放（前端据此跳过"清购物车"这类只该做一次的动作）
 */
function orderCreateOk(o, duplicated) {
  const q = o.deliveryQuote || null
  return ok({
    id: o._id,
    orderNumber: o.orderNumber,
    pickupCode: o.pickupCode,
    amountReal: o.amountReal,
    goodsAmount: o.goodsAmount,
    packingFee: o.packingFee || 0,
    freight: o.freight || 0,
    // 阶段 11：优惠券抵扣（0 = 本单没用券）
    couponId: o.couponId || '',
    couponName: o.couponName || '',
    couponAmount: Number(o.couponAmount) || 0,
    freightText: (q && q.freightText) || '免配送费',
    distanceKm: q ? q.distanceKm : null,
    // 2026-10-19 P1-5：本单运费是否还需店主确认。前端据此**不进入收银台**，
    // 提示顾客等门店电话确认运费后再从订单页继续支付（否则会按不含运费的金额付款）。
    needsFreightConfirm: needsFreightConfirmOf(o),
    status: o.status,
    duplicated: !!duplicated
  })
}

/**
 * 创建订单
 * 前端用法：pages/pay/index.js → orderCreate(postData)
 * 关键点：
 *   1) 服务端重新算价，不信任前端传来的金额（防止改价）
 *   2) 服务端校验入参：数量（正整数、单行上限）、规格（每组必选 + 选项合法）、商品必须上架
 *      —— 2026-10-09 阶段二新增，见下方"阶段二安全修复"注释
 *   3) 同一请求内 goodsId + 规格 去重合并，再校验总数量上限（防止拆成多行绕过单行上限）
 *   4) 生成订单号（QH+日期+4位随机）并派生出取餐码，写入前查重
 *   5) 清空购物车（只清本单出现的行）
 *   6) 2026-10-14：幂等键 clientOrderToken —— 同一 token 的重复提交只落一张单
 *
 * 2026-10-09：**本店没有库存概念**，下单不再校验库存、也不再扣减/回补库存
 *             （原「原子扣减 + 失败回滚」整段已删除）。
 */
async function orderCreate(payload, ctx) {
  const {
    goodsJsonStr,
    remark = '',
    extJsonStr,
    shopIdZt,
    shopNameZt
  } = payload || {}

  // ===== 2026-10-14（backlog：幂等）：同一 token 的重复提交直接返回第一次那一单 =====
  // 放在所有校验之前：重放请求的唯一正确行为是"把第一次那一单原样返回"，
  // 而不是拿现在的 payload 再走一遍校验与算价（顾客可能已经改过购物车、
  // 期望时间也可能已经过期 —— 那会让重放失败甚至生成第二张单）。
  const tokenRes = normalizeOrderToken(payload && payload.clientOrderToken)
  if (!tokenRes.ok) return fail('下单标识不合法，请退出结算页重新进入')
  const clientOrderToken = tokenRes.token
  if (clientOrderToken) {
    const existed = await ctx.db.findOne('order', { _openid: ctx.openid, clientOrderToken })
    if (existed) return orderCreateOk(existed, true)
  } else {
    console.warn('[orderCreate] 请求未带幂等键 clientOrderToken（弱网重试可能重复下单）openid=' + ctx.openid)
  }
  /**
   * 幂等重放探测（阶段 11 补强）。
   * 为什么不能只在函数开头查一次：带券下单时，**并发**的第二个请求可能先通过开头的
   * 查重、接着在"券已被用掉/已被抢完"的校验处失败 —— 但此时第一笔单其实已经建好。
   * 顾客（或弱网重试）应当拿到那一张单，而不是一句"券用过了"。
   * 因此券相关的每一条失败分支都先探测一次"同一 token 是否已有订单"。
   */
  const idempotentReplay = async () => {
    if (!clientOrderToken) return null
    const existed = await ctx.db.findOne('order', { _openid: ctx.openid, clientOrderToken })
    return existed ? orderCreateOk(existed, true) : null
  }

  let goodsJson = []
  try {
    goodsJson = JSON.parse(goodsJsonStr || '[]')
  } catch (e) {
    return fail('商品数据格式错误')
  }
  // 2026-10-14 审查修复：`goodsJsonStr` 是合法 JSON 但不是数组时（如 '{"length":2}'），
  // 下面 `for...of` 会抛 TypeError → dispatch 把它包成 500 并把内部错误回显给客户端。
  // 业务错误必须是业务错误，且不能泄露实现细节。
  if (!Array.isArray(goodsJson)) return fail('商品数据格式错误')
  if (!goodsJson.length) return fail('购物车为空')
  // 2026-10-19 P1-4：单次下单行数上限（防恶意构造几千行放大数据库调用）
  if (goodsJson.length > ORDER_GOODS_MAX_ROWS) {
    return fail('单次下单最多 ' + ORDER_GOODS_MAX_ROWS + ' 行商品')
  }

  // 2026-10-19 P1-4：extJsonStr 必须是字符串且不能过长（原来对象/超长串会被 String() 后塞进库）
  if (extJsonStr !== undefined && extJsonStr !== null &&
    typeof extJsonStr !== 'string') {
    return fail('订单扩展信息格式不正确')
  }
  if (String(extJsonStr || '').length > ORDER_EXT_JSON_MAX_LEN) {
    return fail('订单扩展信息过长')
  }
  let extJson = {}
  try {
    extJson = JSON.parse(extJsonStr || '{}')
  } catch (e) {
    extJson = {}
  }
  // extJson 必须是普通对象（数组/null/字符串会让后续 extJson['x'] 语义跑偏）
  if (!extJson || typeof extJson !== 'object' || Array.isArray(extJson)) extJson = {}

  // 2026-10-19 P1-4：联系电话若提供必须是 11 位手机号。
  //   自提单的联络电话在 extJson（"联络电话" / "收货电话"），外送单在 address.phone
  //   （下面按配送方式再强制要求）。这里只做格式校验，不强制存在（老客户端兼容）。
  const extPhone = String(extJson['联络电话'] || extJson['收货电话'] || '').trim()
  if (extPhone && !MOBILE_RE.test(extPhone)) {
    return fail('联系电话格式不正确（请填 11 位手机号）')
  }

  // 2026-10-14 审查修复：备注的**类型与长度**校验。
  // 原来原样入库并原样回给店主列表：一条 30 万字符的备注能把店主端整页响应撑到 5.7MB，
  // 逼近云函数返回体上限 → 店主整页订单都打不开。
  const remarkRaw = remark === undefined || remark === null ? '' : remark
  if (typeof remarkRaw !== 'string') return fail('备注格式不正确')
  const remarkText = remarkRaw.trim()
  if (remarkText.length > 200) return fail('备注最多 200 字')

  const items = []
  let amount = 0
  let goodsNumber = 0
  // 阶段 9：配送方式要在**算价之前**确定 —— 自提时单价要按「自取立减」算，
  // 与前端结算页（cartSummary 带同一个 deliveryMode）保持同一口径。
  // 2026-10-14 审查修复：严格枚举 + 缺省推断（见 resolveDeliveryMode 注释）。
  //   以前是 `不是 'delivery' 就算 pickup`：传 'DELIVERY' / 枚举改名 / 老客户端漏传时，
  //   会把顾客填的**收货地址直接丢掉**、运费按 0 收、订单落库成自提。
  const deliveryMode = resolveDeliveryMode(payload)
  if (!deliveryMode) return fail('配送方式不正确')
  // 阶段 9：打包费合计（元/件 × 件数）
  let packingFeeTotal = 0

  // ===== 阶段二安全修复：先校验与合并，再算价 =====
  // 修复的三个问题（均有 tests/test-security.js 断言守着）：
  //   a) 数量完全不校验 → 负数能下单（金额为负）、"abc" 能下单（金额 NaN）、小数能下单
  //   b) 规格不校验 → 只选一半规格、选不存在的规格值、无规格商品传虚假规格组，都能下单
  //   c) 下架商品能下单（enabled: false 只被列表接口过滤，orderCreate 不看）
  const merged = {}
  const mergeOrder = []
  for (const row of goodsJson) {
    if (!row || !row.goodsId) return fail('商品数据不完整')

    const goods = await ctx.db.get('goods', row.goodsId)
    if (!goods) return fail('商品不存在：' + row.goodsId)
    if (goods.enabled === false) return fail(goods.name + ' 已下架')

    const numRes = normalizeOrderNumber(row.number, goods.name)
    if (!numRes.ok) return fail(numRes.msg)

    const skuRes = resolveOrderSku(goods, row.propertyChildIds)
    if (!skuRes.ok) return fail(skuRes.msg)

    // 同一商品 + 同一规格组合：合并为一行（防止拆成多行绕过单行的数量上限）
    const key = makeCartKey(row.goodsId, skuRes.sku)
    if (merged[key]) {
      merged[key].number += numRes.number
    } else {
      merged[key] = { goods, sku: skuRes.sku, number: numRes.number }
      mergeOrder.push(key)
    }
  }

  for (const key of mergeOrder) {
    const row = merged[key]
    const goods = row.goods
    // 合并后校验总数量的上限（已无库存概念）
    if (row.number > MAX_ITEM_NUMBER) {
      return fail(goods.name + ' 单次最多购买 ' + MAX_ITEM_NUMBER + ' 件')
    }
    // 阶段 9：最少购买份数（默认 1）。前端加购时就拦了，这里是服务端兜底
    const minBuy = minBuyNumberOf(goods)
    if (row.number < minBuy) {
      return fail(goods.name + ' 最少购买 ' + minBuy + ' 份')
    }

    // 阶段 9：单价按配送方式算（自提可能立减）
    const price = calcPrice(goods, row.sku, deliveryMode)
    // 阶段 9：打包费按件计（默认 0 = 不收）
    packingFeeTotal += packingFeeOf(goods) * row.number
    items.push({
      goodsId: goods._id,
      goodsName: goods.name,
      pic: goods.pic,
      price,
      number: row.number,
      amount: Math.round(price * row.number * 100) / 100,
      sku: row.sku,
      // 商品快照：仅供配送规则计算（蛋糕识别、尺寸解析）使用，不写入订单
      _goodsForQuote: {
        isCake: goods.isCake,
        properties: goods.properties || []
      },
      property: row.sku
        .map((s) => {
          const group = (goods.properties || []).find((g) => String(g.id) === String(s.optionId))
          if (!group) return ''
          const opt = (group.childsCurGoods || []).find(
            (c) => String(c.id) === String(s.optionValueId)
          )
          return opt ? opt.name : ''
        })
        .filter(Boolean)
        .join(' / ')
    })
    amount += price * row.number
    goodsNumber += row.number
  }

  amount = Math.round(amount * 100) / 100

  // ===== 阶段 11：优惠券校验（优惠金额的唯一出处）=====
  // 前端传来的 couponId 只是"想用哪张券"，能不能用、能减多少都以这里为准。
  // 校验顺序：参数 → 券存在 → 顾客资格（有效期/停用/新客/每人限用/总量）→ 金额门槛。
  const couponIdRes = parseCouponId(payload && payload.couponId)
  if (!couponIdRes.ok) return fail(couponIdRes.msg)
  let couponDoc = null
  let couponDiscount = 0
  if (couponIdRes.id) {
    try {
      couponDoc = await ctx.db.get('coupon', couponIdRes.id)
    } catch (e) {
      console.error('[coupon] 下单时读取券失败：' + (e && e.message ? e.message : e))
      return fail('优惠券暂不可用，请重新选择')
    }
    if (!couponDoc) return fail('优惠券不存在，请重新选择')
    const elig = await couponUserEligibility(ctx, couponDoc, ctx.openid, Date.now())
    if (!elig.ok) {
      // 并发重试时这单可能已经建好（见 idempotentReplay 注释）→ 返回那一单
      const replayed = await idempotentReplay()
      if (replayed) return replayed
      return fail(elig.reason)
    }
    // 门槛按**商品金额**判断（不含打包费/运费），与 couponUsableForCart 同口径
    if (String(couponDoc.type) === COUPON_TYPE_THRESHOLD &&
      amount < (Number(couponDoc.threshold) || 0)) {
      return fail('订单金额未满 ¥' + moneyText(couponDoc.threshold) + '，不能使用这张优惠券')
    }
    // 优惠不超过商品金额：amountReal 绝不会因优惠变成负数
    couponDiscount = Math.round(Math.min(Number(couponDoc.amount) || 0, amount) * 100) / 100
    if (couponDiscount <= 0) return fail('该优惠券暂不可用')
  }

  // ===== 2026-10-14 审查修复：期望时间的**服务端**权威校验 =====
  // 背景：`checkAdvanceTime`（营业时间 + 蛋糕提前 3 小时）此前只被客户端
  //   （pages/select-time 与结算页）调用，云函数里一行都没有 ——
  //   直接用 wx.cloud.callFunction 或改过的客户端可以下一个"2000-01-01 03:00"的单。
  // 口径：
  //   · 客户端**结构化字段** `payload.expectTime`（绝对时间）→ 严格校验，不合法直接拒；
  //   · 只在 `extJson` 里的可读文案（"今天 22:00"这类老格式）→ 能解析就校验，不能解析则跳过并记日志
  //     （不为难老版本客户端，但规则不再只存在于前端）。
  // 2026-10-19 P1-4：**含蛋糕的订单必须带期望时间** —— 否则直接省略字段就能绕过
  //   「提前 3 小时」（这是原来"缺省只 warn"留下的后门）。
  {
    const expectFromPayload = payload && payload.expectTime ? String(payload.expectTime).trim() : ''
    const expectFromExt = String(extJson['期望送达时间'] || extJson['自取时间'] || '').trim()
    const expectRaw = expectFromPayload || expectFromExt
    if (!expectRaw) {
      const cakeInfo = delivery.analyzeCake(
        items.map((it) => ({ goods: it._goodsForQuote || it, sku: it.sku }))
      )
      if (cakeInfo.hasCake) {
        return fail('请选择期望时间（蛋糕需提前 ' +
          require('./delivery-config').advance.minHours + ' 小时预订）')
      }
      console.warn('[orderCreate] 请求未带期望时间（非蛋糕订单，按可立即下单处理）openid=' +
        ctx.openid + ' 订单商品数=' + items.length)
    } else {
      const expectDate = parseExpectTime(expectRaw)
      if (!expectDate) {
        if (expectFromPayload) return fail('期望时间格式不正确，请重新选择')
        console.warn('[orderCreate] extJson 里的期望时间无法解析，跳过校验：' + expectRaw)
      } else {
        const adv = delivery.checkAdvanceTime({
          expectTime: expectDate,
          items: items.map((it) => ({ goods: it._goodsForQuote || it, sku: it.sku })),
          openingHours: require('./shop-config').shop.openingHours
        })
        if (!adv.valid) return fail(adv.tip)
      }
    }
  }

  // ===== 改造：服务端重算配送费（安全关键）=====
  // 设计原则：绝不信任前端传来的运费金额。
  //   前端传 freightAmount 只用于「与云函数算出的结果比对」，
  //   不一致时以云函数为准并记录告警，避免顾客伪造运费（例如传 0 元）。
  // 注：deliveryMode 已在函数开头算好（阶段 9：单价要按它算，所以不能等到这里）
  let freight = 0
  let quote = null

  // 商品快照仅用于配送规则计算，算完必须清理，不得写入订单
  const stripInternal = () => {
    items.forEach((it) => { delete it._goodsForQuote })
  }

  // 2026-10-19 P1-4：外送地址先归一化（白名单字段 + 限长 + 坐标合法），
  //   并要求必须有 11 位收货电话（原来电话完全不校验，外送单可能没有可联系号码）。
  let orderAddress = null
  if (deliveryMode === 'delivery') {
    if (!payload.address) {
      return fail('外送订单缺少收货地址')
    }
    const addrRes = validateOrderAddress(payload.address)
    if (!addrRes.ok) return fail(addrRes.msg)
    const address = addrRes.address
    if (!MOBILE_RE.test(address.phone)) {
      return fail('外送订单请填写正确的收货电话（11 位手机号）')
    }
    orderAddress = address
    // 阶段 8：先从云库装入规则（取不到 → 代码默认值），再算运费 ——
    // 保证「顾客屏显的运费」与「服务端实收」用的是同一份规则。
    await loadDeliveryRule(ctx)
    // 用与前端完全相同的规则计算（delivery-calc.js 由 sync-delivery.js 从主包生成）
    quote = delivery.calcQuote({
      address,
      goodsAmount: amount,
      items: items.map((it) => ({ goods: it._goodsForQuote || it, sku: it.sku }))
    })
    if (!quote.deliverable) {
      // 兜底文案与配置同源，避免这里残留旧说法（quote.freightText 正常都有值）
      return fail(quote.freightText || require('./delivery-config').area.outOfAreaTip)
    }
    freight = quote.freight === null ? 0 : quote.freight

    // 篡改检测：前端金额与云函数结果不一致时以云函数为准
    const clientFreight = payload.freightAmount
    if (clientFreight !== undefined && clientFreight !== null && Number(clientFreight) !== freight) {
      console.warn('[orderCreate] 配送费不一致，前端=' + clientFreight + ' 服务端=' + freight + '，以服务端为准')
    }
  }
  // 无论自提还是外送，都清掉内部快照字段
  stripInternal()
  freight = Math.round(freight * 100) / 100
  // 阶段 9：打包费合计（元）。默认 0（没有商品配 packingFee）→ 与历史金额完全一致
  packingFeeTotal = Math.round(packingFeeTotal * 100) / 100

  // 阶段 9：应付 = 商品金额（按配送方式算） + 打包费 + 配送费
  // 阶段 11：再用优惠券抵扣（只抵商品金额；Math.max(0, …) 保证不会出现负实付）
  const payableGoods = Math.max(0, Math.round((amount - couponDiscount) * 100) / 100)
  const totalAmount = Math.round((payableGoods + packingFeeTotal + freight) * 100) / 100

  // ===== 阶段 11：先原子占券，再生成订单号/落单 =====
  // 放在所有校验（含能否配送、期望时间）之后：被拒绝的请求不该消耗顾客的券。
  // 落单失败会在下面回滚（releaseCouponUsage），不会白吃一次使用次数。
  let couponClaimed = false
  if (couponDoc) {
    const claim = await claimCouponUsage(ctx, couponDoc, ctx.openid)
    if (!claim.ok) {
      const replayed = await idempotentReplay()
      if (replayed) return replayed
      return fail(claim.msg)
    }
    couponClaimed = true
  }

  // 2026-10-09：库存概念整体删除。
  // 删除内容：原先在这里对每个商品做「原子条件扣减 stores + 失败回滚」，
  //          以及对应的 decStores / incStores 数据库适配方法。
  // 现在下单只生成订单，不再读写任何库存字段。

  const now = Date.now()

  // 订单号：QH + 年月日 + '-' + 4 位随机数字（例 QH261010-8342）
  const orderNo = await generateUniqueOrderField(ctx, 'orderNumber', ORDER_NO_TRIES, (i) =>
    ORDER_NO_PREFIX + orderNoDatePart(now) + '-' + pad((randomInt(10000) + i * RETRY_STEP) % 10000, 4)
  )
  if (!orderNo) {
    // 订单号都没生成出来，这单不会落库 → 券次数要还回去
    if (couponClaimed) await releaseCouponUsage(ctx, couponDoc, ctx.openid)
    return fail('订单号生成失败，请稍后重试')
  }

  // 取餐码 = 订单号最后 4 位（自提叫号用，例 8342）
  const pickupCode = pickupCodeOf(orderNo)

  const order = {
    _openid: ctx.openid,
    orderNumber: orderNo,
    dateAdd: now,
    status: ORDER_STATUS.UNPAID,
    statusStr: statusTextOf(ORDER_STATUS.UNPAID),
    // amountReal = 商品金额 + 打包费 + 配送费（服务端重算后的最终应付金额）
    amountReal: totalAmount,
    goodsAmount: amount,
    // 阶段 9：打包费合计（元）。没配 packingFee 时为 0
    packingFee: packingFeeTotal,
    freight: freight,
    // 阶段 11：优惠券快照（券面 + 实际抵扣额）。
    // 2026-10-19 P0-3：取消订单/超时未支付会**退回优惠券**（见 cancelPendingOrder），
    //   返还后 usedCount 会回滚；订单上的 couponReleased 记录是否已返还（审计用）。
    //   支付成功时券才最终计入"已用次数"（不再回滚）。
    couponId: couponDoc ? couponDoc._id : '',
    couponName: couponDoc ? couponDoc.name : '',
    couponType: couponDoc ? couponDoc.type : '',
    couponAmount: couponDiscount,
    deliveryMode: deliveryMode,
    // 收货地址快照（仅外送订单；字段已按 P1-4 白名单归一化）
    address: orderAddress,
    deliveryQuote: quote ? {
      distanceKm: quote.distanceKm,
      inArea: quote.inArea,
      reason: quote.reason,
      freightText: quote.freightText
    } : null,
    goodsNumber,
    remark: remarkText,
    extJson,
    goods: items,
    // 取餐码：自提订单叫号用（= 订单号后 4 位）；外送订单不展示，但字段照样存
    pickupCode: pickupCode,
    // 2026-10-14 审查修复：门店标识**取服务端配置**，不再回显前端传来的值
    // （原来 `shopNameZt` 可以是任意对象/超长字符串，也会出现在店主端）
    shopIdZt: (require('./shop-config').shop || {}).id || 0,
    shopNameZt: (require('./shop-config').shop || {}).name || ''
  }

  // ===== 2026-10-14（backlog：幂等）：幂等键落库 + 稳定 _id =====
  // 落库是为了"事后能按 token 找回这一单"（排查 + 幂等重放）；
  // 稳定 _id 是为了挡住**并发**的重复提交：两个请求同时通过上面的查重、
  // 同时插入时，第二个会撞主键报错 → 在 catch 里改判为"重放"。
  if (clientOrderToken) {
    order.clientOrderToken = clientOrderToken
    order._id = stableDocId('o', ctx.openid, clientOrderToken)
  }

  let res
  try {
    res = await ctx.db.add('order', order)
  } catch (e) {
    if (!clientOrderToken) {
      // 落单失败（非幂等场景）→ 把刚占的券次数还回去
      if (couponClaimed) await releaseCouponUsage(ctx, couponDoc, ctx.openid)
      throw e
    }
    // ① 并发重复提交：另一个请求已用同一 token 建好单 → 返回那一单（这才是幂等该有的结果）
    const dup = await ctx.db.findOne('order', { _openid: ctx.openid, clientOrderToken })
    if (dup) {
      // 这张单的用券次数由先成功的那个请求承担，本请求刚占的那次必须还回去
      if (couponClaimed) await releaseCouponUsage(ctx, couponDoc, ctx.openid)
      return orderCreateOk(dup, true)
    }
    // ② 该环境不允许自定义 _id（见 stableDocId 注释）→ 去掉 _id 再试一次。
    //    宁可退化为"并发下仍可能重复"，也不能让顾客完全下不了单；
    //    此时仍有上面的 token 查重兜底（顺序重试依然安全）。
    if (order._id) {
      console.warn('[orderCreate] 自定义 _id 写入失败，降级为默认 _id 重试：' + (e && e.message))
      delete order._id
      try {
        res = await ctx.db.add('order', order)
      } catch (e2) {
        if (couponClaimed) await releaseCouponUsage(ctx, couponDoc, ctx.openid)
        throw e2
      }
    } else {
      if (couponClaimed) await releaseCouponUsage(ctx, couponDoc, ctx.openid)
      throw e
    }
  }

  // 2026-10-14 审查修复：**只清本单出现的商品行**。
  // 原来是 removeWhere 清整车：如果请求只包含了购物车的一部分（改过的客户端/重放），
  // 顾客购物车里其它没下单的商品会被一起删掉、凭空消失。
  for (const cartKey of Object.keys(merged)) {
    await ctx.db.removeWhere('cart', { _openid: ctx.openid, key: cartKey })
  }

  // 首次创建与幂等重放共用同一个返回体构造函数（结构不会漂移）
  return orderCreateOk(Object.assign({}, order, { _id: (res && res._id) || order._id }), false)
}

/**
 * 店主视角订单列表（T-3，阶段 10 第一块，2026-10-14）
 * ---------------------------------------------------------------------------
 * 为什么必须要有它：`orderList` 按 `_openid` 隔离，**店主在小程序里根本看不到顾客下的单** ——
 * 「取餐码对号」「完成订单」「自己送 / 叫跑腿」（店主 10-12 说的 R-04）这条链路全都走不通。
 *
 * 与 orderList 的三点区别：
 *   1) **鉴权**：`requireAdmin(ctx)` —— 服务端用 ctx.openid 校验白名单，前端改不掉；
 *   2) **范围**：跨顾客查询，可按状态过滤、分页，并附各状态数量（前端做筛选标签）；
 *   3) **接单要用的信息**：收货人 / 电话 / 地址（含经纬度，供导航）/ 期望时间 / 备注 /
 *      商品明细 / 取餐码。**不返回 `_openid`**（店主不需要，少一份可泄露的标识）。
 *
 * 参数：{ statusBatch?: '0,1', page?: 1, pageSize?: 20 }
 * 返回：{ orderList, total, page, pageSize, statusCounts, serverNow }
 */
const ADMIN_PAGE_SIZE_DEFAULT = 20
const ADMIN_PAGE_SIZE_MAX = 50

function adminOrderView(o) {
  const ext = o.extJson || {}
  const addr = o.address || null
  const goods = o.goods || []
  // 2026-10-14 审查修复：接单信息**以服务端保存的结构化字段为准**。
  //   运费是按 `payload.address`（服务端算的）算的，而原来店主看到的收货人/电话/地址
  //   全部优先取客户端的 `extJson` —— 客户端可任意写，于是"运费按 A 地址收 0 元、
  //   店主看到的却是 30 公里外的 B 地址（一键导航还会导到 B）"。
  //   现在：address 有值就用 address；只有自提单（没有结构化地址）才回退 extJson 的联络电话。
  const addressText = addr
    ? [addr.province, addr.city, addr.district, addr.detail].filter(Boolean).join('')
    : (ext['收货地址'] || '')
  const quote = o.deliveryQuote || null
  return {
    id: o._id,
    orderNumber: o.orderNumber,
    // 取餐码：老订单没有 pickupCode 字段，回退用「订单号后 4 位」现算
    pickupCode: o.pickupCode || pickupCodeOf(o.orderNumber),
    status: o.status,
    // 阶段 4.1：文案统一由服务端按 status 现算
    statusStr: statusTextOf(o.status),
    deliveryMode: o.deliveryMode || 'pickup',
    dateAdd: o.dateAdd,
    // 期望时间：外送写「期望送达时间」，自提写「自取时间」（都存绝对时间）
    expectTime: ext['期望送达时间'] || ext['自取时间'] || '',
    amountReal: o.amountReal,
    goodsAmount: o.goodsAmount,
    packingFee: o.packingFee || 0,
    // 阶段 11：本单用了什么券、抵了多少（店主对账用；0 = 没用券）
    couponName: o.couponName || '',
    couponAmount: Number(o.couponAmount) || 0,
    freight: o.freight,
    goodsNumber: o.goodsNumber,
    // ===== 接单要用的联系信息 =====
    contactName: (addr && addr.name) || ext['收货人'] || '',
    contactPhone: (addr && addr.phone) || ext['收货电话'] || ext['联络电话'] || '',
    addressText,
    // 结构化地址（含经纬度）：店主端可直接「一键导航」
    address: addr,
    distanceText: quote && quote.distanceKm !== null && quote.distanceKm !== undefined
      ? quote.distanceKm + '公里'
      : '',
    // 2026-10-14 审查修复：把服务端算出的配送判定也下发给店主 ——
    // 否则"运费待确认（>8km / 地址可疑）"的订单在店主页面上跟真免运费的长得一样，
    // 店主无法判断这一单要不要打电话确认运费。
    deliveryQuote: quote ? {
      distanceKm: quote.distanceKm,
      inArea: quote.inArea,
      reason: quote.reason,
      freightText: quote.freightText,
      // 阶段 10：店主补录过运费没有（前端据此把"确认运费"按钮换成"已确认 ¥X"）
      freightConfirmed: quote.freightConfirmed === true
    } : null,
    remark: o.remark || '',
    goods: goods.map((g) => ({
      goodsName: g.goodsName,
      property: g.property,
      number: g.number,
      price: g.price
    })),
    // 一行摘要，列表页直接显示（避免前端拼字符串）
    goodsSummary: goods
      .map((g) => g.goodsName + (g.property ? '（' + g.property + '）' : '') + '×' + g.number)
      .join('、')
  }
}

async function orderAdminList(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const p = payload || {}
  const now = Date.now()
  // 店主视角也做"读取兜底"：先把**所有顾客**超时未支付的单取消掉（等同定时触发器的逻辑），
  // 否则定时触发器没建出来时，店主会一直看到挂在"待支付"的单。
  await expireUnpaidForViewer(ctx, now, { all: true })

  const all = await ctx.db.find('order', {}, { sort: -1, field: 'dateAdd' })

  // 各状态数量（不受筛选影响，供前端做筛选标签）
  const statusCounts = {}
  all.forEach((o) => {
    const k = String(o.status)
    statusCounts[k] = (statusCounts[k] || 0) + 1
  })

  let list = all
  // 2026-10-14 审查修复：**缺省只返回未完成的订单**（待支付 + 制作中）。
  //   原来缺省返回全部历史订单：接口一次把每一位顾客的姓名/电话/地址（含经纬度）/
  //   备注交给白名单里的任何人，且订单越多响应体越大（云函数返回体有上限）。
  //   店主端要看历史时就显式传 `statusBatch: '3'` 或 '0,1,3'。
  const statusFilterRaw = p.statusBatch === undefined || p.statusBatch === null
    ? '0,1'
    : String(p.statusBatch)
  if (statusFilterRaw.trim() !== '') {
    const allow = statusFilterRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !isNaN(n))
    list = all.filter((o) => allow.indexOf(Number(o.status)) >= 0)
  }

  const pageSizeRaw = Number(p.pageSize)
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
    ? Math.min(Math.floor(pageSizeRaw), ADMIN_PAGE_SIZE_MAX)
    : ADMIN_PAGE_SIZE_DEFAULT
  const pageRaw = Number(p.page)
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1

  const total = list.length
  const start = (page - 1) * pageSize
  const pageList = list.slice(start, start + pageSize)

  return ok({
    orderList: pageList.map(adminOrderView),
    total,
    page,
    pageSize,
    statusCounts,
    // 前端用「服务端时间」和本机时间的差值对齐倒计时
    serverNow: now
  })
}

async function orderList(payload, ctx) {
  const { statusBatch } = payload || {}
  // 2026-10-12：读取兜底 —— 先把该顾客超时未支付的订单取消掉，再查列表。
  // 这样即使定时触发器没建/没生效，顾客打开订单页也不会看到"永远挂着"的待支付订单。
  const now = Date.now()
  await expireUnpaidForViewer(ctx, now)

  const all = await ctx.db.find('order', { _openid: ctx.openid }, { sort: -1, field: 'dateAdd' })
  let list = all
  // 2026-10-14 审查修复：判定与 orderAdminList 统一为"非空字符串才过滤"。
  //   原来用 `if (statusBatch)`：`statusBatch: 0`（数字，代表"只看待支付"）是假值 → 变成不过滤。
  const statusFilter = statusBatch === undefined || statusBatch === null ? '' : String(statusBatch).trim()
  if (statusFilter !== '') {
    const allow = statusFilter
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !isNaN(n))
    list = all.filter((o) => allow.indexOf(Number(o.status)) >= 0)
  }
  const goodsMap = {}
  list.forEach((o) => {
    goodsMap[o._id] = o.goods || []
  })
  const timeoutMs = orderTimeoutMs()
  return ok({
    orderList: list.map((o) => ({
      id: o._id,
      orderNumber: o.orderNumber,
      // 取餐码：老订单没有 pickupCode 字段，回退用「订单号后 4 位」现算
      pickupCode: o.pickupCode || pickupCodeOf(o.orderNumber),
      deliveryMode: o.deliveryMode || 'pickup',
      dateAdd: o.dateAdd,
      status: o.status,
      // 阶段 4.1：文案统一由服务端按 status 现算，不直接回传库里可能过期的 statusStr
      statusStr: statusTextOf(o.status),
      amountReal: o.amountReal,
      goodsNumber: o.goodsNumber,
      // 阶段 11：优惠券抵扣（列表页可显示「券 -¥10」；0 = 没用券）
      couponAmount: Number(o.couponAmount) || 0,
      couponName: o.couponName || '',
      // 2026-10-12：待支付订单的自动取消时刻（时间戳）。
      // 由服务端下发、前端只做倒计时展示，避免把 15 分钟这个数字硬编码到页面上。
      autoCancelAt: o.status === ORDER_STATUS.UNPAID && Number(o.dateAdd) > 0
        ? Number(o.dateAdd) + timeoutMs
        : null,
      shopIdZt: o.shopIdZt,
      shopNameZt: o.shopNameZt
    })),
    goodsMap,
    logisticsMap: {},
    // 前端用「服务端时间」和本机时间的差值对齐倒计时，避免顾客手机时钟不准
    serverNow: now
  })
}

async function orderDetail(payload, ctx) {
  const id = payload && payload.id
  if (!id) return fail('缺少订单 id')
  // 2026-10-12：读取兜底（同 orderList）—— 顾客打开详情页时，超时的待支付订单先被取消
  const now = Date.now()
  await expireUnpaidForViewer(ctx, now)

  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权查看该订单')
  const timeoutMs = orderTimeoutMs()
  return ok({
    orderInfo: {
      id: o._id,
      orderNumber: o.orderNumber,
      // 取餐码：老订单没有 pickupCode 字段，回退用「订单号后 4 位」现算
      pickupCode: o.pickupCode || pickupCodeOf(o.orderNumber),
      deliveryMode: o.deliveryMode || 'pickup',
      dateAdd: o.dateAdd,
      status: o.status,
      // 阶段 4.1：文案统一由服务端按 status 现算
      statusStr: statusTextOf(o.status),
      amountReal: o.amountReal,
      goodsNumber: o.goodsNumber,
      // 2026-10-14 审查修复：订单详情补**费用明细**。
      // 原来 orderInfo 只有 amountReal，订单详情页只能显示"共 N 件商品，小计 ¥(含打包费+运费的总额)"，
      // 而运费那行取的是 extJson 里**客户端下单时写的快照**，行项与总额对不上。
      goodsAmount: o.goodsAmount,
      packingFee: o.packingFee || 0,
      // 阶段 11：优惠券（订单详情页显示"优惠券 -¥X"一行；0 = 没用券）
      couponId: o.couponId || '',
      couponName: o.couponName || '',
      couponType: o.couponType || '',
      couponAmount: Number(o.couponAmount) || 0,
      // 2026-10-19 P0-1：支付渠道（订单详情「支付方式」按它显示微信支付 / 线下收款）。
      // 老订单 / 未支付订单没有 payInfo → 空串，页面回退显示「待支付/未支付」。
      payChannel: (o.payInfo && o.payInfo.payChannel) || '',
      paySource: o.paySource || '',
      freight: o.freight,
      deliveryQuote: o.deliveryQuote || null,
      // 收货地址快照（外送单才有；自提单为 null）
      address: o.address || null,
      // 2026-10-12：待支付订单的自动取消时刻（同 orderList）
      autoCancelAt: o.status === ORDER_STATUS.UNPAID && Number(o.dateAdd) > 0
        ? Number(o.dateAdd) + timeoutMs
        : null,
      remark: o.remark,
      shopIdZt: o.shopIdZt,
      shopNameZt: o.shopNameZt
    },
    goods: o.goods || [],
    extJson: o.extJson || {},
    user: { avatarUrl: '', nick: '' },
    serverNow: now
  })
}

/**
 * 取消一张「待支付」订单，并把它占用的优惠券还回去（上线收尾 P0-3，2026-10-19）
 * ---------------------------------------------------------------------------
 * 背景：阶段 11 的取舍是「取消/超时不退券」，但接入支付后这变成稳定投诉源与资损：
 *   顾客下单（券被原子占用）→ 支付取消/超时 → 订单取消、券却没了。
 *   现在改为：**下单时占用（防止同一张券并发下多单），订单取消/超时时返还**。
 *
 * 幂等与并发（关键）：
 *   · 状态用数据库端条件更新 `where({ _id, status: 0 })`，只有真正把 0 改成 -1 的
 *     那一次调用会返回 updated=1；重复调用/并发取消不会二次返还；
 *   · 订单上的 `couponReleased` 与状态更新**同一次写入**，作为返还审计字段；
 *   · 用券次数的回滚失败只会记日志（`releaseCouponUsage` 内部吞异常），
 *     宁可少退一张也不重复加券（重复加券 = 超发）。
 *
 * @returns {Promise<{ok:boolean, updated:number, couponReleased:boolean}>}
 *          ok=false 表示状态已不是「待支付」（被别的请求改过），调用方按冲突处理
 */
async function cancelPendingOrder(ctx, order, extra) {
  if (!order || !order._id) return { ok: false, updated: 0, couponReleased: false }
  const now = Date.now()
  const patch = Object.assign({
    status: ORDER_STATUS.CANCELLED,
    statusStr: statusTextOf(ORDER_STATUS.CANCELLED)
  }, extra || {})
  // 有券的订单：把"已返还"标记与状态更新写在一起（并发下只有一次能写成功）
  patch.couponReleased = !!order.couponId
  if (order.couponId) {
    patch.couponReleaseTime = now
    patch.couponReleaseReason = (extra && extra.cancelReason) || 'cancel'
  }

  const updated = await updateWhere(
    ctx,
    'order',
    { _id: order._id, status: ORDER_STATUS.UNPAID },
    patch
  )
  if (updated <= 0) return { ok: false, updated: 0, couponReleased: false }
  if (!order.couponId) return { ok: true, updated, couponReleased: false }

  // 状态已成功取消 → 真正归还用券次数（数据库端原子自减，min:0 兜底）
  await releaseCouponUsage(ctx, { _id: order.couponId }, order._openid)
  console.log('[cancelOrder] 订单取消，优惠券已退回 openid=' + order._openid +
    ' 订单号=' + order.orderNumber + ' 券=' + order.couponId)
  return { ok: true, updated, couponReleased: true }
}

async function orderClose(payload, ctx) {
  const id = payload && payload.id
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权操作该订单')
  if (o.status !== ORDER_STATUS.UNPAID) return fail('当前状态不可取消')

  const r = await cancelPendingOrder(ctx, o, { cancelReason: 'close', cancelTime: Date.now() })
  if (!r.ok) {
    // 并发/重放：可能另一条链路（超时取消）已经把它取消了 —— 对顾客来说结果一致
    const cur = await ctx.db.get('order', o._id)
    if (cur && cur.status === ORDER_STATUS.CANCELLED) {
      return ok({ id: o._id, couponReleased: cur.couponReleased === true })
    }
    return fail('订单状态已变化，请刷新后重试')
  }
  // 2026-10-19 P0-3：取消订单会退回优惠券（原实现"取消不退券"）
  // 2026-10-09：库存概念已删除，取消订单不再回补库存
  return ok({ id: o._id, couponReleased: r.couponReleased })
}

/**
 * 删除订单
 * ---------------------------------------------------------------------------
 * 2026-10-09 阶段二安全修复：
 *   1) 【真问题】原来不校验状态：任何状态的订单都能删，包括商家还没处理完的。
 *      → 现在只允许删除「已取消(-1)」和「已完成/已核销(3)」的订单，
 *        与前端 pages/current-order/index.wxml 的按钮规则一致
 *        （status==0 显示"取消订单"，status==3 显示"删除订单"）。
 *   2) 越权校验（o._openid !== ctx.openid）原本就有，保留。
 *
 * 2026-10-09 补充：本店**没有库存概念**，所以「删未支付订单会吃掉库存」这条
 *   风险已不存在；但"待支付订单先取消再删除"的状态约束仍然保留，
 *   目的是让订单状态流转清晰（取消 → 已取消 → 可删除），而不是为了库存。
 *
 * 已知边界（阶段 4 处理）：status=1（已支付/制作中）目前前后端都没有删除入口，
 *   既不可取消也不可删除 —— 需要一条"申请取消已支付订单"的路径，届时一起补。
 * 审计：删除是破坏性操作，这里额外打印一条日志（云函数日志可追溯是谁删了哪单）。
 */
async function orderDelete(payload, ctx) {
  const id = payload && payload.id
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权操作该订单')
  // 待支付订单请先走「取消订单」，保持状态流转清晰
  if (o.status === ORDER_STATUS.UNPAID) return fail('待支付订单请先取消，不能直接删除')
  // 只允许删除终态订单（已取消 / 交易成功）
  if (o.status !== ORDER_STATUS.CANCELLED && o.status !== ORDER_STATUS.DONE) {
    return fail('该订单当前不可删除')
  }
  console.log('[orderDelete] openid=' + ctx.openid + ' 删除订单 ' + id +
    ' 状态=' + o.status + ' 金额=' + o.amountReal)
  const removed = await ctx.db.remove('order', o._id)
  // 2026-10-19 P0-3：历史上「取消不退券」期间产生的已取消订单，删除前补一次返还。
  //   用「删除行数」当幂等闸门：并发/重复删除时只有真正删掉一行的那次才返还
  //   （真适配器返回 stats.removed；本地假 db 不返回时按 1 处理，测试不会重复删）。
  const removedCount = removed && typeof removed.removed === 'number' ? removed.removed : 1
  if (removedCount > 0 && o.status === ORDER_STATUS.CANCELLED &&
    o.couponId && o.couponReleased !== true) {
    await releaseCouponUsage(ctx, { _id: o.couponId }, o._openid)
    console.log('[orderDelete] 老订单删除前补退优惠券 openid=' + o._openid +
      ' 订单号=' + o.orderNumber + ' 券=' + o.couponId)
  }
  return ok({ id: o._id, removed: removedCount })
}

/**
 * 完成订单（店主在订单里点「完成订单」：顾客已取餐 / 已送达）
 * ---------------------------------------------------------------------------
 * 2026-10-10：扫码核销整体下线，本 action 取代原 orderHx。
 *   背景：原来 status 1 → 3（交易成功）只有「商家扫码核销」一个入口，
 *         撤掉扫码后必须给店主留一个手动完成的入口，否则订单会永远停在
 *         「制作中」，而「历史订单」只查 -1/3/4 → 历史订单永远为空。
 *   安全：
 *     1) 服务端用 ctx.openid 校验 shop-config.js 的 adminOpenids 白名单
 *        （前端只负责决定按钮显不显示，绝不能作为鉴权依据）；
 *     2) 只允许 status === 1（已支付/制作中）→ 3，待支付、已取消、已完成的
 *        订单都不能被"完成"，避免刷状态；
 *     3) 写入 finishBy / finishTime 审计字段，可追溯"谁在什么时候完成的"。
 */
async function orderFinish(payload, ctx) {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const id = payload && payload.id
  if (!id) return fail('缺少订单 id')
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o.status === ORDER_STATUS.DONE) return fail('该订单已完成')
  if (o.status !== ORDER_STATUS.MAKING) {
    return fail('该订单当前不可完成（仅已付款/制作中的订单可完成，当前状态：' +
      statusTextOf(o.status) + '）')
  }
  // 2026-10-19（P0-1 配套 / P1-3）：条件更新 1 → 3，防连点/并发重复完成
  const updated = await updateWhere(
    ctx,
    'order',
    { _id: o._id, status: ORDER_STATUS.MAKING },
    {
      status: ORDER_STATUS.DONE,
      statusStr: statusTextOf(ORDER_STATUS.DONE),
      finishBy: ctx.openid,
      finishTime: Date.now()
    }
  )
  if (updated <= 0) {
    const cur = await ctx.db.get('order', o._id)
    if (cur && cur.status === ORDER_STATUS.DONE) return fail('该订单已完成')
    return fail('订单状态已变化，请刷新后重试')
  }
  return ok({ id: o._id, orderNumber: o.orderNumber })
}

// ===========================================================================
// 超时未支付订单自动取消（阶段 4.2）
// ---------------------------------------------------------------------------
// 两条触发链路，共用下面的 cancelExpiredCore：
//   1) 定时触发器：云函数入口 index.js 拦截 event.Type === 'Timer' 后调用
//      cancelExpiredOrders（每 5 分钟一次，见 cloudfunctions/api/config.json）。
//   2) **读取兜底**：顾客打开订单列表 / 订单详情时，expireUnpaidForViewer 先把
//      该顾客自己已超时的待支付订单取消掉。
//      为什么必须有第 2 条：定时触发器需要在云开发控制台里真正创建出来才生效，
//      只上传云函数代码、没建触发器时订单会永远挂在「待支付」
//      （店主 2026-10-12 反馈的现象）。第 2 条不依赖任何触发器配置，
//      顾客只要打开订单页就一定能看到超时订单已取消。
//
// 规则：status === 0（待支付）且下单时间超过 orderTimeoutMinutes 分钟 → -1 已取消。
//
// 实现说明：
//   1) dbAdapter 只暴露等值查询（没有 db.command 的比较操作符），所以先按
//      status 拉取，再在 JS 里按 dateAdd 过滤 —— 与本文件 orderList 同一做法，
//      单店订单量完全够用，且 handlers 保持"不依赖 wx-server-sdk"、
//      本地测试可以用内存 db 直接跑。
//   2) 比较的是时间戳差值，与定时触发器的时区（UTC）无关。
//   3) 单次最多处理 MAX_PER_RUN 条，避免异常数据导致一次跑太久。
//
// ⚠️ 这两个函数都**不放进 handlers 路由表**：前端不可调用（与 importData 同样处理），
//    只由 exports.main 的 Timer 分支、orderList / orderDetail 内部或本地测试调用。
// ===========================================================================
const DEFAULT_ORDER_TIMEOUT_MINUTES = 15
const CANCEL_MAX_PER_RUN = 200

/**
 * 超时时间（毫秒）：唯一出处是 shop-config.js 的 orderTimeoutMinutes
 * 配置缺失或非法时回退到 DEFAULT_ORDER_TIMEOUT_MINUTES。
 * @returns {number}
 */
function orderTimeoutMs() {
  const SHOP = require('./shop-config')
  const minutes = Number(SHOP.orderTimeoutMinutes)
  const safe = minutes > 0 ? minutes : DEFAULT_ORDER_TIMEOUT_MINUTES
  return safe * 60 * 1000
}

/**
 * 扫描并取消超时未支付订单（两条链路共用的核心）
 * @param {object} ctx 含 db
 * @param {object} opts { now, minutes, openid }
 *        now      当前时间戳，默认 Date.now()（测试可注入）
 *        minutes  超时分钟数，默认取 shop-config
 *        openid   非空时只处理该顾客的订单（读取兜底用）；为空 = 全表（定时器用）
 * @returns {Promise<{scanned:number, cancelled:number, minutes:number}>}
 */
async function cancelExpiredCore(ctx, opts = {}) {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : orderTimeoutMs() / 60000
  const now = opts.now || Date.now()
  const cutoff = now - minutes * 60 * 1000

  const where = { status: ORDER_STATUS.UNPAID }
  if (opts.openid) where._openid = opts.openid

  const pending = await ctx.db.find('order', where)
  const expired = pending
    .filter((o) => Number(o.dateAdd) > 0 && Number(o.dateAdd) <= cutoff)
    .slice(0, CANCEL_MAX_PER_RUN)

  let cancelled = 0
  let couponReleased = 0
  for (const o of expired) {
    // 2026-10-19 P0-3：超时取消同样退回优惠券；条件更新保证与支付回调并发时只有一方成功
    const r = await cancelPendingOrder(ctx, o, {
      // 审计：区分"顾客主动取消"与"超时自动取消"
      cancelReason: 'timeout',
      cancelTime: now
    })
    if (!r.ok) {
      // 竞态：查出来之后订单被支付/被顾客取消 → 跳过，下一轮不会再是待支付
      continue
    }
    cancelled++
    if (r.couponReleased) couponReleased++
    console.log('[cancelExpiredOrders] 超时未支付自动取消 openid=' + o._openid +
      ' 订单号=' + o.orderNumber + ' 下单时间=' + o.dateAdd +
      (r.couponReleased ? '（已退券）' : ''))
  }

  return { scanned: pending.length, cancelled: cancelled, couponReleased: couponReleased, minutes }
}

/**
 * 顾客在读自己的订单前，先把该顾客超时未支付的订单取消掉（读取兜底）
 * @param {object} ctx 含 db / openid
 * @param {number} now 当前时间戳（与本次读接口共用，避免同一响应里时间不一致）
 * @returns {Promise<{scanned:number, cancelled:number, minutes:number}>}
 */
async function expireUnpaidForViewer(ctx, now, opts) {
  if (!ctx) return { scanned: 0, cancelled: 0, minutes: 0 }
  // opts.all = true：店主视角要扫**所有顾客**的超时单（等同于定时触发器的范围）
  const all = !!(opts && opts.all)
  if (!all && !ctx.openid) return { scanned: 0, cancelled: 0, minutes: 0 }
  try {
    return await cancelExpiredCore(ctx, { now, openid: all ? '' : ctx.openid })
  } catch (e) {
    // 兜底逻辑失败不能连累顾客看订单：记日志后按"没取消任何单"继续
    console.error('[expireUnpaidForViewer] 读取兜底取消失败：' + (e && e.message))
    return { scanned: 0, cancelled: 0, minutes: 0 }
  }
}

/**
 * 定时触发器入口：扫描并取消全部超时未支付订单
 * @param {object} payload 可注入 { now, timeoutMinutes, openid } 便于测试
 * @param {object} ctx 含 db
 * @returns {Promise<{code:number,data:{scanned:number,cancelled:number,couponReleased:number,timeoutMinutes:number}}>}
 */
async function cancelExpiredOrders(payload, ctx) {
  const p = payload || {}
  const r = await cancelExpiredCore(ctx, {
    now: p.now,
    minutes: p.timeoutMinutes,
    openid: p.openid || ''
  })
  return ok({
    scanned: r.scanned,
    cancelled: r.cancelled,
    // 2026-10-19 P0-3：本轮顺带退回优惠券的订单数（审计/日志用）
    couponReleased: r.couponReleased || 0,
    timeoutMinutes: r.minutes
  })
}


// 2026-09-26 阶段二：已删除 orderPay（余额支付 / 标记已支付）action。
// 会员余额体系整体移除，不再需要"用余额支付"这条链路。
//
// 2026-10-19（P0-1）：支付推进状态的入口已经补回来了，见上方支付段：
//   · payCallbackCore —— 微信支付结果回调（服务端 queryOrder 查单验真后 0→1）
//   · orderPayConfirm —— 顾客支付成功后主动确认到账
//   · orderMarkPaid  —— 店主确认线下收款（到店支付/转账）
// 三者共用 markOrderPaid 的数据库端条件更新，幂等且并发安全。

// ===========================================================================
// 数据导入 / 自检（初始化用，上线后可以保留也可以删）
// ===========================================================================
/**
 * 数据自检 + 一键导入种子数据
 * 前端用法：无需页面调用，在云开发控制台「云函数 → api → 云端测试」里手动跑。
 *
 * payload.checkOnly = true  → 只检查，不写入
 *
 * 检查内容：
 *   1) 4 个公开集合（category / goods / banner / app_config）的记录数与关键数据
 *   2) 是否存在禁止写入的集合（应当为空）
 *
 * 导入内容：与 cloud-data/categories.jsonl、goods-sample.jsonl、
 *          banner.jsonl、app-config.jsonl 完全一致。
 *          （这两处是同一份数据的两种投递方式，改一处记得改另一处）
 *
 * ⚠️ 幂等：已存在同 _id 的记录会被跳过，不会重复插入，可以反复调用。
 * ⚠️ 权限：写入用的是云函数的 admin 权限，不受集合安全规则限制。
 */
async function importData(payload, ctx) {
  // ---- 种子数据（与 cloud-data/import-*.json 一致）----
  const CATEGORIES = [
    { _id: 'cat_birthday', name: '生日蛋糕', sort: 5, enabled: true },
    { _id: 'cat_afternoon_tea', name: '下午茶甜品', sort: 10, enabled: true },
    { _id: 'cat_pizza', name: '现烤手工披萨', sort: 20, enabled: true },
    { _id: 'cat_mooncake', name: '纯手工中秋月饼', sort: 30, enabled: true },
    { _id: 'cat_candle_hat', name: '生日蜡烛和帽子', sort: 40, enabled: true },
    { _id: 'cat_strawberry_season', name: '草莓季', sort: 50, enabled: true },
    { _id: 'cat_confession', name: '告白蛋糕', sort: 60, enabled: true },
    { _id: 'cat_thousand_layer', name: '千层蛋糕系列', sort: 70, enabled: true },
    { _id: 'cat_fruit_cake', name: '水果蛋糕', sort: 80, enabled: true },
    { _id: 'cat_handpainted', name: '手绘蛋糕', sort: 90, enabled: true },
    { _id: 'cat_icecream_cake', name: '冰淇淋蛋糕', sort: 100, enabled: true },
    { _id: 'cat_elder_birthday', name: '长辈祝寿蛋糕', sort: 110, enabled: true },
    { _id: 'cat_double_birthday', name: '双层生日蛋糕', sort: 120, enabled: true },
    { _id: 'cat_christmas', name: '圣诞节蛋糕', sort: 130, enabled: true },
    { _id: 'cat_mothers_day', name: '母亲节蛋糕', sort: 140, enabled: true },
    { _id: 'cat_housewarming', name: '乔迁之喜蛋糕', sort: 150, enabled: true },
    { _id: 'cat_childrens_day', name: '儿童节蛋糕', sort: 160, enabled: true },
    { _id: 'cat_goddess_birthday', name: '女神生日蛋糕', sort: 170, enabled: true },
    { _id: 'cat_man_birthday', name: '男神生日蛋糕', sort: 180, enabled: true },
    { _id: 'cat_children_birthday', name: '儿童生日蛋糕', sort: 190, enabled: true },
    { _id: 'cat_room_temp_snack', name: '常温手工零食', sort: 200, enabled: true },
    { _id: 'cat_store_env', name: '店内环境', sort: 210, enabled: true },
    { _id: 'cat_packing_bag', name: '打包袋', sort: 220, enabled: true },
    { _id: 'cat_review_gift', name: '收藏，评价有🎁', sort: 230, enabled: true },
    { _id: 'cat_recommend', name: '推荐', sort: 240, enabled: true },
    { _id: 'cat_discount', name: '折扣', sort: 250, enabled: true }
  ]

  // 2026-10-12：换成店主提供的两张实拍图（首页轮播）。
  // 图已预裁成 3:2（与 pages/index 的 .focus = 720rpx x 480rpx 一致），
  // 见 images/banner/ 与 cloud-data/tools/README.md「图片托管」一节。
  // ⚠️ 与 cloud-data/banner.jsonl 必须保持一致（两处是同一份数据的两种投递方式）。
  const BANNERS = [
    { _id: 'b1', picUrl: '/images/banner/birthday-flower-cake.jpg', link: '', sort: 10, enabled: true },
    { _id: 'b2', picUrl: '/images/banner/mango-roll.jpg', link: '', sort: 20, enabled: true }
  ]

  // 阶段 5.2（缺陷 D-06）：mallName 的种子值同样取自 shop-config.js（不再写字面量），
  // 与 cloud-data/app-config.jsonl、shop-config.js 保持一致；
  // 改店名时只需改 shop-config.js + 重新部署云函数。
  // 2026-10-17：不再种子化店主白名单键（appConfig 改为按 ctx.openid 计算 isAdmin，
  // 店主 openid 只存在 cloudfunctions/api/shop-config.js 的 adminOpenids 里，不下发前端）。
  const APP_CONFIG = [
    { key: 'mallName', value: (require('./shop-config').shop || {}).name || '' },
    { key: 'order_remark_msg', value: '' }
  ]

  const GOODS = [
    {
      _id: 'g_musi_fruit', categoryId: 'cat_fruit_cake', name: '慕斯围边水果小蛋糕',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '动物奶油 / 新鲜水果 / 约400克',
      content: '<p>当季新鲜水果，动物奶油制作，当日现做现卖。</p>',
      minPrice: 54, unit: '个',
      purchaseNotes: '蛋糕需冷藏保存，建议2小时内食用。', sort: 10, enabled: true, isCake: true,
      properties: [
        { id: 'size', name: '磅数', childsCurGoods: [
          { id: 's4', name: '4寸', priceDelta: 0 },
          { id: 's6', name: '6寸', priceDelta: 34 },
          { id: 's8', name: '8寸', priceDelta: 74 }
        ] },
        { id: 'flavor', name: '口味', childsCurGoods: [
          { id: 'f_strawberry', name: '草莓', priceDelta: 0 },
          { id: 'f_mango', name: '芒果', priceDelta: 0 },
          { id: 'f_chocolate', name: '巧克力', priceDelta: 10 }
        ] }
      ]
    },
    {
      _id: 'g_birthday_classic', categoryId: 'cat_birthday', name: '经典生日蛋糕',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '可写生日牌 / 送蜡烛',
      content: '<p>经典款生日蛋糕，下单备注生日牌内容。</p>',
      minPrice: 88, unit: '个',
      purchaseNotes: '需要生日牌请在备注里写明文字。', sort: 10, enabled: true, isCake: true,
      properties: [
        { id: 'size', name: '磅数', childsCurGoods: [
          { id: 's6', name: '6寸', priceDelta: 0 },
          { id: 's8', name: '8寸', priceDelta: 50 },
          { id: 's10', name: '10寸', priceDelta: 110 }
        ] },
        { id: 'flavor', name: '口味', childsCurGoods: [
          { id: 'f_original', name: '原味', priceDelta: 0 },
          { id: 'f_chocolate', name: '巧克力', priceDelta: 10 },
          { id: 'f_matcha', name: '抹茶', priceDelta: 12 }
        ] }
      ]
    },
    {
      _id: 'g_thousand_mango', categoryId: 'cat_thousand_layer', name: '千层芒果蛋糕',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '手工千层皮 / 芒果夹心',
      content: '<p>手工摊制千层皮，夹入新鲜芒果。</p>',
      minPrice: 78, unit: '个',
      purchaseNotes: '千层蛋糕需冷藏，建议取出后尽快食用。', sort: 10, enabled: true, isCake: true,
      properties: [
        { id: 'size', name: '磅数', childsCurGoods: [
          { id: 's6', name: '6寸', priceDelta: 0 },
          { id: 's8', name: '8寸', priceDelta: 42 }
        ] }
      ]
    },
    {
      _id: 'g_ice_cream', categoryId: 'cat_icecream_cake', name: '冰淇淋蛋糕',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '需冷冻保存 / 口感冰凉',
      content: '<p>冰淇淋夹心，需冷冻保存。</p>',
      minPrice: 98, unit: '个',
      purchaseNotes: '请尽快食用，避免融化。', sort: 10, enabled: true, isCake: true,
      properties: [
        { id: 'size', name: '磅数', childsCurGoods: [
          { id: 's6', name: '6寸', priceDelta: 0 },
          { id: 's8', name: '8寸', priceDelta: 50 }
        ] }
      ]
    },
    {
      _id: 'g_candle_hat', categoryId: 'cat_candle_hat', name: '生日蜡烛和帽子套装',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '蜡烛 + 生日帽 / 无规格',
      content: '<p>一次性生日蜡烛与生日帽套装。</p>',
      minPrice: 8, unit: '套',
      purchaseNotes: '', sort: 90, enabled: true, isCake: false,
      properties: []
    }
  ]

  const checkOnly = !!(payload && payload.checkOnly)

  // ---- 幂等插入：已存在同 _id 就跳过 ----
  async function seed(collection, docs, idField) {
    let inserted = 0
    let skipped = 0
    for (const doc of docs) {
      const where = idField === '_id' ? { _id: doc._id } : { [idField]: doc[idField] }
      let exists = null
      try {
        exists = await ctx.db.findOne(collection, where)
      } catch (e) {
        return { error: '集合不存在或不可读：' + collection + '（' + (e.message || '') + '）' }
      }
      if (exists) { skipped++; continue }
      if (checkOnly) { skipped++; continue }
      if (collection === 'app_config') {
        await ctx.db.add(collection, doc)
      } else {
        // 需要保留自定义 _id（分类/商品/轮播的 id 被业务代码直接引用）
        await ctx.db.add(collection, doc)
      }
      inserted++
    }
    return { inserted, skipped }
  }

  const report = { checkOnly, collections: {} }

  // ---- 自检：记录数 ----
  const COLLECTIONS = ['category', 'goods', 'banner', 'app_config', 'user', 'cart', 'order']
  for (const col of COLLECTIONS) {
    try {
      const rows = await ctx.db.find(col, {}, {})
      report.collections[col] = { exists: true, count: rows.length }
    } catch (e) {
      report.collections[col] = { exists: false, count: 0, error: e.message || '查询失败' }
    }
  }

  if (checkOnly) {
    return ok(report)
  }

  // ---- 导入 ----
  report.seed = {}
  report.seed.category = await seed('category', CATEGORIES, '_id')
  // 2026-10-14 审查修复：**库里有商品就不塞样例商品**。
  // 种子商品的 _id 是 g_musi_fruit / g_birthday_classic 这类"样例 id"，与真实商品的
  // g_real_* 不同 → 在已上线的库上跑一次 importData，会给顾客目录追加 5 个
  // Logo 占位图的测试商品（幂等只对"自己的种子 id"生效，挡不住这种跨数据集污染）。
  {
    let goodsCount = 0
    try {
      const rows = await ctx.db.find('goods', {}, {})
      goodsCount = rows.length
    } catch (e) {
      goodsCount = 0
    }
    if (goodsCount > 0) {
      report.seed.goods = { inserted: 0, skipped: 0, skippedReason: 'goods 集合已有数据，跳过种子商品（防止给线上目录塞测试商品）' }
    } else {
      report.seed.goods = await seed('goods', GOODS, '_id')
    }
  }
  report.seed.banner = await seed('banner', BANNERS, '_id')
  report.seed.app_config = await seed('app_config', APP_CONFIG, 'key')

  // 导入后重新统计
  for (const col of ['category', 'goods', 'banner', 'app_config']) {
    try {
      const rows = await ctx.db.find(col, {}, {})
      report.collections[col] = { exists: true, count: rows.length }
    } catch (e) {
      report.collections[col] = { exists: false, count: 0, error: e.message || '查询失败' }
    }
  }

  return ok(report)
}

// ===========================================================================
// 路由表
// ===========================================================================
const handlers = {
  // 用户
  getUser,
  updateUser,
  // 平台配置 / 内容单页
  appConfig,
  cmsPage,
  // ⚠️ 2026-10-09 阶段二安全修复：importData 已从公开路由移除。
  //    原因：它原本能被任意用户调用 —— 不带 checkOnly 会真的写入种子数据，
  //    带 checkOnly 会返回 user/cart/order 的记录数（用户数据规模泄露），
  //    且每次调用对 7 个集合做全量扫描（配额消耗）。
  //    现在改为通过 module.exports.importData 暴露，只能在云开发控制台
  //    「云函数 → api → 云端测试」或本地测试里直接调用，前端 callFunction 拿不到。
  // 首页
  banners,
  // 门店（单店模式下的兼容桩）
  fetchShops,
  shopSubdetail,
  // 分类
  categoryList,
  // 商品
  goodsList,
  goodsDetail,
  // 店主端商品管理（阶段 10）：全部 requireAdmin + 入参校验 + updBy/updTime 审计
  // goodsAdminList 与顾客端 goodsList 的区别：不过滤 enabled（下架商品也要能找回来重新上架）
  goodsAdminList,
  goodsUpsert,
  goodsDelete,
  // 店主端配送设置（阶段 8 的规则"上云可改"，保存前显式校验、不静默吞掉非法值）
  deliveryRuleSave,
  // 购物车
  cartInfo,
  cartAdd,
  cartModifyNumber,
  cartRemoveItem,
  cartRemoveAll,
  // 订单
  orderCreate,
  orderList,
  orderDetail,
  orderClose,
  orderDelete,
  // 店主视角订单列表（T-3，阶段 10）：跨顾客查询 + requireAdmin
  orderAdminList,
  // 店主手动完成订单（取代原扫码核销 orderHx）
  orderFinish,
  // 店主端运费补录（「运费待确认」订单的补款入口，阶段 10）
  orderFreightConfirm,
  // 优惠券（阶段 11）：顾客端只读两个（券列表 / 结算页可用券+预估优惠），
  // 店主端两个写读接口（一律 requireAdmin + 入参校验 + usedCount 服务端维护）
  couponList,
  couponUsableForCart,
  couponAdminList,
  couponUpsert,
  // 微信支付（上线收尾 P0-1）：统一下单 / 支付后客户端确认 / 店主确认线下收款。
  // 支付结果回调不走路由表（见 payCallbackCore，由 index.js 在 action 路由之前拦截）。
  wxpay,
  orderPayConfirm,
  orderMarkPaid
}

/**
 * 统一入口
 * @param {string} action 动作名
 * @param {object} payload 参数
 * @param {object} ctx { db, openid }
 */
async function dispatch(action, payload, ctx) {
  // 2026-10-14 审查修复：
  //   ① 用 hasOwnProperty 取路由 —— 原来 `handlers[action]` 会把原型链上的属性当接口：
  //      action='constructor' 原样回显 payload（返回体没有 code/data）、'__proto__'/'valueOf' 直接 500；
  //   ② 身份必填 —— 云开发上下文里 ctx.openid 一定有值；缺失时（非小程序来源/异常）
  //      必须明确拒绝，否则 `orderCreate` 会写出 `_openid: undefined` 的订单、
  //      `cartRemoveAll` 会执行 `removeWhere('cart', {_openid: undefined})`；
  //   ③ 异常不再把内部细节回显给客户端（原来 'goodsJson is not iterable' 这类实现细节
  //      会直接出现在顾客看到的提示里），细节只进日志。
  const fn = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null
  if (typeof fn !== 'function') return fail('未知的接口：' + action, 404)
  if (!ctx || !ctx.openid) return fail('身份缺失，请重新进入小程序', 401)
  try {
    return await fn(payload || {}, ctx)
  } catch (e) {
    console.error('[dispatch] action=' + action + ' openid=' + (ctx && ctx.openid) +
      ' 异常：' + (e && e.stack ? e.stack : e))
    return fail('服务异常，请稍后重试', 500)
  }
}

module.exports = {
  dispatch,
  handlers,
  // 数据自检 + 一键导入种子数据：故意不放进 handlers 路由表（见路由表处注释），
  // 只暴露给「云控制台云端测试」与本地测试脚本使用。
  importData,
  // 导出内部函数便于测试
  calcPrice,
  makeCartKey,
  getDelta,
  // 阶段 9：渠道差价 / 打包费 / 最少购买（导出便于测试直接断言边界）
  packingFeeOf,
  minBuyNumberOf,
  channelOf,
  // 2026-10-14 审查整改：导出便于测试直接断言（配送方式严格化 / 期望时间 / 单号日期段）
  resolveDeliveryMode,
  parseExpectTime,
  orderNoDatePart,
  // 阶段二安全修复相关
  MAX_ITEM_NUMBER,
  normalizeOrderNumber,
  resolveOrderSku,
  isAdmin,
  // 阶段 10：店主端入参校验（导出便于测试直接断言边界，不必绕过 action 层）
  normalizeSpecGroups,
  normalizePicUrl,
  normalizeTiersForSave,
  normalizeKeywordList,
  goodsAdminView,
  // 阶段 4.1 状态机：供 cloudfunctions/api/index.js（支付回调）复用同一份文案
  ORDER_STATUS,
  statusTextOf,
  // 阶段 4.2 超时未支付自动取消：故意不放进 handlers 路由表
  // （前端不可调用；只由云函数定时触发器或本地测试直接调用）
  cancelExpiredOrders,
  // 2026-10-12：读取兜底取消与超时时间读取器，同样不放进路由表，仅供测试/内部调用
  expireUnpaidForViewer,
  orderTimeoutMs,
  // 阶段 11：优惠券纯函数/校验器（导出便于测试直接断言边界，不必绕过 action 层）
  parseCouponId,
  normalizeCouponTime,
  couponStatusOf,
  couponRuleText,
  couponViewOf,
  effectivePerUserLimitOf,
  COUPON_TYPES: { NEW: COUPON_TYPE_NEW, THRESHOLD: COUPON_TYPE_THRESHOLD },
  // 上线收尾 P0-1/P0-3（2026-10-19）：支付与"取消退券"内部函数导出，便于
  //   index.js 支付回调复用、本地测试直接断言（不进路由表，前端调不到）
  payConfigOf,
  payConfigured,
  payCallbackCore,
  orderPayConfirm,
  orderMarkPaid,
  markOrderPaid,
  updateWhere,
  cancelPendingOrder
}
