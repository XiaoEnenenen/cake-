// 2026-09-26 阶段一：调用路径改走统一数据层。
// 2026-10-09 阶段三：统一数据层已收敛为单一云开发通道（api 工厂降级通道已删除），
// 云函数不可用时 API.wxpay 返回的是「云函数调用失败：…」。
//
// 2026-10-17 顾客端审查整改（T-8 / 报告 P-09）：
//   原来任何失败都弹 `title: '出错了' + content: JSON.stringify(res)` ——
//   顾客看到一串原始 JSON，既不知道发生了什么，也不知道订单还在不在。
//   现在分三种情况给顾客看得懂的话：
//     ① 用户主动取消支付 → 「已取消支付」（不当作错误）
//     ② 线上支付还没接入（501 / 未开通商户号）→ 「线上支付暂未开通，订单已保存，
//        请到店支付或联系门店」+ 门店电话（店主当前阶段就是这个状态）
//     ③ 其它支付失败 → 展示云函数给的业务文案（不是 JSON）
//   三种情况最终都回到订单页（redirectUrl），订单不会丢。
//
// 2026-09-26 阶段二：已删除 recharge（充值）/ paybill（优惠买单）分支 ——
// 二者属会员余额体系，且全项目无任何调用方，唯一调用类型是 'order'。
const API = require('./api-map')
// 阶段 5.7：日志统一收敛到 utils/log.js（不在页面/utils 里直接写 console.*）
const LOG = require('./log')
const SHOP_CONFIG = require('../shop-config')

/** 线上支付"还没接入"的判定（云函数 501 或文案里明说未接入/商户号） */
function isPayNotReady(res) {
  const msg = String((res && res.msg) || '')
  if (res && res.code === 501) return true
  return /尚未接入|未接入|未开通|商户号|cloudPay|支付暂未/i.test(msg)
}

/** 支付失败/不可用时统一回订单页（订单已生成，不能让顾客停在空白页） */
function backToOrders(redirectUrl) {
  if (!redirectUrl) return
  setTimeout(() => {
    try {
      wx.reLaunch({ url: redirectUrl })
    } catch (e) {
      LOG.error('[pay] 返回订单页失败', e)
    }
  }, 600)
}

/** 展示"未接入"的明确说明（带门店电话，方便顾客直接联系） */
function showPayNotReady(redirectUrl) {
  const phone = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.phone) || ''
  wx.showModal({
    title: '线上支付暂未开通',
    content: '订单已保存。线上支付正在接入中，请到店支付或联系门店完成付款。' +
      (phone ? '\n门店电话：' + phone : ''),
    showCancel: false,
    confirmText: '查看订单',
    success () {
      backToOrders(redirectUrl)
    }
  })
}

/**
 * type: order 支付订单
 * data: 扩展数据对象，用于保存参数
 */
function wxpay(type, money, orderId, redirectUrl, data) {
  const postData = {
    token: wx.getStorageSync('token'),
    money: money,
    remark: "在线充值",
  }
  if (type === 'order') {
    postData.remark = "支付订单 ：" + orderId;
    postData.nextAction = {
      type: 0,
      id: orderId
    };
  }
  postData.payName = postData.remark;
  if (postData.nextAction) {
    postData.nextAction = JSON.stringify(postData.nextAction);  
  }
  API.wxpay(postData).then(function (res) {
    if (res.code == 0) {
      const payData = res.data || {}
      // 支付参数不完整时不发起 requestPayment（否则会抛异常且顾客看不懂）
      if (!payData.timeStamp || !payData.nonceStr || !payData.package || !payData.paySign) {
        LOG.error('[pay] 云函数返回的支付参数不完整', payData)
        wx.showModal({
          title: '支付失败',
          content: '支付参数获取失败，请稍后重试；订单已保存。',
          showCancel: false,
          success () { backToOrders(redirectUrl) }
        })
        return
      }
      // 发起支付
      wx.requestPayment({
        timeStamp: payData.timeStamp,
        nonceStr: payData.nonceStr,
        package: payData.package,
        signType: payData.signType,
        paySign: payData.paySign,
        fail: function (err) {
          const errMsg = String((err && err.errMsg) || '')
          if (/cancel/i.test(errMsg)) {
            // 用户主动取消：不是错误，也不吓顾客
            LOG.debug('[pay] 用户取消支付')
            wx.showToast({ title: '已取消支付', icon: 'none' })
            backToOrders(redirectUrl)
            return
          }
          LOG.error('[pay] requestPayment 失败', err)
          wx.showModal({
            title: '支付失败',
            content: '支付没有完成，请稍后重试；订单已保存，可在订单页继续支付。',
            showCancel: false,
            success () { backToOrders(redirectUrl) }
          })
        },
        success: function () {
          // 提示支付成功
          wx.showToast({
            title: '支付成功'
          })
          wx.reLaunch({
            url: redirectUrl
          });
        }
      })
      return
    }

    // 云函数拒绝/未接入：给业务化文案，绝不弹 JSON
    if (isPayNotReady(res)) {
      LOG.warn('[pay] 线上支付尚未接入', res && res.msg)
      showPayNotReady(redirectUrl)
      return
    }
    LOG.error('[pay] 下单后支付失败', res)
    wx.showModal({
      title: '支付失败',
      content: (res && res.msg) || '支付失败，请稍后重试；订单已保存。',
      showCancel: false,
      success () { backToOrders(redirectUrl) }
    })
  }).catch(function (e) {
    // 理论上游统一数据层不会 reject；兜底也绝不把原始异常甩给顾客
    LOG.error('[pay] 支付请求异常', e)
    wx.showModal({
      title: '支付失败',
      content: '网络异常，请稍后重试；订单已保存。',
      showCancel: false,
      success () { backToOrders(redirectUrl) }
    })
  })
}

module.exports = {
  wxpay: wxpay
}
