import { hana } from "@hana/app-sdk/ui";
import React from "react";
import { Button, Busy, EmptyState, ErrorState, Tabs, Tooltip } from "@hana/app-sdk/components";

/**
 * 下载视图（ui/src/releases.js 调用）。
 *
 * 一件事：让用户看见下载在干什么，并且能插手。下载仍然从版本页发起，这里只做管理。
 *
 * 数据全部来自后端 /downloads，那个路由透传常驻下载服务的快照。所以这里看到的
 * 「连接数」是真的在开的连接数，不是页面自己算的估计值。
 *
 * ## 为什么不自己轮询
 *
 * 有任务在跑的时候才轮询（1 秒一拍），全部结束后停下来。没任务还一直问，等于
 * 让一个看不见的定时器持续打后端。
 */

const h = React.createElement;

/** 有任务在跑时的刷新间隔。连接数和速度是活的，慢了看着就像卡住。 */
const POLL_MS = 1000;

/**
 * 没任务时的刷新间隔。
 *
 * 下载是从版本页发起的，本页没有事件可听，只能靠轮询发现新任务。
 * 两秒一次、一次只读内存快照，开销可以忽略。
 */
const IDLE_POLL_MS = 2000;

/**
 * 总连接数的档位：1、2、4、8 … 1024。
 *
 * 并发数差一倍才算一档，微调没有意义；而界面上只放一对普通的加减按钮，
 * 保持和别处一致，不必让人先理解“这是指数控件”。
 *
 * 值始终是一个 2 的幂：只有这两个按钮和设置页会改它，两处都只走档位。
 */
const LIMIT_MAX = 1024;

/** 下一个档位（已到上限就不动）。 */
function nextPowerOfTwo(cur) {
  const v = Math.max(1, Number(cur) || 1);
  return Math.min(LIMIT_MAX, v << 1);
}

/** 上一个档位（已到 1 就不动）。 */
function prevPowerOfTwo(cur) {
  const v = Math.max(1, Number(cur) || 1);
  return Math.max(1, v >> 1);
}

const STATE_LABEL = {
  queued: "排队中",
  waiting: "等连接",
  running: "下载中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

/** 只有这几个状态还需要持续刷新。 */
const ACTIVE_STATES = new Set(["queued", "waiting", "running", "paused"]);

async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error?.message ?? "请求失败（" + response.status + "）";
    const error = new Error(message);
    error.code = body?.error?.code ?? "HTTP_" + response.status;
    throw error;
  }
  return body;
}

/**
 * 分片可视化。
 *
 * 横轴就是文件位置，每片画在它真正所在的地方。这样能看到几条连接各拿一段、
 * 一起往前推，而不是一根总进度条从 0 涨到 100%。
 *
 * 为什么不用「每片一根等宽柱」：片数会从 125 长到两三百，等宽柱后期会碎成一片，
 * 反而看不出在干什么。位置映射不会——片变小时它在那一段里变细，仍然对得上文件。
 *
 * 颜色分三种：已写完（实）、正在下（半透）、未开始（底）。
 * 「正在下」怎么分辨：有 written 但没写满的片。
 */
