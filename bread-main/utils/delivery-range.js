/**
 * 配送计算：距离 / 范围 / 运费 / 预约时间校验
 * ---------------------------------------------------------------------------
 * ★ 本文件是【纯函数】模块，不依赖 wx 与任何小程序 API。
 *   因此前端、云函数、Node 测试三处都能用同一份逻辑，避免规则漂移。
 *
 * ⚠️ 与 cloudfunctions/api/delivery-calc.js 是两份副本，改动需同步。
 *
 * 规则来源见 config/delivery.js
 * ---------------------------------------------------------------------------
 */
const CFG = require('../config/delivery')

// ===========================================================================
// 1. 距离计算
// ===========================================================================

/**
 * 计算两点间距离（Haversine 公式）
 * @returns {number} 公里数，保留 2 位小数
 *
 * 注意：入参应为 GCJ-02 坐标（微信地图/腾讯地图坐标系）。
 *      若混用 WGS-84（GPS 原始坐标）会有几十到几百米偏差。
 */
function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const nums = [lat1, lng1, lat2, lng2].map(Number)
  if (nums.some((n) => !isFinite(n))) return null
  const [a1, o1, a2, o2] = nums
  // 坐标全为 0 视为「未选点」
  if (a1 === 0 && o1 === 0) return null
  if (a2 === 0 && o2 === 0) return null

  const R = 6371 // 地球平均半径（公里）
  const toRad = (d) => (d * Math.PI) / 180

  const dLat = toRad(a2 - a1)
  const dLng = toRad(o2 - o1)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  const km = R * c
  return Math.round(km * 100) / 100
}

// ===========================================================================
// 2. 配送区域判断
// ===========================================================================

/**
 * 判断地址是否在配送区域内
 * @param {object} address 地址对象 { detail, province, city, district, latitude, longitude }
 * @returns {{ inArea: boolean, method: string, reason: string }}
 */
function checkArea(address) {
  if (!address) {
    return { inArea: false, method: 'none', reason: '缺少地址' }
  }

  // ---- 地图围栏模式（后续启用）----
  if (CFG.area.mode === 'polygon' && CFG.area.polygon && CFG.area.polygon.length >= 3) {
    const inside = isPointInPolygon(address.latitude, address.longitude, CFG.area.polygon)
    return {
      inArea: inside,
      method: 'polygon',
      reason: inside ? '在配送围栏内' : CFG.area.outOfAreaTip
    }
  }

  // ---- 文字关键词模式（当前）----
  const text = [
    address.province,
    address.city,
    address.district,
    address.detail
  ].filter(Boolean).join('')

  if (!text) {
    return { inArea: false, method: 'text', reason: '地址为空' }
  }

  const hit = CFG.area.keywords.some((kw) => text.indexOf(kw) >= 0)
  return {
    inArea: hit,
    method: 'text',
    reason: hit ? '在配送区域内' : CFG.area.outOfAreaTip
  }
}

/**
 * 判断点是否在多边形内（射线法）
 * 预留能力：接入地图围栏后使用，当前 mode 为 text 时不会走到这里。
 */
function isPointInPolygon(lat, lng, polygon) {
  if (!lat || !lng || !polygon || polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i].longitude)
    const yi = Number(polygon[i].latitude)
    const xj = Number(polygon[j].longitude)
    const yj = Number(polygon[j].latitude)
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// ===========================================================================
// 3. 蛋糕识别与尺寸解析
// ===========================================================================

/**
 * 判断一件商品是否蛋糕
 * 优先级：显式 isCake 字段 > 规格组里是否存在「磅数」这类尺寸规格
 *
 * 说明：项目原商品数据没有 isCake 字段，已在 cloud-data schema 中补充。
 *      在补齐数据之前，用尺寸规格是否存在作为兜底判断。
 */
