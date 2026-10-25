/**
 * src/lib/jobs.js — App 进程内的任务账簿。
 *
 * 回填与下载都是长时间运行的工作，页面要能看到进度，而且同一时刻只能有一份
 * 回填在跑（手动触发与定时轮询可能同时到达）。这里就记两件事：
 *
 *   · 当前那次回填（同一时刻至多一次，按链只有一条）
 *   · 每次下载的进度与结局，按 "<tag>/<文件名>" 做 key
 *
 * 账簿只在内存里。进程重启后它清空，而回填本身是能续跑的——真正的进度依据
 * 永远是库里已提交的行数（GET /state 一并给出）。
 */

/** 下载记录保留条数上限：只留最近这些，免得长时间运行后无限增长。 */
const MAX_DOWNLOAD_RECORDS = 50;

const nowMs = () => Date.now();

function messageOf(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  return String(error.message ?? error);
}

function codeOf(error) {
  if (error && typeof error.code === "string" && error.code) return error.code;
  return "JOB_FAILED";
}

export function downloadKey(tag, name) {
  return String(tag) + "/" + String(name);
}

export function createJobs() {
  const downloads = new Map();
  let backfill = null;
  let sequence = 0;

  const nextId = (prefix) => prefix + "-" + nowMs().toString(36) + "-" + (sequence++).toString(36);

  /** 超出上限时按插入顺序丢最旧的已结束记录；还在跑的永远留着。 */
  function trimDownloads() {
    if (downloads.size <= MAX_DOWNLOAD_RECORDS) return;
    for (const [key, record] of downloads) {
      if (downloads.size <= MAX_DOWNLOAD_RECORDS) break;
      if (record.state !== "running") downloads.delete(key);
    }
  }

  return {
    nextId,

    /** 起一次回填。已经有一份在跑就直接把手上的那份给出去，不重复起。 */
    beginBackfill(startTag, source) {
      if (backfill && backfill.state === "running") {
        return { started: false, job: backfill };
      }
      backfill = {
        id: nextId("bf"),
        startTag,
        source: source ?? "manual",
        state: "running",
        startedAt: nowMs(),
        finishedAt: null,
        progress: null,
        summary: null,
        error: null,
        taskId: null,
      };
      return { started: true, job: backfill };
    },

    /** runBackfill 的进度回调落点。 */
    progressBackfill(progress) {
      if (!backfill) return;
      backfill.progress = progress && typeof progress === "object" ? progress : null;
    },

    attachBackfillTask(taskId) {
      if (backfill) backfill.taskId = taskId ?? null;
      return backfill;
    },

    finishBackfill(error, summary) {
      if (!backfill) return null;
      backfill.finishedAt = nowMs();
      if (error) {
        backfill.state = "failed";
        backfill.error = { code: codeOf(error), message: messageOf(error) };
      } else {
        backfill.state = "completed";
        backfill.summary = summary ?? null;
      }
      return backfill;
    },

    /** 读一份回填快照。给不出去就返回 null。 */
    backfillSnapshot() {
      if (!backfill) return null;
      return { ...backfill, running: backfill.state === "running" };
    },

    isBackfillRunning() {
      return Boolean(backfill && backfill.state === "running");
    },

    /** 记一次下载的开头。同一个 key 还在跑就不再起第二份。 */
    beginDownload({ tag, name, total }) {
      const key = downloadKey(tag, name);
      const existing = downloads.get(key);
      if (existing && existing.state === "running") {
        return { started: false, record: existing };
      }
      const record = {
        key,
        tag,
        name,
        state: "running",
        done: 0,
        total: Number.isFinite(total) ? total : null,
        speed: null,
        mode: null,
        attemptMirror: null,
        path: null,
        bytes: null,
        sha256: null,
        expectedSha256: null,
        verified: false,
        startedAt: nowMs(),
        finishedAt: null,
        error: null,
      };
      downloads.set(key, record);
      trimDownloads();
      return { started: true, record };
    },

    /** download.js 的 onProgress 回调落点。未知 kind 忽略，不弄坏下载。 */
    progressDownload(key, progress) {
      const record = downloads.get(key);
      if (!record || !progress || typeof progress !== "object") return;
      if (progress.kind === "progress") {
        if (Number.isFinite(progress.done)) record.done = progress.done;
        if (Number.isFinite(progress.total)) record.total = progress.total;
        if (Number.isFinite(progress.speed)) record.speed = progress.speed;
        if (typeof progress.mode === "string") record.mode = progress.mode;
      } else if (progress.kind === "probe") {
        if (typeof progress.mode === "string") record.mode = progress.mode;
        if (Number.isFinite(progress.total)) record.total = progress.total;
      } else if (progress.kind === "done") {
        if (typeof progress.path === "string") record.path = progress.path;
        if (Number.isFinite(progress.bytes)) record.bytes = progress.bytes;
        record.done = Number.isFinite(progress.bytes) ? progress.bytes : record.done;
      } else if (progress.kind === "error") {
        record.error = { code: "DOWNLOAD_ERROR", message: messageOf(progress.message) };
      }
    },

    /** startDownload 的最终结果落点。result.ok 决定状态。 */
    finishDownload(key, result) {
      const record = downloads.get(key);
      if (!record) return null;
      record.finishedAt = nowMs();
      if (result && result.ok) {
        record.state = "completed";
        if (typeof result.path === "string") record.path = result.path;
        if (Number.isFinite(result.bytes)) record.bytes = result.bytes;
        if (typeof result.mirror === "string") record.attemptMirror = result.mirror;
        // 校验结果要透出来：上游没给 hash 时下载依旧成功，但不能当成“已校验”。
        record.sha256 = typeof result.sha256 === "string" ? result.sha256 : null;
        record.expectedSha256 = typeof result.expectedSha256 === "string" ? result.expectedSha256 : null;
        record.verified = result.verified === true;
        record.error = null;
      } else {
        record.state = "failed";
        record.error = {
          code: result && typeof result.code === "string" ? result.code : "DOWNLOAD_FAILED",
          message: messageOf(result && result.error) ?? "下载失败",
        };
      }
      return record;
    },

    /** 下载任务被整体拒掉（参数不合法、找不到资产的运行期错误）。 */
    failDownload(key, error) {
      const record = downloads.get(key);
      if (!record) return null;
      record.state = "failed";
      record.finishedAt = nowMs();
      record.error = { code: codeOf(error), message: messageOf(error) };
      return record;
    },

    isDownloadRunning(key) {
      return downloads.get(key)?.state === "running";
    },

    listDownloads() {
      return [...downloads.values()].map((record) => ({ ...record }));
    },
  };
}
