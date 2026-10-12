/**
 * 店主身份判断（仅用于「按钮显不显示」）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-10）：
 *   扫码核销下线后，店主改为在订单列表里点「完成订单」。
 *   这个按钮只应给店主看，判断依据是 app.js 启动时写入 storage 的
 *   order_hx_uids（云函数 appConfig 返回的店主 openid 白名单，逗号分隔）。
 *
 * ⚠️ 这是**展示判断，不是鉴权**：storage 可被用户篡改，把按钮点出来也没用 ——
 *    云函数 orderFinish 会用 ctx.openid 在服务端重新校验白名单（requireAdmin）。
 * ---------------------------------------------------------------------------
 */
const API = require('./api-map')
// 阶段 5.7：日志统一收敛到 utils/log.js
const LOG = require('./log')

/**
 * 当前用户是否在店主白名单里
 * @returns {Promise<boolean>} 任何一步失败都返回 false（宁可不显示按钮）
 */
async function isShopAdmin() {
  try {
    const res = await API.userDetail()
    if (!res || res.code != 0 || !res.data || !res.data.base) return false
    const openid = res.data.base.id
    const uids = wx.getStorageSync('order_hx_uids')
    if (!openid || !uids) return false
    return String(uids)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => !!s)
      .indexOf(String(openid)) >= 0
  } catch (e) {
    LOG.error('[isShopAdmin] 判断失败，按非店主处理', e)
    return false
  }
}

module.exports = {
  isShopAdmin
}