function isCakeGoods(goods) {
  if (!goods) return false
  if (goods.isCake === true) return true
  if (goods.isCake === false) return false
  // 兜底：有「磅数」规格组即视为蛋糕
  const props = goods.properties || []
  return props.some((g) => g && g.name === CFG.cake.sizeSpecName)
}

/**
 * 从商品 + 已选规格中解析蛋糕尺寸（寸）
 * @param {object} goods 商品
 * @param {Array} sku [{ optionId, optionValueId }]
 * @returns {number|null} 尺寸，解析不出返回 null
 */
function parseCakeSizeInch(goods, sku) {
  if (!goods) return null
  const props = goods.properties || []
  const sizeGroup = props.find((g) => g && g.name === CFG.cake.sizeSpecName)
  if (!sizeGroup) return null

  const options = sizeGroup.childsCurGoods || []
  let picked = null
  if (sku && sku.length) {
    const s = sku.find((x) => String(x.optionId) === String(sizeGroup.id))
    if (s) {
      picked = options.find((o) => String(o.id) === String(s.optionValueId))
    }
  }
  // 未指定则取最小选项（保守：不算大蛋糕）
  if (!picked) picked = options[0]
  if (!picked || !picked.name) return null

  const m = String(picked.name).match(/(\d+(?:\.\d+)?)\s*寸/)
  return m ? Number(m[1]) : null
}

/**
 * 判断订单中是否包含「大蛋糕」（尺寸 >= minSizeInch）
 * @param {Array} items [{ goods, sku }] 或 [{ goodsId, ... }]（需自行带 goods）
 * @returns {{ hasCake: boolean, hasBigCake: boolean, maxInch: number|null }}
 */
function analyzeCake(items) {
  let hasCake = false
  let hasBigCake = false
  let maxInch = null

  ;(items || []).forEach((it) => {
    const goods = it.goods || it
    if (!isCakeGoods(goods)) return
    hasCake = true
    const inch = parseCakeSizeInch(goods, it.sku)
    if (inch !== null) {
      if (maxInch === null || inch > maxInch) maxInch = inch
      if (inch >= CFG.cake.minSizeInch) hasBigCake = true
    }
  })

  return { hasCake, hasBigCake, maxInch }
}

// ===========================================================================
// 4. 运费计算
// ===========================================================================

/**
 * 计算配送报价
 *
 * @param {object} params
 *   @param {object} params.address   收货地址 { detail, latitude, longitude, ... }
 *   @param {number} params.goodsAmount 商品金额（不含运费）
 *   @param {Array}  params.items     可选，[{ goods, sku }] 用于蛋糕规则判断
 *
 * @returns {{
 *   deliverable: boolean,   // 是否可下单外送
 *   freight: number|null,   // 运费金额；null = 待确认
 *   freightText: string,    // 展示文案
 *   distanceKm: number|null,// 距离；null = 无法计算
 *   inArea: boolean,        // 是否在配送区域
 *   reason: string,         // 判定原因，便于调试与订单备注
 *   tip: string             // 给用户看的提示
 * }}
 */
