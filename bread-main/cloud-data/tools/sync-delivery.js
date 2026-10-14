/**
 * 配送规则副本同步工具（阶段 8 新增）
 * ---------------------------------------------------------------------------
 * 背景：微信云函数是**独立打包**的，不能 require 主包里的文件，所以配送规则与
 *      配送计算必须是"两份内容相同的副本"：
 *
 *        config/delivery.js            ↔  cloudfunctions/api/delivery-config.js
 *        utils/delivery-range.js       ↔  cloudfunctions/api/delivery-calc.js
 *
 *      历史做法是"手工改两份"，2026-10-12 的复核已经证明这种做法会漂
 *      （报告 §4.3：副本头部注释自指）。阶段 8 改成 **主包为唯一事实来源，
 *      云函数副本由本脚本生成**：
 *
 *        node cloud-data/tools/sync-delivery.js          # 生成/覆盖云函数副本
 *        node cloud-data/tools/sync-delivery.js --check  # 只校验是否已同步（不写文件）
 *
 *      并有一条测试断言直接把 transform() 的结果与磁盘上的云函数副本逐字节比对
 *      （tests/test-delivery.js 的「副本同步」一节）——**只改一边，测试就会红**。
 *
 * 云函数副本与主包文件的**唯一差异**（由 transform 保证）：
 *   1) 头部注释块换成"云函数副本"版本（说明方向，并注明由本脚本生成）；
 *   2) `require('../config/delivery')`  → `require('./delivery-config')`；
 *      `require('../shop-config')`      → `require('./shop-config')`。
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')

// ===== 云函数副本的头部注释（生成时整块替换主包的头部注释）=====
const CLOUD_HEADER_CONFIG = `/**
 * 配送规则配置（云函数副本）
 * ---------------------------------------------------------------------------
 * ⚠️ 本文件与主包的 \`config/delivery.js\` 是同一份规则的两份副本。
 *    微信云函数是独立打包的，无法 require 主包里的文件，因此必须复制。
 *
 * ★ 本文件**不要手改**：它由 \`node cloud-data/tools/sync-delivery.js\` 从
 *   \`config/delivery.js\` 生成（阶段 8 起）。改规则只改主包那份，然后跑脚本；
 *   \`tests/test-delivery.js\` 有一条断言会把两边逐字节比对，改一边就红。
 *
 * 改规则时【两个文件都要改】这一条的老提醒仍然成立 —— 只是现在由脚本替你改。
 * 规则来源：店主表姐提供，2026-02-14 与开发者逐条确认；
 *          2026-10-12 店主微信反馈 R-03 / R-05（配送费可设、送多远、哪里不送）。
 * ---------------------------------------------------------------------------
 */`

const CLOUD_HEADER_CALC = `/**
 * 配送计算：距离 / 范围 / 运费 / 预约时间校验（云函数副本）
 * ---------------------------------------------------------------------------
 * ★ 本文件是【纯函数】模块，不依赖 wx 与任何小程序 API。
 *   因此前端、云函数、Node 测试三处都能用同一份逻辑，避免规则漂移。
 *
 * ⚠️ 本文件与主包的 \`utils/delivery-range.js\` 是两份副本，改动需同步。
 *    ★ 但**不要手改本文件**：它由 \`node cloud-data/tools/sync-delivery.js\` 生成，
 *      改逻辑只改主包那份，然后跑脚本。
 *      （2026-10-12 阶段 5.7 修正：这里原先写的是「与 cloudfunctions/api/delivery-calc.js
 *        是两份副本」—— 自己指自己，报告 §4.3 已记录。）
 *      （阶段 8 起改为脚本生成，从根上消除两边不一致的可能。）
 *
 * 规则来源见 config/delivery.js
 * ---------------------------------------------------------------------------
 */`

// 主包 require → 云函数 require（云函数目录内的相对路径）
const REQUIRE_REPLACEMENTS = [
  ["require('../config/delivery')", "require('./delivery-config')"],
  ["require('../shop-config')", "require('./shop-config')"]
]

// ===== 两对副本的配置 =====
const PAIRS = [
  {
    id: 'config',
    main: 'config/delivery.js',
    cloud: 'cloudfunctions/api/delivery-config.js',
    header: CLOUD_HEADER_CONFIG,
    requireReplacements: []
  },
  {
    id: 'calc',
    main: 'utils/delivery-range.js',
    cloud: 'cloudfunctions/api/delivery-calc.js',
    header: CLOUD_HEADER_CALC,
    requireReplacements: REQUIRE_REPLACEMENTS
  }
]

/**
 * 把主包源码转成云函数副本源码（纯字符串变换，便于测试直接调用比对）
 * @param {string} id 'config' | 'calc'
 * @param {string} src 主包文件内容
 * @returns {string} 云函数副本应有的内容
 */
function transform(id, src) {
  const pair = PAIRS.find((p) => p.id === id)
  if (!pair) throw new Error('未知的副本 id：' + id)

  // ---- 1) 头部注释块整块替换 ----
  const end = src.indexOf('*/')
  if (!src.startsWith('/**') || end < 0) {
    throw new Error(pair.main + ' 的头部注释格式异常：应以 /** 开头并含 */')
  }
  let out = pair.header + src.slice(end + 2)

  // ---- 2) require 路径替换 ----
  pair.requireReplacements.forEach(([from, to]) => {
    if (out.indexOf(from) < 0) {
      throw new Error(pair.main + ' 里找不到待替换的 ' + from + '（源文件结构变了？）')
    }
    out = out.split(from).join(to)
  })

  return out
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0
  let drift = 0

  PAIRS.forEach((pair) => {
    const expected = transform(pair.id, read(pair.main))
    let actual = ''
    try {
      actual = read(pair.cloud)
    } catch (e) {
      actual = null
    }

    if (actual === expected) {
      console.log('  OK   ' + pair.cloud + ' 与 ' + pair.main + ' 已同步')
      return
    }

    drift++
    if (checkOnly) {
      console.log('  FAIL ' + pair.cloud + ' 与 ' + pair.main + ' 不一致（跑 sync-delivery.js 重新生成）')
      return
    }
    fs.writeFileSync(path.join(ROOT, pair.cloud), expected, 'utf8')
    console.log('  写入 ' + pair.cloud + '（由 ' + pair.main + ' 生成）')
  })

  if (checkOnly && drift) {
    process.exitCode = 1
  }
  console.log(checkOnly ? '同步检查完成：' + drift + ' 处漂移' : '同步完成：' + PAIRS.length + ' 对副本')
}

module.exports = { transform, PAIRS }

if (require.main === module) main()
