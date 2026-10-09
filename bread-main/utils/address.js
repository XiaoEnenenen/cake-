/**
 * 收货地址管理
 * ---------------------------------------------------------------------------
 * 当前阶段：数据存在 wx.setStorageSync('addressList')，纯本地。
 *           用于跑通「增删改查 + 选默认 + 下单时选用」的完整逻辑。
 *
 * 后续阶段：切换为微信云开发时，只需改本文件内部的实现，
 *           对外的函数签名与返回结构保持不变，调用方无需改动。
 *           云端对应集合：address（按 _openid 隔离）
 *
 * ⚠️ 重要区分：
 *   本文件只管「顾客的收货地址」。
 *   「门店自己的地址」在 shop-config.js 的 shop.address，两者互不引用。
 * ---------------------------------------------------------------------------
 */

const STORAGE_KEY = 'addressList'

/**
 * 生成一个本地 id。
 * 说明：本地阶段用时间戳+随机数，云端阶段会换成云数据库的 _id。
 */
function makeId() {
  return 'addr_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
}

/**
 * 读取全部地址（按默认地址优先、其余按创建时间倒序）
 * @returns {Array}
 */
function getList() {
  const list = wx.getStorageSync(STORAGE_KEY) || []
  return list.slice().sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1
    if (!a.isDefault && b.isDefault) return 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function saveList(list) {
  wx.setStorageSync(STORAGE_KEY, list)
  return list
}

/**
 * 取单个地址
 */
function getById(id) {
  return getList().find((a) => a.id === id) || null
}

/**
 * 取默认地址。没有默认地址时返回列表第一个（方便下单页直接带出）。
 */
function getDefault() {
  const list = getList()
  if (!list.length) return null
  return list.find((a) => a.isDefault) || list[0]
}

/**
 * 新增或更新地址
 * @param {object} data 地址数据；带 id 则为更新
 * @returns {object} 保存后的地址
 */
function save(data) {
  const list = getList()
  const now = Date.now()

  if (data.id) {
    const idx = list.findIndex((a) => a.id === data.id)
    if (idx === -1) {
      throw new Error('要修改的地址不存在')
    }
    list[idx] = Object.assign({}, list[idx], data, { updatedAt: now })
    // 若本次设为默认，需要取消其它默认
    if (data.isDefault) {
      list.forEach((a) => {
        if (a.id !== data.id) a.isDefault = false
      })
    }
    return saveList(list).find((a) => a.id === data.id)
  }

  const item = {
    id: makeId(),
    name: (data.name || '').trim(),
    phone: (data.phone || '').trim(),
    province: data.province || '',
    city: data.city || '',
    district: data.district || '',
    detail: (data.detail || '').trim(),
    latitude: data.latitude || 0,
    longitude: data.longitude || 0,
    tag: data.tag || '',
    isDefault: !!data.isDefault,
    createdAt: now,
    updatedAt: now
  }
  // 第一条地址自动设为默认
  if (!list.length) item.isDefault = true
  if (item.isDefault) {
    list.forEach((a) => { a.isDefault = false })
  }
  list.push(item)
  saveList(list)
  return item
}

/**
 * 删除地址
 * 若删掉的是默认地址，自动把剩下的第一条设为默认（避免没有默认地址）
 */
function remove(id) {
  let list = getList()
  const target = list.find((a) => a.id === id)
  list = list.filter((a) => a.id !== id)
  if (target && target.isDefault && list.length) {
    list[0].isDefault = true
  }
  saveList(list)
  return list
}

/**
 * 设为默认地址
 */
function setDefault(id) {
  const list = getList()
  let found = false
  list.forEach((a) => {
    a.isDefault = a.id === id
    if (a.isDefault) found = true
  })
  if (!found) throw new Error('地址不存在')
  saveList(list)
  return getList()
}

/**
 * 拼出用于展示的完整地址文字
 */
function formatFull(addr) {
  if (!addr) return ''
  return [addr.province, addr.city, addr.district, addr.detail]
    .filter(Boolean)
    .join('')
}

/**
 * 手机号格式校验（中国大陆 11 位）
 */
function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || '').trim())
}

module.exports = {
  STORAGE_KEY,
  getList,
  getById,
  getDefault,
  save,
  remove,
  setDefault,
  formatFull,
  isValidPhone
}
