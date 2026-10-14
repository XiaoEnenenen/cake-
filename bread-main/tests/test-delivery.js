/**
 * 配送规则单元测试
 * ---------------------------------------------------------------------------
 * 验证 config/delivery.js 定义的规则是否被正确执行。
 * 覆盖店主表姐提出的全部规则，包括待定项的占位行为。
 * ---------------------------------------------------------------------------
 */
const DR = require('../utils/delivery-range')
const CFG = require('../config/delivery')
const SHOP = require('../shop-config').shop

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  OK   ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
  }
}

// 门店坐标（与 shop-config 一致）
const SHOP_LAT = SHOP.latitude
const SHOP_LNG = SHOP.longitude

// 构造距离门店约 N 公里的坐标（纬度 1 度 ≈ 111.19 公里）
function coordAtKm(km) {
  return {
    latitude: SHOP_LAT + km / 111.19,
    longitude: SHOP_LNG
  }
}
function addrAtKm(km, detailText) {
  return Object.assign({
    province: '云南省',
    city: '昆明市',
    district: '安宁市',
    detail: detailText || '太平新城某小区1栋101'
  }, coordAtKm(km))
}

console.log('=== 1) 距离计算 ===')
{
  const d0 = DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, SHOP_LAT, SHOP_LNG)
  check('同一点距离为 0', d0 === 0, d0)

  const d1 = DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, SHOP_LAT + 1 / 111.19, SHOP_LNG)
  check('1 公里坐标算出约 1 公里（±0.05）', Math.abs(d1 - 1) < 0.05, d1)

  const d5 = DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, SHOP_LAT + 5 / 111.19, SHOP_LNG)
  check('5 公里坐标算出约 5 公里（±0.1）', Math.abs(d5 - 5) < 0.1, d5)

  check('缺参数返回 null', DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, null, null) === null)
  check('坐标为 0 视为未选点', DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, 0, 0) === null)
  check('非数字返回 null', DR.calcDistanceKm(SHOP_LAT, SHOP_LNG, 'abc', 102) === null)
}

console.log('\n=== 2) 配送区域判断（文字关键词）===')
{
  check('含「太平新城」判定在区域内', DR.checkArea(addrAtKm(1)).inArea === true)
  check(
    '不含关键词判定区域外',
    DR.checkArea({ province: '云南省', city: '昆明市', district: '五华区', detail: '某路1号' }).inArea === false
  )
  check('空地址判定区域外', DR.checkArea(null).inArea === false)
  check('方法为 text', DR.checkArea(addrAtKm(1)).method === 'text')
  check('区域内原因文案', DR.checkArea(addrAtKm(1)).reason === '在配送区域内')
  check('区域外提示文案', DR.checkArea({ detail: '某路' }).reason === CFG.area.outOfAreaTip)
}

console.log('\n=== 3) 蛋糕识别 ===')
{
  const cakeGoods = {
    name: '慕斯蛋糕',
    properties: [
      { id: 'size', name: '磅数', childsCurGoods: [
        { id: 's4', name: '4寸' }, { id: 's6', name: '6寸' }, { id: 's8', name: '8寸' }
      ] }
    ]
  }
  const snack = { name: '曲奇饼干', properties: [], isCake: false }
  const explicit = { name: '某物', isCake: true, properties: [] }

  check('有磅数规格 → 识别为蛋糕', DR.isCakeGoods(cakeGoods) === true)
  check('无规格且 isCake=false → 非蛋糕', DR.isCakeGoods(snack) === false)
  check('显式 isCake=true 优先', DR.isCakeGoods(explicit) === true)
  check('null 安全', DR.isCakeGoods(null) === false)

  check('解析 6寸', DR.parseCakeSizeInch(cakeGoods, [{ optionId: 'size', optionValueId: 's6' }]) === 6)
  check('解析 8寸', DR.parseCakeSizeInch(cakeGoods, [{ optionId: 'size', optionValueId: 's8' }]) === 8)
  check('未指定规格时取最小选项 4寸', DR.parseCakeSizeInch(cakeGoods, []) === 4)
  check('非蛋糕返回 null', DR.parseCakeSizeInch(snack, []) === null)

  const a1 = DR.analyzeCake([{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's6' }] }])
  check('分析出含蛋糕', a1.hasCake === true)
  check('分析出含大蛋糕（>=6寸）', a1.hasBigCake === true)
  check('最大尺寸为 6', a1.maxInch === 6)

  const a2 = DR.analyzeCake([{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's4' }] }])
  check('4寸不算大蛋糕', a2.hasCake === true && a2.hasBigCake === false, a2)

  const a3 = DR.analyzeCake([{ goods: snack, sku: [] }])
  check('非蛋糕订单无蛋糕', a3.hasCake === false)
}

console.log('\n=== 4) 运费：区域内 3 公里以内 ===')
{
  // 满 35 元 → 免运费
  const q1 = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 50, items: [] })
  check('3km内满35元 → 运费 0', q1.freight === 0, q1)
  check('  原因 amount_free', q1.reason === 'amount_free', q1.reason)
  check('  文案「免配送费」', q1.freightText === '免配送费', q1.freightText)
  check('  可配送', q1.deliverable === true)

  // 恰好 35 元 → 免运费（边界）
  const q1b = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 35, items: [] })
  check('恰好 35 元 → 免运费（边界含等号）', q1b.freight === 0, q1b)

  // 不满 35 元 → 占位 5 元
  const q2 = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 30, items: [] })
  check('3km内不满35元 → 运费 5', q2.freight === 5, q2)
  check('  原因 within_paid', q2.reason === 'within_paid', q2.reason)
  check('  文案含 ¥5', q2.freightText.indexOf('5') >= 0, q2.freightText)

  // 恰好 3 公里 → 仍算「以内」
  const q3 = DR.calcQuote({ address: addrAtKm(3), goodsAmount: 20, items: [] })
  check('恰好 3 公里 → 按以内规则（收 5 元）', q3.freight === 5, q3)
  check('  距离约 3.0', Math.abs(q3.distanceKm - 3) < 0.1, q3.distanceKm)
}

