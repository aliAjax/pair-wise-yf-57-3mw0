import { configureStore, createSlice, type PayloadAction, type ThunkAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import {
  editLocalObservation,
  resolveReconciliation,
  reviewStationObservation,
  syncOne,
  countNotSynced,
  countPendingReconcile,
  countPendingReview,
  type Risk,
  type Sample,
  type World
} from './sync';

export * from './sync';

const now = () => new Date().toLocaleString();
const STORAGE_KEY = 'yf57-patrol-world';

// 初始场景：
// - o-new：断网后新建的观察（含轨迹点），站里还没有
// - o-conflict：两边同时改过，回网后要保留两版待协调
// - o-review：本地改了风险/正文，站里已有有效复核结论，合并后结论应失效退回待复核
// - o3：两边都没动，已有复核结论照旧保留
// - o-remote：站里单方面改过，本地离线补了一个轨迹点
function buildSeed(): World {
  return {
    observations: [
      { id: 'o-new', time: '2026-10-01 09:12', note: '北坡沟口发现野猪群，约 6 头', risk: 'medium', localRev: 1, stationRev: 0, sync: 'queued' },
      { id: 'o-conflict', time: '2026-09-30 16:40', note: '本地补充：相机位置其实在沟东侧 20 米', risk: 'high', localRev: 3, stationRev: 1, sync: 'queued' },
      { id: 'o-review', time: '2026-09-30 10:05', note: '本地修正：不是豹猫足迹，尺寸更大', risk: 'high', localRev: 2, stationRev: 1, sync: 'queued' },
      { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', localRev: 1, stationRev: 1, sync: 'synced' },
      { id: 'o-remote', time: '2026-09-29 11:20', note: '巡护点 3 号围栏完好', risk: 'low', localRev: 1, stationRev: 1, sync: 'queued' }
    ],
    points: [
      { id: 'p-new-1', observationId: 'o-new', latitude: 30.6012, longitude: 103.2455, at: '09:12', source: 'gps', sync: 'queued' },
      { id: 'p-conflict-1', observationId: 'o-conflict', latitude: 30.5888, longitude: 103.2267, at: '16:40', source: 'manual', sync: 'queued' },
      { id: 'p-remote-1', observationId: 'o-remote', latitude: 30.5744, longitude: 103.2091, at: '11:35', source: 'gps', sync: 'queued' },
      { id: 'p3', observationId: 'o3', latitude: 30.5821, longitude: 103.2174, at: '08:40', source: 'gps', sync: 'synced' }
    ],
    station: [
      {
        id: 'o-conflict', time: '2026-09-30 16:20', note: '站点负责人意见：核实为沟西侧，建议复测', risk: 'medium', rev: 2,
        points: [{ id: 'sp-conflict-1', observationId: 'o-conflict', latitude: 30.5881, longitude: 103.2259, at: '16:20', source: 'gps', sync: 'synced' }]
      },
      {
        id: 'o-review', time: '2026-09-30 10:05', note: '发现疑似豹猫足迹', risk: 'medium', rev: 1,
        points: [{ id: 'sp-review-1', observationId: 'o-review', latitude: 30.5902, longitude: 103.2301, at: '10:05', source: 'gps', sync: 'synced' }],
        review: { status: 'active', comment: '证据照片清晰，维持中风险', reviewedAt: '2026-09-30 11:00', basisNote: '发现疑似豹猫足迹', basisRisk: 'medium' }
      },
      {
        id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', rev: 1,
        points: [{ id: 'p3', observationId: 'o3', latitude: 30.5821, longitude: 103.2174, at: '08:40', source: 'gps', sync: 'synced' }],
        review: { status: 'active', comment: '低风险，无需跟进', reviewedAt: '2026-09-29 09:10', basisNote: '样线南段没有异常', basisRisk: 'low' }
      },
      {
        id: 'o-remote', time: '2026-09-29 11:25', note: '巡护点 3 号围栏完好，站点已补充维护记录', risk: 'low', rev: 2,
        points: [{ id: 'sp-remote-1', observationId: 'o-remote', latitude: 30.5741, longitude: 103.2088, at: '11:25', source: 'gps', sync: 'synced' }]
      }
    ],
    reconciliations: [],
    samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
    syncError: null,
    failNext: false
  };
}

function readState(): World {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    // 真机 getStorageSync 直接返回对象；H5/部分平台返回字符串，两种都兼容
    if (saved && (typeof saved === 'string' ? saved.length > 0 : Array.isArray(saved.observations))) {
      return typeof saved === 'string' ? JSON.parse(saved) as World : saved as World;
    }
  } catch {
    // 存储损坏时回落初始数据
  }
  return buildSeed();
}

interface SyncProgress { running: boolean; done: number; total: number }
interface PatrolState { world: World; progress: SyncProgress }

const slice = createSlice({
  name: 'patrol',
  initialState: { world: readState(), progress: { running: false, done: 0, total: 0 } } as PatrolState,
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      const id = `o-${Date.now()}`;
      state.world.observations.unshift({
        id, time: now(), note: action.payload.note, risk: action.payload.risk,
        localRev: 1, stationRev: 0, sync: 'queued'
      });
    },
    // 轨迹点挂在当前指定的观察下（默认最新一条），回网后随所属观察一起对上
    attachPoint: (state, action: PayloadAction<{ observationId?: string; latitude: number; longitude: number }>) => {
      const observationId = action.payload.observationId ?? state.world.observations[0]?.id;
      if (!observationId) return;
      state.world.points.push({
        id: `p-${Date.now()}`, observationId,
        latitude: action.payload.latitude, longitude: action.payload.longitude,
        at: new Date().toLocaleTimeString(), source: 'gps', sync: 'queued'
      });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.world.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft' });
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.world.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    },
    editObservation: (state, action: PayloadAction<{ id: string; note?: string; risk?: Risk }>) => {
      state.world = editLocalObservation(state.world, action.payload.id, {
        note: action.payload.note, risk: action.payload.risk
      });
    },
    reviewStation: (state, action: PayloadAction<{ id: string; comment: string }>) => {
      state.world = reviewStationObservation(state.world, action.payload.id, action.payload.comment, now());
    },
    resolveConflict: (state, action: PayloadAction<{ id: string; choice: 'local' | 'remote' }>) => {
      state.world = resolveReconciliation(state.world, action.payload.id, action.payload.choice, now());
    },
    // 同步开始：只登记总数，进度按已入库条目计算（失败时已完成部分已落盘）
    syncStarted: (state, action: PayloadAction<{ total: number; simulateFailure: boolean }>) => {
      state.progress = { running: true, done: 0, total: action.payload.total };
      state.world.failNext = action.payload.simulateFailure;
      if (!action.payload.simulateFailure) state.world.syncError = null;
    },
    // 同步单条：幂等，已 synced 的记录引擎会直接跳过
    syncedOne: (state, action: PayloadAction<string>) => {
      state.world = syncOne(state.world, action.payload, now());
      state.progress.done = state.progress.total - state.world.observations.filter((item) => item.sync !== 'synced').length;
    },
    syncFailed: (state, action: PayloadAction<string>) => {
      state.world.syncError = action.payload;
      state.world.failNext = false;
      state.progress.running = false;
    },
    syncFinished: (state) => {
      state.world.syncError = null;
      state.world.failNext = false;
      state.progress.running = false;
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) })
});

