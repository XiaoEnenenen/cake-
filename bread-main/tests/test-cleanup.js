/**
 * 阶段 5.7「整洁度」回归测试（2026-10-12 新增）
 * ---------------------------------------------------------------------------
 * 背景：审计报告 §4.3 列了一批 P2/P3 整洁度问题（死代码 / 死数据 / 日志散落 /
 *      文档与代码不符），它们在《实施步骤清单》里归到阶段 5.7。
 *      这类问题的特点是：**改好了不会有任何功能变化，所以最容易悄悄退回去**。
 *      因此本文件把"已经清理干净"这件事变成断言。
 *
 * 覆盖：
 *   1. 日志：pages/** 与 utils/** 里不再直接写 console.*（统一走 utils/log.js）
 *   2. 死代码/死数据：空的 configLoadOK 桩、shopNotice、refreshAreaText、硬编码版本号
 *   3. 配置：app.json 不再注册零使用的 van-dialog / van-datetime-picker
 *   4. 资源：零引用图片已归档，且仍被种子数据引用的图片没有被误删
 *   5. 样式：页面 wxss 不再重复 app.wxss 已声明的 page 背景
 *   6. 文档与代码一致：接线页面数 / 公开 action 数 / 分类数 / 规格字段名
 *
 * 运行：node tests/test-cleanup.js
 * ---------------------------------------------------------------------------
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

/** 递归收集文件（跳过生成物与第三方） */
function walk(dir, out) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (/node_modules|miniprogram_npm|\.trash-cleanup/.test(e.name)) continue
    const rel = path.join(dir, e.name).replace(/\\/g, '/')
    if (e.isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

/** 去掉注释后的"代码"（用来区分"注释里解释过"和"代码里还在用"） */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 去掉 JS / WXML / WXSS 三种注释（wxml 的注释是 <!-- -->） */
function stripAll(text) {
  return code(text).replace(/<!--[\s\S]*?-->/g, '')
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

function main() {
  // =========================================================================
  console.log('=== 1) 日志收敛：页面/utils 不再直接写 console.* ===')
  // =========================================================================
  const appFiles = walk('pages', []).concat(walk('utils', []))
  const offenders = []
  for (const f of appFiles) {
    if (!f.endsWith('.js')) continue
    if (f === 'utils/log.js') continue // 唯一的 console 出口
    const c = code(src(f))
    if (/console\.(log|warn|error|info|debug)\s*\(/.test(c)) offenders.push(f)
  }
  check('★ pages/ 与 utils/ 里除 utils/log.js 外没有直接的 console.* 调用',
    offenders.length === 0, offenders)
  check('utils/log.js 存在', exists('utils/log.js'))
  const logJs = src('utils/log.js')
  check('log.debug 受 DS.debug 开关控制', /if \(!DS\.debug\) return[\s\S]{0,200}console\.log/.test(logJs))
  check('log.error 始终输出（异常必须留痕）', /function error\(\)[\s\S]{0,200}console\.error/.test(logJs))
  check('log.warn 始终输出（与收敛前一致）', /function warn\(\)[\s\S]{0,200}console\.warn/.test(logJs))
  check('云函数侧的日志不受影响（服务端日志是云控制台唯一观测手段）',
    /console\.warn\('\[orderCreate\]/.test(src('cloudfunctions/api/handlers.js')))

  // =========================================================================
  console.log('\n=== 2) 死代码 / 死数据清理 ===')
  // =========================================================================
  // 空的 app.configLoadOK 桩：只剩 pages/index 的实义赋值
  const stubbers = []
  for (const f of walk('pages', [])) {
    if (!f.endsWith('.js')) continue
    // 形如 app.configLoadOK = () => { } 或 function () { }（函数体里没有语句）
    if (/configLoadOK\s*=\s*(\([^)]*\)|function\s*\([^)]*\))\s*(=>)?\s*\{\s*\}/.test(code(src(f)))) {
      stubbers.push(f)
    }
  }
  check('★ 没有残留的空 configLoadOK 桩（api 工厂时代的启动回调）',
    stubbers.length === 0, stubbers)
  check('app.js 仍保留对 configLoadOK 的调用（首页标题依赖它）',
    /if \(this\.configLoadOK\)/.test(src('app.js')))
  check('首页仍有实义 configLoadOK（不能被误删）',
    /getApp\(\)\.configLoadOK\s*=\s*\(\)\s*=>\s*\{\s*this\.configLoadOK\(\)/.test(src('pages/index/index.js')))

  // shopNotice 死数据（注释里解释过它是可以的，代码里不能还有）
  const allCode = walk('pages', []).concat(walk('components', []))
    .filter((f) => /\.(js|wxml|wxss)$/.test(f))
    .map((f) => f + ' :: ' + stripAll(src(f))).join('\n')
  check('★ 全项目代码里已无 shopNotice（原来是一个永远为空的 wx:if 死节点）',
    allCode.indexOf('shopNotice') < 0,
    (allCode.match(/[^\n]*shopNotice[^\n]*/g) || []).slice(0, 3))

  // refreshAreaText 死函数
  check('★ pages/address/edit.js 已删除无人调用的 refreshAreaText()',
    !/refreshAreaText/.test(code(src('pages/address/edit.js'))))

  // 关于页硬编码版本号
  check('★ 关于我们页不再硬编码「Version 1.0 17:30:54」',
    !/17:30:54/.test(stripAll(src('pages/about-us/index.wxml'))))
  check('版本号改为读微信运行时信息',
    /getAccountInfoSync/.test(src('pages/about-us/index.js')))

  // 未使用的 Dialog 导入
  check('★ utils/auth.js 已删除未使用的 Dialog 导入',
    !/@vant\/weapp\/dialog/.test(code(src('utils/auth.js'))))

  // =========================================================================
  console.log('\n=== 3) app.json：不再注册零使用的组件 ===')
  // =========================================================================
  const appJson = JSON.parse(src('app.json'))
  const comps = appJson.usingComponents || {}
  check('已移除 van-dialog', comps['van-dialog'] === undefined)
  check('已移除 van-datetime-picker', comps['van-datetime-picker'] === undefined)
  check('仍在用的组件没有被误删（van-notice-bar / shop-map 等）',
    !!comps['van-notice-bar'] && !!comps['shop-map'] && !!comps['van-popup'])
  // 全局注册的组件名必须能在某个 wxml 里找到
  // （bind-mobile 单独豁免：它是留给阶段 4.4「手机号快速验证」的，见 shop-config 注释）
  const wxmlAll = walk('.', [])
    .filter((f) => f.endsWith('.wxml'))
    .map((f) => src(f)).join('\n')
  const unused = Object.keys(comps).filter((name) =>
    name !== 'bind-mobile' && !new RegExp('<' + name + '(?=[\\s/>])').test(wxmlAll)
  )
  check('注册的组件（bind-mobile 除外）都真的被用到', unused.length === 0, unused)

  // =========================================================================
  console.log('\n=== 4) 图片资源 ===')
  // =========================================================================
  check('零引用的 icon-font-solid.png 已归档', !exists('images/icon-font-solid.png'))
  check('零引用的 icon-font-solid@2x.png 已归档', !exists('images/icon-font-solid@2x.png'))
  check('轮播图换新后零引用的 rectangle@2x.png 已归档',
    !exists('images/rectangle@2x.png'))
  check('🎯 仍被种子数据/兜底引用的 logo@2x.png 没有被误删',
    exists('images/logo@2x.png'))
  check('已归档图片保留在 .trash-cleanup 里（可 1:1 还原）',
    fs.existsSync(path.join(ROOT, '..', '.trash-cleanup/20261012-1930/01__icon-font-solid.png')) &&
    fs.existsSync(path.join(ROOT, '..', '.trash-cleanup/20261012-1930/ROLLBACK.md')) &&
    fs.existsSync(path.join(ROOT, '..', '.trash-cleanup/20261012-2100/01__rectangle@2x.png')) &&
    fs.existsSync(path.join(ROOT, '..', '.trash-cleanup/20261012-2100/ROLLBACK.md')))

  // ★ 通用守卫：images/ 下每个文件都必须被别处引用
  //   为什么要有这条：报告 §4.3 的"未引用图片"就是这样产生的 —— 图片一旦失去最后一个引用方
  //   就只会白占主包体积（2 MB 上限），而没有任何报错。原来的断言只盯着两三个文件名，
  //   换一次轮播图就漏掉了 rectangle@2x.png，因此改成机械全量扫描。
  const imgFiles = []
  ;(function collectImgs(d) {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) collectImgs(p)
      else imgFiles.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  })('images')
  const texFiles = walk('.', []).filter((f) => /\.(js|json|jsonl|wxml|wxss|md)$/.test(f) && !/^tests\//.test(f))
  const texAll = texFiles.map((f) => src(f)).join('\n')
  const deadImages = imgFiles.filter((p) => {
    if (/README/i.test(p)) return false
    return texAll.indexOf(path.basename(p)) < 0
  })
  check('★ images/ 下每个图片都被引用（' + (imgFiles.length - 1) + ' 张，零引用即失败）',
    deadImages.length === 0, deadImages)
  check('被扫描的文本文件数量合理（防止扫描写坏导致恒真）', texFiles.length >= 40, texFiles.length)

  // =========================================================================
  console.log('\n=== 5) 样式：不再重复 app.wxss 的 page 声明 ===')
  // =========================================================================
  const appWxss = src('app.wxss')
  check('app.wxss 保留全局 page 背景', /page\s*\{[^}]*background-color:\s*#f5f5f5/.test(appWxss))
  const dupPageBg = []
  for (const f of walk('pages', [])) {
    if (!f.endsWith('.wxss')) continue
    const m = code(src(f)).match(/page\s*\{([^}]*)\}/)
    if (m && /background-color:\s*#f5f5f5/.test(m[1]) && !/position/.test(m[1])) dupPageBg.push(f)
  }
  check('★ 页面 wxss 不再重复声明与 app.wxss 相同的 page 背景',
    dupPageBg.length === 0, dupPageBg)
  check('需要 position: relative 的页面仍保留自己的 page 规则（不能被一起删掉）',
    /page\s*\{[^}]*position:\s*relative/.test(src('pages/pay/index.wxss')))

  // =========================================================================
  console.log('\n=== 6) 文档与代码一致（报告 E-07）===')
  // =========================================================================
  // 6.1 接线页面数
  const wiredPages = walk('pages', [])
    .filter((f) => f.endsWith('.js') && /require\(['"][^'"]*api-map['"]\)/.test(src(f)))
  const readme = src('cloudfunctions/README.md')
  const claimed = /实际接线为\s*\*\*(\d+)\s*个页面\*\*/.exec(readme)
  check('★ README 写明了接线页面数', !!claimed, readme.match(/实际接线[^\n]*/))
  check('★ README 的页面数 = 代码里实际 require api-map 的页面数',
    !!claimed && Number(claimed[1]) === wiredPages.length,
    { readme: claimed && claimed[1], actual: wiredPages.length, pages: wiredPages })
  check('README 不再把「13 个页面」当作当前事实陈述', !/实际接线为\s*13\s*个页面/.test(readme))

  // 6.2 公开 action 数
  const handlers = require('../cloudfunctions/api/handlers')
  const actionCount = Object.keys(handlers.handlers || {}).length
  const actionClaim = /可调用的 action 共\s*(\d+)\s*个/.exec(readme)
  check('★ README 的公开 action 数 = handlers 路由表实际条数',
    !!actionClaim && Number(actionClaim[1]) === actionCount,
    { readme: actionClaim && actionClaim[1], actual: actionCount })
  check('importData 不在公开路由表里（阶段二安全修复不能被退回去）',
    handlers.handlers.importData === undefined && typeof handlers.importData === 'function')
  check('docs/云开发初始化清单.md 的 action 数字与代码一致',
    new RegExp('\\*\\*' + actionCount + ' 个公开 action\\*\\*').test(src('docs/云开发初始化清单.md')),
    src('docs/云开发初始化清单.md').match(/云函数[^\n]*action[^\n]*/))

  // 6.3 分类数与清单条数
  const catRows = src('cloud-data/categories.jsonl').trim().split(/\r?\n/)
    .map((l) => JSON.parse(l))
  const catNames = catRows.map((r) => r.name)
  const dataReadme = src('cloud-data/README.md')
  check('cloud-data/README.md 写的分类数 = categories.jsonl 实际条数',
    new RegExp('\\*\\*' + catRows.length + ' 个分类的导入模板\\*\\*').test(dataReadme),
    { actual: catRows.length })
  check('不再残留「25 个分类名」的旧数字', dataReadme.indexOf('25 个分类名') < 0)
  const listBlock = (dataReadme.match(/```([\s\S]*?)```/) || [, ''])[1]
  // 清单按行折行，分隔符是 `·`，**换行本身也是分隔符**（一行的最后一项与下一行的
  // 第一项之间没有 `·`）。所以先把换行也换成 `·` 再切分。
  const listed = listBlock.replace(/\r?\n/g, '·').split('·').map((s) => s.trim()).filter(Boolean)
  check('★ README 里逐个列出的分类数与 jsonl 一致', listed.length === catNames.length,
    { listed: listed.length, jsonl: catNames.length })
  const missingInDoc = catNames.filter((n) => listed.indexOf(n) < 0)
  check('★ README 的分类清单没有漏项', missingInDoc.length === 0, missingInDoc)

  // 6.4 规格字段名 price → priceDelta
  const schema = src('cloud-data/02-schema-goods.js')
  check('★ 商品字段示例不再使用失效的 `price` 字段名',
    !/childsCurGoods:\s*\[[\s\S]{0,400}?\{[^}]*\bprice\s*:/.test(schema))
  check('商品字段示例使用 priceDelta', /priceDelta:\s*\d+/.test(schema))

  // 6.5 配置副本的自指注释
  check('云函数配送配置的副本说明指向主包文件（不再自己指自己）',
    /本文件与主包的\s*`config\/delivery\.js`/.test(src('cloudfunctions/api/delivery-config.js')))
  check('云函数配送计算的副本说明指向 utils/delivery-range.js',
    /与主包的\s*`utils\/delivery-range\.js`/.test(src('cloudfunctions/api/delivery-calc.js')))

  // 6.6 地址页提示与校验一致
  check('地址页提示不再说「省市区与详细地址至少填其一」（与 onSave 矛盾）',
    stripAll(src('pages/address/edit.wxml')).indexOf('至少填其一') < 0)
  check('地址页提示写明详细地址必填',
    /详细地址为必填/.test(src('pages/address/edit.wxml')))

  // 6.7 代码/文档里引用的测试文件必须真的存在
  // （阶段 5 初稿的注释里写过 tests/test-shop-name.js —— 那个文件根本不存在，
  //   与 E-07「文档与代码不符」是同一类问题，这里用机械检查兜住。）
  const testRefs = new Set()
  for (const f of walk('.', [])) {
    if (!/\.(js|md|json)$/.test(f)) continue
    if (/^(tests|node_modules|miniprogram_npm)\//.test(f)) continue
    const re = /tests\/test-[A-Za-z0-9_-]+\.js/g
    let m
    const t = src(f)
    while ((m = re.exec(t))) testRefs.add(m[0])
  }
  const danglingRefs = [...testRefs].filter((r) => !fs.existsSync(path.join(ROOT, r)))
  check('★ 代码/文档里引用的 tests/*.js 都真实存在（扫到 ' + testRefs.size + ' 个引用）',
    danglingRefs.length === 0, danglingRefs)
  check('该检查确实扫到了内容（防止正则写错导致恒真）', testRefs.size >= 5, testRefs.size)

  // 6.8 门店名/营业时间不再有页面级字面量兜底（D-06 同族）
  // 注意剥掉注释：注释里解释"原来写的是什么"是允许的。
  check('页面 wxml 里不再有硬编码店名兜底',
    !/shop\.name \|\| '卿欢蛋糕'/.test(stripAll(src('pages/index/index.wxml'))) &&
    !/shopInfo\.name \|\| '卿欢蛋糕'/.test(stripAll(src('pages/orders/index.wxml'))) &&
    !/shopInfo\.name \|\| '卿欢蛋糕'/.test(stripAll(src('pages/pay/index.wxml'))))
  check('页面 wxml 里不再有与配置不符的营业时间兜底 08:00-20:00',
    !/08:00-20:00/.test(stripAll(src('pages/index/index.wxml'))) &&
    !/08:00-20:00/.test(stripAll(src('pages/orders/index.wxml'))))

  // =========================================================================
  console.log('\n=== 7) 结构守卫：页面代码能编译、wxml 标签配对 ===')
  // =========================================================================
  // 阶段 5 大范围改了页面文件（含把 order-view/index.wxml 整个包了一层状态分支），
  // 这里做两道低成本的机械检查，防止"手滑写坏一个括号/标签"这类白屏级事故。
  const vm = require('vm')
  const jsFiles = walk('pages', []).concat(walk('utils', [])).filter((f) => f.endsWith('.js'))
  const brokenJs = []
  for (const f of jsFiles) {
    try {
      new vm.Script(src(f), { filename: f })
    } catch (e) {
      brokenJs.push(f + ' :: ' + e.message)
    }
  }
  check('★ 所有页面/utils 的 js 都能编译（' + jsFiles.length + ' 个文件）',
    brokenJs.length === 0, brokenJs)

  const VOID_TAGS = new Set(['image', 'input', 'icon', 'import', 'include', 'wxs', 'template', 'br', 'hr'])
  const wxmlFiles = walk('.', []).filter((f) => f.endsWith('.wxml'))
  const brokenWxml = []
  for (const f of wxmlFiles) {
    const t = stripAll(src(f)).replace(/<!--[\s\S]*?-->/g, '')
    const stack = []
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
    let m
    let err = null
    while ((m = re.exec(t))) {
      if (m[4] === '/' || VOID_TAGS.has(m[2])) continue
      if (m[1] !== '/') stack.push(m[2])
      else if (stack.pop() !== m[2]) { err = '意外闭合 </' + m[2] + '>'; break }
    }
    if (!err && stack.length) err = '未闭合：' + stack.join(',')
    if (err) brokenWxml.push(f + ' :: ' + err)
  }
  check('★ 所有 wxml 标签配对正常（' + wxmlFiles.length + ' 个文件）',
    brokenWxml.length === 0, brokenWxml)

  // wxml 里绑定的事件处理函数必须在同目录的 js 里真的有实现
  // （阶段 5 新增了 retryLoad / onChooseAvatar / saveProfile 等处理函数，绑错名字就是点了没反应）
  const missingHandlers = []
  for (const wxml of walk('pages', []).filter((f) => f.endsWith('.wxml'))) {
    const js = wxml.replace(/\.wxml$/, '.js')
    if (!exists(js)) continue
    const tpl = src(wxml).replace(/<!--[\s\S]*?-->/g, '')
    const jsCode = src(js)
    const names = new Set()
    const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g
    let m
    while ((m = re.exec(tpl))) names.add(m[2].trim())
    for (const n of names) {
      const declared =
        new RegExp('(^|[\\s,{])' + n + '\\s*[:(]').test(jsCode) ||
        new RegExp('["\']' + n + '["\']\\s*:').test(jsCode)
      if (!declared) missingHandlers.push(wxml + ' → ' + n)
    }
  }
  check('★ wxml 绑定的事件处理函数都在 js 里有实现',
    missingHandlers.length === 0, missingHandlers)

  // wxml 里用到的**顶层 data 字段**必须在 data 中声明
  // （本项目约定：未声明时首帧渲染读到的是 undefined，容易出现空的「¥」「共 件商品」。
  //   复核整改时发现 5 处，这里把它变成机械检查。）
  const TEMPLATE_LOCALS = new Set(['item', 'index', 'group', 'gi', 'oi', 'opt', 'goods', 'true', 'false', 'null', 'undefined'])
  const missingFields = []
  for (const wxml of walk('pages', []).filter((f) => f.endsWith('.wxml'))) {
    const js = wxml.replace(/\.wxml$/, '.js')
    if (!exists(js)) continue
    const tpl = stripAll(src(wxml))
    const jsSrc = src(js)
    const dataBlock = (jsSrc.match(/\n {2}data:\s*\{([\s\S]*?)\n {2}\},/) || ['', ''])[1]
    const declared = new Set()
    dataBlock.split(/\r?\n/).forEach((l) => {
      const m = l.match(/^\s{4}([A-Za-z_$][\w$]*)\s*:/)
      if (m) declared.add(m[1])
    })
    const used = new Set()
    const re = /\{\{([\s\S]*?)\}\}/g
    let m
    while ((m = re.exec(tpl))) {
      let expr = m[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
      expr = expr.replace(/\.\s*[A-Za-z_$][\w$]*/g, '')  // 去掉属性访问（item.price → item）
      expr = expr.replace(/[A-Za-z_$][\w$]*\s*:/g, '')   // 去掉对象字面量的键（template data）
      const ids = expr.match(/[A-Za-z_$][\w$]*/g) || []
      ids.forEach((id) => { if (!TEMPLATE_LOCALS.has(id)) used.add(id) })
    }
    const miss = [...used].filter((u) => !declared.has(u))
    if (miss.length) missingFields.push(wxml + ' → ' + miss.join(', '))
  }
  check('★ wxml 用到的顶层 data 字段都在 data 里声明',
    missingFields.length === 0, missingFields)

  console.log('\n' + '='.repeat(60))
  console.log((fail === 0 ? '全部通过' : '存在失败') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main()
