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
 */
function calcPrice(goods, sku) {
  let price = typeof goods.minPrice === 'number' ? goods.minPrice : 0
  if (!sku || !sku.length || !goods.properties) return price
  goods.properties.forEach((group) => {
    const picked = sku.find((s) => String(s.optionId) === String(group.id))
    if (!picked) return
    const opt = (group.childsCurGoods || []).find(
      (c) => String(c.id) === String(picked.optionValueId)
    )
    price += getDelta(opt)
  })
  return Math.round(price * 100) / 100
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
    stores: typeof g.stores === 'number' ? g.stores : 0,
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
      stores: typeof g.stores === 'number' ? g.stores : 0,
      purchaseNotes: g.purchaseNotes || '',
      // 改造：是否蛋糕，供前端配送规则（免配送费 / 提前3小时）判断
      isCake: isCakeGoods(g)
    },
    pics: g.pics || [],
    content: g.content || '',
    properties: g.properties || []
  })
}

// ===========================================================================
// 购物车
// ===========================================================================
function cartItemsOf(items, goodsMap) {
  // 组装前端需要的字段：key / goodsId / name / pic / price / number / sku
  return items.map((it) => {
    const g = goodsMap[it.goodsId]
    return {
      key: it.key,
      goodsId: it.goodsId,
      name: g ? g.name : '（商品已下架）',
      pic: g ? g.pic : '',
      price: it.price,
      number: it.number,
      sku: it.sku || []
    }
  })
}

async function cartSummary(ctx, openid) {
  const items = await ctx.db.find('cart', { _openid: openid }, {})
  const goodsIds = [...new Set(items.map((i) => i.goodsId))]
  const goodsMap = {}
  for (const gid of goodsIds) {
    const g = await ctx.db.get('goods', gid)
    if (g) goodsMap[gid] = g
  }
  const view = cartItemsOf(items, goodsMap)
  let price = 0
  let number = 0
  view.forEach((v) => {
    price += v.price * v.number
    number += v.number
  })
  return ok({
    items: view,
    price: Math.round(price * 100) / 100,
    number
  })
}

async function cartInfo(payload, ctx) {
  return cartSummary(ctx, ctx.openid)
}

/**
 * 加入购物车
 * 前端用法：shippingCarInfoAddItemV2({ goodsId, number, sku })
 * 注意：同名同规格会累加数量，而不是新增一行
 */
async function cartAdd(payload, ctx) {
  const { goodsId, number = 1, sku = [] } = payload || {}
  if (!goodsId) return fail('缺少商品 id')

  const goods = await ctx.db.get('goods', goodsId)
  if (!goods) return fail('商品不存在')
  if (goods.stores <= 0) return fail('已售罄')

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

  const existing = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (existing) {
    const nextNumber = existing.number + number
    if (nextNumber > goods.stores) return fail('库存不足')
    await ctx.db.update('cart', existing._id, { number: nextNumber })
  } else {
    if (number > goods.stores) return fail('库存不足')
    await ctx.db.add('cart', {
      _openid: ctx.openid,
      key,
      goodsId,
      price,
      number,
      sku,
      dateAdd: Date.now()
    })
  }
  return cartSummary(ctx, ctx.openid)
}

async function cartModifyNumber(payload, ctx) {
  const { key, number } = payload || {}
  if (!key) return fail('缺少购物车项 key')
  const item = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (!item) return fail('购物车项不存在')
  if (number <= 0) {
    await ctx.db.remove('cart', item._id)
    return cartSummary(ctx, ctx.openid)
  }
  const goods = await ctx.db.get('goods', item.goodsId)
  if (goods && number > goods.stores) return fail('库存不足')
  await ctx.db.update('cart', item._id, { number })
  return cartSummary(ctx, ctx.openid)
}

async function cartRemoveItem(payload, ctx) {
  const { key } = payload || {}
  if (!key) return fail('缺少购物车项 key')
  const item = await ctx.db.findOne('cart', { _openid: ctx.openid, key })
  if (item) await ctx.db.remove('cart', item._id)
  return cartSummary(ctx, ctx.openid)
}

