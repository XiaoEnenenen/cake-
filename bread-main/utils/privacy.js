/**
 * 隐私授权（阶段 12，2026-10-17；2026-10-17 顾客反馈整改）
 * ---------------------------------------------------------------------------
 * 背景：小程序收集/使用用户信息（微信昵称头像、手填手机号、收货地址、
 * 位置用于算配送距离/导航）时，审核要求：
 *   1) 小程序后台配置《用户隐私保护指引》（内容必须与实际一致）；
 *   2) 首次调用隐私接口前获得用户同意；
 *   3) 小程序内有可查看的隐私政策。
 *
 * 本文件负责「本机同意状态」「首次启动是否已提示」「打开隐私政策」三件事：
 *   · 同意状态按版本号存 storage（KEY = privacyAgreedVersion）——
 *     隐私政策内容更新时把 POLICY_VERSION 改一下，老用户会重新弹一次；
 *   · **首次启动的主动告知只弹一次**（KEY = privacyPromptedVersion）：
 *     顾客 2026-10-17 反馈「第二次进小程序、明明已经是登录状态，还是弹隐私政策」——
 *     根因是原来只有 agree 状态、没有「已提示」状态，点「暂不使用」的顾客每次冷启动都会再被弹一次。
 *     现在弹过一次就记 prompted；之后只在**主动登录**（登录弹层里必须重新勾选）或
 *     真正要调用隐私接口时（微信原生弹窗兜底）再要求同意；
 *   · **不拦截** wx.onNeedPrivacyAuthorization：未同意时由微信自己的隐私弹窗兜底，
 *     避免我们注册了回调却因为当前页面没挂载弹窗组件导致隐私接口一直挂起。
 *     我们的自定义弹窗是「首次启动的主动告知 + 登录前必须勾选」，点同意后本地记状态；
 *     平台级授权在登录时通过 wx.requirePrivacyAuthorize 主动触发（见 requestPlatformAuthorize）。
 * ---------------------------------------------------------------------------
 */
const KEY = 'privacyAgreedVersion'
// 首次启动主动告知是否已经弹过（只记"弹过"，不代表"同意"）
const PROMPT_KEY = 'privacyPromptedVersion'
// 退出登录时写这个标记；下次**冷启动**由 app.js 消费：
// 清掉同意/已提示状态 → 隐私弹窗重新出现（2026-10-17 第二轮顾客反馈）
const RESET_ON_LAUNCH_KEY = 'privacyResetOnNextLaunch'
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

/** 首次启动的主动告知是否已经弹过（只代表弹过，不代表同意） */
function hasPrompted() {
  try {
    return wx.getStorageSync(PROMPT_KEY) === POLICY_VERSION
  } catch (e) {
    return false
  }
}

/** 记录"首次启动告知已弹过" */
function markPrompted() {
  try {
    wx.setStorageSync(PROMPT_KEY, POLICY_VERSION)
  } catch (e) {
    // 存不进去最多导致下次再弹一次，不阻断使用
  }
}

/** 清掉"已提示"状态（调试用） */
function resetPrompted() {
  try {
    wx.removeStorageSync(PROMPT_KEY)
  } catch (e) {}
}

/**
 * 退出登录：请求"下次冷启动重新告知隐私政策"。
 * 注意只写标记、**不立刻清同意状态** —— 否则顾客退出登录后在本会话里
 * 再打开结算/地址等页面时又会立刻弹一次（顾客要的是"退出小程序、再次打开后弹"）。
 */
function requestResetOnNextLaunch() {
  try {
    wx.setStorageSync(RESET_ON_LAUNCH_KEY, '1')
  } catch (e) {}
}

/**
 * 下次冷启动时调用（app.js onLaunch）：命中退出登录标记就清掉同意/已提示状态，
 * 让隐私弹窗重新出现。返回是否命中。
 */
function consumeResetOnNextLaunch() {
  let hit = false
  try {
    if (wx.getStorageSync(RESET_ON_LAUNCH_KEY) === '1') {
      hit = true
      wx.removeStorageSync(RESET_ON_LAUNCH_KEY)
      wx.removeStorageSync(KEY)
      wx.removeStorageSync(PROMPT_KEY)
    }
  } catch (e) {}
  return hit
}

/**
 * 重新登录成功：取消"下次冷启动重新告知"。
 * 为什么：顾客退出后又马上登录，已经是登录状态了，下次打开不该再弹隐私政策
 * （与"已登录时不再弹"的规则一致）。
 */
function cancelResetOnNextLaunch() {
  try {
    wx.removeStorageSync(RESET_ON_LAUNCH_KEY)
  } catch (e) {}
}

/**
 * 冷启动时是否要主动弹隐私告知。
 * 只弹一次：同意过（hasAgreed）或已经弹过（hasPrompted）都不再弹 ——
 * 顾客反馈的"第二次进小程序还弹"就是在这里收口；之后只有主动登录时重新要求勾选。
 */
function shouldShowOnLaunch() {
  return !hasAgreed() && !hasPrompted()
}

/**
 * 主动请求微信平台级隐私授权（会让微信弹出它自己的隐私授权框）。
 * 返回 Promise<{ok:boolean, denied:boolean, unsupported?:boolean, errMsg?:string}>
 *
 * 为什么需要它：登录弹层里顾客勾选同意后要真正记下「平台级同意」，
 * 否则后续选头像 / 定位等隐私接口还会被微信拦一次。
 * 兼容处理：
 *   · 旧基础库没有 requirePrivacyAuthorize → 按 unsupported 放行（本地已记同意）；
 *   · 后台还没配置《用户隐私保护指引》时微信可能直接失败（不是用户拒绝）→ 同样放行，
 *     不能因为后台配置没做完就让顾客完全登录不了；
 *   · 只有用户明确点了「拒绝」才返回 denied，由调用方拦住登录。
 */
function requestPlatformAuthorize() {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || typeof wx.requirePrivacyAuthorize !== 'function') {
      resolve({ ok: true, denied: false, unsupported: true })
      return
    }
    try {
      wx.requirePrivacyAuthorize({
        success: () => resolve({ ok: true, denied: false }),
        fail: (e) => {
          const errMsg = (e && e.errMsg) || ''
          const denied = /deny|denied|reject|cancel/i.test(errMsg)
          resolve({ ok: false, denied: denied, errMsg: errMsg })
        }
      })
    } catch (e) {
      // 调用直接抛错（基础库/环境异常）→ 按"平台能力不可用"放行，别把登录堵死
      resolve({ ok: true, denied: false, unsupported: true, errMsg: String((e && e.message) || e || '') })
    }
  })
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
  hasPrompted,
  markPrompted,
  resetPrompted,
  requestResetOnNextLaunch,
  consumeResetOnNextLaunch,
  cancelResetOnNextLaunch,
  shouldShowOnLaunch,
  requestPlatformAuthorize,
  openPolicy,
  openContractPage
}
