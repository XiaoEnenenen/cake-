/**
 * 隐私授权弹窗（阶段 12；2026-10-17 顾客反馈整改）
 * ---------------------------------------------------------------------------
 * 用途：**首次启动**（或隐私政策版本更新后）主动告知用户收集哪些信息，必须勾选同意才能继续；
 *      也提供「查看隐私政策 / 微信隐私保护指引」入口。
 *
 * 2026-10-17 顾客反馈（本组件的两处行为修正）：
 *   ① 「第二次进小程序、已经是登录状态，还是弹隐私政策」——
 *      原来只有 agree 状态、没有"已提示"状态：点了「暂不使用」的顾客每次冷启动都会被再弹一次。
 *      现在弹过一次就记 prompted（见 utils/privacy.js 的 shouldShowOnLaunch），之后不再主动弹；
 *      真正需要同意时由**登录弹层**（components/login-sheet）强制重新勾选。
 *   ② 登录态判断不放在这里：微信身份是静默 openid，冷启动时没有可靠的"已登录"信号，
 *      用"只弹一次"来保证不会重复打扰。
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
const LOG = require('../../utils/log')

// 同一次运行里只主动弹一次（页面来回切换不重复打扰；下次冷启动看首次启动告知是否已弹过）
let shownThisRun = false

Component({
  data: {
    show: false,
    checked: false,
    agreed: false
  },

  lifetimes: {
    attached() {
      // 只弹一次：已同意、或已经弹过一次（含点「暂不使用」）都不再主动弹。
      if (PRIVACY.shouldShowOnLaunch() && !shownThisRun) {
        shownThisRun = true
        // 稍等首屏渲染，避免弹窗把首页内容完全遮住；
        // 真正显示时才记"已提示"——如果顾客在 400ms 内就切走 / 杀进程（弹窗一次都没看到），
        // 下次冷启动还会再提醒，不会出现"记成已提示但用户从没见过"的情况。
        this._timer = setTimeout(() => {
          PRIVACY.markPrompted()
          this.setData({ show: true })
        }, 400)
      }
    },
    detached() {
      if (this._timer) clearTimeout(this._timer)
    }
  },

  methods: {
    /** 页面可主动打开（例如需要临门提示时） */
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
      // 2026-10-17 真机反馈修复：
      //   顾客在本弹窗勾选「同意」只是**本机记录**；微信平台层还需要一次它自己的隐私授权
      //   （否则定位/选头像等隐私接口仍会报 privacy 错误，真机表现为"结算页地图下方提示
      //   需先同意《用户隐私保护指引》"）。这里在同意后主动请求一次平台授权（只弹一次系统确认）；
      //   即使这里没成功，utils/location.js 在真正调用定位时还会再补一次。
      PRIVACY.requestPlatformAuthorize().then((r) => {
        if (r && r.ok === false && !r.denied) {
          LOG.warn('[privacy-popup] 平台隐私授权未完成（请检查后台《用户隐私保护指引》是否已配置）', r.errMsg)
        }
      })
      this.triggerEvent('agree')
    },

    onAgreeAuth() {
      this.agree()
    },

    onAgreeTap() {
      this.agree()
    },

    /** 暂不使用：只是关掉本次告知；"已提示"状态在弹出时已记录，不会下次冷启动再弹 */
    onDisagree() {
      this.setData({ show: false })
      this.triggerEvent('disagree')
    },

    noop() {}
  }
})
