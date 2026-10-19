/**
 * 配送计算：距离 / 范围 / 运费 / 预约时间校验
 * ---------------------------------------------------------------------------
 * ★ 本文件是【纯函数】模块，不依赖 wx 与任何小程序 API。
 *   因此前端、云函数、Node 测试三处都能用同一份逻辑，避免规则漂移。
 *
 * ★ 本文件是配送计算的**唯一事实来源**。
 *   云函数副本 cloudfunctions/api/delivery-calc.js 由脚本生成：
 *        node cloud-data/tools/sync-delivery.js
 *   （阶段 8 起。以前是"手工改两份"，容易漂；现在只改这里，然后跑脚本，
 *     tests/test-delivery.js 有一条断言会把两边逐字节比对。）
 *
 * ★ 规则分两层（阶段 8 起）：
 *   1) 代码默认值：config/delivery.js（唯一事实来源）；
 *   2) 云库覆盖：app_config 集合 key = 'delivery_rule' 的 value（对象）。
 *   运行期规则由 setDeliveryRule(rule) 装进来；**前端与服务端装的是同一份规则**
 *   （前端由 appConfig action 下发 → app.js 写 storage → 结算页同步）,
 *   这是"屏显运费 == 实付运费"的前提。
 *
 * 规则来源见 config/delivery.js
 * ---------------------------------------------------------------------------
 */
const DEFAULT_CFG = require('../config/delivery')

// ===========================================================================
// 0. 运行期规则（阶段 8 新增）
// ===========================================================================
// 说明：模块内所有函数都读 CFG，因此 setDeliveryRule() 只需要把 CFG 换成
//      「默认值 + 云库覆盖」的合并结果，其余代码一行都不用动。
//      - 传入 null / 非对象 / 空 → 回到代码默认值（不启用云库规则）
//      - 传入对象 → 逐字段校验后合并；**非法字段逐项回退默认值**，绝不整体丢弃
//        （云库里写了个半截规则，也不能让系统算错钱或崩掉）
//      - 合并结果每次都是**新对象**，绝不改动 DEFAULT_CFG，也不累积上一次的覆盖
let CFG = DEFAULT_CFG

/** 深拷贝（配置里只有普通对象/数组/数字/字符串/null，JSON 往返足够） */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/** 非负有限数字 → 数字；否则 undefined（表示"这个字段不合法，保留默认值"） */
function toNonNegNumber(v) {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  if (!isFinite(n) || n < 0) return undefined
  return n
}

/**
 * null 或非负数字 → 数字/null；不合法 → undefined
 * 用于「可以为 null（表示待确认）」的字段。
 */
function toNonNegNumberOrNull(v) {
  if (v === null || v === undefined) return null
  if (v === '') return undefined
  return toNonNegNumber(v)
}

/** 非空字符串 → 去掉首尾空格的字符串；否则 undefined */
function toTip(v) {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s : undefined
}

/** 字符串数组（关键词）：去掉空项与空串；空数组视为"显式清空"，合法 */
function toStringList(v) {
  if (!Array.isArray(v)) return undefined
  return v
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
}

/**
 * 校验距离阶梯 tiers
 * @returns {Array|null} 合法档位数组（已按 maxKm 升序、开区间在最后）；不合法返回 null
 */
function sanitizeTiers(v) {
  if (!Array.isArray(v) || !v.length) return null
  const out = []
  for (const t of v) {
    if (!t || typeof t !== 'object') return null
    // maxKm：null/undefined = 不设上限（以上全部）
    const maxKm = t.maxKm === null || t.maxKm === undefined ? null : toNonNegNumber(t.maxKm)
    if (maxKm === undefined) return null
    const fee = toNonNegNumberOrNull(t.fee)
    if (fee === undefined) return null
    const freeAmount = toNonNegNumberOrNull(t.freeAmount)
    if (freeAmount === undefined) return null
    out.push({ maxKm, fee, freeAmount, tip: toTip(t.tip) || '' })
  }
  // 升序排序；maxKm = null（开区间）排最后
  out.sort((a, b) => (a.maxKm === null ? Infinity : a.maxKm) - (b.maxKm === null ? Infinity : b.maxKm))
  return out
}

