/**
 * 统一日志出口（阶段 5.7 整洁度清理）
 * ---------------------------------------------------------------------------
 * 背景（审计报告 §4.3）：页面/utils 里散落着 console.log / console.error，
 *   正式版也会打进用户手机的控制台，既没必要也容易泄露排查细节；
 *   报告的建议是"统一收敛到 DS.debug 开关"。
 *
 * 约定：
 *   1. 页面与 utils 一律 require 本模块，不再直接写 console.*
 *      （cloudfunctions/ 侧是独立的云函数包，服务端日志是云控制台唯一的观测手段，
 *        不受此约定约束）；
 *   2. `debug` 只在 utils/data-source.js 的 debug 开关打开时输出
 *      —— 日常不刷屏，需要排查时改一个开关即可；
 *   3. `warn` / `error` 始终输出：可执行的告警（如"云环境 ID 没配"）与真正的异常
 *      都必须留痕，否则弱网/真机问题无从定位（与收敛前的行为一致）。
 *
 * 本模块不依赖 wx API，可在 Node 下直接单测。
 * ---------------------------------------------------------------------------
 */
const DS = require('./data-source')

function debug() {
  if (!DS.debug) return
  console.log.apply(console, ['[debug]'].concat(Array.prototype.slice.call(arguments)))
}

function warn() {
  // 告警不随 debug 开关关闭（收敛前就是 console.warn，始终输出）
  console.warn.apply(console, ['[warn]'].concat(Array.prototype.slice.call(arguments)))
}

function error() {
  // 错误始终输出
  console.error.apply(console, Array.prototype.slice.call(arguments))
}

module.exports = {
  debug,
  warn,
  error
}
