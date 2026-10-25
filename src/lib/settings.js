/**
 * src/lib/settings.js — 设置项的定义、默认值与校验。
 *
 * 设置存在库里的 state 表（一个 JSON），不走 sdk.config：manifest 的
 * contributes.settings 已撤（设置是主页的一个视图），没有 schema，而 sdk.config.set
 * 对未在 schema 里声明的键一律报"unknown key"。所以配置的真相在库里，页面读写
 * 都走 App 自己的路由。
 *
 * 每一项的校验都集中在这里，路由层只负责把结果转成 HTTP。
 */
import path from "node:path";
import { assetSuffix } from "./upstream.js";

/** state 表里存整份设置的键。 */
export const STATE_SETTINGS = "settings";

/** 轮询间隔的合法区间（秒）。 */
export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 86400;

/**
 * 页面上可选的检查间隔：30 分钟、1 小时、6 小时、24 小时。
 *
 * 后端仍接受区间内的任意整数秒——旧库里可能存着不在四档里的值（比如早期的
 * 默认 2 小时），那是用户的真实配置，不该因为改了选项就被静默改写。
 */
export const INTERVAL_PRESETS = [1800, 3600, 21600, 86400];

export const DEFAULT_INTERVAL_SEC = 21600;

/**
 * 默认落点：App 自己的数据目录下的 downloads。
 *
 * 用 dataDir 而不是用户主目录：这是宿主分配给 App 的目录，一定存在、一定可写，
 * 卸载时也能一并清掉；不必去猜各操作系统的下载文件夹在哪，也不受用户把
 * “下载”改到别的盘影响。
 *
 * 想放到别处是用户的权利，设置里改一下就行。
 */
export function defaultDownloadDir(dataDir) {
  return path.resolve(dataDir, "downloads");
}

/**
 * 默认设置。自动下载默认一项都不勾，镜像留空（直连 GitHub）。
 *
 * autoDownloadSuffixes 存的是安装包后缀（exe / dmg / deb 这类），不是文件名，
 * 也不是全名。后缀跨版本不变，所以勾一次就管以后每个版本。
 */
export function defaultSettings(dataDir) {
  return {
    pollIntervalSec: DEFAULT_INTERVAL_SEC,
    autoDownloadSuffixes: [],
    autoDownload: false,
    downloadDir: defaultDownloadDir(dataDir),
    mirror: "",
    mirrorProbe: null,
    // 总连接数：所有下载任务加起来的并发连接上限。
    poolLimit: 8,
  };
}

