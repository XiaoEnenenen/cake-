#!/usr/bin/env node
/**
 * 换云环境（阶段 6）迁移脚本
 * ---------------------------------------------------------------------------
 * 换新 AppID / 新云环境时，**云环境 ID 会变**，而它散落在代码、数据、文档里。
 * 漏改任意一处，症状分别是：
 *   · `utils/data-source.js` 漏改 → 小程序连的还是旧环境（新环境里一片空白）；
 *   · `cloud://<旧环境>.xxx/...` 漏改 → 商品图/轮播图**全部裂图**（图在旧环境里）；
 *   · `project.config.json` 的 appid 漏改 → 开发者工具上传到旧账号；
 *   · 文档里的旧 ID 漏改 → 下次照着文档操作又连错环境。
 *
 * 所以本脚本只做一件事：**把环境 ID 的替换做成可预演、可回滚的批量操作**。
 *
 * 用法（在 bread-main 目录下执行）：
 *   node cloud-data/tools/migrate-env.js --to cloud1-xxxxxxxxxxxxxxxx      # 预演：只报告不改
 *   node cloud-data/tools/migrate-env.js --to cloud1-xxxxxxxxxxxxxxxx --apply
 *   node cloud-data/tools/migrate-env.js --to <新环境> --appid wxXXXXXXXXXXXX --apply
 *
 * 选项：
 *   --from <旧环境ID>  缺省自动从 utils/data-source.js 的 cloudEnvId 读取
 *   --to   <新环境ID>  必填
 *   --appid <新AppID>  可选：同时改 project.config.json 的 appid（形如 wx + 16 位十六进制）
 *   --apply            真的写文件；**不加这个参数只做预演**（默认安全）
 *   --root <目录>      扫描根目录，缺省 = 本仓库的 bread-main（测试用）
 *
 * 回滚：本仓库在 Git 下，`git checkout -- .` 即可撤销全部改动（跑完先 `git diff` 看一眼）。
 * ---------------------------------------------------------------------------
 * ⚠️ 本脚本**不碰**云开发控制台里的东西（建集合、设权限、建索引、部署云函数、导数据、
 *    重传云存储图片）—— 那些步骤见 docs/换新号迁移清单.md。
 * ---------------------------------------------------------------------------
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT_DEFAULT = path.resolve(__dirname, '..', '..') // bread-main

// 扫描范围：只处理文本文件；这些目录一律跳过（依赖/归档/工具/生成物）
const SKIP_DIRS = ['node_modules', 'miniprogram_npm', '.git', '.trash-cleanup', '.tools', 'dist', 'coverage']
// 本文件自己的示例注释里也写着旧环境 ID，扫自己没有意义，跳过
const SKIP_FILES = ['cloud-data/tools/migrate-env.js']
const TEXT_EXT = ['.js', '.json', '.jsonl', '.wxml', '.wxss', '.wxs', '.md', '.txt', '.py', '.css', '.html']

function isTextFile(file) {
  return TEXT_EXT.indexOf(path.extname(file).toLowerCase()) >= 0
}

/** 递归收集待扫描文件（相对 root 的路径数组） */
function walk(root, dir, out, skipDirs) {
  const abs = path.join(root, dir)
  let entries = []
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch (e) {
    return out
  }
  entries.forEach((ent) => {
    const rel = dir ? dir + '/' + ent.name : ent.name
    if (ent.isDirectory()) {
      if (skipDirs.indexOf(ent.name) >= 0) return
      walk(root, rel, out, skipDirs)
    } else if (ent.isFile() && isTextFile(ent.name)) {
      if (SKIP_FILES.indexOf(rel) >= 0) return
      out.push(rel)
    }
  })
  return out
}

/** 参数解析 */
function parseArgs(argv) {
  const args = { apply: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--quiet') args.quiet = true
    else if (a === '--from') args.from = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--appid') args.appid = argv[++i]
    else if (a === '--root') args.root = argv[++i]
  }
  return args
}

/** 从 utils/data-source.js 里读当前环境 ID（正则够用，不 require 以免受运行时影响） */
function readCurrentEnvId(root) {
  const file = path.join(root, 'utils', 'data-source.js')
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(/cloudEnvId\s*:\s*'([^']*)'/)
  return m ? m[1] : ''
}

/** 环境 ID 基本形态校验：字母数字组成、允许短横线、至少 6 位 */
function isValidEnvId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{5,}$/.test(id)
}
function isValidAppId(id) {
  return typeof id === 'string' && /^wx[0-9a-f]{16}$/.test(id)
}

/**
 * 预演：找出所有含旧环境 ID 的文件与行
 * @returns {{ files: Array<{rel:string, count:number, lines:Array<{n:number,text:string}>}>, total:number, scanned:number }}
 */
function plan(root, from, opts) {
  const o = opts || {}
  const files = walk(root, '', [], SKIP_DIRS)
  const hits = []
  let total = 0
  files.forEach((rel) => {
    const abs = path.join(root, rel)
    let src = ''
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch (e) {
      return
    }
    if (src.indexOf(from) < 0) return
    const lines = []
    let count = 0
    src.split(/\r?\n/).forEach((text, i) => {
      const n = text.split(from).length - 1
      if (n > 0) {
        count += n
        lines.push({ n: i + 1, text: text.trim() })
      }
    })
    if (count) {
      hits.push({ rel, count, lines })
      total += count
    }
  })
  // 附带：appid 现状（--appid 时才关心）
  let appidNow = ''
  try {
    appidNow = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')).appid || ''
  } catch (e) {
    appidNow = ''
  }
  return { files: hits, total, scanned: files.length, appidNow, from, to: o.to || '' }
}

