import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export interface PatrolObservation { id: string; time: string; note: string; risk: 'low' | 'medium' | 'high'; sync: SyncState; reviewed: boolean; }
export interface TrackPoint { id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual'; }
export interface Sample { id: string; code: string; species: string; count: number; status: 'draft' | 'submitted' | 'verified'; }
interface State { observations: PatrolObservation[]; points: TrackPoint[]; samples: Sample[]; conflict: string | null; }

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
  conflict: null
};

function readState(): State {
  try { const saved = Taro.getStorageSync('yf57-patrol-state'); return saved ? JSON.parse(saved) as State : seed; } catch { return seed; }
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<Omit<PatrolObservation, 'id' | 'time' | 'sync' | 'reviewed'>>) => {
      state.observations.unshift({ id: `o-${Date.now()}`, time: new Date().toLocaleString(), ...action.payload, sync: 'queued', reviewed: false });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({ id: `p-${Date.now()}`, ...action.payload, at: new Date().toLocaleTimeString(), source: 'gps' });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft' });
    },
    syncQueue: (state) => {
      state.observations = state.observations.map((item) => item.sync === 'queued' ? { ...item, sync: 'conflict' } : item);
      state.conflict = '服务器上已有同一巡护记录，请选择保留本地版本或合并负责人复核意见。';
    },
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => item.sync === 'conflict' ? { ...item, sync: 'synced' } : item);
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload); if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload); if (item) item.status = 'verified';
    }
  }
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const { addObservation, addPoint, addSample, resolveConflict, reviewObservation, syncQueue, verifySample } = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
