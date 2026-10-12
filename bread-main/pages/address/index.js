/**
 * 收货地址列表
 * ---------------------------------------------------------------------------
 * 数据层：utils/address.js（当前本地 storage，后续可换云开发，调用方式不变）
 *
 * 两种进入方式：
 *   1. 「我的」→ 收货地址管理     → 纯管理，点击卡片不做跳转
 *   2. 结算页 → 选择收货地址(?select=1) → 点击卡片返回上一页并带回地址
 * ---------------------------------------------------------------------------
 */
const ADDR = require('../../utils/address')

Page({
  data: {
    list: [],
    // 是否为「选择模式」（从结算页进入）
    selectMode: false
  },

  onLoad(options) {
    this.setData({
      selectMode: options && options.select === '1'
    })
    wx.setNavigationBarTitle({
      title: this.data.selectMode ? '选择收货地址' : '收货地址'
    })
  },

  // 每次显示都重新读取：从编辑页返回时能看到最新数据
  onShow() {
    this.loadList()
  },

  loadList() {
    const raw = ADDR.getList()
    // 预拼完整地址文字，避免在 wxml 里做字符串拼接
    const list = raw.map((a) => Object.assign({}, a, {
      fullText: ADDR.formatFull(a)
    }))
    this.setData({ list })
  },

  // ===== 新增 =====
  onAdd() {
    wx.navigateTo({
      url: '/pages/address/edit'
    })
  },

  // ===== 编辑 =====
  onEdit(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/address/edit?id=' + id
    })
  },

  // ===== 删除（二次确认，避免误删）=====
  onDelete(e) {
    const id = e.currentTarget.dataset.id
    const target = ADDR.getById(id)
    if (!target) return
    wx.showModal({
      title: '删除地址',
      content: '确定删除「' + target.name + ' ' + target.phone + '」这个地址吗？',
      confirmText: '删除',
      confirmColor: '#ff2d2d',
      success: (res) => {
        if (!res.confirm) return
        ADDR.remove(id)
        this.loadList()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  // ===== 设为默认 =====
  onSetDefault(e) {
    const id = e.currentTarget.dataset.id
    const target = ADDR.getById(id)
    if (!target || target.isDefault) return
    ADDR.setDefault(id)
    this.loadList()
  },

  // ===== 点击卡片 =====
  onCardTap(e) {
    if (!this.data.selectMode) return // 管理模式：点击卡片不做任何事
    const id = e.currentTarget.dataset.id
    const addr = ADDR.getById(id)
    if (!addr) return
    // 把选中的地址放进上一页，由结算页读取。
    // 阶段 5.3（缺陷 P-02）：**同时**注入展示文案 addressText。
    //   结算页 wxml 渲染的是 addressText（selectedAddress 只用于下单快照），
    //   原来这里只注入 selectedAddress → 屏幕上仍显示上一个地址。
    //   结算页的 onShow 也会重新同步一次（双保险，见 pages/pay/index.js 的 applyAddress 调用）。
    const fullText = ADDR.formatFull(addr) || addr.detail || ''
    const pages = getCurrentPages()
    const prev = pages[pages.length - 2]
    if (prev && typeof prev.setData === 'function') {
      prev.setData({
        selectedAddress: Object.assign({}, addr, { fullText }),
        addressText: fullText
      })
    }
    wx.navigateBack()
  }
})
