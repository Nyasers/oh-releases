/**
 * src/lib/download.js — 下载调度（跑在服务端）。
 *
 * 负责：选镜像、拼 URL、起受管运行时、读子进程的进度行、把结果落进任务记录。
 * 真正的下载在 runtime/downloader.mjs 里，跑在受管运行时中。
 *
 * ## 受管运行时能写任意路径、也不受网络白名单约束
 *
 * local-machine 在 Windows 上是 win32-job 后端、enforcement: "none"、grants: {}：
 * 子进程以普通令牌运行，宿主**不给**它注 --permission 那一套参数。所以下载器能写
 * 任意用户可写目录，落点不需要被锁在 dataDir 里。
 *
 * 网络同理：清单里的 network.allowedHosts 只管 AppHost 主进程自己发出的请求，
 * 下载器的出站不经那层校验。镜像源可以随意增删，不需要改清单。
 *
 * 宿主仍然校验的只有两件：必须显式声明 network: "external"（这是声明，不是能力
 * 授予）；**拒绝** readRoots / writeRoots / callToken / taskId；cwd 必须落在 App
 * 数据目录或已授权可写根内。所以 cwd 给数据目录下的暂存区，**真正的落盘位置由
 * task.destination 决定**，不经 cwd 也不经 writeRoots。
 *
 * 仍然用 ctx.runtime.start 而不是 process.spawn：受 --permission 约束的 AppHost 里，
 * 自己 spawn 出的子进程会**继承**权限模型，出站被拒；靠 --allow-fs-write 能补回写
 * 权限，但出站权限补不回来。受管运行时由宿主按 profile 拉起，绕开这层继承，
 * 也不需要自带 node 二进制、不需要分平台发布。
 *
 * ## 怎么读进度
 *
 * runtime.start() 返回的是一条记录（runtimeId 等），**不是进程句柄**。stdout 有两个
 * 出口，都不适合当权威通道：
 *   · runtime.get(runtimeId).log —— 只留最后 64 KiB；
 *   · runtime.watch(runtimeId) —— NDJSON 流，但待发队列上限 16 条，慢读者会丢中间行。
 * 所以进度走 watch（尽力而为），**权威结果写在 resultPath 指向的文件里**，进程结束后读。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * GitHub 上 Release 附件的固定路径（不含主机）。
 *
 * 镜像就是一个反代前缀，下载地址 = 前缀 + 这段路径。不内置任何镜像：
 * 走哪条线路由用户自己填，填空则直连 GitHub。
 */
export function assetPath({ owner, repo, tag, asset }) {
  return ["github.com", owner, repo, "releases", "download", tag, asset]
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * 拼出下载地址。
 *
 * mirror 是用户填的前缀（可空）：
 *   ""                          → https://github.com/<owner>/<repo>/…
 *   "https://ghproxy.net/"      → https://ghproxy.net/github.com/<owner>/<repo>/…
 *   "https://gh-proxy.com"      → 同上，末尾斜线可有可无
 *
 * 前缀里若已经带了 `https://github.com/` 这类完整地址，就不再重复拼路径前缀，
 * 让用户把整条模板贴进来也能跑。
 */
export function resolveUrl(mirror, target) {
  const base = typeof mirror === "string" ? mirror.trim() : "";
  const suffix = assetPath(target);
  if (!base) return "https://" + suffix;
  if (/\/(?:releases\/download|[^/]+\/releases\/download)\//.test(base)) {
    // 已经是完整地址：只把占位符换掉。
    return fillPlaceholders(base, target);
  }
  return base.replace(/\/+$/, "") + "/" + suffix;
}

/** 把旧式的 {owner} {repo} {tag} {asset} 占位符填上。 */
function fillPlaceholders(template, { owner, repo, tag, asset }) {
  return template
    .replaceAll("{owner}", encodeURIComponent(owner))
    .replaceAll("{repo}", encodeURIComponent(repo))
    .replaceAll("{tag}", encodeURIComponent(tag))
    .replaceAll("{asset}", encodeURIComponent(asset));
}

/**
 * 下载地址候选：只有一条。
 *
 * 不内置镜像，也不再排优先级——用户配的那条就是唯一入口。
 * supportsRange 恒为 null（未知）：分片与否由下载器探测结果决定，不预设。
 */
export function planCandidates(mirror, target) {
  return [{ id: "mirror", url: resolveUrl(mirror, target), supportsRange: null }];
}

/** 下载器入口，相对 App 安装目录。宿主校验它必须落在安装/数据目录内。 */
export const DOWNLOADER_ENTRY = "runtime/downloader.mjs";

/**
 * 任务文件与结果的暂存目录（在 dataDir 下）。
 *
 * 名字跟宿主的约定一致：App 数据目录下的临时产物统一放在 .runtime-tmp。
 * 这里只放传给子进程的 task.json 与读回来的 result.json，真正的安装包落在
 * 用户配置的下载目录。
 */
export const SCRATCH_DIR = ".runtime-tmp";

/** 文件名安全化：只留最后一段，挡掉路径穿越与非法字符。 */
export function safeFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "download.bin";
}

