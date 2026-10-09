/**
 * 位置与门店导航（单一入口）
 * ---------------------------------------------------------------------------
 * 把「用户定位授权 → 计算与门店的距离 → 一键导航到店」收敛到这一个文件，
 * 供 components/shop-map 组件以及各页面调用，避免每个页面各写一套授权逻辑。
 *
 * ★ 分两层：
 *   【纯函数】isShopReady / formatDistance / distanceToShop / buildNavText /
 *            buildRoutePlanUrl
 *            —— 不依赖 wx，可在 Node 里直接跑断言（tests/test-location.js）。
 *   【wx 能力】ensureAuth / getCurrent / openSettingGuide / copyShopAddress / openNavigation
 *
 * 权限说明（重要）：
 *   1. wx.getLocation 需要 app.json 的 requiredPrivateInfos 里声明 "getLocation"
 *      （本项目已声明，见 app.json:18-21）。
 *   2. 还需要在小程序后台申请「getLocation 接口权限」，并在《用户隐私保护指引》里
 *      声明收集「位置信息」，否则调用会失败 —— 本项目已做降级：失败只影响
 *      「距离您 X」是否显示，不影响下单与导航。
 *   3. 导航（wx.openLocation）**不需要**任何定位权限。
 *
 * 关于「一键导航到店」点不动的说明（2026-10-09 补充，2026-10-09 晚修正）：
 *   wx.openLocation 只是打开微信内置地图并把门店标出来，**真正的导航动作发生在
 *   那一页底部的「导航」按钮上**，而那个按钮由微信控制，微信会自己选路线：
 *     · 市内短途 → 通常直接跳「腾讯地图小程序」，微信内即可导航（实测可行）；
 *     · 跨城长途 → 更依赖手机已安装的地图 App（高德/百度/腾讯/Apple 地图），
 *       没装或处于微信开发者工具时会点了没反应。
 *   实测确认过：门店坐标越准、路线越短，越容易直接跳腾讯地图小程序。
 *   ⚠️ 因此**门店坐标必须是精确值**（shop-config.js 里当前仍是估算占位值，
 *      会造成几十公里的假路线，进而走到「唤起外部地图 App」那条不稳的路径）。
 *   本项目另有两层兜底：
 *     ① 可选接入「腾讯位置服务路线规划」插件（站内路线规划 + 导航，
 *        见 shop-config.js 的 navigation）；
 *     ② 地图板块提供「复制门店地址」，粘到任意地图 App 都能搜到。
 * ---------------------------------------------------------------------------
 */
const SHOP_CONFIG = require('../shop-config')
const DR = require('./delivery-range')

const SCOPE = 'scope.userLocation'

/** 取门店配置（允许调用方传入自己的对象，缺省用 shop-config.js） */
function shopOf(shop) {
  return shop && Object.keys(shop).length ? shop : SHOP_CONFIG.shop || {}
}

/** 取导航配置 */
function navCfg() {
  return SHOP_CONFIG.navigation || {}
}

/**
 * 门店坐标是否可用（用于决定「能不能画地图 / 能不能导航」）
 * @param {object} shop
 * @returns {boolean}
 */
function isShopReady(shop) {
  const s = shopOf(shop)
  const lat = Number(s.latitude)
  const lng = Number(s.longitude)
  return !!(isFinite(lat) && isFinite(lng) && lat !== 0 && lng !== 0)
}

/**
 * 复制给顾客的门店导航文字（粘到任意地图 App 都能搜到）
 * @returns {string}
 */
function buildNavText(shop) {
  const s = shopOf(shop)
  const lines = []
  if (s.name) lines.push(s.name)
  if (s.address) lines.push(s.address)
  if (isShopReady(s)) lines.push('经纬度 ' + Number(s.latitude) + ',' + Number(s.longitude))
  return lines.join('\n')
}

/**
 * 「腾讯位置服务路线规划」插件地址（站内路线规划 + 真正的导航按钮）
 * 参数说明见 https://lbs.qq.com/miniProgram/plugin/pluginGuide/routePlan
 * @returns {string} plugin:// 协议地址
 */
function buildRoutePlanUrl(shop) {
  const s = shopOf(shop)
  const cfg = navCfg()
  const endPoint = JSON.stringify({
    name: s.name || '门店',
    latitude: Number(s.latitude),
    longitude: Number(s.longitude)
  })
  const query = [
    'key=' + encodeURIComponent(cfg.pluginKey || ''),
    'referer=' + encodeURIComponent(cfg.referer || '卿欢蛋糕'),
    'endPoint=' + encodeURIComponent(endPoint),
    'mode=driving',
    'navigation=1', // 开启导航功能（插件内可直接发起导航）
    'enableAI=true'
  ]
  return 'plugin://route-plan/index?' + query.join('&')
}

