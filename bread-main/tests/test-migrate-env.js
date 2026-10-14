/**
 * 换云环境迁移脚本回归测试（2026-10-14 阶段 6 准备）
 * ---------------------------------------------------------------------------
 * 被测对象：cloud-data/tools/migrate-env.js
 *
 * 这个脚本要"改全仓库的文本"——正是最容易改坏东西的那类工具，所以测试重点不是
 * "能不能替换"，而是**边界**：
 *   · 只扫文本文件、跳过 node_modules / .git / 归档目录（不能把依赖和归档改坏）
 *   · 预演（plan）绝不能写文件
 *   · 执行（applyPlan）后内容正确、**可重复执行（幂等）**
 *   · 参数校验：新旧相同、新 ID 形态不对、AppID 形态不对 → 拒绝执行
 *   · 在真实仓库上能扫到 utils/data-source.js 里那个环境 ID（防止扫描逻辑写坏成"恒为空"）
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const MIG = require('../cloud-data/tools/migrate-env')

const ROOT = path.join(__dirname, '..')

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

// 夹具用的合成 ID（**故意不用仓库里那个真实环境 ID**：
// 否则迁移脚本会把测试里的常量也一起改掉，测试就"自己改自己"了）
const OLD = 'cloud1-fixtureold000000'
const NEW = 'cloud1-fixturenew111111'

/** 建一个临时仓库骨架（含一个被跳过的 node_modules） */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-env-'))
  const write = (rel, content) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  write('utils/data-source.js', "module.exports = {\n  cloudEnvId: '" + OLD + "',\n  useCloud: true\n}\n")
  write('project.config.json', JSON.stringify({ appid: 'wx5b0e027deafefc01', cloudfunctionRoot: 'cloudfunctions/' }, null, 2) + '\n')
  write('docs/清单.md', '> 云环境 ID：`' + OLD + '`\n> 又一次引用 ' + OLD + '\n')
  write('pages/index/index.js', '// 无引用\nconst a = 1\n')
  write('node_modules/pkg/index.js', "module.exports = '" + OLD + "'\n")
  write('.trash-cleanup/20260101/x.js', "// " + OLD + "\n")
  write('images/pic@2x.png', 'binary-' + OLD) // 非文本扩展名：不该被扫
  return dir
}