/** 还在生成、或正在写：这类读失败下一跳就能成，不必记日志。 */
function isTransientReadError(error) {
  return error?.code === "ENOENT" || error?.name === "SyntaxError";
}

/**
 * 起一个下载任务。
 *
 * @param {object} options
 * @param {object} options.sdk          defineApp 里的 sdk（需要 runtime 与 tasks）
 * @param {string} options.dataDir      ctx.dataDir
 * @param {string} options.downloadDir  落盘目录（任意绝对路径；不存在会被建）
 * @param {string} options.mirror        反代前缀；空串则直连 GitHub
 * @param {string} options.tag          版本 tag
 * @param {object} options.asset        { name, size, sha256 }
 * @param {string} [options.owner]
 * @param {string} [options.repo]
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<object>} 一份结果：成功时有 path/shá256/bytes，失败时有 error
 */
export async function startDownload({
  sdk,
  dataDir,
  downloadDir,
  tag,
  asset,
  mirror = "",
  owner = "liliMozi",
  repo = "openhanako",
  onProgress,
} = {}) {
  if (!sdk?.runtime?.start) throw new Error("startDownload 需要 sdk.runtime");
  if (typeof dataDir !== "string" || !dataDir) throw new Error("startDownload 需要 dataDir");
  if (typeof downloadDir !== "string" || !downloadDir) throw new Error("startDownload 需要 downloadDir");
  if (typeof tag !== "string" || !tag) throw new Error("startDownload 需要 tag");
  if (!asset || typeof asset.name !== "string" || !asset.name) {
    throw new Error("startDownload 需要 asset.name");
  }

  // 落盘目录可以是任意路径：下载器跑在 local-machine 里，没有文件系统隔离。
  //
  // 这里**不** mkdir 目标目录：主进程仍受 --permission 约束，只能写 dataDir，
  // 在盘外建目录会被拒。下载器在子进程里建（它有完整文件系统权限）。
  const resolvedData = path.resolve(dataDir);
  const resolvedDownload = path.resolve(downloadDir);

  // 任务文件放在数据目录下的暂存区：它的路径要经 args 传给子进程。
  const scratch = path.join(resolvedData, SCRATCH_DIR);
  mkdirSync(scratch, { recursive: true });

  const target = safeFileName(asset.name);
  const destination = path.join(resolvedDownload, target);
  const stem = tag + "-" + target;
  const taskPath = path.join(scratch, stem + ".task.json");
  const resultPath = path.join(scratch, stem + ".result.json");
  // 进度控制文件也放进暂存区，不放下载目录旁边。
  //
  // 读它的是主进程，而主进程受 --permission 约束、只能读 dataDir：落点在任意
  // 盘位时，读 destination 旁边的 .part.json 会一直失败，界面停在 0%。
  // 写它的是下载器子进程，它写 dataDir 没有阻力。
  const controlPath = path.join(scratch, stem + ".part.json");

  // 上一轮的结果不能当这一轮的：先清掉，否则读到的可能是旧的"成功"。
  rmSync(resultPath, { force: true });

  const candidates = planCandidates(mirror, { owner, repo, tag, asset: target });
  if (!candidates.length) {
    return { ok: false, tag, name: target, error: "镜像地址拼不出来，检查设置里的镜像前缀" };
  }

  // 逐个候选试。正常只有一条；失败就直接报错，不自己换源。
  const attempts = [];
  for (const candidate of candidates) {
    const task = {
      url: candidate.url,
      destination,
      resultPath,
      controlPath,
      expectedSha256: typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : null,
      totalBytes: Number.isFinite(asset.size) ? asset.size : null,
      // connections 不写死：下载器按文件大小自适应（小文件 2 条、
      // 中等 4 条、大文件 8 条）。只有探针确定不支持分片时才明说 1。
      connections: candidate.supportsRange === false ? 1 : undefined,
    };
    writeFileSync(taskPath, JSON.stringify(task, null, 2));

    let runtimeId = null;
    // 从磁盘读进度的定时器。
    //
    // watch 是尽力而为的：宿主待发队列只有 16 条，慢读者会丢中间行；
    // 实测下进度行会被整段丢掉，界面一直停在 0%。
    // 而下载器会把每段已写字节按 1 秒节流写进 `.part.json`，那是磁盘上的权威值。
    // 直接读它，不依赖任何流通道，重启后也能接上。
    let diskTimer = null;
    if (typeof onProgress === "function") {
      // 只报一次失败原因：这个定时器 500ms 一跳，不节流会把日志刷满。
      let controlErrorLogged = false;
      diskTimer = setInterval(() => {
        let raw;
        try {
          raw = JSON.parse(readFileSync(controlPath, "utf8"));
        } catch (error) {
          // 文件还没生成、或刚好在写：正常。但若是权限、路径不对，
          // 就会一直读不到而界面卡在 0%，必须留下能查的痕迹。
          if (!controlErrorLogged && !isTransientReadError(error)) {
            controlErrorLogged = true;
            console.warn("[oh-releases] 读进度控制文件失败：" + controlPath + " — " + (error.code ?? error.message));
          }
          return;
        }
        const segments = Array.isArray(raw?.segments) ? raw.segments : [];
        const done = segments.reduce((sum, seg) => sum + (Number(seg.written) || 0), 0);
        const total = Number(raw?.total) || 0;
        if (done > 0) {
          onProgress({ kind: "progress", tag, name: target, done, total: total || undefined, speed: null, mode: "parallel" });
        }
      }, 500);
      if (typeof diskTimer.unref === "function") diskTimer.unref();
    }

    try {
      const info = await sdk.runtime.start({
        runtime: "node",
        entry: DOWNLOADER_ENTRY,
        profile: "local-machine",
        network: "external",
        // cwd 只能是数据目录内的路径（宿主校验）；真正的落盘位置由 task.destination 决定。
        cwd: scratch,
        // local-machine 明确拒绝 readRoots / writeRoots / callToken / taskId，
        // 所以任务文件路径只能走 args。
        args: [taskPath],
      });
      runtimeId = info?.runtimeId ?? null;
      attempts.push({ mirror: candidate.id, runtimeId, url: candidate.url });

      // 尽力而为的进度：watch 的待发队列只有 16 条，慢读者会丢中间行，
      // 所以它只用来更新进度，不作为成败依据。
      if (runtimeId && typeof onProgress === "function") {
        await pumpProgress(sdk, runtimeId, { tag, name: target, onProgress });
      } else if (runtimeId) {
        // 没人听进度也要把流排空，否则宿主的待发队列会一直挂着。
        await drainWatch(sdk, runtimeId);
      }

      // 权威结果在文件里。等到它出现（或进程结束）再判定。
      const result = await readResult(resultPath, sdk, runtimeId);
      if (result?.ok) {
        return { ...result, tag, name: target, mirror: candidate.id, attempts };
      }
      attempts[attempts.length - 1].error = result?.error ?? "未知失败";
    } catch (error) {
      attempts[attempts.length - 1] = attempts[attempts.length - 1] ?? {};
      attempts[attempts.length - 1].error = String(error?.message ?? error);
    } finally {
      if (diskTimer) clearInterval(diskTimer);
      // 受管运行时是短命进程，下完/失败都该收掉，别占着 4 个并发配额。
      if (runtimeId) {
        try {
          await sdk.runtime.stop(runtimeId);
        } catch {
          // 已经自己退了。
        }
      }
      // 任务文件与结果文件已经用完，删掉。不删就会每下一次留两份，
      // 随着版本累积把数据目录塞满。
      rmSync(taskPath, { force: true });
      rmSync(resultPath, { force: true });
    }
  }

  return {
    ok: false,
    tag,
    name: target,
    error: "下载失败：" + attempts.map((a) => a.error ?? "?").join("; "),
    attempts,
  };
}

