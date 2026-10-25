import { hana } from "@hana/app-sdk/ui";
import React from "react";
import {
  Button,
  Busy,
  ErrorState,
  Inline,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Tabs,
  TextInput,
} from "@hana/app-sdk/components";
import { assetGroupOf, stripVersion } from "./asset-display.js";

/**
 * 主页里的设置视图（ui/src/releases.js 调用）。
 *
 * 读写都走本 App 自己的后端路由：GET /settings 取当前值与上限，PUT /settings 保存。
 * 配置的真相在 App 的库里（src/lib/settings.js）。
 *
 * 它是一个视图，不是独立页面：外层由主页给滚动容器，这里不自己管高度和滚动。
 */

const h = React.createElement;

/** 直连 GitHub 时显示的地址（与后端拼出来的那条一致）。 */
const OFFICIAL_SOURCE = "https://github.com";

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

function putSettings(payload) {
  return api("settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------- 小工具

/** 后端把字段名放在 error.field 里；把它翻成人看得懂的那一栏。 */
const FIELD_LABEL = {
  pollIntervalSec: "轮询间隔",
  autoDownloadSuffixes: "自动下载",
  autoDownload: "自动下载",
  downloadDir: "下载目录",
  mirror: "下载源",
  body: "请求体",
};

function fieldLabel(field) {
  if (!field) return null;
  return FIELD_LABEL[String(field)] ?? String(field);
}

function formatInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + " 秒";
  if (sec < 3600) return Math.round(sec / 60) + " 分钟";
  return (sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1) + " 小时";
}

/** 字节数 → “592 MB” 这类读数。用 1024 进制，与安装包页上 GitHub 显示的一致。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded + " " + units[unit];
}

/** 从 hana.resources.pick 的结果里取出一个目录路径。 */
function pathFromPick(result) {
  const list = Array.isArray(result?.resources) ? result.resources : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.path === "string" && item.path) return item.path;
    if (typeof item.filePath === "string" && item.filePath) return item.filePath;
  }
  return null;
}

// ---------------------------------------------------------------- 组件

/** 一条提示。tone: "info" | "warn" | "error"。 */
function Notice({ tone, title, children }) {
  if (!title && !children) return null;
  const cls =
    "or-set-notice" +
    (tone === "warn" ? " or-set-notice--warn" : "") +
    (tone === "error" ? " or-set-notice--error" : "");
  return h(
    "div",
    { className: cls },
    title ? h("div", { className: "or-set-notice__title" }, title) : null,
    children ? h("div", { className: "or-set-notice__body" }, children) : null,
  );
}

/** 时间戳 → “X 分钟前 / X 小时后”这类相对读数。解析不出来就返回 null。 */
function relativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  const minutes = Math.floor(abs / 60000);
  const say =
    minutes < 1
      ? "刚刚"
      : minutes < 60
        ? minutes + " 分钟"
        : abs < 86400000
          ? Math.floor(minutes / 60) + " 小时"
          : Math.floor(abs / 86400000) + " 天";
  // “刚刚”开头的词接“前/后”都说不通：未来的“下次刚刚”读不成话，说“马上”。
  if (say === "刚刚") return delta >= 0 ? "刚刚" : "马上";
  return delta >= 0 ? say + "前" : say + "后";
}

/** 一句能说明“这条计划到底跑没跑”的读数：跑过几次、上一次什么时候。 */
function runSummary(schedule) {
  const runs = Number.isFinite(schedule?.runCount) ? schedule.runCount : 0;
  const last = relativeTime(Number(schedule?.lastRunAt));
  if (runs === 0) return "这条计划一次都没触发过。";
  return "已运行 " + runs + " 次" + (last ? "，上一次在 " + last : "") + "。";
}

/** 挂起理由的机器名 → 用户能看懂的说法。未知理由原样给。 */
const SUSPENSION_LABEL = {
  app_uninstalled: "App 曾被卸载过（重装后留下的旧标记）",
  app_disabled: "App 被停用了",
  crash_restart: "App 崩溃后等待重启",
  stopped: "App 已停止",
  permission_revoked: "app/tasks.manage 授权被收回了",
};

