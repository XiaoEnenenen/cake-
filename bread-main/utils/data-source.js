/**
 * 数据层开关（唯一事实来源）
 * ---------------------------------------------------------------------------
 * 2026-09-26 阶段一改造：数据源三态化，并引入降级回退。
 *
 * 三个数据源与优先级：
 *   1. Mock     —— 本地内存假数据（utils/mock-backend.js）
 *                   用途：不依赖 AppID / 云函数 / 网络，方便先跑通测试
 *                   开关：useMock = true
 *   2. 云开发   —— 自建云函数（cloudfunctions/api），★ 主路线
 *                   开关：useCloud = true
 *   3. api 工厂 —— 原 apifm-wxapi SaaS（config.js 指向原面包店账号）
 *                   开关：useMock = false 且 useCloud = false
 *                   定位：legacy 备用通道，代码全部保留（utils/services/legacy-apifm.js），
 *                         仅在 1、2 都不可用时作为回退。
 *
 * ⚠️ useMock 与 useCloud 同时为 true 时，Mock 优先。
 *
 * ===== 云函数失败自动降级 =====
 *   fallbackToLegacy = true 时：云函数调用失败（未部署 / 未开通云开发 / 网络异常）
 *   会**自动降级**到 api 工厂通道，只降级一次并弹窗提示，避免"云函数没部署导致全站无数据"。
 *
 *   这样做的前提：legacy 通道与云函数通道的**接口名、参数、返回结构**保持一致
 *   （utils/api-map.js 就是这么设计的）。
 *
 *   降级到 api 工厂意味着**数据来自原面包店账号**，仅用于"让项目能跑起来"，
 *   不能作为上线数据。想彻底关掉降级：把 fallbackToLegacy 改为 false。
 * ---------------------------------------------------------------------------
 */
module.exports = {
  // ===== 数据源三态开关 =====
  // true = 用本地 Mock 内存数据（当前阶段为 false，Mock 层将在后续阶段补齐）
  useMock: false,

  // true = 用自建微信云开发云函数（★ 主路线，阶段一起默认）
  useCloud: true,

  // 云函数调用失败时是否自动降级到 api 工厂通道（仅一次，且会弹窗提示）
  fallbackToLegacy: true,

  // ===== 云函数配置 =====
  // 云函数名（部署时保持一致，见 cloudfunctions/api）
  cloudFunctionName: 'api',

  // 云开发环境 ID（★ 多环境部署：必须显式指定，不要依赖"默认环境"）
  //
  // 为什么必须填：
  //   本店采用多环境方案（例如 dev / prod 分开）。wx.cloud.init 不传 env 时
  //   会使用「开发者工具当前选中的环境」，容易出现"本地连了 dev、真机连了 prod"
  //   这种数据错乱，且云端环境切换不会体现在代码里，排查困难。
  //
  // 怎么填：
  //   微信开发者工具 → 云开发 → 环境 → 环境设置，复制「环境 ID」
  //
  // 当前值（2026-09-26 初始化，个人测试 AppID）：
  //   AppID   : wx5b0e027deafefc01
  //   环境 ID : cloud1-d7g2txuxpf22bb979
  //
  // ⚠️ 换企业 AppID 时，这里必须改成企业环境 ID，并同步改 project.config.json 的 appid。
  //    留空 '' 时的行为 = 使用开发者工具当前选中的默认环境（多环境下不推荐）。
  cloudEnvId: 'cloud1-d7g2txuxpf22bb979',

  // 环境 ID 待填入时，是否在小程序启动时打印一条提醒（方便发现"忘了配环境"）
  warnOnEmptyEnvId: true,

  // ===== 调试 =====
  // 是否在控制台打印数据层调用日志
  debug: false
}
