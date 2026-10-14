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
console.log('=== 1) 收货地址页：省市区整行已删除（2026-10-14 店主真机反馈）===')
// 删除理由：① 行政区划选择器最细只到区县（安宁市），**永远给不出「太平新城」**，
//   对"配送范围按文字判定"毫无帮助；② 地图选点返回的 res.address 本身就是完整地址，
//   再拼一次省市区会出现「云南省昆明市安宁市云南省昆明市安宁市…」的重复文字；
//   ③ 排版乱（标签 + 占位文案两行挤在一起）。
// ===========================================================================
{
  const wxml = src('pages/address/edit.wxml')
  const code = wxmlCode('pages/address/edit.wxml')
  const json = JSON.parse(src('pages/address/edit.json'))
  const js = src('pages/address/edit.js')

  check('★ wxml 代码里不再有「所在地区」这一行', code.indexOf('所在地区') < 0)
  check('★ 不再使用原生省市区选择器（picker mode="region"）', code.indexOf('mode="region"') < 0)
  check('  也不再使用 <van-area>（历史的错误实现）', code.indexOf('<van-area') < 0)
  check('★ edit.json 不注册任何自定义组件（本页零依赖）',
    !json.usingComponents || Object.keys(json.usingComponents).length === 0, json.usingComponents)
  check('★ edit.js 不再有省市区选择相关方法与字段（onAreaChange/openArea/areaText/areaValue）',
    !/onAreaChange\s*\(/.test(js) && !/openArea\s*\(/.test(js) &&
    !/\bareaText\s*:/.test(js) && !/\bareaValue\s*:/.test(js))
  check('  提示文案改成引导「地图选点」', /地图选点/.test(wxml))
  check('  提示里写明配送范围按详细地址文字判断（含「太平新城」即送）',
    /太平新城/.test(wxml) && /详细地址/.test(wxml))
  check('  删除留痕保留（说明为什么删，防止又被加回来）',
    wxml.indexOf('2026-10-14 删除') >= 0 && /永远给不出/.test(wxml))
}

// ===========================================================================
console.log('\n=== 2) 数据兼容：老地址的 province/city/district 不能丢 ===')
// 页面不再收集省市区，但**数据字段保留**：编辑老地址时要原样带回、保存时原样写回。
// ===========================================================================
{
  const FULL = {
    id: 'a_full', name: '肖恩', phone: '13608878371',
    province: '云南省', city: '昆明市', district: '安宁市',
    detail: '云南省昆明市安宁市太平新城街道山水融城B区13栋2商铺',
    latitude: 24.95, longitude: 102.58
  }
  const page = loadPage('pages/address/edit.js')
  withGlobalWx(storageStub([FULL]), () => { page.onLoad({ id: 'a_full' }) })
  check('★ 编辑老地址：省市区原样带回（虽然页面不显示）',
    page.data.province === '云南省' && page.data.city === '昆明市' && page.data.district === '安宁市',
    [page.data.province, page.data.city, page.data.district])
  check('  标题切到「编辑收货地址」', page.__titles.indexOf('编辑收货地址') >= 0, page.__titles)
  check('  详细地址与坐标也带回来了',
    page.data.detail === FULL.detail && page.data.latitude === FULL.latitude)

  const page2 = loadPage('pages/address/edit.js')
  page2.onLoad({})
  check('新增地址时标题为「新增收货地址」', page2.__titles.indexOf('新增收货地址') >= 0, page2.__titles)
  check('  新增时省市区为空（不再有输入入口，保存的就是空串）',
    page2.data.province === '' && page2.data.city === '' && page2.data.district === '')
}

// ===========================================================================
console.log('\n=== 3) 结构守卫：wxml 用到的字段与事件都真实存在 ===')
// ===========================================================================
{
  const wxml = src('pages/address/edit.wxml')
  const js = src('pages/address/edit.js')
  check('wxml 里的 bindchange/bindtap/bindinput 处理函数都有实现',
    (wxml.match(/bind(?:change|tap|input)="([^"]+)"/g) || []).every((m) => {
      const fn = m.replace(/.*="([^"]+)"/, '$1')
      return new RegExp(fn + '\\s*\\(').test(js)
    }))
  check('wxml 用到的 data 字段都已声明（detail / latitude / isDefault / saving）',
    ['detail', 'latitude', 'isDefault', 'saving'].every((k) => new RegExp('\\b' + k + '\\s*:').test(js)))
  check('  必填校验仍在（收货人 / 手机号 / 详细地址）',
    /请填写收货人姓名/.test(js) && /请填写正确的手机号/.test(js) && /请填写详细地址/.test(js))
}
console.log('\n' + '='.repeat(60))
console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)