/**
 * 时区回归测试：云函数（UTC）也必须按**北京时间**判断预约时间
 * ---------------------------------------------------------------------------
 * 背景（上线收尾 P0-2）：
 *   云函数运行在 UTC，而 `utils/delivery-range.js` 原来用
 *   `new Date(y, m-1, d, h, min)` 构造时间、用 `getHours()/getMinutes()`
 *   判断营业时间 —— 这些 API 都按**运行环境时区**解释墙上时间。
 *   在 UTC 机器上整体晚 8 小时，后果：
 *     · 「蛋糕提前 3 小时」形同虚设（本地测试跑在 UTC+8，永远发现不了）；
 *     · 营业时间 09:00-22:00 错位成 17:00-06:00（凌晨的单会被拒）；
 *     · buildDateOptions 在北京时间 00:00-08:00 会把"今天"算成前一天。
 *
 * 做法：
 *   - 非 UTC 环境启动时，用子进程带 TZ=UTC 重跑本文件（父进程只透传退出码），
 *     这样"开发机 UTC+8、云函数 UTC"的差异才会被真正验证到；
 *   - 子进程用 stdio:'inherit'，**不捕获输出**（部分受限环境里管道会 EPERM）；
 *   - UTC 分支里的时间常量全部写成 `Date.UTC(...)`，不依赖本机时区。
 *
 * 运行：node tests/test-timezone.js（npm test 由 Lead 统一并入）
 * ---------------------------------------------------------------------------
 */
const childProcess = require('child_process')

