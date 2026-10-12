/**
 * 待支付订单「自动取消」倒计时（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 背景：店主反馈"待支付账单会一直存在"。云函数里本来就有超时取消
 *      （cloudfunctions/api/handlers.js 的 cancelExpiredOrders），但它只由定时
 *      触发器驱动；触发器要在云开发控制台里真正建出来才生效，否则订单会一直挂着。
 *
 * 现在的做法（两端配合）：
 *   1) 服务端：orderList / orderDetail 读取时先做一次兜底取消
 *      （expireUnpaidForViewer），并返回每个待支付订单的
 *      `autoCancelAt`（自动取消时刻）与 `serverNow`（服务端当前时间）。
 *   2) 前端：本文件只负责**纯计算与格式化**，页面每秒 tick 一次刷新文案，
 *      到点后重新拉一次列表/详情（服务端那时已把它置为「已取消」）。
 *
 * ⚠️ 两个关键约定：
 *   · 超时分钟数（当前 15 分钟）**不在前端硬编码**，只由服务端下发的
 *     autoCancelAt 决定 —— 改时间只需要改 cloudfunctions/api/shop-config.js
 *     的 orderTimeoutMinutes 并重新部署云函数。
 *   · 倒计时用「服务端时间」为基准：页面拿到响应时记录一次本机时钟与服务端时钟的
 *     偏移（clockOffsetOf），之后每秒用 `本机时间 - 偏移` 当服务端时间，
 *     顾客手机时钟不准也不会把倒计时算错。
 *
 * 本文件不依赖 wx.*，可以直接在 node 里跑（见 tests/test-order-countdown.js）。
 * ---------------------------------------------------------------------------
 */
const OS = require('./order-status')

/** 本机时钟相对服务端时钟的偏移（毫秒）：serverTime ≈ localNow - offset */
const MAX_REASONABLE_OFFSET_MS = 24 * 60 * 60 * 1000 // 超过 1 天的偏移视为异常，直接忽略

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/**
 * 由服务端响应算出本机相对服务端的时钟偏移
 * @param {number} serverNow 服务端返回的 serverNow（缺省/非法时返回 0 = 不校正）
 * @param {number} receivedAt 本机收到响应的时间（默认 Date.now()）
 * @returns {number} 偏移毫秒。异常值（非数字、超过 1 天）一律按 0 处理
 */
function clockOffsetOf(serverNow, receivedAt) {
  const s = Number(serverNow)
  if (!(s > 0)) return 0
  const local = Number(receivedAt)
  const offset = (local > 0 ? local : Date.now()) - s
  if (!isFinite(offset) || Math.abs(offset) > MAX_REASONABLE_OFFSET_MS) return 0
  return offset
}

/** 该订单是否处于「待支付且会超时自动取消」状态 */
function isPending(order) {
  return !!(
    order &&
    order.status === OS.STATUS.UNPAID &&
    Number(order.autoCancelAt) > 0
  )
}

/**
 * 剩余毫秒数（负数表示已到点，调用方可据此刷新）
 * @param {object} order 含 status / autoCancelAt
 * @param {number} offsetMs clockOffsetOf 的结果
 * @param {number} localNow 本机当前时间（默认 Date.now()）
 */
function remainMsOf(order, offsetMs, localNow) {
  if (!isPending(order)) return 0
  const offset = Number(offsetMs) || 0
  const serverTime = (Number(localNow) > 0 ? Number(localNow) : Date.now()) - offset
  return Number(order.autoCancelAt) - serverTime
}

/**
 * 把剩余毫秒格式化成 mm:ss（已到点 / 无有效值时返回 '00:00'）
 */
function formatRemain(ms) {
  const n = Number(ms)
  const total = Math.floor((isFinite(n) && n > 0 ? n : 0) / 1000)
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60)
}

/**
 * 单个订单的倒计时结果（页面 tick 时逐项调用）
 * @returns {{active:boolean, expired:boolean, remainMs:number, remainText:string}}
 *   active    是否需要显示倒计时（待支付 + 有 autoCancelAt）
 *   expired   是否已到点（active 且剩余 <= 0）
 *   remainMs  剩余毫秒（不小于 0）
 *   remainText 'mm:ss'
 */
function countdownOf(order, offsetMs, localNow) {
  if (!isPending(order)) {
    return { active: false, expired: false, remainMs: 0, remainText: '' }
  }
  const remainMs = remainMsOf(order, offsetMs, localNow)
  return {
    active: true,
    expired: remainMs <= 0,
    remainMs: Math.max(0, remainMs),
    remainText: formatRemain(remainMs)
  }
}

/**
 * 批量给订单列表补倒计时字段（不改原对象，返回新数组）
 * 页面把它直接 setData，WXML 里用 item.cancelRemainText。
 * @param {object[]} orderList
 * @param {number} offsetMs
 * @param {number} localNow
 * @returns {{list:object[], hasActive:boolean, hasExpired:boolean}}
 */
function patchList(orderList, offsetMs, localNow) {
  const list = orderList || []
  let hasActive = false
  let hasExpired = false
  const patched = list.map((o) => {
    const cd = countdownOf(o, offsetMs, localNow)
    if (cd.active) hasActive = true
    if (cd.expired) hasExpired = true
    return Object.assign({}, o, {
      cancelRemainText: cd.remainText,
      cancelActive: cd.active
    })
  })
  return { list: patched, hasActive, hasExpired }
}

module.exports = {
  clockOffsetOf,
  isPending,
  remainMsOf,
  formatRemain,
  countdownOf,
  patchList
}