/** 把 watch 的 NDJSON 逐行喂给 onProgress，直到流结束。 */
async function pumpProgress(sdk, runtimeId, { tag, name, onProgress }) {
  try {
    const response = await sdk.runtime.watch(runtimeId);
    await consumeNdjson(response, (record) => {
      if (record.type === "progress") {
        onProgress({ kind: "progress", tag, name, done: record.done, total: record.total, speed: record.speed, mode: record.mode });
      } else if (record.type === "probe") {
        onProgress({ kind: "probe", tag, name, range: record.range, total: record.total });
      } else if (record.type === "error") {
        onProgress({ kind: "error", tag, name, message: record.message });
      } else if (record.type === "done") {
        onProgress({ kind: "done", tag, name, path: record.path, bytes: record.bytes });
      }
    });
  } catch {
    // 进度通道断了不影响结果：结果从文件读。
  }
}

/** 只排空 watch 流，不回调。 */
async function drainWatch(sdk, runtimeId) {
  try {
    const response = await sdk.runtime.watch(runtimeId);
    await consumeNdjson(response, () => {});
  } catch {
    // 同上。
  }
}

/** 逐行解析 NDJSON。行可能被切在块边界上，所以留一个残留缓冲。 */
async function consumeNdjson(response, onRecord) {
  const body = response?.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let index = buffered.indexOf("\n");
      while (index >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (line) {
          try {
            onRecord(JSON.parse(line));
          } catch {
            // 半行或非 JSON：跳过。
          }
        }
        index = buffered.indexOf("\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已经释放。
    }
  }
}

/**
 * 读权威结果。
 *
 * 下载器把结果写进 resultPath 才退出，所以等到"文件出现"或"运行时进入终态"即可。
 * 给了宽限：进程刚退出时文件可能还在 flush。
 */
async function readResult(resultPath, sdk, runtimeId) {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (existsSync(resultPath)) {
      try {
        return JSON.parse(readFileSync(resultPath, "utf8"));
      } catch {
        // 正在写，下一轮再读。
      }
    }
    if (runtimeId && sdk?.runtime?.get) {
      try {
        const info = await sdk.runtime.get(runtimeId);
        const terminal =
          info && (info.state === "exited" || info.state === "failed" || info.state === "stopped");
        if (terminal) {
          // 终态之后再宽限一轮，给文件 flush 留时间。
          if (existsSync(resultPath)) continue;
          return { ok: false, error: "下载器退出但没有写结果（退出码 " + (info.exitCode ?? "?") + "）" };
        }
      } catch {
        // get 失败不致命，继续等文件。
      }
    }
    if (Date.now() > deadline) {
      return { ok: false, error: "等待下载结果超时" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
