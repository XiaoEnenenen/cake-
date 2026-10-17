/**
 * 登录弹层（2026-10-17）
 * ---------------------------------------------------------------------------
 * 为什么要有它（顾客反馈）：
 *   ① 第一次进小程序弹隐私政策 → 勾选后才能登录（保留）；
 *   ② 已经登录时再进小程序**不再弹**隐私政策（由 utils/privacy 的"首次启动只弹一次"保证）；
 *   ③ 退出登录后点「登录」必须**重新**弹出隐私勾选 + 微信登录，
 *      绝不能像以前那样本地记过同意就直接静默登录 —— 本弹层每次打开都把勾选框重置为**未勾选**；
 *   ④ 2026-10-17 顾客确认：**不做手机号登录**，只保留微信登录。
 *      手机号是"订单联系方式"，由顾客在结算页手填 / 在「编辑资料」里保存，和登录无关。
 *
 * 交互：
 *   登录 / 注册
 *   ☐ 我已阅读并同意《隐私政策》《微信隐私保护指引》
 *   [ 微信登录 ]   ← 用当前微信身份（云开发 OPENID）登录
 *     暂不登录
 *
 * 关键取舍：
 *   · 「微信登录」不读取昵称头像（wx.getUserProfile 已匿名化），也不弹微信授权框
 *     （小程序身份登录本来就是静默的）；昵称头像在「编辑资料」里由用户主动填写；
 *   · 平台级隐私同意在点登录时通过 wx.requirePrivacyAuthorize 主动触发（用户明确拒绝则拦住登录）；
 *   · 未勾选时按钮置灰 + 点击只提示，不会发起登录。
 * ---------------------------------------------------------------------------
 */
const AUTH = require('../../utils/auth')
const PRIVACY = require('../../utils/privacy')
const LOG = require('../../utils/log')

Component({
  options: {
    addGlobalClass: true
  },

  data: {
    show: false,
    // 每次打开都重置为未勾选：退出登录后重新登录必须重新同意
    checked: false,
    // 登录请求中（防连点）
    logging: false
  },

  methods: {
    /** 打开弹层（每次都重置勾选状态） */
    open() {
      this.setData({
        show: true,
        checked: false,
        logging: false
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

    /** 未勾选时点登录：只提示，不发起登录 */
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

    /** 微信登录（身份 = 当前微信 openid，静默完成，微信不弹授权框） */
    async onWechatLogin() {
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
    }
  }
})
