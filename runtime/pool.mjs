/**
 * runtime/pool.mjs — 全局连接池。
 *
 * 一次下载就是一组分片 worker，每个 worker 开工前要申请一条连接许可。
 * 许可池在**进程级**共享，所以多个任务并发时它们争的是同一份额度，
 * 这就是「总连接数」的实现位置。
 *
 * ## 为什么不是每任务各算自己的
 *
 * 那样总连接数会随任务数线性上涨：开三个任务、每个 8 条，实际就是 24 条。
 * 用户设的是总数，所以池必须在所有任务之外。
 *
 * ## 轮流分配而不是先来先占
 *
 * 纯 FIFO 会让先到的任务把额度吃满、后到的任务停在 0。这里按「谁当前拿得少
 * 给谁」排序，让每个活跃任务都能推进。代价是要记录每个持有者拿了多少。
 */

/**
 * @typedef {{ key: string, resolve: () => void, reject: (error: Error) => void }} Waiter
 */

export function createPool({ limit = 8, maxLimit = 1024, minLimit = 1 } = {}) {
  let capacity = clampLimit(limit, minLimit, maxLimit);
  /** 每个任务当前占了几条。用于公平调度。 */
  const held = new Map();
  /** @type {Waiter[]} */
  const waiting = [];
  let inUse = 0;
  /** 池被关闭时（进程退出、App 卸载）叫醒所有等待者，让它们别再等。 */
  let closed = false;

  function clampLimit(value, min, max) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * 从等待队列里挑一个能开工的。
   *
   * 排序键是「该任务已持有多少」：持有少的先上，这样额度会自然摊平到各个任务。
   * 同持有量时按到达顺序（FIFO）。
   */
  function pickNext() {
    if (!waiting.length) return null;
    let bestIndex = 0;
    let bestHeld = Infinity;
    for (let i = 0; i < waiting.length; i += 1) {
      const count = held.get(waiting[i].key) ?? 0;
      if (count < bestHeld) {
        bestHeld = count;
        bestIndex = i;
      }
    }
    return waiting.splice(bestIndex, 1)[0];
  }

  /** 有额度空出来就尽量派给等待者。 */
  function drain() {
    while (!closed && inUse < capacity && waiting.length) {
      const waiter = pickNext();
      if (!waiter) break;
      inUse += 1;
      held.set(waiter.key, (held.get(waiter.key) ?? 0) + 1);
      waiter.resolve();
    }
  }

  return {
    /**
     * 试拿一条许可，拿不到就立刻返回 null，不排队。
     *
     * 下载器用这个而不是 acquire：每个任务预先开五个八个 worker 去排队，
     * 池紧时就会有一堆 worker 挂在队列里空等——它们不干活，却占着位置，
     * 还让“谁该拿到额度”多绕一层。改成拿到就干、拿不到就退，
     * 由持有者在释放时补一个新的。
     */
    tryAcquire(key) {
      if (closed) return false;
      const holderKey = String(key ?? "");
      if (inUse >= capacity) return false;
      inUse += 1;
      held.set(holderKey, (held.get(holderKey) ?? 0) + 1);
      return true;
    },

    /** 申请一条许可。池满时排队，直到有人归还或额度被调大。 */
    acquire(key) {
      if (closed) return Promise.reject(new Error("连接池已关闭"));
      const holderKey = String(key ?? "");
      if (inUse < capacity) {
        inUse += 1;
        held.set(holderKey, (held.get(holderKey) ?? 0) + 1);
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        waiting.push({ key: holderKey, resolve, reject });
      });
    },

    /** 归还一条许可。多还不会把 inUse 弄成负数。 */
    release(key) {
      const holderKey = String(key ?? "");
      if (inUse > 0) inUse -= 1;
      const count = held.get(holderKey) ?? 0;
      if (count <= 1) held.delete(holderKey);
      else held.set(holderKey, count - 1);
      drain();
    },

    /**
     * 调总连接数。
     *
     * 调小不掐断在跑的连接：它们下完自然归还，只是不再发新的。这样不会把
     * 已经下了大半的分片作废。
     */
    setLimit(value) {
      capacity = clampLimit(value, minLimit, maxLimit);
      drain();
      return capacity;
    },

    /** 还有没有空余额度（不占用，只看）。 */
    hasFree(key) {
      return inUse < capacity;
    },

    /** 某个任务当前占了几条。 */
    heldBy(key) {
      return held.get(String(key ?? "")) ?? 0;
    },

    /** 快照：给 /downloads 报给页面。 */
    snapshot() {
      return { limit: capacity, inUse, waiting: waiting.length, byTask: Object.fromEntries(held) };
    },

    /**
     * 一个任务彻底不干了：把它排队中的申请全部撤销，避免它们永远挂着。
     * 已持有的许可由调用方在 worker 收尾时正常归还。
     */
    cancelWaiting(key) {
      const holderKey = String(key ?? "");
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        if (waiting[i].key === holderKey) {
          const [waiter] = waiting.splice(i, 1);
          waiter.reject(new Error("任务已取消"));
        }
      }
    },

    close() {
      closed = true;
      for (const waiter of waiting.splice(0)) waiter.reject(new Error("连接池已关闭"));
    },
  };
}
