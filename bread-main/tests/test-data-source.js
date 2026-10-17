/**
 * 阶段三回归测试：单一数据源（云开发），api 工厂降级通道必须消失
 * ---------------------------------------------------------------------------
 * 覆盖两类断言：
 *   A. 行为类：用假的 wx.cloud 驱动 utils/api-map.js，验证
 *      - 调用只落在云函数上（action / payload 映射正确）；
 *      - 云函数失败或返回业务 500 时**不换源、不弹降级提示**；
 *      - 无 wx 环境时给出明确错误。
 *   B. 源码类：全项目检索，确保 apifm / WXAPI / mock / 降级开关不再出现在**运行时代码**里
 *      （注释会先被剥离，历史说明与文档链接不受影响）。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..') // bread-main
const DS = require('../utils/data-source')
const API = require('../utils/api-map')

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// ===========================================================================
console.log('=== 1) 数据源配置：单一 useCloud ===')
// ===========================================================================
check('useCloud === true（唯一数据源）', DS.useCloud === true, DS.useCloud)
check('已删除 useMock 开关', DS.useMock === undefined)
check('已删除 fallbackToLegacy 开关', DS.fallbackToLegacy === undefined)
check('云函数名保持 api', DS.cloudFunctionName === 'api', DS.cloudFunctionName)
check('云环境 ID 已配置', typeof DS.cloudEnvId === 'string' && DS.cloudEnvId.length > 0, DS.cloudEnvId)
check('调试开关保留为布尔值', typeof DS.debug === 'boolean')

// ===========================================================================
console.log('\n=== 2) api-map 接口面 ===')
// ===========================================================================
check('__dataSource() 只返回 cloud', API.__dataSource() === 'cloud', API.__dataSource())
check('__isCloudMode() 为 true', API.__isCloudMode() === true)
check('init 已导出', typeof API.init === 'function')

const SURFACE = [
  'goodsCategoryV2', 'goodsv2', 'goodsDetailV2',
  'shippingCarInfo', 'shippingCarInfoAddItemV2', 'shippingCarInfoModifyNumber',
  'shippingCarInfoRemoveItem', 'shippingCarInfoRemoveAll',
  'orderCreate', 'orderList', 'orderDetail', 'orderClose', 'orderDelete', 'orderFinish',
  'wxpay', 'userDetail', 'modifyUserInfoV2', 'login',
  'banners', 'appConfig', 'cmsPage', 'fetchShops', 'shopSubdetail'
]
const missing = SURFACE.filter((m) => typeof API[m] !== 'function')
check('原有 ' + SURFACE.length + ' 个接口一个不少（页面无需改动）', missing.length === 0, missing)

// ===========================================================================
console.log('\n=== 3) 云通道调用契约（假 wx.cloud）===')
// ===========================================================================
let calls = []
let initCalls = []
let modalCount = 0
let mode = 'ok' // ok | fail | biz500

global.wx = {
  // 阶段 9：购物车调用会读当前配送方式（storage.deliveryMode）→ 这里给个可控的桩
  _storage: {},
  getStorageSync(k) { return this._storage[k] === undefined ? '' : this._storage[k] },
  setStorageSync(k, v) { this._storage[k] = v },
  cloud: {
    init(opts) { initCalls.push(opts) },
    callFunction(opts) {
      calls.push({ name: opts.name, data: opts.data })
      if (mode === 'fail') {
        if (opts.fail) opts.fail({ errMsg: 'cloud.callFunction:fail mock network error' })
        return
      }
      if (mode === 'biz500') {
        if (opts.success) opts.success({ result: { code: 500, msg: '数据库错误' } })
        return
      }
      if (opts.success) opts.success({ result: { code: 0, data: { echoed: true } } })
    }
  },
  // 阶段三之前这里会被降级提示调用；现在不应再被调用
  showModal() { modalCount++ }
}

check('init() 返回 true', API.init() === true)
check('wx.cloud.init 带上了本期环境 ID', initCalls.length === 1 && initCalls[0].env === DS.cloudEnvId, initCalls)
check('wx.cloud.init 开启 traceUser', initCalls.length === 1 && initCalls[0].traceUser === true)

;(async () => {
  // ---- 参数映射：抽样覆盖分类 / 商品 / 购物车 / 订单 / 支付 / 用户 ----
  calls = []; mode = 'ok'
  let r = await API.goodsv2({ categoryId: 'c1', page: 2, pageSize: 5 })
  check('goodsv2 → action goodsList', calls.length === 1 && calls[0].data.action === 'goodsList', calls)
  check('goodsv2 payload 映射正确', JSON.stringify(calls[0].data.payload) === '{"categoryId":"c1","page":2,"pageSize":5}', calls[0].data.payload)
  check('返回值原样透传（code 0）', r.code === 0 && r.data.echoed === true, r)

  calls = []
  r = await API.goodsDetailV2({ id: 'g1' })
  check('goodsDetailV2 → action goodsDetail', calls[0].data.action === 'goodsDetail' && calls[0].data.payload.id === 'g1')

  calls = []
  await API.shippingCarInfoModifyNumber('token', 'k1', 3)
  check(
    'shippingCarInfoModifyNumber 沿用 (token,key,number)、只取后两个',
    calls[0].data.action === 'cartModifyNumber' &&
      calls[0].data.payload.key === 'k1' && calls[0].data.payload.number === 3,
    calls[0].data
  )
  // ===== 阶段 9：购物车调用必须带上当前配送方式（自取立减的口径）=====
  // 默认 storage 里没有 deliveryMode → 按自提（utils/delivery 的默认值）
  check('★ 购物车调用附带 deliveryMode（默认自提）',
    calls[0].data.payload.deliveryMode === 'pickup', calls[0].data.payload)
  global.wx.setStorageSync('deliveryMode', 'delivery')
  calls = []
  await API.shippingCarInfo()
  check('★ 切换成外送后，cartInfo 的 deliveryMode 跟着变',
    calls[0].data.action === 'cartInfo' && calls[0].data.payload.deliveryMode === 'delivery',
    calls[0].data.payload)
  calls = []
  await API.shippingCarInfoAddItemV2({ goodsId: 'g1', number: 2, sku: [] })
  check('  cartAdd 也带 deliveryMode，且原有字段不变',
    calls[0].data.payload.deliveryMode === 'delivery' &&
      calls[0].data.payload.goodsId === 'g1' && calls[0].data.payload.number === 2,
    calls[0].data.payload)
  global.wx.setStorageSync('deliveryMode', 'pickup')
  calls = []
  await API.shippingCarInfoRemoveAll('token')
  check('shippingCarInfoRemoveAll 忽略 token', calls[0].data.action === 'cartRemoveAll')

  calls = []
  await API.orderDetail('token', 'o1')
  check(
    'orderDetail 签名为 (token,orderId)（2026-10-10 核销下线后简化）',
    calls[0].data.action === 'orderDetail' && JSON.stringify(calls[0].data.payload) === '{"id":"o1"}',
    calls[0].data
  )

  calls = []
  await API.orderFinish('token', 'o1')
  check('orderFinish → action orderFinish', calls[0].data.action === 'orderFinish' && calls[0].data.payload.id === 'o1', calls[0].data)

  calls = []
  r = await API.wxpay({})
  check('wxpay 走云函数（不再可能落到 api 工厂）', calls[0].data.action === 'wxpay', calls[0].data)

  // 2026-10-17 顾客确认不做手机号登录：bindMobile 已从 API 层一起删除
  check('★ 手机号登录已删除（API 不再暴露 bindMobile）', typeof API.bindMobile === 'undefined')

  calls = []
  const modified = await API.modifyUserInfoV2({ token: 'should-be-dropped', nickName: 'n' })
  check(
    'modifyUserInfoV2 去掉前端 token 后再上云',
    calls[0].data.action === 'updateUser' && calls[0].data.payload.token === undefined,
    calls[0].data.payload
  )
  check('modifyUserInfoV2 保留其它字段', modified.code === 0 && calls[0].data.payload.nickName === 'n')

  calls = []
  await API.userDetail('token')
  check('userDetail → action getUser', calls[0].data.action === 'getUser')

  // ---- 失败路径：不换源、不弹降级 ----
  calls = []; modalCount = 0; mode = 'fail'
  r = await API.orderCreate({ goodsJsonStr: '[]' })
  check('云函数调用失败 → code 500', r.code === 500, r)
  check('失败文案明确含「云函数调用失败」', /云函数调用失败/.test(r.msg || ''), r.msg)
  check('失败时只调用一次云函数（没有换源重试）', calls.length === 1, calls.length)
  check('失败时不再出现「已临时降级」弹窗', modalCount === 0, modalCount)

  // ---- 业务 500：必须原样交回页面，不能被当成「环境不可用」 ----
  calls = []; modalCount = 0; mode = 'biz500'
  r = await API.orderList({ statusBatch: 0 })
  check('业务 500 原样返回给页面', r.code === 500 && r.msg === '数据库错误', r)
  check('业务 500 不换源、不弹降级（修 A-P1-02）', calls.length === 1 && modalCount === 0, { calls: calls.length, modalCount })

  // ---- 开关被误设为 false：明确报错，绝不静默返回空数据 ----
  calls = []; mode = 'ok'
  const savedUseCloud = DS.useCloud
  DS.useCloud = false
  r = await API.banners()
  check('useCloud=false 时返回「数据源未启用」而不是空数据', r.code === 500 && /数据源未启用/.test(r.msg || ''), r)
  check('useCloud=false 时不会去调云函数', calls.length === 0, calls.length)
  DS.useCloud = savedUseCloud

  // ---- 非小程序环境：明确提示云开发不可用 ----
  const savedWx = global.wx
  delete global.wx
  r = await API.banners()
  check('无 wx 环境 → 提示不支持云开发', r.code === 500 && /不支持云开发/.test(r.msg || ''), r)
  global.wx = savedWx

  // ---- callFunction 同步抛异常：也必须 resolve，否则页面永远转圈 ----
  const savedCallFunction = global.wx.cloud.callFunction
  const savedConsoleError = console.error
  console.error = () => {} // 这一条会故意打印异常，测试输出里屏蔽掉
  global.wx.cloud.callFunction = () => { throw new Error('sync boom') }
  r = await API.orderList({ statusBatch: 0 })
  check('callFunction 同步抛异常时仍返回明确错误', r.code === 500 && /云函数调用失败/.test(r.msg || ''), r)
  global.wx.cloud.callFunction = savedCallFunction
  console.error = savedConsoleError

  // =========================================================================
  console.log('\n=== 4) 源码检索：运行时代码里不再有 api 工厂 / Mock / 降级 ===')
  // =========================================================================
  const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm'])
  function listFiles(dir, topLevel, out) {
    out = out || []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // tests 目录自身含本测试用到的模式字符串，跳过以免自匹配
        if (topLevel && entry.name === 'tests') continue
        listFiles(path.join(dir, entry.name), false, out)
      } else {
        out.push(path.join(dir, entry.name))
      }
    }
    return out
  }
  // 剥离注释，只检查真正的代码
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"])\/\/[^\n]*/gm, '$1')
  }

  const allFiles = listFiles(ROOT, true)
  const jsFiles = allFiles.filter((f) => f.endsWith('.js'))
  check('扫描到工程源码（数量合理）', jsFiles.length > 30, jsFiles.length)

  const runtimeViolations = []
  const fallbackViolations = []
  const runtimePatterns = [
    [/require\(\s*['"]apifm-wxapi['"]\s*\)/, 'require(apifm-wxapi)'],
    [/\bWXAPI\./, 'WXAPI.* 调用'],
    [/legacy-apifm/, 'legacy-apifm 引用']
  ]
  const fallbackPatterns = [
    [/useMock/, 'useMock 开关'],
    [/fallbackToLegacy/, 'fallbackToLegacy 开关'],
    [/withFallback|notifyDegrade|callMock|pickCloudOnly/, '降级/Mock 通道函数']
  ]
  for (const file of jsFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    for (const [re, label] of runtimePatterns) {
      if (re.test(code)) runtimeViolations.push(path.relative(ROOT, file) + ' → ' + label)
    }
    for (const [re, label] of fallbackPatterns) {
      if (re.test(code)) fallbackViolations.push(path.relative(ROOT, file) + ' → ' + label)
    }
  }
  check('没有文件 require apifm-wxapi / 调用 WXAPI.*', runtimeViolations.length === 0, runtimeViolations)
  check('没有文件残留 useMock / fallbackToLegacy / 降级函数', fallbackViolations.length === 0, fallbackViolations)

  const configRequires = jsFiles.filter((f) => /require\(\s*['"]config['"]\s*\)/.test(stripComments(fs.readFileSync(f, 'utf8'))))
  check('没有文件 require 已归档的 config.js', configRequires.length === 0, configRequires.map((f) => path.relative(ROOT, f)))

  const legacyAccountHits = []
  for (const file of allFiles) {
    if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    if (src.includes('yuanqibread') || src.includes('24340951')) {
      legacyAccountHits.push(path.relative(ROOT, file))
    }
  }
  check('原面包店账号（yuanqibread / 24340951）在工程内彻底消失', legacyAccountHits.length === 0, legacyAccountHits)

  check('bread-main/config.js 已移除', !fs.existsSync(path.join(ROOT, 'config.js')))
  check(
    'utils/services/legacy-apifm.js 已移除',
    !fs.existsSync(path.join(ROOT, 'utils', 'services', 'legacy-apifm.js'))
  )
  const archiveDir = path.join(ROOT, '..', '.trash-cleanup', '20261009-1815')
  console.log(
    '  info 归档目录 ' + (fs.existsSync(path.join(archiveDir, '01__legacy-apifm.js')) && fs.existsSync(path.join(archiveDir, '02__config.js'))
      ? '存在（两个文件都在，可回滚）'
      : '不存在（若为全新 clone，属正常：.trash-cleanup 不纳入版本控制）')
  )

  // =========================================================================
  console.log('\n=== 5) 启动与鉴权：单一判据 ===')
  // =========================================================================
  const authSrc = fs.readFileSync(path.join(ROOT, 'utils', 'auth.js'), 'utf8')
  check('auth.js 直接读 DS.useCloud 作为判据（修 A-P1-01）', /DS\.useCloud/.test(authSrc))
  check('auth.js 导出 isCloudMode（模式判据的单一出处）', /isCloudMode:\s*isCloudMode/.test(authSrc))
  check('auth.js 不再用 __dataSource() 字符串判断', !/__dataSource\s*\(/.test(stripComments(authSrc)))
  check('auth.js 不含 apifm require', !/apifm-wxapi/.test(stripComments(authSrc)))
  check('auth.js 不再有 checkToken 分支', !/checkToken/.test(stripComments(authSrc)))

  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  const appCode = stripComments(appSrc)
  check('app.js 只调用 API.init() 初始化数据层', /API\.init\s*\(/.test(appCode))
  check('app.js 不含 useMock / fallbackToLegacy 分支', !/useMock|fallbackToLegacy/.test(appCode))
  check('app.js 不含 apifm require / WXAPI 调用', !/apifm-wxapi/.test(appCode) && !/\bWXAPI\./.test(appCode))
  check('app.js 不含 require(config)', !/require\(\s*['"]config['"]\s*\)/.test(appCode))

  // =========================================================================
  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
})()
