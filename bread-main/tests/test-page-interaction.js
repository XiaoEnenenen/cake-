/**
 * 页面交互守卫（点击区域 / 事件冒泡）
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件：这类问题在小程序里**只会在真机上被顾客发现**，
 * node 测试跑不到页面代码（依赖 wx.*），而一旦写错后果很直接 ——
 *   · 点击区域太小 → 顾客以为按钮坏了（店主实测反馈：以为只有「>」能点）
 *   · 卡片可点但按钮用了 bindtap → 一次点击触发两个动作
 *     （点「取消订单」的同时跳进详情页；点「完成订单」同理）
 * 所以用源码级断言把规则固定下来（同 tests/test-data-source.js 的做法）。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

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

const WXML = 'pages/current-order/index.wxml'
const WXSS = 'pages/current-order/index.wxss'
const JS = 'pages/current-order/index.js'

const wxml = src(WXML)
const wxss = src(WXSS)
// 卡片的样式块本体（`*?` 懒匹配到第一个行首 `}`）。
// 为什么解析出来而不是用「从 { 往后数 N 个字符」：卡片注释一多就会被顶出窗口，
// 断言会莫名失败（2026-10-12 实际踩到过一次）。
const cardCssBlock = (wxss.match(/\.order-details-bar\s*\{[\s\S]*?\n\}/) || [''])[0]

console.log('=== 0) 页面文件可编译 ===')
let err = null
try {
  new vm.Script(src(JS), { filename: JS })
} catch (e) {
  err = e
}
check('可编译：' + JS, err === null, err && err.message)

console.log('\n=== 1) 整张订单卡片可点击进详情 ===')
// 卡片最外层必须是 navigator，且 class 就是卡片样式（保证整卡都是点击热区）
const cardNav = wxml.match(/<navigator[\s\S]*?class="order-details-bar"[\s\S]*?>/)
check('卡片最外层是 <navigator class="order-details-bar">', !!cardNav, cardNav && cardNav[0].slice(0, 80))
check('navigator 指向订单详情页并带订单 id',
  /url="\/pages\/order-view\/index\?id=\{\{item\.id\}\}"/.test(wxml))
check('表格/卡片内不再嵌套第二个 navigator（避免双层热区）',
  (wxml.match(/<navigator/g) || []).length === 1,
  (wxml.match(/<navigator/g) || []).length)
check('卡片有按压反馈（hover-class 不是 none，顾客能感知可点）',
  /hover-class="(?!none)[\w-]+"/.test(cardNav ? cardNav[0] : ''),
  cardNav && cardNav[0].match(/hover-class="[^"]*"/))
check('wxss 里定义了该 hover class（且排在卡片底色之后）',
  /\.order-card-hover\s*\{/.test(wxss) &&
  wxss.indexOf('.order-card-hover') > wxss.indexOf('.order-details-bar'),
  'hover class 必须定义在卡片样式之后才盖得住白底')
check('卡片显式 display: block（不依赖 navigator 默认行为）',
  /display:\s*block/.test(cardCssBlock), cardCssBlock.slice(0, 60))
check('卡片仍保留原有卡片样式（圆角/阴影/白底）',
  /border-radius:/.test(cardCssBlock) &&
  /box-shadow:/.test(cardCssBlock) &&
  /background-color:\s*#ffffff/i.test(cardCssBlock), cardCssBlock.slice(0, 60))

console.log('\n=== 2) 卡片内的操作按钮必须用 catchtap（阻止冒泡，否则一次点击两个动作）===')
const ACTIONS = ['cancelOrderTap', 'deleteorder', 'callShop', 'toPayTap', 'finishOrderTap']
ACTIONS.forEach((fn) => {
  check('按钮 ' + fn + ' 用 catchtap', new RegExp('catchtap="' + fn + '"').test(wxml))
  check('  且没有残留 bindtap="' + fn + '"', !new RegExp('bindtap="' + fn + '"').test(wxml))
})
// 反向检查：卡片范围内不允许再出现任何 bindtap（全部应为 catchtap）
const cardBlock = wxml.slice(wxml.indexOf('<navigator'), wxml.indexOf('</navigator>'))
const bindtapsInCard = (cardBlock.match(/bindtap="/g) || []).length
check('卡片范围内没有裸 bindtap（共 ' + bindtapsInCard + ' 处）', bindtapsInCard === 0)
check('卡片范围内的按钮事件数量与改造前一致（5 个动作都在）',
  ACTIONS.every((fn) => cardBlock.indexOf('catchtap="' + fn + '"') >= 0))

console.log('\n=== 3) 卡片外的页面元素不受影响 ===')
check('顶部「当前订单 / 历史订单」仍用 bindtap 切 tab（两种 tab 态各一套）',
  (wxml.match(/bindtap="changeTab"/g) || []).length >= 2 &&
  /bindtap="changeTab"[^>]*>当前订单/.test(wxml) &&
  /bindtap="changeTab"[^>]*>历史订单/.test(wxml))
check('空态提示仍在（暂无订单记录）', /暂无订单记录/.test(wxml))
check('底部 tabbar 仍引入', /template is="tabbar"/.test(wxml))

console.log('\n=== 4) 卡片垂直留白：底部与顶部对齐（2026-10-12 加了倒计时那行后按钮贴边）===')
// 起因：加上「剩余 xx:xx 自动取消」一行后卡片变高，原来底部只靠按钮行自身的
//      margin-bottom: 20rpx，按钮贴着卡片下边缘，看着局促。
// 规则：卡片四周内边距统一 30rpx；按钮行的下边距交给卡片 padding，避免叠加。
check('卡片内边距顶部 = 30rpx',
  /padding-top:\s*30rpx/.test(cardCssBlock), cardCssBlock.slice(0, 60))
check('卡片内边距底部 = 30rpx（按钮不再贴下边缘）',
  /padding-bottom:\s*30rpx/.test(cardCssBlock), cardCssBlock.slice(0, 60))
check('按钮行不再自带下边距（否则与卡片 padding 叠加）',
  /\.order-details-bar\s+\.botton-bar\s*\{[\s\S]*?margin:\s*20rpx\s+30rpx\s+0/.test(wxss))

console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
