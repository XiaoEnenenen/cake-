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
  check('  文案「超出配送范围」', q.freightText === CFG.area.outOfAreaTip, q.freightText)
  check('  运费为 null', q.freight === null, q.freight)

  // 区域外即使金额很高、距离很近也不送
  const q2 = DR.calcQuote({
    address: Object.assign({}, outside, coordAtKm(0.5)),
    goodsAmount: 500,
    items: []
  })
  check('区域外且距离很近 → 仍不配送', q2.deliverable === false && q2.reason === 'out_of_area', q2)
}

console.log('\n=== 6) 运费：3 公里以外（可下单，运费待确认）===')
{
  const q = DR.calcQuote({ address: addrAtKm(5), goodsAmount: 200, items: [] })
  check('3km外仍可下单', q.deliverable === true, q)
  check('  原因 beyond', q.reason === 'beyond', q.reason)
  check('  运费为 null（待确认）', q.freight === null, q.freight)
  check('  文案「运费待确认」', q.freightText === CFG.freight.beyondTip, q.freightText)
  check('  距离已算出约 5', Math.abs(q.distanceKm - 5) < 0.1, q.distanceKm)
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

  // 蛋糕但在 3km 外 → 走待确认
  const q2 = DR.calcQuote({ address: addrAtKm(4), goodsAmount: 30, items: bigCake })
  check('6寸蛋糕但超出3km → 运费待确认', q2.freight === null && q2.reason === 'beyond', q2)

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

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' / 失败 ' + fail)
if (fail) process.exitCode = 1
