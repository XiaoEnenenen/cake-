/**
 * 订单状态：前端唯一一份常量表（阶段 4.1「订单状态机收敛」）
 * ---------------------------------------------------------------------------
 * 改造前状态数字散落在各处，还带着两个**从未被写入过**的"幽灵状态" 2 和 4：
 *   - pages/current-order/index.js   statusBatch = '0, 1, 2' / '-1, 3, 4'
 *   - pages/current-order/index.wxml item.status == 3 || item.status == 4
 *   - pages/my/index.js              注释写着"后端还存在 status=2 与 4"
 * 现在收敛到本文件：状态数字、tab 分组、模板里判断状态用的常量都从这里取。
 *
 * ⚠️ 状态**文案**（待支付/制作中/交易成功/已取消）只在云函数里维护一份，
 *    由服务端始终返回 statusStr；前端不再自己拼文案、也不再覆盖服务端返回值。
 *    原因：云函数是独立打包的，无法 require 本文件，文案做两份拷贝迟早会漂移。
 *    两边的一致性由 tests/test-stage4.js 的断言守着。
 * ---------------------------------------------------------------------------
 */

/** 全部合法状态（只有这 4 个，2 / 4 不存在） */
const STATUS = {
  CANCELLED: -1, // 已取消（顾客主动取消 / 超时未支付自动取消）
  UNPAID: 0,     // 待支付
  MAKING: 1,     // 已付款、制作中（自提场景在「我的」页叫「待取货」）
  DONE: 3        // 交易成功（店主点「完成订单」后）
}

/** 「当前订单」tab：待支付 + 制作中（原 '0, 1, 2'，幽灵状态 2 已删除） */
const CURRENT_STATUS = [STATUS.UNPAID, STATUS.MAKING]

/** 「历史订单」tab：已取消 + 交易成功（原 '-1, 3, 4'，幽灵状态 4 已删除） */
const HISTORY_STATUS = [STATUS.CANCELLED, STATUS.DONE]

/** 「我的」页订单入口：只做项目里真实存在的状态 */
const ORDER_ENTRIES = [
  { key: String(STATUS.UNPAID), label: '待付款' },
  { key: String(STATUS.MAKING), label: '待取货' },
  { key: String(STATUS.DONE), label: '已完成' },
  { key: 'all', label: '全部订单' }
]

/**
 * 拼云函数 orderList 需要的 statusBatch 字符串
 * @param {number[]} list 状态数组（如 CURRENT_STATUS）
 * @returns {string} 如 '0,1'
 */
function statusBatch(list) {
  return (list || []).join(',')
}

/**
 * 订单该不该显示「删除订单」按钮（与服务端 orderDelete 的规则一致：
 * 只有终态 -1 已取消 / 3 交易成功可以删除）
 */
function canDelete(status) {
  return status === STATUS.CANCELLED || status === STATUS.DONE
}

/**
 * 是否店主可「完成订单」的状态（与服务端 orderFinish 的规则一致：只允许 1 → 3）
 */
function canFinish(status) {
  return status === STATUS.MAKING
}

module.exports = {
  STATUS,
  CURRENT_STATUS,
  HISTORY_STATUS,
  ORDER_ENTRIES,
  statusBatch,
  canDelete,
  canFinish
}
