/**
 * 距离文案回归测试（2026-10-10）
 * ---------------------------------------------------------------------------
 * 背景（店主实测反馈）：
 *   外送下单时，结算页门店卡上的气泡显示的是「距离您 282.35km」——
 *   那是**当前用户定位到门店**的距离（开发者工具/人在外面时完全不等于配送距离），
 *   而顾客真正关心的是「收货地址 → 门店」有多远（它同时也是运费的计算依据）。
 *
 * 修复后的规则（本文件逐条守住）：
 *   1) components/shop-map 增加 distanceText 属性：页面传了就优先用，且不再申请定位；
 *      没传则沿用老行为（定位 → 「距离您 X」）。
 *   2) 结算页：外送 = 「配送距离 X」（收货地址 → 门店，来自同一个 calcQuote）；
 *      未选地址 = 「待选择收货地址」；自提 = 留空 → 显示「距离您 X」。
 *   3) 订单详情页：外送订单用订单快照里的「配送距离」（下单时算好的那个值），
 *      自提订单留空。
 *
 * 说明：这些是页面/组件代码，依赖 wx.*，无法在 node 里执行，
 *      因此用源码级断言 + 纯函数断言（同 tests/test-data-source.js 的做法）。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const LOC = require('../utils/location')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

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

const MAP_JS = 'components/shop-map/index.js'
const MAP_WXML = 'components/shop-map/index.wxml'
const PAY_JS = 'pages/pay/index.js'
const PAY_WXML = 'pages/pay/index.wxml'
const VIEW_JS = 'pages/order-view/index.js'
const VIEW_WXML = 'pages/order-view/index.wxml'

const mapJs = src(MAP_JS)
const mapWxml = src(MAP_WXML)
const payJs = src(PAY_JS)
const payWxml = src(PAY_WXML)
const viewJs = src(VIEW_JS)
const viewWxml = src(VIEW_WXML)

console.log('=== 0) 改动的页面/组件可编译 ===')
;[MAP_JS, PAY_JS, VIEW_JS].forEach((rel) => {
  let err = null
  try {
    new vm.Script(src(rel), { filename: rel })
  } catch (e) {
    err = e
  }
  check('可编译：' + rel, err === null, err && err.message)
})

console.log('\n=== 1) 组件：外部距离优先，且不再多申请一次定位 ===')
check('组件暴露 distanceText 属性（父页面唯一的覆盖接口）',
  /distanceText:\s*\{[\s\S]{0,120}type:\s*String/.test(mapJs))
check('内部文案改名为 locateText（避免与属性同名互相覆盖）',
  /locateText:\s*''/.test(mapJs) && /locateText:\s*text \? '距离您 '/.test(mapJs))
check('气泡优先显示外部文案：distanceText || locateText',
  /wx:if="\{\{\s*showDistance && \(distanceText \|\| locateText\)\s*\}\}"/.test(mapWxml) &&
  /\{\{\s*distanceText \|\| locateText\s*\}\}/.test(mapWxml))
check('传了 distanceText 就不再自动定位（避免误导数字与无谓授权）',
  /!this\.data\.distanceText && !this\._autoLocated/.test(mapJs))
check('外部文案被清空时补做一次定位（外送→自提切回仍能显示距离您）',
  /distanceText\(text\)\s*\{[\s\S]{0,600}this\.locate\(\)/.test(mapJs))
check('★ 外部文案到位时清掉残留的定位失败/授权提示（结算页不再挂"需先同意隐私指引"）',
  /if \(text\) \{[\s\S]{0,200}hint: '', hintDenied: false, hintPrivacy: false, locateText: ''/.test(mapJs),
  '真机反馈：外送给出「配送距离」后仍显示定位隐私提示')

console.log('\n=== 2) 结算页：外送显示「配送距离」（收货地址 → 门店）===')
check('结算页把距离文案传给组件', /distance-text="\{\{\s*mapDistanceText\s*\}\}"/.test(payWxml))
check('mapDistanceText 声明在 data 里（否则 WXML 首渲染读不到）',
  /mapDistanceText:\s*''/.test(payJs))
check('外送文案来自 quote.distanceKm（与运费同源），不是定位结果',
  /const mapDistanceText = \(km === null \|\| km === undefined\)[\s\S]{0,160}'配送距离 ' \+ LOC\.formatDistance\(km\)/.test(payJs))
check('用的是收货地址算出来的 quote.distanceKm',
  /const km = quote\.distanceKm/.test(payJs))
check('没选收货地址时显示「待选择收货地址」而不是退回当前位置距离',
  /mapDistanceText:\s*'待选择收货地址'/.test(payJs))
check('自提时清空气泡（由组件显示「距离您 X」）',
  /if \(!this\.data\.isDelivery\) \{[\s\S]{0,400}mapDistanceText:\s*''/.test(payJs))
check('结算页没有再自己读 wx.getLocation 算距离',
  payJs.indexOf('getLocation') < 0)
check('首渲染前就定气泡文案（外送不给组件触发定位的机会）',
  /syncDeliveryMode\(\)\s*\{[\s\S]{0,700}mapDistanceText:\s*isDelivery \? '待选择收货地址' : ''/.test(payJs))

console.log('\n=== 3) 订单详情：外送用订单快照的配送距离 ===')
check('详情页把距离文案传给组件',
  /distance-text="\{\{\s*orderDetail\.orderInfo\.mapDistanceText\s*\}\}"/.test(viewWxml))
check('外送订单取快照 extJson.配送距离',
  /mapDistanceText\s*=[\s\S]{0,200}'配送距离 ' \+ snapshot/.test(viewJs))
check('只在 deliveryMode === delivery 时用快照（自提留空）',
  /deliveryMode === 'delivery' && snapshot/.test(viewJs))
check('详情页没有再自己算距离', viewJs.indexOf('getLocation') < 0)

console.log('\n=== 4) 距离文案格式化（纯函数）===')
check('不足 1 公里按米显示：0.86 → 860m', LOC.formatDistance(0.86) === '860m', LOC.formatDistance(0.86))
check('1 公里以上按 km 显示：282.35 → 282.35km',
  LOC.formatDistance(282.35) === '282.35km', LOC.formatDistance(282.35))
check('算不出距离时返回空串（不显示 NaN）',
  LOC.formatDistance(null) === '' && LOC.formatDistance(undefined) === '', LOC.formatDistance(null))

console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
