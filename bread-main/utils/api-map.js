/**
 * 统一数据服务层（唯一数据入口）
 * ---------------------------------------------------------------------------
 * 2026-10-09 阶段三改造：**只有一条通道** —— 微信云开发（cloudfunctions/api）。
 *
 * 业务层（pages / components / app.js）只 require 本文件，
 * 既不直接调用 wx.cloud，也不直接调用任何第三方 SDK：
 *
 *     pages / components
 *            ↓  API.xxx()
 *     utils/api-map.js        ← 本文件（唯一的 wx.cloud.callFunction 出口）
 *            ↓
 *     cloudfunctions/api       （action 路由表见 handlers.js）
 *
 * 阶段一遗留的 Mock 通道与「api 工厂（apifm-wxapi）+ 云函数失败自动降级」已整体删除：
 *   - 不再有 withFallback / notifyDegrade / callMock / pickCloudOnly 这类通道选择逻辑；
 *   - 云函数失败时**不换源**，直接把 { code: 500, msg: '云函数调用失败' } 交给页面；
 *   - 因此也不存在"降级后数据来自原面包店账号"的串号风险（审计 A-P0-01）。
 *
 * 设计要点（保持不变，避免页面改动）：
 *   1. 方法名与参数签名沿用改造前的 apifm-wxapi 形态，页面里的调用一行都不用改。
 *   2. 所有方法统一返回 { code, data, msg }，页面里的 res.code == 0 判断无需修改。
 *   3. 云开发下用户身份由 OPENID 自动注入，页面传来的 token 参数一律忽略。
 * ---------------------------------------------------------------------------
 */
const DS = require('./data-source')

// ===== 云函数调用 =====
/**
 * 调用统一云函数。
 * @param {string} action 动作名（见 cloudfunctions/api/handlers.js 的路由表）
 * @param {object} payload 参数
 * @returns {Promise<{code:number, data?:any, msg?:string}>} 云函数返回体原样透传
 */
function callCloud(action, payload) {
  return new Promise((resolve) => {
    // 单一数据源：没有第二条通道可切。开关被误设为 false 时给出明确报错，
    // 而不是静默返回空数据（那会让"页面空白"更难排查）。
    if (!DS.useCloud) {
      resolve({
        code: 500,
        msg: '数据源未启用：请把 utils/data-source.js 的 useCloud 设为 true（本项目只有云开发一条通道）'
      })
      return
    }
    if (typeof wx === 'undefined' || !wx.cloud) {
      resolve({ code: 500, msg: '当前环境不支持云开发（请在微信开发者工具或真机中运行，并开通云开发环境）' })
      return
    }
    if (DS.debug) console.log('[api-map] cloud →', action, payload)
    try {
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
          // 失败即失败：不再尝试任何备用数据源（阶段三之前这里会静默降级到 api 工厂）。
          // 文案以「云函数调用失败」开头——页面会直接把这句话提示给用户，
          // 冒号后保留原始 errMsg（形如 cloud.callFunction:fail ...）便于排查云环境/部署问题。
          const detail = err && err.errMsg
          resolve({ code: 500, msg: detail ? '云函数调用失败：' + detail : '云函数调用失败' })
        }
      })
    } catch (e) {
      // callFunction 同步抛异常（少见，例如容器被回收）也必须 resolve，
      // 否则调用方的 await 永远不返回——没有降级兜底后就只剩"一直转圈"。
      console.error('[api-map] cloud 调用同步异常', action, e)
      resolve({ code: 500, msg: '云函数调用失败：' + ((e && e.message) || e) })
    }
  })
}

// ===========================================================================
// 初始化
// ===========================================================================
let cloudInited = false

/**
 * 初始化数据层（在 app.js onLaunch 里调用一次）。
 * 内部执行 wx.cloud.init；未配置 env 时退回开发者工具当前选中的环境并给出提醒。
 * @returns {boolean} 是否初始化成功
 */
