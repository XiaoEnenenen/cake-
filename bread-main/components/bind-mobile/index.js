// 2026-09-26 阶段一：数据来源改走统一数据层。
// 2026-10-09 阶段三：统一数据层只有云开发一条通道（api 工厂降级通道已删除）。
const API = require('../../utils/api-map')
Component({
  options: {
    addGlobalClass: true,
  },
  /**
   * 组件的对外属性，是属性名到属性设置的映射表
   */
  properties: {
    title: String,
    alarmText: String,
    show: Boolean,
  },

  /**
   * 组件的内部数据，和 properties 一同用于组件的模板渲染
   */
  data: {
    
  },
  // 组件数据字段监听器，用于监听 properties 和 data 的变化
  observers: {
  },
  lifetimes: {
    attached() {
      
    },
    detached() {
      // 在组件实例被从页面节点树移除时执行
    },
  },
  /**
   * 组件的方法列表
   */
  methods: {
    close() {
      this.triggerEvent('cancel')
    },
    async getPhoneNumber(e) {
      if (!e.detail.errMsg) {
        wx.showModal({
          content: 'getPhoneNumber异常',
          showCancel: false
        })
        return
      }
      if (e.detail.errMsg == "getPhoneNumber:fail user deny") {
        return
      }
      if (!e.detail.errMsg || e.detail.errMsg != "getPhoneNumber:ok") {
        wx.showModal({
          content: e.detail.errMsg,
          showCancel: false
        })
        return;
      }
      this._getPhoneNumber(e)
    },
    async _getPhoneNumber(e) {
      // 2026-09-26 阶段一：改走统一数据层 API.bindMobile。
      // 2026-10-09 阶段三：只有云开发一条通道，云函数 action bindMobile
      // 当前明确返回"未接入"（需小程序后台开通手机号快速验证，见阶段 4.4）。
      const res = await API.bindMobile({
        token: wx.getStorageSync('token'),
        code: e.detail.code,
        encryptedData: e.detail.encryptedData,
        iv: e.detail.iv
      })
      if (res.code == 0) {
        wx.showToast({
          title: '绑定成功'
        })
        this.data.mobile = res.data
        this.triggerEvent('ok', this.data)
      } else {
        wx.showModal({
          content: res.msg,
          showCancel: false
        })
      }
    },
  }
})