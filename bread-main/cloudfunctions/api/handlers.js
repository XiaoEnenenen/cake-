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
    // 集合不存在 / 查询失败：回退代码默认值，不影响下单
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
 * 从请求体解析配送方式（阶段 9）。
 * 默认 'delivery' —— 即**不应用自取立减**：老客户端/未带该字段的调用方金额不变。
 */
function channelOf(payload) {
  return payload && payload.deliveryMode === 'pickup' ? 'pickup' : 'delivery'
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

/** 订单号的日期段：yyMMdd（例：2026-10-10 → '261010'） */
function orderNoDatePart(now) {
  const d = new Date(now)
  return pad(d.getFullYear() % 100, 2) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
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
  for (const group of groups) {
    const picked = sku.find((s) => String(s.optionId) === String(group.id))
    if (!picked) return { ok: false, msg: '请选择' + group.name }
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
 * 白名单来源：cloudfunctions/api/shop-config.js 的 adminOpenids（回退 app_config.order_hx_uids）。
 *
 * ⚠️ 为什么不读前端传来的身份：前端只是"要不要显示按钮"的展示开关
 *    （依赖本地 storage，可篡改），**不能作为鉴权依据**。
 *    真正的鉴权必须在这里用云函数自动注入的 ctx.openid 判断。
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
  const { categoryId, page = 1, pageSize = 1000 } = payload || {}
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

  // 规格必选校验：商品有规格组时，每组都必须选
  if (goods.properties && goods.properties.length) {
    for (const group of goods.properties) {
      const picked = (sku || []).find((s) => String(s.optionId) === String(group.id))
      if (!picked) return fail('请选择' + group.name)
      const exists = (group.childsCurGoods || []).some(
        (c) => String(c.id) === String(picked.optionValueId)
      )
      if (!exists) return fail(group.name + '选择有误')
    }
  }

  const key = makeCartKey(goodsId, sku)
  const price = calcPrice(goods, sku)

  // 阶段 9：最少购买份数（默认 1，只有 > 1 才拦）。按"累加后的总数"判断，
  // 避免"已经买够 2 份、再点一次 +1"这种正常操作被误拦。
  const minBuy = minBuyNumberOf(goods)
  const existing = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (existing) {
    // 2026-10-09：库存概念已删除，同规格加购直接累加
    // 2026-10-12：但累加后的总数必须仍在单次下单上限内，否则购物车会出现"永远下不了单"的行
    const total = (Number(existing.number) || 0) + addNumber
    if (total > MAX_ITEM_NUMBER) {
      return fail(goods.name + ' 单次最多购买 ' + MAX_ITEM_NUMBER + ' 件')
    }
    if (total < minBuy) {
      return fail(goods.name + ' 最少购买 ' + minBuy + ' 份')
    }
    await ctx.db.update('cart', existing._id, { number: total })
  } else {
    if (addNumber < minBuy) {
      return fail(goods.name + ' 最少购买 ' + minBuy + ' 份')
    }
    await ctx.db.add('cart', {
      _openid: ctx.openid,
      key,
      goodsId,
      price,
      number: addNumber,
      sku,
      dateAdd: Date.now()
    })
  }
  return cartSummary(ctx, ctx.openid, channelOf(payload))
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
 * 更新用户资料（昵称/头像/性别/生日/手机号）
 * 前端用法：modifyUserInfoV2({ token, nick, avatarUrl, ... })
 */
async function updateUser(payload, ctx) {
  const user = await ctx.db.findOne('user', { _openid: ctx.openid })
  const allow = ['nick', 'avatarUrl', 'sex', 'birthday', 'mobile']
  const patch = {}
  allow.forEach((k) => {
    if (payload && payload[k] !== undefined) patch[k] = payload[k]
  })
  if (!Object.keys(patch).length) return fail('没有需要更新的字段')

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
 * 对应原 api工厂 的 queryConfigBatch('mallName,order_remark_msg,order_hx_uids')。
 * 三个键的用途：
 *   mallName          店铺名（前台导航标题）
 *   order_remark_msg  下单备注快捷短语，pages/add-note 按 \n 拆分成列表
 *   order_hx_uids     店主 openid 白名单（键名沿用旧的核销配置，避免动云库数据），
 *                     前端据此决定「完成订单」按钮显不显示
 *
 * 数据来源优先级：
 *   1) 云数据库 app_config 集合（key/value 结构）
 *   2) 本地配置兜底（shop-config.js：门店名；adminOpenids：店主白名单）
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
    order_remark_msg: SHOP.orderRemarkMsg || '',
    // 店主白名单：当前为空（待管理员账号确定后填入 shop-config.js 的 adminOpenids）。
    // 留空时前端不显示「完成订单」按钮（服务端也会拒绝调用）。
    order_hx_uids: (SHOP.adminOpenids || []).join(',')
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
      // 集合不存在 / 查询失败：使用默认值，不影响主流程
    }
    data.push({ key, value: value === undefined ? '' : value })
  }

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
// 手机号绑定（微信支付接入前，先返回明确提示，不伪造成功）
// ===========================================================================
/**
 * 手机号绑定
 * 前端用法：components/bind-mobile → e.detail.code（getPhoneNumber 回调）
 *
 * 说明：云开发下需要用 cloud.getWXContext() + 微信开放接口用 code 换手机号，
 *       需要小程序后台开通「手机号快速验证」，属于第 2 阶段工作。
 *       在接入之前这里明确返回"未接入"，绝不伪造绑定成功。
 */
