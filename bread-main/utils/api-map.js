/**
 * 统一数据服务层（唯一数据入口）
 * ---------------------------------------------------------------------------
 * 2026-09-26 阶段一改造后的定位：
 *   业务层（pages / components / app.js）只 require 本文件，不直接调用
 *   apifm-wxapi，也不直接调用 wx.cloud。
 *
 * 三条通道由 utils/data-source.js 的开关决定：
 *   useMock   = true                  → utils/mock-backend.js（本地假数据）
 *   useCloud  = true                  → wx.cloud.callFunction → cloudfunctions/api（★ 主路线）
 *   两者都 false                       → utils/services/legacy-apifm.js → apifm-wxapi（备用）
 *   云函数失败且 DS.fallbackToLegacy    → 自动降级到 legacy（仅一次，会弹窗提示）
 *
 * 设计要点（保持不变，避免页面改动）：
 *   1. 方法名与返回值结构「尽量与 apifm-wxapi 保持一致」，
 *      这样把 WXAPI.xxx 换成 API.xxx 即可，页面其它逻辑不用动。
 *   2. 三条通道统一返回 { code, data, msg }，因此页面里的 res.code == 0 判断无需修改。
 *   3. 通道选择由 pick() 统一完成，业务层不感知。
 *
 * 迁移方式（页面里只需改这一行）：
 *     const WXAPI = require('apifm-wxapi')
 *     ↓
 *     const API = require('../../utils/api-map')
 * ---------------------------------------------------------------------------
 */
const DS = require('./data-source')
const LEGACY = require('./services/legacy-apifm')

// ===== 云函数调用 =====
/**
 * 调用统一云函数
 * @param {string} action 动作名（见 cloudfunctions/api/handlers.js 的路由表）
 * @param {object} payload 参数
 */
function callCloud(action, payload) {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || !wx.cloud) {
      resolve({ code: 500, msg: '当前环境不支持云开发（请在微信开发者工具或真机中运行，并开通云开发环境）' })
      return
    }
    if (DS.debug) console.log('[api-map] cloud →', action, payload)
    wx.cloud.callFunction({
      name: DS.cloudFunctionName,
      data: { action, payload: payload || {} },
      success(res) {
        if (DS.debug) console.log('[api-map] cloud ←', action, res.result)
        // 云函数抛错时 res.result 可能为空
        resolve(res.result || { code: 500, msg: '云函数无返回' })
      },
      fail(err) {
        if (DS.debug) console.error('[api-map] cloud ✗', action, err)
        resolve({ code: 500, msg: (err && err.errMsg) || '云函数调用失败' })
      }
    })
  })
}

// ===========================================================================
// Mock 通道（本地假数据，阶段三补齐实现）
// ===========================================================================
/**
 * 本地 Mock 通道（预留）。
 * 阶段三会在 utils/mock-backend.js 补齐 call()，届时本函数只需把 action 转发过去。
 * 在此之前调用会明确返回"未接入"，而不是静默返回空数据。
 */
function callMock(action, payload) {
  void action
  void payload
  return Promise.resolve({
    code: 501,
    msg: 'Mock 数据层尚未接入（阶段三补齐），请把 utils/data-source.js 的 useMock 改为 false'
  })
}

// ===========================================================================
// 通道选择
// ===========================================================================
// 云函数失败自动降级的"只提示一次"标记
let degradedToLegacy = false

/**
 * 云函数失败降级提示（只弹一次）
 */
function notifyDegrade(msg) {
  if (degradedToLegacy) return
  degradedToLegacy = true
  if (typeof wx === 'undefined' || !wx.showModal) return
  wx.showModal({
    title: '云开发不可用，已临时降级',
    content: (msg || '云函数调用失败') + '\n\n已临时切换到 api 工厂（备用数据源），数据仍为原面包店账号，仅供调试。\n请检查云开发环境与 cloudfunctions/api 是否已部署。',
    showCancel: false
  })
}

/**
 * 给 cloud 实现包一层"失败自动降级到 legacy"。
 * 仅在业务层传入了 legacy 实现、且 DS.fallbackToLegacy 为 true 时生效。
 */