function suspensionText(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return reasons.map((key) => SUSPENSION_LABEL[key] ?? key).join("、");
}

/**
 * 定时轮询能不能真的跑——用户设了间隔却什么都没发生时最需要看到的一句话。
 *
 * 只有拿到“确实跑过且没出错”的证据才说正常，所以正常那一条也带上运行次数，
 * 不拿一句空口白话充数。其余分支都给一个“恢复定时检查”的出口：用户看到的是
 * 异常，但修它的动作只有这一个。
 */
function SchedulingPanel({ scheduling, schedule, onResume, resuming }) {
  if (!scheduling) return null;

  const resumeButton = h(
    Button,
    { variant: "secondary", size: "sm", loading: resuming, onClick: onResume },
    "恢复定时检查",
  );

  if (scheduling.reason === "missing-permission") {
    return h(Notice, {
      tone: "error",
      title: "定时检查不会触发：缺少 app/tasks.manage 授权",
      children: h(
        "div",
        null,
        h("p", null, "间隔会照常保存，但这个授权没给时宿主不会到点唤起这个 App 的定时计划。"),
        h("p", null, "去 设置 → 应用 → 能力 里给 oh-releases 授予 app/tasks.manage，或者直接在这个页面用“检查”按钮手动更新。"),
      ),
    });
  }

  if (scheduling.reason === "no-schedule") {
    return h(Notice, {
      tone: "warn",
      title: "还没有定时计划",
      children: h(
        "div",
        null,
        h("p", null, "间隔已经保存，但计划尚未创建，到点不会检查。"),
        h("div", { className: "or-set-notice__action" }, resumeButton),
      ),
    });
  }

  if (scheduling.reason === "paused") {
    return h(Notice, {
      tone: "warn",
      title: "定时计划被暂停了",
      children: h(
        "div",
        null,
        h("p", null, "计划存在但当前是暂停状态，到点不会触发。" + runSummary(schedule)),
        h("div", { className: "or-set-notice__action" }, resumeButton),
      ),
    });
  }

  if (scheduling.reason === "suspended") {
    return h(Notice, {
      tone: "warn",
      title: "定时检查被宿主挂起了",
      children: h(
        "div",
        null,
        h("p", null, "原因：" + (suspensionText(scheduling.suspension) ?? scheduling.message ?? "未知") + "。"),
        h("p", null, "挂起期间计划仍是启用状态，宿主也会算出下次时间，但调度器每次都跳过它。" + runSummary(schedule)),
        h("div", { className: "or-set-notice__action" }, resumeButton),
      ),
    });
  }

  if (scheduling.reason === "never-ran") {
    return h(Notice, {
      tone: "warn",
      title: "定时检查到点了却没跑",
      children: h(
        "div",
        null,
        h(
          "p",
          null,
          "原定 " +
            (relativeTime(Number(schedule?.nextRunAt)) ?? "某个时间") +
            "该跑一次，但到现在一次都没触发过。",
        ),
        h("div", { className: "or-set-notice__action" }, resumeButton),
      ),
    });
  }

  if (scheduling.reason === "last-run-failed") {
    return h(Notice, {
      tone: "warn",
      title: "上一次定时检查失败了",
      children: h(
        "div",
        null,
        h("p", null, scheduling.message ?? "宿主没有给出更多信息。"),
        h("p", null, runSummary(schedule)),
      ),
    });
  }

  // 正常时不出声：顶栏已经写了“上次检查 X 前”，那是同一份事实。再给一块
  // “定时检查正常”只是把它换句话重复一遍，还占掉了页面上最显眼的位置。
  // 只有不正常（缺授权、没计划、被暂停、被挂起、到点未跑、上次失败）才需要
  // 一块地方解释原因并给恢复入口。
  return null;
}