console.log('\n=== 5) 运费：区域外 ===')
{
  // 注意：区域判断是把 province/city/district/detail 拼起来找关键词「太平新城」，
  //      所以构造「区域外」地址时必须保证四个字段里都没有这个词。
  const outside = {
    province: '云南省',
    city: '昆明市',
    district: '五华区',
    detail: '某路1号'
  }
  check('前置：该地址确实不含关键词', DR.checkArea(outside).inArea === false)
  const q = DR.calcQuote({ address: outside, goodsAmount: 100, items: [] })
  check('区域外不可配送', q.deliverable === false, q)
  check('  原因 out_of_area', q.reason === 'out_of_area', q.reason)
  check('  区域外文案与配置一致', q.freightText === CFG.area.outOfAreaTip, q.freightText)
  check('  运费为 null', q.freight === null, q.freight)

  // 区域外即使金额很高、距离很近也不送
  const q2 = DR.calcQuote({
    address: Object.assign({}, outside, coordAtKm(0.5)),
    goodsAmount: 500,
    items: []
  })
  check('区域外且距离很近 → 仍不配送', q2.deliverable === false && q2.reason === 'out_of_area', q2)
}

console.log('\n=== 6) 运费：距离阶梯（店主 2026-10-14 定的规则）===')
{
  // 规则：0–3km 满35免/不满5元；3–5km 10元；5–8km 18元；>8km 电话沟通（运费待确认）
  const q5 = DR.calcQuote({ address: addrAtKm(5), goodsAmount: 200, items: [] })
  check('3–5 公里：仍可下单', q5.deliverable === true, q5)
  check('★ 恰好 5 公里 → 第二档 10 元', q5.freight === 10, q5)
  check('  原因 within_paid（按档收费）', q5.reason === 'within_paid', q5.reason)
  check('  文案 ¥10', q5.freightText === '¥10', q5.freightText)
  check('  距离已算出约 5', Math.abs(q5.distanceKm - 5) < 0.1, q5.distanceKm)

  // 边界：3.00 归首档（不满 35 元收 5 元）/ 3.01 归第二档（10 元）
  // 注意金额用 20 元（不满 35），否则会先命中首档的"满 35 免运费"分支
  const e3 = DR.calcQuote({ address: addrAtKm(3), goodsAmount: 20, items: [] })
  const e301 = DR.calcQuote({ address: addrAtKm(3.01), goodsAmount: 20, items: [] })
  check('★ 恰好 3.00 公里 → 首档 5 元（含等号）', e3.freight === 5, e3)
  check('★ 3.01 公里 → 第二档 10 元', e301.freight === 10, e301)

  // 第二档没有免运费门槛（店主只说"3 公里以内满 35 免"）
  const q5b = DR.calcQuote({ address: addrAtKm(4), goodsAmount: 500, items: [] })
  check('★ 3–5 公里档没有免运费门槛（金额再高也收 10 元）', q5b.freight === 10, q5b)

  const q6 = DR.calcQuote({ address: addrAtKm(6), goodsAmount: 200, items: [] })
  check('★ 6 公里 → 第三档 18 元', q6.freight === 18, q6)
  const q8 = DR.calcQuote({ address: addrAtKm(8), goodsAmount: 200, items: [] })
  check('★ 恰好 8.00 公里 → 仍是第三档 18 元（含等号）', q8.freight === 18, q8)

  const q9 = DR.calcQuote({ address: addrAtKm(9), goodsAmount: 200, items: [] })
  check('★ 超过 8 公里：仍可下单（她打电话沟通，不拒绝）', q9.deliverable === true, q9)
  check('  运费为 null（待确认，不预收）', q9.freight === null, q9.freight)
  check('  文案与配置的 beyondTip 一致（说明要电话确认）',
    q9.freightText === CFG.freight.beyondTip, q9.freightText)
  check('  原因 beyond', q9.reason === 'beyond', q9.reason)
}

console.log('\n=== 7) 运费：蛋糕免配送费规则 ===')
{
  const cakeGoods = {
    isCake: true,
    properties: [{ id: 'size', name: '磅数', childsCurGoods: [
      { id: 's6', name: '6寸' }, { id: 's8', name: '8寸' }
    ] }]
  }
  const bigCake = [{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's6' }] }]

  // 蛋糕 30 元（不满 35 门槛）但在 3km 内 → 免运费（覆盖门槛）
  const q1 = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 30, items: bigCake })
  check('6寸蛋糕+3km内+不满35元 → 仍免运费（覆盖门槛）', q1.freight === 0, q1)
  check('  原因 cake_free', q1.reason === 'cake_free', q1.reason)
  check('  文案含免配送费说明', q1.freightText === '免配送费', q1.freightText)

  // 蛋糕免运费只在 3 公里以内：4 公里走第二档（10 元）
  // 2026-10-14：店主口径是"6 寸及以上蛋糕 **3 公里以内**免配送费"，超出不再免
  const q2 = DR.calcQuote({ address: addrAtKm(4), goodsAmount: 30, items: bigCake })
  check('★ 6寸蛋糕但 4 公里（超出蛋糕免运费范围）→ 按第二档收 10 元',
    q2.freight === 10 && q2.reason === 'within_paid', q2)
  const q2b = DR.calcQuote({ address: addrAtKm(6), goodsAmount: 30, items: bigCake })
  check('  6 公里同样不免 → 18 元', q2b.freight === 18, q2b)

  // 小蛋糕（4寸）不享受蛋糕规则 → 走金额门槛
  const smallCake = [{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's4' }] }]
  const cake4 = {
    isCake: true,
    properties: [{ id: 'size', name: '磅数', childsCurGoods: [{ id: 's4', name: '4寸' }] }]
  }
  const q3 = DR.calcQuote({
    address: addrAtKm(2),
    goodsAmount: 30,
    items: [{ goods: cake4, sku: [{ optionId: 'size', optionValueId: 's4' }] }]
  })
  check('4寸蛋糕不满35元 → 收 5 元（不享受蛋糕规则）', q3.freight === 5, q3)
  check('  原因 within_paid', q3.reason === 'within_paid', q3.reason)

  // 非蛋糕订单即使金额很低也不享受蛋糕规则
  const q4 = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 10, items: [{ goods: { isCake: false }, sku: [] }] })
  check('非蛋糕订单 10 元 → 收 5 元', q4.freight === 5, q4)
}

