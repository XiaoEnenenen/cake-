/**
 * 店主端 · 优惠券 / 满减列表（阶段 11）
 * ---------------------------------------------------------------------------
 * 对应店主原话（R-01）：「可以发布优惠券活动吗？比如新客立减多少，满多少减多少
 * 这种活动」→「想要我自己可以设置这个，有权限」。
 *
 * 这一页做什么：
 *   · 列出全部券（含已停用 —— 停用后还要能重新启用，不能藏起来）；
 *   · 显示券面规则（满 ¥X 减 ¥Y / 新客立减 ¥Y）、有效期、已用次数、当前状态；
 *   · 点进去编辑；右侧可按「停用 / 启用」（二次确认，服务端只改 enabled）；
 *   · 底部「新建优惠券」。
 *
 * 纪律：
 *   1) 金额/状态/使用量全部由服务端 `couponAdminList` 算好（前端不重复实现一套规则）；
 *   2) 停用走 `couponUpsert` 的快速通道（只传 { id, enabled }），不重新校验其它字段；
 *   3) 券的使用次数 `usedCount` 只由服务端在下单时累加，店主改不了（防刷量）。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const LOG = require('../../../utils/log')

/** 状态统计的一行文字（店主一眼看活动现状） */
function statsTextOf(counts) {
  const c = counts || {}
  const n = (k) => Number(c[k] || 0)
  return '进行中 ' + n('active') +
    ' · 未开始 ' + n('pending') +
    ' · 已结束 ' + n('expired') +
    ' · 已停用 ' + n('disabled')
}

Page({
  data: {
    isAdminUser: false,
    loading: true,
    loaded: false,
    loadError: false,
    couponList: [],
    total: 0,
    statsText: '',
    // 正在切启用/停用的券 id（防连点）
    togglingId: ''
  },

  async onLoad() {
    const allowed = await ADMIN.guardShopAdminPage()
    this.setData({ isAdminUser: allowed })
    if (!allowed) {
      this.setData({ loading: false, loaded: true })
      return
    }
    this.loadList()
  },

  onShow() {
    // 从新建/编辑页返回后刷新，店主能立刻看到改完的结果
    if (this.data.isAdminUser && this.data.loaded) this.loadList()
  },

  retryLoad() {
    this.loadList()
  },

  async loadList() {
    this.setData({ loading: true, loadError: false })
    const res = await API.adminCouponList()
    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-coupons] 加载失败', res && res.msg)
      this.setData({ loading: false, loaded: true, loadError: true })
      return
    }
    const list = Array.isArray(res.data.couponList) ? res.data.couponList : []
    this.setData({
      couponList: list,
      total: Number(res.data.total || list.length),
      statsText: statsTextOf(res.data.statusCounts),
      loading: false,
      loaded: true,
      loadError: false
    })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/admin/coupons-edit/index' })
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/admin/coupons-edit/index?id=' + id })
  },

  /**
   * 停用 / 启用（二次确认）。
   * 「停用」= 顾客端立即看不到这张券，但**不删除**（使用记录与订单快照都保留），随时可再启用。
   */
  toggleEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    const c = this.data.couponList[index]
    if (!c || this.data.togglingId) return
    const next = !c.enabled
    wx.showModal({
      title: next ? '启用优惠券' : '停用优惠券',
      content: next
        ? '「' + c.name + '」会立即重新出现在顾客结算页（仍在有效期内才可用）。确认启用？'
        : '「' + c.name + '」停用后顾客端立即看不到、也不能再用；不会删除，随时可以重新启用。',
      confirmText: next ? '启用' : '停用',
      cancelText: '取消',
      success: (r) => {
        if (r.confirm) this.doToggle(c, next)
      }
    })
  },

  async doToggle(c, enabled) {
    this.setData({ togglingId: c.id })
    try {
      const res = await API.adminCouponUpsert({ id: c.id, enabled: enabled })
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' })
        return
      }
      wx.showToast({ title: enabled ? '已启用' : '已停用', icon: 'none' })
      await this.loadList()
    } finally {
      this.setData({ togglingId: '' })
    }
  }
})