/**
 * 用旧配置键（首档/尾档镜像）合成 tiers —— tiers 缺失或非法时的兜底。
 * 保证"只写了旧键"的调用方行为不变。
 */
function synthesizeTiers(cfg) {
  return [
    {
      maxKm: cfg.distance.freeWithinKm,
      fee: cfg.freight.withinFee,
      freeAmount: cfg.freight.withinFreeAmount,
      tip: ''
    },
    {
      maxKm: null,
      fee: cfg.freight.beyondFee,
      freeAmount: null,
      tip: cfg.freight.beyondTip
    }
  ]
}

/**
 * 把云库规则合并到代码默认值上（纯函数：不改动入参，也不改动 DEFAULT_CFG）
 * @param {object} rule 云库里的 delivery_rule（可以是半截的、甚至字段类型不对）
 * @returns {object} 完整可用的规则
 */
function normalizeRule(rule) {
  const out = deepClone(DEFAULT_CFG)
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return out

  // ---- area ----
  const a = rule.area && typeof rule.area === 'object' ? rule.area : {}
  const kw = toStringList(a.keywords)
  if (kw) out.area.keywords = kw
  const ex = toStringList(a.excludeKeywords)
  if (ex) out.area.excludeKeywords = ex
  const mode = toTip(a.mode)
  if (mode && (mode === 'text' || mode === 'polygon')) out.area.mode = mode
  const oa = toTip(a.outOfAreaTip)
  if (oa) out.area.outOfAreaTip = oa
  const et = toTip(a.excludedTip)
  if (et) out.area.excludedTip = et
  const blt = toTip(a.beyondLimitTip)
  if (blt) out.area.beyondLimitTip = blt
  const fbk = toNonNegNumberOrNull(a.forbidBeyondKm)
  if (fbk !== undefined) out.area.forbidBeyondKm = fbk
  const ms = toNonNegNumber(a.maxSaneKm)
  if (ms !== undefined) out.area.maxSaneKm = ms
  const fat = toTip(a.farAwayTip)
  if (fat) out.area.farAwayTip = fat
  if (Array.isArray(a.polygon)) {
    const poly = a.polygon
      .filter((p) => p && typeof p === 'object' && isFinite(Number(p.latitude)) && isFinite(Number(p.longitude)))
      .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
    // 少于 3 个点的围栏没有意义：不采用（保留默认）
    if (poly.length >= 3 || poly.length === 0) out.area.polygon = poly
  }

  // ---- distance ----
  const d = rule.distance && typeof rule.distance === 'object' ? rule.distance : {}
  const fwk = toNonNegNumber(d.freeWithinKm)
  if (fwk !== undefined) out.distance.freeWithinKm = fwk
  const prov = toTip(d.provider)
  if (prov && (prov === 'formula' || prov === 'tencent')) out.distance.provider = prov

  // ---- freight ----
  const f = rule.freight && typeof rule.freight === 'object' ? rule.freight : {}
  const wfa = toNonNegNumber(f.withinFreeAmount)
  if (wfa !== undefined) out.freight.withinFreeAmount = wfa
  const wf = toNonNegNumber(f.withinFee)
  if (wf !== undefined) out.freight.withinFee = wf
  const be = f.beyondEnabled
  if (typeof be === 'boolean') out.freight.beyondEnabled = be
  const bf = toNonNegNumberOrNull(f.beyondFee)
  if (bf !== undefined) out.freight.beyondFee = bf
  const bt = toTip(f.beyondTip)
  if (bt) out.freight.beyondTip = bt
  const ut = toTip(f.unknownTip)
  if (ut) out.freight.unknownTip = ut
  // ★ 阶梯是计费依据；合法就整份采用，非法则用（可能已被覆盖的）旧键合成
  const tiers = sanitizeTiers(f.tiers)
  out.freight.tiers = tiers || synthesizeTiers(out)

  // ---- cake ----
  const c = rule.cake && typeof rule.cake === 'object' ? rule.cake : {}
  if (typeof c.enabled === 'boolean') out.cake.enabled = c.enabled
  const cfk = toNonNegNumber(c.freeWithinKm)
  if (cfk !== undefined) out.cake.freeWithinKm = cfk
  const msi = toNonNegNumber(c.minSizeInch)
  if (msi !== undefined) out.cake.minSizeInch = msi
  const ssn = toTip(c.sizeSpecName)
  if (ssn) out.cake.sizeSpecName = ssn
  if (typeof c.overrideThreshold === 'boolean') out.cake.overrideThreshold = c.overrideThreshold
  const frt = toTip(c.freeReasonText)
  if (frt) out.cake.freeReasonText = frt

  return out
}