console.log('\n=== 8) 运费：无经纬度降级（不阻断下单）===')
{
  const noCoord = { province: '云南省', city: '昆明市', district: '安宁市', detail: '太平新城某处' }
  const q = DR.calcQuote({ address: noCoord, goodsAmount: 100, items: [] })
  check('无坐标仍可下单', q.deliverable === true, q)
  check('  距离为 null', q.distanceKm === null, q.distanceKm)
  check('  运费待确认', q.freight === null && q.freightText === CFG.freight.unknownTip, q)
  check('  原因 unknown_distance', q.reason === 'unknown_distance', q.reason)
}

console.log('\n=== 9) 运费：距离异常过远 ===')
{
  const far = Object.assign({ detail: '太平新城某某处' }, { latitude: SHOP_LAT + 0.5, longitude: SHOP_LNG })
  const q = DR.calcQuote({ address: far, goodsAmount: 100, items: [] })
  check('超过 maxSaneKm 提示确认', q.reason === 'too_far', q)
  check('  文案为距离过远提示', q.tip === CFG.area.farAwayTip, q.tip)
}

console.log('\n=== 10) 预约时间校验（注入固定 now，测试稳定）===')
{
  const openingHours = SHOP.openingHours // 09:00-22:00
  // 固定「现在」为 2026-03-01 10:00
  const now = new Date(2026, 2, 1, 10, 0, 0)

  // 非蛋糕订单：applyToAll=false 时不校验提前时间（但仍在营业时间内）
  const q1 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 10, 30),
    items: [],
    now,
    openingHours
  })
  check('非蛋糕可立即下单（半小时后）', q1.valid === true, q1)

  // 蛋糕订单：必须提前 3 小时
  const cakeItems = [{ goods: { isCake: true }, sku: [] }]
  const q2 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 12, 0),
    items: cakeItems,
    now,
    openingHours
  })
  check('蛋糕 + 2小时后 → 拒绝', q2.valid === false && q2.reason === 'too_soon', q2)
  check('  提示含最早可选时间', q2.tip.indexOf('13:00') >= 0, q2.tip)

  const q3 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 13, 0),
    items: cakeItems,
    now,
    openingHours
  })
  check('蛋糕 + 恰好3小时 → 通过（边界含等号）', q3.valid === true, q3)

  const q4 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 15, 0),
    items: cakeItems,
    now,
    openingHours
  })
  check('蛋糕 + 5小时后 → 通过', q4.valid === true, q4)

  // 营业时间校验（09:00-22:00）
  const q5 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 8, 0),
    items: [],
    now,
    openingHours
  })
  check('8:00 未营业 → 拒绝', q5.valid === false && q5.reason === 'closed', q5)

  const q6 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 23, 0),
    items: [],
    now,
    openingHours
  })
  check('23:00 已打烊 → 拒绝', q6.valid === false && q6.reason === 'closed', q6)

  // 未选时间
  const q7 = DR.checkAdvanceTime({ expectTime: null, items: [], now, openingHours })
  check('未选时间 → 拒绝', q7.valid === false && q7.reason === 'no_time', q7)

  // 跨天场景：晚上 21:00 下单蛋糕，最早应为次日 00:00 之后
  const night = new Date(2026, 2, 1, 21, 0, 0)
  const q8 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 1, 22, 0),
    items: cakeItems,
    now: night,
    openingHours
  })
  check('21:00 下单蛋糕选 22:00 → 拒绝（不足3小时）', q8.valid === false, q8)
  const q9 = DR.checkAdvanceTime({
    expectTime: new Date(2026, 2, 2, 10, 0),
    items: cakeItems,
    now: night,
    openingHours
  })
  check('21:00 下单蛋糕选次日 10:00 → 通过', q9.valid === true, q9)
}

