/**
 * runtime/downloader.mjs — 受管运行时里的下载器。
 *
 * 由 App 主进程经 ctx.runtime.start({ runtime:"node", profile:"local-machine" }) 拉起，
 * argv[2] 是一份任务 JSON 的路径。只用 Node 内建模块，零 npm 依赖。
 *
 * ## 为什么是受管运行时而不是自己 spawn
 *
 * 受 --permission 约束的 AppHost 里，自己 spawn 出的子进程会**继承**权限模型，出站被拒。
 * 受管运行时由宿主按 profile 拉起，local-machine 在 Windows 上是 win32-job、enforcement: "none"，
 * 以普通令牌运行：文件系统与网络都没有隔离，可正常出站、可写任意用户可写目录。
 * 不需要自带 node 二进制，也不需要分平台发布。
 *
 * ## 先探测再决定要不要分片
 *
 * 各家镜像对 Range 的支持不一致（实测 GitHub 直连与 ghproxy.net 支持、gh-proxy.com
 * 对大文件返回 200、ghfast.top 超时），所以不能假定。先发 Range: bytes=0-1023：
 * 只有回来 206 且带 content-range 才算支持分片，否则退成单连接流式。
 *
 * ## 完整性
 *
 * 全程写临时文件，校验通过后才改名到正式名。sha256 不符就删掉临时文件、报错退出，
 * 绝不留下一个"看起来下完了"的坏文件。
 *
 * ## 输出
 *
 * stdout 每行一个 JSON：progress / probe / error / done。进度是尽力而为的观察通道
 * ——宿主的 watch() 对慢读者会丢中间行（待发队列上限 16 条），所以**权威结果写在
 * resultPath 指向的文件里**，App 侧在进程结束后读那个文件，不依赖 stdout 不丢行。
 *
 * 任务 JSON（argv[2] 指向它）：
 *   {
 *     "url":           下载地址（必填）
 *     "destination":   落地文件的绝对路径（必填）
 *     "resultPath":    权威结果写这里的绝对路径（必填）
 *     "controlPath":   进度控制文件的绝对路径（可选；不给就放在 destination 旁边）
 *     "expectedSha256": 期望的 sha256，小写十六进制（可选；给了就必须匹配）
 *     "totalBytes":    上游声明的总字节数（可选，仅用于进度分母）
 *     "connections":   分片连接数，默认 4
 *     "maxRetries":    单个分片的重试次数，默认 2
 *     "timeoutMs":     单次请求的超时，默认 30000
 *   }
 *
 * 用法：node runtime/downloader.mjs <task.json>
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.mjs";

const DEFAULT_CONNECTIONS = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 6;

/**
 * 单个任务的并发上限。
 *
 * 不再人为收窄：机器与镜像能吃多少就让它吃多少。实际能开多少最终取决于
 * 连接池的额度，以及用户的设置。
 */
const MAX_WORKERS = 1024;

/**
 * 自适应并发的两个阀值：一块下得快说明带宽还没用满，可以再开一条；
 * 慢成那样说明镜像在限速，多开只会一起变慢。
 *
 * 定在 512KB/s / 128KB/s：单连接在正常宽带上通常能跑到几 MB/s，
 * 低于 512KB 说明这一路确实吃紧。
 */
const FAST_CHUNK_BYTES_PER_SEC = 512 * 1024;
const SLOW_CHUNK_BYTES_PER_SEC = 128 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const USER_AGENT = "oh-releases/0.1 (+hana app)";

// ---------------------------------------------------------------- 输出

const emit = (record) => {
  try {
    process.stdout.write(JSON.stringify(record) + "\n");
  } catch {
    // stdout 关了（宿主提前回收）：进度丢一条不影响下载本身。
  }
};

const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

const removeIfExists = (file) => {
  try {
    unlinkSync(file);
  } catch {
    // 本来就不在。
  }
};

/**
 * 列出某个目标文件留下的所有分片：`.part`（单连接）与 `.partN`（分连接）。
 * 文件名前缀精确到 `目标名 + ".part"`，不会误伤同目录里的其他文件。
 */
const listParts = (destination) => {
  const dir = path.dirname(destination);
  const base = path.basename(destination) + ".part";
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name === base || name.startsWith(base)).map((name) => path.join(dir, name));
};

// ---------------------------------------------------------------- HTTP

/**
 * 发一次 GET，跟随重定向。**不自动消费响应体**——调用方决定是读流还是丢弃。
 *
 * GitHub 的 release 下载地址会 302 到 objects.githubusercontent.com，所以必须跟随。
 * 限制跳转次数，避免镜像配了一个打转的地址把进程挂住。
 */
function request(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = 6, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    /**
     * 能中途抬断的入口。
     *
     * 只在取消时用：暂停的语义是“让手上的片下完再停”，不硬断。
     * 已发出、还在等响应头的请求如果不断，会挂到单次超时（默认 30 秒）——
     * 但那就只是慢一点，不影响正确性；而硬断会变成一次失败。
     */
    let activeReq = null;
    if (signal && typeof signal.onAbort === "function") {
      signal.onAbort(() => {
        try {
          if (activeReq) activeReq.destroy();
        } catch {
          // 已结束。
        }
      });
    }

    const go = (currentUrl, hops) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        done(reject, new Error("非法 URL：" + currentUrl));
        return;
      }
      const mod = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
      if (!mod) {
        done(reject, new Error("不支持的协议：" + parsed.protocol));
        return;
      }

      const req = mod.request(
        parsed,
        {
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume(); // 丢掉跳转响应体
            if (hops >= maxRedirects) {
              done(reject, new Error("重定向次数超过 " + maxRedirects + " 次"));
              return;
            }
            go(new URL(res.headers.location, parsed).toString(), hops + 1);
            return;
          }
          done(resolve, res);
        },
      );

      // 记下当前请求，好让暂停时能立刻抬掉它。
      activeReq = req;

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("请求超时（" + timeoutMs + "ms）：" + currentUrl));
      });
      req.on("error", (error) => done(reject, error));
      req.end();
    };

    go(url, 0);
  });
}

/**
 * 把一段响应体泵进目标文件流，**并在内部负责收尾**。
 *
 * 认背压：target.write() 返回 false 就 pause 源流，drain 之后 resume。不认的话
 * 大文件下载时写缓冲会一直涨——四个分片并发时涨得更快。
 *
 * ## 为什么由它调 target.end()
 *
 * 目标流的 close 时机必须由**这里**决定，不能交给调用方等：WriteStream 不调
 * end() 就不 close。若这里在 res 的 end 上等 target 的 close，而调用方在
 * await 完这个 Promise 之后才调 end()，两边就互锁（实测挂死 15s 超时）。
 *
 * 所以这里做两件事：泵完响应体后调 target.end(cb)，cb 在流真正写完（或出错）
 * 那一刻触发——那时 targetError 一定已经就位。调用方拿到 resolve 时，
 * 数据已经落盘、流已经收了，不用也不该再调 end()。
 *
 * open 失败是异步的，实测事件顺序是 end -> error -> close：只监听 res 的 end
 * 会在错误到达前就 resolve，所以必须等 end(cb)。
 */
