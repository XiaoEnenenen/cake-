/**
 * 收货地址页回归测试（2026-10-14 阶段 8 复核整改新增）
 * ---------------------------------------------------------------------------
 * 覆盖两个**真机复现**的缺陷（店主 2026-10-14 截图）：
 *
 *   1) 新增/编辑地址页的「所在地区」点开是**一大片空白**
 *      根因：用 Vant 的 <van-area> 但没传 area-list，项目也没装 @vant/area-data；
 *            Vant 的 area 组件**不自带**行政区划数据（columns 初始就是三个空数组）。
 *            wxml 里那句「不传 area-list 会使用内置数据」的注释是错的。
 *      修法：换成微信原生 <picker mode="region">（零依赖、不会再空白）。
 *
 *   2) 结算页「改完地址还是显示旧地址，退出重进才对」
 *      （行为回归在 tests/test-stage5-page.js 的「5.3 续」一节，这里只做源码/结构守卫）
 *
 * 做法与 tests/test-stage5-page.js 一致：能真跑的（onAreaChange、onLoad 回填）
 * 把页面文件放进 vm 沙箱跑一遍；wxml / json 这类结构用源码级断言。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const REAL_ADDR = require('../utils/address')

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

/** 把页面文件放进沙箱跑一遍（只实现本测试需要的 API） */
function loadPage(rel, opts) {
  const o = opts || {}
  const titles = []
  const wxBase = Object.assign({
    showToast() {},
    showModal() {},
    setStorageSync() {},
    getStorageSync() { return '' },
    navigateBack() {},
    setNavigationBarTitle(t) { titles.push(t && t.title) }
  }, o.wx || {})
  const wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : () => {}) })

  let pageObj = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    Page: (obj) => { pageObj = obj },
    getApp: () => ({ globalData: {} }),
    getCurrentPages: () => [],
    require: (p) => {
      // 地址页只用这两个模块：地址数据层用真实实现（要真读写 storage），日志用空桩
      if (/utils\/address$/.test(p)) return REAL_ADDR
      if (/utils\/log$/.test(p)) return { warn() {}, debug() {}, info() {} }
      return {}
    },
    wx
  }
  vm.runInNewContext(src(rel), vm.createContext(sandbox), { filename: rel })
  const inst = Object.create(pageObj)
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (d, cb) {
    Object.assign(this.data, d)
    if (cb) cb()
  }
  inst.__titles = titles
  return inst
}

/** utils/address.js 直接引用全局 wx，Node 里要临时挂桩 */
function withGlobalWx(obj, fn) {
  const prev = global.wx
  global.wx = obj
  try {
    return fn()
  } finally {
    global.wx = prev
  }
}

const storageStub = (list) => ({
  getStorageSync(k) { return k === 'addressList' ? list : '' },
  setStorageSync() {}
})

/**
 * 去掉 wxml 注释后再检查。
 * 为什么：本项目习惯把"删掉的东西 + 为什么删"写在注释里（见 edit.wxml），
 * 注释里出现老组件名是**有意保留的留痕**，不该判成"还在用"。
 */
function wxmlCode(rel) {
  return src(rel).replace(/<!--[\s\S]*?-->/g, '')
}

