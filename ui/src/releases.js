import { hana } from "@hana/app-sdk/ui";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  AnimatedList,
  AnimatedListItem,
  AppUiProvider,
  Button,
  Busy,
  EmptyState,
  ErrorState,
  FadeIn,
  Tabs,
  Tooltip,
} from "@hana/app-sdk/components";
import "@hana/app-sdk/components.css";
import "./hana-card-style.css";
import "./page.css";
import "./settings.css";
import "./downloads.css";
import "./releases.css";
import { assetGroupOf, stripVersion } from "./asset-display.js";
import { SettingsPanel } from "./settings-panel.js";
import { DownloadsPanel } from "./downloads-panel.js";

/**
 * 主页（ui/releases.html 的脚本）。
 *
 * 两个视图共用这一张卡：
 *   · 版本 —— 一页翻一个版本，最新的在前
 *   · 设置 —— 轮询间隔、自动下载、下载目录、镜像源
 *
 * 设置不再作为宿主设置窗里的独立标签页存在（manifest 里没有 contributes.settings），
 * 而是这一页的一个视图：它们读写的都是本 App 自己的库，放在一起比拆成两处更近。
 *
 * 数据只从本 App 的后端路由取（hana.api.fetch 会把路径拼成
 * /api/apps/oh-releases/routes/…），页面不直连 GitHub。
 *
 * 卡面被宿主裁四个角，所以最外层三件（html / body / #root）保持方形铺满，
 * 圆角只出现在内层面板与徽标上——见 releases.css 顶部。
 */

const h = React.createElement;

/**
 * 一次取多少条。
 *
 * 整条链实测 50 条，后端 limit 上限是 100，所以一次取全，不分页。
 * 分页在这里没好处：侧栏就是个列表，而且要把“首次回填时逐条长出来”的过程
 * 显给用户看，分页反而会把那个过程截断。
 */
const FETCH_LIMIT = 100;

/**
 * 兵底轮询间隔。
 *
 * 正常路径是事件驱动（后端每入库一版推一次事件）。轮询只是防事件丢失的兵底，
 * 所以不需要密——密了反而会和内容请求抢通道，正是之前详情卡住的诱因之一。
 */
const FALLBACK_POLL_MS = 3000;

const KIND_LABEL = {
  feature: "新功能",
  fix: "修复",
  improvement: "改进",
  migration: "迁移",
};

const IMPORTANCE_LABEL = {
  high: "重要",
  medium: "一般",
  normal: "常规",
  low: "次要",
};

/**
 * 区分「可安装的程序」与「数据产物」。
 *
 * release 的 assets 里混着两类东西（实测 v1.1.7-beta 共 13 个）：
 *
 *   可装：.exe / .dmg / .zip / .deb / .AppImage
 *   数据：.blockmap（差分元数据）、latest*.yml（自动更新清单）、
 *         release-digest.v1.json（本 App 的数据源）、SHA256SUMS.txt（校验）
 *
 * 把后一类也叫「安装包」会让人以为下载下来双击就能装。所以分两组列。
 */
/**
 * 附件分三类，分别成组展示。
 *
 * 实测一个版本带 13–18 个文件，混在一起看很吵，而且“能装”与“能下载”是
 * 两回事：exe/dmg/deb/AppImage 双击就能装；zip/tar.gz 要先解压；剩下的
 * 是给自动更新和校验用的，根本不需要手动下载。
 */
const isInstaller = (asset) =>
  Boolean(asset?.name) && assetGroupOf(suffixOf(asset.name)) === "installer";
const isArchive = (asset) =>
  Boolean(asset?.name) && assetGroupOf(suffixOf(asset.name)) === "archive";

/** 文件名 → 小写后缀。 */
function suffixOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

/** 把附件分成安装包 / 压缩包 / 清单三组，顺序固定。 */
function groupAssets(assets) {
  const named = (Array.isArray(assets) ? assets : []).filter((a) => Boolean(a?.name));
  return {
    installers: named.filter(isInstaller),
    archives: named.filter((a) => !isInstaller(a) && isArchive(a)),
    extras: named.filter((a) => !isInstaller(a) && !isArchive(a)),
  };
}

/**
 * 去掉文件名里重复的版本段，便于在窄栏里区分。
 *
 * 规则与下载页共用 asset-display.js 里的 stripVersion。
 */

// ---------------------------------------------------------------- 网络

async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = body?.error?.code ?? "HTTP_" + response.status;
    const message = body?.error?.message ?? "请求失败（" + response.status + "）";
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.field = body?.error?.field ?? null;
    throw error;
  }
  return body;
}