function init() {
  if (!DS.useCloud) {
    console.error(
      '[api-map] 数据源未启用（utils/data-source.js 的 useCloud 为 false）。' +
      '本项目只有云开发一条通道，没有备用数据源可切。'
    )
    return false
  }
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
// 接口定义（全部走云函数）
// ===========================================================================
const API = {
  // ---------- 分类 ----------
  goodsCategoryV2: () => callCloud('categoryList', {}),

  // ---------- 商品 ----------
  goodsv2(data) {
    const d = data || {}
    return callCloud('goodsList', {
      categoryId: d.categoryId,
      page: d.page,
      pageSize: d.pageSize
    })
  },

  goodsDetailV2(data) {
    const d = data || {}
    return callCloud('goodsDetail', { id: d.id, goodsId: d.goodsId })
  },

  // ---------- 购物车 ----------
  // 云开发下身份由 OPENID 决定，token 参数仅用于保持调用签名兼容
  shippingCarInfo: () => callCloud('cartInfo', {}),

  shippingCarInfoAddItemV2(data) {
    const d = data || {}
    return callCloud('cartAdd', {
      goodsId: d.goodsId,
      number: d.number,
      sku: d.sku
    })
  },

  // 注意参数形态：沿用原 api工厂 的 (token, key, number)，云函数只取后两个
  shippingCarInfoModifyNumber: (token, key, number) => callCloud('cartModifyNumber', { key, number }),

  shippingCarInfoRemoveItem: (token, key) => callCloud('cartRemoveItem', { key }),

  shippingCarInfoRemoveAll: () => callCloud('cartRemoveAll', {}),

  // ---------- 订单 ----------
  orderCreate: (data) => callCloud('orderCreate', data),

  orderList(data) {
    const d = data || {}
    return callCloud('orderList', { statusBatch: d.statusBatch })
  },

  // 沿用原 api工厂 的 (token, orderId, hxNumber) 签名
  orderDetail: (token, orderId, hxNumber) =>
    callCloud('orderDetail', { id: orderId, hxNumber }),

  orderClose: (token, orderId) => callCloud('orderClose', { id: orderId }),

  orderDelete: (token, orderId) => callCloud('orderDelete', { id: orderId }),

  orderHXV2: (data) => callCloud('orderHx', data),

  // 2026-09-26 阶段二：已删除 orderPayV2（余额支付）与 scoreLogs（积分记录）方法。
  // 会员卡 / 积分 / 余额体系整体移除，云函数对应 action 也已删除。

  // ---------- 支付统一下单 ----------
  /**
   * 微信支付统一下单。
   * 返回结构（页面/utils/pay.js 依赖）：res.code === 0 时提供
   * timeStamp / nonceStr / package / signType / paySign 供 wx.requestPayment 使用。
   *
   * 云函数当前返回「支付尚未接入」的明确文案（阶段 7 才接微信支付），
   * 页面据此提示用户，**不伪造支付成功**。
   */
  wxpay: (data) => callCloud('wxpay', data),

  // ---------- 用户 ----------
  /** 读取当前用户资料。云开发下身份由 OPENID 自动确定，token 参数忽略。 */
  userDetail: () => callCloud('getUser', {}),

  /**
   * 更新用户资料。
   * 注意：云开发模式下不接受前端传来的 token，身份以 OPENID 为准。
   */
  modifyUserInfoV2(data) {
    const d = Object.assign({}, data)
    delete d.token // 云开发下 token 无意义，去掉避免混淆
    return callCloud('updateUser', d)
  },

  /**
   * 登录 / 建立用户身份。
   * 云开发：调一次 getUser 即完成「身份确认」（OPENID 由云函数自动注入），
   *         并在 user 集合中确保用户记录存在。
   */
  login: () => callCloud('getUser', {}),

  // 2026-09-26 阶段二：已删除 userAmount（余额/积分）方法。

  /**
   * 手机号绑定。
   * 页面/组件用法：utils/pay 的绑定弹层、components/bind-mobile
   * 云函数 bindMobile 当前返回「未接入」提示，不伪造绑定成功（阶段 4.4）。
   */
  bindMobile: (data) => callCloud('bindMobile', data || {}),

  /** 首页轮播图。页面读取：res.data（每项 id / picUrl） */
  banners: () => callCloud('banners', {}),

  /**
   * 平台/店铺配置（mallName / order_remark_msg / order_hx_uids）。
   * 云函数 action appConfig。
   */
  appConfig: () => callCloud('appConfig', {}),

  /**
   * CMS 单页（用户隐私协议 / 常见问题）。
   * 页面读取：res.data.info.title / res.data.info.content
   * 云函数 action cmsPage（内容来自 shop-config.js 本地文案）。
   */
  cmsPage: (key) => callCloud('cmsPage', { key }),

  /**
   * 门店列表（单店模式下的兼容桩）。
   * 2026-09-26 阶段二：多门店功能已整体删除，前端已无调用方；
   * 按改造约定保留本方法与云函数桩，便于将来恢复门店能力。
   */
  fetchShops: (data) => callCloud('fetchShops', data || {}),

  /**
   * 门店详情。
   * 单店模式下门店信息来自 shop-config.js。
   */
  shopSubdetail: (id) => callCloud('shopSubdetail', { id }),

  init,

  // ---------- 当前数据源信息（调试用）----------
  // 单一数据源：只有云开发，永远返回 'cloud'。
  // 注意语义：这里描述的是**项目配置的数据源**（只有一个），
  // 与下面「云通道是否启用」是两件事（useCloud 被误设为 false 时二者会不同，
  // 此时 callCloud 会明确返回「数据源未启用」，不会静默换源）。
  __dataSource: () => 'cloud',

  // ---------- 当前云通道是否启用（utils/auth.js / 页面判断用）----------
  // 与 utils/data-source.js 的 useCloud 同源，是唯一判据（不再解析 __dataSource() 字符串）
  __isCloudMode: () => !!DS.useCloud
}

module.exports = API