/**
 * 装入运行期规则（前端：从 storage 读云库下发的规则；服务端：从 app_config 读）
 * @param {object|null} rule 云库规则；null/非对象 → 回到代码默认值
 * @returns {object} 生效后的完整规则
 */
function setDeliveryRule(rule) {
  CFG = rule && typeof rule === 'object' && !Array.isArray(rule) ? normalizeRule(rule) : DEFAULT_CFG
  return CFG
}

/** 当前生效的完整规则（只读用途，例如下发/诊断） */
function getDeliveryRule() {
  return CFG
}

/** 回到代码默认值（测试隔离用，也可用于"云库规则读失败"的兜底） */
function resetDeliveryRule() {
  CFG = DEFAULT_CFG
  return CFG
}

/** 代码默认值（不受 setDeliveryRule 影响） */
function getDefaultDeliveryRule() {
  return DEFAULT_CFG
}

// ===========================================================================
// ★ 北京时间工具（P0-2 新增）
// ===========================================================================
// 背景：云函数运行在 UTC。`new Date(y, m-1, d, h, min)` 与 `getHours()` 这类
//      "按本地时区掰墙上时间"的写法，在 UTC 机器上会整体晚 8 小时 ——
//      「蛋糕提前 3 小时」和「营业时间 09:00-22:00」的判断全部错位。
// 原则：**所有墙上时间（用户选的期望送达时间、营业时间）一律按北京时间解释**，
//      内部统一换成 epoch 毫秒再比较，绝不依赖运行环境时区。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 取某一时刻在北京时间下的年/月/日/时/分/秒（不依赖运行环境时区）
 * @param {Date|number} value Date 或 epoch 毫秒
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}|null}
 */
function beijingParts(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (!d || isNaN(d.getTime())) return null
  const shifted = new Date(d.getTime() + BEIJING_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  }
}

/**
 * 把时间统一解析成 epoch 毫秒
 *   - Date / number：已经是绝对时刻，原样取 epoch（不再按墙上时间解释）
 *   - 'YYYY-MM-DD HH:mm[:ss]'（也接受 T 分隔）：按**北京时间**解释
 *   - 其它字符串：交给 new Date()（ISO 带时区等标准格式）
 * @returns {number|null} epoch 毫秒；无法解析返回 null
 */
function parseBeijingTime(value) {
  if (value instanceof Date) {
    const t = value.getTime()
    return isNaN(t) ? null : t
  }
  if (typeof value === 'number') return isFinite(value) ? value : null
  const str = value === null || value === undefined ? '' : String(value).trim()
  if (!str) return null
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/)
  if (m) {
    return Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6] || 0)
    ) - BEIJING_OFFSET_MS
  }
  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d.getTime()
}

// ===========================================================================
// 1. 距离计算
// ===========================================================================