console.log('\n=== 11) 日期与时段生成 ===')
{
  const now = new Date(2026, 2, 1, 10, 0, 0)
  const dates = DR.buildDateOptions(now)
  check('生成 7 天日期', dates.length === 7, dates.length)
  check('第一天为今天', dates[0].label === '今天')
  check('第二天为明天', dates[1].label === '明天')
  check('日期格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dates[0].value), dates[0].value)

  const slots = DR.buildTimeSlots(dates[0].value, now)
  check('时段按营业时间生成（09:00 起）', slots[0] === '13:00' || slots[0] === '13:00', slots.slice(0, 3))
  check('时段不超过打烊 22:00', slots[slots.length - 1] <= '22:00', slots[slots.length - 1])
  check('时段按 1 小时粒度', slots.every((s) => s.endsWith(':00')), slots.slice(0, 5))
  check('已过滤掉不足3小时的时段（10:00 时最早 13:00）', slots.every((s) => s >= '13:00'), slots.slice(0, 3))

  // 隔天时段应包含全部营业时段
  const tomorrow = DR.buildTimeSlots(dates[1].value, now)
  check('次日时段含 09:00', tomorrow[0] === '09:00', tomorrow[0])
  check('次日时段含 22:00', tomorrow[tomorrow.length - 1] === '22:00', tomorrow[tomorrow.length - 1])
}

console.log('\n=== 12) 配置一致性检查 ===')
{
  check('配置里 3km 界线一致', CFG.distance.freeWithinKm === 3)
  check('配置里免运费门槛 35 元', CFG.freight.withinFreeAmount === 35)
  check('配置里占位运费 5 元', CFG.freight.withinFee === 5)
  check('蛋糕规则已启用', CFG.cake.enabled === true)
  check('蛋糕最小尺寸 6 寸', CFG.cake.minSizeInch === 6)
  check('蛋糕规则覆盖金额门槛', CFG.cake.overrideThreshold === true)
  check('提前 3 小时', CFG.advance.minHours === 3)
  check('提前规则只适用蛋糕', CFG.advance.applyToAll === false)
  check('3km外允许下单', CFG.freight.beyondEnabled === true)
  check('3km外运费为待确认（null）', CFG.freight.beyondFee === null)
  // 2026-10-10：区域外提示必须给出可执行指引（自提），不能再是含糊的一句话
  check('区域外提示给出了替代方案（改选自提）',
    String(CFG.area.outOfAreaTip).indexOf('自提') >= 0,
    CFG.area.outOfAreaTip)
  // 2026-10-14 店主真机反馈：只给"改自提"一条路太窄，补上"联系商家"
  check('★ 区域外提示同时给出"联系商家"这条路',
    String(CFG.area.outOfAreaTip).indexOf('联系商家') >= 0, CFG.area.outOfAreaTip)

  // ===== 阶段 8 新增：默认值的"不擅自收紧"与镜像一致性 =====
  check('★ 默认不启用不送区域黑名单（店主没给清单前不能自己加）',
    Array.isArray(CFG.area.excludeKeywords) && CFG.area.excludeKeywords.length === 0,
    CFG.area.excludeKeywords)
  check('★ 默认不启用距离上限（拿到店主答案前保持"超距离仍可下单"）',
    CFG.area.forbidBeyondKm === null, CFG.area.forbidBeyondKm)
  check('不送区域提示给了替代方案（自提/联系门店）',
    String(CFG.area.excludedTip).indexOf('自提') >= 0, CFG.area.excludedTip)
  check('超距离提示给了替代方案',
    String(CFG.area.beyondLimitTip).indexOf('自提') >= 0, CFG.area.beyondLimitTip)

  // 距离阶梯（阶段 8）：真正的计费依据是 freight.tiers，
  // 旧键 withinFee / withinFreeAmount / distance.freeWithinKm / beyondFee / beyondTip
  // 只是"首档/尾档镜像"，两边必须一致（否则改一处漏一处 → 屏显与实付不一致）
  const tiers = CFG.freight.tiers
  check('★ 默认配置有距离阶梯（数组，至少 2 档）', Array.isArray(tiers) && tiers.length >= 2,
    tiers && tiers.length)
  check('★ 阶梯首档与旧键一致（maxKm = distance.freeWithinKm）',
    tiers[0].maxKm === CFG.distance.freeWithinKm, { tier: tiers[0], key: CFG.distance.freeWithinKm })
  check('★ 阶梯首档与旧键一致（fee = withinFee）',
    tiers[0].fee === CFG.freight.withinFee, { tier: tiers[0], key: CFG.freight.withinFee })
  check('★ 阶梯首档与旧键一致（freeAmount = withinFreeAmount）',
    tiers[0].freeAmount === CFG.freight.withinFreeAmount,
    { tier: tiers[0], key: CFG.freight.withinFreeAmount })
  const openTier = tiers.find((t) => t.maxKm === null)
  check('★ 阶梯有"以上全部"档（maxKm = null）', !!openTier, tiers)
  check('★ 尾档运费与 beyondFee 一致（null = 待确认）',
    openTier && openTier.fee === CFG.freight.beyondFee, { tier: openTier, key: CFG.freight.beyondFee })
  check('★ 尾档文案与 beyondTip 一致',
    openTier && (openTier.tip || CFG.freight.beyondTip) === CFG.freight.beyondTip,
    { tier: openTier, key: CFG.freight.beyondTip })

  // ===== 店主 2026-10-14 给的完整档位（改这里必须是有意为之，别被顺手改掉）=====
  check('★ 阶梯共 4 档（3/5/8 公里 + 尾档）', tiers.length === 4, tiers.map((t) => t.maxKm))
  check('★ 第二档 = 3–5 公里 10 元',
    tiers[1].maxKm === 5 && tiers[1].fee === 10, tiers[1])
  check('★ 第三档 = 5–8 公里 18 元',
    tiers[2].maxKm === 8 && tiers[2].fee === 18, tiers[2])
  check('★ 3 公里以外不设免运费门槛（她只说了"3 公里以内满 35 免"）',
    tiers[1].freeAmount === null && tiers[2].freeAmount === null, [tiers[1], tiers[2]])
  check('★ 超过 8 公里 = 尾档：运费待确认（她打电话沟通，不拒绝下单）',
    !!openTier && openTier.fee === null && String(openTier.tip).indexOf('确认') >= 0, openTier)
}

console.log('\n=== 13) 云函数侧副本一致性（关键：防止两端运费不一致）===')
{
  const path = require('path')
  const fs = require('fs')

  const cloudShopPath = path.join(__dirname, '../cloudfunctions/api/shop-config.js')
  const cloudCfgPath = path.join(__dirname, '../cloudfunctions/api/delivery-config.js')
  const cloudCalcPath = path.join(__dirname, '../cloudfunctions/api/delivery-calc.js')

  check('云函数 shop-config.js 存在', fs.existsSync(cloudShopPath))
  check('云函数 delivery-config.js 存在', fs.existsSync(cloudCfgPath))
  check('云函数 delivery-calc.js 存在', fs.existsSync(cloudCalcPath))

  if (fs.existsSync(cloudShopPath)) {
    const cloudShop = require(cloudShopPath).shop
    check('云函数门店纬度与主包一致', cloudShop.latitude === SHOP.latitude, {
      cloud: cloudShop.latitude, main: SHOP.latitude
    })
    check('云函数门店经度与主包一致', cloudShop.longitude === SHOP.longitude, {
      cloud: cloudShop.longitude, main: SHOP.longitude
    })
    check('云函数营业时间与主包一致', cloudShop.openingHours === SHOP.openingHours, {
      cloud: cloudShop.openingHours, main: SHOP.openingHours
    })
  }

  if (fs.existsSync(cloudCfgPath)) {
    const cloudCfg = require(cloudCfgPath)
    check('云函数免运费门槛与主包一致', cloudCfg.freight.withinFreeAmount === CFG.freight.withinFreeAmount)
    check('云函数占位运费与主包一致', cloudCfg.freight.withinFee === CFG.freight.withinFee)
    check('云函数 3km 界线与主包一致', cloudCfg.distance.freeWithinKm === CFG.distance.freeWithinKm)
    check('云函数蛋糕规则与主包一致',
      cloudCfg.cake.enabled === CFG.cake.enabled &&
      cloudCfg.cake.minSizeInch === CFG.cake.minSizeInch &&
      cloudCfg.cake.overrideThreshold === CFG.cake.overrideThreshold)
    check('云函数提前小时数与主包一致', cloudCfg.advance.minHours === CFG.advance.minHours)
    // 2026-10-10 新增：配送区域配置也必须两边一致，
    // 否则会出现"顾客端说能送、服务端拒单"或反过来。
    check('云函数配送区域模式与主包一致', cloudCfg.area.mode === CFG.area.mode)
    check('云函数配送关键词与主包一致',
      JSON.stringify(cloudCfg.area.keywords) === JSON.stringify(CFG.area.keywords),
      { cloud: cloudCfg.area.keywords, main: CFG.area.keywords })
    check('云函数区域外文案与主包一致', cloudCfg.area.outOfAreaTip === CFG.area.outOfAreaTip)
    check('云函数距离兜底上限与主包一致', cloudCfg.area.maxSaneKm === CFG.area.maxSaneKm)
    // ===== 阶段 8 新增字段也必须两边一致 =====
    check('★ 云函数不送区域黑名单与主包一致',
      JSON.stringify(cloudCfg.area.excludeKeywords) === JSON.stringify(CFG.area.excludeKeywords),
      { cloud: cloudCfg.area.excludeKeywords, main: CFG.area.excludeKeywords })
    check('★ 云函数不送区域提示与主包一致', cloudCfg.area.excludedTip === CFG.area.excludedTip)
    check('★ 云函数距离上限与主包一致',
      cloudCfg.area.forbidBeyondKm === CFG.area.forbidBeyondKm, cloudCfg.area.forbidBeyondKm)
    check('★ 云函数超距离提示与主包一致', cloudCfg.area.beyondLimitTip === CFG.area.beyondLimitTip)
    check('★ 云函数距离阶梯与主包一致',
      JSON.stringify(cloudCfg.freight.tiers) === JSON.stringify(CFG.freight.tiers),
      { cloud: cloudCfg.freight.tiers, main: CFG.freight.tiers })
  }

  // 校验云函数侧计算逻辑可用且与主包结果一致
  if (fs.existsSync(cloudCalcPath)) {
    const CloudDR = require(cloudCalcPath)
    const addr = addrAtKm(2)
    const mainQuote = DR.calcQuote({ address: addr, goodsAmount: 30, items: [] })
    const cloudQuote = CloudDR.calcQuote({ address: addr, goodsAmount: 30, items: [] })
    check('两端运费结果一致（30元/2km）',
      mainQuote.freight === cloudQuote.freight && mainQuote.reason === cloudQuote.reason,
      { main: mainQuote, cloud: cloudQuote })

    const addr5 = addrAtKm(5)
    const m2 = DR.calcQuote({ address: addr5, goodsAmount: 100, items: [] })
    const c2 = CloudDR.calcQuote({ address: addr5, goodsAmount: 100, items: [] })
    check('两端运费结果一致（100元/5km）',
      m2.freight === c2.freight && m2.reason === c2.reason,
      { main: m2, cloud: c2 })

    const dist1 = DR.calcDistanceKm(SHOP.latitude, SHOP.longitude, addr.latitude, addr.longitude)
    const dist2 = CloudDR.calcDistanceKm(SHOP.latitude, SHOP.longitude, addr.latitude, addr.longitude)
    check('两端距离计算一致', dist1 === dist2, { main: dist1, cloud: dist2 })
  }
}

// ===========================================================================
// 阶段 8：运行期规则（云库 app_config.delivery_rule）
// ===========================================================================
console.log('\n=== 14) 阶段 8：不送区域黑名单（R-05「哪些地方不送」）===')
{
  // ---- 先确认默认（无云库规则）时黑名单不生效 ----
  DR.setDeliveryRule(null)
  const q0 = DR.calcQuote({ address: addrAtKm(2, '太平新城山水间小区3栋'), goodsAmount: 30, items: [] })
  check('默认无黑名单时「山水间」照常配送', q0.deliverable === true && q0.reason === 'within_paid', q0)

  // ---- 装入带黑名单的规则 ----
  DR.setDeliveryRule({
    area: { excludeKeywords: ['山水间', '某某花园'] }
  })

  const q1 = DR.calcQuote({ address: addrAtKm(2, '太平新城山水间小区3栋'), goodsAmount: 100, items: [] })
  check('★ 命中不送区域 → 不可配送', q1.deliverable === false, q1)
  check('  原因 excluded_area', q1.reason === 'excluded_area', q1.reason)
  check('  提示取自云库配置的 excludedTip',
    q1.freightText === DR.getDeliveryRule().area.excludedTip, q1.freightText)
  check('  运费为 null', q1.freight === null, q1.freight)

  // 黑名单优先于白名单：地址同时含「太平新城」与「山水间」也必须拒
  const both = addrAtKm(2, '安宁市太平新城山水间小区1栋')
  check('前置：该地址同时命中白名单关键词与黑名单关键词',
    DR.checkArea(both).code === 'excluded', DR.checkArea(both))
  const q2 = DR.calcQuote({ address: both, goodsAmount: 500, items: [] })
  check('★ 黑名单优先于白名单（金额再高也不送）', q2.deliverable === false && q2.reason === 'excluded_area', q2)

  // 未命中黑名单的地址不受影响
  const q3 = DR.calcQuote({ address: addrAtKm(2, '太平新城某小区1栋101'), goodsAmount: 50, items: [] })
  check('未命中黑名单的地址照常免运费', q3.deliverable === true && q3.freight === 0, q3)

  // checkArea 的方法标记（便于诊断"到底是黑名单还是白名单拒的"）
  check('checkArea 命中黑名单时 method = exclude', DR.checkArea(both).method === 'exclude')

  DR.setDeliveryRule(null)
}

console.log('\n=== 15) 阶段 8：距离上限 + 距离阶梯运费（R-03 / R-05）===')
{
  // ---- 默认：不启用距离上限（拿到店主答案前行为不变）----
  DR.setDeliveryRule(null)
  const qFarDefault = DR.calcQuote({ address: addrAtKm(9), goodsAmount: 200, items: [] })
  check('默认无距离上限：9km 仍可下单（运费待确认）',
    qFarDefault.deliverable === true && qFarDefault.reason === 'beyond', qFarDefault)

  // ---- 装入"距离上限 8km + 四档阶梯"的规则 ----
  DR.setDeliveryRule({
    area: { forbidBeyondKm: 8 },
    freight: {
      tiers: [
        { maxKm: 3, fee: 5, freeAmount: 35 },
        { maxKm: 5, fee: 8, freeAmount: 60 },
        { maxKm: 8, fee: 12, freeAmount: 120 },
        { maxKm: null, fee: null, freeAmount: null, tip: '运费待确认' }
      ]
    }
  })

  // ---- 档位匹配 ----
  const t1 = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 30, items: [] })
  check('2km 不满 35 → 首档 5 元', t1.freight === 5 && t1.reason === 'within_paid', t1)
  const t1b = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 35, items: [] })
  check('2km 恰好 35 → 免运费（边界含等号）', t1b.freight === 0 && t1b.reason === 'amount_free', t1b)

  const t2 = DR.calcQuote({ address: addrAtKm(4), goodsAmount: 54, items: [] })
  check('★ 4km 不满 60 → 第二档 8 元', t2.freight === 8, t2)
  check('  提示按该档门槛生成', t2.tip.indexOf('60') >= 0, t2.tip)
  const t2b = DR.calcQuote({ address: addrAtKm(4), goodsAmount: 60, items: [] })
  check('4km 恰好 60 → 免运费', t2b.freight === 0, t2b)

  const t3 = DR.calcQuote({ address: addrAtKm(6), goodsAmount: 100, items: [] })
  check('★ 6km → 第三档 12 元', t3.freight === 12, t3)
  const t3b = DR.calcQuote({ address: addrAtKm(6), goodsAmount: 120, items: [] })
  check('6km 恰好 120 → 免运费', t3b.freight === 0, t3b)

  // ---- 档位边界：3.00 归首档 / 3.01 归第二档 ----
  const edge300 = DR.calcQuote({ address: addrAtKm(3), goodsAmount: 30, items: [] })
  const edge301 = DR.calcQuote({ address: addrAtKm(3.01), goodsAmount: 30, items: [] })
  check('★ 恰好 3.00km → 首档 5 元（含等号）',
    edge300.freight === 5 && Math.abs(edge300.distanceKm - 3) < 0.01, edge300)
  check('★ 3.01km → 第二档 8 元', edge301.freight === 8, edge301)

  // ---- 档位匹配函数本身 ----
  check('pickTier 按上限升序命中（2km→首档 / 4km→第二档 / 8km→第三档）',
    DR.pickTier(2).fee === 5 && DR.pickTier(4).fee === 8 && DR.pickTier(8).fee === 12,
    [DR.pickTier(2), DR.pickTier(4), DR.pickTier(8)])

  // ---- 距离上限：8.00 通过 / 8.01 拒绝 ----
  const at8 = DR.calcQuote({ address: addrAtKm(8), goodsAmount: 200, items: [] })
  check('★ 恰好 8.00km 仍可配送（边界含等号）', at8.deliverable === true, at8)
  const over8 = DR.calcQuote({ address: addrAtKm(8.01), goodsAmount: 200, items: [] })
  check('★ 8.01km → 超出上限，不可配送', over8.deliverable === false, over8)
  check('  原因 beyond_limit', over8.reason === 'beyond_limit', over8.reason)
  check('  提示取自 beyondLimitTip',
    over8.freightText === DR.getDeliveryRule().area.beyondLimitTip, over8.freightText)
  check('  距离仍然算出来（便于诊断）', Math.abs(over8.distanceKm - 8.01) < 0.05, over8.distanceKm)

  // 上限优先于阶梯：9km 明明命中"以上全部"档，也必须拒
  const over9 = DR.calcQuote({ address: addrAtKm(9), goodsAmount: 200, items: [] })
  check('★ 距离上限优先于阶梯（9km 不再走"待确认"档）',
    over9.deliverable === false && over9.reason === 'beyond_limit', over9)

  // 蛋糕免运费不能突破距离上限
  const cakeGoods = {
    isCake: true,
    properties: [{ id: 'size', name: '磅数', childsCurGoods: [{ id: 's6', name: '6寸' }] }]
  }
  const cakeFar = DR.calcQuote({
    address: addrAtKm(9), goodsAmount: 300,
    items: [{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's6' }] }]
  })
  check('★ 蛋糕免运费规则也不能突破距离上限',
    cakeFar.deliverable === false && cakeFar.reason === 'beyond_limit', cakeFar)
  const cakeNear = DR.calcQuote({
    address: addrAtKm(2), goodsAmount: 30,
    items: [{ goods: cakeGoods, sku: [{ optionId: 'size', optionValueId: 's6' }] }]
  })
  check('  上限之内蛋糕规则照常生效（2km/6寸 → 免费）',
    cakeNear.freight === 0 && cakeNear.reason === 'cake_free', cakeNear)

  // ---- 所有档位都有上限且全超了 → 按"待确认"处理（不阻断下单）----
  DR.setDeliveryRule({ freight: { tiers: [{ maxKm: 3, fee: 5, freeAmount: 35 }] } })
  const noTier = DR.calcQuote({ address: addrAtKm(6), goodsAmount: 100, items: [] })
  check('★ 只有闭区间档位且全超了 → 运费待确认（不擅自拒单）',
    noTier.deliverable === true && noTier.freight === null && noTier.reason === 'beyond', noTier)

  // ---- tiers 覆盖旧键：tiers 才是计费依据 ----
  DR.setDeliveryRule({
    freight: { withinFee: 99, withinFreeAmount: 999, tiers: [{ maxKm: 3, fee: 7, freeAmount: 20 }] }
  })
  const cover = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 10, items: [] })
  check('★ 有 tiers 时以 tiers 为准（旧键 withinFee=99 不生效，收 7 元）', cover.freight === 7, cover)

  DR.setDeliveryRule(null)
}

