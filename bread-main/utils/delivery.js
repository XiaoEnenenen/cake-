/**
 * 配送方式状态管理
 * ---------------------------------------------------------------------------
 * 改造说明：项目原为纯自提，无配送方式概念。现新增「自提 / 外送」切换。
 *
 * 当前实现范围（简化版外送）：
 *   只记录用户选择，并在订单备注与页面上体现；不涉及收货地址、
 *   不涉及距离校验、不涉及运费计算，因此无需定位权限与地图 key。
 *
 * 数据存放：wx.setStorageSync('deliveryMode')，取值 'pickup' | 'delivery'
 * 默认值：'pickup'（自提）
 *
 * 后续接入正式配送时，本模块可扩展为「读取地址簿默认地址」并返回运费预估。
 * ---------------------------------------------------------------------------
 */
const SHOP_CONFIG = require('../shop-config')

const STORAGE_KEY = 'deliveryMode'
const PICKUP = 'pickup'
const DELIVERY = 'delivery'

/**
 * 外送入口是否可用（受 shop-config.js 的 delivery.enabled 控制）
 */
function isDeliveryEnabled() {
  return !!(SHOP_CONFIG.delivery && SHOP_CONFIG.delivery.enabled)
}

/**
 * 读取当前配送方式。若配置关闭了外送，则强制回退为自提。
 * @returns {'pickup'|'delivery'}
 */
function getMode() {
  const saved = wx.getStorageSync(STORAGE_KEY)
  if (!isDeliveryEnabled()) {
    return PICKUP
  }
  return saved === DELIVERY ? DELIVERY : PICKUP
}

/**
 * 设置配送方式
 * @param {'pickup'|'delivery'} mode
 */
function setMode(mode) {
  const next = mode === DELIVERY && isDeliveryEnabled() ? DELIVERY : PICKUP
  wx.setStorageSync(STORAGE_KEY, next)
  return next
}

/**
 * 判断当前是否为外送
 */
function isDelivery() {
  return getMode() === DELIVERY
}

/**
 * 当前配送方式对应的中文名
 */
function getModeText() {
  return isDelivery() ? '外送' : '自提'
}

module.exports = {
  PICKUP,
  DELIVERY,
  STORAGE_KEY,
  isDeliveryEnabled,
  getMode,
  setMode,
  isDelivery,
  getModeText
}
