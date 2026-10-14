// 2026-10-12 阶段 5.7：删除空的 `app.configLoadOK = () => {}` 桩。
// 该钩子是 api 工厂时代的遗留：app.js onLaunch 拉完配置后回调它。
// 本页早已不需要（配置直接从 storage 读），空回调只会在启动链上多一次无意义调用。
Page({
  data: {
    remark: '',
    // 下单备注快捷短语（来自 storage 的 order_remark_msg，按 \n 拆分）
    // 2026-10-12 复核整改：wxml 用 wx:for="{{list}}" 读它，按本项目约定显式声明。
    list: []
  },
  onLoad: function (options) {
    const order_remark_msg = wx.getStorageSync('order_remark_msg')
    if (order_remark_msg) {
      // 2026-10-14 审查修复：**过滤空项**。
      // 原来直接 split('\n')：配置里有空行/尾随换行时会多出一个"空白可点块"，
      // 顾客误点就把备注设成了空字符串（看起来像备注丢了）。
      this.setData({
        list: String(order_remark_msg)
          .split('\n')
          .map((s) => String(s).trim())
          .filter(Boolean)
      })
    }
  },
  onShow: function () {
    const remark = wx.getStorageSync('remark')
    if (remark) {
      this.setData({
        remark
      })
    }
  },
  msgTap(e) {
    const remark = e.currentTarget.dataset.msg
    wx.setStorageSync('remark', remark)
    this.setData({
      remark
    })
  },
  ok() {
    wx.setStorageSync('remark', this.data.remark)
    wx.navigateBack()
  },
})