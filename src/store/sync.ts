// 离线观察与站点复核记录的逐条合并引擎。
// 纯函数 + Immer，不依赖 Taro，便于在 Node 下单测；store 层只负责持久化与触发。
import { produce, type Draft } from 'immer';

export type Risk = 'low' | 'medium' | 'high';
export type SyncState = 'queued' | 'synced' | 'conflict';

export interface ReviewConclusion {
  status: 'active' | 'invalidated';
  comment: string;
  // 结论所依据的正文与风险等级；观察这两项再被改动时结论失效
  basisNote: string;
  basisRisk: Risk;
  reviewedAt: string;
}

export interface TrackPoint {
  id: string;
  observationId: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  sync: SyncState;
}

// 巡护员设备上的观察
export interface LocalObservation {
  id: string;
  time: string;
  note: string;
  risk: Risk;
  // 本地自增版本号；与 stationRev 一致说明该观察本地没再改过
  localRev: number;
  stationRev: number;
  sync: SyncState;
}

// 站里的观察（含负责人复核结论）
export interface StationObservation {
  id: string;
  time: string;
  note: string;
  risk: Risk;
  rev: number;
  // 轨迹点跟着观察走，按观察 id 归属
  points: TrackPoint[];
  review?: ReviewConclusion;
}

export interface ReconcileItem {
  id: string; // 同观察重复出现时复用
  observationId: string;
  status: 'pending' | 'resolved-local' | 'resolved-remote';
  local: { note: string; risk: Risk; time: string; pointIds: string[] };
  remote: { note: string; risk: Risk; time: string; comment: string; pointIds: string[] };
  // 选择以站里版本为准时，被重新归属到站里观察上的本地轨迹点
  reattachedPointIds?: string[];
  resolvedAt?: string;
}

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: 'draft' | 'submitted' | 'verified';
}

export interface World {
  observations: LocalObservation[];
  points: TrackPoint[];
  station: StationObservation[];
  reconciliations: ReconcileItem[];
  samples: Sample[];
  // 同步流水：失败信息与“下一条故意失败”的演示开关也在这里，保证重开可续
  syncError: string | null;
  failNext: boolean;
}

export interface SyncResult {
  world: World;
  processed: string[]; // 本次真正应用的观察 id（已处理过的不会重复写入）
  failedAt: string | null;
}

const noopReviewBasis = (note: string, risk: Risk) => ({ basisNote: note, basisRisk: risk });

// 风险等级或正文发生改动 -> 已有复核结论失效
function invalidateReviewIfChanged(target: Draft<StationObservation>, note: string, risk: Risk, now: string) {
  if (target.review && target.review.status === 'active' &&
    (target.review.basisNote !== note || target.review.basisRisk !== risk)) {
    target.review.status = 'invalidated';
    target.review.comment = `${target.review.comment}（观察正文/风险已改动，${now} 起退回待复核）`;
  }
}

function localPointIdsOf(world: Draft<World>, observationId: string): string[] {
  return world.points.filter((p) => p.observationId === observationId).map((p) => p.id);
}

function upsertReconciliation(world: Draft<World>, item: ReconcileItem) {
  const index = world.reconciliations.findIndex(
    (entry) => entry.observationId === item.observationId && entry.status === 'pending'
  );
  if (index >= 0) world.reconciliations[index] = item;
  else world.reconciliations.unshift(item);
}

/**
 * 把待同步观察逐条合并进站里记录：
 * - 新观察直接入库；只在一边改过的照常入库（fast-forward）。
 * - 两边都改过：保留两版，生成待协调项，其余记录不受影响继续入库。
 * - 观察的风险等级或正文有改动：挂在该观察上的有效复核结论失效。
 */
export function syncOne(worldIn: World, observationId: string, now: string): World {
  return produce(worldIn, (world) => {
    const local = world.observations.find((entry) => entry.id === observationId);
    if (!local || local.sync === 'synced') return; // 已处理，不重复写入

    const station = world.station.find((entry) => entry.id === observationId);

    // 本地离线下挂在该观察上、还没进站的轨迹点
    const offlinePoints = world.points.filter(
      (p) => p.observationId === observationId && p.sync !== 'synced'
    );

    if (!station) {
      // 站里没有：新观察（含其轨迹点）照常入库
      world.station.unshift({
        id: local.id,
        time: local.time,
        note: local.note,
        risk: local.risk,
        rev: local.localRev,
        points: offlinePoints.map((p) => ({ ...p, sync: 'synced' as const }))
      });
      offlinePoints.forEach((p) => { p.sync = 'synced'; });
      local.stationRev = local.localRev;
      local.sync = 'synced';
      return;
    }

    const localChanged = local.localRev > local.stationRev;
    const remoteChanged = station.rev > local.stationRev;

    if (localChanged && remoteChanged) {
      // 两边同时修改：两版都保留，列入待协调，本条不入库，其余继续
      local.sync = 'conflict';
      upsertReconciliation(world, {
        id: `rc-${observationId}`,
        observationId,
        status: 'pending',
        local: { note: local.note, risk: local.risk, time: local.time, pointIds: localPointIdsOf(world, observationId) },
        remote: {
          note: station.note, risk: station.risk, time: station.time,
          comment: station.review?.comment ?? '', pointIds: station.points.map((p) => p.id)
        }
      });
      return;
    }

    if (localChanged) {
      // 只本地改过：以本地内容更新站里版本，结论按正文/风险变化决定是否失效
      invalidateReviewIfChanged(station, local.note, local.risk, now);
      station.note = local.note;
      station.risk = local.risk;
      station.time = local.time;
      station.rev = local.localRev;
    }

    // 轨迹点跟着所属观察一起对上（含“只站里改过”时本地补录的点）
    offlinePoints.forEach((p) => {
      if (!station.points.some((existing) => existing.id === p.id)) {
        station.points.push({ ...p, sync: 'synced' });
      }
      p.sync = 'synced';
    });

    local.stationRev = local.localRev > station.rev ? local.localRev : station.rev;
    local.sync = 'synced';
  });
}