/** 是否运行在微信开发者工具里（工具内导航可能走不通） */
function isDevtools() {
  try {
    if (typeof wx.getDeviceInfo === 'function') {
      return wx.getDeviceInfo().platform === 'devtools'
    }
    return wx.getSystemInfoSync().platform === 'devtools'
  } catch (e) {
    return false
  }
}

/**
 * 是否处于「开发版 / 体验版」（用于只给店主看的入口，正式版一律隐藏）。
 * 取不到环境信息时返回 false（对顾客更安全）。
 */
function isDevOrTrialEnv() {
  try {
    const info = typeof wx.getAccountInfoSync === 'function' ? wx.getAccountInfoSync() : null
    const envVersion = info && info.miniProgram ? info.miniProgram.envVersion : ''
    return envVersion === 'develop' || envVersion === 'trial'
  } catch (e) {
    return false
  }
}

/**
 * 把坐标格式化成可直接粘进 shop-config.js 的两行文本
 * @returns {string} 如 "latitude: 24.919512,\nlongitude: 102.484033"；非法输入返回空串
 */
function formatCoordinate(latitude, longitude) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) return ''
  const fix = (n) => Math.round(n * 1e6) / 1e6
  return 'latitude: ' + fix(lat) + ',\nlongitude: ' + fix(lng)
}

/**
 * 距离文案：不足 1 公里按米显示
 * @param {number|null} km
 * @returns {string} 如 "860m" / "1.2km"；无法计算时返回空串
 */
function formatDistance(km) {
  if (km === null || km === undefined || !isFinite(km)) return ''
  if (km < 1) return Math.round(km * 1000) + 'm'
  return km + 'km'
}

/**
 * 用户坐标 → 门店的直线距离（公里）
 * @returns {number|null} null 表示算不出（坐标缺失或为 0）
 */
function distanceToShop(latitude, longitude, shop) {
  if (!isShopReady(shop)) return null
  const s = shopOf(shop)
  return DR.calcDistanceKm(s.latitude, s.longitude, latitude, longitude)
}

/** 把 wx 的失败信息翻译成给顾客看的文案 */
function describeError(err) {
  const msg = String((err && err.errMsg) || '')
  if (msg.indexOf('auth deny') >= 0 || msg.indexOf('auth denied') >= 0 || msg.indexOf('authorize') >= 0) {
    return '未授权定位，点击此处开启后可显示距离'
  }
  if (msg.indexOf('privacy') >= 0) {
    return '需先同意《用户隐私保护指引》才能使用定位'
  }
  if (msg.indexOf('requiredPrivateInfos') >= 0) {
    return '小程序尚未声明定位接口，暂无法显示距离'
  }
  if (msg.indexOf('system permission denied') >= 0 || msg.indexOf('system') >= 0) {
    return '手机系统未开启定位权限，请在系统设置中允许微信定位'
  }
  if (msg.indexOf('timeout') >= 0) {
    return '定位超时，点击重试'
  }
  return '定位失败，点击重试'
}

/**
 * 读取 scope.userLocation 授权状态；从未申请过则发起申请。
 * @returns {Promise<{granted:boolean, denied:boolean, errMsg?:string}>}
 */
function ensureAuth() {
  return new Promise((resolve) => {
    if (!wx || typeof wx.getSetting !== 'function') {
      return resolve({ granted: false, denied: false, errMsg: '当前环境不支持定位' })
    }
    wx.getSetting({
      success: (res) => {
        const state = ((res && res.authSetting) || {})[SCOPE]
        if (state === true) {
          return resolve({ granted: true, denied: false })
        }
        if (state === false) {
          // 曾经明确拒绝过：只能引导用户去设置页重新打开
          return resolve({ granted: false, denied: true, errMsg: '未授权定位，点击此处开启后可显示距离' })
        }
        // 从未申请过：发起一次系统授权弹窗
        wx.authorize({
          scope: SCOPE,
          success: () => resolve({ granted: true, denied: false }),
          fail: (err) => resolve({ granted: false, denied: true, errMsg: describeError(err) })
        })
      },
      fail: (err) => resolve({ granted: false, denied: false, errMsg: describeError(err) })
    })
  })
}

/**
 * 取一次用户当前位置（GCJ-02，与微信地图/门店坐标同一坐标系）。
 * 不会抛异常，失败时返回 ok:false + 可展示的 errMsg。
 * @returns {Promise<{ok:boolean, latitude?:number, longitude?:number, denied?:boolean, errMsg?:string}>}
 */