function withFallback(cloudFn, legacyFn) {
  return async (...args) => {
    const res = await cloudFn(...args)
    // 云函数通道的可信返回：code === 0（成功）
    if (res && res.code === 0) return res
    // 云函数不可用（环境未开通 / 未部署 / 调用失败）→ 降级到 legacy 备用通道
    if (res && res.code === 500 && DS.fallbackToLegacy && typeof legacyFn === 'function') {
      notifyDegrade(res.msg)
      return legacyFn(...args)
    }
    return res
  }
}

/**
 * 「仅云通道」包装：不参与云函数失败降级。
 *
 * 用途：给那些**当前尚未接入云函数、且明确返回"未接入"**的接口用
 * （wxpay 微信支付、bindMobile 手机号绑定）。
 *
 * 为什么需要它：
 *   这两个接口在云开发模式下**就是没有实现**（返回 code 501 的明确提示）。
 *   若参与降级，降级到 api 工厂后又会因为"云模式下未 init 过 api 工厂 SDK"而失败，
 *   最终页面只会看到"云函数调用失败 / 出错了"这种无信息量的报错，
 *   把"支付暂时不可用"的真正原因盖掉。
 *   加上本包装后，页面能直接拿到 501 的明确文案。
 *
 * 注意：这不会掩盖环境问题 —— 如果 501「未接入」将来被真正实现，
 *       本包装只是让失败时不再尝试 legacy 通道，成功路径完全不受影响。
 */
function onlyCloud(cloudFn) {
  if (DS.useMock) {
    return () => callMock('', {})
  }
  if (DS.useCloud) {
    return (...args) => cloudFn(...args)
  }
  // 非云开发模式（legacy 回退场景）：仍走 legacy，保持改造前行为
  return null
}

/**
 * 选择数据源。
 * 优先级：Mock → 云函数（失败可降级 legacy）→ legacy
 * @param {Function} cloudFn  云函数实现
 * @param {Function} legacyFn 原 api工厂 实现（备用，不删除）
 */
function pick(cloudFn, legacyFn) {
  if (DS.useMock) {
    // Mock 通道目前是预留位（阶段三补齐 callMock 实现）。返回明确错误，
    // 避免"切到 Mock 却静默返回空数据"这种更难排查的情况。
    return () => callMock('', {})
  }
  if (DS.useCloud) {
    return withFallback(cloudFn, legacyFn)
  }
  return (...args) => legacyFn(...args)
}

/**
 * 选择数据源（不降级版本）。
 * 云开发模式下只用云函数；legacy 模式下用 legacy 实现。
 * @param {Function} cloudFn  云函数实现
 * @param {Function} legacyFn 原 api工厂 实现（备用，不删除）
 */
function pickCloudOnly(cloudFn, legacyFn) {
  const only = onlyCloud(cloudFn)
  if (only) return only
  return (...args) => legacyFn(...args)
}

// ===========================================================================
// 初始化
// ===========================================================================
let cloudInited = false

/**
 * 初始化数据层。
 * 云开发模式下必须调用一次（在 app.js onLaunch 里），否则云函数调不通。
 * api 工厂 模式下由 app.js 直接调 LEGACY.init()（本函数不做任何事）。
 */
function init() {
  if (DS.useMock) return false
  if (!DS.useCloud) return false
  if (cloudInited) return true
  if (typeof wx === 'undefined' || !wx.cloud) {
    console.error('[api-map] 当前环境不支持 wx.cloud，请确认已开通云开发并在真机/开发者工具中运行')
    return false
  }
  if (!DS.cloudEnvId && DS.warnOnEmptyEnvId) {
    console.warn(
      '[api-map] 未配置云环境 ID（utils/data-source.js 的 cloudEnvId）：' +
      '多环境下将使用开发者工具当前选中的环境，容易出现"本地与真机连到不同环境"。' +
      '请在云控制台复制环境 ID 后填入。'
    )
  }
  // 不传 env 时使用当前默认环境；多环境请在 utils/data-source.js 的 cloudEnvId 指定
  wx.cloud.init({
    env: DS.cloudEnvId || undefined,
    traceUser: true
  })
  cloudInited = true
  if (DS.debug) console.log('[api-map] 云开发已初始化', DS.cloudEnvId || '(默认环境)')
  return true
}