// ===========================================================================
console.log('=== 1) 省市区选择器不再空白（van-area → 微信原生 picker）===')
// ===========================================================================
{
  const wxml = src('pages/address/edit.wxml')
  const code = wxmlCode('pages/address/edit.wxml')
  const json = JSON.parse(src('pages/address/edit.json'))
  const js = src('pages/address/edit.js')

  check('★ wxml 不再使用 <van-area（注释里保留的"已删除"留痕不算）',
    code.indexOf('<van-area') < 0)
  check('★ edit.json 不再注册 van-area 组件',
    !(json.usingComponents && json.usingComponents['van-area']),
    json.usingComponents)
  check('★ 改用微信原生省市区选择器（picker mode="region"）',
    /<picker[\s\S]{0,200}mode="region"/.test(code))
  check('  选择器事件接在 onAreaChange 上', /bindchange="onAreaChange"/.test(code))
  check('  不再引用已删除的 openArea', code.indexOf('openArea') < 0)
  check('★ wxml 代码里不再有"van-area 自带行政区划数据"这类说法（注释留痕不算）',
    code.indexOf('area-list') < 0)
  check('  删除留痕里明确标注了那句注释是错的（防止又被当依据）',
    wxml.indexOf('2026-10-14 删除') >= 0 && /错误/.test(wxml))
  check('★ edit.js 不再有 van-area 时代的三个方法（openArea/closeArea/onAreaConfirm）',
    js.indexOf('openArea(') < 0 && js.indexOf('closeArea(') < 0 && js.indexOf('onAreaConfirm(') < 0)
  check('  edit.js 有 onAreaChange 实现', /onAreaChange\s*\(/.test(js))
  check('  不再保留 showArea / areaCode 这类死字段',
    !/\bshowArea\s*:/.test(js) && !/\bareaCode\s*:/.test(js))
}

// ===========================================================================
console.log('\n=== 2) onAreaChange：原生 picker 的值要写进地址字段 ===')
// ===========================================================================
{
  const page = loadPage('pages/address/edit.js')
  page.onAreaChange({ detail: { value: ['云南省', '昆明市', '安宁市'], code: ['530000', '530100', '530181'] } })
  check('province 写入', page.data.province === '云南省', page.data.province)
  check('city 写入', page.data.city === '昆明市', page.data.city)
  check('district 写入', page.data.district === '安宁市', page.data.district)
  check('areaText 拼成完整文案', page.data.areaText === '云南省昆明市安宁市', page.data.areaText)
  check('areaValue 回写（再次打开选择器停在同一位置）',
    JSON.stringify(page.data.areaValue) === JSON.stringify(['云南省', '昆明市', '安宁市']),
    page.data.areaValue)

  // 异常入参不能崩，也不能写出半截地址
  const page2 = loadPage('pages/address/edit.js')
  page2.onAreaChange({})
  check('空 detail 不抛异常且字段保持为空',
    page2.data.province === '' && page2.data.areaText === '' && Array.isArray(page2.data.areaValue))
  page2.onAreaChange({ detail: { value: ['云南省'] } })
  check('只有省（半截值）→ areaValue 留空，避免原生 picker 落到默认省份',
    page2.data.areaValue.length === 0, page2.data.areaValue)
}

// ===========================================================================
console.log('\n=== 3) 编辑已有地址：省市区要能回填到原生选择器 ===')
// ===========================================================================
{
  const FULL = {
    id: 'a_full', name: '肖恩', phone: '13608878371',
    province: '云南省', city: '昆明市', district: '安宁市',
    detail: '太平新城某小区1号', latitude: 24.95, longitude: 102.58
  }
  const HALF = Object.assign({}, FULL, { id: 'a_half', district: '' })

  const page = loadPage('pages/address/edit.js')
  withGlobalWx(storageStub([FULL]), () => { page.onLoad({ id: 'a_full' }) })
  check('★ 三项齐全 → areaValue 回填为三项数组',
    JSON.stringify(page.data.areaValue) === JSON.stringify(['云南省', '昆明市', '安宁市']),
    page.data.areaValue)
  check('  areaText 显示为完整省市区', page.data.areaText === '云南省昆明市安宁市')
  check('  标题切到「编辑收货地址」', page.__titles.indexOf('编辑收货地址') >= 0, page.__titles)

  const page2 = loadPage('pages/address/edit.js')
  withGlobalWx(storageStub([HALF]), () => { page2.onLoad({ id: 'a_half' }) })
  check('★ 缺区（半截值）→ areaValue 不回填（否则 picker 会显示成别的地方）',
    page2.data.areaValue.length === 0, page2.data.areaValue)
  check('  但 areaText 仍然显示已有的省+市，不丢信息',
    page2.data.areaText === '云南省昆明市', page2.data.areaText)

  const page3 = loadPage('pages/address/edit.js')
  page3.onLoad({})
  check('新增地址时标题为「新增收货地址」', page3.__titles.indexOf('新增收货地址') >= 0, page3.__titles)
  check('新增地址时 areaValue 为空数组（不预选任何省）', page3.data.areaValue.length === 0)
}

// ===========================================================================
console.log('\n=== 4) 结构守卫：wxml 用到的字段与事件都真实存在 ===')
// ===========================================================================
{
  const wxml = src('pages/address/edit.wxml')
  const js = src('pages/address/edit.js')
  // 顶层 data 字段（{{ areaValue }} / {{ areaText }}）必须在 data 里声明
  ;['areaValue', 'areaText'].forEach((k) => {
    check('wxml 用到的 ' + k + ' 已在 data 中声明',
      new RegExp('\\b' + k + '\\s*:').test(js) && wxml.indexOf(k) >= 0)
  })
  check('wxml 里的 bindchange 处理函数都有实现（本页只有 onAreaChange）',
    (wxml.match(/bind(?:change|tap|input)="([^"]+)"/g) || []).every((m) => {
      const fn = m.replace(/.*="([^"]+)"/, '$1')
      return new RegExp(fn + '\\s*\\(').test(js)
    }))
  check('  「省市区选填」的口径没变（提示文案仍在）',
    /省市区选填/.test(wxml))
}

console.log('\n' + '='.repeat(60))
console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