console.log('\n=== 16) 阶段 8：规则容错（云库写坏了也不能算错钱）===')
{
  // ---- 非对象 / 空 → 默认 ----
  DR.setDeliveryRule('not-an-object')
  check('传字符串 → 回退默认规则', DR.getDeliveryRule() === DR.getDefaultDeliveryRule())
  DR.setDeliveryRule({})
  const empty = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 30, items: [] })
  check('传空对象 → 仍按默认规则收 5 元', empty.freight === 5, empty)

  // ---- 非法数值逐项回退，不整体丢弃 ----
  DR.setDeliveryRule({
    area: { forbidBeyondKm: -1, maxSaneKm: 'abc', excludedTip: '   ' },
    freight: { tiers: 'nope', withinFee: 6 }
  })
  const r1 = DR.getDeliveryRule()
  check('★ 负数距离上限被丢弃（保持默认 null）', r1.area.forbidBeyondKm === null, r1.area.forbidBeyondKm)
  check('★ 非数字 maxSaneKm 被丢弃（保持默认 20）', r1.area.maxSaneKm === 20, r1.area.maxSaneKm)
  check('★ 空白提示文案被丢弃（保持默认文案）',
    r1.area.excludedTip === CFG.area.excludedTip, r1.area.excludedTip)
  check('★ tiers 非法 → 用（已覆盖的）旧键合成档位',
    Array.isArray(r1.freight.tiers) && r1.freight.tiers[0].fee === 6, r1.freight.tiers)
  const r1q = DR.calcQuote({ address: addrAtKm(2), goodsAmount: 30, items: [] })
  check('  合成档位真的生效（2km/30 → 6 元）', r1q.freight === 6, r1q)

  // ---- 阶梯里混入非法档位 → 整份阶梯不采用（避免"半截阶梯"算错）----
  DR.setDeliveryRule({ freight: { tiers: [{ maxKm: 'abc', fee: 1 }, { maxKm: null, fee: 2 }] } })
  const r2tiers = DR.getDeliveryRule().freight.tiers
  check('★ 阶梯含非法档位 → 整份回退（不采用半截阶梯）',
    r2tiers.length === 2 && r2tiers[0].fee === CFG.freight.withinFee, r2tiers)

  // ---- 不累积：第二条规则未提供的字段回退"代码默认值"，而不是上一条规则的值 ----
  DR.setDeliveryRule({ freight: { withinFee: 9 } })
  check('前置：第一条规则把首档运费改成 9',
    DR.getDeliveryRule().freight.tiers[0].fee === 9, DR.getDeliveryRule().freight.tiers)
  DR.setDeliveryRule({ area: { excludeKeywords: ['山水间'] } })
  check('★ 规则之间互不累积（第二条没提运费 → 回到默认 5）',
    DR.getDeliveryRule().freight.tiers[0].fee === CFG.freight.withinFee,
    DR.getDeliveryRule().freight.tiers)

  // ---- 默认配置对象不能被 normalize 改坏（它是所有规则的基础）----
  check('★ normalize 不改动代码默认值（DEFAULT_CFG 未被污染）',
    CFG.freight.tiers[0].fee === 5 && CFG.area.excludeKeywords.length === 0,
    { fee: CFG.freight.tiers[0].fee, ex: CFG.area.excludeKeywords })

  // ---- 下发给前端的规则结构完整 ----
  const full = DR.setDeliveryRule({ area: { excludeKeywords: ['x'] } })
  ;['area', 'distance', 'freight', 'cake', 'advance'].forEach((k) => {
    check('下发规则含 ' + k + ' 节', !!full[k], Object.keys(full))
  })
  check('下发规则里 tiers 已归一化（数组）', Array.isArray(full.freight.tiers))

  DR.setDeliveryRule(null)
  check('复位后回到代码默认值', DR.getDeliveryRule() === DR.getDefaultDeliveryRule())
}