export const { useConnectionQuery } = patrolApi;
export const {
  addObservation, addSample, attachPoint, editObservation, reviewStation,
  resolveConflict, verifySample, syncStarted, syncedOne, syncFailed, syncFinished
} = slice.actions;

// 逐条同步：每条入库后状态立即落盘（store 订阅写存储），应用被回收后重开可从未完成处继续。
// simulateFailure 时在队列中段制造一次断网失败，已完成的不重传，重试只补没做完的部分。
const networkDelay = () => new Promise<void>((resolveTimer) => { setTimeout(resolveTimer, 280); });

export const synchronize = (simulateFailure = false): ThunkAction<Promise<void>, RootState, undefined, ReturnType<typeof slice.actions[keyof typeof slice.actions]>> =>
  async (dispatch, getState) => {
    const pending = getState().patrol.world.observations.filter((item) => item.sync !== 'synced');
    if (pending.length === 0) { dispatch(syncFinished()); return; }
    // 失败点选在队列中间（至少处理完 1 条），演示“只补剩余部分”
    const failAt = simulateFailure ? Math.min(2, pending.length) : 0;
    dispatch(syncStarted({ total: pending.length, simulateFailure }));
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      await networkDelay(); // 模拟弱网逐条上行；await 点也是回收检查点
      if (simulateFailure && index + 1 === failAt) {
        dispatch(syncFailed(`同步在第 ${index + 1} 条（${item.id}）中断网失败，已入库的 ${index} 条不重传，重试只补剩余记录。`));
        return;
      }
      dispatch(syncedOne(item.id));
    }
    dispatch(syncFinished());
  };

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});

// 每次状态变更即持久化，相当于逐条检查点：被杀掉重开后接着未完成的记录继续
store.subscribe(() => Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol.world)));

export const selectors = {
  pendingReconcile: (state: RootState) => countPendingReconcile(state.patrol.world),
  pendingReview: (state: RootState) => countPendingReview(state.patrol.world),
  notSynced: (state: RootState) => countNotSynced(state.patrol.world)
};

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
