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

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' / 失败 ' + fail)
if (fail) process.exitCode = 1