async function bindMobile(payload, ctx) {
  return fail('云开发模式下手机号绑定尚未接入（需先在小程序后台开通手机号快速验证）', 501)
}

// ===========================================================================
// 微信支付统一下单（第 2 阶段接入；当前明确返回未接入）
// ===========================================================================
/**
 * 微信支付统一下单
 * 前端用法：utils/pay.js → 期望 res.code === 0 且 res.data 含
 *          timeStamp / nonceStr / package / signType / paySign
 *
 * 说明：云开发下建议用 cloud.cloudPay.unifiedOrder()，需先申请微信支付商户号。
 *       在接入之前明确返回"未接入"，让页面提示"支付暂时不可用"，
 *       **绝不伪造支付成功**。
 */
async function wxpay(payload, ctx) {
  return fail('云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）', 501)
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
 * 创建订单
 * 前端用法：pages/pay/index.js → orderCreate(postData)
 * 关键点：
 *   1) 服务端重新算价，不信任前端传来的金额（防止改价）
 *   2) 服务端校验入参：数量（正整数、单行上限）、规格（每组必选 + 选项合法）、商品必须上架
 *      —— 2026-10-09 阶段二新增，见下方"阶段二安全修复"注释
 *   3) 同一请求内 goodsId + 规格 去重合并，再校验总数量上限（防止拆成多行绕过单行上限）
 *   4) 生成订单号（QH+日期+4位随机）并派生出取餐码，写入前查重
 *   5) 清空购物车
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

  let goodsJson = []
  try {
    goodsJson = JSON.parse(goodsJsonStr || '[]')
  } catch (e) {
    return fail('商品数据格式错误')
  }
  if (!goodsJson.length) return fail('购物车为空')

  let extJson = {}
  try {
    extJson = JSON.parse(extJsonStr || '{}')
  } catch (e) {
    extJson = {}
  }

  const items = []
  let amount = 0
  let goodsNumber = 0
  // 阶段 9：配送方式要在**算价之前**确定 —— 自提时单价要按「自取立减」算，
  // 与前端结算页（cartSummary 带同一个 deliveryMode）保持同一口径。
  const deliveryMode = payload.deliveryMode === 'delivery' ? 'delivery' : 'pickup'
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

  if (deliveryMode === 'delivery') {
    const address = payload.address || null
    if (!address) {
      return fail('外送订单缺少收货地址')
    }
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
  const totalAmount = Math.round((amount + packingFeeTotal + freight) * 100) / 100

  // 2026-10-09：库存概念整体删除。
  // 删除内容：原先在这里对每个商品做「原子条件扣减 stores + 失败回滚」，
  //          以及对应的 decStores / incStores 数据库适配方法。
  // 现在下单只生成订单，不再读写任何库存字段。

  const now = Date.now()

  // 订单号：QH + 年月日 + '-' + 4 位随机数字（例 QH261010-8342）
  const orderNo = await generateUniqueOrderField(ctx, 'orderNumber', ORDER_NO_TRIES, (i) =>
    ORDER_NO_PREFIX + orderNoDatePart(now) + '-' + pad((randomInt(10000) + i * RETRY_STEP) % 10000, 4)
  )
  if (!orderNo) return fail('订单号生成失败，请稍后重试')

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
    deliveryMode: deliveryMode,
    // 收货地址快照（仅外送订单）
    address: deliveryMode === 'delivery' ? (payload.address || null) : null,
    deliveryQuote: quote ? {
      distanceKm: quote.distanceKm,
      inArea: quote.inArea,
      reason: quote.reason,
      freightText: quote.freightText
    } : null,
    goodsNumber,
    remark,
    extJson,
    goods: items,
    // 取餐码：自提订单叫号用（= 订单号后 4 位）；外送订单不展示，但字段照样存
    pickupCode: pickupCode,
    shopIdZt: shopIdZt || '',
    shopNameZt: shopNameZt || ''
  }

  const res = await ctx.db.add('order', order)

  // 清空购物车
  await ctx.db.removeWhere('cart', { _openid: ctx.openid })

  return ok({
    id: res._id,
    orderNumber: orderNo,
    pickupCode: pickupCode,
    amountReal: totalAmount,
    goodsAmount: amount,
    // 阶段 9：打包费（前端结算页与实际金额对账用）
    packingFee: packingFeeTotal,
    freight: freight,
    freightText: quote ? quote.freightText : '免配送费',
    distanceKm: quote ? quote.distanceKm : null,
    status: order.status
  })
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
  const addressText = ext['收货地址'] ||
    (addr ? [addr.province, addr.city, addr.district, addr.detail].filter(Boolean).join('') : '')
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
    freight: o.freight,
    goodsNumber: o.goodsNumber,
    // ===== 接单要用的联系信息 =====
    contactName: ext['收货人'] || '',
    contactPhone: ext['收货电话'] || ext['联络电话'] || '',
    addressText,
    // 结构化地址（含经纬度）：店主端可直接「一键导航」
    address: addr,
    distanceText: ext['配送距离'] || '',
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
  if (p.statusBatch !== undefined && p.statusBatch !== null && String(p.statusBatch) !== '') {
    const allow = String(p.statusBatch)
      .split(',')
      .map((s) => Number(s.trim()))
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
  if (statusBatch) {
    const allow = String(statusBatch)
      .split(',')
      .map((s) => Number(s.trim()))
    list = all.filter((o) => allow.indexOf(o.status) >= 0)
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

async function orderClose(payload, ctx) {
  const id = payload && payload.id
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权操作该订单')
  if (o.status !== ORDER_STATUS.UNPAID) return fail('当前状态不可取消')
  await ctx.db.update('order', o._id, {
    status: ORDER_STATUS.CANCELLED,
    statusStr: statusTextOf(ORDER_STATUS.CANCELLED)
  })
  // 2026-10-09：库存概念已删除，取消订单不再回补库存
  return ok({ id })
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
  await ctx.db.remove('order', o._id)
  return ok({ id })
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
  await ctx.db.update('order', o._id, {
    status: ORDER_STATUS.DONE,
    statusStr: statusTextOf(ORDER_STATUS.DONE),
    finishBy: ctx.openid,
    finishTime: Date.now()
  })
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

  for (const o of expired) {
    await ctx.db.update('order', o._id, {
      status: ORDER_STATUS.CANCELLED,
      statusStr: statusTextOf(ORDER_STATUS.CANCELLED),
      // 审计：区分"顾客主动取消"（无 cancelReason）与"超时自动取消"
      cancelReason: 'timeout',
      cancelTime: now
    })
    console.log('[cancelExpiredOrders] 超时未支付自动取消 openid=' + o._openid +
      ' 订单号=' + o.orderNumber + ' 下单时间=' + o.dateAdd)
  }

  return { scanned: pending.length, cancelled: expired.length, minutes }
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
 * @returns {Promise<{code:number,data:{scanned:number,cancelled:number,timeoutMinutes:number}}>}
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
    timeoutMinutes: r.minutes
  })
}


