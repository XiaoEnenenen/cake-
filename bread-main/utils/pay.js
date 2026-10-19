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
// 2026-10-19 P0-1 支付闭环（前端部分）：
//   wx.requestPayment 的 success 只代表"顾客在收银台完成了付款动作"，微信支付回调
//   可能延迟几秒才落到云端。所以 success 之后必须再调一次 orderPayConfirm 向服务端
//   确认**真的到账**：确认到账才提示「支付成功」；确认失败/还没到账则提示
//   「支付成功，订单状态确认中，请稍后在订单页刷新」——钱可能已经付了，不能反过来
//   吓顾客说支付失败。另外云端会在「订单已支付」时返回 alreadyPaid，此时绝不重复
//   拉起收银台（否则顾客会看到第二次扣款界面）。
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

/** 展示"运费待确认"的说明（P1-5：这类订单服务端不允许线上支付） */
function showFreightPending(redirectUrl, msg) {
  const phone = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.phone) || ''
  wx.showModal({
    title: '运费待确认',
    content: (msg || '运费需要门店确认后才能支付。') +
      '\n门店确认运费后，可在「我的订单」里继续支付。' +
      (phone ? '\n门店电话：' + phone : ''),
    showCancel: false,
    confirmText: '查看订单',
    success () {
      backToOrders(redirectUrl)
    }
  })
}

/**
 * requestPayment 成功后向服务端确认「钱真的到账了」（2026-10-19 P0-1）。
 * ---------------------------------------------------------------------------
 * 判据只看服务端的 paid 字段，不看 requestPayment 的 success：
 *   · paid === true            → 真的到账，提示「支付成功」并回订单页；
 *   · paid === false / 请求失败 → 回调可能还在路上（钱已付但订单还没置为已支付），
 *                                提示「支付成功，订单状态确认中，请稍后在订单页刷新」，
 *                                仍然回订单页 —— 顾客刷新时服务端会按回调结果更新。
 * 拿不到订单 id（老数据/异常）时无法确认，按支付成功处理：订单页刷新仍以回调为准。
 * @param {string} redirectUrl 支付后要回的目标页
 * @param {string} orderId 订单 id（本轮支付的服务端 orderId 优先）
 */
function confirmOrderPaid(redirectUrl, orderId) {
  function paidAndBack() {
    wx.showToast({ title: '支付成功' })
    wx.reLaunch({ url: redirectUrl })
  }
  if (!orderId) {
    // 没有订单号可确认：不伪造"确认到账"，但也不把顾客扣在支付页
    LOG.warn('[pay] 支付成功但拿不到 orderId，跳过到账确认')
    paidAndBack()
    return
  }
  API.orderPayConfirm(orderId).then(function (res) {
    if (res && res.code == 0 && res.data && res.data.paid) {
      paidAndBack()
      return
    }
    // 回调延迟 / 确认接口失败：钱大概率已付，给"确认中"而不是"支付失败"
    LOG.warn('[pay] 支付回调尚未确认到账，稍后订单页刷新', res && res.msg)
    wx.showToast({
      title: '支付成功，订单状态确认中，请稍后在订单页刷新',
      icon: 'none'
    })
    backToOrders(redirectUrl)
  }).catch(function (e) {
    LOG.error('[pay] 支付确认请求异常', e)
    wx.showToast({
      title: '支付成功，订单状态确认中，请稍后在订单页刷新',
      icon: 'none'
    })
    backToOrders(redirectUrl)
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
    // 2026-10-19 P0-1：显式把订单 id 传给云端（云端据此校验订单归属、返回支付参数，
    // 支付成功回调也按它把订单置为已支付）。
    postData.orderId = orderId;
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
      // 2026-10-19 P0-1：云端发现订单已支付（回调已到账 / 重复点支付）→ 不再拉起收银台，
      // 否则顾客会看到"再付一次"的界面。提示后直接回订单页。
      if (payData.alreadyPaid) {
        LOG.warn('[pay] 订单已支付，跳过重复支付', payData.orderId)
        wx.showToast({ title: '订单已支付', icon: 'none' })
        backToOrders(redirectUrl)
        return
      }
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
          // 2026-10-19 P0-1：不再直接提示"支付成功" —— 先向服务端确认到账，
          // 确认结果决定文案（到账 = 支付成功；回调延迟 = 订单状态确认中），
          // 两种情况都回订单页。orderId 优先用云端返回的（与订单归属一致）。
          confirmOrderPaid(redirectUrl, payData.orderId || orderId)
        }
      })
      return
    }

    // 云函数拒绝/未接入：给业务化文案，绝不弹 JSON
    // 2026-10-19 P1-5：运费待确认（服务端拒绝线上支付）单独说清楚，不当普通失败
    if (/运费待确认/.test(String((res && res.msg) || ''))) {
      LOG.warn('[pay] 运费待确认，暂不能线上支付', res && res.msg)
      showFreightPending(redirectUrl, res && res.msg)
      return
    }
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