async function getCurrent() {
  const auth = await ensureAuth()
  if (!auth.granted) {
    return { ok: false, denied: !!auth.denied, errMsg: auth.errMsg || '未授权定位' }
  }
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ ok: true, latitude: res.latitude, longitude: res.longitude }),
      fail: (err) => {
        console.warn('[location] getLocation 失败', err)
        resolve({ ok: false, denied: false, errMsg: describeError(err) })
      }
    })
  })
}

/**
 * 引导用户去设置页打开定位权限。
 * @param {boolean} denied 是否被明确拒绝过（否则只提示重试）
 * @returns {Promise<boolean>} 是否已成功开启
 */
function openSettingGuide(denied) {
  return new Promise((resolve) => {
    if (!denied) {
      wx.showToast({ title: '请稍后重试', icon: 'none' })
      return resolve(false)
    }
    wx.showModal({
      title: '开启定位权限',
      content: '开启后可显示您与门店的距离，方便安排自取或配送时间。',
      confirmText: '去设置',
      cancelText: '暂不',
      success: (res) => {
        if (!res.confirm) return resolve(false)
        wx.openSetting({
          success: (s) => resolve(!!((s && s.authSetting) || {})[SCOPE]),
          fail: () => resolve(false)
        })
      },
      fail: () => resolve(false)
    })
  })
}

/** 打开微信内置地图（不需要定位权限） */
function openBuiltInMap(shop) {
  const s = shopOf(shop)
  return new Promise((resolve) => {
    wx.openLocation({
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      name: s.name || '门店',
      address: s.address || '',
      scale: 18,
      success: () => resolve(true),
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') < 0) {
          console.error('[location] openLocation 失败', err)
          wx.showToast({ title: '打开地图失败，请稍后重试', icon: 'none' })
        }
        resolve(false)
      }
    })
  })
}

/**
 * 打开「腾讯位置服务路线规划」插件页（站内路线规划 + 导航）。
 * 未在后台添加插件 / 未配置 key 时 navigateTo 会失败，这里静默返回 false 交给调用方回落。
 */
function openRoutePlan(shop) {
  return new Promise((resolve) => {
    wx.navigateTo({
      url: buildRoutePlanUrl(shop),
      success: () => resolve(true),
      fail: (err) => {
        console.warn('[location] 路线规划插件不可用，回落到微信内置地图', err)
        resolve(false)
      }
    })
  })
}

/**
 * 复制门店地址（兜底能力：手机没装地图 App 时，粘到任意地图 App 都能搜到）
 */
function copyShopAddress(shop) {
  const text = buildNavText(shop)
  if (!text) {
    wx.showToast({ title: '门店地址未配置', icon: 'none' })
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '门店地址已复制', icon: 'none' })
        resolve(true)
      },
      fail: () => resolve(false)
    })
  })
}

/**
 * 一键导航到店。
 *
 * 顺序：
 *   1. 若开启并配置了「腾讯位置服务路线规划」插件 → 用插件（站内路线规划 + 导航）
 *   2. 否则用微信内置地图（wx.openLocation），顾客在该页点「导航」唤起手机地图 App
 *   3. 开发者工具里微信内置地图的「导航」按钮不会有反应，此时先明确告知，
 *      由顾客决定是否仍然查看地图；地图板块另提供「复制门店地址」兜底
 *
 * @param {object} shop 门店信息 { name, address, latitude, longitude }
 * @returns {Promise<boolean>} 是否成功发起了导航
 */
async function openNavigation(shop) {
  const s = shopOf(shop)
  if (!isShopReady(s)) {
    wx.showToast({ title: '门店坐标未配置，暂时无法导航', icon: 'none' })
    return false
  }

  // 1) 站内路线规划插件（可选）
  const cfg = navCfg()
  if (cfg.routePlanPlugin && cfg.pluginKey) {
    const opened = await openRoutePlan(s)
    if (opened) return true
  }

  // 2) 微信内置地图（wx.openLocation）。
  //    微信会自己决定把导航交给「微信内的腾讯地图小程序」还是唤起手机上的地图 App：
  //    市内短途通常直接跳腾讯地图小程序；跨城长途更依赖手机已安装的地图 App。
  //    开发者工具里这两条路都可能走不通，所以地图板块里额外给了「复制门店地址」兜底，
  //    组件在工具里也会显示一行说明（不阻断操作）。
  return openBuiltInMap(s)
}

module.exports = {
  SCOPE,
  shopOf,
  navCfg,
  isShopReady,
  formatDistance,
  distanceToShop,
  buildNavText,
  buildRoutePlanUrl,
  isDevtools,
  isDevOrTrialEnv,
  formatCoordinate,
  ensureAuth,
  getCurrent,
  openSettingGuide,
  copyShopAddress,
  openNavigation
}
