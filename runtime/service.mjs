/**
 * runtime/service.mjs — 常驻下载服务。
 *
 * 为什么要有它：原来一次下载起一个进程，各自的连接数各算各的，「总连接数」
 * 根本无从谈起。要让用户设的那个数真的是总数，所有任务必须在同一个进程里，
 * 共享同一个连接池。这个文件就是那个进程。
 *
 * ## 怎么被拉起
 *
 * App 侧 runtime.start({ entry:"runtime/service.mjs", service:{ port, readyMarker } })。
 * 宿主等 stdout 上出现 readyMarker 才认为服务就绪，之后 App 用
 * runtime.fetch(runtimeId, path, init) 调它 —— 那是唯一被授权的双向通道。
 *
 * ## 接口（都是 JSON）
 *
 *   GET  /status              连接池与所有任务的快照
 *   POST /enqueue             开始一个下载任务
 *   POST /cancel?key=...      取消并删掉半成品
 *   POST /pause?key=...       暂停（保留半成品，可续传）
 *   POST /resume?key=...      继续
 *   POST /pool                调总连接数
 *   POST /shutdown            退出
 *
 * ## 任务生命周期
 *
 * enqueue 之后立刻返回，下载在后台跑。状态保存在内存里，进度另外每秒写一次
 * 控制文件 —— 那是跨进程重启的唯一依据（这个进程被杀掉后，App 会重新拉起它，
 * 靠控制文件里的分片进度接着下）。
 */
import http from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createPool } from "./pool.mjs";
import { runTask } from "./downloader.mjs";

const port = Number(process.argv[2]) || 46311;
const readyMarker = process.argv[3] ?? "OH_RELEASES_READY";

/** 总连接数的默认值与界。 */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 1024;

