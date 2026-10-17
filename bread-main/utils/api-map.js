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
// 阶段 5.7：日志统一收敛到 utils/log.js（本文件不再直接写 console.*）。
// 说明：LOG.debug 内部就是判断 DS.debug，行为与原来的 `if (DS.debug) console.log(...)` 一致；
//      LOG.warn / LOG.error 始终输出，与原来的 console.warn / console.error 一致。
const LOG = require('./log')
// 阶段 9：购物车调用要带当前配送方式（自取立减的口径）。只依赖 shop-config，无循环依赖。
const DELIVERY = require('./delivery')

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
    LOG.debug('[api-map] cloud →', action, payload)
    try {
      wx.cloud.callFunction({
        name: DS.cloudFunctionName,
        data: { action, payload: payload || {} },
        success(res) {
          LOG.debug('[api-map] cloud ←', action, res.result)
          // 云函数抛错时 res.result 可能为空
          resolve(res.result || { code: 500, msg: '云函数无返回' })
        },
        fail(err) {
          // 这次调用失败的原因会原样返回给页面（页面会提示用户），
          // 所以这里只在 debug 开关打开时打日志，避免正式版刷屏（与收敛前一致）。
          LOG.debug('[api-map] cloud ✗', action, err)
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
      LOG.error('[api-map] cloud 调用同步异常', action, e)
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
    LOG.error(
      '[api-map] 数据源未启用（utils/data-source.js 的 useCloud 为 false）。' +
      '本项目只有云开发一条通道，没有备用数据源可切。'
    )
    return false
  }
  if (cloudInited) return true
  if (typeof wx === 'undefined' || !wx.cloud) {
    LOG.error('[api-map] 当前环境不支持 wx.cloud，请确认已开通云开发并在真机/开发者工具中运行')
    return false
  }
  if (!DS.cloudEnvId && DS.warnOnEmptyEnvId) {
    LOG.warn(
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
  LOG.debug('[api-map] 云开发已初始化', DS.cloudEnvId || '(默认环境)')
  return true
}

// ===========================================================================
// 云存储上传（2026-10-12 阶段 5.5 新增）
// ---------------------------------------------------------------------------
// 为什么放在这里：本项目的约定是「页面 / 组件不直接调用 wx.cloud」，
// api-map 是唯一的 wx.cloud 出口（见文件头）。头像上传属于用户资料链路，
// 走同一个出口，避免页面里出现第二处 wx.cloud 调用（也便于统一错误文案）。
// ===========================================================================
/**
 * 上传本地临时文件到云存储。
 * @param {string} filePath 本地临时路径（如 chooseAvatar 返回的 e.detail.avatarUrl）
 * @param {string} cloudPath 云存储路径（形如 'avatars/xxx.png'）
 * @returns {Promise<{code:number, fileID?:string, msg?:string}>}
 *          code 0 = 成功，fileID 可直接用于 <image src>；
 *          失败时 code 500 + 明确文案（不抛异常，调用方按 res.code 处理）。
 */
function uploadFile(filePath, cloudPath) {
  return new Promise((resolve) => {
    if (!filePath) {
      resolve({ code: 500, msg: '没有可上传的文件' })
      return
    }
    if (!DS.useCloud || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) {
      resolve({ code: 500, msg: '当前环境不支持云存储（请在微信开发者工具或真机中运行，并开通云开发环境）' })
      return
    }
    try {
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success(res) {
          if (res && res.fileID) {
            resolve({ code: 0, fileID: res.fileID })
          } else {
            resolve({ code: 500, msg: '上传成功但没有返回 fileID' })
          }
        },
        fail(err) {
          const detail = err && err.errMsg
          resolve({ code: 500, msg: detail ? '上传失败：' + detail : '上传失败' })
        }
      })
    } catch (e) {
      resolve({ code: 500, msg: '上传失败：' + ((e && e.message) || e) })
    }
  })
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
  //
  // ===== 阶段 9：所有购物车调用都自动带上当前配送方式 =====
  // 为什么在这里统一带、而不是让每个页面自己传：
  //   商品可能有「自取立减」（pickupDiscount），自提与外送的**单价不同**。
  //   只要有一个页面漏传，就会出现「购物车按自取价、结算页按下单口径重算」不一致。
  //   在唯一的出口处附加，页面代码一行都不用改（页面只需要在切模式后重新拉一次）。
  // 取值来源是 utils/delivery.getMode()（storage.deliveryMode，默认 'pickup'）。
  // 云函数侧 channelOf() 只认 'pickup'，其它值一律按不启用立减处理。
  _cartPayload(extra) {
    // 读 storage 失败（极端情况/非小程序环境）时按自提处理：宁可少给一个折扣，
    // 也不能让「加入购物车」直接抛异常。
    let mode = DELIVERY.PICKUP
    try {
      mode = DELIVERY.getMode()
    } catch (e) {
      mode = DELIVERY.PICKUP
    }
    return Object.assign({ deliveryMode: mode }, extra || {})
  },
  shippingCarInfo: () => callCloud('cartInfo', API._cartPayload()),

  shippingCarInfoAddItemV2(data) {
    const d = data || {}
    return callCloud('cartAdd', API._cartPayload({
      goodsId: d.goodsId,
      number: d.number,
      sku: d.sku
    }))
  },

  // 注意参数形态：沿用原 api工厂 的 (token, key, number)，云函数只取后两个
  shippingCarInfoModifyNumber: (token, key, number) =>
    callCloud('cartModifyNumber', API._cartPayload({ key, number })),

  shippingCarInfoRemoveItem: (token, key) =>
    callCloud('cartRemoveItem', API._cartPayload({ key })),

  shippingCarInfoRemoveAll: () => callCloud('cartRemoveAll', API._cartPayload()),

  // ---------- 订单 ----------
  orderCreate: (data) => callCloud('orderCreate', data),

  orderList(data) {
    const d = data || {}
    return callCloud('orderList', { statusBatch: d.statusBatch })
  },

  // 2026-10-10：扫码核销下线，orderDetail 不再需要 hxNumber 参数
  // （原签名 (token, orderId, hxNumber) 已简化为 (token, orderId)）
  orderDetail: (token, orderId) =>
    callCloud('orderDetail', { id: orderId }),

  orderClose: (token, orderId) => callCloud('orderClose', { id: orderId }),

  orderDelete: (token, orderId) => callCloud('orderDelete', { id: orderId }),

  // 2026-10-10：店主手动完成订单，取代原 orderHXV2（扫码核销）。
  orderFinish: (token, orderId) => callCloud('orderFinish', { id: orderId }),

  // ---------- 店主端（阶段 10）----------
  // ⚠️ 这些接口在**服务端**用 ctx.openid 比对白名单（requireAdmin）——
  //    前端只是"入口显不显示"的展示判断，改前端拿不到权限。
  //    页面统一通过 utils/admin.js 的 isShopAdmin() 决定入口，禁止自己在页面里拼 storage 判断。
  /** 店主视角订单列表（跨顾客；statusBatch/page/pageSize） */
  adminOrderList(data) {
    const d = data || {}
    return callCloud('orderAdminList', {
      statusBatch: d.statusBatch,
      page: d.page,
      pageSize: d.pageSize
    })
  },

  /** 店主视角商品列表（含已下架；categoryId/keyword 可选） */
  adminGoodsList(data) {
    const d = data || {}
    return callCloud('goodsAdminList', {
      categoryId: d.categoryId,
      keyword: d.keyword
    })
  },

  /** 新增 / 编辑商品（不带 id = 新增；没传的字段沿用旧值，可只传 { id, enabled } 切上下架） */
  adminGoodsUpsert: (data) => callCloud('goodsUpsert', data || {}),

  /** 下架商品（软删：enabled=false，可重新上架） */
  adminGoodsDelete: (id) => callCloud('goodsDelete', { id }),

  /** 保存配送设置（距离阶梯 / 不送区域 / 距离上限 / 蛋糕免运费） */
  adminDeliverySave: (rule) => callCloud('deliveryRuleSave', rule || {}),

  /** 「运费待确认」订单的运费补录：只传一个 freight，总额由服务端重算 */
  adminOrderFreightConfirm: (id, freight) =>
    callCloud('orderFreightConfirm', { id, freight }),

  // ---------- 优惠券（阶段 11）----------
  // ⚠️ 金额纪律：券能不能用、能减多少**只由服务端算** —— 本文件只负责转发，
  //    页面只展示服务端给的 discount，绝不自己用券面金额拼一遍。
  /** 顾客可见的券（含"我的资格"：新客 / 每人限用是否已用完），用于结算页入口提示 */
  couponsAvailable: () => callCloud('couponList', {}),

  /**
   * 结算页：购物车可用券 + 预估优惠（按当前配送方式算，与下单同口径）。
   * 返回 { goodsAmount, packingFee, coupons, usableCoupons, bestCouponId, bestDiscount }
   */
  couponUsableForCart: () => callCloud('couponUsableForCart', API._cartPayload()),

  /** 店主端券列表（含已停用；带使用量、状态与有效期文案） */
  adminCouponList: () => callCloud('couponAdminList', {}),

  /**
   * 新建 / 编辑 / 停用优惠券（店主）
   * 不带 id = 新增；没传的字段沿用旧值（可只传 { id, enabled } 做启用/停用）。
   */
  adminCouponUpsert: (data) => callCloud('couponUpsert', data || {}),

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
   * 可更新字段（云函数 updateUser 白名单）：nick / avatarUrl / sex / birthday / mobile。
   */
  modifyUserInfoV2(data) {
    const d = Object.assign({}, data)
    delete d.token // 云开发下 token 无意义，去掉避免混淆
    return callCloud('updateUser', d)
  },

  /**
   * 上传本地文件到云存储（头像用）。见文件上方 uploadFile 的说明。
   * 页面用法：API.uploadFile(tempFilePath, cloudPath)
   */
  uploadFile: uploadFile,

  /**
   * 登录 / 建立用户身份。
   * 云开发：调一次 getUser 即完成「身份确认」（OPENID 由云函数自动注入），
   *         并在 user 集合中确保用户记录存在。
   */
  login: () => callCloud('getUser', {}),

  // 2026-09-26 阶段二：已删除 userAmount（余额/积分）方法。
  // 2026-10-17 顾客确认不做手机号登录：bindMobile 一起删除（手机号由顾客在结算页手填）。

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