async function cartRemoveAll(payload, ctx) {
  await ctx.db.removeWhere('cart', { _openid: ctx.openid })
  return cartSummary(ctx, ctx.openid)
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
 *   order_hx_uids     商家核销白名单 openid，pages/my 据此决定是否显示"扫码核销"
 *
 * 数据来源优先级：
 *   1) 云数据库 app_config 集合（key/value 结构）
 *   2) 本地配置兜底（shop-config.js：门店名；adminOpenids：核销白名单）
 *
 * 返回结构与 api 工厂 一致：res.code === 0 时 res.data 为 [{ key, value }]
 */
async function appConfig(payload, ctx) {
  const SHOP = require('./shop-config')
  const defaults = {
    mallName: (SHOP.shop && SHOP.shop.name) || '卿欢蛋糕',
    // 下单备注快捷短语：当前为空（业务方第一版不提供，保留用户手动输入备注）。
    // 补充方式：改 cloudfunctions/api/shop-config.js 的 orderRemarkMsg，或写 app_config 集合覆盖。
    order_remark_msg: SHOP.orderRemarkMsg || '',
    // 商家核销白名单：当前为空（待管理员账号确定后填入 shop-config.js 的 adminOpenids）。
    // 留空时 pages/my 的「扫码核销」入口不显示。
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
 *   2) 扣减库存
 *   3) 生成核销码 hxNumber
 *   4) 清空购物车
 */