const pool = createPool({ limit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

/**
 * 所有任务会话。key 是 "<tag>/<文件名>"。
 *
 * @type {Map<string, {
 *   key: string, tag: string, name: string, destination: string,
 *   state: string, done: number, total: number|null,
 *   speed: number|null, connections: number,
 *   startedAt: number, finishedAt: number|null,
 *   error: object|null, path: string|null, verified: boolean,
 *   signal: {aborted: boolean, reason?: string},
 *   promise: Promise<void>|null,
 *   task: object,
 * }>}
 */
const sessions = new Map();

/** 速度采样：用最近几秒的增量算，不用「总量/总时长」——后者会把暂停时间也算进去。 */
const speedOf = (session) => session.speed;

function serialize(session) {
  const conns = pool.heldBy(session.key);
  /**
   * 对外状态。
   *
   * running 不够用：任务可能活着但一条连接也没拿到（别的任务占满了池），
   * 此时它并没有在下。这种“抢不到连接”要单独报出来，否则页面显示
   * “下载中”而连接数是 0，看起来像在空转。
   */
  let state = session.state;
  if (state === "running" && conns === 0) state = "waiting";

  return {
    key: session.key,
    tag: session.tag,
    name: session.name,
    state,
    done: session.done,
    total: session.total,
    speed: state === "running" ? speedOf(session) : null,
    connections: conns,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    error: session.error,
    path: session.path,
    verified: session.verified,
    destination: session.destination,
    // [start, length, written] 的数组；单连接下载时为空。
    segments: Array.isArray(session.segments) ? session.segments : null,
  };
}

/**
 * 启动一个任务。
 *
 * 已经在跑或已经下完的 key 不再重复启动：页面上重复点下载不该变成两个任务。
 */
function startSession(session) {
  if (session.promise) return session.promise;
  const startedAt = Date.now();
  session.startedAt = startedAt;
  session.state = "running";
  session.error = null;
  // 续传时清掉上一轮的收尾时间，否则页面会看到一个“运行中”却已有结束时刻的任务。
  session.finishedAt = null;
  session.signal = { aborted: false };

  // 速度采样窗口。
  let lastSampleAt = Date.now();
  let lastSampleDone = session.done || 0;
  let smoothed = 0;

  session.promise = runTask(
    session.task,
    (record) => {
      if (record.type === "progress") {
        if (Number.isFinite(record.done)) session.done = record.done;
        if (Number.isFinite(record.total)) session.total = record.total;
        // 分片布局直接透传：页面要把每片画在它的文件位置上。
        if (Array.isArray(record.segments)) session.segments = record.segments;
        const now = Date.now();
        const dt = now - lastSampleAt;
        if (dt >= 500) {
          const instant = ((session.done - lastSampleDone) * 1000) / dt;
          // 指数平滑：网络速度抖得厉害，直接显示瞬时值会一直跳。
          smoothed = smoothed ? smoothed * 0.6 + instant * 0.4 : instant;
          session.speed = Math.max(0, Math.round(smoothed));
          lastSampleAt = now;
          lastSampleDone = session.done;
        }
      } else if (record.type === "done") {
        session.speed = null;
      }
    },
    { pool, taskKey: session.key, signal: session.signal },
  )
    .then((result) => {
      session.finishedAt = Date.now();
      session.speed = null;
      if (result?.stopped) {
        // 暂停/取消：状态由调用方设定，这里不覆盖。
        return;
      }
      if (result?.ok) {
        session.state = "completed";
        session.path = result.path ?? null;
        session.verified = result.verified === true;
        if (Number.isFinite(result.bytes)) session.done = result.bytes;
        session.done = session.total ?? session.done;
      } else {
        session.state = "failed";
        session.error = { code: result?.code ?? "DOWNLOAD_FAILED", message: result?.error ?? "下载失败" };
      }
    })
    .catch((error) => {
      session.state = "failed";
      session.finishedAt = Date.now();
      session.error = { code: error?.code ?? "DOWNLOAD_FAILED", message: String(error?.message ?? error) };
    })
    .finally(() => {
      session.promise = null;
    });

  return session.promise;
}

// ---------------------------------------------------------------- HTTP

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // 请求体只有小对象，超过这个量一定不对，截断保护。
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const key = url.searchParams.get("key") ?? "";

  try {
    if (route === "/status" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        pool: pool.snapshot(),
        downloads: [...sessions.values()].map(serialize),
      });
    }

    if (route === "/enqueue" && req.method === "POST") {
      const body = await readBody(req);
      const task = body?.task;
      if (!task || typeof task !== "object" || !task.url || !task.destination) {
        return json(res, 400, { ok: false, error: "enqueue 需要 task.url 与 task.destination" });
      }
      const taskKey = String(body.key ?? task.destination);
      const existing = sessions.get(taskKey);
      if (existing && (existing.state === "running" || existing.state === "paused")) {
        return json(res, 200, { ok: true, started: false, download: serialize(existing) });
      }

      const session = {
        key: taskKey,
        tag: String(body.tag ?? ""),
        name: String(body.name ?? path.basename(task.destination)),
        destination: task.destination,
        state: "queued",
        done: 0,
        total: Number.isFinite(Number(task.totalBytes)) ? Number(task.totalBytes) : null,
        speed: null,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        path: null,
        verified: false,
        signal: { aborted: false },
        promise: null,
        task,
        segments: null,
      };
      sessions.set(taskKey, session);
      // 不 await：enqueue 要立刻返回，下载在后台跑。
      startSession(session);
      return json(res, 200, {
        ok: true,
        started: true,
        download: serialize(session),
        pool: pool.snapshot(),
      });
    }

    if (route === "/pause" && req.method === "POST") {
      const session = sessions.get(key);
      if (!session) return json(res, 404, { ok: false, error: "没有这个任务：" + key });
      if (session.state !== "running") {
        return json(res, 409, { ok: false, error: "任务当前状态是 " + session.state + "，不能暂停" });
      }
      session.signal.aborted = true;
      session.signal.reason = "pause";
      // 排队等许可的 worker 要立刻退出，不然它们会一直挂着占位置。
      pool.cancelWaiting(key);
      session.state = "paused";
      session.speed = null;
      return json(res, 200, { ok: true, download: serialize(session) });
    }

    if (route === "/resume" && req.method === "POST") {
      const session = sessions.get(key);
      if (!session) return json(res, 404, { ok: false, error: "没有这个任务：" + key });
      if (session.state !== "paused") {
        return json(res, 409, { ok: false, error: "任务当前状态是 " + session.state + "，不能继续" });
      }
      // 等上一轮的 worker 真正收尾再起新的，否则两个会话会同时写同一个 .part。
      const previous = session.promise;
      if (previous) {
        try {
          await previous;
        } catch {
          // 已经结束。
        }
      }
      startSession(session);
      return json(res, 200, { ok: true, download: serialize(session) });
    }

    if (route === "/cancel" && req.method === "POST") {
      const session = sessions.get(key);
      if (!session) return json(res, 404, { ok: false, error: "没有这个任务：" + key });
      const wasRunning = session.state === "running";
      session.signal.aborted = true;
      session.signal.reason = "cancel";
      pool.cancelWaiting(key);
      session.state = "canceled";
      session.speed = null;
      session.finishedAt = Date.now();
      // 取消意味着"不要这个文件了"：等 worker 收尾再删半成品，
      // 不然它们还在写，删了会被重新创建出来。
      const previous = session.promise;
      const cleanup = async () => {
        if (wasRunning && previous) {
          try {
            await previous;
          } catch {
            // 已经结束。
          }
        }
        // 半成品与控制文件一起清。只删 .part 会留下一份“看起来还能续传”
        // 的进度记录，下次下同一个文件时会按它去接，而文件已经不在了。
        for (const suffix of [".part", ".part.json"]) {
          rmSync(session.destination + suffix, { force: true });
        }
        if (typeof session.task?.controlPath === "string" && session.task.controlPath) {
          rmSync(session.task.controlPath, { force: true });
        }
      };
      await cleanup();
      return json(res, 200, { ok: true, download: serialize(session) });
    }

    if (route === "/pool" && req.method === "POST") {
      const body = await readBody(req);
      const limit = pool.setLimit(body?.limit);
      return json(res, 200, { ok: true, pool: pool.snapshot(), limit });
    }

    if (route === "/shutdown" && req.method === "POST") {
      pool.close();
      json(res, 200, { ok: true });
      // 给响应一点时间发出去再退。
      setTimeout(() => process.exit(0), 50);
      return undefined;
    }

    return json(res, 404, { ok: false, error: "没有这个接口：" + route });
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  // 宿主在等这一行。格式不敏感，出现这个词就算就绪。
  process.stdout.write(readyMarker + " " + port + "\n");
});

// 进程收到终止信号时把它当正常的收尾：已经写下的分片进度会留在控制文件里。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const session of sessions.values()) {
      if (session.state === "running") {
        session.signal.aborted = true;
        session.signal.reason = "pause";
      }
    }
    pool.close();
    process.exit(0);
  });
}

export { server, sessions, pool };