function calcQuote(params) {
  const { address, goodsAmount, items } = params || {}
  const amount = Number(goodsAmount) || 0

  // ---- 1) 区域判断（不依赖距离，文字判断即可）----
  const area = checkArea(address)
  if (!area.inArea) {
    return {
      deliverable: false,
      freight: null,
      freightText: CFG.area.outOfAreaTip,
      distanceKm: null,
      inArea: false,
      reason: 'out_of_area',
      tip: CFG.area.outOfAreaTip
    }
  }

  // ---- 2) 距离计算 ----
  const shop = require('../shop-config').shop
  const distanceKm = calcDistanceKm(
    shop.latitude,
    shop.longitude,
    address.latitude,
    address.longitude
  )

  // 距离明显过远，提示确认（可能是地址填错）
  if (distanceKm !== null && distanceKm > CFG.area.maxSaneKm) {
    return {
      deliverable: true,
      freight: null,
      freightText: CFG.freight.unknownTip,
      distanceKm,
      inArea: true,
      reason: 'too_far',
      tip: CFG.area.farAwayTip
    }
  }

  // ---- 3) 蛋糕免配送费规则（优先于金额门槛）----
  const cake = analyzeCake(items || [])
  if (
    CFG.cake.enabled &&
    cake.hasBigCake &&
    distanceKm !== null &&
    distanceKm <= CFG.cake.freeWithinKm
  ) {
    return {
      deliverable: true,
      freight: 0,
      freightText: '免配送费',
      distanceKm,
      inArea: true,
      reason: 'cake_free',
      tip: CFG.cake.freeReasonText
    }
  }

  // ---- 3.5) 蛋糕规则要求「同时满足金额门槛」的情况 ----
  // overrideThreshold = false 时，只标记蛋糕资格，仍需走下面的金额判断
  // （当前配置为 true，即蛋糕无条件免运费，此分支不会触发）

  // ---- 4) 3 公里以内 ----
  if (distanceKm !== null && distanceKm <= CFG.distance.freeWithinKm) {
    if (amount >= CFG.freight.withinFreeAmount) {
      return {
        deliverable: true,
        freight: 0,
        freightText: '免配送费',
        distanceKm,
        inArea: true,
        reason: 'amount_free',
        tip: `已满${CFG.freight.withinFreeAmount}元，免配送费`
      }
    }
    // 不满门槛：收配置的占位运费
    return {
      deliverable: true,
      freight: CFG.freight.withinFee,
      freightText: `¥${CFG.freight.withinFee}`,
      distanceKm,
      inArea: true,
      reason: 'within_paid',
      tip: `未满${CFG.freight.withinFreeAmount}元，配送费¥${CFG.freight.withinFee}`
    }
  }

  // ---- 5) 3 公里以外 ----
  if (distanceKm !== null && distanceKm > CFG.distance.freeWithinKm) {
    if (!CFG.freight.beyondEnabled) {
      return {
        deliverable: false,
        freight: null,
        freightText: CFG.area.outOfAreaTip,
        distanceKm,
        inArea: true,
        reason: 'beyond_disabled',
        tip: '超出配送范围'
      }
    }
    // 允许下单，运费待人工确认
    return {
      deliverable: true,
      freight: CFG.freight.beyondFee === null ? null : CFG.freight.beyondFee,
      freightText: CFG.freight.beyondTip,
      distanceKm,
      inArea: true,
      reason: 'beyond',
      tip: `距门店${distanceKm}公里，${CFG.freight.beyondTip}`
    }
  }

  // ---- 6) 没有经纬度，算不出距离：降级为「运费待确认」，不阻断下单 ----
  return {
    deliverable: true,
    freight: null,
    freightText: CFG.freight.unknownTip,
    distanceKm: null,
    inArea: true,
    reason: 'unknown_distance',
    tip: CFG.freight.unknownTip
  }
}

// ===========================================================================
// 5. 预约时间校验
// ===========================================================================

/**
 * 解析 "HH:MM-HH:MM" 营业时间
 */
function parseHours(str) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return {
    startH: Number(m[1]),
    startM: Number(m[2]),
    endH: Number(m[3]),
    endM: Number(m[4])
  }
}

/**
 * 校验期望时间是否可预约
 *
 * @param {object} params
 *   @param {number|Date} params.expectTime 期望送达时间
 *   @param {Array}  params.items 订单商品（用于判断是否含蛋糕）
 *   @param {Date}   params.now 当前时间（便于测试注入）
 *   @param {string} params.openingHours 营业时间，默认取 shop-config
 * @returns {{ valid: boolean, reason: string, tip: string, earliest: Date }}
 */