console.log('\n=== 17) 阶段 8：两端副本由脚本生成（逐字节一致）===')
{
  const path = require('path')
  const fs = require('fs')
  const SYNC = require('../cloud-data/tools/sync-delivery')

  const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const mainCfgSrc = rd('config/delivery.js')
  const mainCalcSrc = rd('utils/delivery-range.js')
  const cloudCfgSrc = rd('cloudfunctions/api/delivery-config.js')
  const cloudCalcSrc = rd('cloudfunctions/api/delivery-calc.js')

  check('★ 云函数配送配置 == 主包配置经 sync-delivery 生成的结果（逐字节）',
    SYNC.transform('config', mainCfgSrc) === cloudCfgSrc)
  check('★ 云函数配送计算 == 主包计算经 sync-delivery 生成的结果（逐字节）',
    SYNC.transform('calc', mainCalcSrc) === cloudCalcSrc)
  check('云函数副本的 require 路径已改成云函数内相对路径',
    cloudCalcSrc.indexOf("require('./delivery-config')") >= 0 &&
    cloudCalcSrc.indexOf("require('../config/delivery')") < 0, true)
  check('云函数副本仍指向一致的 shop-config 路径',
    cloudCalcSrc.indexOf("require('./shop-config')") >= 0 &&
    cloudCalcSrc.indexOf("require('../shop-config')") < 0, true)
  check('主包文件里没有残留云函数专用 require',
    mainCalcSrc.indexOf("require('./delivery-config')") < 0)

  // ---- 同一份规则装到两端，结果必须逐字段一致（这是"屏显运费 == 实付"的根）----
  const CloudDR = require('../cloudfunctions/api/delivery-calc')
  const rule = {
    area: { excludeKeywords: ['山水间'], forbidBeyondKm: 8 },
    freight: {
      tiers: [
        { maxKm: 3, fee: 5, freeAmount: 35 },
        { maxKm: 5, fee: 8, freeAmount: 60 },
        { maxKm: 8, fee: 12, freeAmount: 120 },
        { maxKm: null, fee: null, freeAmount: null, tip: '运费待确认' }
      ]
    }
  }
  DR.setDeliveryRule(rule)
  CloudDR.setDeliveryRule(rule)
  const cases = [
    { km: 2, amount: 30, detail: '太平新城某小区1栋101' },
    { km: 4, amount: 54, detail: '太平新城某小区1栋101' },
    { km: 6, amount: 100, detail: '太平新城某小区1栋101' },
    { km: 9, amount: 100, detail: '太平新城某小区1栋101' },
    { km: 2, amount: 100, detail: '太平新城山水间小区3栋' }
  ]
  cases.forEach((c) => {
    const addr = addrAtKm(c.km, c.detail)
    const a = DR.calcQuote({ address: addr, goodsAmount: c.amount, items: [] })
    const b = CloudDR.calcQuote({ address: addr, goodsAmount: c.amount, items: [] })
    check('两端一致（' + c.km + 'km / ' + c.amount + '元 / ' + c.detail.slice(0, 5) + '…）',
      a.freight === b.freight && a.reason === b.reason && a.deliverable === b.deliverable &&
      a.freightText === b.freightText,
      { main: a, cloud: b })
  })
  DR.setDeliveryRule(null)
  CloudDR.setDeliveryRule(null)
}