function SegmentBar({ segments, total, fallbackPct, mode }) {
  // 单连接下载没有分片表，退回普通进度条。
  const continuous = mode !== "segments";
  if (!Array.isArray(segments) || segments.length === 0 || !total) {
    return h(
      "div",
      { className: "or-dl-bar" },
      h("div", { className: "or-dl-bar__fill", style: { width: (fallbackPct ?? 0) + "%" } }),
    );
  }

  /**
   * 连续视图。
   *
   * 一根普通进度条，但把「正在被接管」的部分画出来——连续视图本来只能看出下了
   * 多少，看不出“谁在同时跑”。
   *
   * 位置不按分片真实位置铺，而是从左往右接在已下量后面：
   * 这个视图表达的是“一共下了多少”，不是“文件哪些区间写过了”。
   * 所以已完成量 + 各正在写的片已写量 = 填充宽度，一条接一条排。
   * 按真实位置铺会有空洞，看上去反而不像进度。
   */
  if (continuous) {
    const doneBytes = segments.reduce((sum, seg) => sum + Math.min(seg[2], seg[1]), 0);
    const live = segments.filter((seg) => seg[2] < seg[1] && seg[3] === 1);
    const donePct = total ? (doneBytes / total) * 100 : 0;

    // 先给底色，再从左往右依次盖：已下量、每个在写片的单独一段、片间空白。
    // 段与段之间用不同深浅区分，不叠加位置信息。
    return h(
      "div",
      { className: "or-dl-bar", role: "progressbar", "aria-valuenow": Math.round(fallbackPct ?? 0) },
      h("div", { className: "or-dl-bar__fill", style: { width: donePct + "%" } }),
      live.map((seg, i) => {
        const widthPct = total ? (Math.min(seg[2], seg[1]) / total) * 100 : 0;
        // 刚接手的片已写量为 0，也得占位：它就是“正在跑”的那一段，
        // 否则界面上的段数会比实际连接数少。给一条最细的可见宽度。
        return h("span", {
          key: i,
          className: "or-dl-bar__busy" + (widthPct <= 0 ? " is-idle" : ""),
          style: widthPct > 0 ? { width: widthPct + "%" } : undefined,
        });
      }),
    );
  }

  return h(
    "div",
    { className: "or-dl-segbar", role: "progressbar", "aria-valuenow": Math.round(fallbackPct ?? 0) },
    // 分片之间留一条缝：没这道缝，两片颜色相同的地方会粘成一片，看不出分段。
    // 缝用 background 的渐变做，比多几百个元素便宜。
    h(
      "div",
      { className: "or-dl-segbar__track" },
      segments.map((seg, i) => {
        const [start, length, written, busy] = seg;
        const left = (start / total) * 100;
        const width = (length / total) * 100;
        const filled = written >= length;
        // 是否被接管由后端直接给，不靠 written > 0 反推：
        // 刚领到手的片已写量还是 0，反推会漏报。
        const live = !filled && busy === 1;
        return h("span", {
          key: i,
          className:
            "or-dl-segbar__piece" +
            (filled ? " is-done" : live ? " is-live" : ""),
          style: {
            left: left + "%",
            width: width + "%",
            // 正在下的那片把一个内层宽度当进度用。
            ...(live ? { "--piece-fill": (written / length) * 100 + "%" } : null),
          },
        });
      }),
    ),
  );
}

/** 字节数按人读的方式写。一位小数够用，再多就是噪声。 */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
}

/** 速度的写法：0 就是 0，不要显示成「0.0 B/s」那种半死不活的样子。 */
function formatSpeed(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatBytes(n) + "/s";
}

function percentOf(done, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (Number(done) / total) * 100));
}

// ---------------------------------------------------------------- 汇总条

/**
 * 顶部汇总：总速度、连接占用、总连接数调节。
 *
 * 连接数是全局的，所以放在汇总条上而不是每个任务里——每个任务各调一个「连接数」
 * 只会让人以为那是加法。
 */
