/**
 * api 工厂（apifm-wxapi）legacy 适配层 —— 备用通道，不参与主流程
 * ---------------------------------------------------------------------------
 * 定位（2026-09-26 阶段一改造）：
 *   api 工厂代码**全部保留、不删除**，但业务层不再直接 require('apifm-wxapi')。
 *   整个项目里只有这一个文件 require apifm-wxapi，其余一律通过 utils/api-map.js。
 *
 * 为什么要有这个文件：
 *   改造前，apifm-wxapi 散落在 6 个文件里直接调用：
 *     utils/pay.js:33                  WXAPI.wxpay
 *     utils/auth.js:37,68,125,152,...  bindSeller / checkToken / login_wx / authorize ...
 *     pages/about-us/detail.js:22      WXAPI.cmsPage
 *     pages/all-stores/index.js:53     WXAPI.fetchShops
 *     components/bind-mobile/index.js:66,74  wxappServiceBindMobile / bindMobileWxappV2
 *     app.js:14,15,72,109              init / setMerchantId / queryConfigBatch / shareGroupGetScore
 *   现在把这些调用集中到本文件，"业务层不直接依赖 api 工厂"才有明确落点。
 *
 * ⚠️ 保留期限：
 *   微信云开发（cloudfunctions/api）是主路线；本通道仅在
 *   utils/data-source.js 里 useMock=false 且 useCloud=false 时作为回退启用。
 *   待云开发全量验证通过（并接好微信支付）后，可整体停用本目录。
 *
 * ⚠️ 已知语义差异（不要试图在本文件里"修正"，会改变业务行为）：
 *   - checkToken / login_wx / authorize / wxappService* 等属 api 工厂登录流程，保留原样；
 *   - 2026-09-26 阶段二已随业务模块清理：scoreLogs（积分记录）、orderPayV2（余额支付）、
 *     bindSeller（三级分销）、shareGroupGetScore（分销裂变）均已删除。
 *
 * 本文件不做任何参数加工，只是把原调用原样转发，确保回退时行为与改造前完全一致。
 * ---------------------------------------------------------------------------
 */
const WXAPI = require('apifm-wxapi')

module.exports = {
  // ===== 初始化与平台配置（app.js 使用）=====
  init: (subDomain) => WXAPI.init(subDomain),
  setMerchantId: (merchantId) => WXAPI.setMerchantId(merchantId),
  queryConfigBatch: (keys) => WXAPI.queryConfigBatch(keys),

  // ===== 分类 / 商品 =====
  goodsCategoryV2: () => WXAPI.goodsCategoryV2(),
  goodsv2: (data) => WXAPI.goodsv2(data),
  goodsDetailV2: (data) => WXAPI.goodsDetailV2(data),

  // ===== 购物车 =====
  shippingCarInfo: (token) => WXAPI.shippingCarInfo(token),
  shippingCarInfoAddItemV2: (data) => WXAPI.shippingCarInfoAddItemV2(data),
  shippingCarInfoModifyNumber: (token, key, number) =>
    WXAPI.shippingCarInfoModifyNumber(token, key, number),
  shippingCarInfoRemoveItem: (token, key) => WXAPI.shippingCarInfoRemoveItem(token, key),
  shippingCarInfoRemoveAll: (token) => WXAPI.shippingCarInfoRemoveAll(token),

  // ===== 订单 =====
  orderCreate: (data) => WXAPI.orderCreate(data),
  orderList: (data) => WXAPI.orderList(data),
  orderDetail: (token, orderId, hxNumber) => WXAPI.orderDetail(token, orderId, hxNumber),
  orderClose: (token, orderId) => WXAPI.orderClose(token, orderId),
  orderDelete: (token, orderId) => WXAPI.orderDelete(token, orderId),
  orderHXV2: (data) => WXAPI.orderHXV2(data),

  // ===== 支付统一下单（app 内支付仍需 pages 里的 wx.requestPayment，见 utils/pay.js）=====
  wxpay: (data) => WXAPI.wxpay(data),

  // ===== 用户 =====
  login: () => WXAPI.login_wx(''),
  login_wx: (code) => WXAPI.login_wx(code),
  userDetail: (token) => WXAPI.userDetail(token),
  modifyUserInfoV2: (data) => WXAPI.modifyUserInfoV2(data),

  // ===== 登录 / 鉴权（utils/auth.js 使用）=====
  checkToken: (token) => WXAPI.checkToken(token),
  authorize: (data) => WXAPI.authorize(data),
  wxappServiceLogin: (data) => WXAPI.wxappServiceLogin(data),
  wxappServiceAuthorize: (data) => WXAPI.wxappServiceAuthorize(data),

  // ===== 手机号绑定（components/bind-mobile 使用）=====
  bindMobileWxappV2: (token, code) => WXAPI.bindMobileWxappV2(token, code),
  wxappServiceBindMobile: (data) => WXAPI.wxappServiceBindMobile(data),

  // ===== 首页 / 内容 / 门店 =====
  banners: () => WXAPI.banners(),
  cmsPage: (key) => WXAPI.cmsPage(key),
  fetchShops: (data) => WXAPI.fetchShops(data),
  shopSubdetail: (id) => WXAPI.shopSubdetail(id)
}
