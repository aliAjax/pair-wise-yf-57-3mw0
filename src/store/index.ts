import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

// ---------- 类型 ----------
export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type Risk = 'low' | 'medium' | 'high';

/** 观察的一个版本（三向合并：本地版 / 站里版 / 上次同步快照） */
export interface ObsVersion { note: string; risk: Risk; time: string; hash: string; }

export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: Risk;
  sync: SyncState;
  reviewed: boolean;
  /** 复核时的正文+风险哈希，内容改动后用于判定复核结论是否失效 */
  reviewedHash?: string;
  /** 归属它的轨迹点 id */
  pointIds: string[];
  /** 断网时在本地改出的版本 */
  local?: ObsVersion;
  /** 站里（服务器复核记录）上的版本 */
  station?: ObsVersion;
  /** 上次同步完成时的快照，三向合并基准 */
  base?: ObsVersion;
}

export interface TrackPoint {
  id: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  /** 所属观察；观察以站里版本为准后，点会被重新归属或列入待协调 */
  observationId?: string;
}

export interface Sample { id: string; code: string; species: string; count: number; status: 'draft' | 'submitted' | 'verified'; }

/** 待协调项：同一条观察两边都改了，保留两版，等人工选定以哪版为准 */
export interface CoordItem {
  id: string;
  observationId: string;
  local: ObsVersion;
  station: ObsVersion;
  pointIds: string[];
  /** 以站里版本为准后，从观察上卸下、待重新归属的轨迹点 */
  orphanPointIds?: string[];
  status: 'open' | 'local' | 'station';
  createdAt: string;
}