function SummaryBar({ pool, totalSpeed, activeCount, onLimitChange, onLimitStep, busy, mode, onModeChange }) {
  const limit = Number(pool?.limit) || 0;
  const inUse = Number(pool?.inUse) || 0;
  const speed = formatSpeed(totalSpeed);

  return h(
    "div",
    { className: "or-dl-summary" },
    h(
      "div",
      { className: "or-dl-summary__readings" },
      h(
        "span",
        { className: "or-dl-summary__speed" },
        speed ? speed : "—",
        h("span", { className: "or-dl-summary__unit" }, "总速度"),
      ),
      h(
        "span",
        { className: "or-dl-summary__stat" },
        "连接 ",
        h("strong", null, inUse),
        " / ",
        h("strong", null, limit),
      ),
      h(
        "span",
        { className: "or-dl-summary__stat" },
        activeCount > 0 ? activeCount + " 个任务在跑" : "没有任务在跑",
      ),
    ),
    h(
      "div",
      { className: "or-dl-summary__control" },
      // 显示方式：分片看出并行结构，连续看出整体进度。两者信息不同，不该只给一种。
      h(
        Tooltip,
        { content: "分片按文件位置分格显示，能看出多连接并行的样子；连续就是一根普通进度条" },
        h("span", { className: "or-dl-summary__label" }, "显示"),
      ),
      h(Tabs, {
        items: [
          { value: "segments", label: "分片" },
          { value: "continuous", label: "连续" },
        ],
        value: mode,
        onChange: onModeChange,
        ariaLabel: "切换进度显示方式",
        variant: "segmented",
        className: "or-dl-modes",
      }),
      h(
        Tooltip,
        { content: "所有下载任务加起来最多同时开多少条连接" },
        h("span", { className: "or-dl-summary__label" }, "总连接数"),
      ),
      h(
        "div",
        { className: "or-dl-steps" },
        // 就把当前值看成 2^n：左减指数、右加指数。
        //
        // 按钮写 −/+ 与实际行为一致（点一下确实变小/变大），
        // 而步长是翻倍/减半，不用一下一下磨。
        h(
          Button,
          {
            variant: "ghost",
            size: "sm",
            disabled: busy || limit <= 1,
            onClick: () => onLimitStep(-1),
            "aria-label": "减少总连接数",
          },
          "−",
        ),
        h("span", { className: "or-dl-steps__value" }, limit),
        h(
          Button,
          {
            variant: "ghost",
            size: "sm",
            disabled: busy || limit >= 1024,
            onClick: () => onLimitStep(1),
            "aria-label": "增加总连接数",
          },
          "+",
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 单条任务

function DownloadRow({ item, onAction, busyKey, mode }) {
  const state = item.state;
  const label = STATE_LABEL[state] ?? state;
  const pct = percentOf(item.done, item.total);
  const speed = state === "running" ? formatSpeed(item.speed) : null;
  const busy = busyKey === item.key;
  const conns = Number(item.connections) || 0;

  const canPause = state === "running" || state === "queued";
  const canResume = state === "paused";
  const canCancel = state === "running" || state === "queued" || state === "paused";

  return h(
    "div",
    { className: "or-dl-row or-dl-row--" + state },
    h(
      "div",
      { className: "or-dl-row__head" },
      h(
        "div",
        { className: "or-dl-row__title" },
        h("span", { className: "or-dl-row__name", title: item.name }, item.name),
        h("span", { className: "or-dl-row__tag" }, item.tag),
      ),
      h("span", { className: "or-dl-row__state or-dl-row__state--" + state }, label),
    ),

    h(SegmentBar, { segments: item.segments, total: item.total, fallbackPct: pct, mode }),

    h(
      "div",
      { className: "or-dl-row__foot" },
      h(
        "div",
        { className: "or-dl-row__meta" },
        h(
          "span",
          { className: "or-dl-row__size" },
          formatBytes(item.done),
          " / ",
          item.total ? formatBytes(item.total) : "未知",
          pct !== null ? "  ·  " + pct.toFixed(1) + "%" : null,
        ),
        // 速度与连接数是「正在下」才有意义的东西，别的状态显示出来只会让人困惑。
        speed ? h("span", { className: "or-dl-row__speed" }, speed) : null,
        state === "running" || state === "queued"
          ? h("span", { className: "or-dl-row__conns" }, conns + " 条连接")
          : null,
        state === "paused" && conns === 0
          ? h("span", { className: "or-dl-row__conns" }, "连接已释放")
          : null,
        item.error
          ? h("span", { className: "or-dl-row__error", title: item.error.message }, item.error.message ?? "失败")
          : null,
      ),

      // 按钮跟在读数同一行的右端：单独占一行会白费半张卡的高度。
      canPause || canResume || canCancel
        ? h(
            "div",
            { className: "or-dl-row__actions" },
            canPause
              ? h(
                  Button,
                  { variant: "secondary", size: "sm", loading: busy, onClick: () => onAction(item, "pause") },
                  "暂停",
                )
              : null,
            canResume
              ? h(
                  Button,
                  { variant: "primary", size: "sm", loading: busy, onClick: () => onAction(item, "resume") },
                  "继续",
                )
              : null,
            canCancel
              ? h(
                  Button,
                  { variant: "ghost", size: "sm", loading: busy, onClick: () => onAction(item, "cancel") },
                  "取消",
                )
              : null,
          )
        : null,
    ),
  );
}

// ---------------------------------------------------------------- 主体

export function DownloadsPanel({ onToast }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  /** 进度显示方式。默认分片：它多给一层信息，看不惯的可以切回连续。 */
  const [mode, setMode] = React.useState(() => {
    try {
      const saved = localStorage.getItem("oh-releases:bar-mode");
      if (saved === "continuous" || saved === "segments") return saved;
    } catch {
      // 存储不可用就用默认值。
    }
    return "segments";
  });

  const changeMode = React.useCallback((next) => {
    setMode(next);
    try {
      localStorage.setItem("oh-releases:bar-mode", next);
    } catch {
      // 记不住就只在本次生效。
    }
  }, []);
  const [busyKey, setBusyKey] = React.useState(null);
  const [limitBusy, setLimitBusy] = React.useState(false);
  /** 用户手动改了连接数后，用这个值覆盖服务返回的旧值，避免闪回。 */
  const [pendingLimit, setPendingLimit] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const next = await api("downloads");
      setData(next);
      setError(null);
      return next;
    } catch (loadError) {
      setError(loadError);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  /**
   * 轮询。
   *
   * 不能只在「有任务在跑」时轮询：下载已完成、页面停在旧的空列表上，
   * 之后从版本页又发起一个下载，这里就永远发现不了。而下载是**在别的视图**
   * 发起的，本页面没有事件可听。
   *
   * 所以：有活跃任务时快轮询（速度要跟得上），没有时慢轮询（只为发现新任务）。
   * 慢轮询的代价很小：一次 /downloads 只是读内存快照。
   */
  const hasActive = (data?.downloads ?? []).some((item) => ACTIVE_STATES.has(item.state));
  React.useEffect(() => {
    const timer = setInterval(
      () => {
        load();
      },
      hasActive ? POLL_MS : IDLE_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [hasActive, load]);

  // 服务返回的 limit 与我们刚设的值一致时，撤掉覆盖。
  React.useEffect(() => {
    if (pendingLimit !== null && data?.pool?.limit === pendingLimit) setPendingLimit(null);
  }, [data, pendingLimit]);

  const changeLimit = React.useCallback(
    async (next) => {
      const limit = Math.max(1, Math.min(1024, Math.round(next)));
      if (limit === (pendingLimit ?? data?.pool?.limit)) return;
      setPendingLimit(limit);
      setLimitBusy(true);
      try {
        await api("downloads/pool", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit }),
        });
        await load();
      } catch (limitError) {
        setPendingLimit(null);
        onToast?.("总连接数没改成：" + limitError.message, "error");
      } finally {
        setLimitBusy(false);
      }
    },
    [data, pendingLimit, load, onToast],
  );

  /**
   * 按档位走一步。dir=1 加倍，dir=-1 减半。
   *
   * 基准值取 pendingLimit（已在飞的那个目标）而不是屏幕上的 limit：
   * 连点两下时，第二下到达时第一次的响应往往还没回来，
   * 拿旧值算就会跳错档（曾经从 128 一下跳到 2）。
   * 同时把请求串成一列，不并发发。
   */
  const stepLimiter = React.useRef(Promise.resolve());
  const stepLimit = React.useCallback(
    (dir) => {
      stepLimiter.current = stepLimiter.current.then(() => {
        const base = pendingLimit ?? data?.pool?.limit ?? 1;
        const target = dir > 0 ? nextPowerOfTwo(base) : prevPowerOfTwo(base);
        if (target === base) return undefined;
        return changeLimit(target);
      });
      return stepLimiter.current;
    },
    [pendingLimit, data, changeLimit],
  );

  const act = React.useCallback(
    async (item, action) => {
      setBusyKey(item.key);
      try {
        await api("downloads/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: item.key, action }),
        });
        await load();
      } catch (actionError) {
        onToast?.(actionError.message, "error");
      } finally {
        setBusyKey(null);
      }
    },
    [load, onToast],
  );

  if (loading && !data) {
    return h("div", { className: "or-state" }, h(Busy, { label: "正在读取下载任务…" }));
  }

  if (error && !data) {
    return h(
      "div",
      { className: "or-state" },
      h(ErrorState, {
        title: "读不到下载任务",
        message: error.message,
        action: h(Button, { variant: "secondary", size: "sm", onClick: load }, "重试"),
      }),
    );
  }

  // 服务起不来：这是真故障，要说清楚，不能显示成「没有任务」。
  if (data && data.available === false) {
    return h(
      "div",
      { className: "or-state" },
      h(ErrorState, {
        title: "下载服务不可用",
        message: data.error ?? "下载服务没有起来，重新发起一次下载会再尝试拉起它。",
        action: h(Button, { variant: "secondary", size: "sm", onClick: load }, "再试一次"),
      }),
    );
  }

  const downloads = data?.downloads ?? [];
  const pool = { ...(data?.pool ?? {}), limit: pendingLimit ?? data?.pool?.limit };
  const activeCount = downloads.filter((item) => item.state === "running").length;

  return h(
    "div",
    { className: "or-dl" },
    h(SummaryBar, {
      pool,
      totalSpeed: data?.totalSpeed ?? 0,
      activeCount,
      onLimitChange: changeLimit,
      onLimitStep: stepLimit,
      busy: limitBusy,
      mode,
      onModeChange: changeMode,
    }),

    downloads.length === 0
      ? h(
          "div",
          { className: "or-state" },
          h(EmptyState, {
            title: "还没有下载任务",
            message: "在版本页选中一个文件点下载，它会出现在这里。",
          }),
        )
      : h(
          "div",
          { className: "or-dl-list" },
          downloads.map((item) => h(DownloadRow, { key: item.key, item, onAction: act, busyKey, mode })),
        ),
  );
}
