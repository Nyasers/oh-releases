/**
 * src/app.js — oh-releases 的 App 入口。
 *
 * 一个订阅 HanaAgent Release 的 App：后台定时问一次 atom，有新版本就入库、发通知，
 * 可选自动下载安装包；页面读自己的后端路由把更新内容和安装包列出来。
 *
 * ## 三个后台动作
 *
 *   · 轮询  —— 走 ctx.tasks.schedule 的定时计划，dispatch 到本文件的 poll handler。
 *   · 回填  —— runBackfill 把 tag 链从最新往旧补到闭合。手动触发（路由/工具）
 *              与轮询都可能要它，靠 jobs 账簿做互斥：同一时刻只有一份。
 *   · 下载  —— startDownload 起受管运行时跑 runtime/downloader.mjs。
 *
 * ## 为什么 schedule 不在 apply 里建
 *
 * 宿主文档明确要求不要在 apply 里自动登记定时计划。apply 里建的话，App 每次重载
 * 都会新登记一条，重启一次多一条。所以只在用户明确授权的入口（保存设置、
 * 手动回填）里先 listSchedules 再决定是新建还是改间隔。
 *
 * ## 错误一律结构化
 *
 * 路由与工具都不把异常抛给宿主：宿主会把未捕获的异常变成 500 或一条失败的工具
 * 调用，页面拿不到"哪个字段不对"这种信息。这里统一回 { ok:false, error:{...} }。
 */
import { defineApp } from "@hana/app-sdk/server";
import path from "node:path";
import { runBackfill } from "./lib/backfill.js";
import { resolveUrl, safeFileName, SCRATCH_DIR } from "./lib/download.js";
import {
  cancelDownload,
  enqueueDownload,
  pauseDownload,
  resumeDownload,
  serviceStatus,
  setPoolLimit,
} from "./lib/download-service.js";
import { createJobs, downloadKey } from "./lib/jobs.js";
import { ensureAssets, notificationFor, pollOnce, readAssetsKnown } from "./lib/poll.js";
import {
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DEFAULT_INTERVAL_SEC,
  INTERVAL_PRESETS,
  STATE_SETTINGS,
  readSettings,
  resolveDownloadDir,
  defaultDownloadDir,
  validateSettings,
  writeSettings,
} from "./lib/settings.js";
import { openStore, STATE_LAST_CHECK_AT, STATE_LAST_ETAG } from "./lib/store.js";
import {
  describeAsset,
  isVersionTag,
  makeClient,
  parseAtom,
  releaseUrl,
  REPO_NAME,
  REPO_OWNER,
} from "./lib/upstream.js";

/** 轮询计划的 handlerKey。改它就是改库里已存计划认得的名字。 */
const HANDLER_POLL = "poll";
/** 回填计划的 handlerKey。手动回填走同一份工作，这个 key 供计划任务复用。 */
const HANDLER_BACKFILL = "backfill";

const SCHEDULE_LABEL = "OH Releases 轮询";

const nowMs = () => Date.now();

/**
 * 正在后台补附件清单的 tag。
 *
 * 详情路由不阻塞正文，附件清单改成后台拉，那同一个 tag 被反复打开时就会
 * 反复发请求。这个集合防重入：已经在拉就不再起第二份。
 */
const refreshingRef = new Set();

function messageOf(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  return String(error.message ?? error);
}

function codeOf(error, fallback) {
  if (error && typeof error.code === "string" && error.code) return error.code;
  return fallback;
}

/**
 * 这次失败重试还有没有意义。
 *
 * 网络波动、镜像限流、连接被对端断掉：等一会儿就能过，值得重试。
 * 文件内容对不上 sha256、附件本身不存在、磁盘写不进去：重试多少次都是同一个
 * 结果，只白白拖时间与带宽。
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "DOWNLOAD_INTERRUPTED",
  "DOWNLOAD_FAILED",
]);

function isRetryableFailure(result) {
  if (!result) return true;
  const code = typeof result.code === "string" ? result.code : null;
  // 不可重试的硬失败。
  if (code === "SHA256_MISMATCH" || code === "ASSET_NOT_FOUND" || code === "RANGE_UNAVAILABLE") {
    return false;
  }
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = messageOf(result.error ?? result.message ?? "");
  // 落盘类错误（磁盘满、无权限、路径非法）重试没用。
  if (/ENOSPC|EACCES|EPERM|EROFS|EISDIR|ENOTDIR/.test(message)) return false;
  if (/磁盘|不可写|无权限|路径/.test(message)) return false;
  // 剩下的当网络类处理：无从归类的失败重试一次比直接放弃好。
  return true;
}

/** 路由层的结构化拒绝。 */function fail(c, status, code, message, field) {
  return c.json(
    { ok: false, error: { code, message, ...(field ? { field } : {}) } },
    status,
  );
}

/** 每个路由都包一层：handler 里抛出的任何异常都变成一条可读的失败响应。 */
function route(handler) {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      return fail(c, 500, codeOf(error, "ROUTE_FAILED"), messageOf(error));
    }
  };
}

function toInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

/**
 * 读请求体。
 *
 * 解析失败返回 null，不是「空对象」——空对象会让 PUT /settings 看起来像一次
 * 合法的「全部用默认值」，把用户配置悄悄重置掉。
 */
