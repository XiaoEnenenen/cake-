// 位置与导航工具（utils/location.js）纯函数测试
// 说明：本文件只测不依赖 wx 的部分（坐标判定 / 距离 / 文案）；
//      ensureAuth / getCurrent / openNavigation 属于 wx 能力，需要真机或开发者工具验证。
const LOC = require('../utils/location')
const SHOP = require('../shop-config').shop

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

console.log('=== 1) 门店坐标是否可用 ===')
check('shop-config 的门店坐标可用', LOC.isShopReady(SHOP) === true)
check('坐标为 0 视为不可用', LOC.isShopReady({ latitude: 0, longitude: 0 }) === false)
check('缺坐标视为不可用', LOC.isShopReady({ latitude: 24.9 }) === false)
check('字符串数字也能识别', LOC.isShopReady({ latitude: '24.9195', longitude: '102.4840' }) === true)
check('不传参时回退到 shop-config.js', LOC.isShopReady() === true)

console.log('\n=== 2) 距离文案 ===')
check('null → 空串', LOC.formatDistance(null) === '')
check('undefined → 空串', LOC.formatDistance(undefined) === '')
check('NaN → 空串', LOC.formatDistance(NaN) === '')
check('0.86 公里 → 860m', LOC.formatDistance(0.86) === '860m', LOC.formatDistance(0.86))
check('0.5 公里 → 500m', LOC.formatDistance(0.5) === '500m')
check('恰好 1 公里 → 1km（不小于 1 走公里）', LOC.formatDistance(1) === '1km')
check('12.35 公里 → 12.35km', LOC.formatDistance(12.35) === '12.35km')
check('288.6 公里 → 288.6km', LOC.formatDistance(288.6) === '288.6km')

console.log('\n=== 3) 用户 → 门店距离 ===')
const same = LOC.distanceToShop(SHOP.latitude, SHOP.longitude, SHOP)
check('同一点距离为 0', same === 0, same)

// 纬度 +0.01° 约等于 1.11 公里
const near = LOC.distanceToShop(Number(SHOP.latitude) + 0.01, SHOP.longitude, SHOP)
check('偏北 0.01° ≈ 1.11 公里', near > 1 && near < 1.2, near)

const far = LOC.distanceToShop(39.9042, 116.4074, SHOP) // 北京
check('昆明→北京 约 1800 公里量级', far > 1500 && far < 2500, far)

check('门店无坐标时返回 null', LOC.distanceToShop(24.9, 102.4, { latitude: 0, longitude: 0 }) === null)
check('用户坐标为 0 时返回 null', LOC.distanceToShop(0, 0, SHOP) === null)

console.log('\n=== 4) 门店信息取值 ===')
check('shopOf 回退到 shop-config', LOC.shopOf({}).name === SHOP.name, LOC.shopOf({}).name)
check('传入门店时优先使用传入值', LOC.shopOf({ name: '测试门店' }).name === '测试门店')
check('授权 scope 常量为 scope.userLocation', LOC.SCOPE === 'scope.userLocation')

console.log('\n=== 5) 导航兜底文案（复制地址）===')
const navText = LOC.buildNavText(SHOP)
check('包含门店名', navText.indexOf(SHOP.name) >= 0, navText)
check('包含门店地址', navText.indexOf(SHOP.address) >= 0)
check('包含经纬度（便于粘到地图 App 搜）', navText.indexOf(String(SHOP.latitude)) >= 0)
check('多行展示', navText.split('\n').length === 3, navText.split('\n'))
check('无坐标时不含经纬度行', LOC.buildNavText({ name: 'X', address: 'Y' }) === 'X\nY')

console.log('\n=== 6) 腾讯位置服务路线规划插件地址 ===')
const pluginUrl = LOC.buildRoutePlanUrl(SHOP)
check('使用 plugin:// 协议', pluginUrl.indexOf('plugin://route-plan/index?') === 0, pluginUrl.slice(0, 40))
check('开启导航功能 navigation=1', pluginUrl.indexOf('navigation=1') >= 0)
check('默认驾车模式', pluginUrl.indexOf('mode=driving') >= 0)
check('带上了终点 endPoint', pluginUrl.indexOf('endPoint=') >= 0)
check(
  'endPoint 含门店名与坐标',
  decodeURIComponent(pluginUrl).indexOf(SHOP.name) >= 0 &&
    decodeURIComponent(pluginUrl).indexOf(String(SHOP.latitude)) >= 0
)
check(
  'referer 默认取门店名',
  decodeURIComponent(pluginUrl).indexOf('referer=' + SHOP.name) >= 0
)
check('插件默认关闭时配置项为 false', LOC.navCfg().routePlanPlugin === false)

