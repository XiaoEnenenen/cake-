/**
 * 支付失败体验回归测试（2026-10-17，T-8 / 报告 P-09）
 * ---------------------------------------------------------------------------
 * 修复前：任何支付失败都弹 `title:'出错了' + content: JSON.stringify(res)`，
 * 顾客看到一串原始 JSON，也不知道订单还在不在。
 * 现在必须区分三种情况：
 *   ① 用户主动取消 → 「已取消支付」（不是错误）
 *   ② 线上支付尚未接入（501 / 未开通商户号）→ 「线上支付暂未开通，订单已保存…」+ 门店电话
 *   ③ 其它失败 → 展示业务文案（不是 JSON 对象）
 * 且所有分支最终都回订单页，订单不会丢。
 *
 * 2026-10-19 P0-1 追加（第 5 节）：支付闭环
 *   · 云端返回 alreadyPaid → 不重复拉起收银台；
 *   · requestPayment 成功后必须调 orderPayConfirm 确认真实到账，
 *     paid=true 才提示「支付成功」；paid=false / 确认异常 → 「状态确认中，稍后刷新」；
 *   · wxpay 请求体必须带 orderId（云端据此校验订单归属）。
 *
 * 运行：node tests/test-pay.js
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

const QUIET_LOG = { debug() {}, warn() {}, error() {} }
const SHOP_STUB = { shop: { name: '卿欢蛋糕', phone: '18725136710' } }

/**
 * 加载真实的 utils/pay.js（沙箱里替换 API / 日志 / 门店配置 / wx）。
 * @param {object} opts {
 *   wxpayResult | wxpayError,
 *   paymentBehavior: 'success'|'cancel'|'fail',
 *   confirmResult | confirmError   // 2026-10-19 P0-1：orderPayConfirm 的返回/异常
 * }
 */
function loadPay(opts) {
  const o = opts || {}
  const state = {
    modals: [], toasts: [], relaunches: [], payments: [],
    // 2026-10-19 P0-1：记录 wxpay 请求体与「支付后确认到账」的调用
    wxpayPayloads: [], confirms: []
  }
  const wx = {
    getStorageSync() { return '' },
    showToast(t) { state.toasts.push((t && t.title) || '') },
    showModal(m) { state.modals.push(m) },
    reLaunch(a) { state.relaunches.push((a && a.url) || '') },
    requestPayment(o2) {
      state.payments.push(o2)
      if (o.paymentBehavior === 'success') {
        if (o2 && o2.success) o2.success()
      } else if (o.paymentBehavior === 'cancel') {
        if (o2 && o2.fail) o2.fail({ errMsg: 'requestPayment:fail cancel' })
      } else {
        if (o2 && o2.fail) o2.fail({ errMsg: 'requestPayment:fail system error' })
      }
    }
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // 让"返回订单页"的 setTimeout 立即执行，测试不需要真等 600ms
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout() {},
    require: (p) => {
      if (/api-map$/.test(p)) {
        return {
          wxpay: async (payload) => {
            state.wxpayPayloads.push(payload)
            if (o.wxpayError) throw o.wxpayError
            return o.wxpayResult
          },
          // P0-1：requestPayment 成功后的到账确认（默认"已到账"，老用例行为不变）
          orderPayConfirm: async (orderId) => {
            state.confirms.push(orderId)
            if (o.confirmError) throw o.confirmError
            const r = typeof o.confirmResult === 'function'
              ? o.confirmResult(orderId)
              : o.confirmResult
            return r || { code: 0, data: { paid: true } }
          }
        }
      }
      if (/log$/.test(p)) return QUIET_LOG
      if (/shop-config$/.test(p)) return SHOP_STUB
      throw new Error('unexpected require: ' + p)
    },
    wx,
    module: { exports: {} },
    exports: {}
  }
  sandbox.module.exports = sandbox.exports
  vm.runInNewContext(src('utils/pay.js'), vm.createContext(sandbox), { filename: 'utils/pay.js' })
  return { api: sandbox.module.exports, state }
}

/** 等一次微任务，让 wxpay 里的 .then 跑完 */
function tick() {
  return new Promise((r) => setTimeout(r, 0))
}

function noRawJson(s) {
  return String(s).indexOf('{"') < 0
}

