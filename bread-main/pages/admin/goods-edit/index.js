/**
 * 店主端 · 商品新增 / 编辑（阶段 10）
 * ---------------------------------------------------------------------------
 * 这一页就是店主原话里要的东西：
 *   · R-07「后期我是可以修改的嘛？」→ 名称/分类/价格/图片/详情都能改；
 *   · R-08「有用户端跟商家端吧」→ 这是商家端的商品编辑页；
 *   · 阶段 9 的四个新机制也在这里配：规格组（含夹心/奶油等加价组）、
 *     自取立减、打包费、最少购买份数；以及上下架与排序。
 *
 * 三条约定：
 *   1) **所有金额与校验以服务端为准**：前端只做"好心的提示"，服务端
 *      `goodsUpsert` 会重新校验（价格 > 0、规格组 id 唯一、选项 id 唯一…）；
 *   2) **图片必须先上传成功**：`wxfile://` 这类本地临时路径写进库里就是顾客端裂图，
 *      所以上传没成功时保存按钮直接拦住（与「我的」页头像同一类防呆）；
 *   3) 商品 id 由云库生成；规格组/选项的 id 本地生成（`g1` / `o1` 递增），
 *      它们是计价与 sku 拼接的键，一旦有顾客下过单就**不要改名**（页面里有提示）。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const LOG = require('../../../utils/log')

/** 生成不重复的规格组/选项 id（服务端要求 1~32 位字母数字下划线短横线） */
function nextId(prefix, list) {
  let i = 1
  while (list.some((x) => String(x.id) === prefix + i)) i++
  return prefix + i
}

/**
 * 分类下拉的显示名。
 * 已停用的分类**照样列出来并标注** —— 否则挂在停用分类下的商品会因为 picker
 * 找不到自己的分类而回落到第一项，店主"只改个价"就把商品挪走了（顾客端直接看不到）。
 */
function categoryLabel(c) {
  return c.enabled === false ? c.name + '（已停用）' : c.name
}