/**
 * 顺序消费同步队列。返回处理结果；processed 已幂等（synced 跳过、conflict 只入待协调）。
 * failAfter > 0 时处理到第 failAfter 条制造一次断网失败，剩余留待重试只补没做完的部分。
 */
export function runSync(worldIn: World, now: string, failAfter = 0): SyncResult {
  let world = worldIn;
  const processed: string[] = [];
  const pending = worldIn.observations.filter((item) => item.sync !== 'synced');
  let failedAt: string | null = null;

  for (let index = 0; index < pending.length; index += 1) {
    const observationId = pending[index].id;
    if (world.failNext && index + 1 === failAfter) {
      // 应用被回收/断网：已处理的条目已落进 world（持久化时即落盘），后面的原样保留
      world = produce(world, (draft) => {
        draft.failNext = false;
        draft.syncError = `同步在第 ${index + 1} 条（${observationId}）中断网失败，重试只会补传剩余记录。`;
      });
      failedAt = observationId;
      break;
    }
    const before = world;
    world = syncOne(world, observationId, now);
    if (world !== before) processed.push(observationId);
  }

  if (!failedAt) {
    world = produce(world, (draft) => { draft.syncError = null; });
  }
  return { world, processed, failedAt };
}

/**
 * 解决一条待协调：
 * - keepLocal：以巡护员版本覆盖站里；站里的点归并回该观察；结论保留（内容若已变，
 *   站里结论所依据内容不同则退回待复核）。
 * - keepRemote：以站里版本为准；挂在本地观察下的轨迹点重新归属到站里版本上，
 *   并在待协调项里列出这些点。
 */
export function resolveReconciliation(worldIn: World, itemId: string, choice: 'local' | 'remote', now: string): World {
  return produce(worldIn, (world) => {
    const item = world.reconciliations.find((entry) => entry.id === itemId && entry.status === 'pending');
    if (!item) return;
    const local = world.observations.find((entry) => entry.id === item.observationId);
    const station = world.station.find((entry) => entry.id === item.observationId);
    if (!local || !station) return;

    if (choice === 'local') {
      invalidateReviewIfChanged(station, local.note, local.risk, now);
      station.note = local.note;
      station.risk = local.risk;
      station.time = local.time;
      station.rev = Math.max(station.rev, local.localRev) + 1;
      // 站里版本挂着的点保持归属；本地未进站的点归并进站里观察
      world.points.forEach((p) => {
        if (p.observationId === local.id) {
          if (!station.points.some((existing) => existing.id === p.id)) {
            station.points.push({ ...p, sync: 'synced' });
          }
          p.sync = 'synced';
        }
      });
      item.reattachedPointIds = [];
      item.status = 'resolved-local';
    } else {
      const reattached: string[] = [];
      // 以站里版本为准：本地观察下的轨迹点重新归属到站里观察上并列出
      world.points.forEach((p) => {
        if (p.observationId === local.id) {
          p.observationId = station.id;
          p.sync = 'synced';
          if (!station.points.some((existing) => existing.id === p.id)) {
            station.points.push({ ...p });
          }
          reattached.push(p.id);
        }
      });
      local.note = station.note;
      local.risk = station.risk;
      local.time = station.time;
      item.reattachedPointIds = reattached;
      item.status = 'resolved-remote';
    }

    local.stationRev = station.rev;
    local.localRev = station.rev;
    local.sync = 'synced';
    item.resolvedAt = now;
  });
}

/** 负责人在站里复核观察：结论记录所依据的正文/风险，之后这两项再变就失效。 */
export function reviewStationObservation(worldIn: World, observationId: string, comment: string, now: string): World {
  return produce(worldIn, (world) => {
    const station = world.station.find((entry) => entry.id === observationId);
    if (!station) return;
    station.review = { status: 'active', comment, reviewedAt: now, ...noopReviewBasis(station.note, station.risk) };
  });
}

/** 巡护员离线改正文/风险：只动本地版本并自增版本号，制造后续逐条合并依据。 */
export function editLocalObservation(worldIn: World, observationId: string, patch: { note?: string; risk?: Risk }): World {
  return produce(worldIn, (world) => {
    const local = world.observations.find((entry) => entry.id === observationId);
    if (!local) return;
    if (patch.note !== undefined) local.note = patch.note;
    if (patch.risk !== undefined) local.risk = patch.risk;
    local.localRev += 1;
    // 已同步的再改进队列；待协调期间又改也回到队列，重试时按最新版本重新判定
    if (local.sync === 'synced' || local.sync === 'conflict') local.sync = 'queued';
  });
}

// ---- 页面计数 ----
export const countPendingReconcile = (world: World) =>
  world.reconciliations.filter((item) => item.status === 'pending').length;

// 待复核：站里没有有效结论（未复核，或结论因正文/风险改动已失效）
export const countPendingReview = (world: World) =>
  world.station.filter((item) => !item.review || item.review.status !== 'active').length;

// 没同步完：观察或轨迹点仍在队列里，或观察两边改过等协调
export const countNotSynced = (world: World) =>
  world.observations.filter((item) => item.sync !== 'synced').length
  + world.points.filter((point) => point.sync !== 'synced').length;
