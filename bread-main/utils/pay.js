// 2026-09-26 阶段一：调用路径改走统一数据层。
// 2026-10-09 阶段三：统一数据层已收敛为单一云开发通道（api 工厂降级通道已删除），
// 云函数不可用时 API.wxpay 返回的是「云函数调用失败：…」。
// 云开发模式下若微信支付尚未接入，API.wxpay 会返回明确文案
// "云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付"。
//
// ⚠️ 2026-10-12 复核整改：这里原先写「下面 else 分支会直接弹出该文案（不再是"出错了"）」，
//    但实际代码仍是 `title: '出错了' + content: JSON.stringify(res)` —— 顾客会看到一串原始 JSON。
//    这条（报告 P-09）按计划**留给阶段 7** 与真实支付一起改：
//    接支付时统一改成明确文案（如"支付尚未接入，请稍后再试"），并区分「取消/失败/未接入」三种情况。
//    本次只把这条注释改成与实现一致，避免"文档说已修好、代码没修"。
//
// 2026-09-26 阶段二：已删除 recharge（充值）/ paybill（优惠买单）分支 ——
// 二者属会员余额体系，且全项目无任何调用方，唯一调用类型是 'order'。
const API = require('./api-map')
// 阶段 5.7：日志统一收敛到 utils/log.js（不在页面/utils 里直接写 console.*）
const LOG = require('./log')

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
  // https://www.yuque.com/apifm/nu0f75/kffu74
  API.wxpay(postData).then(function (res) {
    if (res.code == 0) {
      // 发起支付
      wx.requestPayment({
        timeStamp: res.data.timeStamp,
        nonceStr: res.data.nonceStr,
        package: res.data.package,
        signType: res.data.signType,
        paySign: res.data.paySign,
        fail: function (aaa) {
          LOG.error('[pay] requestPayment 失败', aaa)
          wx.showToast({
            title: '支付失败:' + aaa
          })
          setTimeout(() => {
            wx.reLaunch({
              url: redirectUrl
            });
          }, 500);
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
    } else {
      wx.showModal({
        title: '出错了',
        content: JSON.stringify(res),
        showCancel: false,
        success (res) {
          wx.reLaunch({
            url: redirectUrl
          });
        }
      })
    }
  })
}

module.exports = {
  wxpay: wxpay
}