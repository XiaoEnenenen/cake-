/**
 * 店主端 · 新建 / 编辑优惠券（阶段 11）
 * ---------------------------------------------------------------------------
 * 对应店主原话（R-01）：「新客立减多少，满多少减多少这种活动」→「想要我自己可以设置」。
 *
 * 这一页让她自己填：
 *   · 券名（顾客看得到，建议写清活动，如"新客立减 10 元"）；
 *   · 类型：满减（满 X 减 Y）/ 新客立减（只给没下过单的顾客，每人 1 次）；
 *   · 有效期（开始/结束日期 + 时刻，默认 7 天）；
 *   · 总量（0 = 不限，用于"前 100 单"这类活动）；
 *   · 每人限用（满减券可用；新客券由服务端强制 1 次，页面会说明）；
 *   · 排序 / 是否启用。
 *
 * 三条防呆（都对应真金白银）：
 *   1) 优惠金额必须**小于**满减门槛 —— 否则实付 0，等于白送；
 *   2) 结束时间必须晚于开始时间，且不能是"过去的时间"（建一张永远用不了的券）；
 *   3) 提交前前端先自查一遍，服务端 couponUpsert 再独立校验一遍（不信前端）。
 * 时间由前端组装成**毫秒时间戳**提交（避免字符串在云函数 UTC 时区里被解析歪一天）。
 * ---------------------------------------------------------------------------
 */
const API = require('../../../utils/api-map')
const ADMIN = require('../../../utils/admin')
const LOG = require('../../../utils/log')