/**
 * 计算两点间距离（Haversine 公式）
 * @returns {number} 公里数，保留 2 位小数
 *
 * 注意：入参应为 GCJ-02 坐标（微信地图/腾讯地图坐标系）。
 *      若混用 WGS-84（GPS 原始坐标）会有几十到几百米误差。
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
 *
 * 判定顺序（阶段 8 起）：
 *   ① 不送区域黑名单 excludeKeywords 命中 → 直接拒（优先级高于白名单）；
 *   ② polygon 围栏模式（若启用且点数够）→ 用射线法；
 *   ③ 文字关键词白名单 keywords → 命中才算在区域内。
 *
 * @param {object} address 地址对象 { detail, province, city, district, latitude, longitude }
 * @returns {{ inArea: boolean, method: string, reason: string, code: string }}
 *   code: 'in' | 'out' | 'excluded' | 'empty' | 'none'（给 calcQuote 用的机器可读判定）
 */
function checkArea(address) {
  if (!address) {
    return { inArea: false, method: 'none', reason: '缺少地址', code: 'none' }
  }

  // 地址文字（黑名单与白名单都用它判定）
  const text = [
    address.province,
    address.city,
    address.district,
    address.detail
  ].filter(Boolean).join('')

  // ---- ① 不送区域黑名单（阶段 8 新增）：命中即拒，优先于白名单 ----
  const exclude = (CFG.area.excludeKeywords || [])
  if (exclude.length && text && exclude.some((kw) => text.indexOf(kw) >= 0)) {
    return {
      inArea: false,
      method: 'exclude',
      reason: CFG.area.excludedTip,
      code: 'excluded'
    }
  }

  // ---- ② 地图围栏模式（后续启用）----
  if (CFG.area.mode === 'polygon' && CFG.area.polygon && CFG.area.polygon.length >= 3) {
    const inside = isPointInPolygon(address.latitude, address.longitude, CFG.area.polygon)
    return {
      inArea: inside,
      method: 'polygon',
      reason: inside ? '在配送围栏内' : CFG.area.outOfAreaTip,
      code: inside ? 'in' : 'out'
    }
  }

  // ---- ③ 文字关键词模式（当前）----
  if (!text) {
    return { inArea: false, method: 'text', reason: '地址为空', code: 'empty' }
  }

  const hit = CFG.area.keywords.some((kw) => text.indexOf(kw) >= 0)
  return {
    inArea: hit,
    method: 'text',
    reason: hit ? '在配送区域内' : CFG.area.outOfAreaTip,
    code: hit ? 'in' : 'out'
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
 * 取距离命中的档位（阶段 8 新增）
 * 规则：按 maxKm 升序取第一条 distanceKm <= maxKm；maxKm = null 表示"以上全部"。
 * @returns {object|null} 档位；null = 所有档位都有上限且都超了（按"待确认"处理）
 */
function pickTier(distanceKm) {
  const tiers = (CFG.freight && CFG.freight.tiers) || []
  for (const t of tiers) {
    if (t.maxKm === null || distanceKm <= t.maxKm) return t
  }
  return null
}

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
 *
 * reason 取值（诊断用，会写进订单的 deliveryQuote 快照）：
 *   out_of_area       收货地址不在配送区域（文字未命中关键词/围栏外）
 *   excluded_area     命中"不送区域"黑名单（阶段 8 新增）
 *   too_far           距离超过 maxSaneKm（疑似地址填错，仍允许下单）
 *   beyond_limit      距离超过 forbidBeyondKm（阶段 8 新增，**不允许下单**）
 *   cake_free         含 6 寸及以上蛋糕且在上限内 → 免配送费
 *   amount_free       命中档位且达到该档免运费门槛 → 免费
 *   within_paid       命中档位但未达门槛 → 收该档运费
 *     （名字保留历史叫法，阶段 8 起表示"按档收费"，不再专指 3km 以内）
 *   beyond            命中"运费待确认"档 / 所有档位都没覆盖到
 *   beyond_disabled   尾档配置为不接单（beyondEnabled = false）
 *   unknown_distance  没有经纬度，算不出距离（不阻断下单）
 */
function calcQuote(params) {
  const { address, goodsAmount, items } = params || {}
  const amount = Number(goodsAmount) || 0

  // ---- 1) 区域判断（不依赖距离，文字判断即可；含不送区域黑名单）----
  const area = checkArea(address)
  if (!area.inArea) {
    const excluded = area.code === 'excluded'
    return {
      deliverable: false,
      freight: null,
      freightText: area.reason,
      distanceKm: null,
      inArea: false,
      reason: excluded ? 'excluded_area' : 'out_of_area',
      tip: area.reason
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

  // ---- 2.5) 外送距离上限（阶段 8 新增；默认 null = 不启用）----
  // 与上面的 maxSaneKm 语义不同：maxSaneKm 是"地址可能填错"的提示，仍可下单；
  // forbidBeyondKm 是业务上的"送不了那么远"，直接不允许外送。
  const forbidKm = CFG.area.forbidBeyondKm
  if (distanceKm !== null && forbidKm !== null && forbidKm !== undefined && distanceKm > forbidKm) {
    return {
      deliverable: false,
      freight: null,
      freightText: CFG.area.beyondLimitTip,
      distanceKm,
      inArea: true,
      reason: 'beyond_limit',
      tip: CFG.area.beyondLimitTip
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

  // ---- 4) 按距离档位计费（阶段 8：由两段式升级为阶梯）----
  if (distanceKm !== null) {
    const tier = pickTier(distanceKm)

    // 4.1 所有档位都有上限且全超了：按"运费待确认"处理，不阻断下单
    if (!tier) {
      return {
        deliverable: true,
        freight: null,
        freightText: CFG.freight.beyondTip,
        distanceKm,
        inArea: true,
        reason: 'beyond',
        tip: `距门店${distanceKm}公里，${CFG.freight.beyondTip}`
      }
    }

    // 4.2 尾档 fee = null：运费待人工确认（默认配置里 >3km 就是这一档）
    if (tier.fee === null) {
      const tip = tier.tip || CFG.freight.beyondTip
      // beyondEnabled = false → 这一档干脆不接单（保留旧开关的语义）
      if (!CFG.freight.beyondEnabled) {
        return {
          deliverable: false,
          freight: null,
          freightText: CFG.area.outOfAreaTip,
          distanceKm,
          inArea: true,
          reason: 'beyond_disabled',
          tip: CFG.area.outOfAreaTip
        }
      }
      return {
        deliverable: true,
        freight: null,
        freightText: tip,
        distanceKm,
        inArea: true,
        reason: 'beyond',
        tip: `距门店${distanceKm}公里，${tip}`
      }
    }

    // 4.3 达到该档免运费门槛 → 免费
    if (tier.freeAmount !== null && amount >= tier.freeAmount) {
      return {
        deliverable: true,
        freight: 0,
        freightText: '免配送费',
        distanceKm,
        inArea: true,
        reason: 'amount_free',
        tip: `已满${tier.freeAmount}元，免配送费`
      }
    }

    // 4.4 收该档运费
    return {
      deliverable: true,
      freight: tier.fee,
      freightText: `¥${tier.fee}`,
      distanceKm,
      inArea: true,
      reason: 'within_paid',
      tip: tier.freeAmount === null
        ? `配送费¥${tier.fee}`
        : `未满${tier.freeAmount}元，配送费¥${tier.fee}`
    }
  }

  // ---- 5) 没有经纬度，算不出距离：降级为「运费待确认」，不阻断下单 ----
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
  const nowMs = parseBeijingTime(p.now)
  const baseMs = nowMs === null ? Date.now() : nowMs
  const openingHours = p.openingHours || require('../shop-config').shop.openingHours
  const hours = parseHours(openingHours)

  const needAdvance =
    CFG.advance.applyToAll || analyzeCake(p.items || []).hasCake
  // 提前量是"绝对时长"（3 小时就是 3 小时），用 epoch 做算术即不受时区影响
  const minMs = CFG.advance.minHours * 60 * 60 * 1000
  const earliest = new Date(baseMs + minMs)

  // expectTime 可能是 Date（页面/测试注入）或 'YYYY-MM-DD HH:mm' 字符串（云函数入参），
  // 统一解析成 epoch 再比较；墙上时间的字符串按北京时间解释。
  const expectMs = p.expectTime ? parseBeijingTime(p.expectTime) : null
  if (expectMs === null) {
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

  // ---- 1) 营业时间校验（按**北京时间**取时/分，不依赖运行环境时区）----
  if (hours) {
    const bp = beijingParts(expectMs)
    const minutes = bp.hour * 60 + bp.minute
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
  if (needAdvance && expectMs < earliest.getTime()) {
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
 * 格式化时间为 HH:MM（按**北京时间**，不依赖运行环境时区）
 */
function fmtTime(d) {
  const bp = beijingParts(d)
  if (!bp) return ''
  const hh = String(bp.hour).padStart(2, '0')
  const mm = String(bp.minute).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 生成可选的日期列表（从今天起 selectableDays 天）
 * "今天/明天"与 value 都按**北京日期**算（云函数 UTC 下凌晨不再错一天）
 */
function buildDateOptions(now) {
  const nowMs = parseBeijingTime(now)
  const base = new Date(nowMs === null ? Date.now() : nowMs)
  const bp = beijingParts(base)
  const list = []
  for (let i = 0; i < CFG.advance.selectableDays; i++) {
    // 北京日历日 +i：用 Date.UTC 做日历加法，再取 UTC 字段，避开本地时区与夏令时
    const d = new Date(Date.UTC(bp.year, bp.month - 1, bp.day + i))
    const y = d.getUTCFullYear()
    const mo = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    let label = `${mo}月${day}日`
    if (i === 0) label = '今天'
    else if (i === 1) label = '明天'
    else if (i === 2) label = '后天'
    list.push({
      value: `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      label
    })
  }
  return list
}

/**
 * 生成某天的可预约时段（按 slotMinutes 粒度，营业时间内）
 * @param {string} dateStr YYYY-MM-DD（北京时间）
 * @param {Date} now 当前时间（用于过滤掉已过期的时段）
 */
function buildTimeSlots(dateStr, now) {
  const openingHours = require('../shop-config').shop.openingHours
  const hours = parseHours(openingHours) || { startH: 9, startM: 0, endH: 22, endM: 0 }
  const nowMs = parseBeijingTime(now)
  const baseMs = nowMs === null ? Date.now() : nowMs
  const minMs = CFG.advance.minHours * 60 * 60 * 1000
  const earliestMs = baseMs + minMs

  const slots = []
  const step = CFG.advance.slotMinutes
  const startMin = hours.startH * 60 + hours.startM
  const endMin = hours.endH * 60 + hours.endM

  for (let m = startMin; m <= endMin; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0')
    const mm = String(m % 60).padStart(2, '0')
    const time = `${hh}:${mm}`
    // 时段是北京时间的墙上时间 → 显式换算成 epoch，不能依赖 new Date 的本地解析
    const slotMs = parseBeijingTime(`${dateStr} ${time}`)
    if (slotMs === null) continue
    // 过滤掉早于「最早可预约时间」的时段
    if (slotMs < earliestMs) continue
    slots.push(time)
  }
  return slots
}

module.exports = {
  // 运行期规则（阶段 8）
  normalizeRule,
  setDeliveryRule,
  getDeliveryRule,
  resetDeliveryRule,
  getDefaultDeliveryRule,
  pickTier,
  // 距离 / 范围
  calcDistanceKm,
  checkArea,
  isPointInPolygon,
  // 蛋糕
  isCakeGoods,
  parseCakeSizeInch,
  analyzeCake,
  // 报价
  calcQuote,
  // 时区工具（P0-2）
  BEIJING_OFFSET_MS,
  parseBeijingTime,
  // 预约时间
  parseHours,
  checkAdvanceTime,
  fmtTime,
  buildDateOptions,
  buildTimeSlots
}
