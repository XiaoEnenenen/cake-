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
const _ = db.command

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
}

/**
 * 支付回调（第 2 阶段接微信支付时启用）
 * cloud.cloudPay.unifiedOrder 的支付结果会回调到云函数，
 * 这里预留处理入口，避免将来找不到地方接。
 */
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
  // 支付回调分支：由微信支付触发，不带 action
  if (event && event.outTradeNo && event.resultCode) {
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
