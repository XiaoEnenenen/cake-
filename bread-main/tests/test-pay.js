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
 * @param {object} opts { wxpayResult | wxpayError, paymentBehavior: 'success'|'cancel'|'fail' }
 */
function loadPay(opts) {
  const o = opts || {}
  const state = { modals: [], toasts: [], relaunches: [], payments: [] }
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
          wxpay: async () => {
            if (o.wxpayError) throw o.wxpayError
            return o.wxpayResult
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
  console.log('\n=== 5) 源码守卫：不再把原始返回体甩给顾客 ===')
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
  }

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
