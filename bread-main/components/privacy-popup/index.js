/**
 * 隐私授权弹窗（阶段 12）
 * ---------------------------------------------------------------------------
 * 用途：首次启动（或隐私政策版本更新后）主动告知用户收集哪些信息，必须勾选同意才能继续；
 *      也提供「查看隐私政策 / 微信隐私保护指引」入口。
 *
 * 设计取舍：
 *   · **不注册** wx.onNeedPrivacyAuthorization（见 utils/privacy.js 顶部说明）：
 *     未同意时若调用定位/选头像等隐私接口，由微信原生弹窗兜底，不会因为当前页面
 *     没挂载本组件而让接口一直挂起；
 *   · 同意按钮用官方 `<button open-type="agreePrivacyAuthorization">`，
 *     用户同意后平台级授权也一并完成，后续隐私接口不再重复弹系统框；
 *   · 未勾选时按钮 disabled，避免"没看协议就点同意"。
 * ---------------------------------------------------------------------------
 */
const PRIVACY = require('../../utils/privacy')

// 同一次运行里只主动弹一次（页面来回切换不重复打扰；下次冷启动仍未同意会再弹）
let shownThisRun = false

Component({
  data: {
    show: false,
    checked: false,
    agreed: false
  },

  lifetimes: {
    attached() {
      if (!PRIVACY.hasAgreed() && !shownThisRun) {
        shownThisRun = true
        // 稍等首屏渲染，避免弹窗把首页内容完全遮住
        this._timer = setTimeout(() => this.setData({ show: true }), 400)
      }
    },
    detached() {
      if (this._timer) clearTimeout(this._timer)
    }
  },

  methods: {
    /** 页面可主动打开（例如点「登录」但还没同意隐私政策时） */
    show() {
      this.setData({ show: true, checked: PRIVACY.hasAgreed() || this.data.checked })
    },

    hide() {
      this.setData({ show: false })
    },

    toggleCheck() {
      this.setData({ checked: !this.data.checked })
    },

    onOpenPolicy() {
      PRIVACY.openPolicy()
    },

    onOpenContract() {
      PRIVACY.openContractPage()
    },

    /** 同意（官方按钮事件 + 普通 tap 兜底，两个事件都触发时用 agreed 去重） */
    agree() {
      if (this.data.agreed) return
      if (!this.data.checked) {
        wx.showToast({ title: '请先阅读并勾选同意隐私政策', icon: 'none' })
        return
      }
      this.setData({ agreed: true, show: false })
      PRIVACY.markAgreed()
      this.triggerEvent('agree')
    },

    onAgreeAuth() {
      this.agree()
    },

    onAgreeTap() {
      this.agree()
    },

    onDisagree() {
      this.setData({ show: false })
      this.triggerEvent('disagree')
    },

    noop() {}
  }
})