console.log('\n=== 7) 开发者工具判定（无 wx 环境不应抛错）===')
check('无 wx 环境下 isDevtools() 返回 false', LOC.isDevtools() === false)
check('无 wx 环境下 isDevOrTrialEnv() 返回 false（对顾客更安全）', LOC.isDevOrTrialEnv() === false)

console.log('\n=== 8) 坐标格式化（门店坐标拾取页用）===')
check(
  '标准坐标输出两行可直接粘贴',
  LOC.formatCoordinate(24.919512, 102.484033) === 'latitude: 24.919512,\nlongitude: 102.484033',
  LOC.formatCoordinate(24.919512, 102.484033)
)
check('字符串坐标同样可用', LOC.formatCoordinate('24.9195', '102.484') === 'latitude: 24.9195,\nlongitude: 102.484')
check('0 视为未选点，返回空串', LOC.formatCoordinate(0, 0) === '')
check('非数字返回空串', LOC.formatCoordinate('abc', 102.4) === '')
check('undefined 返回空串', LOC.formatCoordinate(undefined, undefined) === '')
check(
  '超过 6 位小数会被收敛',
  LOC.formatCoordinate(24.1234567891, 102.9876543219) === 'latitude: 24.123457,\nlongitude: 102.987654',
  LOC.formatCoordinate(24.1234567891, 102.9876543219)
)

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ROOT = path.join(__dirname, '..')
function srcFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 临时给 Node 全局挂 wx 桩（utils/location、utils/privacy 直接引用全局 wx） */
function withGlobalWx(stub, fn) {
  const prev = global.wx
  global.wx = stub
  return Promise.resolve().then(fn).finally(() => { global.wx = prev })
}

/** 加载 components/shop-map（Component 沙箱） */
function loadShopMap(overrides) {
  const o = overrides || {}
  let compObj = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Component: (obj) => { compObj = obj },
    require: (p) => {
      if (/utils\/location$/.test(p)) return o.location
      return {}
    },
    wx: o.wx || {}
  }
  vm.runInNewContext(srcFile('components/shop-map/index.js'), vm.createContext(sandbox), {
    filename: 'components/shop-map/index.js'
  })
  const inst = {
    data: JSON.parse(JSON.stringify(compObj.data || {})),
    setData(d, cb) {
      Object.assign(this.data, d)
      if (cb) cb()
    },
    triggerEvent() {}
  }
  Object.assign(inst, compObj.methods || {})
  inst.__observers = compObj.observers || {}
  return inst
}

/** 门店地图用的 LOC 桩：第一次定位失败（隐私）、之后成功 */
function makeLocStub() {
  let calls = 0
  return {
    isDevtools: () => false,
    getCurrent: async () => {
      calls++
      if (calls === 1) {
        return { ok: false, privacy: true, errMsg: '需先同意《用户隐私保护指引》才能显示距离，点击此处重新授权' }
      }
      return { ok: true, latitude: 24.92, longitude: 102.58 }
    },
    distanceToShop: () => 0.41,
    formatDistance: () => '410m',
    openNavigation() {},
    openSettingGuide: async () => true,
    copyShopAddress() {}
  }
}

