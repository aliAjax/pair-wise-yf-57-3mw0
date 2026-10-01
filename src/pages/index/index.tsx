import { useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog, Progress, Switch, Tag } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation,
  addPoint,
  addSample,
  editObservation,
  hashVersion,
  reattachPoint,
  resolveCoord,
  reviewObservation,
  runSync,
  selectCounts,
  setWeakNetwork,
  simulateStationChange,
  verifySample,
  type PatrolObservation,
  type Risk,
  type RootState
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const riskTagType: Record<Risk, 'default' | 'warning' | 'danger'> = { low: 'default', medium: 'warning', high: 'danger' };

function riskLabel(t: ReturnType<typeof useI18n>, risk: Risk) {
  if (risk === 'high') return t.highRisk;
  if (risk === 'medium') return t.mediumRisk;
  return t.lowRisk;
}

function syncLabel(sync: PatrolObservation['sync']) {
  if (sync === 'synced') return '已入库';
  if (sync === 'conflict') return '待协调';
  if (sync === 'queued') return '待同步';
  return '本地';
}

/** 编辑观察弹窗：断网时改的内容进本地版，联网后参与三向合并 */
function EditDialog({ obs, onClose }: { obs: PatrolObservation | null; onClose: () => void }) {
  const t = useI18n();
  const dispatch = useDispatch();
  const [note, setNote] = useState('');
  const [risk, setRisk] = useState<Risk>('low');
  const [editingId, setEditingId] = useState<string | null>(null);
  if (obs && obs.id !== editingId) {
    setEditingId(obs.id);
    setNote(obs.note);
    setRisk(obs.risk);
  }
  const confirm = () => {
    if (!obs || note.trim().length < 2) return;
    dispatch(editObservation({ id: obs.id, note: note.trim(), risk }));
    onClose();
  };
  return (
    <NutDialog visible={!!obs} title={t.editTitle} confirmText={t.save} cancelText="取消" onConfirm={confirm} onCancel={onClose}>
      <View className="edit-dialog">
        <Textarea className="textarea" value={note} onInput={(e) => setNote(e.detail.value)} placeholder={t.noteLabel} />
        <View className="risk">
          <Text>{t.riskLabel}</Text>
          <select value={risk} onChange={(e) => setRisk(e.target.value as Risk)}>
            <option value="low">{t.lowRisk}</option>
            <option value="medium">{t.mediumRisk}</option>
            <option value="high">{t.highRisk}</option>
          </select>
        </View>
      </View>
    </NutDialog>
  );
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const counts = selectCounts(state);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });
  const [editing, setEditing] = useState<PatrolObservation | null>(null);

  const recordPoint = async () => {
    const ownerId = state.observations[0]?.id;
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude, observationId: ownerId }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2, observationId: ownerId }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) {
      dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    }
    reset();
  };

  const openCoord = state.coordItems.filter((c) => c.status === 'open');
  const orphanItems = state.coordItems.filter((c) => c.status === 'station' && c.orphanPointIds && c.orphanPointIds.length > 0);
  const pendingReview = state.observations.filter((o) => !o.reviewed);
  const ownerOf = (id?: string) => state.observations.find((o) => o.id === id);
  const run = state.syncRun;
  const progress = run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0;

  const reviewReason = (o: PatrolObservation) => {
    if (!o.reviewedHash) return t.reasonNew;
    const currentHash = hashVersion({ note: o.note, risk: o.risk, time: o.time });
    return o.reviewedHash === currentHash ? t.reasonPending : t.reasonInvalidated;
  };

  const syncStatusText = () => {
    if (run.status === 'running') return t.syncing;
    if (run.status === 'done') return t.syncDone;
    if (run.status === 'failed') return `${t.syncFailed}（${run.failedRecordId ?? ''}）`;
    return t.syncIdle;
  };

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">{t.subtitle}</Text>
      </View>

      {/* 条数总览：待协调 / 待复核 / 未同步完 */}
      <View className="metrics">
        <View><Text className="metric-label">{t.pendingCoord}</Text><Text className="metric warn">{counts.coord}</Text></View>
        <View><Text className="metric-label">{t.pendingReview}</Text><Text className="metric warn">{counts.review}</Text></View>
        <View><Text className="metric-label">{t.pendingSync}</Text><Text className="metric warn">{counts.pendingSync}</Text></View>
        <View><Text className="metric-label">{t.points}</Text><Text className="metric">{counts.points}</Text></View>
      </View>

      {/* 现场记录 */}
      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>{t.riskLabel}</Text>
            <select {...register('risk')}>
              <option value="low">{t.lowRisk}</option>
              <option value="medium">{t.mediumRisk}</option>
              <option value="high">{t.highRisk}</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>{t.recordPoint}</Button>
        </form>
      </View>

      {/* 同步队列 */}
      <View className="card">
        <View className="card-title">{t.sync}<Text className="count">{counts.pendingSync} 条</Text></View>
        <View className="sync-status">
          <Tag type={run.status === 'failed' ? 'danger' : run.status === 'done' ? 'success' : 'warning'}>{syncStatusText()}</Tag>
          {run.status === 'failed' && <Text className="muted">{t.syncFailedHint}</Text>}
          {run.status === 'done' && <Text className="muted">{t.syncDoneHint}</Text>}
        </View>
        {run.total > 0 && (
          <View className="sync-progress">
            <Progress percent={progress} strokeWidth="8" color="#166534" />
            <Text className="muted">{t.syncProgress} {run.processed}/{run.total} · {t.syncRemaining} {Math.max(run.total - run.processed, 0)}</Text>
          </View>
        )}
        <View className="sync-actions">
          <Button
            className="primary"
            onClick={() => dispatch(runSync())}
            disabled={run.status === 'running' || (run.status === 'done' && counts.pendingSync === 0 && counts.coord === 0)}
          >
            {run.status === 'failed' ? t.retrySync : t.syncNow}
          </Button>
        </View>
        <View className="weak-switch">
          <Text>{t.weakNetwork}</Text>
          <Switch checked={state.weakNetwork} onChange={(v) => dispatch(setWeakNetwork(v))} />
        </View>
        <Button className="secondary" onClick={() => dispatch(simulateStationChange())}>{t.simulateStation}</Button>
        <Text className="hint">{t.ledgerHint}</Text>
      </View>

      {/* 待协调：同一条观察两边都改了，保留两版 */}
      {openCoord.length > 0 && (
        <View className="card">
          <View className="card-title">{t.pendingCoord}<Text className="count">{openCoord.length} 条</Text></View>
          <Text className="hint">{t.coordHint}</Text>
          {openCoord.map((item) => {
            const obs = ownerOf(item.observationId);
            return (
              <View className="coord-item" key={item.id}>
                <Text className="obs-title">{obs?.note ?? item.local.note}</Text>
                <View className="versions">
                  <View className="version local">
                    <Text className="v-label">{t.localVersion}</Text>
                    <Text>{item.local.note}</Text>
                    <Text className="muted">{riskLabel(t, item.local.risk)} · {item.pointIds.length} {t.pointCount}</Text>
                  </View>
                  <View className="version station">
                    <Text className="v-label">{t.stationVersion}</Text>
                    <Text>{item.station.note}</Text>
                    <Text className="muted">{riskLabel(t, item.station.risk)}</Text>
                  </View>
                </View>
                <View className="alert-actions">
                  <Button size="mini" onClick={() => dispatch(resolveCoord({ coordId: item.id, choice: 'local' }))}>{t.keepLocal}</Button>
                  <Button size="mini" onClick={() => dispatch(resolveCoord({ coordId: item.id, choice: 'station' }))}>{t.keepStation}</Button>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* 待重新归属的轨迹点（以站里版本为准后卸下） */}
      {orphanItems.length > 0 && (
        <View className="card">
          <View className="card-title">{t.orphanPoints}</View>
          <Text className="hint">{t.orphanHint}</Text>
          {orphanItems.map((item) =>
            (item.orphanPointIds ?? []).map((pid) => {
              const p = state.points.find((x) => x.id === pid);
              if (!p) return null;
              return (
                <View className="orphan" key={p.id}>
                  <View>
                    <Text className="obs-title">{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}</Text>
                    <Text className="muted">{p.at} · {t.noOwner}</Text>
                  </View>
                  <Button size="mini" onClick={() => dispatch(reattachPoint({ pointId: p.id }))}>{t.reattach}</Button>
                </View>
              );
            })
          )}
        </View>
      )}

      {/* 待复核 */}
      {pendingReview.length > 0 && (
        <View className="card">
          <View className="card-title">{t.pendingReview}<Text className="count">{pendingReview.length} 条</Text></View>
          {pendingReview.map((o) => (
            <View className="review-item" key={o.id}>
              <View>
                <Text className="obs-title">{o.note}</Text>
                <View className="badges">
                  <Tag type={riskTagType[o.risk]}>{riskLabel(t, o.risk)}</Tag>
                  <Tag type="warning">{reviewReason(o)}</Tag>
                </View>
              </View>
              <Button size="mini" disabled={o.sync === 'conflict'} onClick={() => dispatch(reviewObservation(o.id))}>{t.reviewPass}</Button>
            </View>
          ))}
        </View>
      )}

      {/* 观察记录总览 */}
      <View className="card">
        <View className="card-title">{t.observations}<Text className="count">{state.observations.length} 条</Text></View>
        <ScrollView scrollY className="list">
          {state.observations.map((item) => (
            <View className="observation" key={item.id}>
              <View>
                <Text className="obs-title">{item.note}</Text>
                <View className="badges">
                  <Tag type={riskTagType[item.risk]}>{riskLabel(t, item.risk)}</Tag>
                  <Tag type={item.sync === 'synced' ? 'success' : item.sync === 'conflict' ? 'danger' : 'warning'}>{syncLabel(item.sync)}</Tag>
                  <Tag type={item.reviewed ? 'success' : 'default'}>{item.reviewed ? t.reviewed : t.pendingReview}</Tag>
                  {item.pointIds.length > 0 && <Tag type="default">{item.pointIds.length} {t.pointCount}</Tag>}
                </View>
              </View>
              <Button size="mini" onClick={() => setEditing(item)}>{t.edit}</Button>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* 轨迹与样本 */}
      <View className="card">
        <View className="card-title">{t.points}与{t.samples}</View>
        {state.points.slice(-5).map((point) => {
          const owner = ownerOf(point.observationId);
          return (
            <NutCell
              key={point.id}
              title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}
              description={`${point.at} · ${point.source} · ${owner ? owner.note.slice(0, 10) : t.noOwner}${owner && owner.sync === 'conflict' ? `（${t.blockedHint}）` : ''}`}
            />
          );
        })}
        {state.samples.map((sample) => (
          <View className="sample" key={sample.id}>
            <Text>{sample.code} · {sample.species} × {sample.count}</Text>
            <Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>
              {sample.status === 'verified' ? t.reviewed : '核验'}
            </Button>
          </View>
        ))}
      </View>

      <EditDialog obs={editing} onClose={() => setEditing(null)} />
    </View>
  );
}
