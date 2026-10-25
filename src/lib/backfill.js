/**
 * src/lib/backfill.js — 回填状态机。
 *
 * 从最新版本往回溯源，把每个版本的 digest 收进库。停止条件是**链闭合**，不是
 * "这个 tag 在库里"。
 *
 * 为什么不是"tag 在库里就停"：回溯方向是从新到旧，所以崩溃留下的状态必然是
 * 顶端齐全、底端缺失。只看"这个 tag 在库里吗"会把它误判成已经补完，当场停死
 * ——实测会在第 5 条卡住，再也补不完。
 *
 * 链闭合 = 从 tag 沿 previous_tag 一直往下走，直到：
 *   · previous_tag 为 null（到尽头），或
 *   · 指向一个已在 absent 表里的 tag（确认无 digest，链止于此）。
 * 穿过已在库的行**只读本地、不发请求**，所以续跑的成本精确等于还缺的那几个。
 *
 * 本模块只负责"把一条链从给定起点补到闭合"，不替调用方判断该不该跑。
 */
import { createHash } from "node:crypto";
import { isVersionTag, releaseUrl } from "./upstream.js";

/** 单次回填的步数上限。实测有效链 50 条，留足余量，同时挡住成环。 */
export const MAX_STEPS = 400;

/**
 * 断口接续时最多探多少个「无 digest」版本。
 *
 * 断口接续是为了跨过一批只打了 tag、没发 Release 的版本。实测这种空缺有两种形态：
 *
 *   可穿越：v0.416.12 → v0.416.4 → v0.416.3 → v0.416.2 → v0.415.16 →
 *           v0.415.15 → v0.412.7（第 7 个才有 digest，连穿 6 个）
 *   到尽头：v0.351.5 → v0.350.2 → v0.349.5 → v0.348.11 →…… 一路到底都没 digest
 *
 * 只看“连续空了几个”分不开这两种，所以真正的判据在 probeNextDigest：
 * 找到一个候选就叫一次 digest，看它到底有没有。这里只留一个探多少个候选的硬上限。
 */
const MAX_HOLE_PROBES = 10;

/**
 * 断口接续时 tags 翻页的页数上限。
 *
 * 实测 tags 共 400 个、分 40 页。断口可能落在很靠前的位置（比如从 v0.416.26
 * 往下接续时要翻到包含 v0.390.0 附近的页），12 页不够。留到 60 页是硬上限，
 * 比实测需要的翻倍。
 */
const MAX_TAG_PAGES = 60;

const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * 链是否闭合。只读本地库，不发任何请求。
 *
 * 每一步按这个顺序判定：
 *   · 已在 versions → 读它的 previous_tag，继续往下；
 *   · 已在 absent 且记过接续 → 沿接续的那一版继续往下（断口可穿越）；
 *   · 已在 absent 且确认是尽头 → 闭合；
 *   · 其它（不在库、也没探过）→ 未闭合。
 *
 * 「断口可穿越」这一条是关键：实测链上第 26 个版本（v0.416.26）的 previousTag
 * 指向一个只打了 git tag、没发 Release 的版本，那里必定 404。若把 absent 一律
 * 当终点，冷启动会停在 26 条，永远拿不到完整的 50 条。
 */
export function chainClosed(store, tag) {
  if (typeof tag !== "string" || !tag) return false;
  const holes = store.getHoleContinuations();
  const seen = new Set();
  let cur = tag;
  while (cur) {
    if (seen.has(cur)) return true; // 成环：没有可补的下一版，按闭合处理
    seen.add(cur);

    const link = store.getLink(cur);
    if (link) {
      // previous_tag 为空 = 这一版就是尽头。
      if (!link.previousTag) return true;
      cur = link.previousTag;
      continue;
    }

    if (store.isAbsent(cur) || cur in holes) {
      // 探过但没有 digest：只有“确认是尽头”才闭合，否则沿接续继续走。
      // absent 只说明「这个 tag 没有 digest」，它不区分两件事：确认是尽头，
      // 还是探过但接续没写成（断口接续失败时只来得及 markAbsent）。后者当成
      // 闭合会让整条链在断口处提前收工，库里只留前半段。所以没有接续记录时
      // 返回 false：不确定，需再探一次。
      if (!(cur in holes)) return false;
      const next = holes[cur];
      if (!next) return true;
      cur = next;
      continue;
    }

    return false;
  }
  return true;
}

