/**
 * 店主身份判断（仅用于「按钮显不显示」）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-10）：
 *   扫码核销下线后，店主改为在订单列表里点「完成订单」。
 *   这个按钮只应给店主看。
 *
 * 2026-10-17 安全整改（顾客端审查 backlog）：
 *   原来云函数 appConfig 会下发**店主 openid 白名单**，
 *   等于把店主的 openid 发给了每一个顾客。现在改为：
 *   云函数按当前调用者的 ctx.openid 现场算一个布尔标记 `isAdmin`（'1' / '0'），
 *   前端只拿到这个标记（存 storage），拿不到任何人的 openid。
 *
 * ⚠️ 这仍然只是**展示判断，不是鉴权**：storage 可被用户篡改，把按钮点出来也没用 ——
 *    云函数每个店主 action 会用 ctx.openid 在服务端重新校验白名单（requireAdmin）。
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

// 云函数 appConfig 下发的店主标记（'1' = 店主，'0' = 非店主）
const ADMIN_FLAG_KEY = 'isAdmin'

/** storage 里是否已经拿到过店主标记（'1' 或 '0' 都算拿到） */
function hasAdminFlag() {
  try {
    const v = wx.getStorageSync(ADMIN_FLAG_KEY)
    return v === '1' || v === '0'
  } catch (e) {
    return false
  }
}

/**
 * 当前用户是不是店主（**纯本地读标记，不发网络请求**）
 * 用途：页面已经拿到用户资料时直接判断，不必为了一个按钮多调一次云函数。
 * @returns {boolean}
 */
function isAdminUser() {
  try {
    return wx.getStorageSync(ADMIN_FLAG_KEY) === '1'
  } catch (e) {
    LOG.error('[isAdminUser] 读取店主标记失败，按非店主处理', e)
    return false
  }
}

/**
 * 确保「店主标记」已经从云端取回并写进 storage。
 * ---------------------------------------------------------------------------
 * 为什么需要它（2026-10-14 阶段 10 复核发现）：app.js 在启动时调 appConfig 把
 * `isAdmin` 写进 storage，而「我的」页可能在它**返回之前**就判断身份 ——
 * 于是刚配好白名单的店主第一次进来会看不到「店主中心」入口（要切走再切回）。
 * 这里在"storage 里还没有标记"时补一次 appConfig，拿到就写回 storage
 * （之后所有判断都是纯本地读，不再多发请求）。
 * @returns {Promise<boolean>} storage 里现在有没有标记
 */
async function ensureAdminFlag() {
  if (hasAdminFlag()) return true
  try {
    const res = await API.appConfig()
    const rows = res && res.code == 0 && Array.isArray(res.data) ? res.data : []
    const row = rows.filter((x) => x && x.key === ADMIN_FLAG_KEY)[0]
    if (row && row.value !== undefined && row.value !== null && row.value !== '') {
      // 只认 '1'，其它一律按非店主处理（fail-closed）
      wx.setStorageSync(ADMIN_FLAG_KEY, String(row.value) === '1' ? '1' : '0')
      return true
    }
  } catch (e) {
    LOG.error('[ensureAdminFlag] 拉取店主标记失败，按非店主处理', e)
  }
  return false
}

/**
 * 当前用户是否店主
 * @returns {Promise<boolean>} 任何一步失败都返回 false（宁可不显示按钮）
 */
async function isShopAdmin() {
  try {
    if (!hasAdminFlag()) await ensureAdminFlag()
    return isAdminUser()
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
  ADMIN_FLAG_KEY,
  isShopAdmin,
  isAdminUser,
  ensureAdminFlag,
  getMyOpenid,
  guardShopAdminPage
}
