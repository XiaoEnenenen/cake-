/**
 * 登录弹层（2026-10-17）
 * ---------------------------------------------------------------------------
 * 为什么要有它（顾客反馈的三条问题）：
 *   ① 第一次进小程序弹隐私政策 → 勾选后才能登录（保留）；
 *   ② 已经登录时再进小程序**不再弹**隐私政策（由 utils/privacy 的"首次启动只弹一次"保证）；
 *   ③ 退出登录后点「登录」必须**重新**弹出隐私勾选 + 手机号/微信登录，
 *      绝不能像以前那样本地记过同意就直接静默登录 —— 本弹层每次打开都把勾选框重置为**未勾选**。
 *
 * 交互（参照店主提供的参考小程序截图）：
 *   登录 / 注册
 *   ☐ 我已阅读并同意《隐私政策》《微信隐私保护指引》
 *   [ 手机号一键登录 ]   ← open-type="getPhoneNumber"（微信原生授权框）
 *   [ 微信登录 ]         ← 微信身份（openid）登录
 *     暂不登录
 *
 * 关键取舍：
 *   · 勾选框没勾时**不渲染**真正的 open-type="getPhoneNumber" 按钮（渲染成普通按钮样式，
 *     点击只提示"请先勾选"）。否则微信会在用户同意隐私政策之前就弹手机号授权框；
 *   · 手机号登录当前依赖小程序后台开通「手机号快速验证」（个人主体不支持，本项目还没开通）：
 *     授权失败 / 云函数 bindMobile 返回未接入时，明确提示并给「用微信登录」的兜底，
 *     **绝不伪造登录成功**；
 *   · 「微信登录」不读取昵称头像（wx.getUserProfile 已匿名化），只建立/读取云开发用户记录，
 *     身份就是当前微信的 openid；昵称头像在「编辑资料」里由用户主动填写；
 *   · 平台级隐私同意在点登录时通过 wx.requirePrivacyAuthorize 主动触发（用户明确拒绝则拦住登录）。
 * ---------------------------------------------------------------------------
 */
const AUTH = require('../../utils/auth')
const API = require('../../utils/api-map')
const PRIVACY = require('../../utils/privacy')
const LOG = require('../../utils/log')

// 同一台手机上确认过"手机号快速验证不可用"后，本次运行不再反复等微信报错
let phoneUnavailable = false