/**
 * 下载源：一行。
 *
 * 默认直连 GitHub；要用镜像就点“修改”，填一个反代前缀（例如
 * `https://ghproxy.net`），下载时拼成 `<前缀>/github.com/<owner>/<repo>/…`。
 * App 不内置任何镜像，用哪条线路由用户自己决定。
 */
function SourceRow({ mirror, probe, onSave }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(mirror);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setDraft(mirror);
  }, [mirror]);

  const current = mirror || OFFICIAL_SOURCE;
  const probeText =
    probe === null || probe === undefined
      ? null
      : probe.state === "unreachable"
        ? "上次探测连不上"
        : probe.supportsRange === true
          ? "上次探测可用 · 支持断点续传"
          : probe.supportsRange === false
            ? "上次探测可用 · 不支持断点续传"
            : "上次探测可用";

  const commit = React.useCallback(
    async (value) => {
      setSaving(true);
      setError(null);
      try {
        await onSave(value);
        setEditing(false);
      } catch (err) {
        setError(err);
      } finally {
        setSaving(false);
      }
    },
    [onSave],
  );

  return h(SettingsRow, {
    label: "下载源",
    hint: probeText ?? "安装包从这里下载。留空即直连 GitHub。",
    layout: "stacked",
    control: editing
      ? h(
          "div",
          { className: "or-source-edit" },
          h(TextInput, {
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            spellCheck: false,
            autoFocus: true,
            placeholder: "https://mirror.example/",
            "aria-label": "下载源前缀",
            onKeyDown: (event) => {
              if (event.key === "Enter") commit(draft);
              if (event.key === "Escape") {
                setDraft(mirror);
                setEditing(false);
                setError(null);
              }
            },
          }),
          h(
            Inline,
            { gap: "sm", align: "center" },
            h(
              Button,
              { variant: "primary", size: "sm", loading: saving, onClick: () => commit(draft) },
              "保存",
            ),
            h(
              Button,
              {
                variant: "ghost",
                size: "sm",
                onClick: () => {
                  setDraft(mirror);
                  setEditing(false);
                  setError(null);
                },
              },
              "取消",
            ),
          ),
          error ? h("div", { className: "or-source-error" }, error.message) : null,
        )
      : h(
          "div",
          { className: "or-source-view" },
          h("code", { className: "or-set-mono" }, current),
          h(
            Inline,
            { gap: "sm", align: "center" },
            h(
              Button,
              { variant: "secondary", size: "sm", onClick: () => setEditing(true) },
              "修改",
            ),
            mirror
              ? h(
                  Button,
                  { variant: "ghost", size: "sm", loading: saving, onClick: () => commit("") },
                  "恢复官方",
                )
              : null,
          ),
        ),
  });
}

/**
 * 自动下载：按后缀多选，分组与命名跟下载页一致。
 *
 * 选项来自最近一次更新（库里最新那版）的安装包条目。勾的单位是后缀：后缀决定
 * 这个文件是什么、能不能装，版本号只是同一种东西的不同变体。
 *
 * 展示沿下载页那套：按“安装包 / 压缩包”分组，名字去掉版本号（版本号已经不提供
 * 信息量，抹掉后剩下平台与架构才看得清），右侧给大小。同一个后缀下有多份时
 * 合一行并标出份数。已勾但本版没发的后缀仍然列出，否则用户以为配置被删了。
 */
