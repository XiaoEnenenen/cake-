#!/usr/bin/env node
/**
 * 真实商品录入工具
 * ---------------------------------------------------------------------------
 *   goods-real.source.json   （人写的源文件，字段友好：分类写名字、尺寸写绝对价）
 *            │  node cloud-data/tools/build-goods.js
 *            ▼
 *   goods-real.jsonl         （微信云开发控制台「导入」用的格式，每行一条）
 *
 * 为什么要有这一步，而不直接手写 jsonl：
 *   1) categoryId 必须是 category 集合里真实存在的 _id（写错 → 商品在分类下不显示，且不报错）；
 *   2) properties 里生效的是 priceDelta（加价），不是绝对价 —— 手写极容易把 6寸 128 直接写成
 *      priceDelta:128，结果最终价变成 minPrice+128（本店算法：最终价 = minPrice + 各选中项加价之和，
 *      见 cloudfunctions/api/handlers.js 的 calcPrice / getDelta）；
 *   3) pics 有两种历史写法（["url"] 与 [{pic:"url"}]），统一成 [{pic}] 与线上种子一致；
 *   4) 图片文件缺没缺、id 有没有重复、价格有没有算错，都能在这里一次性查出来。
 *
 * 用法：
 *   node cloud-data/tools/build-goods.js            # 校验 + 生成 goods-real.jsonl
 *   node cloud-data/tools/build-goods.js --check    # 只校验，不写文件
 * ---------------------------------------------------------------------------
 */
'use strict'

const fs = require('fs')
const path = require('path')

const CD = path.resolve(__dirname, '..') // bread-main/cloud-data
const ROOT = path.resolve(CD, '..') // bread-main
const SRC = path.join(CD, 'goods-real.source.json')
const OUT = path.join(CD, 'goods-real.jsonl')
const CATEGORIES = path.join(CD, 'categories.jsonl')
const IMG_DIR = path.join(ROOT, 'images', 'goods')
const FALLBACK_PIC = '/images/logo@2x.png'
// 默认：图片打进小程序包（开发期用）。改成云存储见 toPics 注释与 tools/README.md
const LOCAL_IMAGE_BASE = '/images/goods/'
const isCloudBase = (b) => /^cloud:/i.test(String(b || ''))

const errors = []
const warnings = []
const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        err(path.basename(file) + ' 第 ' + (i + 1) + ' 行不是合法 JSON：' + e.message)
        return null
      }
    })
    .filter(Boolean)
}

/** 确定性短哈希：只依赖名字，插入/删除其它商品不会改变已有 id */
function shortHash(s) {
  let h = 2166136261
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).slice(0, 6)
}

/** 常见口味 → 可读的选项 id（与线上种子 f_strawberry / f_chocolate 同一套命名） */
const FLAVOR_IDS = {
  原味: 'original', 巧克力: 'chocolate', 草莓: 'strawberry', 芒果: 'mango', 抹茶: 'matcha',
  榴莲: 'durian', 芋泥: 'taro', 蓝莓: 'blueberry', 奥利奥: 'oreo', 咖啡: 'coffee',
  香草: 'vanilla', 百香果: 'passionfruit', 提拉米苏: 'tiramisu', 荔枝: 'lychee',
  水蜜桃: 'peach', 桃子: 'peach', 柠檬: 'lemon', 栗子: 'chestnut', 榛果: 'hazelnut',
  酸奶: 'yogurt', 焦糖: 'caramel', 芝士: 'cheese', 海盐: 'seasalt', 玫瑰: 'rose',
  桂花: 'osmanthus', 红豆: 'redbean', 椰香: 'coconut', 椰子: 'coconut', 香蕉: 'banana',
  车厘子: 'cherry', 樱桃: 'cherry', 青提: 'grape', 葡萄: 'grape', 猕猴桃: 'kiwi',
  火龙果: 'dragonfruit', 无花果: 'fig', 开心果: 'pistachio', 栗蓉: 'chestnutpaste'
}

/** 尺寸/口味选项 id：显式 id > 口味词典 > 名字里的数字（6寸→s6）> 短哈希 */
function optionId(prefix, name, explicit) {
  if (explicit) return String(explicit)
  if (prefix === 'f' && FLAVOR_IDS[name]) return 'f_' + FLAVOR_IDS[name]
  const digits = String(name).match(/\d+/g)
  if (digits && digits.length) return prefix + digits.join('')
  return prefix + '_' + shortHash(name)
}