// ===========================================================================
console.log('=== 1) plan：只报告、不改文件、跳过非文本与归档目录 ===')
// ===========================================================================
{
  const dir = makeFixture()
  const before = fs.readFileSync(path.join(dir, 'utils/data-source.js'), 'utf8')
  const res = MIG.plan(dir, OLD, { to: NEW })

  check('扫到了 2 个文件（data-source / docs；project.config.json 里只有 appid、没有环境 ID）',
    res.files.length === 2, res.files.map((f) => f.rel))
  check('★ 跳过 node_modules', !res.files.some((f) => f.rel.indexOf('node_modules') >= 0))
  check('★ 跳过 .trash-cleanup 归档目录', !res.files.some((f) => f.rel.indexOf('.trash-cleanup') >= 0))
  check('★ 非文本扩展名（.png）不扫', !res.files.some((f) => f.rel.indexOf('.png') >= 0))
  check('行号与出现次数统计正确（docs 里同一文件 2 处 / 2 行）',
    res.files.find((f) => f.rel === 'docs/清单.md').count === 2,
    res.files.find((f) => f.rel === 'docs/清单.md'))
  check('合计出现次数 = 3（data-source 1 + docs 2）', res.total === 3, res.total)
  check('★ 预演不写文件', fs.readFileSync(path.join(dir, 'utils/data-source.js'), 'utf8') === before)
  check('附带读出当前 appid', res.appidNow === 'wx5b0e027deafefc01', res.appidNow)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
console.log('\n=== 2) applyPlan：内容正确替换，且可重复执行（幂等）===')
// ===========================================================================
{
  const dir = makeFixture()
  const res = MIG.plan(dir, OLD, { to: NEW })
  const out = MIG.applyPlan(dir, res, OLD, NEW)
  check('改动了 2 个文件 / 3 处', out.changedFiles === 2 && out.changedOccurrences === 3, out)

  const ds = fs.readFileSync(path.join(dir, 'utils/data-source.js'), 'utf8')
  check('★ data-source.js 里的环境 ID 已替换', ds.indexOf(NEW) >= 0 && ds.indexOf(OLD) < 0)
  check('  其它内容没被动（useCloud 还在）', ds.indexOf('useCloud: true') >= 0)
  const doc = fs.readFileSync(path.join(dir, 'docs/清单.md'), 'utf8')
  check('★ 同一文件多处都被替换（2 处）',
    doc.split(NEW).length - 1 === 2 && doc.indexOf(OLD) < 0, doc)
  check('  被跳过的 node_modules 原样保留',
    fs.readFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'utf8').indexOf(OLD) >= 0)

  // 幂等：换完再预演一次，应该找不到旧 ID
  const again = MIG.plan(dir, OLD, { to: NEW })
  check('★ 迁移后可重复执行：再预演找不到旧 ID（幂等）', again.total === 0, again.files)

  // 反向也成立：新 ID 现在能被扫到
  const backward = MIG.plan(dir, NEW, { to: OLD })
  check('  反向预演能找到新 ID（证明替换真的落盘了）', backward.total === 3, backward.total)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===========================================================================
console.log('\n=== 3) AppID 替换与参数校验 ===')
// ===========================================================================
{
  const dir = makeFixture()
  check('appid 替换成功', MIG.applyAppId(dir, 'wx0123456789abcdef') === true)
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf8'))
  check('  project.config.json 的 appid 已改', cfg.appid === 'wx0123456789abcdef', cfg.appid)
  check('  其它字段没丢（cloudfunctionRoot 还在）', cfg.cloudfunctionRoot === 'cloudfunctions/')
  check('  同一个 appid 再改一次返回 false（没变化）', MIG.applyAppId(dir, 'wx0123456789abcdef') === false)
  fs.rmSync(dir, { recursive: true, force: true })

  check('★ 环境 ID 形态校验：合法值通过', MIG.isValidEnvId(NEW) === true)
  check('  太短 / 空 / 带空格 → 拒绝',
    MIG.isValidEnvId('abc') === false && MIG.isValidEnvId('') === false && MIG.isValidEnvId('cloud1 a') === false)
  check('★ AppID 形态校验：wx + 16 位十六进制', MIG.isValidAppId('wx5b0e027deafefc01') === true &&
    MIG.isValidAppId('wxZZZ') === false && MIG.isValidAppId('5b0e027deafefc01') === false)

  // 旧环境 ID 的读取
  const dir2 = makeFixture()
  check('能从 utils/data-source.js 读出当前环境 ID', MIG.readCurrentEnvId(dir2) === OLD, MIG.readCurrentEnvId(dir2))
  fs.rmSync(dir2, { recursive: true, force: true })
}

// ===========================================================================
console.log('\n=== 4) 真实仓库：扫描逻辑真的能扫到东西（防止恒为空）===')
// ===========================================================================
{
  const current = MIG.readCurrentEnvId(ROOT)
  check('真实仓库里读得到当前环境 ID', !!current, current)
  const res = MIG.plan(ROOT, current, { to: NEW })
  check('★ 真实仓库里能扫到该环境 ID 的引用（至少 data-source.js 自己）',
    res.total >= 1 && res.files.some((f) => f.rel === 'utils/data-source.js'), res.files.map((f) => f.rel))
  check('  扫描的文本文件数量合理（> 50，防止 walk 写坏）', res.scanned > 50, res.scanned)
  check('  真实仓库里没有 cloud:// 旧环境图片前缀（图片仍在小程序包内，T-1 未做）',
    res.files.every((f) => f.rel.indexOf('cloud-data/') < 0 || f.rel.indexOf('tools/') >= 0),
    res.files.map((f) => f.rel))
}

console.log('\n' + '='.repeat(60))
console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
