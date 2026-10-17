/**
 * 隐私授权（阶段 12，2026-10-17）
 * ---------------------------------------------------------------------------
 * 背景：小程序收集/使用用户信息（微信昵称头像、手填手机号、收货地址、
 * 位置用于算配送距离/导航）时，审核要求：
 *   1) 小程序后台配置《用户隐私保护指引》（内容必须与实际一致）；
 *   2) 首次调用隐私接口前获得用户同意；
 *   3) 小程序内有可查看的隐私政策。
 *
 * 本文件负责「本机同意状态」与「打开隐私政策」两件事：
 *   · 同意状态按版本号存 storage（KEY = privacyAgreedVersion）——
 *     隐私政策内容更新时把 POLICY_VERSION 改一下，老用户会重新弹一次；
 *   · **不拦截** wx.onNeedPrivacyAuthorization：未同意时由微信自己的隐私弹窗兜底，
 *     避免我们注册了回调却因为当前页面没挂载弹窗组件导致隐私接口一直挂起。
 *     我们的自定义弹窗只是「首次启动的主动告知 + 勾选」，点同意后本地记状态；
 *     平台级授权仍由微信原生弹窗（或按钮 open-type="agreePrivacyAuthorization"）完成。
 * ---------------------------------------------------------------------------
 */
const KEY = 'privacyAgreedVersion'
// 隐私政策内容有实质变化时改这个版本号（会重新弹同意）
const POLICY_VERSION = '2026-10-17'

/** 本机是否已同意当前版本的隐私政策 */
function hasAgreed() {
  try {
    return wx.getStorageSync(KEY) === POLICY_VERSION
  } catch (e) {
    return false
  }
}

/** 记录本机已同意 */
function markAgreed() {
  try {
    wx.setStorageSync(KEY, POLICY_VERSION)
  } catch (e) {
    // 存不进去也不影响用户继续使用；下次会再提示一次
  }
}

/** 清掉同意状态（调试用；正式版没有入口） */
function resetAgreed() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {}
}

/** 打开隐私政策页（我们自己的协议页，内容见云函数 shop-config.js 的 cms.agreement） */
function openPolicy() {
  wx.navigateTo({
    url: '/pages/about-us/detail?key=agreement',
    fail: () => {}
  })
}

/**
 * 打开微信官方的《用户隐私保护指引》（需在小程序后台配置过）。
 * 配置了就用官方的（带"已配置"的正式文案）；没配置/旧基础库则回落到我们自己的协议页。
 */
function openContractPage() {
  if (typeof wx !== 'undefined' && typeof wx.openPrivacyContract === 'function') {
    wx.openPrivacyContract({
      fail: () => openPolicy()
    })
    return
  }
  openPolicy()
}

module.exports = {
  POLICY_VERSION,
  hasAgreed,
  markAgreed,
  resetAgreed,
  openPolicy,
  openContractPage
}