const DAY_MS = 24 * 3600 * 1000
const TYPE_NAMES = ['满减（满 X 减 Y）', '新客立减']

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** Date → 'YYYY-MM-DD' */
function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** 时间戳 → { date: 'YYYY-MM-DD', time: 'HH:mm' }（本地时区，店主手机上就是她看到的那个时间） */
function splitDateTime(ms) {
  const d = new Date(Number(ms) || Date.now())
  return { date: ymd(d), time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
}

/** 'YYYY-MM-DD' + 'HH:mm' → 毫秒时间戳（本地时区）；非法返回 NaN */
function combineTime(dateStr, timeStr) {
  const d = String(dateStr || '').trim()
  const t = String(timeStr || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) return NaN
  const ts = new Date((d + ' ' + t).replace(/-/g, '/')).getTime()
  return isFinite(ts) ? ts : NaN
}

Page({
  data: {
    isAdminUser: false,
    loading: true,
    loaded: false,
    loadError: false,
    isCreate: true,
    couponId: '',
    // 表单（输入框里都是字符串，提交前再转数字）
    name: '',
    typeNames: TYPE_NAMES,
    typeIndex: 0,
    threshold: '',
    amount: '',
    startDate: '',
    startTimeText: '00:00',
    endDate: '',
    endTimeText: '23:59',
    totalLimit: '0',
    perUserLimit: '1',
    sort: '10',
    enabled: true,
    // 给店主看的说明（随类型变化）
    typeHint: '',
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
      this.setData({ isCreate: false, couponId: id })
      await this.loadCoupon(id)
    } else {
      this.setData({ isCreate: true, couponId: '' })
      this.initDefaults()
      this.setData({ loading: false, loaded: true })
    }
  },

  retryLoad() {
    if (this.data.isCreate) {
      this.initDefaults()
      this.setData({ loading: false, loaded: true, loadError: false })
      return
    }
    this.loadCoupon(this.data.couponId)
  },

  /** 新建时的默认值：名称留空、7 天有效、总量不限、每人 1 次 */
  initDefaults() {
    const now = new Date()
    const end = new Date(now.getTime() + 7 * DAY_MS)
    this.setData({
      name: '',
      typeIndex: 0,
      threshold: '',
      amount: '',
      startDate: ymd(now),
      startTimeText: '00:00',
      endDate: ymd(end),
      endTimeText: '23:59',
      totalLimit: '0',
      perUserLimit: '1',
      sort: '10',
      enabled: true
    })
    this.refreshTypeHint()
  },

  async loadCoupon(id) {
    this.setData({ loading: true, loadError: false })
    const res = await API.adminCouponList()
    if (!res || res.code != 0 || !res.data) {
      LOG.error('[admin-coupons-edit] 券读取失败', res && res.msg)
      this.setData({ loading: false, loaded: true, loadError: true })
      return
    }
    const list = Array.isArray(res.data.couponList) ? res.data.couponList : []
    const c = list.filter((x) => String(x.id) === String(id))[0]
    if (!c) {
      this.setData({ loading: false, loaded: true, loadError: true })
      wx.showToast({ title: '优惠券不存在，可能已被删除', icon: 'none' })
      return
    }
    const start = splitDateTime(c.startTime)
    const end = splitDateTime(c.endTime)
    this.setData({
      loading: false,
      loaded: true,
      loadError: false,
      isCreate: false,
      couponId: c.id,
      name: c.name || '',
      typeIndex: c.type === 'newCustomer' ? 1 : 0,
      threshold: c.threshold ? String(c.threshold) : '',
      amount: String(c.amount === undefined ? '' : c.amount),
      startDate: start.date,
      startTimeText: start.time,
      endDate: end.date,
      endTimeText: end.time,
      totalLimit: String(c.totalLimit || 0),
      perUserLimit: String(c.perUserLimit || 0),
      sort: String(c.sort === undefined ? 10 : c.sort),
      enabled: c.enabled !== false
    })
    this.refreshTypeHint()
  },

  // ===== 表单事件 =====
  onNameInput(e) { this.setData({ name: String((e.detail && e.detail.value) || '') }) },
  onAmountInput(e) { this.setData({ amount: String((e.detail && e.detail.value) || '') }) },
  onThresholdInput(e) { this.setData({ threshold: String((e.detail && e.detail.value) || '') }) },
  onTotalLimitInput(e) { this.setData({ totalLimit: String((e.detail && e.detail.value) || '') }) },
  onPerUserLimitInput(e) { this.setData({ perUserLimit: String((e.detail && e.detail.value) || '') }) },
  onSortInput(e) { this.setData({ sort: String((e.detail && e.detail.value) || '') }) },
  onStartDateChange(e) { this.setData({ startDate: String(e.detail.value || '') }) },
  onStartTimeChange(e) { this.setData({ startTimeText: String(e.detail.value || '') }) },
  onEndDateChange(e) { this.setData({ endDate: String(e.detail.value || '') }) },
  onEndTimeChange(e) { this.setData({ endTimeText: String(e.detail.value || '') }) },
  onEnabledChange(e) { this.setData({ enabled: !!(e.detail && e.detail.value) }) },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) === 1 ? 1 : 0 })
    this.refreshTypeHint()
  },

  /** 「7 天 / 30 天」快捷设置结束日期（店主最常用的两种活动周期） */
  setDuration(e) {
    const days = Number(e.currentTarget.dataset.days)
    if (!isFinite(days) || days <= 0) return
    const start = combineTime(this.data.startDate, this.data.startTimeText)
    const from = isFinite(start) ? start : Date.now()
    this.setData({ endDate: ymd(new Date(from + days * DAY_MS)) })
    wx.showToast({ title: '结束日期已设为 ' + days + ' 天后', icon: 'none' })
  },

  refreshTypeHint() {
    const isNew = this.data.typeIndex === 1
    this.setData({
      typeHint: isNew
        ? '新客立减：只有「还没有已生效订单」的顾客能用，且每人限用 1 次（服务端强制）。'
        : '满减：顾客的商品金额（不含打包费、运费）达到门槛才能用。'
    })
  },

  /**
   * 前端自查（服务端还会独立校验一遍，这里只是为了少跑一趟、错误提示更具体）。
   * @returns {{ok:boolean, msg?:string, payload?:object}}
   */
  validate() {
    const name = String(this.data.name || '').trim()
    if (!name) return { ok: false, msg: '请填写优惠券名称' }
    if (name.length > 30) return { ok: false, msg: '优惠券名称最多 30 个字' }

    const isNew = this.data.typeIndex === 1
    const type = isNew ? 'newCustomer' : 'threshold'

    const amount = Number(this.data.amount)
    if (!isFinite(amount) || amount <= 0) return { ok: false, msg: '请填写优惠金额（大于 0）' }
    if (amount > 10000) return { ok: false, msg: '优惠金额不能超过 10000 元' }
    // 最多两位小数（用字符串判断，避免 10.55 * 100 的浮点误差误判成 3 位小数）
    if (!/^\d+(\.\d{1,2})?$/.test(String(this.data.amount).trim())) {
      return { ok: false, msg: '优惠金额最多两位小数' }
    }

    let threshold = 0
    if (!isNew) {
      threshold = Number(this.data.threshold)
      if (!isFinite(threshold) || threshold <= 0) return { ok: false, msg: '请填写满减门槛（大于 0）' }
      if (amount >= threshold) {
        return { ok: false, msg: '优惠金额必须小于满减门槛，否则等于白送' }
      }
    }

    const startTime = combineTime(this.data.startDate, this.data.startTimeText)
    const endTime = combineTime(this.data.endDate, this.data.endTimeText)
    if (!isFinite(startTime)) return { ok: false, msg: '请选择开始时间' }
    if (!isFinite(endTime)) return { ok: false, msg: '请选择结束时间' }
    if (startTime >= endTime) return { ok: false, msg: '结束时间必须晚于开始时间' }

    const totalRaw = String(this.data.totalLimit === undefined ? '' : this.data.totalLimit).trim()
    const totalLimit = totalRaw === '' ? 0 : Number(totalRaw)
    if (!isFinite(totalLimit) || Math.floor(totalLimit) !== totalLimit || totalLimit < 0) {
      return { ok: false, msg: '总量必须是 0 或正整数（0 = 不限）' }
    }
    if (totalLimit > 100000) return { ok: false, msg: '总量不能超过 100000' }

    const perRaw = String(this.data.perUserLimit === undefined ? '' : this.data.perUserLimit).trim()
    const perUserLimit = perRaw === '' ? 0 : Number(perRaw)
    if (!isFinite(perUserLimit) || Math.floor(perUserLimit) !== perUserLimit || perUserLimit < 0) {
      return { ok: false, msg: '每人限用必须是 0 或正整数（0 = 不限）' }
    }
    if (perUserLimit > 100) return { ok: false, msg: '每人限用不能超过 100 次' }

    const sort = Number(this.data.sort)
    if (!isFinite(sort) || Math.floor(sort) !== sort || sort < 0 || sort > 9999) {
      return { ok: false, msg: '排序必须是 0 ~ 9999 的整数' }
    }

    const payload = {
      name: name,
      type: type,
      threshold: threshold,
      amount: Math.round(amount * 100) / 100,
      startTime: startTime,
      endTime: endTime,
      totalLimit: totalLimit,
      perUserLimit: perUserLimit,
      enabled: !!this.data.enabled,
      sort: sort
    }
    if (!this.data.isCreate) payload.id = this.data.couponId
    return { ok: true, payload: payload }
  },

  async save() {
    if (this.data.saving) return
    const v = this.validate()
    if (!v.ok) {
      wx.showToast({ title: v.msg, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const res = await API.adminCouponUpsert(v.payload)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存，立即生效', icon: 'success' })
      // 返回列表页（列表 onShow 会刷新），店主能立刻确认结果
      setTimeout(() => {
        try {
          wx.navigateBack()
        } catch (e) {
          LOG.error('[admin-coupons-edit] 返回失败', e)
        }
      }, 700)
    } finally {
      this.setData({ saving: false })
    }
  }
})