function pipeTo(res, target, onChunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let targetError = null;

    // 目标流的 error 必须接住：写不进去（目录不可写、磁盘满、路径被占用）时，
    // WriteStream 会 emit("error")，没人听就是进程级未捕获异常——整个下载器崩掉，
    // 连一条 error 记录都发不回来。
    target.on("error", (error) => {
      targetError = error;
      res.destroy();
    });

    res.on("data", (chunk) => {
      if (settled || targetError) return;
      try {
        onChunk(chunk);
      } catch (error) {
        targetError = error;
        res.destroy();
        return;
      }
      if (target.write(chunk) === false) {
        res.pause();
        target.once("drain", () => {
          if (!settled && !targetError) res.resume();
        });
      }
    });

    // 响应体读完：收尾目标流，等它彻底落定再判定。
    //
    // 不能只听 end(cb)：实测事件顺序是 end-cb -> error -> close，即回调先于错误。
    // open 失败（目录不可写之类）的报告排在 end 回调之后，这时候看 targetError
    // 还是空的，错误就被吞了。所以 end(cb) 之后再等一次 close——close 总在最后，
    // 那时 error 一定已经派发过。
    res.on("end", () => {
      if (settled) return;
      settled = true;
      const settle = (extra) => {
        if (targetError) reject(targetError);
        else if (extra) reject(extra);
        else resolve(undefined);
      };
      target.end(() => {
        // 一律等 close，不看 target.closed：实测在 end 回调里 closed 可能已经是
        // true，而 out:error(EPERM) 仍排在它之后（顺序：res:end → res:close →
        // out:error → out:close）。拿 closed 当"写成功了"的证据会把写盘错误吞掉。
        let done = false;
        const once = () => {
          if (done) return;
          done = true;
          settle(null);
        };
        target.once("close", once);
        // close 一直不来也不能永远挂住调用方。
        setTimeout(once, 5000).unref?.();
      });
    });

    // 源流出错：目标流仍要收尾，否则文件句柄和写缓冲留在那儿。
    const abortWith = (error) => {
      if (settled) return;
      settled = true;
      const finish = () => reject(targetError ?? error);
      try {
        target.end(() => {
          target.once("close", finish);
          setTimeout(finish, 5000).unref?.();
        });
      } catch {
        finish();
      }
    };

    res.on("error", abortWith);
    res.on("aborted", () => abortWith(new Error("连接被对端中断")));
  });
}

/** 丢弃响应体并返回状态码（探测用）。 */
function drain(res) {
  return new Promise((resolve) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
    res.on("error", () => resolve(res.statusCode ?? 0));
  });
}

// ---------------------------------------------------------------- 探测

/**
 * 探测 Range 支持。（导出给离线测试用；不用写盘，所以能单独验。）
 *
 * 判定标准是 206 + 有 content-range：只看到 206 但缺 content-range 的镜像没法算分片
 * 边界，按不支持处理。返回 total 时优先用 content-range 的总长（比 content-length 准，
 * 后者是这一段的长度）。
 */
export async function probeRange(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await request(url, { headers: { range: "bytes=0-1023" }, timeoutMs });
  } catch (error) {
    return { range: false, reason: "探测请求失败：" + (error?.message ?? String(error)) };
  }

  const status = res.statusCode ?? 0;
  const contentRange = res.headers["content-range"] ?? null;
  const contentLength = res.headers["content-length"] ?? null;
  let total = null;
  if (typeof contentRange === "string") {
    const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
    if (m) total = Number(m[1]);
  }
  await drain(res);

  if (status === 206 && contentRange) {
    return { range: true, status, total, contentRange };
  }
  const declared = contentLength ? Number(contentLength) : null;
  return {
    range: false,
    status,
    total: Number.isFinite(declared) && declared > 0 ? declared : null,
    contentRange,
  };
}

// ---------------------------------------------------------------- 分片规划

/**
 * 分片计划：初始均分，之后「完成一部分就把最大的未完成片二分」。
 *
 * 静态切块的问题是：某片搭上慢连接或断流，总耗时就被它决定，快的连接空着也没用。
 * 二分让慢片不断被切小，剩下的活能分给已经空出来的连接。
 *
 * 续传靠控制文件：片的位置完全由 (start, end, written) 描述，重放同一份记录就能
 * 得到同一套片，不需要重放二分的全过程。
 */
export const MAX_PIECES = 256;
/** 最小片长：低于它就停止二分，否则会退化成一堆碎请求。 */
export const MIN_PIECE_BYTES = 256 * 1024;
/** 初始单片上限：再大就又回到“一片拖住全局”。 */
export const MAX_PIECE_BYTES = 4 * 1024 * 1024;

/** 片长与剩余量。 */
const segLen = (seg) => seg.end - seg.start + 1;
const segLeft = (seg) => segLen(seg) - (Number(seg.written) || 0);

/**
 * 初始计划：直接二分到目标片数。
 *
 * 不先按 worker 数均分再慢慢切：那样开局是 8 片几十 MB 的大片，每个 worker
 * 占一大片慢慢下，切出来的小块没人领（都在忙），二分形同虚设。
 *
 * ## 片数和连接数是两件事
 *
 * 片数多不是为了“每个连接一片”，而是为了「一片卡住时别人有活可干」：
 * 跑得快的连接多领几片，跑得慢的少领，负载自己就均了。片数等于连接数
 * 就成了静态均分，快连接无处多干——实测过，那是 120 秒对 56 秒的差距。
 *
 * ## 实际算出来是多少
 *
 * 目标片数 = worker 数 × 8，但单片被夹在 [256KB, 4MB]。所以对大文件，
 * 真正起作用的是 4MB 上限：523MB 的文件无论 1 条还是 12 条连接，初始都是
 * 125 片。片数只随文件大小变，不随连接数变，这是预期行为。
 *
 * 二分过程中片数会继续长，尾部会多到两三百片。
 */
export function planSegments(total, connections) {
  const workers = Math.max(1, Number(connections) || DEFAULT_CONNECTIONS);
  const target = Math.max(1, Math.min(workers * 8, MAX_PIECES));
  // 单片长度夹在 [MIN_PIECE_BYTES, MAX_PIECE_BYTES]：
  //   太小 → 请求开销与连接建立吃掉收益；
  //   太大 → 又回到“一片拖住全局”的老问题。
  let size = Math.ceil(total / target);
  size = Math.max(MIN_PIECE_BYTES, Math.min(MAX_PIECE_BYTES, size));
  if (total / size > MAX_PIECES) size = Math.ceil(total / MAX_PIECES);

  const segments = [];
  let start = 0;
  let index = 0;
  while (start < total) {
    const end = Math.min(total - 1, start + size - 1);
    segments.push({ index, start, end, length: end - start + 1, written: 0 });
    start = end + 1;
    index += 1;
  }
  return segments;
}
/**
 * 挑当前最大的未完成片，二分它。
 *
 * 返回切出来的左片，或者 null（片数到上限、或最大片已够小）。
 * 已写字节归左片：右片从已写区之后开始，所以「已写」这个量不必重新分配。
 */
export function splitLargestUnfinished(
  segments,
  { maxPieces = MAX_PIECES, minPieceBytes = MIN_PIECE_BYTES, skip = null } = {},
) {
  if (segments.length >= maxPieces) return null;
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (segLeft(seg) <= 0) continue;
    // 正在被下的片不能切：切了以后它的已写量归到左片，
    // 而下载线程仍在按旧的 start/end 写，结果既丢进度又可能写错位置。
    if (skip && skip(seg)) continue;
    const len = segLen(seg);
    // 不再切：等于最小片长时再切就会得到两片一半长度的碎块，
    // 而碎块会让尾部积一堆没人领的极小块。用 <= 而不是 <。
    if (len <= minPieceBytes) continue;
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  if (best < 0) return null;

  const seg = segments[best];
  const mid = seg.start + Math.floor(segLen(seg) / 2);
  if (mid <= seg.start || mid > seg.end) return null;

  const written = Math.min(Number(seg.written) || 0, mid - seg.start);
  const left = { start: seg.start, end: mid - 1, length: mid - seg.start, written };
  const right = { start: mid, end: seg.end, length: seg.end - mid + 1, written: 0 };
  segments.splice(best, 1, left, right);
  // 索引重排：控制文件与 doneBytes 都靠它对齐。
  for (let i = 0; i < segments.length; i += 1) segments[i].index = i;
  return left;
}

