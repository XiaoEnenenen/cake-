/**
 * 多规格改造验证（用完可删）
 * ---------------------------------------------------------------------------
 * 重点验证原项目的「串位」bug 是否修复：
 *   原来只比对 sku[0]，导致「4寸+草莓」和「4寸+巧克力」在购物车里被当成同一项。
 * ---------------------------------------------------------------------------
 */

// 复制 pages/goods-details/index.js 里的纯逻辑（与页面实现保持一致）
function buildPropertyGroups(properties) {
  if (!properties || !properties.length) return []
  return properties.map((group, gi) => {
    const pid = group.id !== undefined ? group.id : gi
    const options = (group.childsCurGoods || []).map((child, ci) => ({
      cid: child.id !== undefined ? child.id : ci,
      cname: child.name,
      priceDelta: typeof child.priceDelta === 'number' ? child.priceDelta : 0
    }))
    return { pid, pname: group.name, options }
  }).filter((g) => g.options.length > 0)
}

function buildSku(propertyGroups, selectedIndices) {
  const sku = []
  propertyGroups.forEach((group, gi) => {
    const opt = group.options[selectedIndices[gi]]
    if (opt) sku.push({ optionId: group.pid, optionValueId: opt.cid })
  })
  return sku
}

function isSameSku(a, b) {
  const norm = (arr) => (arr || [])
    .map((s) => String(s.optionId) + ':' + String(s.optionValueId))
    .sort()
    .join(',')
  return norm(a) === norm(b)
}

// 云端购物车 key 生成逻辑（来自 cloudfunctions/api/handlers.js）
function makeCartKey(goodsId, sku) {
  const parts = (sku || []).map((s) => String(s.optionId) + ':' + String(s.optionValueId)).sort()
  return String(goodsId) + (parts.length ? '|' + parts.join(',') : '')
}

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// 模拟后端返回的两组规格
const backendProperties = [
  {
    id: 'size', name: '磅数',
    childsCurGoods: [
      { id: 's4', name: '4寸', priceDelta: 0 },
      { id: 's6', name: '6寸', priceDelta: 34 }
    ]
  },
  {
    id: 'flavor', name: '口味',
    childsCurGoods: [
      { id: 'f_straw', name: '草莓', priceDelta: 0 },
      { id: 'f_choco', name: '巧克力', priceDelta: 10 }
    ]
  }
]

console.log('=== 1) 规格组构建 ===')
const groups = buildPropertyGroups(backendProperties)
check('构建出 2 组（原实现只有 1 组）', groups.length === 2, groups.length)
check('第一组名 = 磅数', groups[0].pname === '磅数', groups[0].pname)
check('第一组有 2 个选项', groups[0].options.length === 2)
check('选项携带加价', groups[0].options[1].priceDelta === 34, groups[0].options[1])
check('选项 cid 正确', groups[0].options[1].cid === 's6')

console.log('\n=== 2) 后端不给 id 时的兜底 ===')
const noIdGroups = buildPropertyGroups([
  { name: '规格A', childsCurGoods: [{ name: 'x' }, { name: 'y' }] },
  { name: '规格B', childsCurGoods: [{ name: 'z' }] }
])
check('无 id 时用下标兜底', noIdGroups[0].pid === 0 && noIdGroups[1].pid === 1, noIdGroups.map(g => g.pid))
check('选项无 id 时用下标', noIdGroups[0].options[1].cid === 1)
check('空规格组被过滤', buildPropertyGroups([{ name: '空', childsCurGoods: [] }]).length === 0)

console.log('\n=== 3) sku 汇总（原实现只 push 一组）===')
const skuA = buildSku(groups, [1, 0]) // 6寸 + 草莓
check('sku 含 2 项', skuA.length === 2, skuA)
check('第一项 = size:s6', skuA[0].optionId === 'size' && skuA[0].optionValueId === 's6', skuA[0])
check('第二项 = flavor:f_straw', skuA[1].optionId === 'flavor' && skuA[1].optionValueId === 'f_straw', skuA[1])

console.log('\n=== 4) 串位 bug 修复验证（核心）===')
const skuStraw = buildSku(groups, [1, 0]) // 6寸 + 草莓
const skuChoco = buildSku(groups, [1, 1]) // 6寸 + 巧克力
check('同尺寸不同口味 → 判定为不同 sku', isSameSku(skuStraw, skuChoco) === false, { skuStraw, skuChoco })

// 旧实现的行为：只比 sku[0]，两者第一项相同 → 会被误判为同一项
const oldLogic = (a, b) => {
  const x = (a || [])[0], y = (b || [])[0]
  if (!x || !y) return false
  return x.optionId == y.optionId && x.optionValueId == y.optionValueId
}
check('旧逻辑确实会误判为相同（复现 bug）', oldLogic(skuStraw, skuChoco) === true)
check('新逻辑修正了该误判', isSameSku(skuStraw, skuChoco) === false)

check('相同 sku 判定为相同', isSameSku(skuStraw, buildSku(groups, [1, 0])) === true)
check('顺序不同仍判为相同', isSameSku([{ optionId: 'a', optionValueId: '1' }, { optionId: 'b', optionValueId: '2' }], [{ optionId: 'b', optionValueId: '2' }, { optionId: 'a', optionValueId: '1' }]) === true)
check('空 sku 相等', isSameSku([], []) === true)
check('空 vs 非空 不等', isSameSku([], skuStraw) === false)

console.log('\n=== 5) 云端购物车 key 与前端匹配一致 ===')
const keyStraw = makeCartKey('g1', skuStraw)
const keyChoco = makeCartKey('g1', skuChoco)
check('不同口味生成不同 key', keyStraw !== keyChoco, { keyStraw, keyChoco })
check('相同选择生成相同 key', keyStraw === makeCartKey('g1', buildSku(groups, [1, 0])))
check('key 含两组', keyStraw.indexOf('size:s6') >= 0 && keyStraw.indexOf('flavor:f_straw') >= 0, keyStraw)

console.log('\n=== 6) 价格计算（基础价 + 各组加价）===')
function calcPrice(goodsMinPrice, groups, selectedIndices) {
  let price = goodsMinPrice
  groups.forEach((g, gi) => {
    const opt = g.options[selectedIndices[gi]]
    if (opt) price += opt.priceDelta
  })
  return price
}
check('4寸+草莓 = 54', calcPrice(54, groups, [0, 0]) === 54)
check('6寸+草莓 = 88', calcPrice(54, groups, [1, 0]) === 88)
check('6寸+巧克力 = 98', calcPrice(54, groups, [1, 1]) === 98)

console.log('\n=== 7) 无规格商品 ===')
check('无规格时 groups 为空', buildPropertyGroups([]).length === 0)
check('无规格时 sku 为空', buildSku([], []).length === 0)
check('无规格 key 不含 |', makeCartKey('g9', []) === 'g9', makeCartKey('g9', []))

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' / 失败 ' + fail)
if (fail) process.exitCode = 1
