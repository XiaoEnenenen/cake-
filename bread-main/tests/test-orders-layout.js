/**
 * 点单页「底部遮挡」布局回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 背景（店主截图反馈）：
 *   「购物车这里有遮挡的情况」—— 底部固定的结算栏把内容压住了：
 *     · 左侧分类栏最后几行（推荐 / 折扣）永远点不到
 *     · 右侧商品卡片的价格行被结算栏盖住
 *
 * 根因：两个 scroll-view 的高度写的是 `calc(100vh - 500rpx)`，即「一屏高减去一个
 *       **估算**的表头高度」。它把滚动区一直铺到屏幕最底部，而底部被两条固定栏
 *       占着 —— 结算栏 120rpx + van-tabbar 50px(=100rpx) + 全面屏安全区。
 *       于是最底下约 220rpx 的内容永远压在结算栏下面。
 *       （表头里有「外送提示」「店铺公告」两个条件块，估算值本身也不可靠）
 *
 * 修法：改成 flex 列骨架 —— 整页固定一屏高，中间区域自动占满
 *       「一屏 - 结算栏 - tabbar - 安全区」的剩余空间，高度不再依赖估算值。
 *
 * 这一份测试守住三件事：
 *   1) wxml 结构：表头和菜单区确实被 .page-wrap 包住，结算栏在它**外面**
 *      （用标签配对解析真实嵌套深度，不是数标签个数）
 *   2) 高度不再有硬编码估算：side-bar / goods-list 不许再出现 100vh
 *   3) ★ 防高度漂移：骨架预留的 220rpx 必须等于「结算栏 120rpx + tabbar 100rpx」，
 *      且 tabbar 的 100rpx 要跟 @vant/weapp 实际的 50px 对得上 ——
 *      以后谁改了结算栏高度或升级了 vant 把 tabbar 改高，这条会立刻失败
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const WXML = 'pages/orders/index.wxml'
const WXSS = 'pages/orders/index.wxss'
const VANT_TABBAR = 'miniprogram_npm/@vant/weapp/tabbar/index.wxss'

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

/** 取 css 里某个选择器的样式块本体 */
function cssBlock(wxss, selector) {
  const re = new RegExp(selector.replace(/[.]/g, '\\.') + '\\s*\\{([\\s\\S]*?)\\n\\}')
  const m = wxss.match(re)
  return m ? m[1] : ''
}

/**
 * 解析 wxml 的标签嵌套，返回每个 view/scroll-view 的深度。
 * 先去掉注释（注释里出现 `<view` 字样会污染统计），再按出现顺序压栈。
 * 只跟踪 view / scroll-view：本页其余容器（van-popup 等）都在断言点之后，
 * 不影响 shop-head / main-tabs / menu-wrap / settle-bar 的深度判定。
 */
function nesting(wxml) {
  const clean = wxml.replace(/<!--[\s\S]*?-->/g, '')
  const re = /<(\/?)(view|scroll-view)\b[^>]*?(\/?)>/g
  const stack = []
  const marks = []
  let m
  while ((m = re.exec(clean))) {
    if (m[1] === '/') {
      stack.pop()
      continue
    }
    if (m[3] === '/') continue // 自闭合
    const cls = (m[0].match(/class="([^"]*)"/) || [])[1] || ''
    marks.push({ tag: m[2], depth: stack.length, cls })
    stack.push(m[2])
  }
  return { marks, unclosed: stack }
}

function findMark(marks, cls) {
  return marks.find((x) => x.cls.split(/\s+/).indexOf(cls) >= 0)
}

const wxml = src(WXML)
const wxss = src(WXSS)
const { marks, unclosed } = nesting(wxml)

console.log('=== 1) wxml 标签配对正常（防止包裹层改错） ===')
check('没有未闭合的 view / scroll-view', unclosed.length === 0, unclosed)

console.log('\n=== 2) 页面骨架：表头与菜单区在 .page-wrap 内，结算栏在它外面 ===')
const pageWrap = findMark(marks, 'page-wrap')
check('存在 .page-wrap 骨架容器', !!pageWrap)
check('骨架在最外层（深度 0）', pageWrap && pageWrap.depth === 0, pageWrap)
;[
  ['shop-head', '店铺信息卡'],
  ['main-tabs', '菜单次栏'],
  ['menu-wrap', '左分类栏 + 右商品列表']
].forEach(([cls, label]) => {
  const mk = findMark(marks, cls)
  check(label + '（.' + cls + '）在骨架内（深度 1）', mk && mk.depth === 1, mk)
})
const settle = findMark(marks, 'settle-bar')
check('结算栏在骨架外（深度 0），定位不受骨架影响', settle && settle.depth === 0, settle)

