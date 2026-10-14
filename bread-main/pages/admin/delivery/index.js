/**
 * 店主端 · 配送设置（阶段 10）
 * ---------------------------------------------------------------------------
 * 对应店主的 R-03「上面可以设置配送费吗？还是根据距离自动匹配配送费」
 * 与 R-05「送多远 / 哪些小区不送」：
 *   · 距离阶梯运费（每档：距离上限 / 运费 / 免运费门槛 / 待确认文案）
 *   · 不送区域（命中即拒外送）
 *   · 外送距离上限（超过不接单）
 *   · 配送范围关键词（收货地址文字命中才算在片区内）
 *   · 蛋糕免配送费规则（6 寸及以上、X 公里内）
 *
 * 三条纪律：
 *   1) **存的是云库**（app_config 的 delivery_rule），改完所有端立刻同口径 ——
 *      服务端下单重算、顾客端结算页显示的都是这一份（阶段 8 的"屏显 = 实付"）；
 *   2) 保存前**服务端显式校验**（deliveryRuleSave）：非法值报错拒绝，不静默回退默认值
 *      （否则店主以为改了、实际没改，钱还按旧规则收）；
 *   3) 关键词要写**完整专名**（如「太平新城」）。写「西山」「太平」这类短词会把
 *      片区外的地址也放进来 —— 服务端会直接拒绝少于 3 个字的词。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const DR = require('../../../utils/delivery-range')
const LOG = require('../../../utils/log')

/** 按行拆关键词（去空行、去首尾空格、去重） */
function splitLines(text) {
  const out = []
  String(text || '')
    .split(/[\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((s) => { if (out.indexOf(s) < 0) out.push(s) })
  return out
}

/** 每档一句话说明（店主自己看得懂的话，不用对着数字想） */
function tierSummary(t) {
  const km = t.maxKm === '' || t.maxKm === null ? '以上全部' : t.maxKm + ' 公里内'
  const free = t.freeAmount === '' || t.freeAmount === null ? '' : '满 ' + t.freeAmount + ' 元免运费'
  const fee = t.fee === '' || t.fee === null
    ? (t.tip ? '运费待确认（' + t.tip + '）' : '运费待确认')
    : '运费 ' + t.fee + ' 元'
  return [km, free, fee].filter(Boolean).join('，')
}

Page({
  data: {
    isAdminUser: false,
    loading: true,
    loaded: false,
    loadError: false,
    saving: false,
    // 距离阶梯（输入框里是字符串：空串 = 不限 / 不设门槛 / 待确认）
    tiers: [],
    // 配送范围关键词与不送区域（多行文本）
    keywordsText: '',
    excludeText: '',
    // 外送距离上限（空 = 不限制）
    forbidBeyondKm: '',
    // 蛋糕免配送费
    cakeEnabled: true,
    cakeFreeWithinKm: '',
    cakeMinSizeInch: '',
    cakeOverrideThreshold: true,
    // 规则说明（给店主看的当前生效规则摘要）
    summaryText: ''
  },

  async onLoad() {
    const allowed = await ADMIN.guardShopAdminPage()
    this.setData({ isAdminUser: allowed })
    if (!allowed) {
      this.setData({ loading: false, loaded: true })
      return
    }
    this.loadRule()
  },

  retryLoad() {
    this.loadRule()
  },

  /**
   * 读取当前生效规则。
   * 来源：appConfig 下发的 `delivery_rule`（**完整的生效规则**，不是云库里的半截覆盖）；
   * 取不到时回退本地默认配置（config/delivery.js），页面不会白屏。
   */
  async loadRule() {
    this.setData({ loading: true, loadError: false })
    const res = await API.appConfig()
    let rule = null
    if (res && res.code == 0 && Array.isArray(res.data)) {
      const row = res.data.filter((x) => x && x.key === 'delivery_rule')[0]
      if (row && row.value && typeof row.value === 'object') rule = row.value
    } else {
      LOG.error('[admin-delivery] 配送规则读取失败', res && res.msg)
      this.setData({ loading: false, loaded: true, loadError: true })
      return
    }
    if (!rule) rule = DR.getDefaultDeliveryRule()
    this._rule = rule

    const tiers = ((rule.freight && rule.freight.tiers) || []).map((t) => ({
      maxKm: t.maxKm === null || t.maxKm === undefined ? '' : String(t.maxKm),
      fee: t.fee === null || t.fee === undefined ? '' : String(t.fee),
      freeAmount: t.freeAmount === null || t.freeAmount === undefined ? '' : String(t.freeAmount),
      tip: t.tip || '',
      summary: tierSummary({
        maxKm: t.maxKm === null || t.maxKm === undefined ? '' : t.maxKm,
        fee: t.fee === null || t.fee === undefined ? '' : t.fee,
        freeAmount: t.freeAmount === null || t.freeAmount === undefined ? '' : t.freeAmount,
        tip: t.tip || ''
      })
    }))

    this.setData({
      loading: false,
      loaded: true,
      loadError: false,
      tiers,
      keywordsText: ((rule.area && rule.area.keywords) || []).join('\n'),
      excludeText: ((rule.area && rule.area.excludeKeywords) || []).join('\n'),
      forbidBeyondKm: rule.area && rule.area.forbidBeyondKm !== null && rule.area.forbidBeyondKm !== undefined
        ? String(rule.area.forbidBeyondKm)
        : '',
      cakeEnabled: !(rule.cake && rule.cake.enabled === false),
      cakeFreeWithinKm: rule.cake && rule.cake.freeWithinKm !== undefined ? String(rule.cake.freeWithinKm) : '3',
      cakeMinSizeInch: rule.cake && rule.cake.minSizeInch !== undefined ? String(rule.cake.minSizeInch) : '6',
      cakeOverrideThreshold: !(rule.cake && rule.cake.overrideThreshold === false),
      summaryText: this.buildSummary(rule)
    })
  },

  buildSummary(rule) {
    const parts = []
    const kw = ((rule.area && rule.area.keywords) || []).join('、')
    parts.push('配送片区：' + (kw || '（未设置关键词，将无法判断是否可送）'))
    const ex = ((rule.area && rule.area.excludeKeywords) || [])
    parts.push('不送区域：' + (ex.length ? ex.join('、') : '无'))
    const forbid = rule.area && rule.area.forbidBeyondKm
    parts.push('外送距离上限：' + (forbid ? forbid + ' 公里（超过不接单）' : '不限制'))
    return parts.join('\n')
  },

  // ===== 阶梯编辑 =====

  onTierInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    const value = String((e.detail && e.detail.value) || '')
    const tiers = this.data.tiers.slice()
    if (!tiers[index] || !field) return
    tiers[index] = Object.assign({}, tiers[index], { [field]: value })
    tiers[index].summary = tierSummary(tiers[index])
    this.setData({ tiers })
  },

  addTier() {
    const tiers = this.data.tiers.slice()
    if (tiers.length >= 6) {
      wx.showToast({ title: '最多 6 档', icon: 'none' })
      return
    }
    const t = { maxKm: '', fee: '', freeAmount: '', tip: '', summary: '' }
    t.summary = tierSummary(t)
    tiers.push(t)
    this.setData({ tiers })
  },

  removeTier(e) {
    const index = Number(e.currentTarget.dataset.index)
    const tiers = this.data.tiers.slice()
    if (tiers.length <= 1) {
      wx.showToast({ title: '至少要留 1 档', icon: 'none' })
      return
    }
    wx.showModal({
      title: '删除这一档',
      content: '删除后这一段的运费不再按此档计算，保存后才生效。',
      confirmText: '删除',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        tiers.splice(index, 1)
        this.setData({ tiers })
      }
    })
  },

  onKeywordsInput(e) {
    this.setData({ keywordsText: String((e.detail && e.detail.value) || '') })
  },

  onExcludeInput(e) {
    this.setData({ excludeText: String((e.detail && e.detail.value) || '') })
  },

  onForbidInput(e) {
    this.setData({ forbidBeyondKm: String((e.detail && e.detail.value) || '') })
  },

  // ===== 蛋糕规则 =====

  onCakeEnabledChange(e) {
    this.setData({ cakeEnabled: !!(e.detail && e.detail.value) })
  },

  onCakeOverrideChange(e) {
    this.setData({ cakeOverrideThreshold: !!(e.detail && e.detail.value) })
  },

  onCakeKmInput(e) {
    this.setData({ cakeFreeWithinKm: String((e.detail && e.detail.value) || '') })
  },

  onCakeInchInput(e) {
    this.setData({ cakeMinSizeInch: String((e.detail && e.detail.value) || '') })
  },

  // ===== 保存 =====

  buildPayload() {
    const base = this._rule || DR.getDefaultDeliveryRule()
    const tiers = this.data.tiers.map((t) => ({
      maxKm: String(t.maxKm).trim() === '' ? null : Number(t.maxKm),
      fee: String(t.fee).trim() === '' ? null : Number(t.fee),
      freeAmount: String(t.freeAmount).trim() === '' ? null : Number(t.freeAmount),
      tip: String(t.tip || '').trim()
    }))
    const cakeKm = String(this.data.cakeFreeWithinKm).trim()
    const cakeInch = String(this.data.cakeMinSizeInch).trim()
    return {
      // area / cake 都用「当前生效规则」打底再覆盖改动项，避免把没展示的字段（mode/polygon/文案）抹掉
      area: Object.assign({}, base.area || {}, {
        keywords: splitLines(this.data.keywordsText),
        excludeKeywords: splitLines(this.data.excludeText),
        forbidBeyondKm: String(this.data.forbidBeyondKm).trim() === ''
          ? null
          : Number(this.data.forbidBeyondKm)
      }),
      freight: {
        tiers,
        unknownTip: (base.freight && base.freight.unknownTip) || undefined
      },
      cake: Object.assign({}, base.cake || {}, {
        enabled: !!this.data.cakeEnabled,
        freeWithinKm: cakeKm === '' ? (base.cake && base.cake.freeWithinKm) || 3 : Number(cakeKm),
        minSizeInch: cakeInch === '' ? (base.cake && base.cake.minSizeInch) || 6 : Number(cakeInch),
        overrideThreshold: !!this.data.cakeOverrideThreshold
      })
    }
  },

  async save() {
    if (this.data.saving) return
    const payload = this.buildPayload()
    // 清空配送范围 = 所有顾客都无法外送（服务端也会拒，但这里先说清楚，别让她白跑一趟）
    if (!payload.area.keywords.length) {
      wx.showToast({
        title: '配送范围不能为空，否则顾客都无法外送；只想自提请把距离上限设小',
        icon: 'none'
      })
      return
    }
    // 前端先自查明显错误（服务端还会再校验一遍）；关键词太短是最容易犯的错
    for (const kw of payload.area.keywords.concat(payload.area.excludeKeywords)) {
      if (kw.length < 3) {
        wx.showToast({ title: '「' + kw + '」太短，请写完整小区/道路名', icon: 'none' })
        return
      }
    }
    for (let i = 0; i < payload.freight.tiers.length; i++) {
      const t = payload.freight.tiers[i]
      if (t.maxKm !== null && (!isFinite(t.maxKm) || t.maxKm <= 0)) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 档的距离上限要大于 0', icon: 'none' })
        return
      }
      if (t.fee !== null && (!isFinite(t.fee) || t.fee < 0)) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 档的运费不能为空或负数', icon: 'none' })
        return
      }
      if (t.freeAmount !== null && (!isFinite(t.freeAmount) || t.freeAmount < 0)) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 档的免运费门槛不能为空或负数', icon: 'none' })
        return
      }
    }
    this.setData({ saving: true })
    try {
      const res = await API.adminDeliverySave(payload)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存，立即生效', icon: 'success' })
      // 用服务端归一化后的规则回填：页面上看到的就是真正生效的那一份
      if (res.data && res.data.rule) {
        this._rule = res.data.rule
        this.setData({ summaryText: this.buildSummary(res.data.rule) })
      }
    } finally {
      this.setData({ saving: false })
    }
  }
})