function AutoDownloadRow({ choices, selected, onChange }) {
  const items = Array.isArray(choices?.items) ? choices.items : [];
  const set = new Set(selected);

  const toggle = (suffix) => {
    const next = selected.includes(suffix)
      ? selected.filter((item) => item !== suffix)
      : [...selected, suffix];
    onChange(next);
  };

  if (!items.length) {
    return h(SettingsRow, {
      label: "自动下载安装包",
      hint: "还没有可选的安装包：先跑一次检查，等最新版本的附件清单入库后，这里会按后缀列出条目。",
      control: h("span", { className: "or-set-muted" }, "暂无可选项"),
    });
  }

  const count = selected.length;
  const tag = choices?.tag ?? null;

  const row = (item) => {
    const checked = set.has(item.suffix);
    const group = assetGroupOf(item.suffix);
    const shownName =
      item.present === false || !item.name ? "." + item.suffix : stripVersion(item.name, tag);
    const extras = [
      item.present === false ? "本版没有" : null,
      item.names && item.names.length > 1 ? "本版 " + item.names.length + " 份" : null,
    ].filter(Boolean);
    return h(
      "label",
      {
        key: item.suffix,
        className:
          "or-assetlist__row" +
          (checked ? " or-assetlist__row--on" : "") +
          (item.present === false ? " or-assetlist__row--missing" : ""),
        title: item.name ? "完整文件名：" + item.name : undefined,
      },
      h("input", {
        type: "checkbox",
        checked,
        onChange: () => toggle(item.suffix),
        className: "or-assetlist__check",
      }),
      h("span", { className: "or-assetlist__name" }, shownName),
      h(
        "span",
        { className: "or-assetlist__meta" },
        extras.length ? extras.join(" · ") : group === "archive" ? "解压后使用" : "",
      ),
      h("span", { className: "or-assetlist__size" }, item.size ? formatBytes(item.size) : ""),
    );
  };

  const installers = items.filter((item) => assetGroupOf(item.suffix) === "installer");
  const archives = items.filter((item) => assetGroupOf(item.suffix) === "archive");
  const others = items.filter((item) => assetGroupOf(item.suffix) === "extra");

  const groupHead = (title, hint, list) =>
    list.length
      ? h(
          "div",
          { className: "or-assetlist__group" },
          h(
            "div",
            { className: "or-assetlist__grouphead" },
            h("span", { className: "or-assetlist__grouptitle" }, title),
            h("span", { className: "or-assetlist__groupcount" }, String(list.length)),
            hint ? h("span", { className: "or-assetlist__grouphint" }, hint) : null,
          ),
          list.map(row),
        )
      : null;

  return h(SettingsRow, {
    label: "自动下载安装包",
    hint:
      (count ? "已选 " + count + " 种后缀，" : "未勾选任何项，") +
      "发现新版本时把这类文件各下一份，后缀跨版本不变。清单取自 " +
      (tag ?? "最新版本") +
      "。",
    layout: "stacked",
    control: h(
      "div",
      { className: "or-assetlist", role: "group", "aria-label": "自动下载的安装包" },
      groupHead("安装包", "双击安装", installers),
      groupHead("压缩包", "解压后使用", archives),
      groupHead("其他", null, others),
    ),
  });
}

// ---------------------------------------------------------------- 面板