// ---------------------------------------------------------------- 单连接

async function downloadSingle({ url, destination, partPath, timeoutMs, onProgress, maxRetries = DEFAULT_MAX_RETRIES }) {
  const already = sizeOf(partPath);
  const headers = already > 0 ? { range: "bytes=" + already + "-" } : {};
  const res = await request(url, { headers, timeoutMs });
  const status = res.statusCode ?? 0;

  // 服务端不认 Range 时会把整个文件重发一遍：此时已下部分是无效的，从头来。
  if (already > 0 && status !== 206) {
    removeIfExists(partPath);
    res.resume();
    return downloadSingle({ url, destination, partPath, timeoutMs, onProgress, maxRetries });
  }
  if (status !== 200 && status !== 206) {
    res.resume();
    throw new Error("下载请求失败：HTTP " + status);
  }

  let total = null;
  const cr = res.headers["content-range"];
  if (typeof cr === "string") {
    const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
    if (m) total = Number(m[1]);
  } else if (res.headers["content-length"]) {
    total = Number(res.headers["content-length"]);
  }

  const hash = createHash("sha256");
  let offset = already;

  // 续跑时已落盘的那部分字节不在本次流里，要单独喂给哈希。
  if (already > 0) {
    await new Promise((resolve, reject) => {
      const rs = createReadStream(partPath);
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("error", reject);
      rs.on("end", resolve);
    });
  }

  // pipeTo 内部负责 end()，返回时数据已落盘、流已关闭；这里不再收尾。
  const out = createWriteStream(partPath, { flags: already > 0 ? "a" : "w" });
  // 落盘失败（目录不可写、磁盘满）由 pipeTo 抛出，如实往上走，不要混成"长度不符"。
  await pipeTo(res, out, (chunk) => {
    hash.update(chunk);
    offset += chunk.length;
    onProgress(offset, total);
  });

  // 上游声明了总长就核一遍。
  if (total !== null && offset !== total) {
    // 对端提前关连接是常态：已写部分留在 .part 里，下一次从头就会从断点续。
    // 不在这里直接认输，不然大文件一旦断流就永远下不完。
    if (maxRetries > 0) {
      const backoff = Math.min(8000, 400 * 2 ** Math.min(5, DEFAULT_MAX_RETRIES - maxRetries));
      await new Promise((r) => setTimeout(r, backoff));
      return downloadSingle({ url, destination, partPath, timeoutMs, onProgress, maxRetries: maxRetries - 1 });
    }
    throw new Error("单连接下载长度不符：期望 " + total + "，实际 " + offset);
  }

  return { bytes: offset, total, sha256: hash.digest("hex") };
}

// ---------------------------------------------------------------- 分片


// ---------------------------------------------------------------- 控制文件

/**
 * 控制文件：记载每个分片已经写了多少字节，放在 `目标名.part.json`。
 *
 * 单文件分片写完后，从文件大小推不出进度（不同区间跳着写，总长恒等于 total），
 * 所以进度必须另外存。没有它就分不清“写了一半”和“完全没开始”。
 *
 * 文件名自己说明它是 `.part` 的附属：不用别人的格式名，免得被误认为其他工具的产物。
 */
/**
 * 控制文件的位置。
 *
 * 默认放在 destination 旁边（.part.json）；App 也可以显式指定。为什么要能指定：
 * 读它的那个进程（App 主进程）受 --permission 约束，只能读 dataDir，而 destination
 * 可能在任意盘位。不把控制文件放到主进程读得到的地方，进度就永远是 0。
 */
const controlPathFor = (destination, explicit) =>
  typeof explicit === "string" && explicit ? explicit : destination + ".part.json";

const CONTROL_VERSION = 1;