async function main() {
  // =========================================================================
  console.log('=== 1) 线上支付未接入（当前阶段的真实状态）===')
  // =========================================================================
  {
    const { api, state } = loadPay({
      wxpayResult: { code: 501, msg: '云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）' }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 未接入时不弹"出错了"+JSON', m.title !== '出错了' && noRawJson(m.content), m)
    check('★ 明确告诉顾客「线上支付暂未开通」', /线上支付暂未开通/.test(String(m.title)), m.title)
    check('★ 说明订单已保存 + 到店支付/联系门店', /订单已保存/.test(String(m.content)) &&
      /到店支付|联系门店/.test(String(m.content)), m.content)
    check('★ 附门店电话，方便顾客直接联系', /18725136710/.test(String(m.content)), m.content)
    check('  没有泄露支付接口原始错误 JSON', noRawJson(m.content))
    check('  全程没有发起 requestPayment', state.payments.length === 0)
    // 点「查看订单」后回到订单页
    m.success()
    check('★ 关闭弹窗后回到订单页（订单不会丢）',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
  }

  // =========================================================================
  console.log('\n=== 2) 用户主动取消支付 ===')
  // =========================================================================
  {
    const { api, state } = loadPay({
      wxpayResult: {
        code: 0,
        data: { timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
      },
      paymentBehavior: 'cancel'
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('  发起了 requestPayment', state.payments.length === 1)
    check('★ 用户取消 → 提示「已取消支付」而不是报错',
      state.toasts.some((t) => /已取消支付/.test(t)), state.toasts)
    check('  取消不弹错误弹窗', state.modals.length === 0, state.modals)
    check('★ 取消后也回到订单页（订单待支付，可再付）',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
  }

  // =========================================================================
  console.log('\n=== 3) 支付成功 ===')
  // =========================================================================
  {
    const { api, state } = loadPay({
      wxpayResult: {
        code: 0,
        data: { timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
      },
      paymentBehavior: 'success'
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('★ 支付成功提示', state.toasts.some((t) => /支付成功/.test(t)), state.toasts)
    check('  成功后回订单页', state.relaunches.indexOf('/pages/current-order/index') >= 0)
    check('  成功不弹错误窗', state.modals.length === 0)
  }

  // =========================================================================
  console.log('\n=== 4) 其它支付失败 / 参数异常 ===')
  // =========================================================================
  {
    const { api, state } = loadPay({ paymentBehavior: 'fail',
      wxpayResult: {
        code: 0,
        data: { timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
      } })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 支付失败有明确提示（不是原始 errMsg/JSON）',
      /支付失败/.test(String(m.title)) && !/requestPayment:/.test(String(m.content)), m)
    check('★ 告知订单已保存、可继续支付', /订单已保存/.test(String(m.content)), m.content)
    m.success()
    check('  失败后也回订单页', state.relaunches.indexOf('/pages/current-order/index') >= 0)
  }
  {
    const { api, state } = loadPay({ wxpayResult: { code: 0, data: {} } })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 支付参数缺失时明确失败（不发起 requestPayment 抛异常）',
      state.payments.length === 0 && /支付失败/.test(String(m.title)) &&
      /订单已保存/.test(String(m.content)), m)
  }
  {
    const { api, state } = loadPay({
      wxpayResult: { code: 500, msg: '云函数调用失败：network' }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 业务失败展示云函数文案而不是 JSON',
      /支付失败/.test(String(m.title)) && /云函数调用失败/.test(String(m.content)) &&
      noRawJson(m.content), m)
  }
  {
    const { api, state } = loadPay({ wxpayError: new Error('boom') })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 请求异常（理论上不会发生）也有兜底文案',
      /支付失败/.test(String(m.title)) && /网络异常/.test(String(m.content)), m)
  }

  // =========================================================================
  console.log('\n=== 4b) P1-5：运费待确认的订单 → 单独提示，不当作普通失败 ===')
  // =========================================================================
  {
    const { api, state } = loadPay({
      wxpayResult: { code: 500, msg: '该订单运费待确认，请先联系门店确认运费后再支付' }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    const m = state.modals[0] || {}
    check('★ 标题明确是「运费待确认」（不是笼统的支付失败）',
      /运费待确认/.test(String(m.title)), m.title)
    check('★ 说明门店确认后可在订单页继续支付 + 给出门店电话',
      /订单/.test(String(m.content)) && /18725136710/.test(String(m.content)), m.content)
    check('  没有发起 requestPayment', state.payments.length === 0)
    m.success()
    check('  关闭后回订单页（订单不会丢）',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
  }

  // =========================================================================
  console.log('\n=== 5) 支付闭环：已支付拦截 + 支付成功后服务端确认到账（P0-1）===')
  // =========================================================================
  // 5.1 云端发现订单已支付（回调已到账 / 重复点支付）→ 不拉起收银台
  {
    const { api, state } = loadPay({
      wxpayResult: { code: 0, data: { alreadyPaid: true, orderId: 'o1' } }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('★ 订单已支付 → 绝不重复发起 requestPayment', state.payments.length === 0, state.payments)
    check('★ 订单已支付 → 给出顾客看得懂的提示（不是 JSON）',
      state.toasts.some((t) => /已支付/.test(String(t))) && state.modals.length === 0,
      { toasts: state.toasts, modals: state.modals })
    check('★ 订单已支付 → 直接回订单页',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
  }

  // 5.2 支付成功 + 服务端确认到账 → 提示支付成功
  {
    const { api, state } = loadPay({
      wxpayResult: {
        code: 0,
        data: {
          orderId: 'o1', timeStamp: '1', nonceStr: 'n', package: 'p',
          signType: 'MD5', paySign: 's'
        }
      },
      paymentBehavior: 'success',
      confirmResult: { code: 0, data: { paid: true, status: 1, orderNumber: 'QH1', amountReal: 100 } }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('★ requestPayment 成功后会向服务端确认到账（且带上订单 id）',
      state.confirms.length === 1 && state.confirms[0] === 'o1', state.confirms)
    check('★ 服务端确认已到账 → 才提示「支付成功」',
      state.toasts.some((t) => String(t) === '支付成功'), state.toasts)
    check('  确认到账时不出现「确认中」这种含糊提示',
      !state.toasts.some((t) => /确认中/.test(String(t))), state.toasts)
    check('  成功后回订单页', state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
    check('  成功不弹错误窗', state.modals.length === 0, state.modals)
  }

  // 5.3 回调延迟：服务端 paid=false → 不谎报失败，提示"确认中"并回订单页刷新
  {
    const { api, state } = loadPay({
      wxpayResult: {
        code: 0,
        data: { orderId: 'o1', timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
      },
      paymentBehavior: 'success',
      confirmResult: { code: 0, data: { paid: false, status: 0 } }
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('★ 服务端还没确认到账 → 提示「支付成功…订单状态确认中…刷新」',
      state.toasts.some((t) => /支付成功/.test(String(t)) && /确认中|刷新/.test(String(t))),
      state.toasts)
    check('  这种情况仍回订单页（顾客刷新后按回调结果更新）',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
    check('  不弹原始 JSON / 错误弹窗',
      // noRawJson(t) 为 true 表示"这条 toast 不含原始 JSON"；这里要断言的是
      // **没有任何一条** toast 带原始 JSON（原写法取反了，见 2026-10-19 修复）。
      state.modals.length === 0 &&
      !state.toasts.some((t) => String(t).indexOf('{"') >= 0), state.modals)
  }

  // 5.4 确认请求抛异常 → 同样给"确认中"，仍回订单页
  {
    const { api, state } = loadPay({
      wxpayResult: {
        code: 0,
        data: { orderId: 'o1', timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
      },
      paymentBehavior: 'success',
      confirmError: new Error('confirm boom')
    })
    api.wxpay('order', 100, 'o1', '/pages/current-order/index')
    await tick()
    check('★ 确认到账请求异常 → 仍按「支付成功、状态确认中」处理（钱可能已付）',
      state.toasts.some((t) => /支付成功/.test(String(t)) && /确认中|刷新/.test(String(t))),
      state.toasts)
    check('  确认异常时也回订单页',
      state.relaunches.indexOf('/pages/current-order/index') >= 0, state.relaunches)
    check('  确认异常时不弹原始 JSON', state.modals.length === 0, state.modals)
  }

  // 5.5 postData 带上 orderId（云端据此校验订单归属 / 生成支付参数）
  {
    const { api, state } = loadPay({
      wxpayResult: { code: 0, data: { alreadyPaid: true, orderId: 'o9' } }
    })
    api.wxpay('order', 100, 'o9', '/pages/current-order/index')
    await tick()
    const payload = state.wxpayPayloads[0] || {}
    check('★ wxpay 请求体带 orderId（P0-1 新增字段）', payload.orderId === 'o9', payload)
    check('  仍保留 remark / nextAction 兼容字段',
      /支付订单/.test(String(payload.remark)) && typeof payload.nextAction === 'string', payload)
    check('  订单类型以外的分支不塞 orderId 之外的语义（remark 保持"在线充值"外的订单口径）',
      payload.money === 100 && payload.payName === payload.remark, payload)
  }

  // =========================================================================
  console.log('\n=== 6) 源码守卫：不再把原始返回体甩给顾客 ===')
  // =========================================================================
  {
    const payJs = src('utils/pay.js')
    // 注释里会解释"原来怎么写"（含 JSON.stringify / 出错了），所以先剥掉注释再查代码
    const payCode = payJs
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    check('★ pay.js 不再 JSON.stringify(res) 弹给顾客', !/JSON\.stringify\(res\)/.test(payCode))
    check('★ pay.js 不再使用「出错了」作为标题', !/title:\s*'出错了'/.test(payCode))
    check('  区分未接入 / 取消 / 其它失败三种分支',
      /isPayNotReady/.test(payCode) && /cancel/i.test(payCode) && /线上支付暂未开通/.test(payCode))
    check('★ 支付成功后向服务端确认到账（orderPayConfirm），不再只信 requestPayment',
      /orderPayConfirm/.test(payCode))
    check('★ 订单已支付（alreadyPaid）时直接回订单页，不重复拉起收银台',
      /alreadyPaid/.test(payCode) && /不重复拉起收银台|跳过重复支付/.test(payCode))
    check('★ 确认未到账时只提示"确认中"，绝不把支付说成失败',
      /订单状态确认中/.test(payCode) && !/支付失败[\s\S]{0,80}确认中/.test(payCode))
    check('★ 运费待确认有独立提示分支（P1-5）',
      /showFreightPending/.test(payCode) && /运费待确认/.test(payCode))
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
