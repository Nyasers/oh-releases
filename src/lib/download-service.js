/**
 * src/lib/download-service.js — 常驻下载服务的客户端（跑在 App 主进程）。
 *
 * 下载不再「一次任务起一个进程」，而是一个常驻服务管全部任务。理由是连接池：
 * 「总连接数」必须是所有任务加起来的总数，跨进程没法共享，所以只能同处一进程。
 *
 * ## 通道
 *
 * 宿主只给一条授权的双向通道：runtime.fetch(runtimeId, path, init)，它把请求打到
 * 本 App 自己声明的 loopback 服务上。所以这个文件做的就是选端口、起服务、
 * 记下 runtimeId，之后所有操作都是对它的 HTTP 调用。
 *
 * ## 端口
 *
 * 端口必须由 App 指定并同时写进 service 声明，宿主据此才认这个服务。这里用固定
 * 端口 + 递增试探：固定端口可能被别的程序占了，起不来就换下一个。
 *
 * ## 幸存
 *
 * 服务进程可能因为宿主重启、崩溃而消失。每次调用前先确认它在（runtime.get），
 * 不在就重新拉起。服务端本身不落盘任务列表，所以重启后能恢复的是「文件层面的
 * 续传」，不是「任务列表」——页面看到的任务列表会清空。这是有意的取舍：
 * 落盘任务表要处理版本迁移与并发写，而这里的任务都是用户当场点的。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 服务入口，相对 App 安装目录。 */
export const SERVICE_ENTRY = "runtime/service.mjs";

/** 就绪标记：宿主看到 stdout 上出现它才认为服务可用。 */
const READY_MARKER = "OH_RELEASES_READY";

/** 候选端口。第一个被占就顺延，最多试这么多。 */
const PORT_CANDIDATES = [46311, 46312, 46313, 46314, 46315];

/** 存运行时状态的文件，放在 dataDir 下。重启后先看看旧的那个还活着没有。 */
const STATE_FILE = path.join(".runtime-tmp", "service.json");

/**
 * 服务句柄。一个 App 进程只该有一个服务实例，所以放在模块作用域。
 *
 * @type {{ runtimeId: string, port: number, starting: boolean } | null}
 */
let current = null;
/** 正在拉起中的 Promise：并发调用共用同一次启动，不重复起进程。 */
let startingPromise = null;

const readState = (dataDir) => {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
};

const writeState = (dataDir, value) => {
  try {
    const file = path.join(dataDir, STATE_FILE);
    if (!value) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch {
    // 记不住就记不住：下次重新起一个服务。
  }
};

/** 让服务进程退出。关闭/卸载、或端口冲突要清理时用。 */
export async function stopService(sdk) {
  if (!current) return;
  const { runtimeId } = current;
  current = null;
  startingPromise = null;
  try {
    await sdk.runtime.stop(runtimeId);
  } catch {
    // 已经退了。
  }
}

/**
 * 确保服务在跑，返回它的 runtimeId 与端口。
 *
 * @param {object} sdk
 * @param {string} dataDir
 * @returns {Promise<{runtimeId: string, port: number}>}
 */
async function ensureService(sdk, dataDir, { poolLimit } = {}) {
  if (!sdk?.runtime?.start) throw new Error("下载服务需要 sdk.runtime");

  const wantedPoolLimit = Number(poolLimit);

  // 已经在跑且还是 ready：直接用。
  if (current?.runtimeId) {
    try {
      const info = await sdk.runtime.get(current.runtimeId);
      if (info && (info.state === "ready" || info.state === "starting")) {
        return { runtimeId: current.runtimeId, port: current.port };
      }
    } catch {
      // 拿不到就是没了，往下重起。
    }
    current = null;
  }

  // 并发调用共用一次启动。
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    // 先看上次记下的那个服务还活着没有：宿主重启后旧的 runtimeId 多半已失效，
    // 但仍有可能活着（App 重载而宿主没重启），能复用就别多起一个。
    const saved = readState(dataDir);
    if (saved?.runtimeId) {
      try {
        const info = await sdk.runtime.get(saved.runtimeId);
        if (info && info.state === "ready" && info.service?.state === "ready") {
          current = { runtimeId: saved.runtimeId, port: info.service.port };
          return { runtimeId: current.runtimeId, port: current.port };
        }
      } catch {
        // 旧的没了。
      }
      // 旧记录已经没用了，清掉：否则每次启动都先白查一遍。
      writeState(dataDir, null);
    }

    let lastError = null;
    for (const port of PORT_CANDIDATES) {
      try {
        const info = await sdk.runtime.start({
          runtime: "node",
          entry: SERVICE_ENTRY,
          profile: "local-machine",
          // local-machine 强制要求 external：它没有网络隔离，声明必须如实。
          network: "external",
          cwd: path.join(dataDir, ".runtime-tmp"),
          args: [String(port), READY_MARKER],
          service: { port, readyMarker: READY_MARKER },
        });
        const runtimeId = info?.runtimeId;
        if (!runtimeId) throw new Error("宿主没有返回 runtimeId");

        // 服务要先真的就绪才能 fetch，否则会得到
        // “does not have a ready service”。start 返回时它还是 pending。
        const ready = await waitForReady(sdk, runtimeId);
        if (!ready) {
          try {
            await sdk.runtime.stop(runtimeId);
          } catch {
            // 已经退了。
          }
          throw new Error("下载服务启动后没就绪（端口 " + port + "）");
        }

        current = { runtimeId, port };
        writeState(dataDir, { runtimeId, port, poolLimit: wantedPoolLimit });

        // 服务刚起来时池是默认值：按用户存下的设置立刻对齐。
        // 不能等到下一次下载才对齐——那样页面上的数字会先错一阵。
        if (Number.isInteger(wantedPoolLimit) && wantedPoolLimit >= 1) {
          try {
            await sdk.runtime.fetch(runtimeId, "/pool", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ limit: wantedPoolLimit }),
            });
          } catch {
            // 没对上就用默认值，不影响功能。
          }
        }

        return { runtimeId, port };
      } catch (error) {
        lastError = error;
        // 端口被占就试下一个；其他错误（授权缺失、入口不存在）换端口也没用。
        const message = String(error?.message ?? error);
        if (!/EADDRINUSE|address already in use|port/i.test(message)) throw error;
      }
    }
    throw lastError ?? new Error("下载服务起不来");
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/**
 * 等服务的声明状态变成 ready。
 *
 * start() 返回时服务是 pending：宿主还在等子进程打出 readyMarker。
 * 此时 fetch 会直接报「没有就绪的服务」，所以必须先等。
 *
 * @returns {Promise<boolean>} 就绪返回 true，超时或进入终态返回 false
 */