/** 纯文本详情 → 富文本 HTML；已经是 HTML 就原样保留 */
function toHtml(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return ''
  // 只有「以标签开头」才当成已格式化 HTML —— 不能用「包含 <...>」判断：
  // 详情文字里正常写 "<p>" 三个字也会被误判，于是整段不转义直接塞进 parser
  if (/^<[a-z!/]/i.test(s)) return s
  return s
    .split(/\n\s*\n/)
    .map((p) => '<p>' + p.trim().replace(/\n/g, '<br/>') + '</p>')
    .join('')
}

/**
 * 图片字段 → 详情页轮播用的 pics 数组（统一 [{pic}] 写法）
 *
 * @param images 源文件里的文件名数组
 * @param imageBase 图片前缀（见源文件顶层 imageBase）：
 *   - 不写（默认）= '/images/goods/'  → 图片打进小程序包，受主包 2MB 限制，改图要重新提审
 *   - 'cloud://<环境ID>.<bucket>/goods/' → 图片放云存储，不受主包限制，改图不用重新提审
 *   两种模式切换只需改源文件里那一行，商品条目一个字都不用动。
 */
function toPics(images, imageBase) {
  const base = imageBase || LOCAL_IMAGE_BASE
  const isLocal = base.charAt(0) === '/'
  const list = (Array.isArray(images) ? images : images ? [images] : [])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean)
  if (!list.length) return [{ pic: FALLBACK_PIC }]
  return list.map((v) => {
    // 完整外链 / 云存储 fileID / 已带路径的，原样使用
    if (/^(https?:|cloud:|wxfile:|\/)/i.test(v)) return { pic: v }
    // 只写文件名 → 拼上当前托管方式的前缀
    if (isLocal) {
      const abs = path.join(IMG_DIR, v)
      if (!fs.existsSync(abs)) {
        warn('图片不存在：images/goods/' + v + '（导入后该图会 404，先补图再重跑）')
      }
    }
    return { pic: base.replace(/\/?$/, '/') + v }
  })
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN
}
const money = (n) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0

  if (!fs.existsSync(SRC)) {
    console.error('找不到源文件：' + path.relative(process.cwd(), SRC))
    process.exit(1)
  }

  // ---- 分类映射 ----
  const cats = readJsonl(CATEGORIES)
  const catByName = {}
  const catById = {}
  cats.forEach((c) => {
    catByName[c.name] = c._id
    catById[c._id] = c.name
  })

  // ---- 读源文件 ----
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  } catch (e) {
    console.error('goods-real.source.json 不是合法 JSON：' + e.message)
    process.exit(1)
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.goods) || []
  if (!list.length) {
    console.error('源文件里没有商品（goods 数组为空）。')
    process.exit(1)
  }
  // 图片托管方式：源文件顶层 imageBase（不写 = 打进小程序包）
  const imageBase = Array.isArray(raw) ? '' : String((raw && raw.imageBase) || '').trim()
  if (imageBase && imageBase.charAt(0) !== '/' && !isCloudBase(imageBase) && !/^https?:/i.test(imageBase)) {
    err('imageBase 只支持以 / 开头的本地路径、cloud:// 云存储前缀或 https:// 外链，当前是：' + imageBase)
  }
  const cloudHosting = isCloudBase(imageBase)

  // ---- 逐条构建 ----
  const records = []
  const seenIds = {}

  list.forEach((g, i) => {
    const at = '第 ' + (i + 1) + ' 个商品' + (g && g.name ? '「' + g.name + '」' : '')
    if (!g || typeof g !== 'object') return err(at + '：不是对象')
    if (!g.name || !String(g.name).trim()) return err(at + '：缺少 name')

    const name = String(g.name).trim()

    // id
    const id = g.id
      ? String(g.id).trim()
      : 'g_real_' + shortHash(name)
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      err(at + '：id「' + id + '」只能包含字母/数字/下划线/中划线')
    }
    if (seenIds[id]) err(at + '：id 与「' + seenIds[id] + '」重复（' + id + '）')
    seenIds[id] = name

    // 分类：接受分类名，也接受 cat_ 开头的 _id
    let categoryId = ''
    const cRaw = g.category == null ? '' : String(g.category).trim()
    if (!cRaw) {
      err(at + '：缺少 category（所属分类）')
    } else if (catById[cRaw]) {
      categoryId = cRaw
    } else if (catByName[cRaw]) {
      categoryId = catByName[cRaw]
    } else {
      err(
        at +
          '：分类「' +
          cRaw +
          '」不在 categories.jsonl 里。可选：' +
          Object.keys(catByName).join(' / ')
      )
    }

    // 规格：sizes = 绝对价（如 6寸 128），flavors = 加价
    const sizes = Array.isArray(g.sizes) ? g.sizes.filter(Boolean) : []
    const flavors = Array.isArray(g.flavors) ? g.flavors.filter(Boolean) : []

    let minPrice = NaN
    const sizeOpts = []

    if (sizes.length) {
      const prices = []
      const seenSizeNames = {}
      sizes.forEach((s, si) => {
        const sname = s && s.name != null ? String(s.name).trim() : ''
        const price = num(s && s.price)
        const sat = at + ' 的第 ' + (si + 1) + ' 个尺寸'
        if (!sname) return err(sat + '：缺少 name')
        if (seenSizeNames[sname]) err(sat + '：尺寸名「' + sname + '」重复')
        seenSizeNames[sname] = 1
        if (!(price > 0)) return err(sat + '（' + sname + '）：price 必须是大于 0 的数字')
        prices.push(price)
        sizeOpts.push({ name: sname, price, id: optionId('s', sname, s.id) })
      })
      minPrice = money(Math.min.apply(null, prices))
      // priceDelta = 该规格绝对价 - 最低价（最低价那个选项加价为 0）
      sizeOpts.forEach((o) => {
        o.priceDelta = money(o.price - minPrice)
      })
    }

    if (!sizes.length) {
      const p = num(g.price)
      if (!(p > 0)) {
        err(at + '：既没有 sizes（磅数规格），也没有 price —— 至少给一个单价')
      } else {
        minPrice = money(p)
      }
    }

    const flavorOpts = flavors.map((f, fi) => {
      const fname = f && f.name != null ? String(f.name).trim() : ''
      const fat = at + ' 的第 ' + (fi + 1) + ' 个口味'
      if (!fname) {
        err(fat + '：缺少 name')
        return null
      }
      const delta = f.delta == null ? 0 : num(f.delta)
      if (!Number.isFinite(delta)) {
        err(fat + '（' + fname + '）：delta 必须是数字')
        return null
      }
      if (delta < 0) warn(at + '：口味「' + fname + '」是负加价（' + delta + '），确认是有意为之')
      return { id: optionId('f', fname, f.id), name: fname, priceDelta: money(delta) }
    })
    const flavorOk = flavorOpts.filter(Boolean)

    // 规格组
    const properties = []
    if (sizeOpts.length) {
      properties.push({
        id: 'size',
        name: g.sizeGroupName ? String(g.sizeGroupName) : '磅数',
        childsCurGoods: sizeOpts.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta }))
      })
    }
    if (flavorOk.length) {
      properties.push({ id: 'flavor', name: '口味', childsCurGoods: flavorOk })
    }
    // 规格组内部 id 唯一性（同名尺寸/口味会撞 id）
    properties.forEach((grp) => {
      const seen = {}
      grp.childsCurGoods.forEach((o) => {
        if (seen[o.id]) err(at + '：' + grp.name + ' 的选项 id「' + o.id + '」重复（选项名重名？）')
        seen[o.id] = 1
      })
    })

    const pics = toPics(g.images || g.pics, imageBase)
    // 有「磅数」规格 = 蛋糕（配送规则据此算免配送费/提前 3 小时，见 handlers.js 的 isCakeGoods）
    const isCake = typeof g.isCake === 'boolean' ? g.isCake : sizeOpts.length > 0

    records.push({
      _id: id,
      categoryId,
      name,
      pic: pics[0].pic,
      pics,
      characteristic: g.characteristic ? String(g.characteristic).trim() : '',
      content: toHtml(g.content || g.detail || ''),
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
      unit: g.unit ? String(g.unit) : '个',
      purchaseNotes: g.purchaseNotes ? String(g.purchaseNotes).trim() : '',
      sort: Number.isFinite(num(g.sort)) ? num(g.sort) : 10,
      enabled: g.enabled === false ? false : true,
      isCake: !!isCake,
      properties
    })
  })

  // ---- 图片体积（只在「图片打进小程序包」时才需要关心主包 2MB 限制）----
  if (!cloudHosting && fs.existsSync(IMG_DIR)) {
    let bytes = 0
    let n = 0
    fs.readdirSync(IMG_DIR).forEach((f) => {
      const st = fs.statSync(path.join(IMG_DIR, f))
      if (st.isFile()) {
        bytes += st.size
        n++
      }
    })
    if (n && bytes > 1.5 * 1024 * 1024) {
      warn(
        'images/goods/ 已有 ' +
          n +
          ' 个文件、共 ' +
          (bytes / 1024 / 1024).toFixed(2) +
          ' MB，接近小程序主包 2MB 上限；建议改用云存储（在源文件顶层加 imageBase）'
      )
    }
  }

  // ---- 报告 ----
  console.log('')
  console.log('商品录入校验 ' + path.relative(process.cwd(), SRC))
  console.log('─'.repeat(72))
  records.forEach((r) => {
    const cat = catById[r.categoryId] || '❓' + r.categoryId
    const sizeTxt = r.properties.length
      ? r.properties
          .map(
            (grp) =>
              grp.name +
              '(' +
              grp.childsCurGoods.map((o) => o.name + (o.priceDelta ? '+' + o.priceDelta : '')).join('/') +
              ')'
          )
          .join(' ')
      : '无规格'
    console.log(
      '  ' +
        r._id.padEnd(24) +
        ' ' +
        cat.padEnd(10) +
        ' ￥' +
        String(r.minPrice).padEnd(6) +
        ' ' +
        r.pics.length +
        '图  ' +
        sizeTxt
    )
  })
  console.log('─'.repeat(72))
  console.log('共 ' + records.length + ' 个商品')
  console.log(
    '图片托管：' +
      (cloudHosting
        ? '云存储 ' + imageBase + '（不受主包 2MB 限制，改图无需重新提审）'
        : imageBase
          ? '小程序包 ' + imageBase + '（占主包体积，改图要重新提审）'
          : '小程序包 /images/goods/（默认，占主包体积，改图要重新提审）')
  )

  warnings.forEach((w) => console.log('  ⚠ ' + w))
  if (errors.length) {
    console.log('')
    errors.forEach((e) => console.log('  ✗ ' + e))
    console.log('')
    console.log('校验不通过（' + errors.length + ' 个错误），未生成文件。')
    process.exit(1)
  }

  if (checkOnly) {
    console.log('  ✓ 校验通过（--check，未写文件）')
    return
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  // 回读一次，确保生成物每行都能解析（导入失败最常见的坑）
  jsonl
    .split('\n')
    .filter(Boolean)
    .forEach((l, i) => {
      try {
        JSON.parse(l)
      } catch (e) {
        err('生成物第 ' + (i + 1) + ' 行无法解析：' + e.message)
      }
    })
  if (errors.length) {
    errors.forEach((e) => console.log('  ✗ ' + e))
    process.exit(1)
  }

  fs.writeFileSync(OUT, jsonl, 'utf8')
  console.log('  ✓ 已写入 ' + path.relative(process.cwd(), OUT) + '（' + records.length + ' 行，UTF-8）')

  // 同一个内容再存一份 .json：微信云开发控制台的「导入」文件选择框只认 .json / .csv，
  // .jsonl 可能不出现在列表里。内容完全一致（每行一个 JSON 对象 = JSON Lines），
  // 只是换个扩展名，免得你在导入那一步卡住。
  const OUT_JSON = OUT.replace(/\.jsonl$/, '.json')
  fs.writeFileSync(OUT_JSON, jsonl, 'utf8')
  console.log('  ✓ 已写入 ' + path.relative(process.cwd(), OUT_JSON) + '（同内容，给控制台导入用）')

  console.log('')
  console.log('下一步：微信开发者工具 → 云开发 → 数据库 → goods 集合 → 导入')
  console.log('        文件选 goods-real.json，冲突处理选「upsert」')
}

main()
