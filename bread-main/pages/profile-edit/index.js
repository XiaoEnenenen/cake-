/**
 * 编辑资料（阶段 12，2026-10-17）
 * ---------------------------------------------------------------------------
 * 为什么单独一页：原来「我的」页只有内联的头像 + 昵称编辑，入口不明显、字段也少，
 * 顾客反馈"只能改头像"。现在统一收到这一页：
 *   · 头像（微信头像选择能力 chooseAvatar → 先上传云存储再保存 fileID）；
 *   · 昵称（微信昵称填写能力 input type="nickname"）；
 *   · 手机号（顾客手填，用于订单联系；可留空）；
 *   · 收货地址（跳地址簿管理，显示默认地址）。
 * 保存走云函数 updateUser（服务端已加字段校验：昵称 ≤20、手机号 11 位、
 * 头像不允许本地临时路径）。
 * ---------------------------------------------------------------------------
 */
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const ADDR = require('../../utils/address')
const FMT = require('../../utils/format')
const LOG = require('../../utils/log')
// 2026-10-17 顾客反馈：退出登录 = 回到「未登录」状态 —— 下次打开小程序要重新弹隐私政策，
// 因此退出时一并清掉本机的隐私同意/已提示状态（见 logout()）。
const PRIVACY = require('../../utils/privacy')

Page({
  data: {
    loading: true,
    loadError: false,
    userNo: '',
    nick: '',
    avatarUrl: '',
    // 选完头像还没上传成功（本地临时路径）时为 true → 保存会被拦住
    avatarIsLocal: false,
    mobile: '',
    mobileError: '',
    addressText: '',
    saving: false
  },

  async onLoad() {
    await this.userDetail()
  },

  onShow() {
    // 从地址页返回后刷新默认地址文案
    this.loadAddress()
  },

  async userDetail() {
    this.setData({ loading: true, loadError: false })
    const res = await API.userDetail()
    if (!res || res.code != 0 || !res.data || !res.data.base) {
      LOG.error('[profile-edit] 资料读取失败', res && res.msg)
      this.setData({ loading: false, loadError: true })
      return
    }
    const base = res.data.base
    this.setData({
      loading: false,
      loadError: false,
      userNo: FMT.shortUserNo(base.id || ''),
      nick: base.nick || '',
      avatarUrl: base.avatarUrl || '',
      avatarIsLocal: false,
      mobile: base.mobile || ''
    })
  },

  retryLoad() {
    this.userDetail()
  },

  loadAddress() {
    const addr = ADDR.getDefault()
    this.setData({ addressText: addr ? ADDR.formatFull(addr) : '' })
  },

  // ===== 头像 =====
  async onChooseAvatar(e) {
    const temp = e && e.detail && e.detail.avatarUrl
    if (!temp) return
    this.setData({ avatarUrl: temp, avatarIsLocal: true })
    // 连选两次时，先发的上传可能后返回，用序号丢弃过期结果
    this._avatarSeq = (this._avatarSeq || 0) + 1
    const seq = this._avatarSeq
    const openid = wx.getStorageSync('uid') || 'anonymous'
    const ext = (/\.(png|jpg|jpeg|webp)$/i.exec(temp) || [null, 'png'])[1].toLowerCase()
    wx.showLoading({ title: '上传头像…' })
    const res = await API.uploadFile(temp, 'avatars/' + openid + '_' + Date.now() + '.' + ext)
    wx.hideLoading()
    if (seq !== this._avatarSeq) return
    if (res && res.code == 0 && res.fileID) {
      this.setData({ avatarUrl: res.fileID, avatarIsLocal: false })
    } else {
      LOG.error('[profile-edit] 头像上传失败', res && res.msg)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    }
  },

  // ===== 昵称 / 手机号 =====
  onNickInput(e) {
    this.setData({ nick: String((e && e.detail && e.detail.value) || '') })
  },

  onMobileInput(e) {
    // 只保留数字并截到 11 位（type="number" 仍可能带出符号/小数点）
    const value = String((e && e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 11)
    this.setData({ mobile: value, mobileError: '' })
    return value
  },

  /**
   * 前端自查（服务端 updateUser 还会独立校验一遍）。
   * @returns {{ok:boolean, msg?:string, payload?:object}}
   */
  validate() {
    const nick = String(this.data.nick || '').trim()
    if (!nick) return { ok: false, msg: '请填写昵称' }
    if (nick.length > 20) return { ok: false, msg: '昵称最多 20 个字' }

    if (this.data.avatarIsLocal) {
      return { ok: false, msg: '头像还没上传成功，请重新选择' }
    }

    const mobile = String(this.data.mobile || '').trim()
    if (mobile && !/^1\d{10}$/.test(mobile)) {
      return { ok: false, msg: '请填写正确的 11 位手机号' }
    }

    const payload = { nick: nick, mobile: mobile }
    if (this.data.avatarUrl) payload.avatarUrl = this.data.avatarUrl
    return { ok: true, payload: payload }
  },

  async save() {
    if (this.data.saving) return
    const v = this.validate()
    if (!v.ok) {
      wx.showToast({ title: v.msg, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const res = await API.modifyUserInfoV2(v.payload)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => {
        try {
          wx.navigateBack()
        } catch (e) {
          LOG.error('[profile-edit] 返回失败', e)
        }
      }, 600)
    } finally {
      this.setData({ saving: false })
    }
  },

  goAddress() {
    wx.navigateTo({ url: '/pages/address/index' })
  },

  /**
   * 退出登录（2026-10-17 顾客反馈：入口放在「编辑资料」页底部，而不是「我的」页）
   * 只清本机展示（storage.loggedOut）——微信小程序的身份就是当前微信 openid，
   * 没有真正的"注销"；订单/地址仍保留，重新登录即可恢复。
   *
   * 2026-10-17 第二轮反馈：退出后再打开小程序要重新弹隐私政策。
   * 做法：只写一个"下次冷启动重新告知"的标记（utils/privacy 的 requestResetOnNextLaunch），
   * 由 app.js 在下次 onLaunch 时消费 → 清掉本机同意/已提示状态，隐私弹窗重新出现。
   * 不在退出当下直接清：否则顾客退出后在本会话里打开结算/地址等页面时会立刻又弹一次，
   * 而顾客要的是"退出小程序、再次打开后弹"。退出后又马上登录的话，登录弹层会取消这个标记。
   */
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后本机不再显示你的资料；订单和收货地址仍保留在当前微信下，重新登录即可恢复。确认退出？',
      confirmText: '退出',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        AUTH.loginOut()
        PRIVACY.requestResetOnNextLaunch()
        try {
          wx.setStorageSync('loggedOut', '1')
        } catch (e) {}
        wx.showToast({ title: '已退出登录', icon: 'none' })
        // 回「我的」页（它 onShow 会读 loggedOut 展示登录卡片）
        setTimeout(() => {
          wx.navigateBack({
            fail: () => wx.reLaunch({ url: '/pages/my/index' })
          })
        }, 500)
      }
    })
  }
})