console.log('\n=== 18) 云库规则模板与代码默认值一致（防止"模板和代码说的不是一回事"）===')
{
  const fs = require('fs')
  const path = require('path')
  const jlPath = path.join(__dirname, '../cloud-data/delivery-rule.sample.jsonl')
  const jsonPath = path.join(__dirname, '../cloud-data/delivery-rule.sample.json')

  const raw = fs.readFileSync(jlPath, 'utf8').trim()
  const twin = fs.readFileSync(jsonPath, 'utf8').trim()
  check('模板的两份副本内容一致（.jsonl 与 .json）', raw === twin)

  let rec = null
  try {
    rec = JSON.parse(raw)
  } catch (e) {
    check('模板是合法 JSON', false, e.message)
  }
  if (rec) {
    check('模板是 app_config 的一条记录（key = delivery_rule）', rec.key === 'delivery_rule', rec.key)
    const applied = DR.normalizeRule(rec.value)
    check('★ 模板的阶梯与代码默认阶梯逐条一致（导入它不会改变线上运费）',
      JSON.stringify(applied.freight.tiers) === JSON.stringify(CFG.freight.tiers),
      { tpl: applied.freight.tiers, cfg: CFG.freight.tiers })
    check('  模板的黑名单为空、距离上限不启用（与代码默认一致）',
      applied.area.excludeKeywords.length === 0 && applied.area.forbidBeyondKm === null,
      { ex: applied.area.excludeKeywords, km: applied.area.forbidBeyondKm })
    check('  模板里没有多余的越权字段（只覆盖 area / freight）',
      Object.keys(rec.value).every((k) => k === 'area' || k === 'freight'),
      Object.keys(rec.value))
  }
}

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' / 失败 ' + fail)
if (fail) process.exitCode = 1