export function SettingsPanel({ onSaved }) {
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);

  const [downloadPath, setDownloadPath] = React.useState("");
  // 默认落点由后端算（它才知道用户主目录在哪），页面只拿来展示与回退。
  const [defaultDir, setDefaultDir] = React.useState("");
  const [schedule, setSchedule] = React.useState(null);
  const [scheduling, setScheduling] = React.useState(null);

  // 表单值
  const [intervalSec, setIntervalSec] = React.useState(21600);
  const [autoDownloadSuffixes, setAutoDownloadSuffixes] = React.useState([]);
  const [downloadDir, setDownloadDir] = React.useState("");
  const [mirror, setMirror] = React.useState("");
  const [mirrorProbe, setMirrorProbe] = React.useState(null);

  // 可选项：检查间隔的档位、自动下载能勾的附件。
  const [intervals, setIntervals] = React.useState(null);
  const [assetChoices, setAssetChoices] = React.useState({ tag: null, items: [] });

  // 保存状态
  const [saveStatus, setSaveStatus] = React.useState("idle");
  const [saveError, setSaveError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [picking, setPicking] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);

  /**
   * 把服务端响应写回表单。
   *
   * 只覆盖响应里真实存在的字段：同一个函数被 GET /settings 与 PUT /settings 共用，
   * 两份响应带的东西不一样。以前缺字段时会被当成“清空”，保存一次就把可选项列表
   * 抹成空、提示“暂无可选项”。
   */
  const applyServerSettings = React.useCallback((payload) => {
    const settings = payload?.settings ?? {};
    if (typeof payload?.downloadPath === "string") setDownloadPath(payload.downloadPath);
    if (typeof payload?.defaultDownloadDir === "string") setDefaultDir(payload.defaultDownloadDir);
    if (payload?.schedule !== undefined) setSchedule(payload.schedule ?? null);
    if (payload?.scheduling !== undefined) setScheduling(payload.scheduling ?? null);
    if (Array.isArray(payload?.intervals) && payload.intervals.length) setIntervals(payload.intervals);
    if (payload?.assetChoices && Array.isArray(payload.assetChoices.items)) {
      setAssetChoices(payload.assetChoices);
    }

    const savedInterval = Number.isInteger(settings.pollIntervalSec) ? settings.pollIntervalSec : 21600;
    const savedSuffixes = Array.isArray(settings.autoDownloadSuffixes) ? settings.autoDownloadSuffixes : [];
    setIntervalSec(savedInterval);
    setAutoDownloadSuffixes(savedSuffixes);
    setDownloadDir(typeof settings.downloadDir === "string" ? settings.downloadDir : "");
    setMirror(typeof settings.mirror === "string" ? settings.mirror : "");
    setMirrorProbe(settings.mirrorProbe ?? null);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await api("settings");
      applyServerSettings(payload);
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [applyServerSettings]);

  React.useEffect(() => {
    load();
  }, [load]);

  // ---- 恢复定时检查

  /**
   * 只动计划，不动设置。
   *
   * 它是“我看到上面那句话了，帮我修好”的出口：后端清掉过期挂起标记、必要时把
   * 计划建起来，然后把新快照回传，这一块提示自己就会变。
   */
  const resumeSchedule = React.useCallback(async () => {
    setResuming(true);
    setNotice(null);
    try {
      const payload = await api("schedule/resume", { method: "POST" });
      setSchedule(payload?.schedule ?? null);
      setScheduling(payload?.scheduling ?? null);
      setNotice({
        tone: "info",
        title: "定时检查已恢复",
        message: "宿主已重新认可这条计划。下一次触发时间见上方读数。",
      });
      if (typeof onSaved === "function") onSaved(payload);
    } catch (error) {
      setNotice({ tone: "error", title: "恢复失败", message: error.message });
    } finally {
      setResuming(false);
    }
  }, [onSaved]);

  // ---- 选目录

  const pickDirectory = React.useCallback(async () => {
    setPicking(true);
    setNotice(null);
    try {
      // 弹窗一出现，“多久选完”就完全取决于用户，不该有任何截止时间。
      // SDK 的请求默认 10 秒超时，慢慢翻两下目录就报 “Plugin host request
      // timed out”；它也不提供取消通道，只能把 timeoutMs 调到实际上等于
      // 不超时（一小时，远超任何人真会花的时间，又不碰 setTimeout 的上限）。
      const result = await hana.resources.pick(
        { mode: "directory" },
        { timeoutMs: 60 * 60 * 1000 },
      );
      const picked = pathFromPick(result);
      if (!picked) return; // 用户取消：resources 是空数组，什么都不改
      setDownloadDir(picked);
      // 选目录是明确动作，不必等防抖。这里直接写，成功与否在提示里说清楚。
      setSaveStatus("saving");
      try {
        const payload = await putSettings({ downloadDir: picked });
        applyServerSettings(payload);
        setSaveStatus("saved");
        setNotice({ tone: "info", title: "已保存", message: "以后的安装包会落到这个目录。" });
        if (typeof onSaved === "function") onSaved(payload);
      } catch (error) {
        setSaveStatus("idle");
        setNotice({
          tone: "error",
          title: "目录没能保存",
          message: (error.field ? fieldLabel(error.field) + "：" : "") + error.message,
        });
      }
    } catch (error) {
      setNotice({ tone: "error", title: "选择目录失败", message: error.message });
    } finally {
      setPicking(false);
    }
  }, [applyServerSettings, onSaved]);

  // ---- 自动保存
  //
  // 任何一项改动都立刻写回去，不再靠用户记得点“保存”。输入框（下载目录）
  // 要防抖：逐字发请求会一下子把好几个半截路径写进库里。
  //
  // 只传发生改变的那一个字段，不凑一整份设置：PUT 是部分更新，凑全量就得读
  // 闭包里的其他值，而闭包会滞后于用户的最近一次操作，会把刚改好的字段写回旧值。

  const commit = React.useCallback(
    async (patch) => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const payload = await putSettings(patch);
        applyServerSettings(payload);
        setSaveStatus("saved");
        if (payload?.warning) {
          setNotice({ tone: "warn", title: "已保存，但计划没能建起来", message: payload.warning });
        }
        if (typeof onSaved === "function") onSaved(payload);
      } catch (error) {
        setSaveStatus("idle");
        setSaveError(error);
        setNotice({
          tone: "error",
          title: "保存失败",
          message: (error.field ? fieldLabel(error.field) + "：" : "") + error.message,
        });
      }
    },
    [applyServerSettings, onSaved],
  );

  /** 选档位 / 勾条目这种离散操作：即时存。 */
  const saveNow = React.useCallback(
    (patch) => {
      void commit(patch);
    },
    [commit],
  );

  /** 文本输入：停下来 600ms 再存，不跟用户的击键赛跑。 */
  const pending = React.useRef(null);
  const pendingPatch = React.useRef(null);
  const saveDebounced = React.useCallback(
    (patch) => {
      pendingPatch.current = patch;
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        const queued = pendingPatch.current;
        pendingPatch.current = null;
        void commit(queued ?? patch);
      }, 600);
    },
    [commit],
  );

  // 离开页面前把还在防抖里的写入补上：用户输完就切视图，不该丢。
  React.useEffect(
    () => () => {
      if (!pending.current) return;
      clearTimeout(pending.current);
      pending.current = null;
      const queued = pendingPatch.current;
      pendingPatch.current = null;
      if (queued) void commit(queued);
    },
    [commit],
  );

  /** 下载源单独保存：它是一行即改即存的设置，不跟下面的草稿混在一起。 */
  const saveMirror = React.useCallback(
    async (value) => {
      setNotice(null);
      const payload = await putSettings({ mirror: value });
      applyServerSettings(payload);
      if (typeof onSaved === "function") onSaved(payload);
    },
    [applyServerSettings, onSaved],
  );

  // ---- 渲染

  if (loading) {
    return h("div", { className: "or-set-state" }, h(Busy, { label: "正在读取设置…" }));
  }

  if (loadError) {
    return h(
      "div",
      { className: "or-set-state" },
      h(ErrorState, {
        title: "读不到设置",
        message: loadError.message,
        action: h(Button, { variant: "secondary", size: "sm", onClick: load }, "重试"),
      }),
    );
  }

  // 提示交给区块说明与四档按钮本身：这一行原来写“最勤 1 分钟，最懒 24 小时”，
  // 那是校验区间的上下界，不是可选范围（页面上一共只四个按钮），写成上下界
  // 会让人以为能填任意秒数。
  const intervalHint = null;

  // 档位：后端给的四个可选值；当前值不在里面时（旧库里的 2 小时之类）补一个，
  // 否则用户会看到一个没有任何选项被选中的控件，而他其实存着一个有效值。
  const presetIntervals =
    Array.isArray(intervals) && intervals.length ? intervals : [1800, 3600, 21600, 86400];
  const intervalItems = presetIntervals.map((sec) => ({
    value: String(sec),
    label: formatInterval(sec * 1000),
  }));
  if (!presetIntervals.includes(intervalSec)) {
    intervalItems.push({ value: String(intervalSec), label: formatInterval(intervalSec * 1000) });
  }

  return h(
    SettingsPage,
    { tab: "oh-releases", className: "or-set-root" },
    h(
      SettingsStack,
      { gap: "lg" },

      h(SchedulingPanel, { scheduling, schedule, onResume: resumeSchedule, resuming }),

      h(
        SettingsSection,
        {
          title: "更新检查",
          description: "应用多久问一次有没有新版本。",
        },
        h(
          SettingsStack,
          { gap: "md", className: "or-set-stack" },
          h(SettingsRow, {
            label: "检查间隔",
            hint: intervalHint,
            control: h(
              "div",
              { className: "or-interval-tabs" },
              h(Tabs, {
                items: intervalItems,
                value: String(intervalSec),
                onChange: (next) => {
                  const sec = Number(next);
                  if (!Number.isFinite(sec)) return;
                  setIntervalSec(sec);
                  saveNow({ pollIntervalSec: sec });
                },
                ariaLabel: "检查间隔",
                variant: "segmented",
              }),
            ),
          }),
          h(AutoDownloadRow, {
            choices: assetChoices,
            selected: autoDownloadSuffixes,
            onChange: (next) => {
              setAutoDownloadSuffixes(next);
              saveNow({ autoDownloadSuffixes: next });
            },
          }),
        ),
      ),

      h(
        SettingsSection,
        {
          title: "下载",
          description: "安装包从哪来、落到哪去。",
          variant: "list",
        },
        h(
          SettingsStack,
          { gap: "md", className: "or-set-stack" },
          h(SourceRow, { mirror, probe: mirrorProbe, onSave: saveMirror }),
          h(SettingsRow, {
            label: "保存位置",
            hint: downloadPath ? "实际落盘位置：" + downloadPath : "可以是任意可写目录。",
            layout: "stacked",
            control: h(
              Inline,
              { gap: "sm", align: "center", wrap: true },
              h(TextInput, {
                value: downloadDir,
                onChange: (event) => {
                  const value = event.target.value;
                  setDownloadDir(value);
                  saveDebounced({ downloadDir: value });
                },
                spellCheck: false,
                placeholder: "选择或填写一个目录",
                className: "or-set-dirinput",
                "aria-label": "下载目录",
              }),
              h(
                Button,
                { variant: "secondary", size: "sm", loading: picking, onClick: pickDirectory },
                "选择",
              ),
              // 只在当前值不是默认值时才出现：已经用着默认目录的话，
              // 这个按钮按下去什么都不会变。
              defaultDir && downloadDir !== defaultDir
                ? h(
                    Button,
                    {
                      variant: "ghost",
                      size: "sm",
                      onClick: () => {
                        // 点按钮是明确动作，不必等防抖。
                        setDownloadDir(defaultDir);
                        saveNow({ downloadDir: defaultDir });
                      },
                    },
                    "恢复默认",
                  )
                : null,
            ),
          }),
        ),
      ),

      h(Notice, { tone: notice?.tone ?? "info", title: notice?.title }, notice?.message ?? null),

      saveError
        ? h(
            "div",
            { className: "or-set-error" },
            h("div", { className: "or-set-error__title" }, "保存失败"),
            saveError.field
              ? h("div", { className: "or-set-error__field" }, "字段：" + fieldLabel(saveError.field))
              : null,
            h("div", { className: "or-set-error__body" }, saveError.message),
          )
        : null,
    ),

    // 自动保存不需要一个“已保存”的牌位：安静生效就是预期行为。
    // 只在两种时候出声：正在写、或者写失败了。其余时候整行不占位。
    saveStatus === "saving" || saveError
      ? h(
          "div",
          { className: "or-set-savehint-row" },
          h(
            "span",
            { className: "or-set-savehint" + (saveError ? " or-set-savehint--error" : "") },
            saveError ? "改动没能保存" : "正在保存…",
          ),
        )
      : null,
  );
}
