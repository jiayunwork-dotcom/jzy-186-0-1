import { AsyncLocalStorage } from 'async_hooks';

/**
 * 可重入的异步互斥队列。
 *
 * 服务层“先 withWriteLock 再在内部调仓储写方法”，仓储实现不再重复加锁；
 * 但为了让内存存储的 insertActivity 也能独立安全调用，锁设计为
 * 基于 AsyncLocalStorage 的可重入锁：同一异步上下文可嵌套进入，
 * 只有最外层退出时才真正释放。不同上下文之间严格串行。
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = new AsyncLocalStorage<{ nested: boolean }>();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const ownerCtx = this.depth.getStore();
    if (ownerCtx) {
      // 已在锁内：直接执行，不排队、不释放
      return fn();
    }
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await this.depth.run({ nested: true }, fn);
    } finally {
      release();
    }
  }
}