async function orderCreate(payload, ctx) {
  const {
    goodsJsonStr,
    remark = '',
    extJsonStr,
    isCanHx = true,
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

  for (const row of goodsJson) {
    const goods = await ctx.db.get('goods', row.goodsId)
    if (!goods) return fail('商品不存在：' + row.goodsId)
    if (goods.stores < row.number) return fail(goods.name + ' 库存不足')

    // 解析 propertyChildIds："optionId:optionValueId,optionId:optionValueId"
    const sku = []
    if (row.propertyChildIds) {
      String(row.propertyChildIds).split(',').forEach((pair) => {
        const [optionId, optionValueId] = pair.split(':')
        if (optionId && optionValueId) sku.push({ optionId, optionValueId })
      })
    }

    const price = calcPrice(goods, sku)
    items.push({
      goodsId: row.goodsId,
      goodsName: goods.name,
      pic: goods.pic,
      price,
      number: row.number,
      amount: Math.round(price * row.number * 100) / 100,
      sku,
      // 商品快照：仅供配送规则计算（蛋糕识别、尺寸解析）使用，不写入订单
      _goodsForQuote: {
        isCake: goods.isCake,
        properties: goods.properties || []
      },
      property: sku
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
  const deliveryMode = payload.deliveryMode === 'delivery' ? 'delivery' : 'pickup'
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
    // 用与前端完全相同的规则计算（delivery-calc.js 是 config/delivery.js 的副本）
    quote = delivery.calcQuote({
      address,
      goodsAmount: amount,
      items: items.map((it) => ({ goods: it._goodsForQuote || it, sku: it.sku }))
    })
    if (!quote.deliverable) {
      return fail(quote.freightText || '超出配送范围')
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

  const totalAmount = Math.round((amount + freight) * 100) / 100

  // 扣库存
  for (const it of items) {
    const goods = await ctx.db.get('goods', it.goodsId)
    await ctx.db.update('goods', goods._id, { stores: goods.stores - it.number })
  }

  const now = Date.now()
  const orderNo =
    String(now) + String(Math.floor(Math.random() * 9000) + 1000)

  const order = {
    _openid: ctx.openid,
    orderNumber: orderNo,
    dateAdd: now,
    status: 0, // 0 待支付
    statusStr: '待支付',
    // amountReal = 商品金额 + 配送费（服务端重算后的最终应付金额）
    amountReal: totalAmount,
    goodsAmount: amount,
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
    isCanHx,
    hxNumber: isCanHx ? orderNo : '',
    shopIdZt: shopIdZt || '',
    shopNameZt: shopNameZt || ''
  }

  const res = await ctx.db.add('order', order)

  // 清空购物车
  await ctx.db.removeWhere('cart', { _openid: ctx.openid })

  return ok({
    id: res._id,
    orderNumber: orderNo,
    amountReal: totalAmount,
    goodsAmount: amount,
    freight: freight,
    freightText: quote ? quote.freightText : '免配送费',
    distanceKm: quote ? quote.distanceKm : null,
    hxNumber: order.hxNumber,
    status: order.status
  })
}

async function orderList(payload, ctx) {
  const { statusBatch } = payload || {}
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
  return ok({
    orderList: list.map((o) => ({
      id: o._id,
      orderNumber: o.orderNumber,
      dateAdd: o.dateAdd,
      status: o.status,
      statusStr: o.statusStr,
      amountReal: o.amountReal,
      goodsNumber: o.goodsNumber,
      shopIdZt: o.shopIdZt,
      shopNameZt: o.shopNameZt
    })),
    goodsMap,
    logisticsMap: {}
  })
}

async function orderDetail(payload, ctx) {
  const id = payload && payload.id
  if (!id) return fail('缺少订单 id')
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权查看该订单')
  return ok({
    orderInfo: {
      id: o._id,
      orderNumber: o.orderNumber,
      dateAdd: o.dateAdd,
      status: o.status,
      statusStr: o.statusStr,
      amountReal: o.amountReal,
      goodsNumber: o.goodsNumber,
      remark: o.remark,
      hxNumber: o.hxNumber,
      shopIdZt: o.shopIdZt,
      shopNameZt: o.shopNameZt
    },
    goods: o.goods || [],
    extJson: o.extJson || {},
    user: { avatarUrl: '', nick: '' }
  })
}

async function orderClose(payload, ctx) {
  const id = payload && payload.id
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权操作该订单')
  if (o.status !== 0) return fail('当前状态不可取消')
  await ctx.db.update('order', o._id, { status: -1, statusStr: '已取消' })
  // 回补库存
  for (const it of o.goods || []) {
    const goods = await ctx.db.get('goods', it.goodsId)
    if (goods) await ctx.db.update('goods', goods._id, { stores: goods.stores + it.number })
  }
  return ok({ id })
}

async function orderDelete(payload, ctx) {
  const id = payload && payload.id
  const o = await ctx.db.get('order', id)
  if (!o) return fail('订单不存在')
  if (o._openid !== ctx.openid) return fail('无权操作该订单')
  await ctx.db.remove('order', o._id)
  return ok({ id })
}

/**
 * 核销（商家扫码核销订单）
 */
async function orderHx(payload, ctx) {
  const hxNumber = payload && payload.hxNumber
  if (!hxNumber) return fail('缺少核销码')
  const o = await ctx.db.findOne('order', { hxNumber })
  if (!o) return fail('核销码无效')
  if (o.status === 3) return fail('该订单已核销')
  await ctx.db.update('order', o._id, { status: 3, statusStr: '交易成功' })
  return ok({ id: o._id, orderNumber: o.orderNumber })
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

  const BANNERS = [
    { _id: 'b1', picUrl: '/images/logo@2x.png', link: '', sort: 10, enabled: true },
    { _id: 'b2', picUrl: '/images/rectangle@2x.png', link: '', sort: 20, enabled: true }
  ]

  const APP_CONFIG = [
    { key: 'mallName', value: '卿欢蛋糕' },
    { key: 'order_remark_msg', value: '' },
    { key: 'order_hx_uids', value: '' }
  ]

  const GOODS = [
    {
      _id: 'g_musi_fruit', categoryId: 'cat_fruit_cake', name: '慕斯围边水果小蛋糕',
      pic: '/images/logo@2x.png', pics: [{ pic: '/images/logo@2x.png' }],
      characteristic: '动物奶油 / 新鲜水果 / 约400克',
      content: '<p>当季新鲜水果，动物奶油制作，当日现做现卖。</p>',
      minPrice: 54, unit: '个', stores: 20,
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
      minPrice: 88, unit: '个', stores: 30,
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
      minPrice: 78, unit: '个', stores: 12,
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
      minPrice: 98, unit: '个', stores: 8,
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
      minPrice: 8, unit: '套', stores: 100,
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
  // 数据自检 + 一键导入种子数据（初始化用）
  importData,
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
  orderHx,
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
  // 导出内部函数便于测试
  calcPrice,
  makeCartKey,
  getDelta
}
