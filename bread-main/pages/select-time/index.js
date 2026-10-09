/**
 * 期望时间选择（重写）
 * ---------------------------------------------------------------------------
 * 改造说明：
 *   原实现只能选「今天」，用「时/分」两列 picker，且没有提前时间校验。
 *   现按配送规则重写为：
 *     - 日期：今天起 7 天（可在 config/delivery.js 的 advance.selectableDays 配置）
 *     - 时段：按营业时间生成整点时段（粒度可配置）
 *     - 校验：含蛋糕的订单必须提前 3 小时；所有时间必须在营业时间内
 *     - 已过期/不可选的时段直接不列出，避免用户选了才被拒
 *
 * 规则都在 config/delivery.js 与 utils/delivery-range.js，本页不写死规则。
 * ---------------------------------------------------------------------------
 */
const DR = require('../../utils/delivery-range')
const CFG = require('../../config/delivery')
const SHOP_CONFIG = require('../../shop-config')

Page({
  data: {
    // 日期列表 [{ value, label }]
    dates: [],
    dateIndex: 0,
    // 当前日期下的可选时段 ['09:00', ...]
    slots: [],
    slotIndex: 0,
    // 是否含蛋糕（决定是否提示提前 3 小时）
    hasCake: false,
    advanceTip: '',
    openingHours: ''
  },

  onLoad() {
    const now = new Date()
    const dates = DR.buildDateOptions(now)
    const openingHours = (SHOP_CONFIG.shop && SHOP_CONFIG.shop.openingHours) || ''

    // 判断购物车是否含蛋糕：用于决定是否提示「提前3小时」
    // 购物车数据由结算页写入 storage，这里读取以保持与下单一致
    const items = wx.getStorageSync('checkoutItems') || []
    const cake = DR.analyzeCake(items)
    const hasCake = cake.hasCake

    // 提前时间仅对蛋糕生效（除非配置 applyToAll）
    const needAdvance = CFG.advance.applyToAll || hasCake

    this.setData({
      dates,
      dateIndex: 0,
      openingHours,
      hasCake,
      advanceTip: needAdvance
        ? `${CFG.advance.cakeOnlyTip}（最早 ${DR.fmtTime(new Date(now.getTime() + CFG.advance.minHours * 3600 * 1000))}）`
        : ''
    })

    this.refreshSlots()
  },

  // 根据当前选中日期重新计算可选时段
  refreshSlots() {
    const date = this.data.dates[this.data.dateIndex]
    if (!date) {
      this.setData({ slots: [], slotIndex: 0 })
      return
    }
    const slots = DR.buildTimeSlots(date.value, new Date())
    // 默认选中第一个可选时段
    this.setData({
      slots,
      slotIndex: 0
    })
  },

  onDateChange(e) {
    this.setData({
      dateIndex: Number(e.detail.value)
    })
    this.refreshSlots()
  },

  onSlotChange(e) {
    this.setData({
      slotIndex: Number(e.detail.value)
    })
  },

  back() {
    wx.navigateBack()
  },

  ok() {
    const date = this.data.dates[this.data.dateIndex]
    const slot = this.data.slots[this.data.slotIndex]

    if (!date || !slot) {
      wx.showToast({
        title: '暂无可选时间，请稍后再试',
        icon: 'none'
      })
      return
    }

    // 组装期望时间：YYYY-MM-DD HH:MM
    const expectTimeStr = `${date.value} ${slot}`
    const expectTime = new Date(expectTimeStr.replace(/-/g, '/'))

    // ===== 下单前再校验一次（防止用户停留过久导致时间失效）=====
    const items = wx.getStorageSync('checkoutItems') || []
    const check = DR.checkAdvanceTime({
      expectTime,
      items,
      now: new Date(),
      openingHours: this.data.openingHours
    })
    if (!check.valid) {
      wx.showToast({
        title: check.tip,
        icon: 'none'
      })
      this.refreshSlots()
      return
    }

    // 展示用文案：今天/明天 15:00
    const timeText = `${date.label} ${slot}`
    wx.setStorageSync('fetchTime', timeText)
    wx.setStorageSync('expectTime', expectTimeStr)
    wx.navigateBack()
  }
})
