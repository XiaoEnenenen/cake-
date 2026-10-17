/**
 * 待支付订单「自动取消倒计时」回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 背景：店主反馈"待支付账单会一直存在"，希望改成 15 分钟自动取消，
 *      并且顾客能在订单卡片 / 订单详情上看到剩余时间。
 *
 * 这一份测试守住三件事：
 *   1) utils/order-countdown.js 的纯计算（无法在真机上快速回归的部分）：
 *      时钟偏移校正、mm:ss 格式化、到点判定、只对待支付订单生效。
 *   2) 页面接线：倒计时定时器必须被 setInterval 起来、并且
 *      onHide / onUnload 必须 clearInterval —— 否则离开页面后还在每秒 setData。
 *   3) 服务端与前端对「谁需要倒计时」的判据一致（status=0 且有 autoCancelAt），
 *      且页面里**不硬编码** 15 这个分钟数（改时间只改 cloudfunctions/api/shop-config.js）。
 *
 * 说明：页面代码依赖 wx.*，node 里跑不了，因此第 2/3 项用源码级断言
 *      （与 tests/test-page-interaction.js 同一做法）。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const CD = require('../utils/order-countdown')
const OS = require('../utils/order-status')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 把页面文件在受控沙箱里真正执行一遍（只 Page() 注册，不跑 wx.*）。
 * 为什么不用真 require：页面的依赖链会走到 @vant/weapp（小程序专用、node 里
 * 无法解析），所以除了两个纯工具模块，其余依赖一律给桩。
 * @returns {object} 页面实例（{ data, setData, ...页面方法 }）
 */