// 2026-09-26 阶段二：已删除 orderPay（余额支付 / 标记已支付）action。
// 会员余额体系整体移除，不再需要"用余额支付"这条链路。
//
// ⚠️ 注意：删除后 cloudfunctions/api/index.js 的 handlePayCallback（微信支付回调）
//    暂无可写状态的入口。接入微信支付（第 2 阶段）时需在此处重新加回
//    一个"标记订单已支付"的 action，并让回调调用它。

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
  const APP_CONFIG = [
    { key: 'mallName', value: (require('./shop-config').shop || {}).name || '' },
    { key: 'order_remark_msg', value: '' },
    { key: 'order_hx_uids', value: '' }
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
  report.seed.goods = await seed('goods', GOODS, '_id')
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
  // 手机号绑定（当前返回"未接入"，不伪造成功）
  bindMobile,
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
  // 支付统一下单（当前返回"未接入"，不伪造支付成功）
  wxpay
}

/**
 * 统一入口
 * @param {string} action 动作名
 * @param {object} payload 参数
 * @param {object} ctx { db, openid }
 */
async function dispatch(action, payload, ctx) {
  const fn = handlers[action]
  if (!fn) return fail('未知的接口：' + action, 404)
  try {
    return await fn(payload, ctx)
  } catch (e) {
    return fail('服务异常：' + (e && e.message ? e.message : '未知错误'), 500)
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
  // 阶段二安全修复相关
  MAX_ITEM_NUMBER,
  normalizeOrderNumber,
  resolveOrderSku,
  isAdmin,
  // 阶段 4.1 状态机：供 cloudfunctions/api/index.js（支付回调）复用同一份文案
  ORDER_STATUS,
  statusTextOf,
  // 阶段 4.2 超时未支付自动取消：故意不放进 handlers 路由表
  // （前端不可调用；只由云函数定时触发器或本地测试直接调用）
  cancelExpiredOrders,
  // 2026-10-12：读取兜底取消与超时时间读取器，同样不放进路由表，仅供测试/内部调用
  expireUnpaidForViewer,
  orderTimeoutMs
}
