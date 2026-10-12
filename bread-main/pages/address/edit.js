/**
 * 新增 / 编辑收货地址
 * ---------------------------------------------------------------------------
 * ⚠️ 关于「地图选点」：
 *   本页的「地图选点」按钮使用 wx.chooseLocation（微信原生，无需第三方插件与 key）。
 *   但该接口要求在 app.json 的 requiredPrivateInfos 中声明 "chooseLocation"。
 *   若声明缺失，点击时会失败并提示（本项目 app.json 已声明 getLocation + chooseLocation，
 *   见 app.json 的 requiredPrivateInfos；下方失败分支是给"后台未开通接口权限"等情况兜底的）。
 *
 * 手动填写路径同样完整可用（省/市/区 + 详细地址）。
 *
 * 2026-10-09 变更：删除「标签（家 / 公司 / 学校 / 其他）」选择。
 *   原因：该卡片位于表单最底部，被固定定位的「保存」按钮遮挡；
 *        店主确认不需要地址标签，故整体移除（UI + 逻辑），
 *        保存时不再写入 tag 字段（utils/address.js 仍保留该字段以兼容历史数据）。
 * ---------------------------------------------------------------------------
 */
const ADDR = require('../../utils/address')
// 阶段 5.7：日志统一收敛到 utils/log.js
const LOG = require('../../utils/log')

Page({
  data: {
    id: '',
    name: '',
    phone: '',
    // 省市区（用 van-area 选择）
    province: '',
    city: '',
    district: '',
    detail: '',
    isDefault: false,
    latitude: 0,
    longitude: 0,
    saving: false,
    // 省市区选择弹层
    showArea: false,
    areaCode: '',
    // 省市区展示文案（如「云南省昆明市安宁市」）
    areaText: ''
  },

  onLoad(options) {
    if (options && options.id) {
      const addr = ADDR.getById(options.id)
      if (addr) {
        this.setData({
          id: addr.id,
          name: addr.name,
          phone: addr.phone,
          province: addr.province || '',
          city: addr.city || '',
          district: addr.district || '',
          areaText: [addr.province, addr.city, addr.district].filter(Boolean).join(''),
          detail: addr.detail,
          isDefault: !!addr.isDefault,
          latitude: addr.latitude || 0,
          longitude: addr.longitude || 0
        })
        wx.setNavigationBarTitle({ title: '编辑收货地址' })
        return
      }
    }
    wx.setNavigationBarTitle({ title: '新增收货地址' })
  },

  // ===== 省市区选择 =====
  openArea() {
    this.setData({ showArea: true })
  },
  closeArea() {
    this.setData({ showArea: false })
  },
  onAreaConfirm(e) {
    // e.detail.values 形如 [{ name: '云南省' }, { name: '昆明市' }, { name: '安宁市' }]
    const values = (e.detail && e.detail.values) || []
    const pick = (i) => (values[i] && values[i].name) || ''
    const province = pick(0)
    const city = pick(1)
    const district = pick(2)
    this.setData({
      province,
      city,
      district,
      areaText: [province, city, district].filter(Boolean).join(''),
      showArea: false
    })
  },

  // 2026-10-12 阶段 5.7：删除死代码 refreshAreaText()。
  //   它是 api 工厂时代「编辑已有地址时刷新省市区文案」的辅助函数，
  //   但 onLoad 早已直接算出 areaText（见上面的 setData），全项目零调用。
  //   （审计报告 §4.3 已记录该孤儿函数。）

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onDefaultChange(e) {
    this.setData({ isDefault: e.detail.value })
  },

  /**
   * 地图选点
   * 成功后会带出 latitude / longitude 与地址文字。
   * 未声明 chooseLocation 权限时会失败 —— 这里给出明确指引而不是静默失败。
   */
  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          // res.address 是完整地址，直接作为详细地址，用户可再修改门牌号
          detail: res.address || res.name || this.data.detail,
          latitude: res.latitude,
          longitude: res.longitude
        })
      },
      fail: (err) => {
        LOG.warn('[address] chooseLocation 失败', err)
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth') >= 0 || msg.indexOf('privacy') >= 0 || msg.indexOf('permission') >= 0) {
          wx.showModal({
            title: '无法打开地图选点',
            content: '当前小程序未声明 chooseLocation 权限，请手动填写地址，或联系开发者在 app.json 中开启该权限。',
            showCancel: false
          })
        } else if (msg.indexOf('cancel') < 0) {
          // 用户主动取消不提示
          wx.showToast({ title: '打开地图失败，请手动填写', icon: 'none' })
        }
      }
    })
  },

  onSave() {
    if (this.data.saving) return

    const name = (this.data.name || '').trim()
    const phone = (this.data.phone || '').trim()
    const detail = (this.data.detail || '').trim()

    // ===== 校验 =====
    if (!name) {
      wx.showToast({ title: '请填写收货人姓名', icon: 'none' })
      return
    }
    if (!ADDR.isValidPhone(phone)) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
      return
    }
    if (!detail) {
      wx.showToast({ title: '请填写详细地址', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      ADDR.save({
        id: this.data.id || undefined,
        name,
        phone,
        // 省市区（区域判断会用「太平新城」等关键词匹配拼接后的地址）
        province: this.data.province,
        city: this.data.city,
        district: this.data.district,
        detail,
        isDefault: this.data.isDefault,
        latitude: this.data.latitude,
        longitude: this.data.longitude
      })
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => {
        wx.navigateBack()
      }, 600)
    } catch (e) {
      this.setData({ saving: false })
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
    }
  },

  onBack() {
    wx.navigateBack()
  }
})