async function waitForReady(sdk, runtimeId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const info = await sdk.runtime.get(runtimeId);
      if (info?.service?.state === "ready") return true;
      if (info?.state === "exited" || info?.state === "failed" || info?.state === "stopped") {
        return false;
      }
    } catch {
      // 查不到就再等一拍；真的死了下一轮会进终态。
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 调服务的一个接口。
 *
 * @param {object} sdk
 * @param {string} dataDir
 * @param {string} route  形如 "/status" 或 "/pause?key=..."
 * @param {object} [body] 给了就是 POST，不给是 GET
 */
async function callService(sdk, dataDir, route, body, options) {
  const { runtimeId } = await ensureService(sdk, dataDir, options);
  const init =
    body === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

  let response;
  try {
    response = await sdk.runtime.fetch(runtimeId, route, init);
  } catch (error) {
    // 服务没了：丢掉句柄，让下一次调用重起。
    // 这次如实报错，不在这里静默重试——用户点的动作有没有生效必须说清楚。
    current = null;
    throw new Error("下载服务不可用：" + String(error?.message ?? error));
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("下载服务返回了非 JSON（状态 " + response.status + "）：" + text.slice(0, 200));
  }
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error ?? "下载服务调用失败（状态 " + response.status + "）";
    const error = new Error(message);
    error.serviceStatus = response.status;
    throw error;
  }
  return payload;
}

/** 连接池与所有任务的状态快照。 */
export async function serviceStatus(sdk, dataDir, options) {
  return await callService(sdk, dataDir, "/status", undefined, options);
}

/** 调总连接数。 */
export async function setPoolLimit(sdk, dataDir, limit) {
  return await callService(sdk, dataDir, "/pool", { limit });
}

/**
 * 入队一个下载。
 *
 * @param {object} options
 * @param {object} options.task 下载器的任务对象（url/destination/expectedSha256/…）
 * @param {string} options.key  任务标识（"<tag>/<文件名>"）
 */
export async function enqueueDownload(sdk, dataDir, { key, tag, name, task, poolLimit }) {
  return await callService(sdk, dataDir, "/enqueue", { key, tag, name, task }, { poolLimit });
}

export async function pauseDownload(sdk, dataDir, key) {
  return await callService(sdk, dataDir, "/pause?key=" + encodeURIComponent(key), {});
}

export async function resumeDownload(sdk, dataDir, key) {
  return await callService(sdk, dataDir, "/resume?key=" + encodeURIComponent(key), {});
}

export async function cancelDownload(sdk, dataDir, key) {
  return await callService(sdk, dataDir, "/cancel?key=" + encodeURIComponent(key), {});
}

/** 服务在不在（不开服务，只查状态）。给「下载服务未运行」这类提示用。 */
export function serviceKnown() {
  return Boolean(current);
}

export { existsSync as serviceStateFileExists };