function loadPage(rel) {
  let pageObj = null
  const anyStub = () => new Proxy(function () {}, {
    get: (t, k) => (k in t ? t[k] : anyStub()),
    apply: () => Promise.resolve({ code: 0, data: {} })
  })
  const sandbox = {
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Page: (o) => { pageObj = o },
    getApp: () => ({ configLoadOK() {}, tabbarChange() {}, globalData: {} }),
    require: (p) => {
      if (/order-status$/.test(p)) return OS
      if (/order-countdown$/.test(p)) return CD
      // 2026-10-17：登录门禁（本文件测倒计时，统一按"已登录"处理）
      if (/utils\/login-gate$/.test(p)) {
        return {
          isLoggedOut: () => false,
          requireLogin: (page, action) => { if (typeof action === 'function') action(); return true },
          onLoginSuccess: () => {}
        }
      }
      return anyStub()
    },
    wx: {
      showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
      getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {},
      setNavigationBarTitle() {}, navigateTo() {}, reLaunch() {}
    }
  }
  vm.runInNewContext(src(rel), vm.createContext(sandbox), { filename: rel })
  if (!pageObj) throw new Error('Page() 没有被调用：' + rel)
  const inst = Object.create(pageObj)
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (o) { Object.assign(this.data, o) }
  return inst
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

const MIN = 60 * 1000
const SERVER_NOW = 1791624000000

/** 造一条待支付订单：下单时间 dateAdd，自动取消时刻 dateAdd + 15 分钟 */
function pendingOrder(dateAdd) {
  return { id: 'o1', status: OS.STATUS.UNPAID, dateAdd, autoCancelAt: dateAdd + 15 * MIN }
}

function main() {
  // =========================================================================
  console.log('=== 0) 页面文件可编译 ===')
  // =========================================================================
  ;['utils/order-countdown.js', 'pages/current-order/index.js', 'pages/order-view/index.js'].forEach((rel) => {
    let err = null
    try {
      new vm.Script(src(rel), { filename: rel })
    } catch (e) {
      err = e
    }
    check('可编译：' + rel, err === null, err && err.message)
  })

  // =========================================================================
  console.log('\n=== 1) 时钟偏移校正（顾客手机时间不准也不能算错）===')
  // =========================================================================
  check('服务端时间缺失 → 偏移为 0（不校正）', CD.clockOffsetOf(undefined, 123) === 0)
  check('服务端时间非法 → 偏移为 0', CD.clockOffsetOf('abc', 123) === 0 && CD.clockOffsetOf(0, 123) === 0)
  check('本机比服务端快 3 秒 → 偏移 = +3000',
    CD.clockOffsetOf(SERVER_NOW, SERVER_NOW + 3000) === 3000, CD.clockOffsetOf(SERVER_NOW, SERVER_NOW + 3000))
  check('本机比服务端慢 3 秒 → 偏移 = -3000',
    CD.clockOffsetOf(SERVER_NOW, SERVER_NOW - 3000) === -3000, CD.clockOffsetOf(SERVER_NOW, SERVER_NOW - 3000))
  check('偏移超过 1 天视为异常 → 按 0 处理',
    CD.clockOffsetOf(SERVER_NOW, SERVER_NOW + 2 * 24 * 60 * MIN) === 0)

  // =========================================================================
  console.log('\n=== 2) mm:ss 格式化 ===')
  // =========================================================================
  check('15 分钟 → 15:00', CD.formatRemain(15 * MIN) === '15:00', CD.formatRemain(15 * MIN))
  check('61 秒 → 01:01', CD.formatRemain(61 * 1000) === '01:01', CD.formatRemain(61 * 1000))
  check('1 秒 → 00:01', CD.formatRemain(1000) === '00:01')
  check('0 / 负数 / 非法值 → 00:00',
    CD.formatRemain(0) === '00:00' && CD.formatRemain(-5) === '00:00' &&
    CD.formatRemain(NaN) === '00:00' && CD.formatRemain(undefined) === '00:00')
  check('不足 1 秒向下取整 → 00:00', CD.formatRemain(999) === '00:00')

  // =========================================================================
  console.log('\n=== 3) 倒计时计算 ===')
  // =========================================================================
  const order = pendingOrder(SERVER_NOW - 5 * MIN) // 已过去 5 分钟 → 剩 10 分钟
  let cd = CD.countdownOf(order, 0, SERVER_NOW)
  check('待支付订单 active = true', cd.active === true, cd)
  check('剩余 10 分钟 → 10:00', cd.remainText === '10:00', cd.remainText)
  check('未到点 expired = false', cd.expired === false)

  cd = CD.countdownOf(order, 0, SERVER_NOW + 10 * MIN)
  check('刚好到点 → expired = true，文案 00:00',
    cd.expired === true && cd.remainText === '00:00', cd)
  cd = CD.countdownOf(order, 0, SERVER_NOW + 11 * MIN)
  check('超过取消时刻 → expired = true，剩余不为负',
    cd.expired === true && cd.remainMs === 0, cd)

  // 手机时钟比服务端快 5 分钟：若不校正，会把"还剩 10 分钟"算成"还剩 5 分钟"
  const offset = CD.clockOffsetOf(SERVER_NOW, SERVER_NOW + 5 * MIN)
  cd = CD.countdownOf(order, offset, SERVER_NOW + 5 * MIN)
  check('本机快 5 分钟也仍显示 10:00（按服务端时间算）', cd.remainText === '10:00', cd.remainText)
  cd = CD.countdownOf(order, CD.clockOffsetOf(SERVER_NOW, SERVER_NOW - 5 * MIN), SERVER_NOW - 5 * MIN)
  check('本机慢 5 分钟也仍显示 10:00', cd.remainText === '10:00', cd.remainText)

  // 只有待支付订单才需要倒计时
  const cancelled = { status: OS.STATUS.CANCELLED, autoCancelAt: SERVER_NOW }
  const making = { status: OS.STATUS.MAKING, autoCancelAt: SERVER_NOW }
  const noField = { status: OS.STATUS.UNPAID }
  check('已取消订单不显示倒计时', CD.countdownOf(cancelled, 0, SERVER_NOW).active === false)
  check('制作中订单不显示倒计时', CD.countdownOf(making, 0, SERVER_NOW).active === false)
  check('没有 autoCancelAt 的待支付订单不显示（老数据兜底）',
    CD.countdownOf(noField, 0, SERVER_NOW).active === false)
  check('空订单不崩', CD.countdownOf(null, 0, SERVER_NOW).active === false)
  check('isPending 与服务端判据一致（status=0 且有 autoCancelAt）',
    CD.isPending(order) === true && CD.isPending(cancelled) === false && CD.isPending(noField) === false)

  // 批量补字段
  const patched = CD.patchList([order, cancelled], 0, SERVER_NOW)
  check('patchList 给待支付项补 cancelRemainText', patched.list[0].cancelRemainText === '10:00', patched.list[0])
  check('patchList 给已取消项留空文案', patched.list[1].cancelRemainText === '' && patched.list[1].cancelActive === false)
  check('patchList 报告存在 active / 不存在 expired',
    patched.hasActive === true && patched.hasExpired === false, patched)
  const patchedExpired = CD.patchList([order], 0, SERVER_NOW + 20 * MIN)
  check('patchList 到点后报告 hasExpired（页面据此重拉列表）', patchedExpired.hasExpired === true)
  check('patchList 不改动原对象', order.cancelRemainText === undefined)
  check('patchList 空列表不崩',
    CD.patchList(null, 0, SERVER_NOW).list.length === 0 &&
    CD.patchList([], 0, SERVER_NOW).hasActive === false)

  // =========================================================================
  console.log('\n=== 4) 订单列表页接线 ===')
  // =========================================================================
  const listJs = src('pages/current-order/index.js')
  const listWxml = src('pages/current-order/index.wxml')
  const listWxss = src('pages/current-order/index.wxss')
  check('列表页引入倒计时工具', /require\(['"]\.\.\/\.\.\/utils\/order-countdown['"]\)/.test(listJs))
  check('列表页 setInterval 起定时器', /setInterval\(/.test(listJs))
  check('列表页 onHide 停定时器', /onHide[\s\S]{0,200}stopCountdown/.test(listJs))
  check('列表页 onUnload 停定时器', /onUnload[\s\S]{0,200}stopCountdown/.test(listJs))
  check('stopCountdown 里 clearInterval', /stopCountdown\(\)\s*\{[\s\S]{0,200}clearInterval/.test(listJs))
  check('用服务端 serverNow 对齐偏移（clockOffsetOf）', /clockOffsetOf\(res\.data\.serverNow/.test(listJs))
  check('模板只对待支付订单显示倒计时',
    /item\.status == ST\.UNPAID && item\.cancelActive/.test(listWxml))
  check('模板显示剩余时间文案', /剩余 \{\{item\.cancelRemainText\}\} 自动取消/.test(listWxml))
  check('wxss 定义了倒计时样式', /\.auto-cancel-tip\s*\{/.test(listWxss))
  check('再次支付弹窗也提示剩余时间（支付前告知会过期）',
    /剩余 ' \+ cd\.remainText \+ ' 自动取消/.test(listJs))
  check('页面里不硬编码 15 分钟（只认服务端下发的 autoCancelAt）',
    !/(15|30)\s*\*\s*60\s*\*\s*1000/.test(listJs) && !/900000|1800000/.test(listJs))

  // =========================================================================
  console.log('\n=== 5) 订单详情页接线 ===')
  // =========================================================================
  const viewJs = src('pages/order-view/index.js')
  const viewWxml = src('pages/order-view/index.wxml')
  const viewWxss = src('pages/order-view/index.wxss')
  check('详情页引入倒计时工具', /require\(['"]\.\.\/\.\.\/utils\/order-countdown['"]\)/.test(viewJs))
  check('详情页 setInterval 起定时器', /setInterval\(/.test(viewJs))
  check('详情页 onHide 停定时器', /onHide[\s\S]{0,200}stopCountdown/.test(viewJs))
  check('详情页 onUnload 停定时器', /onUnload[\s\S]{0,200}stopCountdown/.test(viewJs))
  check('详情页用 serverNow 对齐偏移', /clockOffsetOf\(res\.data\.serverNow/.test(viewJs))
  check('详情模板只对待支付订单显示倒计时',
    /orderDetail\.orderInfo\.status == ST\.UNPAID && cancelRemainText/.test(viewWxml))
  check('详情模板显示剩余时间文案', /剩余 \{\{ cancelRemainText \}\} 自动取消/.test(viewWxml))
  check('详情页 wxss 定义了倒计时样式', /\.auto-cancel-tip\s*\{/.test(viewWxss))
  check('详情页从别的页面返回时会刷新（离开期间可能已被取消）',
    /onShow[\s\S]{0,200}orderDetail\(\)/.test(viewJs))
  check('详情页不硬编码超时分钟数', !/(15|30)\s*\*\s*60\s*\*\s*1000/.test(viewJs))

  // =========================================================================
  console.log('\n=== 6) 动态验证：真的把页面跑起来驱动倒计时（确定性，不等真实定时器）===')
  // =========================================================================
  // 说明：这里直接调 tickCountdown（不用 setInterval 等时间），所以断言是确定的；
  //      只保留「startCountdown 是否真的起了定时器」这一处真实 setInterval，
  //      并在断言后立刻 stopCountdown，避免进程被定时器挂住。
  const listInst = loadPage('pages/current-order/index.js')
  let reloads = 0
  listInst.orderList = () => { reloads++ }
  listInst.data.serverOffset = 0
  listInst.data.orderList = [
    { id: 'a', status: OS.STATUS.UNPAID, autoCancelAt: Date.now() + 119000 }, // 还剩不到 2 分钟
    { id: 'b', status: OS.STATUS.MAKING },
    { id: 'c', status: OS.STATUS.CANCELLED }
  ]
  listInst.startCountdown()
  check('列表页 startCountdown 起了定时器', !!listInst._countdownTimer)
  check('倒计时文案已算出（不足 2 分钟 → 01:5x）',
    /^01:5\d$/.test(listInst.data.orderList[0].cancelRemainText),
    listInst.data.orderList[0].cancelRemainText)
  check('制作中 / 已取消订单不显示倒计时',
    listInst.data.orderList[1].cancelActive === false && listInst.data.orderList[2].cancelActive === false)
  check('未到点时不重拉列表', reloads === 0, reloads)
  listInst.onHide()
  check('onHide 真的清掉了定时器', !listInst._countdownTimer)

  // 到点：tick 一次就应该重拉（服务端读取兜底会把订单置为已取消）
  const expiredInst = loadPage('pages/current-order/index.js')
  let expiredReloads = 0
  expiredInst.orderList = () => { expiredReloads++ }
  expiredInst.data.serverOffset = 0
  expiredInst.data.orderList = [{ id: 'a', status: OS.STATUS.UNPAID, autoCancelAt: Date.now() - 1 }]
  expiredInst.tickCountdown()
  check('已到点时 tick 一次即重拉列表', expiredReloads === 1, expiredReloads)
  check('到点文案为 00:00', expiredInst.data.orderList[0].cancelRemainText === '00:00',
    expiredInst.data.orderList[0].cancelRemainText)
  // 连续到点也不能无限重拉：节流 + 5 次上限（把节流时间戳清零模拟"每次都已过 3 秒"）
  for (let i = 0; i < 10; i++) {
    expiredInst._lastExpireReloadAt = 0
    expiredInst.tickCountdown()
  }
  check('连续到点最多重拉 5 次（异常时钟下不刷爆服务端）', expiredReloads === 5, expiredReloads)

  // 详情页同一条链路
  const viewInst = loadPage('pages/order-view/index.js')
  let viewReloads = 0
  viewInst.orderDetail = () => { viewReloads++ }
  viewInst.data.serverOffset = 0
  viewInst.data.orderDetail = { orderInfo: { id: 'x', status: OS.STATUS.UNPAID, autoCancelAt: Date.now() + 299000 } }
  viewInst.startCountdown()
  check('详情页 startCountdown 起了定时器', !!viewInst._countdownTimer)
  check('详情页倒计时文案已算出（不足 5 分钟 → 04:5x）',
    /^04:5\d$/.test(viewInst.data.cancelRemainText), viewInst.data.cancelRemainText)
  viewInst.data.orderDetail.orderInfo.autoCancelAt = Date.now() - 1
  viewInst.tickCountdown()
  check('详情页到点重拉详情', viewReloads === 1, viewReloads)
  viewInst.onUnload()
  check('详情页 onUnload 真的清掉了定时器', !viewInst._countdownTimer)

  const noneInst = loadPage('pages/current-order/index.js')
  noneInst.orderList = () => {}
  noneInst.data.orderList = [{ id: 'z', status: OS.STATUS.CANCELLED }]
  noneInst.startCountdown()
  check('没有待支付订单时不起定时器（省电、不做无意义请求）', !noneInst._countdownTimer)

  console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main()
