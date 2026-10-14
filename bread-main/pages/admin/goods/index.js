/**
 * 店主端 · 商品列表（阶段 10）
 * ---------------------------------------------------------------------------
 * 与顾客端点单页的区别（这是"店主能不能自助改菜单"的关键）：
 *   1) 用 `goodsAdminList`（云函数 requireAdmin）—— **包含已下架商品**，
 *      顾客端 goodsList 只返回 enabled:true，下架后店主就再也找不回那个商品；
 *   2) 每行给出「价格区间 / 规格组数 / 排序 / 上下架状态」，点进去就是编辑页；
 *   3) 上下架必须二次确认（下架 = 顾客端立即看不到，误触代价高）。
 *
 * 「删除」的语义：本页只提供**下架**（软删 enabled:false），不物理删除 ——
 *   历史订单是快照，删不删都不影响，但物理删掉就无法恢复。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const LOG = require('../../../utils/log')

/** 分类下拉显示名：已停用的分类照样列出来并标注（否则商品会被悄悄挪到别的分类） */
function categoryLabel(c) {
  return c.enabled === false ? c.name + '（已停用）' : c.name
}

Page({
  data: {
    isAdminUser: false,
    loading: true,
    loaded: false,
    loadError: false,
    // 在售 / 已下架 分组（同一个接口返回，这里按 enabled 拆开渲染）
    onSaleList: [],
    offSaleList: [],
    total: 0,
    // 搜索与分类筛选（服务端过滤：categoryId / keyword）
    keyword: '',
    categoryNames: ['全部分类'],
    categories: [],
    categoryIndex: 0,
    // 正在切换上下架的商品 id（防连点）
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
    // 从编辑页返回后要看到最新结果（改完价/换完图立刻确认一眼）
    if (this.data.isAdminUser && this.data.loaded) this.loadList()
  },

  retryLoad() {
    this.loadList()
  },

  async loadList() {
    this.setData({ loading: true, loadError: false })
    const cats = this.data.categories
    // 下拉第 0 项是「全部分类」（不传 categoryId）；其余项对应 cats[index-1]
    const picked = this.data.categoryIndex > 0 ? cats[this.data.categoryIndex - 1] : null
    const categoryId = picked ? picked.id : ''
    const res = await API.adminGoodsList({ categoryId, keyword: this.data.keyword })
    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-goods] 加载失败', res && res.msg)
      this.setData({ loading: false, loaded: true, loadError: true })
      return
    }
    const list = Array.isArray(res.data.result) ? res.data.result : []
    // 分类下拉只在第一次（或结构变化时）更新，避免店主选完分类后被重置
    const remoteCats = Array.isArray(res.data.categories) ? res.data.categories : []
    const nextCategories = this.data.categories.length ? cats : remoteCats
    this.setData({
      onSaleList: list.filter((g) => g.enabled),
      offSaleList: list.filter((g) => !g.enabled),
      total: Number(res.data.total || list.length),
      categories: nextCategories,
      categoryNames: ['全部分类'].concat(nextCategories.map(categoryLabel)),
      loading: false,
      loaded: true,
      loadError: false
    })
  },

  onKeywordInput(e) {
    this.setData({ keyword: String((e.detail && e.detail.value) || '') })
  },

  doSearch() {
    this.loadList()
  },

  clearKeyword() {
    this.setData({ keyword: '' })
    this.loadList()
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) || 0 })
    this.loadList()
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/admin/goods-edit/index' })
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/admin/goods-edit/index?id=' + id })
  },

  /**
   * 上架 / 下架（二次确认）。
   * 服务端 goodsUpsert 支持"只传 id + enabled"的部分更新 —— 不必把整个商品回传。
   */
  toggleEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    const fromOnSale = e.currentTarget.dataset.group === 'on'
    const list = fromOnSale ? this.data.onSaleList : this.data.offSaleList
    const g = list[index]
    if (!g || this.data.togglingId) return
    const next = !g.enabled
    wx.showModal({
      title: next ? '重新上架' : '下架商品',
      content: next
        ? '「' + g.name + '」会立即出现在顾客点单页。确认上架？'
        : '「' + g.name + '」下架后顾客立即看不到（不会删除，历史订单不受影响），随时可以重新上架。',
      confirmText: next ? '上架' : '下架',
      cancelText: '取消',
      success: (r) => {
        if (r.confirm) this.doToggle(g, next)
      }
    })
  },

  async doToggle(g, enabled) {
    this.setData({ togglingId: g.id })
    try {
      const res = await API.adminGoodsUpsert({ id: g.id, enabled })
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' })
        return
      }
      wx.showToast({ title: enabled ? '已上架' : '已下架', icon: 'none' })
      await this.loadList()
    } finally {
      this.setData({ togglingId: '' })
    }
  },

  /** 复制商品名（发给顾客/做活动文案时用得上，避免店主手动打字打错） */
  copyName(e) {
    const name = e.currentTarget.dataset.name || ''
    if (!name) return
    wx.setClipboardData({ data: String(name) })
  }
})