// ===========================================================================
// 接口定义：左为云开发实现（主路线），右为原 api工厂 实现（备用，保持向后兼容）
// ===========================================================================
const API = {
  // ---------- 分类 ----------
  goodsCategoryV2: pick(
    // 云开发：无参数
    () => callCloud('categoryList', {}),
    // 原实现
    () => LEGACY.goodsCategoryV2()
  ),

  // ---------- 商品 ----------
  goodsv2: pick(
    (data) => {
      const d = data || {}
      return callCloud('goodsList', {
        categoryId: d.categoryId,
        page: d.page,
        pageSize: d.pageSize
      })
    },
    (data) => LEGACY.goodsv2(data)
  ),

  goodsDetailV2: pick(
    (data) => {
      const d = data || {}
      return callCloud('goodsDetail', { id: d.id, goodsId: d.goodsId })
    },
    (data) => LEGACY.goodsDetailV2(data)
  ),

  // ---------- 购物车 ----------
  shippingCarInfo: pick(
    (token) => callCloud('cartInfo', {}),
    (token) => LEGACY.shippingCarInfo(token)
  ),

  shippingCarInfoAddItemV2: pick(
    (data) => {
      const d = data || {}
      return callCloud('cartAdd', {
        goodsId: d.goodsId,
        number: d.number,
        sku: d.sku
      })
    },
    (data) => LEGACY.shippingCarInfoAddItemV2(data)
  ),

  shippingCarInfoModifyNumber: pick(
    // 注意参数形态不同：原 api工厂 是 (token, key, number)，云开发用对象
    (token, key, number) => callCloud('cartModifyNumber', { key, number }),
    (token, key, number) => LEGACY.shippingCarInfoModifyNumber(token, key, number)
  ),

  shippingCarInfoRemoveItem: pick(
    (token, key) => callCloud('cartRemoveItem', { key }),
    (token, key) => LEGACY.shippingCarInfoRemoveItem(token, key)
  ),

  shippingCarInfoRemoveAll: pick(
    (token) => callCloud('cartRemoveAll', {}),
    (token) => LEGACY.shippingCarInfoRemoveAll(token)
  ),

  // ---------- 订单 ----------
  orderCreate: pick(
    (data) => callCloud('orderCreate', data),
    (data) => LEGACY.orderCreate(data)
  ),

  orderList: pick(
    (data) => {
      const d = data || {}
      return callCloud('orderList', { statusBatch: d.statusBatch })
    },
    (data) => LEGACY.orderList(data)
  ),

  orderDetail: pick(
    // 原 api工厂 是 (token, orderId, hxNumber)
    (token, orderId, hxNumber) =>
      callCloud('orderDetail', { id: orderId, hxNumber }),
    (token, orderId, hxNumber) => LEGACY.orderDetail(token, orderId, hxNumber)
  ),

  orderClose: pick(
    (token, orderId) => callCloud('orderClose', { id: orderId }),
    (token, orderId) => LEGACY.orderClose(token, orderId)
  ),

  orderDelete: pick(
    (token, orderId) => callCloud('orderDelete', { id: orderId }),
    (token, orderId) => LEGACY.orderDelete(token, orderId)
  ),

  orderHXV2: pick(
    (data) => callCloud('orderHx', data),
    (data) => LEGACY.orderHXV2(data)
  ),

  // 2026-09-26 阶段二：已删除 orderPayV2（余额支付）与 scoreLogs（积分记录）方法。
  // 会员卡 / 积分 / 余额体系整体移除，云函数对应 action 也已删除。

  // ---------- 支付统一下单 ----------
  /**
   * 微信支付统一下单。
   * 返回结构（页面/utils/pay.js 依赖）：res.code === 0 时提供
   * timeStamp / nonceStr / package / signType / paySign 供 wx.requestPayment 使用。
   *
   * 云开发通道当前返回"未接入"提示（微信支付尚未接入云函数），
   * 由调用方展示提示，不伪造支付成功。
   * ⚠️ 该接口使用 pickCloudOnly：云模式下不降级，
   *    保证页面拿到的是"云开发支付尚未接入…"而不是被降级掩盖成"出错了"。
   */
  wxpay: pickCloudOnly(
    (data) => callCloud('wxpay', data),
    (data) => LEGACY.wxpay(data)
  ),

  // ---------- 用户 ----------
  /**
   * 读取当前用户资料。
   * 云开发模式下身份由 OPENID 自动确定，不需要 token。
   */
  userDetail: pick(
    (token) => callCloud('getUser', {}),
    (token) => LEGACY.userDetail(token)
  ),

  /**
   * 更新用户资料。
   * 注意：云开发模式下不接受前端传来的 token，身份以 OPENID 为准。
   */
  modifyUserInfoV2: pick(
    (data) => {
      const d = Object.assign({}, data)
      delete d.token // 云开发下 token 无意义，去掉避免混淆
      return callCloud('updateUser', d)
    },
    (data) => LEGACY.modifyUserInfoV2(data)
  ),

  /**
   * 登录 / 建立用户身份。
   * 云开发：调一次 getUser 即完成「身份确认」（OPENID 由云函数自动注入），
   *         并在 user 集合中确保用户记录存在。
   * 原后端：仍然走 code 换 token 的流程。
   */
  login: pick(
    () => callCloud('getUser', {}),
    () => LEGACY.login()
  ),

  // 2026-09-26 阶段二：已删除 userAmount（余额/积分）与 scoreLogs（积分记录）方法。

  /**
   * 手机号绑定。
   * 页面/组件用法：utils/pay 的绑定弹层、components/bind-mobile
   * 云开发通道由云函数 bindMobile 接管（当前返回"未接入"提示，不伪造绑定成功）。
   * legacy 通道保持原 api 工厂流程不变。
   * ⚠️ 该接口使用 pickCloudOnly：云模式下不降级，保证提示文案不被掩盖。
   */
  bindMobile: pickCloudOnly(
    (data) => callCloud('bindMobile', data || {}),
    (data) => LEGACY.bindMobileWxappV2(data && data.token, data && data.code)
  ),

  /**
   * 首页轮播图。
   * 页面读取：res.data（每项 id / picUrl）
   */
  banners: pick(
    () => callCloud('banners', {}),
    () => LEGACY.banners()
  ),

  /**
   * 平台/店铺配置（mallName / order_remark_msg / order_hx_uids）。
   * 云开发通道：新增云函数 action appConfig。
   * legacy 通道：原 queryConfigBatch。
   */
  appConfig: pick(
    () => callCloud('appConfig', {}),
    () => LEGACY.queryConfigBatch('mallName,order_remark_msg,order_hx_uids')
  ),

  /**
   * CMS 单页（用户隐私协议 / 常见问题）。
   * 页面读取：res.data.info.title / res.data.info.content
   * 云开发通道：新增云函数 action cmsPage（内容来自 shop-config.js 本地文案）。
   */
  cmsPage: pick(
    (key) => callCloud('cmsPage', { key }),
    (key) => LEGACY.cmsPage(key)
  ),

  /**
   * 门店列表（单店模式下的兼容桩）。
   * 2026-09-26 阶段二：多门店功能已整体删除，前端已无调用方；
   * 按改造约定保留本方法与云函数桩，便于将来恢复门店能力。
   */
  fetchShops: pick(
    (data) => callCloud('fetchShops', data || {}),
    (data) => LEGACY.fetchShops(data)
  ),

  /**
   * 门店详情。
   * 单店模式下门店信息来自 shop-config.js。
   */
  shopSubdetail: pick(
    (id) => callCloud('shopSubdetail', { id }),
    (id) => LEGACY.shopSubdetail(id)
  ),

  init,

  // ---------- 当前数据源信息（调试用）----------
  __dataSource() {
    if (DS.useMock) return 'mock'
    if (DS.useCloud) return degradedToLegacy ? 'cloud(degraded→apifm)' : 'cloud'
    return 'apifm'
  },

  // ---------- 当前是否运行在云开发模式（utils/auth.js 等判断用）----------
  __isCloudMode() {
    return !!DS.useCloud && !DS.useMock
  }
}

module.exports = API