/** 一个结构化的拒绝：路由层据此返回 400，而不是把异常抛给宿主。 */
function reject(field, message) {
  return { ok: false, error: { code: "SETTINGS_INVALID", field, message } };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把落点规范化成绝对路径。
 *
 * 绝对路径直接用（下载器跑在 local-machine 里，没有文件系统隔离，任意盘位都能写）；
 * 相对路径当作 dataDir 下的名字，兼容旧库里存的 "downloads"。
 *
 * 这里只做形态检查，不试探能不能写。App 主进程自己受 --permission 约束，只能写
 * dataDir：拿它的访问能力去测盘外路径，得到的永远是“不可写”，会把合法的 E:\… 也
 * 判成错的。真正能不能写要问下载器子进程——它才是有完整文件系统权限的那个。
 */
export function normalizeDownloadDir(dataDir, value) {
  const dataRoot = path.resolve(dataDir);
  if (typeof value !== "string" || !value.trim()) {
    return reject("downloadDir", "下载落点必须是非空字符串");
  }
  const trimmed = value.trim();
  if (trimmed.includes("\0")) return reject("downloadDir", "下载落点不能含 NUL 字符");
  const absolute = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(dataRoot, trimmed);
  return { ok: true, value: absolute };
}

/** 落点 → 绝对路径。绝对路径原样返回，相对值按 dataDir 解析（旧数据的兼容面）。 */
export function resolveDownloadDir(dataDir, value) {
  const dataRoot = path.resolve(dataDir);
  const name = typeof value === "string" && value.trim() ? value.trim() : defaultDownloadDir(dataDir);
  if (path.isAbsolute(name)) return path.normalize(name);
  return path.resolve(dataRoot, name);
}

/**
 * 校验一份设置（PUT 的入参）。任何一个字段不合规就整体拒绝。
 *
 * base 是当前已存的设置：PUT 的语义是改哪项就传哪项，没传的必须原样保留。
 * 拿默认值当 base 会把未传字段静默重置——存一次镜像源就把检查间隔和下载目录
 * 一起打回出厂值，用户根本看不出来。base 故意不自动去读库，由调用方显式传入。
 */
export function validateSettings(dataDir, input, base = defaultSettings(dataDir)) {
  if (!isPlainObject(input)) {
    return reject("body", "设置必须是一个 JSON 对象");
  }
  const out = { ...defaultSettings(dataDir), ...base };

  if (input.pollIntervalSec !== undefined) {
    const raw = Number(input.pollIntervalSec);
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      return reject("pollIntervalSec", "轮询间隔必须是整数秒");
    }
    if (raw < MIN_INTERVAL_SEC || raw > MAX_INTERVAL_SEC) {
      return reject(
        "pollIntervalSec",
        "轮询间隔必须在 " + MIN_INTERVAL_SEC + " 到 " + MAX_INTERVAL_SEC + " 秒之间，收到 " + raw,
      );
    }
    out.pollIntervalSec = raw;
  }

  if (input.autoDownloadSuffixes !== undefined) {
    if (!Array.isArray(input.autoDownloadSuffixes)) {
      return reject("autoDownloadSuffixes", "自动下载的列表必须是后缀数组");
    }
    const suffixes = [];
    for (const item of input.autoDownloadSuffixes) {
      if (typeof item !== "string") {
        return reject("autoDownloadSuffixes", "自动下载的列表必须是后缀数组");
      }
      // 容忍带点、带大写、前后有空白：用户从文件名里拷一段进来不该报错。
      const suffix = item.trim().replace(/^\.+/, "").toLowerCase();
      if (!suffix) continue;
      if (!/^[a-z0-9]+$/.test(suffix)) {
        return reject("autoDownloadSuffixes", "后缀只能包含字母与数字，收到 " + JSON.stringify(item));
      }
      if (!suffixes.includes(suffix)) suffixes.push(suffix);
    }
    if (suffixes.length > 32) {
      return reject("autoDownloadSuffixes", "自动下载最多同时勾选 32 种后缀");
    }
    out.autoDownloadSuffixes = suffixes;
  }

  if (input.autoDownload !== undefined) {
    if (typeof input.autoDownload !== "boolean") {
      return reject("autoDownload", "自动下载必须是布尔值");
    }
    out.autoDownload = input.autoDownload;
  }

  // 开关注定由后缀列表派生：只要传了列表，布尔位就跟着它走。
  out.autoDownload = out.autoDownloadSuffixes.length > 0;

  if (input.downloadDir !== undefined) {
    const normalized = normalizeDownloadDir(dataDir, input.downloadDir);
    if (!normalized.ok) return normalized;
    out.downloadDir = normalized.value;
  }

  if (input.mirror !== undefined) {
    const checked = normalizeMirror(input.mirror);
    if (!checked.ok) return checked;
    out.mirror = checked.value;
  }

  if (input.poolLimit !== undefined) {
    const raw = Number(input.poolLimit);
    if (!Number.isInteger(raw) || raw < 1 || raw > 1024) {
      return reject("poolLimit", "总连接数必须是 1 到 1024 之间的整数");
    }
    out.poolLimit = raw;
  }

  if (input.mirrorProbe !== undefined) {
    const probe = isPlainObject(input.mirrorProbe) ? input.mirrorProbe : null;
    out.mirrorProbe = probe
      ? {
          state: probe.state === "unreachable" ? "unreachable" : "reachable",
          supportsRange: probe.supportsRange === true ? true : probe.supportsRange === false ? false : null,
          checkedAt: Number.isFinite(probe.checkedAt) ? probe.checkedAt : null,
        }
      : null;
  }

  return { ok: true, value: out };
}