function run() {
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

  const D = require('../utils/delivery-range')
  const CloudD = require('../cloudfunctions/api/delivery-calc')
  const H = require('../cloudfunctions/api/handlers')
  const SHOP = require('../shop-config').shop

  // 北京时间 2026-03-01 10:00 = UTC 2026-03-01 02:00
  const NOW_MS = Date.UTC(2026, 2, 1, 2, 0, 0)
  const now = new Date(NOW_MS)
  const OPENING = SHOP.openingHours // 09:00-22:00
  const CAKE = [{ goods: { isCake: true }, sku: [] }]

  console.log('=== 0) 前置：确实跑在 UTC 时区（模拟云函数）===')
  check('  子进程的 process.env.TZ === "UTC"', process.env.TZ === 'UTC', process.env.TZ)
  check('  new Date().getHours() 按 UTC 取值（UTC 02:00 → 2）',
    new Date(NOW_MS).getHours() === 2, new Date(NOW_MS).getHours())
  check('  营业时间确实是 09:00-22:00', OPENING === '09:00-22:00', OPENING)

  console.log('\n=== 1) parseBeijingTime：墙上时间按北京时间解释 ===')
  check('  BEIJING_OFFSET_MS = 8 小时',
    D.BEIJING_OFFSET_MS === 8 * 60 * 60 * 1000, D.BEIJING_OFFSET_MS)
  check('  "2026-03-01 13:00" = UTC 05:00（北京时间 13:00）',
    D.parseBeijingTime('2026-03-01 13:00') === Date.UTC(2026, 2, 1, 5, 0),
    D.parseBeijingTime('2026-03-01 13:00'))
  check('  也接受 T 分隔（2026-03-01T13:00:00）',
    D.parseBeijingTime('2026-03-01T13:00:00') === Date.UTC(2026, 2, 1, 5, 0),
    D.parseBeijingTime('2026-03-01T13:00:00'))
  check('  Date 入参原样取 epoch（不再做时区解释）',
    D.parseBeijingTime(now) === NOW_MS, D.parseBeijingTime(now))
  check('  number 入参原样取 epoch',
    D.parseBeijingTime(NOW_MS) === NOW_MS, D.parseBeijingTime(NOW_MS))
  check('  带 Z 的 ISO 串交给 new Date（按 UTC 解释）',
    D.parseBeijingTime('2026-03-01T05:00:00Z') === Date.UTC(2026, 2, 1, 5, 0),
    D.parseBeijingTime('2026-03-01T05:00:00Z'))
  check('  空 / 非法字符串 → null',
    D.parseBeijingTime('') === null && D.parseBeijingTime('不是时间') === null)

  console.log('\n=== 2) fmtTime：按北京时间输出 HH:MM ===')
  check('  UTC 05:00 → "13:00"（北京 13:00）',
    D.fmtTime(new Date(Date.UTC(2026, 2, 1, 5, 0))) === '13:00',
    D.fmtTime(new Date(Date.UTC(2026, 2, 1, 5, 0))))
  check('  now（北京 10:00）→ "10:00"', D.fmtTime(now) === '10:00', D.fmtTime(now))

  console.log('\n=== 3) checkAdvanceTime：北京 10:00 下蛋糕提前 3 小时 ===')
  const q12 = D.checkAdvanceTime({
    expectTime: '2026-03-01 12:00',
    items: CAKE,
    now,
    openingHours: OPENING
  })
  check('  蛋糕 + 12:00（不足 3 小时）→ 拒绝 too_soon',
    q12.valid === false && q12.reason === 'too_soon', q12)
  check('  提示里的"最早 HH:MM"是北京时间 13:00',
    q12.tip.indexOf('13:00') >= 0, q12.tip)
  check('  earliest = 北京 13:00（epoch 正确）',
    q12.earliest.getTime() === Date.UTC(2026, 2, 1, 5, 0), q12.earliest)

  const q12Date = D.checkAdvanceTime({
    expectTime: new Date(Date.UTC(2026, 2, 1, 4, 0)), // 同一时刻，日期对象入参
    items: CAKE,
    now,
    openingHours: OPENING
  })
  check('  Date 入参算出同一结果（页面传 Date 的路径）',
    q12Date.valid === false && q12Date.reason === 'too_soon', q12Date)

  const q13 = D.checkAdvanceTime({
    expectTime: '2026-03-01 13:00',
    items: CAKE,
    now,
    openingHours: OPENING
  })
  check('  蛋糕 + 13:00（恰好 3 小时）→ 通过', q13.valid === true, q13)

  const qNoCake11 = D.checkAdvanceTime({
    expectTime: '2026-03-01 11:00',
    items: [],
    now,
    openingHours: OPENING
  })
  check('  非蛋糕 + 11:00 → 通过（applyToAll=false 不校验提前量）',
    qNoCake11.valid === true, qNoCake11)

  const qClosed8 = D.checkAdvanceTime({
    expectTime: '2026-03-01 08:00',
    items: [],
    now,
    openingHours: OPENING
  })
  check('  08:00（北京）→ 未营业 closed',
    qClosed8.valid === false && qClosed8.reason === 'closed', qClosed8)
  check('  未营业提示里带营业时间', qClosed8.tip.indexOf(OPENING) >= 0, qClosed8.tip)

  const q22 = D.checkAdvanceTime({
    expectTime: '2026-03-01 22:00',
    items: [],
    now,
    openingHours: OPENING
  })
  check('  22:00（打烊边界，含等号）→ 通过', q22.valid === true, q22)

  const qClosed23 = D.checkAdvanceTime({
    expectTime: '2026-03-01 23:00',
    items: [],
    now,
    openingHours: OPENING
  })
  check('  23:00（北京）→ 已打烊 closed',
    qClosed23.valid === false && qClosed23.reason === 'closed', qClosed23)

  // 跨天：北京 21:00 下单蛋糕，最早次日 00:00
  const nightMs = Date.UTC(2026, 2, 1, 13, 0) // 北京 2026-03-01 21:00
  const qNight = D.checkAdvanceTime({
    expectTime: '2026-03-01 22:00',
    items: CAKE,
    now: new Date(nightMs),
    openingHours: OPENING
  })
  check('  北京 21:00 下单蛋糕选 22:00 → 拒绝 too_soon',
    qNight.valid === false && qNight.reason === 'too_soon', qNight)
  const qNextDay = D.checkAdvanceTime({
    expectTime: '2026-03-02 10:00',
    items: CAKE,
    now: new Date(nightMs),
    openingHours: OPENING
  })
  check('  北京 21:00 下单蛋糕选次日 10:00 → 通过', qNextDay.valid === true, qNextDay)

  const qNoTime = D.checkAdvanceTime({ expectTime: null, items: [], now, openingHours: OPENING })
  check('  未选时间 → no_time', qNoTime.valid === false && qNoTime.reason === 'no_time', qNoTime)

  console.log('\n=== 4) buildTimeSlots：按北京日历日 / 北京时间生成时段 ===')
  const slots = D.buildTimeSlots('2026-03-01', now)
  check('  北京时间 10:00 时，当天首个可选时段为 13:00', slots[0] === '13:00', slots.slice(0, 3))
  check('  末个时段为打烊 22:00', slots[slots.length - 1] === '22:00', slots[slots.length - 1])
  check('  过滤掉不足 3 小时的 09:00-12:00（共 10 个时段）',
    slots.length === 10 && slots.every((s) => s >= '13:00'), slots)
  const tomorrowSlots = D.buildTimeSlots('2026-03-02', now)
  check('  次日（整天空闲）首 09:00 尾 22:00',
    tomorrowSlots[0] === '09:00' && tomorrowSlots[tomorrowSlots.length - 1] === '22:00',
    [tomorrowSlots[0], tomorrowSlots[tomorrowSlots.length - 1]])

  // 北京凌晨 01:00 = UTC 前一天 17:00：UTC 日期与北京日期不同，最容易错一天
  const earlyMs = Date.UTC(2026, 1, 28, 17, 0) // 北京 2026-03-01 01:00
  const earlySlots = D.buildTimeSlots('2026-03-01', new Date(earlyMs))
  check('  北京凌晨 01:00 时当天首时段为 09:00（最早 04:00 起都在营业时间内）',
    earlySlots[0] === '09:00', earlySlots.slice(0, 3))

  console.log('\n=== 5) buildDateOptions：今天/明天按北京日期 ===')
  const dates = D.buildDateOptions(now)
  check('  生成 7 天', dates.length === 7, dates.length)
  check('  北京 2026-03-01 10:00 → 今天 value = 2026-03-01',
    dates[0].value === '2026-03-01' && dates[0].label === '今天', dates[0])
  check('  明天 value = 2026-03-02', dates[1].value === '2026-03-02' && dates[1].label === '明天', dates[1])
  check('  后天 value = 2026-03-03', dates[2].value === '2026-03-03' && dates[2].label === '后天', dates[2])

  // ★ 关键：UTC 是 2026-02-28 17:00，北京已是 2026-03-01 —— 不能按 UTC 日期错成 02-28
  const earlyDates = D.buildDateOptions(new Date(earlyMs))
  check('  北京凌晨 01:00 → 今天仍是 2026-03-01（不按 UTC 日期错一天）',
    earlyDates[0].value === '2026-03-01' && earlyDates[0].label === '今天', earlyDates[0])

  console.log('\n=== 6) handlers.parseExpectTime 与服务端校验同一时刻口径 ===')
  // 注：统一用 parseBeijingTime 归一成 epoch 比较（handlers 返回 Date 或 epoch 都成立）
  const parsed = H.parseExpectTime('2026-03-01 13:00')
  check('  handlers.parseExpectTime("2026-03-01 13:00") = UTC 05:00',
    D.parseBeijingTime(parsed) === Date.UTC(2026, 2, 1, 5, 0), parsed)
  check('  与 delivery.parseBeijingTime 同一时刻',
    D.parseBeijingTime(parsed) === D.parseBeijingTime('2026-03-01 13:00'), {
      handlers: D.parseBeijingTime(parsed),
      delivery: D.parseBeijingTime('2026-03-01 13:00')
    })
  const parsedEarly = H.parseExpectTime('2026-03-01 08:00')
  check('  handlers.parseExpectTime("2026-03-01 08:00") = UTC 00:00（北京 08:00）',
    D.parseBeijingTime(parsedEarly) === Date.UTC(2026, 2, 1, 0, 0), parsedEarly)
  // 云函数 orderCreate 的路径：先 parseExpectTime，再把结果喂给 checkAdvanceTime
  const serverCheck = CloudD.checkAdvanceTime({
    expectTime: H.parseExpectTime('2026-03-01 12:00'),
    items: CAKE,
    now,
    openingHours: OPENING
  })
  check('  服务端路径（parseExpectTime → checkAdvanceTime）蛋糕+12:00 → too_soon',
    serverCheck.valid === false && serverCheck.reason === 'too_soon', serverCheck)

  console.log('\n=== 7) 云函数副本仍与主包逐字节同步（防止只改一边）===')
  const fs = require('fs')
  const path = require('path')
  const SYNC = require('../cloud-data/tools/sync-delivery')
  const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  check('  cloudfunctions/api/delivery-calc.js == sync-delivery 由主包生成的结果',
    SYNC.transform('calc', rd('utils/delivery-range.js')) === rd('cloudfunctions/api/delivery-calc.js'))
  check('  云函数副本导出了 parseBeijingTime / BEIJING_OFFSET_MS',
    typeof CloudD.parseBeijingTime === 'function' &&
    CloudD.BEIJING_OFFSET_MS === 8 * 60 * 60 * 1000)
  check('  云函数副本的 parseBeijingTime 与主包结果一致',
    CloudD.parseBeijingTime('2026-03-01 13:00') === D.parseBeijingTime('2026-03-01 13:00'))
  const cloudCheck = CloudD.checkAdvanceTime({
    expectTime: '2026-03-01 12:00',
    items: CAKE,
    now,
    openingHours: OPENING
  })
  check('  云函数副本 checkAdvanceTime 在 UTC 下同样拒绝蛋糕 + 12:00',
    cloudCheck.valid === false && cloudCheck.reason === 'too_soon', cloudCheck)

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' / 失败 ' + fail)
  if (fail) process.exitCode = 1
}

if (process.env.TZ !== 'UTC') {
  // 本机（UTC+8）只负责把 TZ=UTC 传下去；断言全部在子进程里跑
  console.log('（当前不是 UTC 时区，用 TZ=UTC 子进程重跑以模拟云函数运行环境）')
  const result = childProcess.spawnSync(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { TZ: 'UTC' }),
    // 输出直接继承：不能捕获（受限环境下管道会 EPERM），也方便直接看到子进程断言
    stdio: 'inherit'
  })
  if (result.error) {
    console.error('  FAIL 无法启动 TZ=UTC 子进程：' + result.error.message)
    process.exitCode = 1
  } else {
    process.exitCode = result.status === null ? 1 : result.status
  }
} else {
  run()
}