function postJson(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

// ---------------------------------------------------------------- 小工具

/** digest 里的文案都是 {zh, en}：中文优先，没有就用英文，都没有返回 null。 */
function pickText(value) {
  if (!value || typeof value !== "object") return null;
  const zh = typeof value.zh === "string" ? value.zh.trim() : "";
  if (zh) return zh;
  const en = typeof value.en === "string" ? value.en.trim() : "";
  return en || null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/** ISO 时间串（digest.generatedAt）→ 可读文本。解析不出来就原样给出。 */
function formatIso(text) {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return text;
  return formatTime(ms);
}

function relativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const delta = Date.now() - ms;
  if (delta < 0) return "刚刚";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.floor(hours / 24);
  return days + " 天前";
}

/** 下载进度百分比。没有 total 就返回 null，由调用方画不确定态。 */
function percentOf(done, total) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** 侧栏里显示的版本号：与 tag 原文一致，不做任何简写。 */
function shortTagOf(tag) {
  return String(tag ?? "");
}

/** 侧栏行尾日期：只要年月日。 */
function dateOf(text) {
  if (typeof text !== "string" || !text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 侧栏行尾徽标：变更条数。零条就不给徽标。 */
/**
 * 侧栏行尾的变更条数。
 *
 * 零返回 null（不占位）：日期在它右边，如果这里撑一个 "00"，每行都会多一个
 * 物体，视觉上比空着重。计数为零的版本本来就少，空着不影响列宽——真正会
 * 挤出日期位移的是位数从 1 变 2，那是数字变多时的天然代价，可接受。
 */
function countBadge(counts) {
  let total = 0;
  if (counts) {
    for (const key of ["feature", "fix", "improvement", "migration"]) {
      total += Number(counts[key]) || 0;
    }
  }
  return total > 0 ? String(total) : null;
}

// ---------------------------------------------------------------- 组件

/** 视图标识：版本内容与设置面板。 */
const VIEW_RELEASES = "releases";
const VIEW_DOWNLOADS = "downloads";
const VIEW_SETTINGS = "settings";

/**
 * 下载进度：只有圆环，百分比放在悬停提示里。
 *
 * 不带文字是有意的：右侧那一格要和“下载”按钮同形，多几个字符就会把宽度撑开；
 * 圆环自己会随者 dashoffset 走，静着看一眼也看得出来到哪了。
 *
 * 半径 8（直径 20px）：壳高 34px，环与上下边各留 7px，既不满也不至于缩成一点。
 */
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_SIZE = 20;

function ProgressRing({ ratio }) {
  const known = typeof ratio === "number" && Number.isFinite(ratio);
  const clamped = known ? Math.max(0, Math.min(1, ratio)) : 0;
  const percent = Math.round(clamped * 100);

  return h(
    "span",
    {
      className: "or-ring" + (known ? "" : " or-ring--spin"),
      role: "progressbar",
      "aria-valuenow": known ? percent : undefined,
      "aria-valuemin": known ? 0 : undefined,
      "aria-valuemax": known ? 100 : undefined,
      title: known ? "下载中 " + percent + "%" : "下载中",
    },
    h(
      "svg",
      {
        className: "or-ring__svg",
        viewBox: "0 0 " + RING_SIZE + " " + RING_SIZE,
        width: RING_SIZE,
        height: RING_SIZE,
        "aria-hidden": "true",
      },
      h("circle", {
        className: "or-ring__track",
        cx: RING_SIZE / 2,
        cy: RING_SIZE / 2,
        r: RING_RADIUS,
      }),
      h("circle", {
        className: "or-ring__fill" + (known ? "" : " or-ring__fill--indeterminate"),
        cx: RING_SIZE / 2,
        cy: RING_SIZE / 2,
        r: RING_RADIUS,
        style: known
          ? { strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: RING_CIRCUMFERENCE * (1 - clamped) }
          : { strokeDasharray: RING_CIRCUMFERENCE * 0.3 + " " + RING_CIRCUMFERENCE },
      }),
    ),
    // 百分比：等宽数字 + 固定最小宽度，9% 与 100% 之间切换时胶囊不抖。
    h("span", { className: "or-ring__pct" }, known ? percent + "%" : ""),
  );
}

/** 一条提示。warn 用于"这次没成功"，普通用于说明现状。 */
function Notice({ tone, children }) {
  if (!children) return null;
  return h("div", { className: "or-notice" + (tone === "warn" ? " or-notice--warn" : "") }, children);
}


/**
 * 错误边界：单个版本渲染出错时只换掉内容区，不把整张卡变成白屏。
 *
 * React 一旦有组件在渲染中抛异常，默认会卸载整棵树，用户看到的就是一片空白，
 * 连翻页按钮都没了——卡死在那一版也退不出去。这里把错接住，报出具体是哪个
 * tag、什么错，并给一个“回第一版”的出口。
 */
class CardErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    // 换到别的版本时重新尝试渲染，不把刚才的错带到下一版。
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return h(
      "div",
      { className: "or-state" },
      h(ErrorState, {
        title: "这一版没能显示出来",
        message: String(error?.message ?? error),
        action: h(
          Button,
          { variant: "secondary", size: "sm", onClick: this.props.onReset },
          "回第一版",
        ),
      }),
    );
  }
}

/** 版本头：tag、版本号、发布时间、变更计数。 */
function VersionHeader({ item, detail, isFresh }) {
  const counts = detail?.counts ?? item?.counts ?? null;
  const parts = [];
  if (counts) {
    for (const key of ["feature", "fix", "improvement", "migration"]) {
      const n = Number(counts[key]);
      if (Number.isFinite(n) && n > 0) parts.push((KIND_LABEL[key] ?? key) + " " + n);
    }
  }
  const published = formatIso(detail?.generatedAt ?? item?.generatedAt ?? null);

  // digest 里的 version 与 tag 是同一件事的两种写法（"1.1.7-beta" 与 "v1.1.7-beta"）。
  // 只有两者确实不同时才单独列出来，否则标题下面会重复一遍版本号。
  const tagTail = String(item.tag ?? "").replace(/^v/i, "");
  const distinctVersion = item.version && item.version !== tagTail ? item.version : null;

  return h(
    "div",
    { className: "or-version" },
    h(
      "h1",
      { className: "or-version__tag" },
      item.tag,
      isFresh ? h("span", { className: "or-version__new" }, "刚到") : null,
    ),
    h(
      "div",
      { className: "or-version__sub" },
      distinctVersion ? h("span", null, "版本 " + distinctVersion) : null,
      published ? h("span", null, "发布于 " + published) : null,
      parts.length ? h("span", { className: "hs-badge" }, parts.join(" · ")) : null,
      item.previousTag ? h("span", null, "上一版 " + item.previousTag) : null,
    ),
  );
}

/** 条目：标题 + 类型徽标 + 正文 + 可折叠的补充细节。 */
function ItemEntry({ item, index }) {
  const title = pickText(item?.title) ?? item?.id ?? "变更 " + (index + 1);
  const body = pickText(item?.summary);
  const kind = typeof item?.kind === "string" ? item.kind : null;
  const importance = typeof item?.importance === "string" ? item.importance : null;
  const details = Array.isArray(item?.details) ? item.details.map(pickText).filter(Boolean) : [];

  return h(
    AnimatedListItem,
    { className: "or-item" + (importance === "high" ? " or-item--high" : importance === "low" ? " or-item--low" : "") },
    h(
      "div",
      { className: "or-item__head" },
      h("h3", { className: "or-item__title" }, title),
      kind ? h("span", { className: "hs-badge" }, KIND_LABEL[kind] ?? kind) : null,
      // 只在两端标出来：绝大多数变更都是中间档，逐条挂个徽章只是噪声。
      importance === "high" || importance === "low"
        ? h(
            "span",
            { className: "hs-badge" + (importance === "high" ? " hs-badge--warn" : "") },
            IMPORTANCE_LABEL[importance],
          )
        : null,
    ),
    body ? h("p", { className: "or-item__body" }, body) : null,
    details.length
      ? h(
          "div",
          { className: "or-item__details" },
          h(
            "details",
            { className: "hs-disclosure" },
            h("summary", null, "补充说明（" + details.length + "）"),
            h(
              "div",
              { className: "hs-disclosure-body" },
              details.map((text, i) => h("p", { className: "or-item__detail", key: i }, text)),
            ),
          ),
        )
      : null,
  );
}

/** 附件行：文件名、大小、下载按钮、进度。 */
function AssetRow({ tag, asset, progress, onDownload, downloading }) {
  const size = formatBytes(asset.size);
  const state = progress?.state ?? null;
  const percent = progress ? percentOf(progress.done, progress.total ?? asset.size) : null;

  // 显示时去掉重复的版本段，悬停始终给完整名字。
  const shown = stripVersion(asset.name, tag);

  // 三种状态共用同一个丸壳，只换里面的内容。
  // 壳子的高度与圆角一致，所以从“下载”到圆环再到“已完成”，行高与右缘都不动。
  // 四种状态都是同一只胶囊，只有内容和底色不同。
  //
  // 胶囊宽度由 CSS 固定（--or-pill-w），不由内容撑开：
  // “已完成”三个字、圆环一个圈、两个字的重试，宽度各不相同，
  // 让内容决定宽度就只能得到四个大小不一的壳。
  // 还没拿到服务端记录时（只是刚点下去）也显示圆环，走不确定态。
  const inFlight = state === "running" || (downloading && !state);

  let action;
  if (inFlight) {
    action = h(
      "span",
      { className: "or-pill or-pill--busy", title: percent === null ? "下载中" : "下载中 " + percent + "%" },
      h(ProgressRing, { ratio: percent === null ? null : percent / 100 }),
    );
  } else if (state === "completed") {
    action = h("span", { className: "or-pill or-pill--done", title: "已下载完成" }, "已完成");
  } else if (state === "failed") {
    action = h(
      Tooltip,
      { content: progress?.error?.message ?? "下载失败" },
      h(
        "button",
        { type: "button", className: "or-pill or-pill--failed", onClick: () => onDownload(tag, asset) },
        "重试",
      ),
    );
  } else {
    action = h(
      "button",
      { type: "button", className: "or-pill or-pill--idle", onClick: () => onDownload(tag, asset) },
      "下载",
    );
  }

  return h(
    "li",
    { className: "or-asset" },
    h(
      "div",
      { className: "or-asset__row" },
      // 手写一行而不是用 ListRow：文件名很长（版本号 + 平台 + 架构），窄栏里
      // 会被截断。要让“悬停看全名”只发生在文件名上、不连带影响右侧按钮，
      // title 属性必须只挂在文件名那一个元素上——ListRow 的 title 是字符串
      // 且 Omit 掉了原生 title 属性，做不到这一点。
      h("span", { className: "or-asset__file", title: asset.name }, shown),
      h(
        "div",
        { className: "or-asset__trailing" },
        size ? h("span", { className: "or-asset__size" }, size) : null,
        h("span", { className: "or-asset__slot" }, action),
      ),
    ),
  );
}

/**
 * 整理数据来源地址：保留协议头，去掉末尾斜杠。
 * 不在 JS 里截断——宽度截断交给 CSS 的省略号，按实际可用宽度算，
 * 比按字符数硬切更准（硬切会把版本号那块砍掉）。
 */
function formatSourceUrl(url) {
  if (typeof url !== "string" || !url) return "上游";
  return url.replace(/\/+$/, "");
}

/**
 * 顶部：标题与状态。
 *
 * 卡体本身不再带宿主标题栏（cardForm: edge-to-edge + titleMode: hide），
 * 所以这里自己承担“这是哪个 App”和那排操作。两个按钮放在第二行右侧，
 * 不占标题行——标题行留给版本状态，带宽更寛。
 */
function StatusHead({ state, counts, onRefresh, onCheck, refreshing, checking, view, onViewChange }) {
  const backfillRunning = state?.backfill?.state === "running";
  const backfillState = state?.backfill_state ?? 0;
  const lastCheck = relativeTime(Number(state?.last_check_at));

  // 定时检查到底跑没跑。enabled 只是用户意图，被宿主挂起的计划也是 enabled 为真
  // 但永远不会触发，所以两个都得看。
  const schedule = state?.schedule ?? null;
  const suspended = Array.isArray(schedule?.suspension) && schedule.suspension.length > 0;
  const scheduleTrouble = suspended
    ? "定时检查被挂起"
    : schedule && schedule.enabled === false
      ? "定时检查已暂停"
      : null;

  return h(
    "div",
    { className: "or-head" },
    h(
      "div",
      { className: "or-head__inner" },
      h(
        "div",
        { className: "or-head__eyebrow" },
        h("h1", { className: "or-head__title" }, "OH Releases"),
        h(
          "span",
          { className: "hs-badge" + (backfillState === 1 ? " hs-badge--good" : " hs-badge--pending") },
          backfillState === 1 ? "已同步" : backfillRunning ? "同步中" : "未同步",
        ),
      ),
      // 第二行是工具栏：左边是读数，右边是一组开关与动作。
      // 读数不随视图变：它描述的是同一份数据（多少版本、上次何时检查），
      // 在哪个视图都一样。隐藏它只会留下空白，再让设置页把同样的数字另说一遍。
      h(
        "div",
        { className: "or-head__meta" },
        h("span", null, "共 " + (counts?.versions ?? 0) + " 个版本"),
        lastCheck ? h("span", null, "上次检查 " + lastCheck) : h("span", null, "还没检查过"),
        scheduleTrouble ? h("span", { className: "or-head__warn" }, scheduleTrouble) : null,
        // 动作与导航包成一组靠右。两者都不随视图变：检查与刷新动的是同一份数据，
        // 在下载页或设置页也成立；把它们藏起来只会让用户要先切回版本页。
        h(
          "div",
          { className: "or-head__tools" },
          h(
            "div",
            { className: "or-head__actions" },
            h(
              Tooltip,
              { content: "检查有没有新版本" },
              h(
                Button,
                { variant: "secondary", size: "sm", loading: checking, onClick: onCheck },
                "检查",
              ),
            ),
            h(
              Tooltip,
              { content: "重新读取本地数据" },
              h(
                Button,
                { variant: "ghost", size: "sm", loading: refreshing, onClick: onRefresh },
                "刷新",
              ),
            ),
          ),
          h(
            "div",
            { className: "or-head__views" },
            h(Tabs, {
              items: [
                { value: VIEW_RELEASES, label: "版本" },
                { value: VIEW_DOWNLOADS, label: "下载" },
                { value: VIEW_SETTINGS, label: "设置" },
              ],
              value: view,
              onChange: onViewChange,
              ariaLabel: "切换版本、下载与设置",
              variant: "segmented",
            }),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 主组件

function ReleasesCard() {
  const [view, setView] = React.useState(VIEW_RELEASES);
  const [list, setList] = React.useState({ items: [], total: 0, offset: 0 });
  const [index, setIndex] = React.useState(0);
  const [details, setDetails] = React.useState({});
  const [appState, setAppState] = React.useState(null);
  const [status, setStatus] = React.useState("loading");
  const [error, setError] = React.useState(null);
  const [detailError, setDetailError] = React.useState(null);
  const [checking, setChecking] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [downloading, setDownloading] = React.useState({});
  const [downloadingVersion, setDownloadingVersion] = React.useState(false);
  /**
   * 操作结果的反馈走宿主 toast，不占版面。
   *
   * 这些是一次性事件（检查完了、下载失败了、已排队），用完就该消失；
   * 放在卡片里会一直占着版面，而它们不是页面的稳定状态。
   * 页面本身的稳定状态（没有变更、附件还在取）仍然用内联 Notice。
   *
   * toast.show 是宿主唯一对 card 槽位开放、且不需授权的交互能力，正好用在这。
   */
  const setNotice = React.useCallback((message, tone) => {
    if (!message) return;
    const type = tone === "warn" ? "warning" : tone === "ok" ? "success" : "info";
    try {
      hana.toast.show({ message, type });
    } catch {
      // toast 通道不可用时也不能把流程挂住，这条消息只是没弹出来。
    }
  }, []);

  /**
   * 冷启动只自动发起一次回填。
   *
   * 用 ref 而不是 state：发起动作会改 state，而 state 进依赖数组就会重启 effect，
   * 每一轮都多排一个定时器。后端自己也会去重（已在跑就返回 started:false），
   * 但这个门让页面这边也不会反复发请求。
   */
  const coldStartRef = React.useRef(false);

  const currentItem = list.items[index] ?? null;
  const currentTag = currentItem?.tag ?? null;
  const currentDetail = currentTag ? details[currentTag] ?? null : null;

  const loadState = React.useCallback(async () => {
    try {
      const next = await api("state");
      setAppState(next);
      return next;
    } catch (err) {
      return null;
    }
  }, []);

  const loadPage = React.useCallback(async () => {
    return api("releases?limit=" + FETCH_LIMIT + "&offset=0");
  }, []);

  /**
   * 已取回的详情缓存。
   *
   * 用 ref 而不是直接读 details state：loadDetail 若依赖 details，它每次缓存写入
   * 都会换一个新函数，而 boot 又依赖 loadDetail、挂载 effect 又依赖 boot —— 三者
   * 串成一个闭环，页面会无限重拉。ref 让 loadDetail 保持稳定。
   */
  const detailsRef = React.useRef({});

  const loadDetail = React.useCallback(async (tag, force) => {
    if (!tag) return null;
    if (!force && detailsRef.current[tag]) return detailsRef.current[tag];
    const detail = await api("releases/" + encodeURIComponent(tag) + (force ? "?refresh=1" : ""));
    detailsRef.current = { ...detailsRef.current, [tag]: detail };
    setDetails(detailsRef.current);
    return detail;
  }, []);

  /** 首屏：列表、状态、第一版详情一起拉。 */
  /**
   * 首屏：列表与状态并行，详情单独发。
   *
   * 详情不当成就绪的前提：它只是一个次要请求，挂了也不该让整张卡停在
   * “正在读”。所以三个都并行发，列表和状态一到就把卡置为 ready，详情回来
   * 再填进去。
   */
  const boot = React.useCallback(async () => {
    setStatus("loading");
    setError(null);
    setNotice(null);
    try {
      const [page, state] = await Promise.all([loadPage(), api("state")]);
      setList({ items: page.items ?? [], total: page.total ?? 0, offset: 0 });
      setAppState(state);
      setIndex(0);
      setStatus("ready");

      const first = page.items?.[0];
      if (first?.tag) {
        // 不 await：详情晚到就晚渲染，不拦住任何东西。
        loadDetail(first.tag, false).catch((err) => setDetailError(err));
      }
    } catch (err) {
      setError(err);
      setStatus("error");
    }
  }, [loadPage, loadDetail]);

  React.useEffect(() => {
    boot();
  }, [boot]);

  React.useEffect(() => {
    if (currentDetail || detailError || !currentTag) {
      setDetailSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setDetailSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [currentDetail, detailError, currentTag]);

  /**
   * 附件清单是后台补的：正文先到，清单晚一步。
   *
   * 这里在“正文到了但清单还没到”时再拉一次详情，把清单接上。只补一次，
   * 避免清单真的取不到时无限重试。
   */
  const assetsRetryRef = React.useRef(new Set());
  React.useEffect(() => {
    if (!currentTag || !currentDetail) return undefined;
    if (currentDetail.assetsLoaded !== false) return undefined;
    if (assetsRetryRef.current.has(currentTag)) return undefined;
    assetsRetryRef.current.add(currentTag);

    const timer = setTimeout(() => {
      loadDetail(currentTag, true).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [currentTag, currentDetail, loadDetail]);

  /**
   * 本次会话里“刚长出来”的 tag，用于入场动画。几秒后自动清空。
   *
   * 回填是从最新往旧一条条入库的，所以每轮 /state 回来时列表都会多几条。
   * 把新增的标记出来做个淡入，用户就能看见“一条条长出来”而不是“整表一闪”。
   */
  const [justArrived, setJustArrived] = React.useState(() => new Set());
  const freshTimer = React.useRef(null);

  /**
   * 详情读得比平时久时把重试入口露出来。
   *
   * 正常一个详情请求是毫秒级。如果它一直不回来，界面就卡在“正在读”上、什么
   * 出口也没有。超过这个时限就把“重试”摆出来。
   */
  const [detailSlow, setDetailSlow] = React.useState(false);

  React.useEffect(
    () => () => {
      if (freshTimer.current) clearTimeout(freshTimer.current);
    },
    [],
  );

  /**
   * 合并新拉到的列表，并按 diff 标出新增项。
   *
   * 内容完全没变就返回旧引用，避免无意义的 re-render（面板推送也会跟着少一次）。
   */
  const mergeList = React.useCallback((incoming, total) => {
    setList((prev) => {
      const next = Array.isArray(incoming) ? incoming : [];
      const known = new Set(prev.items.map((item) => item.tag));
      const fresh = next.filter((item) => item?.tag && !known.has(item.tag)).map((item) => item.tag);
      if (next.length === prev.items.length && next[0]?.tag === prev.items[0]?.tag) return prev;

      if (fresh.length > 0) {
        setJustArrived((old) => {
          const merged = new Set(old);
          for (const tag of fresh) merged.add(tag);
          return merged;
        });
        if (freshTimer.current) clearTimeout(freshTimer.current);
        freshTimer.current = setTimeout(() => {
          setJustArrived(new Set());
          freshTimer.current = null;
        }, 4000);
      }

      return { items: next, total: Number(total) || next.length, offset: 0 };
    });
  }, []);

  /**
   * 每次打开页面都跑一次回填。
   *
   * 库里已有的版本是本地读（不发请求），没有的才去取 digest 并落库，所以这个
   * 动作天然幂等：链完整时一遍下来只花一次状态查询。
   *
   * 首轮拉列表、然后**只等事件**：后端每入库一版推一次 oh-releases:backfill，
   * 前端收到就查一次库。新增条目的节奏就等于回填的入库节奏，不多一层定时器。
   * 定时器只在“事件通道完全不可用”时才上路，那时候只能靠它。
   */
  React.useEffect(() => {
    if (status !== "ready") return undefined;

    let cancelled = false;
    let timer = null;
    let stopped = false;

    /** 兵底：只在事件没到时定期自查。 */
    const armFallback = () => {
      if (cancelled || stopped) return;
      timer = setTimeout(async () => {
        if (cancelled || stopped) return;
        const state = await loadState();
        if (cancelled || stopped) return;
        if (state?.backfill?.state === "running") {
          const page = await loadPage();
          if (!cancelled && !stopped) mergeList(page.items, page.total);
          armFallback();
        }
      }, FALLBACK_POLL_MS);
    };

    /** 回填停下来之后收尾：把尾巴上的条目补齐，启定时检查。 */
    const settle = async () => {
      if (cancelled || stopped) return;
      const page = await loadPage();
      if (cancelled || stopped) return;
      mergeList(page.items, page.total);
      const state = await loadState();
      if (cancelled || stopped) return;
      if (state?.backfill?.state === "running") armFallback();
    };

    // 同一个页面生命周期内只起一次回填，避免重渲染反复打这个接口。
    // 回填期间的新条目由事件推过来；定时器只当兵底，所以起回填后不马上开始转。
    if (!coldStartRef.current) {
      coldStartRef.current = true;
      postJson("backfill", {})
        .then(() => armFallback())
        .catch((err) => {
          setNotice("获取历史版本失败：" + err.message, "warn");
          stopped = true;
        });
    } else {
      settle();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, loadState, loadPage, mergeList]);

  /*
   * 下载进行中时定时拉一次状态。
   *
   * 进度是服务端内存里的计数（jobs.progressDownload 写入），前端不会自己知道，
   * 而 loadState 只在明确动作后才调，所以不轮询就只能看到开始时的 0% 和
   * 结束时的“已完成”，中间那段永远是空的。
   *
   * 只在真有未完成的下载时转，没下载时完全不占轮询。
   */
  /**
   * 下载进行中时定时拉一次状态。
   *
   * 进度是服务端内存里的计数（jobs.progressDownload 写入），前端不会自己知道，
   * 而 loadState 只在明确动作后才调，所以不轮询就只能看到开始时的 0% 和
   * 结束时的“已完成”，中间那段永远是空的。
   *
   * 定时器只建一次，不看状态变化；每跳一下自己判断该不该停。
   * 否则依赖进状态会变成“每次刷新都重建定时器”，而状态从 running 变 completed
   * 时条目数没变，effect 根本不重跑，定时器停不下来。
   */
  const downloadsRef = React.useRef([]);
  downloadsRef.current = Array.isArray(appState?.downloads) ? appState.downloads : [];

  const isActiveDownload = (list) =>
    list.some((item) => item && (item.state === "running" || item.state === "waiting"));

  React.useEffect(() => {
    if (!isActiveDownload(downloadsRef.current)) return undefined;

    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      if (!isActiveDownload(downloadsRef.current)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      loadState().catch(() => {});
    }, 600);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // 只看条目数：开始时建一次，到最终态时自己停。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState?.downloads?.length, loadState]);

  const goTo = React.useCallback(
    async (next) => {
      if (next < 0 || next >= list.total) return;
      setIndex(next);
      setDetailError(null);

      const item = list.items[next];
      if (item?.tag && !detailsRef.current[item.tag]) {
        try {
          await loadDetail(item.tag, false);
        } catch (err) {
          setDetailError(err);
        }
      }
    },
    [list, loadDetail],
  );

  /**
   * 功能面板（侧栏）：把版本列表推给宿主，由宿主用内置原语画。
   *
   * 面板是主卡的一块投影，不是第二个页面。用声明式契约推 sections，不必另写
   * 一份 html/js/css，也不必开一个第三方文档安全面。用户点哪一条由
   * panel.onEvent 回传，在这里转成 goTo。
   *
   * 面板只在卡片表面可用，拿不到 hana.panel 时就安静地跳过。
   */
  React.useEffect(() => {
    const panel = hana.panel;
    if (!panel || typeof panel.set !== "function") return undefined;

    // 槽位顺序（从宿主实际渲染反推）：title → meta → badge，badge 靠最右。
    // 要的排列是「版本 计数 日期」，所以计数走 meta、日期走 badge，
    // 两者对调才能得到计数在左、日期在右的结果。
    const items = list.items.slice(0, 200).map((item) => ({
      id: item.tag,
      title: shortTagOf(item.tag),
      subtitle: null,
      meta: countBadge(item.counts),
      badge: dateOf(item.generatedAt),
      selected: item.tag === currentTag,
    }));

    const sections = [{ kind: "list", id: "versions", items, emptyText: "还没有版本数据。" }];
    if (list.total > 0) {
      sections.push({ kind: "meta", id: "total", text: "共 " + list.total + " 个版本" });
    }

    panel.set({ sections }).catch(() => {
      // 面板不可用（不在卡片表面、宿主拒绝）时不影响主卡。
    });

    const off = panel.onEvent((event) => {
      if (!event || event.kind !== "select") return;
      const tag = event.itemId;
      if (!tag) return;
      const at = list.items.findIndex((item) => item.tag === tag);
      if (at < 0) return;
      // 侧栏列的是版本，点一下就该看到那个版本：正在设置里也要切回去，
      // 否则点了没反应。
      setView(VIEW_RELEASES);
      goTo(at);
    });
    return typeof off === "function" ? off : undefined;
  }, [list, currentTag, goTo]);

  const onCheck = React.useCallback(async () => {
    setChecking(true);
    setNotice(null);
    try {
      const result = await postJson("check", {});
      const fresh = result?.newVersions ?? [];
      if (result?.notModified) {
        setNotice("上游没有变化（304，零字节）。");
      } else if (fresh.length) {
        setNotice("发现 " + fresh.length + " 个新版本：" + fresh.join("、"), "ok");
        await boot();
      } else {
        setNotice("没有新版本。");
      }
      await loadState();
    } catch (err) {
      setNotice("检查失败：" + err.message, "warn");
    } finally {
      setChecking(false);
    }
  }, [boot, loadState]);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      await boot();
      await loadState();
    } finally {
      setRefreshing(false);
    }
  }, [boot, loadState]);

  const onDownload = React.useCallback(
    async (tag, asset) => {
      const key = tag + "/" + asset.name;
      setDownloading((prev) => ({ ...prev, [key]: true }));
      setNotice(null);
      try {
        const result = await postJson("download", { tag, name: asset.name });
        setNotice(
          result?.started === false
            ? asset.name + " 已经在下载。"
            : "已开始下载 " + asset.name + "。",
        );
      } catch (err) {
        setNotice("下载失败：" + err.message, "warn");
      } finally {
        setDownloading((prev) => ({ ...prev, [key]: false }));
        await loadState();
      }
    },
    [loadState],
  );

  /** 下载所有可安装的程序：只拿安装包，不含压缩包与清单。 */
  const onDownloadAll = React.useCallback(async () => {
    const assets = (currentDetail?.assets ?? []).filter(
      (a) => Boolean(a?.name) && isInstaller(a),
    );
    if (!assets.length || !currentTag) return;
    setDownloadingVersion(true);
    setNotice(null);
    try {
      for (const asset of assets) {
        await api("download", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag: currentTag, name: asset.name }),
        });
      }
      setNotice("已排队下载 " + assets.length + " 个文件。", "ok");
    } catch (err) {
      setNotice("批量下载失败：" + err.message, "warn");
    } finally {
      setDownloadingVersion(false);
      await loadState();
    }
  }, [currentDetail, currentTag, loadState]);

  /**
   * 后端事件：回填入库一版就拉一次列表，不靠定时轮询。
   *
   * 后端在 onProgress 里每入库一版推一次 oh-releases:backfill（state=progress），
   * 所以这里的节奏就是后端的真实入库节奏——一条推一次，没新条目就一条也不会来。
   * 轮询留着只当兵底：事件通道不可用、或者事件在页面没打开时发掉了，还能靠它
   * 把状态拉齐（见下一个 effect）。
   */
  React.useEffect(() => {
    const offs = [];
    const subscribe = (type, handler) => {
      try {
        offs.push(hana.appEvents.on(type, handler));
      } catch {
        // 事件通道不可用：靠下面的兵底轮询。
      }
    };

    subscribe("oh-releases:backfill", () => {
      // 不依赖 payload 的形状：收到就查库。后端只在“入库了一版”和“整个回填
      // 结束”时推这个事件，两种都该重拉一次列表，所以不需要分辨。
      loadState();
      loadPage()
        .then((page) => mergeList(page.items, page.total))
        .catch(() => {});
    });
    subscribe("oh-releases:download", () => loadState());
    subscribe("oh-releases:release", () => {
      loadState();
      loadPage()
        .then((page) => mergeList(page.items, page.total))
        .catch(() => {});
    });

    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          // 已经解绑。
        }
      }
    };
  }, [loadState]);

  // ---- 渲染

  const head = h(StatusHead, {
    state: appState,
    counts: appState?.counts ?? { versions: list.total },
    onRefresh,
    onCheck,
    refreshing,
    checking,
    view,
    onViewChange: setView,
  });

  /**
   * 下载视图。
   *
   * 和设置共用外层的滚动容器与间距，只是内容不同。下载列表可能很长，
   * 所以它自带滚动而不是把整张卡拉高。
   */
  if (view === VIEW_DOWNLOADS) {
    return h(
      "div",
      { className: "or-card" },
      head,
      h(
        "div",
        { className: "or-set-body" },
        h(
          "div",
          { className: "or-set-view" },
          h(DownloadsPanel, { onToast: (message, tone) => setNotice(message, tone) }),
        ),
      ),
    );
  }

  /**
   * 设置视图。
   *
   * 顶栏共用：切换开关在它里面，两个视图才像是在同一张卡上切开的两半。
   * 保存后把 /state 重拉一次，顶栏的“定时检查已暂停”之类的提示才不会滞后。
   */
  if (view === VIEW_SETTINGS) {
    return h(
      "div",
      { className: "or-card" },
      head,
      h(
        "div",
        { className: "or-set-body" },
        h(
          "div",
          { className: "or-set-view" },
          h(SettingsPanel, { onSaved: () => loadState().catch(() => {}) }),
        ),
      ),
    );
  }

  if (status === "loading") {
    return h(
      "div",
      { className: "or-card" },
      head,
      h("div", { className: "or-state" }, h(Busy, { label: "正在载入版本…" })),
    );
  }

  if (status === "error") {
    return h(
      "div",
      { className: "or-card" },
      head,
      h(
        "div",
        { className: "or-state" },
        h(ErrorState, {
          title: "读不到版本数据",
          message: error?.message ?? "未知错误",
          action: h(Button, { variant: "secondary", size: "sm", onClick: boot }, "重试"),
        }),
      ),
    );
  }

  const downloads = Array.isArray(appState?.downloads) ? appState.downloads : [];
  const backfillRunning = appState?.backfill?.state === "running";

  // 只在真的没有任何数据时才用空态占位。回填进行中已经有条目时照常展示，
  // 不逼用户等它跑完——回填可能走上百步，干等一张空卡没有道理。
  if (list.total === 0) {
    const progress = appState?.backfill?.progress ?? null;
    const storedCount = Number.isFinite(progress?.stored) ? progress.stored : null;
    return h(
      "div",
      { className: "or-card" },
      head,
      h(
        "div",
        { className: "or-body" },
        h(
          "div",
          { className: "or-inner" },
          h(
            "div",
            { className: "or-state" },
            h(EmptyState, {
              title: backfillRunning ? "正在获取历史版本" : "还没有版本数据",
              description: backfillRunning
                ? "首条版本取回来就会出现在这里，不必等它全部跑完。"
                : "点“检查”手动取一次，或等定时检查到点。",
              action: h(
                Button,
                { variant: "secondary", size: "sm", onClick: onRefresh },
                "刷新看看",
              ),
            }),
            backfillRunning && storedCount === null
              ? h(Busy, { label: "正在回填…" })
              : null,
          ),
        ),
      ),
    );
  }

  const assetProgress = {};
  for (const record of downloads) {
    if (record && typeof record.key === "string") assetProgress[record.key] = record;
  }

  /**
   * 资产区：安装包 / 压缩包 / 清单与校验，三组平行。
   *
   * 独立成一个元素而不是塞在版本内容的 FadeIn 里：宽屏时它要作为右栏单独
   * 定位（见 releases.css 的 @media 段），只有独立的直接子元素才能进 grid。
   */
  const assetsBlock = (() => {
    if (!Array.isArray(currentDetail?.assets) || currentDetail.assets.length === 0) return null;
    const groups = groupAssets(currentDetail.assets);

    /** 一组附件：小标题 + 计数 + 用途 + 行。空组不渲染。 */
    const group = (key, title, hint, list, action) =>
      list.length
        ? h(
            "div",
            { className: "or-asset-group", key },
            h(
              "div",
              { className: "or-asset-group__head" },
              h("h3", { className: "or-asset-group__title" }, title),
              h("span", { className: "hs-caption" }, String(list.length)),
              hint ? h("span", { className: "or-asset-group__hint" }, hint) : null,
              action ? h("span", { className: "or-asset-group__action" }, action) : null,
            ),
            h(
              "ul",
              { className: "or-assets" },
              list.map((asset) =>
                h(AssetRow, {
                  key: asset.name,
                  tag: currentTag,
                  asset,
                  progress: assetProgress[currentTag + "/" + asset.name] ?? null,
                  onDownload,
                  downloading: Boolean(downloading[currentTag + "/" + asset.name]),
                }),
              ),
            ),
          )
        : null;

    return h(
      "div",
      { className: "hs-section or-assets-aside" },
      h(
        "div",
        { className: "hs-section-head" },
        h("h2", { className: "hs-heading" }, "资产"),
        h("span", { className: "hs-caption" }, currentDetail.assets.length + " 个文件"),
      ),
      group(
        "installers",
        "安装包",
        "双击安装",
        groups.installers,
        groups.installers.length
          ? h(
              Button,
              { variant: "ghost", size: "sm", loading: downloadingVersion, onClick: onDownloadAll },
              "全部下载",
            )
          : null,
      ),
      group("archives", "压缩包", "解压后使用", groups.archives, null),
      group("extras", "清单与校验", "自动更新与校验用", groups.extras, null),
    );
  })();

  // 版本头与摘要固定在卡片上部，不在滚动区里——这样它和资产栏不会
  // 在同一个滚动层里争位置。
  const pinned = h(
    CardErrorBoundary,
    { resetKey: currentTag, onReset: () => goTo(0) },
    h(
      "div",
      { className: "or-pinned" },
      h(
        "div",
        { className: "or-pinned__inner" },
        h(
          FadeIn,
          { key: currentTag ?? "empty", preset: "paperGentle", className: "or-fade" },
          h(VersionHeader, {
            item: currentItem,
            detail: currentDetail,
            isFresh: Boolean(currentItem?.tag && justArrived.has(currentItem.tag)),
          }),
          currentDetail
            ? h(
                "div",
                { className: "or-panel" },
                h("p", { className: "or-summary" }, pickText(currentDetail.summary) ?? "这一版没有摘要。"),
              )
            : null,
          detailError
            ? h(ErrorState, {
                title: "这一版的详情读不出来",
                message: detailError.message,
                action: h(
                  Button,
                  {
                    variant: "secondary",
                    size: "sm",
                    onClick: () => {
                      setDetailError(null);
                      loadDetail(currentTag, true).catch((err) => setDetailError(err));
                    },
                  },
                  "重试",
                ),
              })
            : null,
          !currentDetail && !detailError
            ? h(
                "div",
                { className: "or-state" },
                h(Busy, { label: "正在读这一版的内容…" }),
                detailSlow
                  ? h(
                      "div",
                      { className: "or-slow" },
                      "比平时久了一些。",
                      h(
                        Button,
                        {
                          variant: "secondary",
                          size: "sm",
                          onClick: () => {
                            setDetailError(null);
                            loadDetail(currentTag, true).catch((err) => setDetailError(err));
                          },
                        },
                        "重试",
                      ),
                    )
                  : null,
              )
            : null,
        ),
      ),
    ),
  );

  const body = h(
    "div",
    { className: "or-body" },
    h(
      CardErrorBoundary,
      { resetKey: currentTag, onReset: () => goTo(0) },
      h(
        "div",
        { className: "or-inner" },
        // 变更条目在左栏。
        h(
          "div",
          { className: "or-main" },
          h(
            "div",
            { className: "or-scroll" },
            Array.isArray(currentDetail?.items) && currentDetail.items.length
              ? h(
                  "div",
                  { className: "hs-section" },
                  h(
                    "div",
                    { className: "hs-section-head" },
                    h("h2", { className: "hs-heading" }, "变更"),
                    h("span", { className: "hs-caption" }, currentDetail.items.length + " 条"),
                  ),
                  /* 自己包一层来管条间距：AnimatedList 内部会再套动效元素，
                     它的 className 落在哪一层不可控。 */
                  h(
                    "div",
                    { className: "or-items" },
                    h(
                      AnimatedList,
                      { layoutId: "or-items-" + currentTag },
                      currentDetail.items.map((item, i) => h(ItemEntry, { key: item?.id ?? i, item, index: i })),
                    ),
                  ),
                )
              : null,
            Array.isArray(currentDetail?.items) && currentDetail.items.length === 0
              ? h(Notice, null, "这一版没有分条列出变更，看看上面的摘要。")
              : null,
            currentDetail?.noUserFacingChanges === true
              ? h(Notice, null, "这一版没有面向使用者的变化。")
              : null,
          ),
        ),
        assetsBlock,
        h(
          "div",
          { className: "or-aside-notes" },
          currentDetail && currentDetail.assetsLoaded === false && !currentDetail.assets?.length
            ? h(Notice, null, "附件清单还在取……")
            : null,
          currentDetail && currentDetail.assetsError
            ? h(Notice, { tone: "warn" }, "附件清单没取到：" + (currentDetail.assetsError.message ?? "网络问题"))
            : null,
          currentDetail &&
          Array.isArray(currentDetail.assets) &&
          currentDetail.assets.length === 0 &&
          currentDetail.assetsLoaded
            ? h(Notice, null, "这一版没有上传附件。")
            : null,
        ),
      ),
    ),
  );

  // 数据来源钉在卡底：它是常驻的低价值信息，跟着正文滚动会一直占着视线。
  // 只展示不做成链接：宿主的界面能力白名单里，external.open 不含 card 槽位，
  // 而这面卡就是 card 槽位；服务端与客户端分开部署后，让服务器开浏览器也不对。
  const foot = currentDetail
    ? h(
        "div",
        { className: "or-source" },
        h(
          "div",
          { className: "or-source__inner" },
          h("span", { className: "or-source__label" }, "数据来源："),
          h(
            "span",
            { className: "or-source__url", title: currentDetail.sourceUrl ?? "" },
            formatSourceUrl(currentDetail.sourceUrl),
          ),
        ),
      )
    : null;

  return h("div", { className: "or-card" }, head, pinned, body, foot);
}

// ---------------------------------------------------------------- 挂载

/** 整卡级错误边界：任何未捕获的渲染/生命周期错误都在这里停下来，给出可见的错误。 */
class RootBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // 控制台也留一份，方便在开发者工具里看完整堆栈。
    try {
      console.error("[oh-releases] 页面出错：", error);
    } catch {
      // 忽略
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return h(
      "div",
      { className: "or-crash" },
      h("div", { className: "or-crash__title" }, "OH Releases 没能显示出来"),
      h("div", { className: "or-crash__body" }, String(error?.message ?? error)),
      h(
        "div",
        { className: "or-crash__hint" },
        "这是页面自身的问题，不影响已经取回的版本数据。点下面重试，或者去设置页看状态。",
      ),
      h(
        "button",
        {
          type: "button",
          className: "or-crash__btn",
          onClick: () => window.location.reload(),
        },
        "重新加载",
      ),
    );
  }
}

const container = document.getElementById("root");

if (container) {
  container.textContent = "";
  // AppUiProvider 是必需的：它挂出 [data-hana-app-ui]，而 @hana/app-sdk/components.css
  // 的规则全部限定在这个属性下面。少了它，宿主控件会渲染出没有样式的裸元素。
  //
  // 它自己也渲染一层 div（默认只带 min-width:0，高度是 auto）。卡面要撑满整块，
  // 就必须把这一层也铺满，否则 .or-card 的 height:100% 无从解析、底部的翻页条会
  // 跑到可见区外面去。样式写在 releases.css 的 .or-host 里。
  //
  // 错误边界必须包在**整张卡外面**：卡自己的 effect、事件处理、数据装载都可能
  // 抛异常，只包住内容区接不住它们，整页依旧变白屏。
  createRoot(container).render(
    h(
      RootBoundary,
      null,
      h(AppUiProvider, { className: "or-host" }, h(ReleasesCard)),
    ),
  );
}