/**
 * 校验镜像前缀。
 *
 * 空串合法：直连 GitHub。非空时必须带 http(s):// 协议头，且不能带查询串与片段——
 * 它是前缀，后面要拼 `github.com/<owner>/<repo>/releases/download/…`。
 */
export function normalizeMirror(value) {
  if (typeof value !== "string") return reject("mirror", "镜像地址必须是字符串");
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return reject("mirror", "镜像地址必须以 http:// 或 https:// 开头，留空则直连 GitHub");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject("mirror", "镜像地址不是合法 URL：" + trimmed);
  }
  if (parsed.search || parsed.hash) {
    return reject("mirror", "镜像地址不能带查询串或片段");
  }
  return { ok: true, value: trimmed.replace(/\/+$/, "") };
}

/** 从库里读设置。缺项与坏值一律回落到默认值，不让一处坏数据拖垮整个页面。 */
export function readSettings(store, dataDir) {
  const base = defaultSettings(dataDir);
  const raw = store.getState(STATE_SETTINGS, null);
  if (typeof raw !== "string" || !raw) return base;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!isPlainObject(parsed)) return base;
  const out = { ...base };
  if (Number.isInteger(parsed.pollIntervalSec)) {
    const sec = parsed.pollIntervalSec;
    if (sec >= MIN_INTERVAL_SEC && sec <= MAX_INTERVAL_SEC) out.pollIntervalSec = sec;
  }
  if (typeof parsed.autoDownload === "boolean") out.autoDownload = parsed.autoDownload;
  if (Array.isArray(parsed.autoDownloadSuffixes)) {
    const suffixes = [];
    for (const item of parsed.autoDownloadSuffixes) {
      if (typeof item !== "string") continue;
      const suffix = item.trim().replace(/^\.+/, "").toLowerCase();
      if (suffix && /^[a-z0-9]+$/.test(suffix) && !suffixes.includes(suffix)) suffixes.push(suffix);
    }
    out.autoDownloadSuffixes = suffixes;
  } else if (Array.isArray(parsed.autoDownloadAssets)) {
    // 旧库存的是剔过版本号的文件名，从里面把后缀摘出来。摘不出来就丢掉，
    // 页面会展示成“一项都没选”——这比拿一个猜出来的后缀去静默下载安全。
    const suffixes = [];
    for (const item of parsed.autoDownloadAssets) {
      if (typeof item !== "string") continue;
      const suffix = assetSuffix(item);
      if (suffix && !suffixes.includes(suffix)) suffixes.push(suffix);
    }
    out.autoDownloadSuffixes = suffixes;
  }
  // 旧库只有布尔开关：开着就等用户重新勾选，不自作主张挑一个平台。读成空列表，
  // 页面会把它展示成“一项都没选”，这是实话。
  out.autoDownload = out.autoDownloadSuffixes.length > 0;
  if (typeof parsed.downloadDir === "string" && parsed.downloadDir.trim()) {
    out.downloadDir = parsed.downloadDir.trim();
  }
  if (typeof parsed.mirror === "string") {
    const checked = normalizeMirror(parsed.mirror);
    if (checked.ok) out.mirror = checked.value;
  }
  if (Number.isInteger(parsed.poolLimit) && parsed.poolLimit >= 1 && parsed.poolLimit <= 1024) {
    out.poolLimit = parsed.poolLimit;
  }
  if (isPlainObject(parsed.mirrorProbe)) {
    const probe = parsed.mirrorProbe;
    out.mirrorProbe = {
      state: probe.state === "unreachable" ? "unreachable" : "reachable",
      supportsRange: probe.supportsRange === true ? true : probe.supportsRange === false ? false : null,
      checkedAt: Number.isFinite(probe.checkedAt) ? probe.checkedAt : null,
    };
  }
  return out;
}

/** 写回一份已经校验过的设置。 */
export function writeSettings(store, settings) {
  store.setState(STATE_SETTINGS, JSON.stringify(settings));
  return settings;
}