/** 执行替换；返回实际改动的文件与替换次数 */
function applyPlan(root, planRes, from, to) {
  let changedFiles = 0
  let changedOccurrences = 0
  planRes.files.forEach((f) => {
    const abs = path.join(root, f.rel)
    const src = fs.readFileSync(abs, 'utf8')
    const next = src.split(from).join(to)
    if (next !== src) {
      fs.writeFileSync(abs, next, 'utf8')
      changedFiles++
      changedOccurrences += f.count
    }
  })
  return { changedFiles, changedOccurrences }
}

/** 改 project.config.json 的 appid（单独一步，便于报告） */
function applyAppId(root, newAppId) {
  const file = path.join(root, 'project.config.json')
  const raw = fs.readFileSync(file, 'utf8')
  const next = raw.replace(/("appid"\s*:\s*")[^"]*(")/, '$1' + newAppId + '$2')
  if (next === raw) return false
  fs.writeFileSync(file, next, 'utf8')
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root || ROOT_DEFAULT)
  const quiet = args.quiet

  if (!fs.existsSync(path.join(root, 'utils', 'data-source.js'))) {
    console.error('找不到 ' + path.join(root, 'utils', 'data-source.js') + '，--root 是否正确？')
    process.exit(1)
  }

  const from = args.from || readCurrentEnvId(root)
  const to = args.to

  if (!from) {
    console.error('无法确定旧环境 ID：utils/data-source.js 的 cloudEnvId 是空的，请用 --from 指定。')
    process.exit(1)
  }
  if (!to) {
    console.error('缺少 --to <新环境ID>。用法见文件头注释。')
    process.exit(1)
  }
  if (!isValidEnvId(to)) {
    console.error('新环境 ID「' + to + '」形态不对（应形如 cloud1-d7g2txuxpf22bb979）。')
    process.exit(1)
  }
  if (to === from) {
    console.error('新旧环境 ID 相同（' + from + '），没有可迁移的东西。')
    process.exit(1)
  }
  if (args.appid !== undefined && !isValidAppId(args.appid)) {
    console.error('新 AppID「' + args.appid + '」形态不对（应形如 wx5b0e027deafefc01）。')
    process.exit(1)
  }

  const res = plan(root, from, { to })
  const line = '-'.repeat(72)

  if (!quiet) {
    console.log('')
    console.log('云环境迁移预演' + (args.apply ? '（--apply，将真的写文件）' : '（只报告，不改文件）'))
    console.log(line)
    console.log('  扫描根目录 : ' + root)
    console.log('  旧环境 ID  : ' + from)
    console.log('  新环境 ID  : ' + to)
    console.log('  扫描文本文件: ' + res.scanned + ' 个')
    console.log(line)
  }

  if (!res.total) {
    console.log('  未找到旧环境 ID 的引用 —— 可能已经迁过了。')
  } else {
    res.files.forEach((f) => {
      console.log('  ' + f.rel + '  （' + f.count + ' 处）')
      if (!quiet) {
        f.lines.slice(0, 4).forEach((l) => {
          console.log('      L' + l.n + ': ' + (l.text.length > 110 ? l.text.slice(0, 110) + '…' : l.text))
        })
        if (f.lines.length > 4) console.log('      … 另有 ' + (f.lines.length - 4) + ' 行')
      }
    })
    console.log(line)
    console.log('  合计：' + res.files.length + ' 个文件 / ' + res.total + ' 处引用')
  }

  if (args.appid !== undefined) {
    console.log('  project.config.json 的 appid：' + res.appidNow + ' → ' + args.appid)
  }

  if (!args.apply) {
    console.log('')
    console.log('  以上为预演。确认无误后加 --apply 执行替换（可先 git status 确认工作区干净，')
    console.log('  跑完用 git diff 复核；回滚：git checkout -- .）')
    return
  }

  if (res.total) {
    const out = applyPlan(root, res, from, to)
    console.log('')
    console.log('  ✓ 已替换 ' + out.changedFiles + ' 个文件 / ' + out.changedOccurrences + ' 处')
  }
  if (args.appid !== undefined) {
    const ok = applyAppId(root, args.appid)
    console.log('  ' + (ok ? '✓ project.config.json 的 appid 已改为 ' + args.appid : '· project.config.json 的 appid 本来就是这个值'))
  }

  console.log('')
  console.log('  ⚠️ 本脚本不碰云开发控制台，接下来还要做（见 docs/换新号迁移清单.md）：')
  console.log('     1. 新 AppID 下开通云开发，拿到新环境 ID')
  console.log('     2. 建 7 个集合 + 设权限（user/cart/order 必须"仅创建者可读写"）')
  console.log('     3. 建索引（order.orderNumber 唯一、order._openid、cart._openid、goods.categoryId）')
  console.log('     4. 上传部署云函数 api（云端安装依赖）')
  console.log('     5. 导入 category / goods / banner / app_config（不要迁 user / order）')
  console.log('     6. 云存储：重传图片到新环境，并确认"所有用户可读"')
  console.log('     7. 填 adminOpenids（店主新 openid）、校准门店坐标')
  console.log('')
  console.log('  核对：git diff 应只出现环境 ID / appid 的替换；npm test 应全绿。')
}

module.exports = { plan, applyPlan, applyAppId, readCurrentEnvId, isValidEnvId, isValidAppId, walk, SKIP_DIRS, TEXT_EXT }

if (require.main === module) main()
