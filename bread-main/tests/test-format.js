/**
 * 时间格式化单元测试（修复：下单时间显示成 13 位毫秒时间戳）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1. 毫秒时间戳 → 'YYYY-MM-DD HH:mm'，且绝不残留原始数字；
 *   2. 秒级时间戳、Date、字符串日期都能识别；
 *   3. 非法输入走 placeholder，不抛错、不显示 NaN。
 * ---------------------------------------------------------------------------
 */
const FMT = require('../utils/format')

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

// 用本地时间构造，避免测试结果依赖运行机器的时区
const LOCAL = new Date(2026, 9, 10, 17, 18, 12) // 2026-10-10 17:18:12
const LOCAL_MS = LOCAL.getTime()

console.log('=== 1) 毫秒时间戳（真实故障样本） ===')
// 线上截图里的真实值：下单时间显示为 1791623892357
const REAL = 1791623892357
const realText = FMT.formatDateTime(REAL)
check('返回 YYYY-MM-DD HH:mm 结构', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(realText), realText)
check('不再包含 13 位原始数字', realText.indexOf(String(REAL)) < 0, realText)
check('年份为 2026（时间本身没错）', realText.slice(0, 4) === '2026', realText)
check('带秒时结构为 YYYY-MM-DD HH:mm:ss', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(FMT.formatDateTime(REAL, { withSeconds: true })), FMT.formatDateTime(REAL, { withSeconds: true }))

console.log('=== 2) 本地时间戳 → 精确文案 ===')
check('formatDateTime(本地毫秒) === 2026-10-10 17:18', FMT.formatDateTime(LOCAL_MS) === '2026-10-10 17:18', FMT.formatDateTime(LOCAL_MS))
check('withSeconds 精确到秒', FMT.formatDateTime(LOCAL_MS, { withSeconds: true }) === '2026-10-10 17:18:12', FMT.formatDateTime(LOCAL_MS, { withSeconds: true }))
check('formatDate 只到日', FMT.formatDate(LOCAL_MS) === '2026-10-10', FMT.formatDate(LOCAL_MS))
check('个位数月日补零', FMT.formatDate(new Date(2026, 0, 5, 9, 5).getTime()) === '2026-01-05', FMT.formatDate(new Date(2026, 0, 5, 9, 5).getTime()))

console.log('=== 3) 其它输入形态 ===')
check('Date 对象', FMT.formatDateTime(LOCAL) === '2026-10-10 17:18', FMT.formatDateTime(LOCAL))
check('秒级时间戳（10 位）按秒处理', FMT.formatDateTime(Math.floor(LOCAL_MS / 1000)) === '2026-10-10 17:18', FMT.formatDateTime(Math.floor(LOCAL_MS / 1000)))
check('数字字符串', FMT.formatDateTime(String(LOCAL_MS)) === '2026-10-10 17:18', FMT.formatDateTime(String(LOCAL_MS)))
check("'YYYY-MM-DD HH:mm:ss' 字符串（iOS 兼容）", FMT.formatDateTime('2026-10-10 17:18:12') === '2026-10-10 17:18', FMT.formatDateTime('2026-10-10 17:18:12'))
check('ISO 8601 字符串', FMT.formatDateTime('2026-10-10T17:18:12') === '2026-10-10 17:18', FMT.formatDateTime('2026-10-10T17:18:12'))

console.log('=== 4) 非法输入兜底 ===')
check('null → 空字符串', FMT.formatDateTime(null) === '', FMT.formatDateTime(null))
check('undefined → 空字符串', FMT.formatDateTime(undefined) === '', FMT.formatDateTime(undefined))
check('0 → 不返回 1970 假时间', FMT.formatDateTime(0) === '', FMT.formatDateTime(0))
check('乱码字符串 → placeholder', FMT.formatDateTime('abc', { placeholder: '—' }) === '—', FMT.formatDateTime('abc', { placeholder: '—' }))
check('无效 Date → placeholder', FMT.formatDateTime(new Date('x'), { placeholder: '—' }) === '—', FMT.formatDateTime(new Date('x'), { placeholder: '—' }))
check('toDate 非法输入返回 null', FMT.toDate('abc') === null)

console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