async function readJson(c) {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const store = openStore(dataDir);
  const jobs = createJobs();
  const client = makeClient((url, init) => sdk.network.fetch(url, init));

  /** 自动下载的串行链：新版本排队下一份，同一个时刻只有一份在跑。 */
  let autoChain = Promise.resolve(null);

  /**
   * 三个"发了就不等"的宿主调用。
   *
   * sdk.logger.* 与 sdk.appEvents.emit 跨进程都是 Promise：裸调用留下的 rejection
   * 会变成未处理的拒绝。日志与事件都是观察者，不该让业务流程跟着断，所以在这里
   * 各自吞掉自己的失败。
   */
  const logWarn = (message) => {
    sdk.logger.warn(message).catch(() => {});
  };
  const logInfo = (message) => {
    sdk.logger.info(message).catch(() => {});
  };
  const emitEvent = (type, payload) => {
    sdk.appEvents.emit(type, payload).catch(() => {});
  };

  const currentSettings = () => readSettings(store, dataDir);

  const downloadsDir = () => resolveDownloadDir(dataDir, currentSettings().downloadDir);

  // ------------------------------------------------------------ 上游与入库

  /** 回填的起点：库里最新的一条；库空时向 atom 要第一个版本 tag。 */
  async function resolveStartTag() {
    if (store.countVersions() > 0) {
      const newest = store.listVersions({ limit: 1, offset: 0 }).items[0];
      if (newest && newest.tag) return { ok: true, tag: newest.tag, from: "store" };
    }
    const response = await client.fetchAtom(null);
    if (!response?.ok) {
      return {
        ok: false,
        code: "ATOM_FETCH_FAILED",
        message: "取 atom 失败：" + (response?.error ?? "HTTP " + response?.status),
      };
    }
    const parsed = parseAtom(response.text ?? "");
    for (const entry of parsed.entries) {
      if (entry && isVersionTag(entry.tag)) {
        return { ok: true, tag: entry.tag, from: "atom", etag: response.etag ?? null };
      }
    }
    return { ok: false, code: "NO_VERSION_TAG", message: "atom 里没有版本 tag" };
  }

  // ------------------------------------------------------------ 回填

  /**
   * 起一次回填。
   *
   * 已经在跑就不重复起——手动触发与轮询在同一时刻到达时，第二次调用拿到的是
   * 同一份工作，不会对同一条链并发写库。
   */
  async function startBackfillJob({ startTag, source }) {
    let tag = startTag;
    if (!tag) {
      const resolved = await resolveStartTag();
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
      tag = resolved.tag;
    }

    const begun = jobs.beginBackfill(tag, source);
    if (!begun.started) {
      return {
        ok: true,
        started: false,
        jobId: begun.job.id,
        startTag: begun.job.startTag,
        message: "回填已经在跑，复用当前这一份",
      };
    }
    const job = begun.job;

    void (async () => {
      try {
        const summary = await runBackfill({
          store,
          client,
          startTag: tag,
          onProgress: (progress) => {
            jobs.progressBackfill(progress);
            // 每入库一版就推一次事件，页面不用轮询就能一条条长出来。
            // 只推 stored（“又一条进了库”），其余动作不推——链上有一半是
            // 本地缓存命中与 404 探测，推它们只会让页面做无用的重拉。
            if (progress?.action === "stored") {
              emitEvent("oh-releases:backfill", {
                state: "progress",
                jobId: job.id,
                tag: progress.tag ?? null,
                stored: progress.stored ?? null,
                step: progress.step ?? null,
              });
            }
          },
        });
        jobs.finishBackfill(null, summary);
        emitEvent("oh-releases:backfill", {
          state: "completed",
          jobId: job.id,
          steps: summary?.steps ?? null,
          stored: summary?.stored ?? null,
        });
      } catch (error) {
        jobs.finishBackfill(error, null);
        emitEvent("oh-releases:backfill", {
          state: "failed",
          jobId: job.id,
          error: messageOf(error),
        });
      }
    })();

    return { ok: true, started: true, jobId: job.id, startTag: tag };
  }

  // ------------------------------------------------------------ 下载

  /**
   * 按后缀列表挑出这个版本要自动下载的附件。
   *
   * 后缀决定这个文件是什么、能不能装，版本号只是同一种东西的不同变体，所以勾
   * "exe" 就是“以后每个版本的 Windows 安装包”。一份都匹配不上就返回空表，
   * 绝不回退到“随便挑一个当前平台的”：用户没勾的东西不该因为一个新版本就自己
   * 开始下载。
   */
  function pickSelectedAssets(assets, selectedSuffixes) {
    const wanted = new Set(Array.isArray(selectedSuffixes) ? selectedSuffixes : []);
    if (wanted.size === 0) return [];
    return (assets || []).filter((asset) => {
      if (!asset || typeof asset.name !== "string" || !asset.name) return false;
      const described = describeAsset(asset.name, asset.size);
      if (!described.downloadable) return false;
      return wanted.has(described.suffix);
    });
  }

  /** 起一次下载。jobKey 是 "<tag>/<文件名>"，同一个 key 还在跑就不再起第二份。 */

  /**
   * 全局进度同步器。
   *
   * 常驻服务用一次 /status 就能给出所有任务的进度，所以只该有一个轮询循环，
   * 不该每个任务各开一个定时器，十几个任务就是十几个并发请求打同一个服务。
   *
   * 这个循环只在有任务在等的时候跑，没任务就停。
   */
  const watchers = new Map();
  let syncTimer = null;
  let syncing = false;

  function stopSyncIfIdle() {
    if (watchers.size === 0 && syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function ensureSync() {
    if (syncTimer) return;
    syncTimer = setInterval(async () => {
      if (syncing || watchers.size === 0) return;
      syncing = true;
      try {
        const status = await serviceStatus(sdk, dataDir);
        for (const item of status.downloads ?? []) {
          const waiting = watchers.get(item.key);
          if (!waiting) continue;
          waiting.onUpdate(item);
          if (item.state === "completed" || item.state === "failed" || item.state === "canceled") {
            watchers.delete(item.key);
            waiting.resolve(item);
          }
        }
      } catch {
        // 服务短暂不可用（重启中）：不把任务判死，下一拍再看。
      } finally {
        syncing = false;
        stopSyncIfIdle();
      }
    }, 400);
    if (typeof syncTimer.unref === "function") syncTimer.unref();
  }

  /** 等一个任务走到终态。进度通过 onUpdate 转写给任务账簿。 */
  function waitForTerminal(key) {
    ensureSync();
    return new Promise((resolve) => {
      watchers.set(key, {
        resolve,
        onUpdate: (item) => {
          jobs.progressDownload(key, {
            kind: "progress",
            done: item.done,
            total: item.total ?? undefined,
            speed: item.speed ?? undefined,
            mode: "parallel",
          });
        },
      });
    });
  }

  async function startDownloadJob({ tag, name, source }) {
    const settings = currentSettings();
    let assets = store.listAssets(tag);
    let asset = assets.find((item) => item.name === name);
    if (!asset) {
      return {
        ok: false,
        code: "ASSET_NOT_FOUND",
        message: "库里没有 " + tag + " 的附件 " + name,
      };
    }

    /**
     * 下载前先确保手上有官方 sha256。
     *
     * 回填只取 digest、不抓附件清单，所以历史版本第一次下载时 assets 表里可能只有
     * 名字而没有 sha256。带着空 sha256 去下，下载器就无从上手校验——那等于静默
     * 放弃官方校验。这里先补一次 expanded_assets（不占 API 配额）。
     *
     * 补不到也不拦：上游确实有些版本没给 sha256。但结果会标 verified:false。
     */
    if (typeof asset.sha256 !== "string" || !asset.sha256) {
      try {
        await ensureAssets({ store, client, tag, now: Date.now() });
        assets = store.listAssets(tag);
        asset = assets.find((item) => item.name === name) ?? asset;
      } catch {
        // 取不到清单就按无 hash 处理，下载器会标 verified:false。
      }
    }
    const key = downloadKey(tag, asset.name);
    const begun = jobs.beginDownload({ tag, name: asset.name, total: asset.size });
    if (!begun.started) {
      return {
        ok: true,
        started: false,
        jobId: key,
        tag,
        name: asset.name,
        message: "这个文件已经在下载",
      };
    }

    const done = (async () => {
      try {
        // 下载不再起一次性进程，而是交给常驻服务排队：连接池要跨任务共享，
        // 「总连接数」才是用户设的那个数。enqueue 立即返回。
        const target = safeFileName(asset.name);
        const resolvedDownload = path.resolve(downloadsDir());
        const destination = path.join(resolvedDownload, target);
        const scratch = path.join(path.resolve(dataDir), SCRATCH_DIR);
        const stem = tag + "-" + target;
        const task = {
          url: resolveUrl(settings.mirror, {
            owner: REPO_OWNER,
            repo: REPO_NAME,
            tag,
            asset: target,
          }),
          destination,
          resultPath: path.join(scratch, stem + ".result.json"),
          controlPath: path.join(scratch, stem + ".part.json"),
          expectedSha256: typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : null,
          totalBytes: Number.isFinite(asset.size) ? asset.size : null,
        };

        const enqueued = await enqueueDownload(sdk, dataDir, {
          key,
          tag,
          name: asset.name,
          task,
          // 服务刚起时池是默认值：把用户设的数目带过去，
          // 不做就会变成“设置里写 20、实际只跑 12”。
          poolLimit: Number(settings.poolLimit),
        });
        jobs.progressDownload(key, {
          kind: "progress",
          done: enqueued.download?.done ?? 0,
          total: enqueued.download?.total ?? undefined,
          mode: "parallel",
        });

        // 等这个任务收尾。进度由全局同步器统一转写，这里只关心结局。
        const final = await waitForTerminal(key);
        const ok = final.state === "completed";
        if (ok) {
          jobs.finishDownload(key, {
            ok: true,
            path: final.path,
            bytes: final.done,
            sha256: null,
            verified: final.verified,
            mirror: "mirror",
          });
        } else {
          jobs.finishDownload(key, {
            ok: false,
            code: final.error?.code ?? "DOWNLOAD_FAILED",
            error: final.error?.message ?? "下载中断",
          });
        }
        emitEvent("oh-releases:download", {
          state: ok ? "completed" : "failed",
          tag,
          name: asset.name,
          source,
          error: ok ? null : (final.error?.message ?? null),
        });
        return {
          ok,
          path: final.path ?? null,
          bytes: final.done ?? null,
          verified: final.verified === true,
          error: ok ? null : (final.error?.message ?? "下载未完成"),
          code: ok ? null : (final.error?.code ?? "DOWNLOAD_FAILED"),
        };
      } catch (error) {
        jobs.failDownload(key, error);
        emitEvent("oh-releases:download", {
          state: "failed",
          tag,
          name: asset.name,
          source,
          error: messageOf(error),
        });
        return { ok: false, error: messageOf(error) };
      }
    })();

    return { ok: true, started: true, jobId: key, tag, name: asset.name, done };
  }

  /**
   * 自动下载：新版本入库后，把用户勾过的附件逐份排队下载。
   *
   * 排队而不是丢弃——一次检查可能带来多个新版本、一个版本也可能勾了好几份，
   * 丢弃就等于永远不下载它。串行也是硬要求：宿主给一个 App 的受管运行时并发
   * 上限是 4，一次放多份出去会把后面的挤掉。
   *
   * 单份失败会退避重试几次：自动下载本就是在用户不在场时跑的，一次网络抖动就
   * 放弃，用户只能等到下个版本或自己去手动点。但碰上内容对不上 sha256、附件
   * 不存在这类硬失败就不重试——重多少次都是同一个结果。
   */

  /** 自动下载的尝试次数（含首次）。首次之外最多再试 3 次。 */
  const AUTO_DOWNLOAD_ATTEMPTS = 4;

  /** 第 n 次失败后的等待：30s / 2min / 8min，翻倍封顶 10 分钟。 */
  function autoRetryDelay(attempt) {
    return Math.min(10 * 60 * 1000, 30 * 1000 * 4 ** (attempt - 1));
  }

  /** 后台重试队列：不阻塞主链，一次抖动不该把后面排队的那几份一起拖住。 */
  const retryQueue = new Set();

  /**
   * 下完一份。返回首次的结果，失败的重试交给后台。
   *
   * 为什么不在主链里等：退避总时长可能十几分钟，而主链是串行的——一份卡在
   * 重试里，同一版本的另一份（甚至下个版本）就都下不了。重试本来就不需要
   * 跟谁抢位置，放后台单跑更合理。
   */
  async function downloadWithRetry({ tag, name }) {
    const started = await startDownloadJob({ tag, name, source: "auto" });
    let first;
    if (!started.ok || !started.done) {
      first = { ok: false, code: started.code ?? null, error: started.message ?? "下载未能启动" };
    } else {
      const { done } = started;
      const result = await done;
      first = result && result.ok
        ? { ok: true, result }
        : { ok: false, code: result?.code ?? null, error: messageOf(result?.error) };
    }

    if (first.ok || !isRetryableFailure(first)) {
      return { ...first, attempts: 1 };
    }

    scheduleRetry({ tag, name, attempt: 1, last: first });
    return { ...first, attempts: 1, retrying: true };
  }

  /** 把一份失败放到后台按退避重试，不再阻塞调用方。 */
  function scheduleRetry({ tag, name, attempt, last }) {
    const work = (async () => {
      const next = attempt + 1;
      if (next > AUTO_DOWNLOAD_ATTEMPTS) {
        await notifyAutoDownloadFailed([{ tag, name, error: last.error }]);
        return;
      }
      const delay = autoRetryDelay(attempt);
      logWarn(
        "自动下载 " +
          tag +
          "/" +
          name +
          " 第 " +
          attempt +
          " 次失败（" +
          (last.error ?? "未知") +
          "），" +
          Math.round(delay / 1000) +
          " 秒后重试",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      const started = await startDownloadJob({ tag, name, source: "auto" });
      let outcome;
      if (!started.ok || !started.done) {
        outcome = { ok: false, code: started.code ?? null, error: started.message ?? "下载未能启动" };
      } else {
        const result = await started.done;
        outcome = result && result.ok
          ? { ok: true, result }
          : { ok: false, code: result?.code ?? null, error: messageOf(result?.error) };
      }

      if (outcome.ok || !isRetryableFailure(outcome)) return;
      await scheduleRetry({ tag, name, attempt: next, last: outcome });
    })().catch((error) => logWarn("自动下载重试链断了：" + messageOf(error)));

    retryQueue.add(work);
    work.finally(() => retryQueue.delete(work));
  }

  function autoDownload(version) {
    const selected = pickSelectedAssets(version.assets, currentSettings().autoDownloadSuffixes);
    if (!selected.length) return Promise.resolve({ skipped: "no-selected-asset" });

    let chain = Promise.resolve([]);
    const results = [];
    for (const asset of selected) {
      const queued = chain.then(async () => {
        const outcome = await downloadWithRetry({ tag: version.tag, name: asset.name });
        results.push({ tag: version.tag, name: asset.name, ...outcome });
        return outcome;
      });
      // 链上留一个已处理的副本：一份失败不该让后面那几份直接拒掉。
      chain = queued.catch(() => null);
    }
    // 外层也接上全局串行链：多版本连着来的时候，版本间也不该抢运行时。
    const all = autoChain.then(() => chain);
    autoChain = all.catch(() => null);
    return all.then(() => {
      // 会重试的那些已经交给后台，这里只报“当场就失败且不值得重试”的。
      const failed = results.filter((item) => !item.ok && !item.retrying);
      if (failed.length) {
        notifyAutoDownloadFailed(failed).catch(() => {});
      }
      return {
        started: results.length,
        failed: failed.length,
        retrying: results.filter((item) => item.retrying).length,
        results,
      };
    });
  }

  /** 自动下载彻底失败时发一条通知，带上文件名与原因。 */
  async function notifyAutoDownloadFailed(failed) {
    const names = failed.map((item) => item.name);
    const first = failed[0];
    try {
      await sdk.notifications.show({
        title: "有 " + names.length + " 个安装包没下下来",
        body:
          names.slice(0, 3).join("、") +
          (names.length > 3 ? " 等" : "") +
          "。原因：" +
          (first.error ?? "未知") +
          "。可以在卡片里手动重试。",
      });
    } catch (error) {
      logWarn("自动下载失败通知没发出去：" + messageOf(error));
    }
  }

  // ------------------------------------------------------------ 轮询

  /**
   * 跑一次检查。有新版本就入库、发通知，必要时自动下载。
   *
   * 通知失败（没授权、桌面不可用）不影响入库：能看到的更新内容比一条通知重要。
   */
  async function runPollCheck({ source }) {
    const result = await pollOnce({ store, client, now: nowMs() });
    if (!result.ok) {
      logWarn("oh-releases 检查失败：" + messageOf(result.error));
      return result;
    }
    if (result.notModified) return result;

    for (const version of result.newVersions) {
      const note = notificationFor(version);
      try {
        await sdk.notifications.show({ title: note.title, body: note.body });
      } catch (error) {
        logWarn("oh-releases 通知失败：" + messageOf(error));
      }
      emitEvent("oh-releases:release", {
        tag: version.tag,
        version: version.version,
        source,
      });
      if (currentSettings().autoDownloadSuffixes.length > 0) {
        await autoDownload(version);
      }
    }
    return result;
  }

  // ------------------------------------------------------------ 定时计划

  /** 计划上被宿主打上的暂停标记。空数组表示没被挂起。 */
  function suspensionReasons(schedule) {
    const raw = schedule && typeof schedule === "object" ? schedule.suspension : null;
    if (!raw || typeof raw !== "object") return [];
    return Object.keys(raw).filter((key) => raw[key] === true);
  }

  /**
   * 清掉宿主留下的 app_uninstalled 挂起标记。
   *
   * 卸载重装（开发期很常见）会让宿主给这个 App 名下的计划打上 app_uninstalled。
   * 重新加载时宿主会清 app_disabled / crash_restart / stopped / permission_revoked，
   * 唯独不清这一种：它只认 App 主动调 resumeSchedule 时做的那次 owner 校验。
   * 不清的结果是计划存在、enabled 为真、nextRunAt 也算得出来，但调度器每次都跳过它。
   *
   * 只清这一个理由。其余理由是宿主按当前状态实时打上去的，硬清等于把真实故障盖掉。
   * resumeSchedule 顺带会把 enabled 置真，所以只在用户没有主动暂停时调用。
   */
  async function clearStaleSuspension(schedule) {
    if (!suspensionReasons(schedule).includes("app_uninstalled")) return false;
    if (schedule.enabled === false) return false;
    await sdk.tasks.resumeSchedule(schedule.scheduleId);
    return true;
  }

  /**
   * 让轮询计划与当前设置一致。
   *
   * 先 listSchedules：已经有一条由本 App 登记的轮询计划就改它的间隔并清掉过期的
   * 挂起标记，没有才新建。只在用户明确授权的入口调用，绝不在 apply 里调用。
   */
  async function ensureSchedule(intervalSec) {
    const sec = Number.isInteger(intervalSec) ? intervalSec : currentSettings().pollIntervalSec;
    const safeSec = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, sec));
    const intervalMs = safeSec * 1000;
    const schedules = await sdk.tasks.listSchedules();
    const existing = (schedules || []).find(
      (item) => item && item.handlerKey === HANDLER_POLL && item.scope === "app",
    );
    if (existing) {
      // updateSchedule 不动 enabled 与 suspension，两件事互不覆盖；先改间隔只是
      // 为了让接下来算出的 nextRunAt 已经是新间隔。
      const updated =
        existing.intervalMs === intervalMs
          ? existing
          : await sdk.tasks.updateSchedule(existing.scheduleId, { intervalMs });
      const resumed = await clearStaleSuspension(updated);
      return { ok: true, created: false, resumed, scheduleId: updated.scheduleId, intervalMs };
    }
    const created = await sdk.tasks.schedule({
      handlerKey: HANDLER_POLL,
      scope: "app",
      label: SCHEDULE_LABEL,
      intervalMs,
    });
    return { ok: true, created: true, scheduleId: created.scheduleId, intervalMs };
  }

  /** 当前轮询计划的可读快照，给 /state 与 /settings 用。 */
  async function scheduleSnapshot() {
    try {
      const schedules = await sdk.tasks.listSchedules();
      const own = (schedules || []).find(
        (item) => item && item.handlerKey === HANDLER_POLL && item.scope === "app",
      );
      if (!own) return null;
      return {
        scheduleId: own.scheduleId,
        intervalMs: own.intervalMs,
        enabled: own.enabled,
        nextRunAt: own.nextRunAt ?? null,
        lastRunAt: own.lastRunAt ?? null,
        lastError: own.lastError ?? null,
        runCount: own.runCount ?? 0,
        suspension: suspensionReasons(own),
      };
    } catch (error) {
      return { error: messageOf(error) };
    }
  }

  /**
   * 定时轮询到底能不能跑。
   *
   * 宿主把"这个 App 的计划能不能触发"绑在 app/tasks.manage 授权上（按授权实时
   * 开关）。没有这个授权时，间隔存得进去、计划也可能建得出来，但到点不会触发
   * ——用户会以为 App 坏了。所以页面要能说出这件事，而不是只显示一个存下来的数字。
   *
   * listSchedules 本身就要这项授权，它的拒绝就是最直接的证据。能列出来之后还要
   * 看计划本身：不存在、被暂停、被挂起、一次都没跑过、或者上一次跑失败了，都算
   * "没在跑"。
   *
   * enabled 与 suspension 是两套独立的开关：enabled 是用户意图，suspension 是
   * 宿主按当前状态（卸载、崩溃、权限被收）打上的。两个都是 0 的时候调度器才跑，
   * 所以这里必须两个都看。只看 enabled 会把一条永远不触发的计划报成"正常"。
   */
  async function schedulingHealth() {
    let schedules;
    try {
      schedules = await sdk.tasks.listSchedules();
    } catch (error) {
      return {
        available: false,
        reason: "missing-permission",
        code: codeOf(error, "TASKS_UNAVAILABLE"),
        message: messageOf(error),
      };
    }
    const own = (schedules || []).find(
      (item) => item && item.handlerKey === HANDLER_POLL && item.scope === "app",
    );
    if (!own) {
      return { available: false, reason: "no-schedule", code: null, message: null };
    }
    if (own.enabled === false) {
      return { available: false, reason: "paused", code: null, message: null };
    }
    const suspended = suspensionReasons(own);
    if (suspended.length > 0) {
      return {
        available: false,
        reason: "suspended",
        code: null,
        suspension: suspended,
        message: suspended.join("、"),
      };
    }
    if (own.lastError) {
      return {
        available: false,
        reason: "last-run-failed",
        code: null,
        message: own.lastError,
      };
    }
    // 到点该跑却没跑的第二个证据：nextRunAt 已经过了整整一个周期，而 runCount 还是 0。
    // 刚装载、计时器尚未支棱起来的头一个周期不该被抱怨，所以留出一个周期的宽限。
    const overdueByMs = typeof own.nextRunAt === "number" ? nowMs() - own.nextRunAt : null;
    if (
      typeof own.nextRunAt === "number" &&
      own.intervalMs &&
      overdueByMs > own.intervalMs &&
      (own.runCount ?? 0) === 0
    ) {
      return {
        available: false,
        reason: "never-ran",
        code: null,
        overdueByMs,
        message: null,
      };
    }
    return { available: true, reason: "ok", code: null, message: null };
  }

  /**
   * 自动下载的可选项：以库里最新一版的附件清单为模板，按后缀归并。
   *
   * 匹配单位是后缀而不是文件名：后缀决定这个文件是什么、能不能装，版本号只是
   * 同一种东西的不同变体。所以一个后缀一行，勾了就是“以后每个版本都下这种”。
   *
   * 用最新版而不是“曾经出现过的全部附件”：用户看到的是刚刚发布的东西发什么，
   * 勾选才有依据。已勾选但本版没出现的后缀仍列出（present:false），否则旧
   * 配置里那些项在界面上会默不作声地消失，用户以为被删了。
   */
  async function assetChoicesForLatest() {
    const newest = store.listVersions({ limit: 1, offset: 0 }).items[0] ?? null;
    if (!newest) return { tag: null, items: [] };
    const assets = store.listAssets(newest.tag);
    const items = [];
    const bySuffix = new Map();
    for (const asset of assets) {
      const described = describeAsset(asset.name, asset.size);
      if (!described.downloadable) continue;
      const existing = bySuffix.get(described.suffix);
      if (existing) {
        existing.names.push(asset.name);
        continue;
      }
      const item = {
        suffix: described.suffix,
        name: asset.name,
        names: [asset.name],
        platform: described.platform,
        arch: described.arch,
        format: described.format,
        size: described.size,
        present: true,
      };
      bySuffix.set(described.suffix, item);
      items.push(item);
    }
    for (const suffix of currentSettings().autoDownloadSuffixes) {
      if (bySuffix.has(suffix)) continue;
      items.push({
        suffix,
        name: "." + suffix,
        names: [],
        platform: null,
        arch: null,
        format: null,
        size: null,
        present: false,
      });
    }
    return { tag: newest.tag, items };
  }

  // ------------------------------------------------------------ 任务 handler

  await sdk.tasks.registerHandler(HANDLER_POLL, {
    async run() {
      const result = await runPollCheck({ source: "schedule" });
      return {
        ok: result.ok,
        notModified: result.notModified ?? false,
        newVersions: (result.newVersions || []).map((item) => item.tag),
        error: result.ok ? null : messageOf(result.error),
        checkedAt: result.checkedAt ?? null,
      };
    },
  });

  await sdk.tasks.registerHandler(HANDLER_BACKFILL, {
    async run(context) {
      const input = context && typeof context.input === "object" && context.input ? context.input : {};
      const started = await startBackfillJob({
        startTag: typeof input.startTag === "string" ? input.startTag : null,
        source: "handler",
      });
      return started;
    },
  });

  // ------------------------------------------------------------ 模型工具

  /** 注册失败不拖垮整个 App：少了这一个工具，页面与定时检查仍然该能用。 */
  const registerTool = async (registration) => {
    try {
      await sdk.tools.register(registration);
      return true;
    } catch (error) {
      logWarn("oh-releases 工具 " + registration.name + " 未注册：" + messageOf(error));
      return false;
    }
  };

  await registerTool({
    name: "get_releases",
    description:
      "读取已采集的 HanaAgent 版本列表，最新的在前。每条含 tag、版本号、中英文摘要与变更计数。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "返回几条，默认 10，最多 50。" },
        offset: { type: "integer", description: "跳过几条，默认 0。" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const input = args && typeof args === "object" ? args : {};
      const limit = Math.min(50, Math.max(1, toInteger(input.limit, 10)));
      const offset = Math.max(0, toInteger(input.offset, 0));
      const page = store.listVersions({ limit, offset });
      return {
        ok: true,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        backfillState: store.getBackfillState(),
        items: page.items.map((item) => ({
          tag: item.tag,
          previousTag: item.previousTag,
          version: item.version,
          generatedAt: item.generatedAt,
          summary: item.summary,
          counts: item.counts,
          itemCount: item.itemCount,
        })),
      };
    },
  });

  await registerTool({
    name: "trigger_backfill",
    description:
      "手动触发一次版本回填：从最新版本沿 previousTag 往旧补，直到链闭合。已经在跑就复用当前那一份。",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "从哪个 tag 开始，默认库里最新的一条。" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const input = args && typeof args === "object" ? args : {};
      const startTag = typeof input.tag === "string" && input.tag ? input.tag : null;
      return startBackfillJob({ startTag, source: "tool" });
    },
  });

  // ------------------------------------------------------------ 后端路由

  const routeApp = (app) => {
    app.get(
      "/releases",
      route(async (c) => {
        const limit = Math.min(100, Math.max(1, toInteger(c.req.query("limit"), 20)));
        const offset = Math.max(0, toInteger(c.req.query("offset"), 0));
        const page = store.listVersions({ limit, offset });
        return c.json({
          ok: true,
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          items: page.items,
        });
      }),
    );

    app.get(
      "/releases/:tag",
      route(async (c) => {
        const tag = String(c.req.param("tag") ?? "");
        if (!tag) return fail(c, 400, "TAG_REQUIRED", "缺少 tag");
        const version = store.getVersion(tag);
        if (!version) return fail(c, 404, "VERSION_NOT_FOUND", "库里没有版本 " + tag);

        // 正文就是库里存的 digest 原文，本地读，不碰网络。
        const digest = version.digest && typeof version.digest === "object" ? version.digest : {};

        // 附件清单是唯一可能要联网的部分：回填只补 digest，附件清单等到有人
        // 真的打开这一版才抓。但它不该把正文一起拖住——先看看能不能不联网就
        // 交付：已缓存就直接用。
        const cachedAssets = store.listAssets(tag);
        const assetsKnown = readAssetsKnown(store);
        const wantRefresh = c.req.query("refresh") === "1";

        let assets = cachedAssets;
        let assetsLoaded = wantRefresh ? false : assetsKnown[tag] !== undefined;
        // 没缓存且需要联网时，先发请求但不 await——先把正文交付出去，把附件
        // 清单当后台动作。翻页时正文不再等那一次网络往返。
        let assetsError = null;
        if (!assetsLoaded && !refreshingRef.has(tag)) {
          refreshingRef.add(tag);
          void ensureAssets({ store, client, tag, force: wantRefresh })
            .catch(() => {})
            .finally(() => refreshingRef.delete(tag));
        }

        return c.json({
          ok: true,
          tag: version.tag,
          previousTag: version.previousTag,
          digestSha256: version.digestSha256,
          // 现算而不读库里存的：早期版本存的是 digest 文件地址，
          // 而这里要引到 Release 页面，旧数据也就不必迁移。
          sourceUrl: releaseUrl(version.tag),
          fetchedAt: version.fetchedAt,
          version: typeof digest.version === "string" ? digest.version : null,
          generatedAt: typeof digest.generatedAt === "string" ? digest.generatedAt : null,
          noUserFacingChanges:
            typeof digest.noUserFacingChanges === "boolean" ? digest.noUserFacingChanges : null,
          summary: digest.summary ?? null,
          counts: digest.counts ?? null,
          source: digest.source ?? null,
          items: Array.isArray(digest.items) ? digest.items : [],
          assets,
          assetsLoaded,
          ...(assetsError ? { assetsError } : {}),
        });
      }),
    );

    app.post(
      "/backfill",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const startTag = typeof body.tag === "string" && body.tag ? body.tag : null;
        const started = await startBackfillJob({ startTag, source: "route" });
        if (!started.ok) {
          return fail(c, 502, started.code, started.message);
        }
        // 用户在这里明确要求回填，顺带把轮询计划对齐到当前设置。
        let schedule = await scheduleSnapshot();
        try {
          await ensureSchedule(currentSettings().pollIntervalSec);
          schedule = await scheduleSnapshot();
        } catch (error) {
          logWarn("oh-releases 轮询计划未就绪：" + messageOf(error));
        }
        return c.json({ ...started, schedule });
      }),
    );

    app.post(
      "/schedule",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const intervalSec = Number.isInteger(body.pollIntervalSec)
          ? body.pollIntervalSec
          : currentSettings().pollIntervalSec;
        if (intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC) {
          return fail(
            c,
            400,
            "SETTINGS_INVALID",
            "轮询间隔必须在 " + MIN_INTERVAL_SEC + " 到 " + MAX_INTERVAL_SEC + " 秒之间",
            "pollIntervalSec",
          );
        }
        return c.json(await ensureSchedule(intervalSec));
      }),
    );

    /**
     * 把定时检查重新拉起来。
     *
     * 不动间隔，只做两件事：清掉宿主留下的过期挂起标记，一个计划都没有时把它建起来。
     * 设置页那个“恢复定时检查”的按钮走这里：用户的意图是“让它真的跑起来”，而他
     * 不需要知道要去比对哪些字段。回完一并给刷新过的快照与体检结果，页面不用再多
     * 发两个请求。
     */
    app.post(
      "/schedule/resume",
      route(async (c) => {
        const result = await ensureSchedule(currentSettings().pollIntervalSec);
        return c.json({
          ...result,
          schedule: await scheduleSnapshot(),
          scheduling: await schedulingHealth(),
        });
      }),
    );

    app.get(
      "/state",
      route(async (c) => {
        const settings = currentSettings();
        const lastCheckRaw = store.getState(STATE_LAST_CHECK_AT, null);
        const lastCheckAt = Number(lastCheckRaw);
        return c.json({
          ok: true,
          backfill_state: store.getBackfillState(),
          backfillStateText: store.getBackfillState() === 1 ? "已完成" : "未完成",
          last_check_at: Number.isFinite(lastCheckAt) ? lastCheckAt : null,
          last_etag: store.getState(STATE_LAST_ETAG, null),
          counts: {
            versions: store.countVersions(),
            absent: store.listAbsent().length,
          },
          backfill: jobs.backfillSnapshot(),
          downloads: jobs.listDownloads(),
          autoRetrying: retryQueue.size,
          schedule: await scheduleSnapshot(),
          scheduling: await schedulingHealth(),
          settings: {
            pollIntervalSec: settings.pollIntervalSec,
            autoDownload: settings.autoDownload,
            autoDownloadSuffixes: settings.autoDownloadSuffixes,
            downloadDir: settings.downloadDir,
            mirror: settings.mirror,
            mirrorProbe: settings.mirrorProbe,
          },
          downloadPath: downloadsDir(),
          platform: process.platform,
        });
      }),
    );

    app.get(
      "/settings",
      route(async (c) => {
        const settings = currentSettings();
        const schedule = await scheduleSnapshot();
        const scheduling = await schedulingHealth();
        return c.json({
          ok: true,
          settings,
          intervals: INTERVAL_PRESETS,
          limits: {
            minIntervalSec: MIN_INTERVAL_SEC,
            maxIntervalSec: MAX_INTERVAL_SEC,
            defaultIntervalSec: DEFAULT_INTERVAL_SEC,
          },
          downloadPath: downloadsDir(),
          // 供页面上的“恢复默认”用：默认落点是 App 自己算出来的，不该让界面
          // 再拼一份同样的路径逻辑。
          defaultDownloadDir: defaultDownloadDir(dataDir),
          // 自动下载的可选项：拿库里最新一版的附件清单当模板。
          assetChoices: await assetChoicesForLatest(),
          schedule,
          // 设置视图据此提示"定时轮询还没建起来"：间隔存好了但计划不存在时，
          // 光看 settings 是看不出来的。被挂起的计划也算没在跑：enabled 为真
          // 但它永远不会被调度器唤起。
          scheduleActive:
            schedule !== null &&
            schedule.enabled !== false &&
            !(Array.isArray(schedule.suspension) && schedule.suspension.length > 0),
          // 计划是否存在、是否被暂停、有没有 app/tasks.manage 授权，都在这。
          scheduling,
        });
      }),
    );

    app.put(
      "/settings",
      route(async (c) => {
        const body = await readJson(c);
        if (!body) {
          return fail(c, 400, "SETTINGS_INVALID", "请求体必须是 JSON 对象", "body");
        }
        const checked = validateSettings(dataDir, body, currentSettings());
        if (!checked.ok) {
          return fail(c, 400, checked.error.code, checked.error.message, checked.error.field);
        }
        const saved = writeSettings(store, checked.value);
        let schedule = await scheduleSnapshot();
        // 保存设置是用户明确授权的入口：间隔变了才去动计划。
        if (body.pollIntervalSec !== undefined || body.applySchedule === true) {
          try {
            await ensureSchedule(saved.pollIntervalSec);
            schedule = await scheduleSnapshot();
          } catch (error) {
            return c.json({
              ok: true,
              settings: saved,
              schedule,
              scheduling: await schedulingHealth(),
              warning: "设置已保存，但轮询计划未能创建：" + messageOf(error),
            });
          }
        }
        return c.json({
          ok: true,
          settings: saved,
          schedule,
          scheduling: await schedulingHealth(),
          // 保存后页面会用这份响应刷新状态，所以它必须带上可选项：
          // 不带的话页面会把列表置空，看起来像“保存把选项弄丢了”。
          assetChoices: await assetChoicesForLatest(),
        });
      }),
    );

    app.post(
      "/download",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const tag = typeof body.tag === "string" ? body.tag.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!tag) return fail(c, 400, "TAG_REQUIRED", "缺少 tag", "tag");
        if (!name) return fail(c, 400, "ASSET_REQUIRED", "缺少附件名 name", "name");
        const started = await startDownloadJob({ tag, name, source: "manual" });
        if (!started.ok) {
          return fail(c, started.code === "ASSET_NOT_FOUND" ? 404 : 409, started.code, started.message);
        }
        // done 是内部等待句柄，不进响应：序列化成一个空对象只会让页面误以为有字段。
        const { done, ...publicPart } = started;
        return c.json(publicPart);
      }),
    );

    /**
     * 下载页的主数据。
     *
     * 直接透传常驻服务的快照，并补上一层页面需要的东西：总连接数上限、
     * 当前占用、汇总速度。任务列表以服务里的为准（那才是真实在跑的东西），
     * 内存账簿只用来补一些历史字段。
     */
    app.get(
      "/downloads",
      route(async (c) => {
        let snapshot;
        try {
          snapshot = await serviceStatus(sdk, dataDir, { poolLimit: Number(currentSettings().poolLimit) });
        } catch (error) {
          // 服务起不来是真实故障，得让页面能说出来，不假装“没有任务”。
          return c.json({
            ok: true,
            available: false,
            error: messageOf(error),
            pool: { limit: 8, inUse: 0, waiting: 0 },
            downloads: [],
            totalSpeed: 0,
          });
        }
        const downloads = snapshot.downloads ?? [];
        const totalSpeed = downloads.reduce((sum, d) => sum + (Number(d.speed) || 0), 0);
        return c.json({
          ok: true,
          available: true,
          pool: snapshot.pool,
          downloads,
          totalSpeed,
        });
      }),
    );

    /** 调总连接数。 */
    app.post(
      "/downloads/pool",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const limit = Number(body.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1024) {
          return fail(c, 400, "POOL_INVALID", "总连接数必须是 1 到 1024 之间的整数", "limit");
        }
        const result = await setPoolLimit(sdk, dataDir, limit);
        // 记住它：服务重启后要按用户设的值来，不能跌回默认的 12。
        writeSettings(store, { ...currentSettings(), poolLimit: limit });
        return c.json({ ok: true, pool: result.pool });
      }),
    );

    /** 暂停 / 继续 / 取消。三个动作只差一个服务端接口，用一个处理器。 */
    app.post(
      "/downloads/action",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const key = typeof body.key === "string" ? body.key : "";
        const action = typeof body.action === "string" ? body.action : "";
        if (!key) return fail(c, 400, "KEY_REQUIRED", "缺少任务 key", "key");
        if (!["pause", "resume", "cancel"].includes(action)) {
          return fail(c, 400, "ACTION_INVALID", "action 只能是 pause / resume / cancel", "action");
        }
        try {
          const result =
            action === "pause"
              ? await pauseDownload(sdk, dataDir, key)
              : action === "resume"
                ? await resumeDownload(sdk, dataDir, key)
                : await cancelDownload(sdk, dataDir, key);
          return c.json({ ok: true, download: result.download });
        } catch (error) {
          // 状态不允许（已暂停又暂停）是 409，其他是 502。
          const message = messageOf(error);
          const status = /不能|状态/.test(message) ? 409 : 502;
          return fail(c, status, "DOWNLOAD_ACTION_FAILED", message);
        }
      }),
    );

    app.post(
      "/check",
      route(async (c) => {
        const result = await runPollCheck({ source: "route" });
        if (!result.ok) {
          return fail(c, 502, result.code ?? "POLL_FAILED", messageOf(result.error));
        }
        return c.json({
          ok: true,
          notModified: result.notModified ?? false,
          newVersions: (result.newVersions || []).map((item) => item.tag),
          checkedAt: result.checkedAt ?? null,
        });
      }),
    );

    app.post(
      "/mirror-probe",
      route(async (c) => {
        const body = (await readJson(c)) ?? {};
        const settings = currentSettings();
        const tag = typeof body.tag === "string" && body.tag ? body.tag : null;
        const name = typeof body.name === "string" && body.name ? body.name : null;
        if (!tag || !name) {
          return fail(c, 400, "TARGET_REQUIRED", "探测需要一个真实的 tag 与附件名");
        }
        // 探的是当前生效的那一条（空串即直连 GitHub）。
        const probe = await probeMirror(sdk, {
          mirror: settings.mirror,
          owner: REPO_OWNER,
          repo: REPO_NAME,
          tag,
          asset: name,
        });
        const saved = writeSettings(store, { ...settings, mirrorProbe: probe.probe });
        return c.json({ ok: true, probe, mirror: saved.mirror, mirrorProbe: saved.mirrorProbe });
      }),
    );

    return undefined;
  };

  try {
    await sdk.routes.register(routeApp);
  } catch (error) {
    // 路由没注册上意味着两个页面拿不到数据，这是要让人看见的故障，不是静默降级。
    logWarn("oh-releases 后端路由未注册：" + messageOf(error));
  }

  // ------------------------------------------------------------ 就绪日志

  logInfo(
    "oh-releases 已装载：dataDir=" + dataDir + "，库里 " + store.countVersions() + " 个版本，回填状态 " + store.getBackfillState(),
  );

  // 冷启动不预置任何版本：库空、backfill_state=0，等用户点回填或等轮询到点。
  // 只把设置补齐——缺项回落到默认值（默认镜像是空表里没有 probe 的初值）。
  const settings = currentSettings();
  if (!store.getState(STATE_SETTINGS, null)) {
    writeSettings(store, settings);
  }
});

/** 探测当前生效的下载源：发一个字节的 Range 请求，看是否 206 + content-range。 */
async function probeMirror(sdk, { mirror, owner, repo, tag, asset }) {
  const url = resolveUrl(mirror, { owner, repo, tag, asset });
  const checkedAt = nowMs();
  try {
    const response = await sdk.network.fetch(url, {
      method: "GET",
      headers: { range: "bytes=0-1023" },
      timeoutMs: 15000,
    });
    const contentRange = typeof response.headers?.get === "function"
      ? response.headers.get("content-range")
      : null;
    const supportsRange = response.status === 206 && Boolean(contentRange);
    // 把响应体排空，别占着连接。
    try {
      await response.arrayBuffer();
    } catch {
      // 读不掉就算了：探测结果已经拿到。
    }
    return {
      url,
      status: response.status,
      probe: { state: response.ok || response.status === 206 ? "reachable" : "unreachable", supportsRange, checkedAt },
    };
  } catch (error) {
    return {
      url,
      status: null,
      probe: { state: "unreachable", supportsRange: null, checkedAt, error: messageOf(error) },
    };
  }
}
