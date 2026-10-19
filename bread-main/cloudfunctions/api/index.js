/**
 * 云函数入口：api
 * ---------------------------------------------------------------------------
 * 为什么只做一个云函数（而不是分类/商品/购物车/订单各一个）：
 *   本项目前端原本就是通过 apifm-wxapi 的「一个 SDK 调多个接口」模式工作的，
 *   改成「一个云函数 + action 路由」可以让前端调用形式最接近原样，改动最小。
 *
 * 部署方式：微信开发者工具 → 云开发 → 云函数 → 新建 api → 上传本目录。
 *
 * 调用方式（前端）：
 *   wx.cloud.callFunction({
 *     name: 'api',
 *     data: { action: 'goodsList', payload: { categoryId: 'xxx' } }
 *   })
 *
 * 本文件依赖 wx-server-sdk（云端自带），不要在本地 node 直接运行它。
 * 业务逻辑都在 handlers.js，那里不依赖 wx-server-sdk，可本地测试。
 * ---------------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk')
const { dispatch, cancelExpiredOrders, payCallbackCore } = require('./handlers')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 把云开发数据库包装成 handlers.js 期望的接口
 * 统一把 _id 记为 id 之外的 _id 字段，保持返回值一致。
 */
const dbAdapter = {
  async find(collection, where, opts = {}) {
    let q = db.collection(collection).where(where || {})
    if (opts.sort) {
      q = q.orderBy(opts.field || 'sort', opts.sort > 0 ? 'asc' : 'desc')
    }
    // 云开发单次最多 100 条，这里翻页取全
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
  },

  async findOne(collection, where) {
    const res = await db.collection(collection).where(where).limit(1).get()
    return res.data[0] || null
  },

  async get(collection, id) {
    if (id === undefined || id === null || id === '') return null
    try {
      const res = await db.collection(collection).doc(String(id)).get()
      return res.data || null
    } catch (e) {
      // doc(id) 查不到会抛错，回退为按字段查（支持自定义数字 id 的场景）
      const res = await db.collection(collection).where({ id }).limit(1).get()
      return res.data[0] || null
    }
  },

  async add(collection, data) {
    const res = await db.collection(collection).add({ data })
    return Object.assign({ _id: res._id }, data)
  },

  async update(collection, id, data) {
    await db.collection(collection).doc(String(id)).update({ data })
    return { _id: id, ...data }
  },

  /**
   * 条件更新（2026-10-19 上线收尾新增，见 handlers.js 的 updateWhere）
   * ---------------------------------------------------------------------------
   * 为什么必须有它：订单状态流转（支付回调 0→1、超时取消 0→-1、完成 1→3）
   * 用"先读后写"在并发下会互相覆盖（最危险：已支付却被超时取消）。
   * `where({ _id, status: 期望值 }).update()` 由数据库端判断条件，
   * 只有真正改到行才返回 updated=1 —— 天然幂等、不会覆盖别人刚写的状态。
   * @returns {Promise<{updated:number}>}
   */
  async updateWhere(collection, where, data) {
    const res = await db.collection(collection).where(where || {}).update({ data })
    const updated = (res && res.stats && res.stats.updated) || 0
    return { updated }
  },

  async remove(collection, id) {
    const res = await db.collection(collection).doc(String(id)).remove()
    // 2026-10-19（P0-3）：把"真正删掉几行"返回给 handlers，
    // 作为老订单（取消时还没退券）删除前补退优惠券的幂等闸门。
    const removed = (res && res.stats && res.stats.removed) || 0
    return { _id: id, removed }
  },

  async removeWhere(collection, where) {
    // 云开发不支持条件删除，需先查出再逐条删
    const docs = await this.find(collection, where, {})
    for (const d of docs) {
      await db.collection(collection).doc(d._id).remove()
    }
    return { removed: docs.length }
  },

  /**
   * 原子自增一个数字字段（并发安全）
   * ---------------------------------------------------------------------------
   * 2026-10-14 新增（backlog：并发/幂等）。
   * 为什么必须有它：`cartAdd` 原来是"先 findOne 读出旧数量 → 再 update 覆盖写"，
   *   两次操作之间没有原子性 —— 并发加购（双击、弱网重试、多端）会**丢数量**：
   *   两个请求都读到 3，各自算成 4 写回，最终只有 4（正确应为 5）。
   * 云开发的 `db.command.inc` 是数据库端的原子操作，读改写一次完成，不存在这个窗口。
   *
   * @param {string} collection 集合名
   * @param {object} where 等值条件（如 { _id, _openid }，防越权改到别人的行）
   * @param {string} field 要自增的字段（number）
   * @param {number} delta 增量（必须是非 0 的有限数；负数即自减）
   * @param {object} [opts] { min, max }：**自增之后**必须落在 [min, max] 内。
   *        不满足时条件不匹配 → 一条都不改（数据库端判断，不是先读后判）。
   * @returns {Promise<{updated:number}>} updated=1 表示改到了；0 = 条件不满足/行不存在
   */
  async incField(collection, where, field, delta, opts = {}) {
    const _ = db.command
    const cond = Object.assign({}, where)
    // 边界换算成"自增前"的值域：inc 后 ≤ max  ⇔  当前 ≤ max - delta
    const lo = opts.min === undefined ? null : opts.min - delta
    const hi = opts.max === undefined ? null : opts.max - delta
    if (lo !== null && hi !== null) cond[field] = _.gte(lo).and(_.lte(hi))
    else if (lo !== null) cond[field] = _.gte(lo)
    else if (hi !== null) cond[field] = _.lte(hi)

    const res = await db.collection(collection).where(cond).update({
      data: { [field]: _.inc(delta) }
    })
    const updated =
      (res && res.stats && res.stats.updated) || (res && res.updated) || 0
    return { updated }
  }

  // 2026-10-09：库存概念整体删除（原 decStores / incStores 两个适配方法一并删除）。
  // 本店不记库存：下单只生成订单，不读写任何库存字段。
  // 2026-10-14：上面新增的 incField 与库存无关 —— 它服务的是**购物车数量累加**
  //             （并发不丢数量），见 handlers.js 的 cartAdd / incCartNumber。
}