console.log('\n=== 3) 高度不再依赖估算表头 ===')
// 断言「有没有写死 100vh」时必须先去掉注释 —— 注释里正解释着「不再写死 100vh」
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const sideBarBlock = cssBlock(wxss, '.side-bar')
const goodsListBlock = cssBlock(wxss, '.goods-list')
check('删除 .side-bar 里的 100vh 硬编码',
  !/100vh/.test(stripCssComments(sideBarBlock)), stripCssComments(sideBarBlock).slice(0, 80))
check('删除 .goods-list 里的 100vh 硬编码',
  !/100vh/.test(stripCssComments(goodsListBlock)), stripCssComments(goodsListBlock).slice(0, 80))
check('两个滚动区改为撑满父容器（height: 100%）',
  /height:\s*100%/.test(sideBarBlock) && /height:\s*100%/.test(goodsListBlock))
const menuWrapBlock = cssBlock(wxss, '.menu-wrap')
check('.menu-wrap 用 flex:1 撑满剩余空间', /flex:\s*1/.test(menuWrapBlock), menuWrapBlock.slice(0, 80))
check('.menu-wrap 有 min-height:0（否则子项不被压缩、scroll-view 拿不到确定高度）',
  /min-height:\s*0/.test(menuWrapBlock), menuWrapBlock.slice(0, 120))
const pageWrapBlock = cssBlock(wxss, '.page-wrap')
check('.page-wrap 是纵向 flex 列', /flex-direction:\s*column/.test(pageWrapBlock))
check('.page-wrap 高度 = 一屏 - 底部固定栏 - 安全区',
  /calc\(\s*100vh\s*-\s*220rpx\s*-\s*env\(safe-area-inset-bottom\)\s*\)/.test(pageWrapBlock),
  pageWrapBlock)

console.log('\n=== 4) ★ 防高度漂移：220rpx = 结算栏 120rpx + tabbar 100rpx ===')
const reserved = Number((pageWrapBlock.match(/100vh\s*-\s*(\d+)rpx/) || [])[1])
const settleH = Number((settle ? cssBlock(wxss, '.settle-bar').match(/height:\s*(\d+)rpx/) || [] : [])[1])
const tabbarBottom = Number((cssBlock(wxss, '.settle-bar').match(/bottom:\s*calc\((\d+)rpx/) || [])[1])
check('能解析出三个数字', [reserved, settleH, tabbarBottom].every((n) => Number.isFinite(n)),
  { reserved, settleH, tabbarBottom })
check('骨架预留 = 结算栏高 + 结算栏底边距（即 tabbar 高）',
  reserved === settleH + tabbarBottom, { reserved, settleH, tabbarBottom })

// 结算栏底边距 100rpx 是「照着 van-tabbar 的 50px」写的，核对第三方组件真实值
let vantWxss = ''
try {
  vantWxss = src(VANT_TABBAR)
} catch (e) {
  vantWxss = ''
}
if (vantWxss) {
  const vantH = (vantWxss.match(/--tabbar-height,(\d+)px/) || [])[1]
  check('van-tabbar 默认高度仍是 50px（100rpx）→ 与骨架预留一致',
    vantH === '50' && tabbarBottom === 100,
    { vantTabbarHeightPx: vantH, settleBarBottomRpx: tabbarBottom })
} else {
  check('（跳过）未找到 @vant/weapp tabbar 样式，升级 vant 后请复核 100rpx 这个值', false)
}

console.log('\n=== 5) 底部占位不再是「硬撑」的 300rpx ===')
const holderBlock = cssBlock(wxss, '.list-bottom-holder')
const holderH = Number((holderBlock.match(/height:\s*(\d+)rpx/) || [])[1])
check('占位高度 ≤ 100rpx（原来 300rpx 是在撑被挡住的那 220rpx）',
  Number.isFinite(holderH) && holderH <= 100, holderH)

console.log('\n' + '='.repeat(60))
console.log((fail === 0 ? '全部通过：' : '存在失败：') + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
