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
 *
 * 2026-10-14 阶段 10 补充：
 *   · getMyOpenid()          —— 店主配置白名单要用原始 openid（仅开发版入口暴露）
 *   · guardShopAdminPage()   —— 店主端页面的统一闸门（非店主提示后返回）
 * 真正的权限判定仍然只有一个出处：云函数侧 requireAdmin(ctx)。
 * ---------------------------------------------------------------------------
 */
const API = require('./api-map')
// 阶段 5.7：日志统一收敛到 utils/log.js
const LOG = require('./log')

/**
 * 确保「店主白名单」已经从云端取回并写进 storage。
 * ---------------------------------------------------------------------------
 * 为什么需要它（2026-10-14 阶段 10 复核发现）：app.js 在启动时调 appConfig 把
 * `order_hx_uids` 写进 storage，而「我的」页可能在它**返回之前**就判断身份 ——
 * 于是刚配好白名单的店主第一次进来会看不到「店主中心」入口（要切走再切回）。
 * 这里在"storage 里还没有白名单"时补一次 appConfig，拿到就写回 storage
 * （之后所有判断都是纯本地读，不再多发请求）。
 * @returns {Promise<boolean>} storage 里现在有没有白名单
 */
async function ensureWhitelist() {
  try {
    if (wx.getStorageSync('order_hx_uids')) return true
  } catch (e) {
    LOG.error('[ensureWhitelist] 读 storage 失败', e)
    return false
  }
  try {
    const res = await API.appConfig()
    const rows = res && res.code == 0 && Array.isArray(res.data) ? res.data : []
    const row = rows.filter((x) => x && x.key === 'order_hx_uids')[0]
    if (row && row.value !== undefined && row.value !== null) {
      wx.setStorageSync('order_hx_uids', row.value)
      return true
    }
  } catch (e) {
    LOG.error('[ensureWhitelist] 拉取白名单失败，按未配置处理', e)
  }
  return false
}

/**
 * 判断某个 openid 是否在店主白名单里（**纯本地判断，不发网络请求**）
 * 用途：页面已经拿到当前用户 openid 时（如「我的」页的 userDetail），
 *      不必为了判断身份再多调一次云函数。
 * @param {string} openid
 * @returns {boolean}
 */
function isAdminOpenid(openid) {
  if (!openid) return false
  let uids = ''
  try {
    uids = wx.getStorageSync('order_hx_uids')
  } catch (e) {
    LOG.error('[isAdminOpenid] 读取白名单失败，按非店主处理', e)
    return false
  }
  if (!uids) return false
  return String(uids)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => !!s)
    .indexOf(String(openid)) >= 0
}

/**
 * 当前用户是否在店主白名单里
 * @returns {Promise<boolean>} 任何一步失败都返回 false（宁可不显示按钮）
 */
async function isShopAdmin() {
  try {
    const res = await API.userDetail()
    if (!res || res.code != 0 || !res.data || !res.data.base) return false
    // 白名单还没到手时补一次（只会在"启动竞态/首次配置"时发生）
    if (!isAdminOpenid(res.data.base.id)) await ensureWhitelist()
    return isAdminOpenid(res.data.base.id)
  } catch (e) {
    LOG.error('[isShopAdmin] 判断失败，按非店主处理', e)
    return false
  }
}

/**
 * 取当前用户的**原始 openid**（仅供店主配置白名单用，不要在顾客界面展示）
 * ---------------------------------------------------------------------------
 * 为什么需要它（阶段 10）：启用店主端的第一步是把店主的 openid 填进
 * `cloudfunctions/api/shop-config.js` 的 adminOpenids —— 没有它，店主自己
 * 也进不了店主端（先有鸡还是先有蛋）。原来只能去云开发控制台的 user 集合里翻，
 * 手机上做不到；现在「我的」页在**开发版 / 体验版**给一个"复制我的 openid"入口
 * （正式版不显示，见 pages/my 的 isDevEnv 判定）。
 * 顾客界面一律用 utils/format.js 的 shortUserNo()（不可反推的短编号）。
 * @returns {Promise<string>} 失败返回空串（宁可不显示，也不抛异常打断页面）
 */
async function getMyOpenid() {
  try {
    const res = await API.userDetail()
    if (!res || res.code != 0 || !res.data || !res.data.base) return ''
    return String(res.data.base.id || '')
  } catch (e) {
    LOG.error('[getMyOpenid] 读取失败', e)
    return ''
  }
}

/**
 * 店主端页面的统一闸门：非店主 → 提示并返回上一页。
 * ⚠️ 这**只是体验层**（避免顾客误点进来看到一屏空白或半截数据）；
 *    真正的鉴权在云函数的 requireAdmin(ctx) —— 伪造入口也调不通接口。
 * @returns {Promise<boolean>} 是否放行
 */
async function guardShopAdminPage() {
  const allowed = await isShopAdmin()
  if (allowed) return true
  try {
    wx.showToast({ title: '无店主权限', icon: 'none' })
  } catch (e) {
    LOG.error('[guardShopAdminPage] 提示失败', e)
  }
  setTimeout(() => {
    try {
      wx.navigateBack()
    } catch (e) {
      LOG.error('[guardShopAdminPage] 返回失败', e)
    }
  }, 600)
  return false
}

module.exports = {
  isShopAdmin,
  isAdminOpenid,
  ensureWhitelist,
  getMyOpenid,
  guardShopAdminPage
}