// ===========================================================================
// 支付结果回调（上线收尾 P0-1，2026-10-19 重写）
// ---------------------------------------------------------------------------
// 云开发支付的支付结果会回调到本云函数（unifiedOrder 的 functionName）。
//
// 安全边界（与旧实现的区别）：
//   旧实现把 event 里的 outTradeNo / resultCode 直接当成"支付成功"就写库；
//   但客户端 `wx.cloud.callFunction({ data: { outTradeNo, resultCode: 'SUCCESS' } })`
//   的 data 会**原样**成为云函数 event —— 任何人都能伪造一份"支付成功"事件，
//   把自己的未付款订单改成已支付。旧实现因此被开关关闭（ENABLE_PAY_CALLBACK=false）。
//
//   现在：回调事件里的字段**只当线索**，真正的支付状态由 handlers.payCallbackCore
//   调 `cloud.cloudPay.queryOrder()` 向微信支付服务端查单确认，并校验金额、
//   用条件更新幂等推进订单状态。伪造的事件查单结果是 NOTPAY → 不改任何状态。
// ===========================================================================
const payAdapter = {
  async unifiedOrder(params) {
    return cloud.cloudPay.unifiedOrder(params)
  },
  async queryOrder(params) {
    return cloud.cloudPay.queryOrder(params)
  }
}

/**
 * 是否像"支付结果回调"事件：不带 action、带 outTradeNo 与 resultCode/returnCode。
 * 客户端调用永远带 action，因此不会误进这个分支；
 * 即使伪造的事件进来，也会因为查单不成功而不改状态（见上方安全边界）。
 */
function isPayCallbackEvent(event) {
  if (!event || event.Type === 'Timer' || event.action) return false
  if (!event.outTradeNo) return false
  return event.resultCode !== undefined || event.returnCode !== undefined
}

exports.main = async (event, context) => {
  // 定时触发器（阶段 4.2）：每 5 分钟清理超时未支付订单。
  // 触发器事件形如 { Type: 'Timer', TriggerName: 'orderTimeoutCancel', Time: ... }，
  // 不带 action，因此必须在 action 路由之前拦截。
  // 配置见同目录 config.json，超时分钟数见 shop-config.js 的 orderTimeoutMinutes。
  if (event && event.Type === 'Timer') {
    return cancelExpiredOrders({}, { db: dbAdapter, openid: '', appid: '' })
  }

  // 支付结果回调：由微信支付触发，不带 action，必须在 action 路由之前拦截。
  // 处理逻辑（查单验真 / 金额校验 / 幂等推进状态）在 handlers.payCallbackCore。
  if (isPayCallbackEvent(event)) {
    return payCallbackCore(event, { db: dbAdapter, pay: payAdapter })
  }

  const wxContext = cloud.getWXContext()
  const { action, payload } = event || {}

  const result = await dispatch(action, payload || {}, {
    db: dbAdapter,
    openid: wxContext.OPENID,
    appid: wxContext.APPID,
    // 支付能力注入：handlers.js 不依赖 wx-server-sdk，靠 ctx.pay 调用云开发支付
    pay: payAdapter
  })

  return result
}