;(async function () {
  // =========================================================================
  console.log('\n=== 9) 定位隐私授权：自动补触发 + 重试（2026-10-17 真机反馈）===')
  // =========================================================================
  {
    let privacyCalls = 0
    let authCalls = 0
    let locationCalls = 0
    const stub = {
      getSetting(o) { o.success({ authSetting: {} }) },
      authorize(o) {
        authCalls++
        if (authCalls === 1) o.fail({ errMsg: 'authorize:fail privacy permission is not authorized' })
        else o.success()
      },
      requirePrivacyAuthorize(o) { privacyCalls++; o.success() },
      getLocation(o) { locationCalls++; o.success({ latitude: 24.92, longitude: 102.58 }) }
    }
    const r = await withGlobalWx(stub, () => LOC.getCurrent())
    check('★ 隐私授权失败 → 自动触发微信平台级隐私授权', privacyCalls === 1, { privacyCalls })
    check('★ 授权成功后自动重试并拿到坐标', r.ok === true && typeof r.latitude === 'number', r)
    check('  授权成功后只多调一次定位', locationCalls === 1, { locationCalls })
  }
  {
    let privacyCalls = 0
    let locationCalls = 0
    const stub = {
      getSetting(o) { o.success({ authSetting: {} }) },
      authorize(o) { o.fail({ errMsg: 'authorize:fail privacy permission is not authorized' }) },
      requirePrivacyAuthorize(o) { privacyCalls++; o.fail({ errMsg: 'requirePrivacyAuthorize:fail auth deny' }) },
      getLocation() { locationCalls++ }
    }
    const r = await withGlobalWx(stub, () => LOC.getCurrent())
    check('★ 用户拒绝平台隐私授权 → 返回可展示文案、不抛异常',
      r.ok === false && /隐私|授权/.test(String(r.errMsg)), r)
    check('  拒绝后不会强行调用定位接口', privacyCalls === 1 && locationCalls === 0, { privacyCalls, locationCalls })
  }
  {
    // 旧基础库：没有 requirePrivacyAuthorize
    const stub = {
      getSetting(o) { o.success({ authSetting: {} }) },
      authorize(o) { o.fail({ errMsg: 'authorize:fail privacy permission is not authorized' }) }
    }
    const r = await withGlobalWx(stub, () => LOC.getCurrent())
    check('旧基础库无 requirePrivacyAuthorize → 不抛异常、返回隐私提示',
      r.ok === false && r.privacy === true && /隐私/.test(String(r.errMsg)), r)
  }
  {
    // getLocation 本身报 privacy（部分基础库在定位这一步才拦）
    let locCalls = 0
    let privacyCalls = 0
    const stub = {
      getSetting(o) { o.success({ authSetting: { 'scope.userLocation': true } }) },
      requirePrivacyAuthorize(o) { privacyCalls++; o.success() },
      getLocation(o) {
        locCalls++
        if (locCalls === 1) o.fail({ errMsg: 'getLocation:fail privacy permission is not authorized' })
        else o.success({ latitude: 1, longitude: 2 })
      }
    }
    const r = await withGlobalWx(stub, () => LOC.getCurrent())
    check('★ getLocation 报隐私错误 → 同样补授权并重试成功',
      r.ok === true && privacyCalls === 1 && locCalls === 2, { r, privacyCalls, locCalls })
  }

  // =========================================================================
  console.log('\n=== 10) 门店地图定位提示：失败可点重试，业务距离到位后不再残留 ===')
  // =========================================================================
  {
    const c = loadShopMap({ location: makeLocStub(), wx: { showToast() {} } })
    c.data.navigable = true
    c.data.shop = { latitude: 1, longitude: 2 }
    await c.locate()
    check('★ 定位因隐私授权失败 → 提示条出现并标记为隐私问题',
      /隐私/.test(String(c.data.hint)) && c.data.hintPrivacy === true, c.data)
    await c.onHintTap()
    check('★ 点提示条 → 重试定位成功、提示消失、显示距离',
      c.data.hint === '' && c.data.hintPrivacy === false && /距离您 410m/.test(c.data.locateText),
      c.data)
  }
  {
    // 真机截图场景：结算页已经给出「配送距离 410m」（来自收货地址，不依赖用户定位），
    // 之前上一次定位失败留下的提示必须被清掉，不能一直挂在 map 下方。
    const c2 = loadShopMap({ location: makeLocStub() })
    c2.data.navigable = true
    c2.data.shop = { latitude: 1, longitude: 2 }
    await c2.locate()
    check('  前置：定位失败留下了提示', !!c2.data.hint, c2.data)
    c2.__observers.distanceText.call(c2, '配送距离 410m')
    check('★ 页面提供业务距离 → 清除残留的定位授权提示（结算页不再出现该行）',
      c2.data.hint === '' && c2.data.hintPrivacy === false, c2.data)
  }

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
})()