function checkAdvanceTime(params) {
  const p = params || {}
  const now = p.now ? new Date(p.now) : new Date()
  const openingHours = p.openingHours || require('../shop-config').shop.openingHours
  const hours = parseHours(openingHours)

  const needAdvance =
    CFG.advance.applyToAll || analyzeCake(p.items || []).hasCake
  const minMs = CFG.advance.minHours * 60 * 60 * 1000
  const earliest = new Date(now.getTime() + minMs)

  const expect = p.expectTime ? new Date(p.expectTime) : null
  if (!expect || isNaN(expect.getTime())) {
    return {
      valid: false,
      reason: 'no_time',
      tip: '请选择期望时间',
      earliest
    }
  }

  // ===== 校验顺序：先校验营业时间，再校验提前时间 =====
  // 原因：若先校验提前时间，选了个"未营业"的时间会报"不足3小时"，
  //      提示误导用户。先报"不在营业时间"更准确。

  // ---- 1) 营业时间校验 ----
  if (hours) {
    const minutes = expect.getHours() * 60 + expect.getMinutes()
    const start = hours.startH * 60 + hours.startM
    const end = hours.endH * 60 + hours.endM
    if (minutes < start || minutes > end) {
      return {
        valid: false,
        reason: 'closed',
        tip: `${CFG.advance.closedTip}（${openingHours}）`,
        earliest
      }
    }
  }

  // ---- 2) 提前时间校验 ----
  // ★ 仅在 needAdvance 为 true 时生效（配置 advance.applyToAll 或订单含蛋糕）
  //   非蛋糕订单在 applyToAll=false 时可立即下单，不受 3 小时限制
  if (needAdvance && expect.getTime() < earliest.getTime()) {
    return {
      valid: false,
      reason: 'too_soon',
      tip: `${CFG.advance.cakeOnlyTip}（最早 ${fmtTime(earliest)}）`,
      earliest
    }
  }

  return { valid: true, reason: 'ok', tip: '', earliest }
}

/**
 * 格式化时间为 HH:MM
 */
function fmtTime(d) {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 生成可选的日期列表（从今天起 selectableDays 天）
 */
function buildDateOptions(now) {
  const base = now ? new Date(now) : new Date()
  const list = []
  for (let i = 0; i < CFG.advance.selectableDays; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
    let label = `${d.getMonth() + 1}月${d.getDate()}日`
    if (i === 0) label = '今天'
    else if (i === 1) label = '明天'
    else if (i === 2) label = '后天'
    list.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      label
    })
  }
  return list
}

/**
 * 生成某天的可预约时段（按 slotMinutes 粒度，营业时间内）
 * @param {string} dateStr YYYY-MM-DD
 * @param {Date} now 当前时间（用于过滤掉已过期的时段）
 */
function buildTimeSlots(dateStr, now) {
  const openingHours = require('../shop-config').shop.openingHours
  const hours = parseHours(openingHours) || { startH: 9, startM: 0, endH: 22, endM: 0 }
  const base = now ? new Date(now) : new Date()
  const minMs = CFG.advance.minHours * 60 * 60 * 1000
  const earliest = new Date(base.getTime() + minMs)

  const slots = []
  const step = CFG.advance.slotMinutes
  const startMin = hours.startH * 60 + hours.startM
  const endMin = hours.endH * 60 + hours.endM

  for (let m = startMin; m <= endMin; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0')
    const mm = String(m % 60).padStart(2, '0')
    const time = `${hh}:${mm}`
    const dt = new Date(`${dateStr}T${time}:00`)
    // 过滤掉早于「最早可预约时间」的时段
    if (dt.getTime() < earliest.getTime()) continue
    slots.push(time)
  }
  return slots
}

module.exports = {
  calcDistanceKm,
  checkArea,
  isPointInPolygon,
  isCakeGoods,
  parseCakeSizeInch,
  analyzeCake,
  calcQuote,
  parseHours,
  checkAdvanceTime,
  fmtTime,
  buildDateOptions,
  buildTimeSlots
}
