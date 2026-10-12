/**
 * 时间格式化工具（仅用于前端展示层）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-10 修复）：
 *   云函数 cloudfunctions/api/handlers.js 里订单的 dateAdd 存的是
 *   Date.now() 毫秒时间戳（例如 1791623892357）。页面原来把它直接丢给
 *   WXML 渲染：<view>下单时间：{{item.dateAdd}}</view>，
 *   顾客看到的就是一串 13 位数字，会误以为「下单时间和现实时间对不上」。
 *   实际上时间本身完全正确，缺的只是格式化。
 *
 * 约定：
 *   1. 云库 / 云函数始终保存原始时间戳（便于排序、比较、计算）；
 *   2. 只在页面渲染前格式化，不要在写库时存格式化字符串；
 *   3. 本模块不依赖 wx API，也不依赖第三方库，可直接在 Node 下单测。
 * ---------------------------------------------------------------------------
 */

function pad2(n) {
  return n < 10 ? '0' + String(n) : String(n)
}

/**
 * 把各种形态的时间转成 Date，无法识别时返回 null。
 * 支持：Date / 毫秒时间戳(13 位) / 秒时间戳(10 位) / 纯数字字符串 /
 *      'YYYY-MM-DD HH:mm(:ss)' / ISO 8601 字符串。
 * @param {Date|number|string} input
 * @returns {Date|null}
 */
function toDate(input) {
  if (input === undefined || input === null || input === '') return null
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input

  // 数字或纯数字字符串 → 按时间戳处理
  if (typeof input === 'number' || /^\d+$/.test(String(input).trim())) {
    const n = Number(input)
    if (!isFinite(n) || n <= 0) return null
    // 10 位按「秒」处理，13 位按「毫秒」处理
    const ms = n < 1e11 ? n * 1000 : n
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }

  // 字符串：iOS 不认 'YYYY-MM-DD HH:mm:ss'，横杠统一换成斜杠
  const text = String(input).trim()
  const d = text.indexOf('T') >= 0
    ? new Date(text) // ISO 8601，交给原生解析
    : new Date(text.replace(/-/g, '/'))
  return isNaN(d.getTime()) ? null : d
}

/**
 * 时间戳 → 'YYYY-MM-DD HH:mm'（可选到秒）
 * @param {Date|number|string} input
 * @param {{withSeconds?: boolean, placeholder?: string}} [opts]
 * @returns {string} 无法识别时返回 placeholder（默认空字符串）
 */
function formatDateTime(input, opts) {
  const options = opts || {}
  const placeholder = options.placeholder === undefined ? '' : options.placeholder
  const d = toDate(input)
  if (!d) return placeholder
  let text = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  if (options.withSeconds) text += ':' + pad2(d.getSeconds())
  return text
}

/**
 * 时间戳 → 'YYYY-MM-DD'
 * @param {Date|number|string} input
 * @param {{placeholder?: string}} [opts]
 * @returns {string}
 */
function formatDate(input, opts) {
  const options = opts || {}
  const placeholder = options.placeholder === undefined ? '' : options.placeholder
  const d = toDate(input)
  if (!d) return placeholder
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/**
 * 由 openid 生成一个**可展示的短用户编号**（阶段 5.5 / 报告 P-12）
 * ---------------------------------------------------------------------------
 * 背景：「我的」页原来把 userInfo.id（= 微信 OPENID）直接显示出来
 *       —— 既是敏感标识，对顾客也毫无意义。
 * 做法：对 openid 做一次稳定哈希（djb2），取 6 位 36 进制大写，前面加 QH。
 *       同一个 openid 永远得到同一个编号（可用来人工核对），但无法反推 openid。
 *       纯函数、不依赖 wx，可在 Node 下单测。
 * @param {string} id openid
 * @returns {string} 形如 'QH1A2B3C'；入参为空时返回 ''
 */
function shortUserNo(id) {
  const text = String(id || '')
  if (!text) return ''
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    // 与 (h * 33) 等价的移位写法，>>> 0 保证 32 位无符号
    h = ((h << 5) + h) ^ text.charCodeAt(i)
    h = h >>> 0
  }
  let s = h.toString(36).toUpperCase()
  while (s.length < 6) s = '0' + s
  return 'QH' + s.slice(-6)
}

module.exports = {
  toDate,
  formatDate,
  formatDateTime,
  shortUserNo
}
