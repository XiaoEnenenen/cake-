// 地址工具行为测试（用完可删）
global.wx = {
  _s: {},
  getStorageSync(k) { return this._s[k] },
  setStorageSync(k, v) { this._s[k] = v }
}
const ADDR = require('../utils/address')

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

console.log('=== 1) 初始状态 ===')
check('初始列表为空', ADDR.getList().length === 0)
check('初始无默认地址', ADDR.getDefault() === null)

console.log('\n=== 2) 新增 ===')
const a1 = ADDR.save({ name: '张三', phone: '13800138000', detail: '万辉小区1栋101' })
check('新增成功', !!a1.id, a1)
check('第一条自动设为默认', a1.isDefault === true)
check('列表长度 1', ADDR.getList().length === 1)

const a2 = ADDR.save({ name: '李四', phone: '13900139000', detail: '太平新城2栋202', tag: '公司' })
check('第二条新增成功', !!a2.id)
check('第二条不是默认', a2.isDefault === false)
check('默认仍是第一条', ADDR.getDefault().id === a1.id)

console.log('\n=== 3) 手机号校验 ===')
check('合法 138xxxx', ADDR.isValidPhone('13800138000') === true)
check('非法 123', ADDR.isValidPhone('123') === false)
check('非法字母', ADDR.isValidPhone('abcdefghijk') === false)
check('空值', ADDR.isValidPhone('') === false)
check('带空格仍合法', ADDR.isValidPhone(' 13800138000 ') === true)

console.log('\n=== 4) 编辑 ===')
ADDR.save({ id: a2.id, name: '李四四', phone: '13900139000', detail: '改过的地址' })
const edited = ADDR.getById(a2.id)
check('名称已更新', edited.name === '李四四', edited.name)
check('地址已更新', edited.detail === '改过的地址')
check('编辑不改变 id', edited.id === a2.id)
check('编辑后总数仍为 2', ADDR.getList().length === 2)

console.log('\n=== 5) 设为默认 ===')
ADDR.setDefault(a2.id)
check('默认切到第二条', ADDR.getDefault().id === a2.id)
check('第一条不再默认', ADDR.getById(a1.id).isDefault === false)
check('同时只有一个默认', ADDR.getList().filter((x) => x.isDefault).length === 1)

console.log('\n=== 6) 列表排序（默认优先）===')
const sorted = ADDR.getList()
check('默认地址排在首位', sorted[0].id === a2.id, sorted.map((x) => x.name))

console.log('\n=== 7) 删除默认地址后自动补默认（边界）===')
ADDR.remove(a2.id)
check('删除成功，剩 1 条', ADDR.getList().length === 1)
check('删除默认后自动补默认', ADDR.getDefault() !== null && ADDR.getDefault().id === a1.id, ADDR.getDefault())

console.log('\n=== 8) 删空 ===')
ADDR.remove(a1.id)
check('删空后列表为空', ADDR.getList().length === 0)
check('删空后无默认', ADDR.getDefault() === null)

console.log('\n=== 9) 地址格式化 ===')
const full = ADDR.formatFull({ province: '云南省', city: '昆明市', district: '安宁市', detail: '某小区1栋' })
check('拼接完整地址', full === '云南省昆明市安宁市某小区1栋', full)
check('缺字段不报错', ADDR.formatFull({ detail: '只有详细' }) === '只有详细')
check('null 安全', ADDR.formatFull(null) === '')

console.log('\n=== 10) 编辑不存在的地址应报错 ===')
let threw = false
try { ADDR.save({ id: 'not_exist', name: 'x', detail: 'y' }) } catch (e) { threw = true }
check('编辑不存在地址抛错', threw)

console.log('\n=== 11) 店铺地址与用户地址互不干扰（关键风险点）===')
global.wx._s = {}
const SHOP = require('../shop-config')
ADDR.save({ name: '王五', phone: '13700137000', detail: '用户自己的地址' })
check('用户地址存在', ADDR.getList().length === 1)
check('门店地址不受影响', SHOP.shop.address.indexOf('万辉西山田园') >= 0, SHOP.shop.address)
check('两者内容不同', ADDR.getList()[0].detail !== SHOP.shop.address)
check('门店地址不在用户地址簿里', ADDR.getList().every((a) => a.detail !== SHOP.shop.address))

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' / 失败 ' + fail)
if (fail) process.exitCode = 1