/** 读控制文件。不存在、格式不对、或 total 与本次不一致，都当作全新开始。 */
function readControl(file, total) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw?.version !== CONTROL_VERSION) return null;
    if (Number(raw.total) !== Number(total)) return null;
    if (!Array.isArray(raw.segments) || raw.segments.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeControl(file, total, segments) {
  try {
    writeFileSync(file, JSON.stringify({ version: CONTROL_VERSION, total, segments }));
  } catch {
    // 控制文件写不了不影响本次下载，只是丢了续传能力。
  }
}

/**
 * 打开（必要时创建并预分配到 total）单文件的 `.part`。
 *
 * 预分配是为了让并发写不同区间时文件长度始终等于 total，不出现空洞末尾，
 * 也不用在每段写完后操心截断。代价是“文件大小完整”不再代表“已经下完”，
 * 成不成立只能看 sha256——原来的分片长度校验也换成了这个。
 */
async function openPartFile(partPath, total) {
  const fh = await fsPromises.open(partPath, existsSync(partPath) ? "r+" : "w+");
  const stat = await fh.stat();
  if (stat.size !== total) await fh.truncate(total);
  return fh;
}

// ---------------------------------------------------------------- 分片（单文件随机写）

/**
 * 在同一个 `.part` 里写下 segment 指定的区间。
 *
 * 用 fs.write 的 position 参数做随机写，不用流：流只能顺序追加，
 * 几个分片并发就会互相覆盖。
 *
 * 已写字节数由控制文件提供；这里是它的唯一权威来源，文件大小不参与判断。
 */
async function downloadSegmentInFile({
  url,
  fh,
  segment,
  doneBytes,
  timeoutMs,
  maxRetries,
  onProgress,
  onCheckpoint,
  shouldAbort,
  abortSignal,
  signalAdapter,
}) {
  let attempt = 0;
  // 跨重试累计已写字节。doneBytes 是调用方传进来的值（一段的起点进度），
  // 函数内的 have 是本次尝试的局部量；断流重试时必须把上一轮写进去的字节带回来，
  // 否则就从段首重下——大文件每断一次就白下一大截。
  let persisted = doneBytes;
  for (;;) {
    attempt += 1;
    try {
      // 本次的真实边界。不读 segment.length：那个字段只在构造时算过一次，
      // 片被改过边界（削短、二分）之后就不一定等于 end-start+1，
      // 用它会拿旧值判完成或拿旧值算起始位置，两者都会写错。
      const boundaryLen = segment.end - segment.start + 1;
      let have = persisted;
      // 写多了说明进度记录与当前边界不匹配（比如这期间片被切开过）：这段重下。
      if (have > boundaryLen) have = 0;
      if (have === boundaryLen) return { bytes: boundaryLen, resumed: have > 0 };

      const from = segment.start + have;
      const headers = { range: "bytes=" + from + "-" + segment.end };
      const res = await request(url, {
        headers,
        timeoutMs,
        // 暂停/取消时能把“已发出、还在等响应头”的请求也掐掉。
        signal: abortSignal ? signalAdapter : null,
      });
      const status = res.statusCode ?? 0;
      if (status !== 206) {
        res.resume();
        // 镜像中途不再认 Range：重试多少次都一样，直接失败让上层退回单连接。
        const error = new Error("分片请求未返回 206（实际 " + status + "），Range 已不可用");
        error.code = "RANGE_UNAVAILABLE";
        error.retryable = false;
        throw error;
      }

      let pos = from;
      /**
       * 暂停/取消时立刻抬断这条流。
       *
       * 不能只靠“收到下一块时再检查 aborted”：镜像可能十几秒不来数据
       * （单次超时是 30 秒），那段时间连接还开着、许可也还没还，
       * 界面就是“已暂停却仍占着一条连接”。这里直接起个短定时器盯着。
       */
      /**
       * 只有取消才硬断在跑的流。
       *
       * 暂停不硬断：硬断会被下游当成网络错误，进重试；而重试又因为暂停中
       * 而失败，用户只是点个暂停却看到“下载失败”。暂停的语义是“把手上的这片
       * 下完、进度落盘、然后停”，不丢已下的字节。
       *
       * 代价是暂停后可能还要等一下这片收尾（最坏是单片大小），可接受。
       */
      const abortWatch = setInterval(() => {
        const why = shouldAbort ? shouldAbort() : null;
        if (why === "cancel") {
          try {
            res.destroy();
          } catch {
            // 已经关了。
          }
        }
      }, 100);
      if (typeof abortWatch.unref === "function") abortWatch.unref();
      // 边界不缓存：这一片可能在下到一半时被削短，缓存 limit 就感知不到，
      // 会在旧边界上白写一段。
      //
      // 读流和写盘要分开接错：`for await` 会把网络中断（ECONNRESET、
      // 对端提前关连接）与 fh.write 的失败混在同一个 catch 里抛出，
      // 而这两类错误的处置正好相反：网络断了重试就能接着下，
      // 盘写不进去重试多少次都一样。
      let writeFailed = null;
      try {
        for await (const chunk of res) {
          /**
           * 只有取消才中途放弃；暂停让这片收尾。
           *
           * 暂停的语义是“把手上的工作做完、进度落盘、然后停”。
           * 在这里抛出去等于把一片下到一半的活丢掉，已写的字节虽然还在，
           * 但这段连接被白开一次，下次还要重新握手。
           */
          const why = shouldAbort ? shouldAbort() : null;
          if (why === "cancel") {
            const stop = new Error("任务已取消");
            stop.code = "TASK_CANCELED";
            stop.retryable = false;
            stop.noRetry = true;
            throw stop;
          }
          // 到达当前边界就停：削短后立刻在新边界收尾，不多写一份。
          // 已经写在 socket 缓冲区里的数据拦不住，但那只是几十 KB 的量级。
          const room = segment.end + 1 - pos;
          if (room <= 0) break;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          try {
            /**
             * 必须检查实际写入量。
             *
             * FileHandle.write 可以只写一部分（返回 bytesWritten 小于请求长度），
             * 而且不报错。按 slice.length 推进 pos 就会把后面的数据整体错位，
             * 最终表现为“长度正好、sha256 不符”。多个分片共用一个文件句柄
             * 并发写时尤其容易碰到。
             */
            let written = 0;
            while (written < slice.length) {
              const result = await fh.write(slice, written, slice.length - written, pos + written);
              const n = result?.bytesWritten ?? 0;
              if (n <= 0) {
                // 一个字节都写不进去：当作落盘失败，不在死循环里转。
                throw new Error("写入 0 字节（位置 " + (pos + written) + "）");
              }
              written += n;
            }
          } catch (error) {
            // 落盘失败（目录不可写、磁盘满）重试也没用，如实报出来。
            writeFailed = error;
            error.retryable = false;
            break;
          }
          pos += slice.length;
          have += slice.length;
          // 每写一段就把进度记到这个函数之外的量上：断流后重试要从这里接。
          persisted = have;
          // 上报的已写量不能超过当前边界：削尾后 pos 可能已经越过新 end，
          // 此时 have > 长度。按长度封顶，免得上层把 written 记成超界值。
          const curLen = segment.end - segment.start + 1;
          onProgress(Math.min(have, curLen), curLen);
          onCheckpoint();
        }
      } catch (error) {
        // 走到这里就是读流本身出错：网络断流是常态，标成可重试。
        // 但暂停/取消不是网络问题，它们的标记不能被盖掉。
        if (!error?.noRetry) error.retryable = true;
        throw error;
      } finally {
        // 这条流的监视器必须收掉，否则每片都留一个定时器。
        clearInterval(abortWatch);
      }
      if (writeFailed) throw writeFailed;

      // 当前长度重算：这一轮可能被削短过。
      const curLen = segment.end - segment.start + 1;
      if (have >= curLen) return { bytes: curLen, resumed: persisted > 0 };

      // 没收齐：削短的边界刚好落在已写处之后但流已结束，或对端提前关了连接。
      // 都按“还差一点”处理，让外层接着从 have 往下要。
      const error = new Error(
        "分片 " + segment.index + " 未收齐：期望 " + curLen + "，实际 " + have,
      );
      error.retryable = true;
      throw error;
    } catch (error) {
      // 暂停/取消/取消等待：直接上抛，不进重试。
      if (error?.noRetry) throw error;
      /**
       * 暂停会把在跑的流直接抬掉，那会作为一个网络错误冒上来。
       *
       * 必须先看信号再看重试：不然它会被当成断流去重试，重试次数用尽后
       * 报成“镜像反复断开”的失败——用户只是点了暂停，却看到任务失败。
       */
      const stopReason = shouldAbort ? shouldAbort() : null;
      if (stopReason) {
        const stop = new Error(stopReason === "cancel" ? "任务已取消" : "任务已暂停");
        stop.code = stopReason === "cancel" ? "TASK_CANCELED" : "TASK_PAUSED";
        stop.noRetry = true;
        throw stop;
      }
      if (error?.retryable === false) throw error;
      if (attempt > maxRetries) {
        // 重试用尽：给一句用户能看懂的，不要把 ECONNRESET 这种字面抛到界面上。
        const wrapped = new Error(
          "下载中断：镜像反复断开（已重试 " + maxRetries + " 次），第 " + (segment.index + 1) + " 段停在 " + persisted + "/" + segment.length + " 字节",
        );
        wrapped.code = error?.code ?? "DOWNLOAD_INTERRUPTED";
        wrapped.cause = error;
        throw wrapped;
      }
      // 逐次拉长退避上限，但不超过 8 秒：镜像短时间限流靠等一下就能过，
      // 无限等待会把一次下载拖成不可预测的长。
      const backoff = Math.min(8000, 400 * 2 ** (attempt - 1));
      // 退避也要能被暂停打断：否则暂停后要等完这段才能归还连接，
      // 最长 8 秒，界面上就是“已暂停却仍占着一条连接”。
      await sleepUnlessAborted(backoff, shouldAbort);
      // 等完再看一眼：若是被暂停叫醒的，不要再走下一轮请求。
      const wokenStop = shouldAbort ? shouldAbort() : null;
      if (wokenStop) {
        const stop = new Error(wokenStop === "cancel" ? "任务已取消" : "任务已暂停");
        stop.code = wokenStop === "cancel" ? "TASK_CANCELED" : "TASK_PAUSED";
        stop.noRetry = true;
        throw stop;
      }
    }
  }
}

/**
 * 等一下，但如果中途被要求停下就立刻返回。
 *
 * 重试退避最长 8 秒。暂停发生在退避期间时，不能让连接真等这么久才归还。
 */
function sleepUnlessAborted(ms, shouldAbort) {
  if (!shouldAbort) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve) => {
    const step = 100;
    let waited = 0;
    const timer = setInterval(() => {
      waited += step;
      if (shouldAbort() || waited >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(step, ms));
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * 对一个已经完整的文件算 sha256，同时报字节数。
 * 合并阶段消失后，完整性只能靠哈希与 total 两道确认。
 */
async function hashFilePath(file) {
  return { bytes: sizeOf(file), sha256: await hashFile(file) };
}

// ---------------------------------------------------------------- 主流程

/**
 * 执行一份下载任务。
 *
 * @param {object} task 任务 JSON（见文件头）
 * @param {(record: object) => void} [sink] 进度出口，默认写 stdout
 * @param {object} [options] 服务模式下的共享上下文
 * @param {object} [options.pool] 进程级连接池（不传就为这一份任务单独建一个）
 * @param {string} [options.taskKey] 连接池里记账用的任务标识
 * @param {{aborted: boolean, reason?: string}} [options.signal] 暂停/取消信号
 * @returns {Promise<{ok: true, path: string, sha256: string, bytes: number, mode: string}
 *                  | {ok: false, error: string}>}
 */
export async function runTask(task, sink = emit, options = {}) {
  const startedAt = Date.now();
  const url = task?.url;
  const destination = task?.destination;
  const resultPath = task?.resultPath;

  const fail = (message, extra = {}) => {
    const record = { ok: false, error: message, ...extra };
    sink({ type: "error", message, ...extra });
    if (resultPath) {
      try {
        mkdirSync(path.dirname(resultPath), { recursive: true });
        writeFileSync(resultPath, JSON.stringify({ ...record, elapsedMs: Date.now() - startedAt }, null, 2));
      } catch {
        // 连结果文件都写不了：stdout 那条 error 仍然发出去了。
      }
    }
    return record;
  };

  if (typeof url !== "string" || !url) return fail("任务缺 url");
  if (typeof destination !== "string" || !destination) return fail("任务缺 destination");

  /**
   * 一个任务想开多少条并发。
   *
   * 小文件多开只是多重几次握手，没必要；大文件才值得多开。
   * 这里给的是“想要值”，真正的上限由连接池的可用额度决定——
   * 所以池开大时，单个任务也能跟着用满。
   */
  const autoConnections = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_CONNECTIONS;
    if (bytes < 8 * 1024 * 1024) return 2;
    if (bytes < 64 * 1024 * 1024) return 4;
    if (bytes < 256 * 1024 * 1024) return 8;
    // 大文件直接要满：上限不再在任务这一侧提前收窄。
    return MAX_WORKERS;
  };
  const requestedConnections = Number(task.connections) > 0 ? Number(task.connections) : null;
  const connections = requestedConnections ?? autoConnections(Number(task.totalBytes));
  const timeoutMs = Number(task.timeoutMs) > 0 ? Number(task.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isFinite(Number(task.maxRetries)) ? Number(task.maxRetries) : DEFAULT_MAX_RETRIES;
  const expected = typeof task.expectedSha256 === "string" ? task.expectedSha256.toLowerCase() : null;
  // 控制文件位置：App 可以指定到它读得到的地方（dataDir 下），
  // 不给就沿用 destination 旁边的默认位。
  const controlFile = controlPathFor(destination, task.controlPath);

  /**
   * 连接池与任务标识。
   *
   * 必须在这里就建好：探测与单连接回退都在分片分支之外，而它们同样占真实
   * 连接，不占许可就会出现“池里 0 条、任务却在下”，也就绕过了总连接数。
   * 分片分支里会把它们换成传入的共享池。
   */
  const poolRef = {
    current: options.pool ?? createPool({ limit: Math.min(connections, MAX_WORKERS) }),
  };
  const poolKeyRef = { current: String(options.taskKey ?? destination) };

  /**
   * 把 options.signal（一个 {aborted, reason} 对象）包成可订阅的接口。
   *
   * request 需要在发出后就能被抬断，而不是只能被动等超时。subscribe 收集回调，
   * 一旦 signal.aborted 变真（由一个短定时器盯着）就全部触发。
   *
   * 为什么用定时器而不是事件：options.signal 来自服务端的普通对象，
   * 没有事件可监听，只能轮询。100ms 的精度对“释放连接”这件事已经够。
   */
  const pendingAborts = new Set();
  const signalAdapter = {
    onAbort(fn) {
      pendingAborts.add(fn);
      // 已经处于取消状态：立刻触发，不必等下一拍。
      if (options.signal?.aborted && options.signal.reason === "cancel") {
        try {
          fn();
        } catch {
          // 忽略。
        }
      }
    },
  };
  const abortPoll = setInterval(() => {
    // 只有取消才硬断在途请求：暂停的语义是让手上的片下完再停，
    // 硬断会被当成网络错误去重试，用户就看到了“暂停之后变成失败”。
    if (!options.signal?.aborted || options.signal.reason !== "cancel") return;
    if (pendingAborts.size === 0) return;
    for (const fn of pendingAborts) {
      try {
        fn();
      } catch {
        // 忽略。
      }
    }
    pendingAborts.clear();
  }, 100);
  if (typeof abortPoll.unref === "function") abortPoll.unref();

  // 进度定时器：在 try 外声明，收尾时能停掉。
  // 不停的话，成功返回后它还可能再发一条 progress，把“已完成”又拉回进度态。
  let progressTimer = null;

  try {
    mkdirSync(path.dirname(destination), { recursive: true });

    // 已经下好且校验通过 → 直接收工。重复点下载不该重下一遍。
    if (existsSync(destination) && expected) {
      const existing = await hashFile(destination);
      if (existing === expected) {
        const bytes = sizeOf(destination);
        const record = {
          ok: true,
          path: destination,
          sha256: existing,
          expectedSha256: expected,
          verified: true,
          bytes,
          mode: "already-complete",
        };
        // 上一次中断留下的分片要在这里清：直接 return 的话没人会再走到
        // 正常结束流程，那些 .part 就会一直躺在下载目录里。
        for (const stale of listParts(destination)) removeIfExists(stale);
        sink({ type: "done", ...record, elapsedMs: Date.now() - startedAt });
        if (resultPath) {
          mkdirSync(path.dirname(resultPath), { recursive: true });
          writeFileSync(resultPath, JSON.stringify({ ...record, elapsedMs: Date.now() - startedAt }, null, 2));
        }
        return record;
      }
      // 内容不对：删掉重下，不要在一个坏文件上续传。
      removeIfExists(destination);
    }

    // 1) 探测
    //
    // 探测本身也是一条连接，同样占许可。不占的话，镜像不支持 Range 时
    // 界面会看到“池里 0 条、却在下”，而且多个任务的探测会叠加到总连接数之外。
    let probe;
    await poolRef.current.acquire(poolKeyRef.current);
    try {
      probe = await probeRange(url, { timeoutMs });
    } finally {
      poolRef.current.release(poolKeyRef.current);
    }
    sink({ type: "probe", range: probe.range, status: probe.status ?? null, total: probe.total ?? null });

    const total = Number.isFinite(probe.total) && probe.total > 0 ? probe.total : (Number(task.totalBytes) || null);
    const mode = probe.range && total ? "parallel" : "single";

    // 2) 进度上报：
    //
    // 不能用“每次收到数据就看时间”的写法：分片并发时数据到达可能很密，
    // 每两次都不到 250ms，于是每次都被节流掉，最后只剩一条——表现就是
    // 界面一直停在 0%。改成定时器主动发，节流频率与数据速度解耦。
    //
    // 宿主 watch() 的待发队列只有 16 条，仍然需要控制频率，所以仍是 250ms 一发。
    let lastDone = 0;
    let lastTotal = total;
    /** 分片快照的来源。分片模式下是 segments，单连接下为空。 */
    let lastSegments = null;
    // report 定义在分片表之前，而分片表在分支里才建：留一个可替换的钩子，
    // 两边都改不了对方的定义顺序。
    const syncSegmentsRef = { current: null };
    /** 正在下载的片集合。syncSegments 在它之前定义，用 ref 桥接。 */
    const claimedRef = { current: null };
    const report = () => {
      const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
      // 分片布局会变（二分、削尾），每次上报前重取一份。片数就几百，
      // 构一次数组的开销远小于它带来的信息量。
      if (typeof syncSegmentsRef.current === "function") syncSegmentsRef.current();
      sink({
        type: "progress",
        done: lastDone,
        total: lastTotal,
        speed: Math.round(lastDone / elapsed),
        mode,
        // 分片布局随进度一起报：页面要把每片画在它的文件位置上。
        // 不报就会只剩一根总进度条，看不出分片在同时填。
        segments: lastSegments,
      });
    };
    // 记下最新值并立刻统计一次，不在这里判断该不该发。
    const throttled = (done, of) => {
      lastDone = done;
      if (of) lastTotal = of;
    };
    progressTimer = setInterval(report, PROGRESS_INTERVAL_MS);
    // 计时器不该拖住进程退出。
    if (typeof progressTimer.unref === "function") progressTimer.unref();

    let result;
    // 探测说支持分片，也可能下载途中镜像翻脸。那时退回单连接，而不是整个失败。
    let useParallel = mode === "parallel";

    if (useParallel) {
      const segments = planSegments(total, connections);
      const partPath = destination + ".part";
      const controlPath = controlFile;

      /**
       * 把当前分片布局交给进度上报。
       *
       * 只传位置与已写量，不传 index：页面按 start 排序铺开就行，
       * 而 index 会随二分重排，传了反而误导。
       *
       * 片数能有几百，所以用紧凑的数组（[start, length, written]）
       * 而不是对象数组：字段名重复几百遍就是白花流量。
       */
      const syncSegments = () => {
        const claimedSet = claimedRef.current;
        lastSegments = segments.map((seg) => [
          seg.start,
          seg.end - seg.start + 1,
          Number(seg.written) || 0,
          // 第四个字段：这片眼下是不是有人在跑。
          //
          // 不能靠 written > 0 反推：刚领到手的片还没写出字节，那样会漏报，
          // 界面上就会像“连接数对得上、被接管的段却少了”。
          claimedSet && claimedSet.has(seg) ? 1 : 0,
        ]);
      };
      syncSegmentsRef.current = syncSegments;
      syncSegments();

      // 控制文件是进度来源，但它只描述“写到哪了”，前提是那份 .part 还在。
      //
      // 用户把下载目录里的文件删了、控制文件却还在（它在本 App 的数据目录），
      // 于是一次全新的下载会直接读到旧进度、跳过那些字节——
      // 表现就是“刚开始就完成了大半”，最后 sha256 不符。
      // 所以这里必须同时确认 .part 存在且尺寸已预分配到 total。
      const partSize = sizeOf(partPath);
      const partUsable = existsSync(partPath) && partSize >= total;
      const previous = partUsable ? readControl(controlPath, total) : null;
      if (previous) {
        // 按边界对齐恢复：只有 start/end 都对得上的片才采信它的已写量，
        // 防止上游换文件后拿旧进度硬接。
        for (const seg of segments) {
          const found = previous.segments.find(
            (item) => Number(item.start) === seg.start && Number(item.end) === seg.end,
          );
          if (found) {
            seg.written = Math.max(0, Math.min(Number(found.written) || 0, seg.length));
          }
        }
        // 上次二分割出来的片比本次初始计划更细：把它们接回来。
        // 不接的话，重放一遍就退回粗粒度，已有的细粒度进度白丢。
        for (const item of previous.segments) {
          const start = Number(item.start);
          const end = Number(item.end);
          if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
          if (start < 0 || end >= total || end < start) continue;
          const covered = segments.some((seg) => seg.start <= start && seg.end >= end);
          if (covered) continue;
          segments.push({ start, end, length: end - start + 1, written: Number(item.written) || 0 });
        }
        segments.sort((a, b) => a.start - b.start);
        for (let i = 0; i < segments.length; i += 1) segments[i].index = i;
      } else {
        // 没有可用的进度，或者 .part 已经不在/不完整：两者必须一致，
        // 否则会拿着一份不存在的文件的进度去“续传”。
        removeIfExists(partPath);
        removeIfExists(controlPath);
      }

      let fh = null;
      // 控制文件不需要每字节都刷，但也不能只在结束时写：按时间节流。
      let lastCheckpoint = 0;
      const flushControl = () => {
        if (!fh) return;
        lastCheckpoint = Date.now();
        writeControl(
          controlPath,
          total,
          segments.map((seg) => ({ index: seg.index, start: seg.start, end: seg.end, written: seg.written })),
        );
      };
      const checkpoint = () => {
        if (!fh) return;
        if (Date.now() - lastCheckpoint < 1000) return;
        flushControl();
      };

      try {
        fh = await openPartFile(partPath, total);
        writeControl(
          controlPath,
          total,
          segments.map((seg) => ({ index: seg.index, start: seg.start, end: seg.end, written: seg.written })),
        );

        try {
          // 每个 worker 都去领“当前最大的未完成片”，领到就把自己标记成在跑。
          //
          // 不用游标，因为二分会让新片插到已走过位置。改成每次从剩余片里挑最大
          // 的那片：领走的片从候选里排除，下完后它自然不再被挑；被切开的片则重新
          // 参与候选。两个 worker 不会领到同一片——领取与排除在同一段同步代码里。
          //
          // 并发用许可控制而不是动态增删 Promise：增删要自己维护在飞集合与退出
          // 条件，漏块与没收尾都很难看出来。许可模型下 worker 数固定，收尾就是
          // 一次 Promise.all。
          let failed = null;
          // 正在被谁下着：用图标记，避免两个 worker 领到同一片。
          const claimed = new WeakSet();
      claimedRef.current = claimed;

          /** 所有片已写的总字节，用于进度上报。 */
          const totalWritten = () => segments.reduce((sum, seg) => sum + (Number(seg.written) || 0), 0);

          /**
           * 一个任务能开多少并发。
           *
           * 不再拿 MAX_WORKERS 硬压：池上限就是全局额度，单任务能占多少应当由
           * 当下可用额度决定。比如池开 32、只跑一个任务，它就该能用完 32 条；
           * 以前这里钳到 8，32 永远用不完。
           *
           * connections 仍然有意义：它是这个任务“想要”的并发数，作为上限参与
           * 调度，池紧张时实际占用会少于它。
           */
          const pool = options.pool ?? createPool({ limit: Math.min(Number(connections) || DEFAULT_CONNECTIONS, MAX_WORKERS) });
          const poolKey = String(options.taskKey ?? destination);
          const poolCapacity = typeof pool.snapshot === "function" ? pool.snapshot().limit : Number(connections) || DEFAULT_CONNECTIONS;
          const wanted = Math.min(Number(connections) || DEFAULT_CONNECTIONS, MAX_WORKERS);
          const maxWorkers = Math.max(1, Math.min(wanted, poolCapacity));
          // 供分片分支之外的单连接回退使用。
          poolRef.current = pool;
          poolKeyRef.current = poolKey;

          /** 挑一片最大的未完成、且没人在下的。返回 null 表示没活了。 */
          /**
           * 挑一片来下。
           *
           * 两个目标要平衡：
           *
           *   一是快。片越大，请求开销摊得越薄，所以优先领大片。
           *   二是好看、好读数。纯按大小挑会让位置到处跳：二分不断造出
           *   新的大片，每个 worker 都去抢最新的那片，进度条上的已完成区域
           *   就像在随机点缀，看不出“在从头往后推”。
           *
           * 做法：取最靠前的几片里最大的那片。靠前优先让进度整体往前推，
           * 在那一小段里再取最大，不会因为死守顺序而把小片翻出来。
           *
           * 为什么不是“取最靠前的未完成片”：那样就退化成从头扫到尾，
           * 尾部的小片会把结束时间拖长（实测这是 120 秒对 56 秒的差别）。
           */
          const takeLargest = () => {
            const CANDIDATES = 8;
            // 先按起点收集候选，不排序：片数几百，全排一遍没必要。
            const picks = [];
            for (const seg of segments) {
              if (segLeft(seg) <= 0) continue;
              if (claimed.has(seg)) continue;
              picks.push(seg);
              if (picks.length >= 64) break;
            }
            if (!picks.length) return null;

            // 在候选里找起点最靠前的那几片，再从那几片里取最大的。
            picks.sort((a, b) => a.start - b.start);
            let best = picks[0];
            let bestLen = segLen(best);
            const limit = Math.min(picks.length, CANDIDATES);
            for (let i = 1; i < limit; i += 1) {
              const len = segLen(picks[i]);
              if (len > bestLen) {
                bestLen = len;
                best = picks[i];
              }
            }
            claimed.add(best);
            return best;
          };

          /** 还有没有活可干（未被领取的未完成片）。 */
          const hasWork = () =>
            segments.some((seg) => segLeft(seg) > 0 && !claimed.has(seg));

          /**
           * 一个 worker 只干一片就退。
           *
           * 原来是固定开 maxWorkers 个 worker 各自 for(;;) 抢活，池紧的时候
           * 大部分 worker 就卡在 acquire 的队列里空等：日志里会看到“连接 10/10，
           * 等待 22”——那 22 个不干活，却把调度绕成两层。
           *
           * 现在改成：拿到许可就干一片，干完退；谁释放了许可，pool 的 drain
           * 会叫醒等待者，而这里由下面的 pump 按需开新的。
           */
          const runOne = async () => {
            if (failed) return;
            if (options.signal?.aborted) return;
            // 拿不到就立刻退，不排队：由持有者释放时再补。
            if (!pool.tryAcquire(poolKey)) return;
            const seg = takeLargest();
            if (!seg) {
              pool.release(poolKey);
              return;
            }
            const startedAt = Date.now();
            try {
              await downloadSegmentInFile({
                url,
                fh,
                segment: seg,
                doneBytes: seg.written,
                timeoutMs,
                maxRetries,
                onProgress: (written) => {
                  seg.written = written;
                  seg.index = segments.indexOf(seg);
                  throttled(totalWritten(), total);
                },
                onCheckpoint: checkpoint,
                abortSignal: options.signal,
                signalAdapter,
                shouldAbort: () => {
                  if (options.signal?.aborted) return options.signal.reason === "cancel" ? "cancel" : "pause";
                  return null;
                },
              });
              seg.written = seg.end - seg.start + 1;
            } catch (error) {
              if (!error?.noRetry) failed = failed ?? error;
            } finally {
              pool.release(poolKey);
              claimed.delete(seg);
            }

            if (failed) return;
            // 这一片下完了：把最大的、且不是别人正在下的未完成片二分。
            splitLargestUnfinished(segments, { skip: (s) => claimed.has(s) });
          };

          /**
           * 调度：在飞数不超过 maxWorkers、且池里还有额度时，持续补 worker。
           *
           * 不再预先开满 maxWorkers 个然后让它们排队。这里用“在飞数 + 启动
           * 新 worker”收敛，启动出去的每个都会尝试 tryAcquire，拿不到就退，
           * 所以多开几个不会变成阻塞队列。
           */
          let inFlight = 0;
          const pump = async () => {
            for (;;) {
              if (failed) return;
              if (options.signal?.aborted) return;
              if (!hasWork()) return;
              if (inFlight >= maxWorkers) return;
              if (!pool.hasFree(poolKey)) return;
              inFlight += 1;
              runOne()
                .catch((error) => {
                  failed = failed ?? error;
                })
                .finally(() => {
                  inFlight -= 1;
                  // 这一片结束后再看还有没有活和额度。
                  // 用微任务拉开一档，避免同步递归把栈堆深。
                  queueMicrotask(() => {
                    pump().catch(() => {});
                  });
                });
            }
          };

          /**
           * 跑到底：持续补 worker，直到没活、失败、或被叫停。
           *
           * 不能用一次 Promise.all 就收尾：worker 是“干一片就退”的，
           * 中间随时会归零。这里用一个小循环盯着：
           * 每拍看一次“还有活但没在飞”就重新 pump，全部下完才退出。
           */
          await new Promise((resolve) => {
            let timer = null;
            const tick = () => {
              if (failed || options.signal?.aborted) {
                if (timer) clearInterval(timer);
                timer = null;
                resolve();
                return;
              }
              if (inFlight > 0) return; // 还在干，下一拍再看
              if (!hasWork()) {
                if (timer) clearInterval(timer);
                timer = null;
                resolve();
                return;
              }
              // 有活但没人干：要么是池满（等它释放），要么是该补了。
              pump().catch(() => {});
            };
            timer = setInterval(tick, 30);
            // 不能 unref：这个定时器是“等下载跑完”的唯一句柄。
            // unref 之后，当进程里只剩它一个活跃句柄时，Node 会直接退出，
            // runTask 的 await 永远不返回（实测表现为进程“卡死后无声退出”）。
            tick();
          });
          // 暂停/取消前把进度落盘：检查点是每秒一刷，丢掉最后一秒意味着
          // 续传时这一段要从头再下一遍。
          flushControl();
          if (failed) throw failed;
          // 暂停/取消：worker 安静退出了，这里必须把信号翻译成结果。
          // 不处理的话“还有分片没写完”会被当成真失败，页面看到的是下载出错。
          if (options.signal?.aborted) {
            const stopping = new Error(
              options.signal.reason === "cancel" ? "任务已取消" : "任务已暂停",
            );
            stopping.code = options.signal.reason === "cancel" ? "TASK_CANCELED" : "TASK_PAUSED";
            stopping.noRetry = true;
            throw stopping;
          }
        } catch (error) {
          if (error?.code !== "RANGE_UNAVAILABLE") throw error;
          // 分片写了一半也不能接着拼：关窗、清掉两边，退回单连接重下。
          useParallel = false;
          try {
            await fh.close();
          } catch {
            // 已经关了。
          }
          fh = null;
          removeIfExists(partPath);
          removeIfExists(controlPath);
          sink({ type: "fallback", reason: "Range 在下载途中变得不可用，退回单连接", mode: "single" });
        }

        if (useParallel) {
          // 每段长度已由 downloadSegmentInFile 自己核过；这里再写一次最终进度。
          writeControl(
            controlPath,
            total,
            segments.map((seg) => ({ index: seg.index, start: seg.start, end: seg.end, written: seg.written })),
          );
          const anythingMissing = segments.some((seg) => segLeft(seg) > 0);
          if (anythingMissing) {
            // 把没写完的片报出来：只报“有片没写完”没法定位，
            // 而片的位置与已写量决定了是漏写还是记账错。
            const detail = segments
              .filter((seg) => segLeft(seg) > 0)
              .slice(0, 5)
              .map((seg) => seg.start + ".." + seg.end + "(" + seg.written + "/" + segLen(seg) + ")")
              .join(", ");
            throw new Error("有分片没有写完，不当作完成：" + detail);
          }

          /**
           * 收尾前抽查：每个声称写完的片，中间那个字节应当真被写过。
           *
           * 为什么需要这一步：.part 是预分配（truncate 到 total）的，所以
           * “文件长度 == total”完全不能证明内容齐了。分片是随机写，`written`
           * 只是记账；记账一旦偏离事实，漏写会一路滑到 sha256 才暴露，
           * 那时已经白下了几百 MB。
           *
           * 抽查而不是全量：全量读一遍 500MB 要额外几秒，抽查每片一个字节
           * 能抳住“整段没写”这类真故障。
           */
          const holes = [];
          const probe = Buffer.allocUnsafe(1);
          for (const seg of segments) {
            const mid = seg.start + Math.floor(segLen(seg) / 2);
            const { bytesRead } = await fh.read(probe, 0, 1, mid);
            if (bytesRead !== 1) holes.push(seg.start + ".." + seg.end);
          }
          if (holes.length) {
            throw new Error("有分片声称写完但读不到数据：" + holes.slice(0, 5).join(", "));
          }
        }
      } finally {
        // 异常退出也把进度刷一次：下次才能从真实断点续，不从段首重下。
        flushControl();
        if (fh) {
          try {
            await fh.close();
          } catch {
            // 已经关了。
          }
        }
      }

      if (useParallel) {
        // 不再有合并阶段：.part 本身就是成品，只差一个哈希与改名。
        // 先改名到 staging，再算哈希，算完通过才算完成。
        const stagingPath = destination + ".part";
        const hashed = await hashFilePath(stagingPath);
        if (total && hashed.bytes !== total) {
          removeIfExists(stagingPath);
          removeIfExists(controlPath);
          throw new Error("合并后长度不符：期望 " + total + "，实际 " + hashed.bytes);
        }
        result = { bytes: hashed.bytes, sha256: hashed.sha256, staging: stagingPath, parts: [] };
      }
    }

    if (!result) {
      const partPath = destination + ".part";
      // 单连接下载也要占一条许可：它同样是一条真实连接，不占就会出现在
      // “池里 0 条、任务却在下”的现象。镜像不支持 Range 时全量都走这条路，
      // 不纳入池等于绕过了总连接数。
      let single = null;
      try {
        await poolRef.current.acquire(poolKeyRef.current);
        try {
          single = await downloadSingle({
            url,
            destination,
            partPath,
            timeoutMs,
            onProgress: throttled,
            maxRetries,
          });
        } finally {
          poolRef.current.release(poolKeyRef.current);
        }
      } catch (error) {
        throw error;
      }
      result = { bytes: single.bytes, sha256: single.sha256, staging: partPath, parts: [] };
    }

    // 3) 校验：不符就删掉临时文件，绝不落盘成一个"看起来下完了"的坏文件。
    //
    // expected 为空（上游没给这个附件的 sha256）时无法校验：不阻止下载，
    // 但结果里 verified:false，让上层和界面都能把“已校验”与“没校验”说清楚。
    if (expected && result.sha256 !== expected) {
      // 默认删掉坏文件，避免用户拿到一个“看起来下完了”的东西。
      // 但排查时需要看现场：设 OH_KEEP_BAD 就把它留下来改名，方便逐段比对。
      if (process.env.OH_KEEP_BAD) {
        try {
          renameSync(result.staging, result.staging + ".bad");
        } catch {
          // 改不了名就算了，下面还会尝试删除。
        }
      } else {
        removeIfExists(result.staging);
      }
      // 分片数据既然对不上，控制文件里的进度也就没意义了。
      removeIfExists(controlFile);
      for (const p of result.parts || []) removeIfExists(p);
      return fail(
        "sha256 不符：" + result.sha256 + " ≠ 期望 " + expected,
        { code: "SHA256_MISMATCH", expected, actual: result.sha256 },
      );
    }
    const verified = Boolean(expected) && result.sha256 === expected;

    // 4) 校验通过才改名到正式名，同时收掉控制文件。
    // 先停进度定时器，否则它可能在 done 之后再发一条 progress。
    if (progressTimer) clearInterval(progressTimer);
    clearInterval(abortPoll);
    // 补一条终态前的最新进度：下载得比一个节拍还快时，定时器可能一次都没发，
    // 前端就只看得到 0% 直接跳“已完成”，中间那条过渡不能省。
    sink({ type: "progress", done: result.bytes, total: total ?? result.bytes, speed: null, mode });
    renameSync(result.staging, destination);
    removeIfExists(controlFile);
    for (const p of result.parts || []) removeIfExists(p);

    const record = {
      ok: true,
      path: destination,
      sha256: result.sha256,
      expectedSha256: expected,
      verified,
      bytes: result.bytes,
      mode,
    };
    sink({ type: "done", ...record, elapsedMs: Date.now() - startedAt });
    if (resultPath) {
      mkdirSync(path.dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, JSON.stringify({ ...record, elapsedMs: Date.now() - startedAt }, null, 2));
    }
    return record;
  } catch (error) {
    if (progressTimer) clearInterval(progressTimer);
    clearInterval(abortPoll);
    // 暂停与取消不是失败：不删 .part（下次要接着下），也不当作错误报给上层。
    if (error?.noRetry) {
      const record = {
        ok: false,
        stopped: true,
        code: error.code ?? "TASK_STOPPED",
        error: String(error.message ?? error),
      };
      sink({ type: error.code === "TASK_CANCELED" ? "canceled" : "paused", ...record });
      if (resultPath) {
        try {
          mkdirSync(path.dirname(resultPath), { recursive: true });
          writeFileSync(resultPath, JSON.stringify({ ...record, elapsedMs: Date.now() - startedAt }, null, 2));
        } catch {
          // 写不了就算了，stop 那条已经发出去。
        }
      }
      return record;
    }
    // 保留 .part* 让下次能续传；只有"内容不对"才需要清掉（上面已处理）。
    return fail(String(error?.message ?? error), { code: error?.code ?? "DOWNLOAD_FAILED" });
  }
}

/** 算一个已存在文件的 sha256。 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(file);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

// ---------------------------------------------------------------- CLI

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const taskPath = process.argv[2];
  if (!taskPath) {
    emit({ type: "error", message: "缺任务 JSON 路径：node downloader.mjs <task.json>" });
    process.exitCode = 2;
  } else {
    let task;
    try {
      task = JSON.parse(readFileSync(taskPath, "utf8"));
    } catch (error) {
      emit({ type: "error", message: "任务 JSON 读不了：" + (error?.message ?? String(error)) });
      process.exitCode = 2;
    }
    if (task) {
      const result = await runTask(task);
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