Component({
  options: {
    addGlobalClass: true
  },

  data: {
    show: false,
    // 每次打开都重置为未勾选：退出登录后重新登录必须重新同意
    checked: false,
    // 登录请求中（防连点）
    logging: false,
    // 手机号授权/绑定中
    phoneLoading: false,
    // 手机号快速验证不可用时的常驻提示
    phoneHint: ''
  },

  methods: {
    /** 打开弹层（每次都重置勾选状态） */
    open() {
      this.setData({
        show: true,
        checked: false,
        logging: false,
        phoneLoading: false,
        phoneHint: phoneUnavailable ? '当前小程序未开通「手机号快速验证」，请使用微信登录' : ''
      })
    },

    /** 关闭（登录请求中不允许关闭，避免"点完登录又关掉"的状态错乱） */
    close() {
      if (this.data.logging) return
      this.setData({ show: false })
      this.triggerEvent('cancel')
    },

    noop() {},

    toggleCheck() {
      if (this.data.logging) return
      this.setData({ checked: !this.data.checked })
    },

    onOpenPolicy() {
      PRIVACY.openPolicy()
    },

    onOpenContract() {
      PRIVACY.openContractPage()
    },

    /** 未勾选时点任何登录按钮：只提示，不发起授权/登录 */
    onLoginBlocked() {
      wx.showToast({ title: '请先阅读并勾选同意隐私政策', icon: 'none' })
    },

    /**
     * 勾选 + 平台级隐私授权。
     * @returns {Promise<boolean>} false = 没勾选或用户明确拒绝，调用方必须停止登录
     */
    async ensurePrivacyAuthorized() {
      if (!this.data.checked) {
        this.onLoginBlocked()
        return false
      }
      const r = await PRIVACY.requestPlatformAuthorize()
      // 只有用户明确拒绝才拦；后台指引没配 / 旧基础库不支持时按"已同意"继续
      if (r && r.ok === false && r.denied) {
        wx.showToast({ title: '需同意隐私政策后才能登录', icon: 'none' })
        return false
      }
      PRIVACY.markAgreed()
      return true
    },

    /** 微信登录（身份 = 当前微信 openid） */
    async onWechatLogin() {
      await this.doWechatLogin()
    },

    async doWechatLogin() {
      if (this.data.logging) return
      const ok = await this.ensurePrivacyAuthorized()
      if (!ok) return
      this.setData({ logging: true })
      try {
        await AUTH.authorize()
        // 已是登录状态：取消"退出登录 → 下次冷启动重新弹隐私"的待办
        PRIVACY.cancelResetOnNextLaunch()
        this.setData({ show: false })
        this.triggerEvent('success', { method: 'wechat' })
      } catch (e) {
        LOG.error('[login-sheet] 微信登录失败', e)
        wx.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ logging: false })
      }
    },

    /**
     * 手机号一键登录（open-type="getPhoneNumber" 的回调）
     * detail：{ errMsg, code(新版) | encryptedData+iv(旧版) }
     */
    async onGetPhoneNumber(e) {
      const d = (e && e.detail) || {}
      const errMsg = String(d.errMsg || '')
      // 用户主动取消：静默返回
      if (!errMsg || /deny|cancel/i.test(errMsg)) return
      if (errMsg.indexOf('getPhoneNumber:ok') < 0) {
        // 没开通「手机号快速验证」的典型回调：getPhoneNumber:fail no permission
        this.markPhoneUnavailable(errMsg)
        return
      }
      if (!this.data.checked) {
        this.onLoginBlocked()
        return
      }
      if (this.data.phoneLoading || this.data.logging) return
      this.setData({ phoneLoading: true })
      try {
        // 2026-10-17：云函数 bindMobile 目前仍是"未接入"桩（需后台开通手机号快速验证），
        // 所以这里按返回结果如实提示，不伪造成功。
        const res = await API.bindMobile({
          code: d.code || '',
          encryptedData: d.encryptedData || '',
          iv: d.iv || ''
        })
        if (res && res.code === 0) {
          PRIVACY.markAgreed()
          await AUTH.authorize()
          // 已是登录状态：取消"退出登录 → 下次冷启动重新弹隐私"的待办
          PRIVACY.cancelResetOnNextLaunch()
          this.setData({ show: false })
          this.triggerEvent('success', { method: 'phone' })
          return
        }
        this.markPhoneUnavailable((res && res.msg) || '手机号绑定失败')
      } catch (err) {
        LOG.error('[login-sheet] 手机号登录异常', err)
        this.markPhoneUnavailable('手机号登录失败')
      } finally {
        this.setData({ phoneLoading: false })
      }
    },

    /**
     * 手机号登录不可用：明确说明原因，并给「用微信登录」的兜底。
     * @param {string} reason 微信回调 / 云函数返回的原因
     */
    markPhoneUnavailable(reason) {
      phoneUnavailable = true
      this.setData({
        phoneHint: '当前小程序未开通「手机号快速验证」，请使用微信登录'
      })
      wx.showModal({
        title: '手机号登录暂不可用',
        content: '手机号一键登录需要小程序后台开通「手机号快速验证」' +
          '（当前未开通）。可以先用微信登录，登录后在「编辑资料」里填写手机号。' +
          (reason ? '\n\n原因：' + reason : ''),
        confirmText: '用微信登录',
        cancelText: '暂不登录',
        success: (r) => {
          if (r && r.confirm) this.doWechatLogin()
        }
      })
    }
  }
})
