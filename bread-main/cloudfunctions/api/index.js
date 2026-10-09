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
const { dispatch } = require('./handlers')

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

  async remove(collection, id) {
    await db.collection(collection).doc(String(id)).remove()
    return { _id: id }
  },

  async removeWhere(collection, where) {
    // 云开发不支持条件删除，需先查出再逐条删
    const docs = await this.find(collection, where, {})
    for (const d of docs) {
      await db.collection(collection).doc(d._id).remove()
    }
    return { removed: docs.length }
  }

  // 2026-10-09：库存概念整体删除。
  // 删除内容：原先的 decStores（条件更新 + command.inc 原子扣减）与
  //          incStores（原子回补）两个适配方法，以及配套的 command 引用。
  // 本店不记库存：下单只生成订单，不再读写任何库存字段。
}

/**
 * 支付回调（第 2 阶段接微信支付时启用）
 * cloud.cloudPay.unifiedOrder 的支付结果会回调到云函数，
 * 这里预留处理入口，避免将来找不到地方接。
 *
 * ⚠️ 安全警告（2026-10-09 阶段二修复）
 *   以下分支原本是「无 action 且 event 带 outTradeNo/resultCode 就直接当成支付回调」。
 *   但客户端 wx.cloud.callFunction({ data: {...} }) 的 data 会**原样**成为云函数的 event，
 *   因此任何人都能构造 { outTradeNo: '<自己的订单号>', resultCode: 'SUCCESS' }
 *   把自己的未付款订单改成"已支付/制作中" —— 无签名、无来源校验、无金额校验。
 *   而当前项目**还没有任何 cloudPay.unifiedOrder 调用方**，这条分支唯一能被触发的途径就是伪造。
 *
 *   因此接入真实支付之前，本分支由 ENABLE_PAY_CALLBACK 开关关闭（默认 false）。
 *   将来接入时改成独立入口，并且必须做到：
 *     1) 验签（商户平台证书 / 云开发支付回调机制）
 *     2) 校验 totalFee 与订单 amountReal 一致
 *     3) 幂等（以 outTradeNo 为幂等键，且只允许 status 0 → 1）
 */
const ENABLE_PAY_CALLBACK = false

async function handlePayCallback(event) {
  const outTradeNo = event.outTradeNo
  const resultCode = event.resultCode
  if (resultCode !== 'SUCCESS') {
    return { errcode: 0, errmsg: 'ignored' }
  }
  const res = await db
    .collection('order')
    .where({ orderNumber: outTradeNo })
    .limit(1)
    .get()
  const order = res.data[0]
  if (order) {
    await db
      .collection('order')
      .doc(order._id)
      .update({ data: { status: 1, statusStr: '制作中', payTime: Date.now() } })
  }
  return { errcode: 0, errmsg: 'ok' }
}

exports.main = async (event, context) => {
  // 支付回调分支：由微信支付触发，不带 action。
  // 由 ENABLE_PAY_CALLBACK 开关保护（默认关闭），关闭时一律视为普通 action 调用，
  // 避免客户端伪造 { outTradeNo, resultCode } 把自己的订单改成"已支付"。详见上方安全警告。
  if (ENABLE_PAY_CALLBACK && event && event.outTradeNo && event.resultCode) {
    return handlePayCallback(event)
  }

  const wxContext = cloud.getWXContext()
  const { action, payload } = event || {}

  const result = await dispatch(action, payload || {}, {
    db: dbAdapter,
    openid: wxContext.OPENID,
    appid: wxContext.APPID
  })

  return result
}