/**
 * 把版本 tag 拆成可比的数字元组。解析不了返回 null。
 *
 * 只认 v<主>.<次>.<修>[-后缀] 这种形状，数字段逐段比，后缀不参与大小。
 * `isVersionTag` 已经挡掉了 train-* 这类内部通道，这里只处理版本段。
 */
function versionParts(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a 是否严格比 b 者（更老）。任一方解析不了就返回 false。 */
function isOlderThan(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

/**
 * 沿 tags 列表列出比某个 tag 更老的版本 tag。
 *
 * 只在链断掉时才用：digest 的 previousTag 可能指向一个在 tags 页里压根不存在的
 * 版本。实测两种成因都会出现：
 *   · 打了 tag 但没发 Release（v0.416.12 这类，能翻到它）；
 *   · 直接没打这个 tag（v0.390.0，digest 里写着它，tags 页没有这个条目）。
 *
 * 后一种情况下「先定位到 tag 再取下一个」永远定位不到，翻到多少页都没用。
 * 所以这里不找那个 tag，而是找**严格比它更老**的那些：tags 页是「新 → 旧」，
 * 从头往后扫，遇到数字段更小的就收录。
 *
 * 一次返回一批而不是一个：一张 tags 页上往往有五个、六个连着的无 digest 版本
 * （实测 v0.416.12 / v0.416.4 / v0.416.3 / v0.416.2 / v0.415.16 / v0.415.15
 * 全在同一页）。一次只返回一个会让调用方每探一个就回来重翻同一页。
 *
 * **前提是 tag 本身能解析出版本号**。解析不了就没法比，退化成「找到它再取后面」。
 *
 * 返回的 skipped 是途中跨过的非版本 tag（train-* 之类）：它们确实不会有 digest，
 * 调用方会记进 absent，下次不再探。
 */
async function findOlderTags(fetchPage, tag, { after: startAfter = null } = {}) {
  let after = startAfter;
  let pages = 0;
  const skipped = [];
  const older = [];
  const targetParts = versionParts(tag);
  let located = targetParts !== null;

  while (pages < MAX_TAG_PAGES) {
    pages += 1;
    const page = await fetchPage(after);
    if (!page?.ok) {
      return {
        ok: false,
        status: page?.status,
        error: page?.error ?? "HTTP " + page?.status,
        pages,
        skipped,
        older,
      };
    }
    const tags = Array.isArray(page.tags) ? page.tags : [];

    let start = 0;
    if (!located) {
      // 解析不了版本号：先找到它自己，再从它后面取。
      const idx = tags.indexOf(tag);
      if (idx < 0) {
        if (!page.after) return { ok: true, older, pages, skipped, exhausted: true };
        after = page.after;
        continue;
      }
      located = true;
      start = idx + 1;
    }

    for (let i = start; i < tags.length; i += 1) {
      const candidate = tags[i];
      if (!isVersionTag(candidate)) {
        skipped.push(candidate);
        continue;
      }
      if (targetParts === null || isOlderThan(candidate, tag)) older.push(candidate);
    }

    // 已经收到候选了就先把这一页的给他，不够再去下一页。
    if (older.length > 0) return { ok: true, older, pages, skipped, after: page.after };
    if (!page.after) return { ok: true, older, pages, skipped, exhausted: true };
    after = page.after;
  }

  return {
    ok: false,
    error: "tags 翻页超过 " + MAX_TAG_PAGES + " 页仍未找到 " + tag + " 的更老版本",
    pages,
    skipped,
    older,
  };
}

/**
 * 从 startTag 往回回填，直到链闭合。
 *
 * @param {object} options
 * @param {object} options.store    openStore() 的返回值
 * @param {object} options.client   makeClient(fetchImpl) 的返回值
 * @param {string} options.startTag 起点（通常是 atom 里最新的版本 tag）
 * @param {(progress: object) => void} [options.onProgress] 每步回调
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxSteps]
 *
 * 返回一份运行摘要。抛错时库里的状态就是"已提交的部分"，下一次从同一 startTag
 * 接着跑即可——每个版本独立提交正是为了这个。
 *
 * 两类失败要分开看：
 *   · 网络/上游错误：保留 backfill_state=0 并抛出，可续跑。
 *   · 结构性错误（digest 不是合法 JSON、步数超上限）：同样保留 state=0 并抛出。
 */
export async function runBackfill({
  store,
  client,
  startTag,
  onProgress,
  signal,
  maxSteps = MAX_STEPS,
} = {}) {
  if (!store) throw new Error("runBackfill 需要 store");
  if (!client) throw new Error("runBackfill 需要 client");
  if (typeof startTag !== "string" || !startTag) throw new Error("runBackfill 需要 startTag");

  const stats = {
    startTag,
    steps: 0,
    stored: 0,
    cached: 0,
    absent: 0,
    /** 真正取 digest 的请求数：实测里"50 个版本 50 次请求"就是它。 */
    digestFetches: 0,
    /** 只在断口处发生的 tags 翻页请求数，单独计数，不混进上面那个数。 */
    tagPageFetches: 0,
    /** 当前连续碰到的「有 tag 但没 digest」个数；取到 digest 就归零。 */
    consecutiveHoles: 0,
    /** 断口接续时为确认候选有没有 digest 而发生的探测请求数。 */
    holeProbes: 0,
    closed: false,
    lastTag: null,
  };

  const report = (action, extra = {}) => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({
        step: stats.steps,
        startTag,
        stored: stats.stored,
        cached: stats.cached,
        absent: stats.absent,
        digestFetches: stats.digestFetches,
        tagPageFetches: stats.tagPageFetches,
        action,
        ...extra,
      });
    } catch {
      // 进度回调是观察者，它的失败不该弄坏回填本身。
    }
  };

  const abortCheck = () => {
    if (signal?.aborted) {
      const error = new Error("回填被中止");
      error.name = "AbortError";
      error.code = "BACKFILL_ABORTED";
      throw error;
    }
  };

  /** 链闭合的统一出口：记状态、报进度、返回摘要。 */
  const finish = (tag) => {
    stats.closed = true;
    store.setBackfillState(1);
    report("closed", { tag });
    return stats;
  };

  /**
   * tags 页缓存（只在本次运行内有效）。
   *
   * 一个真实断口常连着好几个没有 Release 的版本 tag（实测 v0.416.12 /
   * v0.416.4 / v0.416.3 / v0.415.16 连着四个），每穿一个都要翻同一页 tags。
   * 不缓存就是同一页抓四次；缓存之后整轮只抓一次。
   */
  const pageCache = new Map();
  const fetchPage = async (after) => {
    const key = after ?? "";
    if (pageCache.has(key)) return pageCache.get(key);
    stats.tagPageFetches += 1;
    const page = await client.fetchTagsPage(after);
    pageCache.set(key, page);
    return page;
  };

  /**
   * 断口接续：从 tags 列表按「新 → 旧」逐个验，找到第一个真有 digest 的版本。
   *
   * 走到这里说明当前 tag 没有 digest，它的 previousTag 无从得知，只有 tags 列表
   * 知道更老的版本是哪些。不能“拿到一个就用”：实测空 tag 有连着六七个的，
   * 而历史深处整整一大段都没 digest（v0.351.5 往下全没有）。
   *
   * 所以每拿到一个候选就真的叫一次 digest：
   *   · 有 → 就是它，链在这里接回去；
   *   · 无 → 记进 absent（下次不再探），继续验下一个。
   *
   * 候选是一次批量拿的（findOlderTags），因为同一页上往往就有五六个连着空。
   * 探满 MAX_HOLE_PROBES 个还都是空，就判定上游历史数据到此不再提供 digest，
   * 返回 null 收尾，不再把剩下几百个 tag 全扫一遍。
   */
  const breakLink = async (tag, reason) => {
    let after = null;
    let probes = 0;

    while (probes < MAX_HOLE_PROBES) {
      const found = await findOlderTags(fetchPage, tag, { after });
      for (const skippedTag of found.skipped || []) {
        if (!store.isAbsent(skippedTag)) {
          store.markAbsent(skippedTag);
          stats.absent += 1;
        }
      }
      if (!found.ok) {
        store.setBackfillState(0);
        const error = new Error("断口接续失败（" + tag + "，" + reason + "）：" + found.error);
        error.code = "BACKFILL_BREAK_LOOKUP_FAILED";
        error.tag = tag;
        throw error;
      }

      const candidates = Array.isArray(found.older) ? found.older : [];
      if (!candidates.length) {
        // tags 列表翻到底了，没有更老的版本。
        store.setHoleContinuation(tag, null);
        return null;
      }

      for (const candidate of candidates) {
        // 候选已在库里：直接用它，不必再发请求。
        if (store.getLink(candidate)) {
          store.setHoleContinuation(tag, candidate);
          report("hole", { tag, previousTag: candidate, probes });
          return candidate;
        }
        if (store.isAbsent(candidate)) continue; // 已经验过没 digest，跳过
        if (probes >= MAX_HOLE_PROBES) break;

        probes += 1;
        stats.holeProbes += 1;
        let response = null;
        try {
          response = await client.fetchDigestText(candidate);
          stats.digestFetches += 1;
        } catch {
          response = null;
        }

        if (response?.ok) {
          store.setHoleContinuation(tag, candidate);
          report("hole", { tag, previousTag: candidate, probes });
          return candidate;
        }

        if (!response) {
          // 探测本身失败（网络、超时）：不当成“无 digest”，交给外层报错重试。
          store.setBackfillState(0);
          const error = new Error("断口探测失败：" + candidate);
          error.code = "BACKFILL_BREAK_PROBE_FAILED";
          error.tag = candidate;
          throw error;
        }

        // 无 digest：记下来，接着验下一个。
        if (!store.isAbsent(candidate)) {
          store.markAbsent(candidate);
          stats.absent += 1;
        }
      }

      if (!found.after) {
        // 这一批是最后一页，没有下一页可继续。
        break;
      }
      after = found.after;
    }

    // 验到上限还是空：上游历史数据到此不再提供 digest。
    store.setHoleContinuation(tag, null);
    report("holes-exhausted", { tag, probes });
    return null;
  };

  let cur = startTag;
  while (cur && stats.steps < maxSteps) {
    abortCheck();
    stats.steps += 1;
    stats.lastTag = cur;

    // 1) 链已闭合 → 完成。这个判断是传导的：穿过的每条都是本地读，不发请求。
    if (chainClosed(store, startTag)) return finish(cur);

    // 2) 这个 tag 已经探过（absent）：有接续就沿接续走，没有就往下重新探。
    //    absent 只说明“这个 tag 没有 digest”，它不区分两件事：链确实到此到尽头，
    //    还是探过但接续没写成（断口接续失败时只来得及 markAbsent）。后者当终点
    //    会让链在断口处提前收工，库里只留前半段。所以没有接续记录时不当终点，
    //    落到下面重探：404 会重新触发一次断口接续，那次写成功就能继续走。
    const holes = store.getHoleContinuations();
    if (cur in holes) {
      const next = holes[cur];
      if (!next) return finish(cur); // 确认是链的尽头
      report("hole", { tag: cur, previousTag: next });
      cur = next;
      continue;
    }
    if (store.isChainEnd(cur)) return finish(cur);

    // 3) 不是版本 tag（train-* 等内部通道）→ 记负面缓存，沿 tags 接上一版继续。
    if (!isVersionTag(cur)) {
      if (!store.isAbsent(cur)) stats.absent += 1;
      store.markAbsent(cur);
      report("absent-non-version", { tag: cur });
      const next = await breakLink(cur, "非版本 tag");
      if (!next) return finish(cur);
      cur = next;
      continue;
    }

    // 4) 已在库里 → 只读本地接着走，不发请求。这一步就是"续跑穿缓存"。
    const cachedLink = store.getLink(cur);
    if (cachedLink) {
      const previousTag = cachedLink.previousTag;
      stats.cached += 1;
      report("cached", { tag: cur, previousTag });
      // 库里的 previousTag 为空 = 这一版就是尽头，链在此闭合。
      if (!previousTag) return finish(cur);
      cur = previousTag;
      continue;
    }

    // 5) 取 digest。
    let response;
    try {
      response = await client.fetchDigestText(cur);
    } catch (error) {
      // 网络错误（超时、断网、DNS）：保住 backfill_state=0，把错误抛出去，
      // 下一次从同一 startTag 续跑。已提交的行都在，不会留下半截状态。
      store.setBackfillState(0);
      report("network-error", {
        tag: cur,
        error: String(error && error.message ? error.message : error),
      });
      throw error;
    }
    stats.digestFetches += 1;

    if (response?.notModified) {
      // digest 端点不带条件请求，走不到这里；真走到就是上游行为变了。
      store.setBackfillState(0);
      const error = new Error("digest 端点返回 304（" + cur + "），不符合预期");
      error.code = "BACKFILL_UNEXPECTED_304";
      error.tag = cur;
      throw error;
    }

    if (!response?.ok) {
      if (response?.status === 404) {
        // 打了 git tag 但没发 Release，所以没有 digest。记负面缓存，
        // 再用 tags 列表接上它的上一版——它的 previousTag 无从得知。
        if (!store.isAbsent(cur)) stats.absent += 1;
        store.markAbsent(cur);
        report("absent-404", { tag: cur });
        // breakLink 会自己探到第一个真正有 digest 的版本，探不到就返回 null。
        const next = await breakLink(cur, "404");
        if (!next) return finish(cur);
        cur = next;
        continue;
      }
      // 其它非 2xx 当网络侧失败：保留 state=0 并抛出，下次可续跑。
      store.setBackfillState(0);
      report("http-error", { tag: cur, status: response?.status });
      const error = new Error(
        "取 digest 失败：" + cur + " → " + (response?.error ?? "HTTP " + response?.status),
      );
      error.code = "BACKFILL_DIGEST_HTTP_ERROR";
      error.tag = cur;
      error.status = response?.status;
      throw error;
    }

    const body = response.text;
    let digest = null;
    try {
      digest = JSON.parse(body);
    } catch {
      digest = null;
    }
    if (!digest || typeof digest !== "object") {
      store.setBackfillState(0);
      const error = new Error("digest 不是合法 JSON 对象：" + cur);
      error.code = "BACKFILL_DIGEST_MALFORMED";
      error.tag = cur;
      throw error;
    }
    // digest 自称的 tag 与请求的 tag 不一致，说明取到了别人的文件：宁可不入库。
    if (typeof digest.tag === "string" && digest.tag !== cur) {
      store.setBackfillState(0);
      const error = new Error("digest 的 tag 与请求不符：请求 " + cur + "，文件自称 " + digest.tag);
      error.code = "BACKFILL_TAG_MISMATCH";
      error.tag = cur;
      throw error;
    }

    const previousTag =
      typeof digest.previousTag === "string" && digest.previousTag ? digest.previousTag : null;

    // 独立提交：这一版立即落盘。崩溃时已取到的都在。
    store.upsertVersion({
      tag: cur,
      previousTag,
      digestSha256: sha256Hex(body),
      sourceUrl: releaseUrl(cur),
      fetchedAt: Date.now(),
      body,
    });
    stats.stored += 1;
    // 取到一份 digest 就证明链在这里是接得上的，连续断口计数归零。
    stats.consecutiveHoles = 0;
    report("stored", { tag: cur, previousTag });

    // 最老的一版没有上一版：链在此闭合。
    if (!previousTag) return finish(cur);

    cur = previousTag;
    // 写完就查一次：新版本到来时，它一入库链就已闭合，这正是"1 步 1 网络"。
    if (chainClosed(store, startTag)) return finish(cur);
  }

  // 走到步数上限还没闭合：不宣布完成，保留 state=0，让下一次接着跑。
  store.setBackfillState(0);
  report("step-limit", { tag: cur });
  const error = new Error("回填在 " + maxSteps + " 步内未闭合（停在 " + (cur ?? "null") + "）");
  error.code = "BACKFILL_STEP_LIMIT";
  error.tag = cur;
  throw error;
}