/** 同步台账：按条记录跟踪处理状态，断点续传、幂等写入 */
export interface LedgerEntry {
  recordId: string;
  kind: 'observation' | 'point' | 'sample';
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

export interface SyncRun {
  id: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  /** 本轮待处理总数 */
  total: number;
  /** 本轮已处理条数 */
  processed: number;
  failedRecordId?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface State {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  coordItems: CoordItem[];
  ledger: Record<string, LedgerEntry>;
  syncRun: SyncRun;
  /** 模拟弱网：首次写入可能中断，用于演示失败重试 */
  weakNetwork: boolean;
}

// ---------- 工具函数 ----------
export function hashVersion(v: { note: string; risk: Risk; time: string }): string {
  const s = `${v.note}|${v.risk}|${v.time}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h${h.toString(16)}`;
}

function nowIso() { return new Date().toISOString(); }

function makeVersion(note: string, risk: Risk, time: string): ObsVersion {
  return { note, risk, time, hash: hashVersion({ note, risk, time }) };
}

function versionOf(obs: PatrolObservation): ObsVersion {
  return makeVersion(obs.note, obs.risk, obs.time);
}

function applyVersion(obs: PatrolObservation, v: ObsVersion) {
  obs.note = v.note;
  obs.risk = v.risk;
  obs.time = v.time;
}

function newLedger(recordId: string, kind: LedgerEntry['kind']): LedgerEntry {
  return { recordId, kind, status: 'pending', attempts: 0, updatedAt: nowIso() };
}

function getLedger(state: State, recordId: string, kind: LedgerEntry['kind']): LedgerEntry {
  let entry = state.ledger[recordId];
  if (!entry) {
    entry = newLedger(recordId, kind);
    state.ledger[recordId] = entry;
  }
  return entry;
}

/** 记录有新改动待写入站里时，把台账重置为待处理（断点续传时不会被跳过） */
function markPending(state: State, recordId: string, kind: LedgerEntry['kind']) {
  const entry = getLedger(state, recordId, kind);
  entry.status = 'pending';
  entry.updatedAt = nowIso();
}

function countPending(state: State): number {
  let n = 0;
  const records: Array<[string, LedgerEntry['kind']]> = [
    ...state.observations.map((o) => [o.id, 'observation'] as [string, LedgerEntry['kind']]),
    ...state.points.map((p) => [p.id, 'point'] as [string, LedgerEntry['kind']]),
    ...state.samples.map((s) => [s.id, 'sample'] as [string, LedgerEntry['kind']])
  ];
  for (const [id, kind] of records) {
    const entry = state.ledger[id];
    if (!entry || entry.status !== 'done') n++;
  }
  return n;
}

function minutesOf(t: string): number {
  const m = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 按时间就近，给孤儿轨迹点重新归属到已同步的观察 */
export function nearestObservation(at: string, candidates: PatrolObservation[]): PatrolObservation | undefined {
  const target = minutesOf(at);
  let best: PatrolObservation | undefined;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const d = Math.abs(minutesOf(c.time) - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = c;
    }
  }
  return best;
}

// ---------- 三向合并引擎 ----------
/**
 * 合并一条观察：
 * - 站里没有 → 新观察入库，轨迹点按归属一起对上；
 * - 仅本地改 → 本地版入站；
 * - 仅站里改 → 采用站里版；
 * - 两边都改且不一致 → 保留两版，生成待协调项，不覆盖任何一版。
 * 合并后若正文/风险与复核时不同，复核结论失效、退回待复核。
 */
function mergeObservation(state: State, obs: PatrolObservation, entry: LedgerEntry, now: string): 'done' | 'pending' {
  const localV: ObsVersion = obs.local ?? versionOf(obs);
  const baseV = obs.base;
  const stationV = obs.station;

  if (!stationV) {
    // 新观察：随本地记录入库
    obs.station = { ...localV };
    obs.base = { ...localV };
    applyVersion(obs, localV);
    obs.sync = 'synced';
  } else {
    const localChanged = !baseV || localV.hash !== baseV.hash;
    const stationChanged = !!baseV && stationV.hash !== baseV.hash;
    if (localChanged && stationChanged && localV.hash !== stationV.hash) {
      // 两边同时修改过 → 保留两版，列待协调项
      obs.sync = 'conflict';
      const exists = state.coordItems.some((c) => c.observationId === obs.id && c.status === 'open');
      if (!exists) {
        state.coordItems.push({
          id: `c-${obs.id}-${now}`,
          observationId: obs.id,
          local: { ...localV },
          station: { ...stationV },
          pointIds: [...obs.pointIds],
          status: 'open',
          createdAt: now
        });
      }
      entry.status = 'pending';
      entry.updatedAt = now;
      return 'pending';
    }
    if (localChanged) {
      obs.station = { ...localV };
      obs.base = { ...localV };
      applyVersion(obs, localV);
    } else if (stationChanged) {
      applyVersion(obs, stationV);
      obs.base = { ...stationV };
    }
    obs.sync = 'synced';
  }

  // 风险等级或正文有改动 → 对应复核结论失效，退回待复核；没改到的结论照旧
  const currentHash = versionOf(obs).hash;
  if (obs.reviewed && obs.reviewedHash && obs.reviewedHash !== currentHash) {
    obs.reviewed = false;
  }

  entry.status = 'done';
  entry.attempts += 1;
  entry.updatedAt = now;
  return 'done';
}

/** 轨迹点跟着所属观察一起对上；观察待协调时，点暂不入库 */
function processPoint(state: State, point: TrackPoint, entry: LedgerEntry, now: string, shouldFail: (e: LedgerEntry) => boolean): 'done' | 'pending' | 'failed' {
  if (entry.status === 'done') return 'done';
  const owner = point.observationId ? state.observations.find((o) => o.id === point.observationId) : undefined;
  if (owner && owner.sync === 'conflict') {
    entry.status = 'pending';
    entry.updatedAt = now;
    return 'pending';
  }
  if (shouldFail(entry)) {
    entry.status = 'failed';
    entry.attempts += 1;
    entry.lastError = '弱网导致写入中断，请重试';
    entry.updatedAt = now;
    return 'failed';
  }
  entry.status = 'done';
  entry.attempts += 1;
  entry.updatedAt = now;
  return 'done';
}

// ---------- 种子数据 ----------
const seedObservations: PatrolObservation[] = [
  {
    id: 'o1', time: '2026-09-29 07:20',
    note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium',
    sync: 'synced', reviewed: false, pointIds: ['p1'],
    base: makeVersion('东坡发现新鲜足迹，沿溪谷方向移动', 'medium', '2026-09-29 07:20'),
    station: makeVersion('东坡发现新鲜足迹，沿溪谷方向移动', 'medium', '2026-09-29 07:20')
  },
  {
    id: 'o2', time: '2026-09-29 08:05',
    note: '红外相机外壳松动，已拍照待补报', risk: 'high',
    sync: 'queued', reviewed: false, pointIds: ['p2'],
    base: makeVersion('红外相机外壳松动', 'high', '2026-09-29 08:05'),
    local: makeVersion('红外相机外壳松动，已拍照待补报', 'high', '2026-09-29 08:05'),
    station: makeVersion('红外相机外壳松动', 'medium', '2026-09-29 08:05')
  },
  {
    id: 'o3', time: '2026-09-29 08:40',
    note: '样线南段没有异常', risk: 'low',
    sync: 'synced', reviewed: true, pointIds: [],
    reviewedHash: makeVersion('样线南段没有异常', 'low', '2026-09-29 08:40').hash,
    base: makeVersion('样线南段没有异常', 'low', '2026-09-29 08:40'),
    station: makeVersion('样线南段没有异常', 'low', '2026-09-29 08:40')
  },
  {
    id: 'o4', time: '2026-09-29 09:12',
    note: '北坡发现疑似人为丢弃物', risk: 'medium',
    sync: 'queued', reviewed: false, pointIds: [],
    local: makeVersion('北坡发现疑似人为丢弃物', 'medium', '2026-09-29 09:12')
  },
  {
    id: 'o5', time: '2026-09-29 09:30',
    note: '管护站周边巡查', risk: 'low',
    sync: 'queued', reviewed: true, pointIds: [],
    reviewedHash: makeVersion('管护站周边巡查', 'low', '2026-09-29 09:30').hash,
    base: makeVersion('管护站周边巡查', 'low', '2026-09-29 09:30'),
    station: makeVersion('管护站周边巡查，一切正常', 'medium', '2026-09-29 09:30')
  }
];

const seedPoints: TrackPoint[] = [
  { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', observationId: 'o1' },
  { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', observationId: 'o2' }
];

const seed: State = {
  observations: seedObservations,
  points: seedPoints,
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
  coordItems: [],
  ledger: {},
  syncRun: { id: 'run-init', status: 'idle', total: 0, processed: 0 },
  weakNetwork: true
};

const STORAGE_KEY = 'yf57-patrol-state';

function readState(): State {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<State>;
      return {
        ...seed,
        ...parsed,
        syncRun: { ...seed.syncRun, ...(parsed.syncRun ?? {}) }
      };
    }
  } catch { /* 存储损坏时回到种子数据 */ }
  return seed;
}

// ---------- 页面计数 ----------
export interface PatrolCounts {
  coord: number;       // 待协调
  review: number;      // 待复核
  pendingSync: number; // 没同步完
  points: number;
  samples: number;
}

export function selectCounts(state: State): PatrolCounts {
  const pendingPoints = state.points.filter((p) => {
    if (!p.observationId) return true;
    const owner = state.observations.find((o) => o.id === p.observationId);
    return !owner || owner.sync !== 'synced';
  }).length;
  return {
    coord: state.coordItems.filter((c) => c.status === 'open').length,
    review: state.observations.filter((o) => !o.reviewed).length,
    pendingSync: state.observations.filter((o) => o.sync !== 'synced').length + pendingPoints,
    points: state.points.length,
    samples: state.samples.length
  };
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      const time = new Date().toLocaleString();
      const v = makeVersion(action.payload.note, action.payload.risk, time);
      state.observations.unshift({
        id: `o-${Date.now()}`,
        time,
        note: v.note,
        risk: v.risk,
        sync: 'queued',
        reviewed: false,
        pointIds: [],
        local: v
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number; observationId?: string }>) => {
      const id = `p-${Date.now()}`;
      state.points.push({
        id,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: new Date().toLocaleTimeString(),
        source: 'gps',
        observationId: action.payload.observationId
      });
      if (action.payload.observationId) {
        const obs = state.observations.find((o) => o.id === action.payload.observationId);
        if (obs && !obs.pointIds.includes(id)) obs.pointIds.push(id);
      }
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft' });
    },
    editObservation: (state, action: PayloadAction<{ id: string; note: string; risk: Risk }>) => {
      const obs = state.observations.find((o) => o.id === action.payload.id);
      if (!obs) return;
      if (!obs.base) obs.base = versionOf(obs);
      obs.note = action.payload.note;
      obs.risk = action.payload.risk;
      const v = versionOf(obs);
      obs.local = { ...v };
      obs.sync = 'queued';
      markPending(state, obs.id, 'observation');
      // 正文或风险改动 → 原复核结论失效，退回待复核
      if (obs.reviewedHash && obs.reviewedHash !== v.hash) obs.reviewed = false;
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const obs = state.observations.find((o) => o.id === action.payload);
      if (!obs || obs.sync === 'conflict') return;
      obs.reviewed = true;
      obs.reviewedHash = versionOf(obs).hash;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) item.status = 'verified';
    },
    setWeakNetwork: (state, action: PayloadAction<boolean>) => {
      state.weakNetwork = action.payload;
    },
    /** 设置某条观察的站里版本（演示/测试用：模拟站里另一人改过） */
    setStationVersion: (state, action: PayloadAction<{ id: string; note: string; risk: Risk }>) => {
      const obs = state.observations.find((o) => o.id === action.payload.id);
      if (!obs) return;
      obs.station = makeVersion(action.payload.note, action.payload.risk, obs.time);
      obs.sync = 'queued';
      markPending(state, obs.id, 'observation');
    },
    /** 重置为种子数据（调试/测试用） */
    resetState: () => seed,
    /** 模拟站里另一人改动一条已同步观察（用于演示站里版本更新后复核结论失效） */
    simulateStationChange: (state) => {
      // 优先挑已复核的观察，演示"站里改动后复核结论失效"
      const candidates = state.observations.filter(
        (o) => o.sync === 'synced' && o.base && o.station && o.station.hash === o.base.hash
      );
      const target = candidates.find((o) => o.reviewed) ?? candidates[0];
      if (!target) return;
      const changed = makeVersion(`${target.note}（站里补充：周边发现新增兽径，需提高关注）`, 'high', target.time);
      target.station = changed;
      target.sync = 'queued';
      markPending(state, target.id, 'observation');
    },
    /**
     * 恢复联网，按条合并入库。
     * 失败只中断当前轮次，台账里已 done 的记录下轮直接跳过，重试只补没做完的部分。
     */
    runSync: (state) => {
      const now = nowIso();
      if (state.syncRun.status !== 'running') {
        state.syncRun = {
          id: `run-${Date.now()}`,
          status: 'running',
          total: countPending(state),
          processed: 0,
          startedAt: now
        };
      }
      const run = state.syncRun;
      const shouldFail = (entry: LedgerEntry) => state.weakNetwork && entry.attempts === 0 && Math.random() < 0.45;

      // 1. 按条合并观察
      for (const obs of state.observations) {
        const entry = getLedger(state, obs.id, 'observation');
        if (entry.status === 'done') continue; // 处理过的记录不再重复写入
        if (shouldFail(entry)) {
          entry.status = 'failed';
          entry.attempts += 1;
          entry.lastError = '弱网导致写入中断，请重试';
          entry.updatedAt = now;
          run.status = 'failed';
          run.failedRecordId = obs.id;
          run.finishedAt = now;
          return;
        }
        if (mergeObservation(state, obs, entry, now) === 'done') run.processed += 1;
      }
      // 2. 轨迹点跟着所属观察一起对上
      for (const point of state.points) {
        const entry = getLedger(state, point.id, 'point');
        if (entry.status === 'done') continue;
        const result = processPoint(state, point, entry, now, shouldFail);
        if (result === 'failed') {
          run.status = 'failed';
          run.failedRecordId = point.id;
          run.finishedAt = now;
          return;
        }
        if (result === 'done') run.processed += 1;
      }
      // 3. 样本照常入库
      for (const sample of state.samples) {
        const entry = getLedger(state, sample.id, 'sample');
        if (entry.status === 'done') continue;
        if (shouldFail(entry)) {
          entry.status = 'failed';
          entry.attempts += 1;
          entry.lastError = '弱网导致写入中断，请重试';
          entry.updatedAt = now;
          run.status = 'failed';
          run.failedRecordId = sample.id;
          run.finishedAt = now;
          return;
        }
        entry.status = 'done';
        entry.attempts += 1;
        entry.updatedAt = now;
        run.processed += 1;
      }
      run.status = 'done';
      run.finishedAt = now;
    },
    /** 协调待协调项：选定以本地版还是站里版为准 */
    resolveCoord: (state, action: PayloadAction<{ coordId: string; choice: 'local' | 'station' }>) => {
      const item = state.coordItems.find((c) => c.id === action.payload.coordId);
      if (!item || item.status !== 'open') return;
      const obs = state.observations.find((o) => o.id === item.observationId);
      if (!obs) return;
      const now = nowIso();
      if (action.payload.choice === 'local') {
        applyVersion(obs, item.local);
        obs.station = { ...item.local };
        obs.base = { ...item.local };
        item.status = 'local';
      } else {
        applyVersion(obs, item.station);
        obs.station = { ...item.station };
        obs.base = { ...item.station };
        item.status = 'station';
        // 以站里版本为准：挂在它下面的轨迹点卸下，列入待重新归属
        item.orphanPointIds = [...obs.pointIds];
        obs.pointIds = [];
        for (const p of state.points) {
          if (item.orphanPointIds.includes(p.id)) p.observationId = undefined;
        }
      }
      obs.sync = 'synced';
      // 协调后正文/风险若与复核时不同，结论同样失效
      const currentHash = versionOf(obs).hash;
      if (obs.reviewed && obs.reviewedHash && obs.reviewedHash !== currentHash) obs.reviewed = false;
      // 版本已定，记录入库（幂等，不重复写）
      const entry = getLedger(state, obs.id, 'observation');
      entry.status = 'done';
      entry.attempts += 1;
      entry.updatedAt = now;
    },
    /** 给以站里版本为准后卸下的轨迹点重新归属（默认按时间就近） */
    reattachPoint: (state, action: PayloadAction<{ pointId: string; observationId?: string }>) => {
      const point = state.points.find((p) => p.id === action.payload.pointId);
      if (!point) return;
      const now = nowIso();
      for (const item of state.coordItems) {
        if (item.orphanPointIds?.includes(point.id)) {
          item.orphanPointIds = item.orphanPointIds.filter((id) => id !== point.id);
        }
      }
      let targetId = action.payload.observationId;
      if (!targetId) {
        const targets = state.observations.filter((o) => o.sync === 'synced');
        targetId = nearestObservation(point.at, targets)?.id;
      }
      if (targetId) {
        const target = state.observations.find((o) => o.id === targetId);
        if (target) {
          point.observationId = target.id;
          if (!target.pointIds.includes(point.id)) target.pointIds.push(point.id);
        }
      }
      // 重新归属后即随观察入库
      const entry = state.ledger[point.id];
      if (entry) {
        entry.status = 'done';
        entry.attempts += 1;
        entry.updatedAt = now;
      }
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
  addObservation, addPoint, addSample, editObservation, reviewObservation,
  runSync, resolveCoord, reattachPoint, setWeakNetwork, simulateStationChange,
  setStationVersion, resetState, verifySample
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});
if (typeof window !== 'undefined') {
  // 应用被系统回收后重开也能接着：台账、待协调、待复核状态全部持久化
  store.subscribe(() => Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
