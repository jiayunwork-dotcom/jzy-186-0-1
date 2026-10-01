import { ActivityStore } from '../activity/store.interface';
import { FactorStore } from '../factors/store.interface';
import { ClosureStore } from '../closure/entities';

/** 统一存储端口：一个实现同时承载活动、因子、关账三类数据 */
export interface Store extends ActivityStore, FactorStore, ClosureStore {
  /** 启动时初始化（PG 建表；内存实现为空操作） */
  init?(): Promise<void>;
  /** 关账临界区：回调内读取到的活动最大序号等状态与外界写操作互斥 */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>;
}
