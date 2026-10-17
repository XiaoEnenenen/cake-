/**
 * 登录门禁（2026-10-17 第二轮顾客反馈）
 * ---------------------------------------------------------------------------
 * 顾客反馈：“我没登录怎么还能点餐？”——退出登录后仍能加购、进结算、下单。
 *
 * 为什么门禁必须放在前端：
 *   本项目的用户身份由微信云开发的 OPENID 自动提供（下单/购物车都挂在这个身份下），
 *   没有账号密码、也没有服务端 session。`storage.loggedOut === '1'` 是**本机展示状态**，
 *   云函数拿不到、也不该拿它做鉴权（换手机 / 清缓存后本来就不存在这个标志）。
 *   因此“退出登录后必须重新登录才能下单/支付”只能由前端在动作入口处拦截：
 *   弹登录弹层（含隐私勾选 + 手机号/微信登录），登录成功后再继续原来的动作。
 *
 * 使用方式（页面）：
 *   1) wxml 里挂 `<login-sheet id="login-sheet" bind:success="onLoginSuccess" />`；
 *   2) 动作入口：
 *        if (LOGIN_GATE.isLoggedOut()) {
 *          LOGIN_GATE.requireLogin(this, () => this.xxx())
 *          return
 *        }
 *   3) 页面方法：
 *        onLoginSuccess() { LOGIN_GATE.onLoginSuccess(this) }
 *
 * 覆盖的动作（2026-10-17）：
 *   · 商品详情「加入购物车」
 *   · 点单页「去结算」
 *   · 结算页「去支付 / 提交订单」
 *   · 订单列表「再次支付」
 * 浏览商品、打开商品详情、查看门店信息不受影响（这些不下单、不收集新信息）。
 * ---------------------------------------------------------------------------
 */
// 与 app.js / pages/my 使用同一个 storage 键（退出登录时写入 '1'）
const LOGGED_OUT_KEY = 'loggedOut'

/** 本机是否处于“已退出登录”状态（不是服务端鉴权，只是展示状态） */
function isLoggedOut() {
  try {
    return wx.getStorageSync(LOGGED_OUT_KEY) === '1'
  } catch (e) {
    return false
  }
}

/** 写本机退出标志（供退出登录处复用；目前由 pages/profile-edit 直接写） */
function markLoggedOut() {
  try {
    wx.setStorageSync(LOGGED_OUT_KEY, '1')
  } catch (e) {}
}

/** 清本机退出标志（登录成功后调用） */
function clearLoggedOut() {
  try {
    wx.removeStorageSync(LOGGED_OUT_KEY)
  } catch (e) {}
}

/**
 * 需要登录才能继续的动作入口。
 *
 * @param {object} page 页面实例（wxml 里挂了 <login-sheet id="login-sheet">）
 * @param {Function} action 已登录 / 登录成功后要执行的动作（用箭头函数绑定页面 this）
 * @returns {boolean} true = 本来就是登录状态，action 已执行；
 *                    false = 已弹出登录弹层，等登录成功后由 onLoginSuccess 继续
 */
function requireLogin(page, action) {
  if (!isLoggedOut()) {
    if (typeof action === 'function') action()
    return true
  }
  if (page) page._pendingAfterLogin = typeof action === 'function' ? action : null
  const sheet = page && typeof page.selectComponent === 'function'
    ? page.selectComponent('#login-sheet')
    : null
  if (sheet && typeof sheet.open === 'function') {
    sheet.open()
    return false
  }
  // 组件没挂上（页面结构被改坏）时不要静默放行，明确提示
  wx.showToast({ title: '请先登录再继续', icon: 'none' })
  return false
}

/**
 * 页面 `bind:success="onLoginSuccess"` 的统一实现：清退出标志 → 继续被拦截的动作。
 * @param {object} page 页面实例
 * @param {Function} [fallback] 没有待继续动作时的刷新动作（如重拉购物车）
 */
function onLoginSuccess(page, fallback) {
  clearLoggedOut()
  const pending = page && page._pendingAfterLogin
  if (page) page._pendingAfterLogin = null
  if (typeof pending === 'function') {
    pending()
    return
  }
  if (typeof fallback === 'function') fallback()
}

module.exports = {
  LOGGED_OUT_KEY,
  isLoggedOut,
  markLoggedOut,
  clearLoggedOut,
  requireLogin,
  onLoginSuccess
}