Page({
  data: {
    isAdminUser: false,
    loading: true,
    loaded: false,
    loadError: false,
    isCreate: true,
    goodsId: '',
    // 基本字段（textarea/input 的值都用字符串，避免数字键盘把 null 变成 'null'）
    name: '',
    categoryNames: [],
    categories: [],
    categoryIndex: 0,
    minPrice: '',
    unit: '个',
    characteristic: '',
    purchaseNotes: '',
    content: '',
    sort: '10',
    enabled: true,
    pickupDiscount: '',
    packingFee: '',
    minBuyNumber: '1',
    // 图片（已上传成功的地址；第一张作为列表缩略图）
    pics: [],
    uploading: false,
    // 规格组：[{ id, name, childsCurGoods: [{ id, name, priceDelta }] }]
    specGroups: [],
    saving: false
  },

  async onLoad(options) {
    const allowed = await ADMIN.guardShopAdminPage()
    this.setData({ isAdminUser: allowed })
    if (!allowed) {
      this.setData({ loading: false, loaded: true })
      return
    }
    const id = (options && options.id) || ''
    if (id) {
      this.setData({ isCreate: false, goodsId: id })
      await this.loadGoods(id)
    } else {
      this.setData({ isCreate: true, goodsId: '' })
      await this.loadCategories()
      this.setData({ loading: false, loaded: true })
    }
  },

  retryLoad() {
    if (this.data.isCreate) {
      this.loadCategories().then(() => this.setData({ loading: false, loaded: true, loadError: false }))
      return
    }
    this.loadGoods(this.data.goodsId)
  },

  /**
   * 读分类列表。
   * 说明：与编辑数据走同一个接口（adminGoodsList 顺带返回可选的分类），
   *       少一个只给店主用的接口，也就少一处权限面。
   */
  async loadCategories() {
    const res = await API.adminGoodsList({})
    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-goods-edit] 分类读取失败', res && res.msg)
      this.setData({ loadError: true })
      return []
    }
    const cats = Array.isArray(res.data.categories) ? res.data.categories : []
    this.setData({
      categories: cats,
      categoryNames: cats.map(categoryLabel)
    })
    return cats
  },

  async loadGoods(id) {
    this.setData({ loading: true, loadError: false })
    const res = await API.adminGoodsList({})
    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-goods-edit] 商品读取失败', res && res.msg)
      this.setData({ loading: false, loaded: true, loadError: true })
      return
    }
    const cats = Array.isArray(res.data.categories) ? res.data.categories : []
    const list = Array.isArray(res.data.result) ? res.data.result : []
    const g = list.filter((x) => String(x.id) === String(id))[0]
    if (!g) {
      this.setData({ loading: false, loaded: true, loadError: true })
      wx.showToast({ title: '商品不存在，可能已被删除', icon: 'none' })
      return
    }
    const categoryIndex = Math.max(0, cats.map((c) => String(c.id)).indexOf(String(g.categoryId)))
    this.setData({
      loading: false,
      loaded: true,
      loadError: false,
      categories: cats,
      categoryNames: cats.map(categoryLabel),
      categoryIndex,
      name: g.name || '',
      minPrice: String(g.minPrice === undefined ? '' : g.minPrice),
      unit: g.unit || '个',
      characteristic: g.characteristic || '',
      purchaseNotes: g.purchaseNotes || '',
      content: g.content || '',
      sort: String(g.sort === undefined ? 0 : g.sort),
      enabled: g.enabled !== false,
      pickupDiscount: g.pickupDiscount ? String(g.pickupDiscount) : '',
      packingFee: g.packingFee ? String(g.packingFee) : '',
      minBuyNumber: String(g.minBuyNumber || 1),
      pics: Array.isArray(g.pics) ? g.pics.slice() : (g.pic ? [g.pic] : []),
      specGroups: (Array.isArray(g.properties) ? g.properties : []).map((grp) => ({
        id: String(grp.id),
        name: grp.name || '',
        childsCurGoods: ((grp && grp.childsCurGoods) || []).map((c) => ({
          id: String(c.id),
          name: c.name || '',
          priceDelta: String(Number(c.priceDelta) || 0)
        }))
      }))
    })
  },

  // ===== 基本字段输入 =====
  onNameInput(e) { this.setData({ name: String((e.detail && e.detail.value) || '') }) },
  onPriceInput(e) { this.setData({ minPrice: String((e.detail && e.detail.value) || '') }) },
  onUnitInput(e) { this.setData({ unit: String((e.detail && e.detail.value) || '') }) },
  onCharInput(e) { this.setData({ characteristic: String((e.detail && e.detail.value) || '') }) },
  onNoteInput(e) { this.setData({ purchaseNotes: String((e.detail && e.detail.value) || '') }) },
  onContentInput(e) { this.setData({ content: String((e.detail && e.detail.value) || '') }) },
  onSortInput(e) { this.setData({ sort: String((e.detail && e.detail.value) || '') }) },
  onDiscountInput(e) { this.setData({ pickupDiscount: String((e.detail && e.detail.value) || '') }) },
  onPackingInput(e) { this.setData({ packingFee: String((e.detail && e.detail.value) || '') }) },
  onMinBuyInput(e) { this.setData({ minBuyNumber: String((e.detail && e.detail.value) || '') }) },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) || 0 })
  },

  onEnabledChange(e) {
    this.setData({ enabled: !!(e.detail && e.detail.value) })
  },

  // ===== 图片 =====

  /** 选图 → 立即上传到云存储（拿到 fileID 才算成功） */
  pickImage() {
    if (this.data.uploading) return
    const that = this
    wx.chooseMedia({
      count: Math.max(1, 5 - this.data.pics.length),
      mediaType: ['image'],
      sizeType: ['compressed'],
      success(res) {
        const files = (res && res.tempFiles) || []
        files.forEach((f) => that.uploadOne(f.tempFilePath))
      },
      fail(err) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return
        LOG.error('[admin-goods-edit] chooseMedia 失败', err)
        wx.showToast({ title: '选择图片失败，请重试', icon: 'none' })
      }
    })
  },

  async uploadOne(tempPath) {
    if (!tempPath) return
    const ext = (/\.(png|jpg|jpeg|webp)$/i.exec(tempPath) || [null, 'jpg'])[1].toLowerCase()
    const idPart = this.data.goodsId || 'new'
    const cloudPath = 'goods/' + idPart + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext
    // ★ 上传计数而不是布尔量：一次可选多张（chooseMedia count>1），并发的上传
    //   各自 setData 会让"上传中"标志提前变 false —— 保存时就会把没传完的图漏掉。
    this._uploading = (this._uploading || 0) + 1
    this.setData({ uploading: true })
    const res = await API.uploadFile(tempPath, cloudPath)
    this._uploading = Math.max(0, (this._uploading || 1) - 1)
    this.setData({ uploading: this._uploading > 0 })
    if (!res || res.code != 0 || !res.fileID) {
      LOG.error('[admin-goods-edit] 图片上传失败', res && res.msg)
      wx.showToast({ title: (res && res.msg) || '图片上传失败，请重试', icon: 'none' })
      return
    }
    // 读"当前"的 pics 再追加：并发上传时不会互相覆盖（每张图都保留）
    const pics = this.data.pics.slice()
    if (pics.indexOf(res.fileID) < 0) pics.push(res.fileID)
    this.setData({ pics })
  },

  removePic(e) {
    const index = Number(e.currentTarget.dataset.index)
    const pics = this.data.pics.slice()
    pics.splice(index, 1)
    this.setData({ pics })
  },

  previewPic(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!this.data.pics.length) return
    wx.previewImage({ current: this.data.pics[index], urls: this.data.pics })
  },

  // ===== 规格组 =====

  addGroup() {
    if (this.data.specGroups.length >= 8) {
      wx.showToast({ title: '最多 8 组规格', icon: 'none' })
      return
    }
    const groups = this.data.specGroups.slice()
    groups.push({
      id: nextId('g', groups),
      name: '',
      childsCurGoods: [{ id: 'o1', name: '', priceDelta: '0' }]
    })
    this.setData({ specGroups: groups })
  },

  removeGroup(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const groups = this.data.specGroups.slice()
    const g = groups[gi]
    if (!g) return
    wx.showModal({
      title: '删除规格组',
      content: '删除「' + (g.name || '未命名规格组') + '」后，这项规格不再出现在商品详情页。已下过的订单不受影响。',
      confirmText: '删除',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        groups.splice(gi, 1)
        this.setData({ specGroups: groups })
      }
    })
  },

  onGroupNameInput(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const groups = this.data.specGroups.slice()
    if (!groups[gi]) return
    groups[gi] = Object.assign({}, groups[gi], { name: String((e.detail && e.detail.value) || '') })
    this.setData({ specGroups: groups })
  },

  addOption(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const groups = this.data.specGroups.slice()
    const g = groups[gi]
    if (!g) return
    if (g.childsCurGoods.length >= 20) {
      wx.showToast({ title: '每组最多 20 个选项', icon: 'none' })
      return
    }
    const childs = g.childsCurGoods.slice()
    childs.push({ id: nextId('o', childs), name: '', priceDelta: '0' })
    groups[gi] = Object.assign({}, g, { childsCurGoods: childs })
    this.setData({ specGroups: groups })
  },

  removeOption(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    const groups = this.data.specGroups.slice()
    const g = groups[gi]
    if (!g) return
    if (g.childsCurGoods.length <= 1) {
      wx.showToast({ title: '每组至少留 1 个选项', icon: 'none' })
      return
    }
    const childs = g.childsCurGoods.slice()
    childs.splice(oi, 1)
    groups[gi] = Object.assign({}, g, { childsCurGoods: childs })
    this.setData({ specGroups: groups })
  },

  onOptionNameInput(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    const groups = this.data.specGroups.slice()
    const g = groups[gi]
    if (!g || !g.childsCurGoods[oi]) return
    const childs = g.childsCurGoods.slice()
    childs[oi] = Object.assign({}, childs[oi], { name: String((e.detail && e.detail.value) || '') })
    groups[gi] = Object.assign({}, g, { childsCurGoods: childs })
    this.setData({ specGroups: groups })
  },

  onOptionDeltaInput(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    const groups = this.data.specGroups.slice()
    const g = groups[gi]
    if (!g || !g.childsCurGoods[oi]) return
    const childs = g.childsCurGoods.slice()
    childs[oi] = Object.assign({}, childs[oi], { priceDelta: String((e.detail && e.detail.value) || '') })
    groups[gi] = Object.assign({}, g, { childsCurGoods: childs })
    this.setData({ specGroups: groups })
  },

  // ===== 校验 + 保存 =====

  /** 前端校验（服务端还会再校验一遍，这里只是让店主少跑一趟） */
  validate() {
    const d = this.data
    const name = String(d.name || '').trim()
    if (!name) return { ok: false, msg: '请填写商品名称' }
    if (name.length > 40) return { ok: false, msg: '商品名称最多 40 个字' }
    if (!d.categories[d.categoryIndex]) return { ok: false, msg: '请选择商品分类' }
    if (!d.pics.length) return { ok: false, msg: '请先上传商品图片' }
    if (d.uploading) return { ok: false, msg: '图片还在上传中，请稍候' }
    const price = Number(d.minPrice)
    if (!isFinite(price) || price <= 0) return { ok: false, msg: '价格必须大于 0' }
    const discount = d.pickupDiscount === '' ? 0 : Number(d.pickupDiscount)
    if (!isFinite(discount) || discount < 0) return { ok: false, msg: '自取立减不能为空或负数' }
    if (discount >= price) return { ok: false, msg: '自取立减不能大于等于商品价格' }
    const packing = d.packingFee === '' ? 0 : Number(d.packingFee)
    if (!isFinite(packing) || packing < 0) return { ok: false, msg: '打包费不能为空或负数' }
    const minBuy = Number(d.minBuyNumber === '' ? 1 : d.minBuyNumber)
    if (!isFinite(minBuy) || Math.floor(minBuy) !== minBuy || minBuy < 1) {
      return { ok: false, msg: '最少购买份数必须是不小于 1 的整数' }
    }
    const sort = d.sort === '' ? 0 : Number(d.sort)
    if (!isFinite(sort) || Math.floor(sort) !== sort || sort < 0) {
      return { ok: false, msg: '排序必须是不小于 0 的整数' }
    }
    const groups = []
    for (let i = 0; i < d.specGroups.length; i++) {
      const g = d.specGroups[i]
      const gname = String(g.name || '').trim()
      if (!gname) return { ok: false, msg: '第 ' + (i + 1) + ' 组规格还没填名称' }
      const childs = []
      for (let j = 0; j < g.childsCurGoods.length; j++) {
        const c = g.childsCurGoods[j]
        const cname = String(c.name || '').trim()
        if (!cname) return { ok: false, msg: '「' + gname + '」里第 ' + (j + 1) + ' 个选项还没填名称' }
        const delta = c.priceDelta === '' ? 0 : Number(c.priceDelta)
        if (!isFinite(delta) || delta < 0) {
          return { ok: false, msg: '「' + gname + '」的「' + cname + '」加价必须是不小于 0 的数字' }
        }
        childs.push({ id: c.id, name: cname, priceDelta: delta })
      }
      groups.push({ id: g.id, name: gname, childsCurGoods: childs })
    }
    return {
      ok: true,
      payload: {
        name,
        categoryId: d.categories[d.categoryIndex].id,
        minPrice: price,
        unit: String(d.unit || '个').trim() || '个',
        characteristic: String(d.characteristic || '').trim(),
        purchaseNotes: String(d.purchaseNotes || '').trim(),
        content: String(d.content || '').trim(),
        sort,
        enabled: !!d.enabled,
        pickupDiscount: discount,
        packingFee: packing,
        minBuyNumber: minBuy,
        pics: d.pics,
        properties: groups
      }
    }
  },

  async save() {
    if (this.data.saving) return
    const v = this.validate()
    if (!v.ok) {
      wx.showToast({ title: v.msg, icon: 'none' })
      return
    }
    const payload = v.payload
    if (!this.data.isCreate) payload.id = this.data.goodsId
    this.setData({ saving: true })
    try {
      const res = await API.adminGoodsUpsert(payload)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: this.data.isCreate ? '已新增' : '已保存', icon: 'success' })
      // 新增成功后记下 id：接着再改一次图/规格就不会重复建商品
      if (res.data && res.data.id) this.setData({ goodsId: res.data.id, isCreate: false })
      setTimeout(() => wx.navigateBack(), 700)
    } finally {
      this.setData({ saving: false })
    }
  }
})
