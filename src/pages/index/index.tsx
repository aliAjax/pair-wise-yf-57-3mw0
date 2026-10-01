import { useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addSample, attachPoint, editObservation, reviewStation,
  resolveConflict, selectors, synchronize, verifySample,
  type AppDispatch, type LocalObservation, type ReconcileItem, type Risk, type RootState,
  type StationObservation
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const riskLabel: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
const syncLabel: Record<LocalObservation['sync'], string> = { queued: '待同步', synced: '已同步', conflict: '待协调' };

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: RootState) => root.patrol);
  const { world, progress } = state;
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });
  const [targetObservation, setTargetObservation] = useState(world.observations[0]?.id ?? '');
  const pendingReconcile = useSelector(selectors.pendingReconcile);
  const pendingReview = useSelector(selectors.pendingReview);
  const notSynced = useSelector(selectors.notSynced);

  const recordPoint = async () => {
    const observationId = targetObservation || world.observations[0]?.id;
    if (!observationId) { Taro.showToast({ title: '先建一条观察', icon: 'none' }); return; }
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(attachPoint({ observationId, latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(attachPoint({ observationId, latitude: 30.5 + Math.random() * 0.02, longitude: 103.2 + Math.random() * 0.02 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">断网时逐条记录，回网后按观察合并进站，轨迹点随观察对上，两边同改则两版并留待协调。</Text>
    </View>

    <View className="metrics">
      <View className={pendingReconcile ? 'metric-card hot' : 'metric-card'}>
        <Text>待协调</Text><Text className="metric">{pendingReconcile}</Text>
      </View>
      <View className={pendingReview ? 'metric-card hot' : 'metric-card'}>
        <Text>待复核</Text><Text className="metric">{pendingReview}</Text>
      </View>
      <View className={notSynced ? 'metric-card warn' : 'metric-card'}>
        <Text>没同步完</Text><Text className="metric">{notSynced}</Text>
      </View>
    </View>

    <View className="card">
      <View className="card-title">现场记录</View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="物种或样本名称" {...register('species')} />
          <Input className="input" type="number" placeholder="数量" {...register('count')} />
        </View>
        <View className="risk">
          <Text>风险等级</Text>
          <select {...register('risk')}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </View>
        <Button className="primary" formType="submit">{t.save}</Button>
      </form>
      <View className="point-row">
        <select value={targetObservation} onChange={(event) => setTargetObservation(event.target.value)}>
          {world.observations.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.note.slice(0, 10)}</option>)}
        </select>
        <Button className="secondary" onClick={recordPoint}>记录轨迹点并挂到该观察</Button>
      </View>
    </View>

    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{notSynced} 条未完成</Text></View>
      <View className="two">
        <Button className="primary" disabled={progress.running || notSynced === 0} onClick={() => void dispatch(synchronize(false))}>
          {progress.running ? `同步中 ${progress.done}/${progress.total}` : '恢复联网·逐条同步'}
        </Button>
        <Button className="secondary" disabled={progress.running} onClick={() => void dispatch(synchronize(true))}>模拟断网失败</Button>
      </View>
      {world.syncError && <View className="alert conflict"><Text>{world.syncError}</Text></View>}
      <Text className="hint">同步按条入库并立即落盘：失败重试只补没做完的部分，应用被系统回收重开也能接着，已入库记录不重复写入；两边同时改过的观察不会被覆盖，进下方待协调。</Text>
    </View>

    {world.reconciliations.length > 0 && <View className="card">
      <View className="card-title">待协调<Text className="count hot-text">{pendingReconcile} 条待处理</Text></View>
      <ScrollView scrollY className="list">
        {world.reconciliations.map((item) => <ReconcileRow key={item.id} item={item} onResolve={(choice) => dispatch(resolveConflict({ id: item.id, choice }))} />)}
      </ScrollView>
    </View>}

    <View className="card">
      <View className="card-title">巡护员观察（本地）<Text className="count">{world.observations.length} 条</Text></View>
      <ScrollView scrollY className="list">
        {world.observations.map((item) => <ObservationRow key={item.id} item={item} points={world.points.filter((p) => p.observationId === item.id)} onSave={(patch) => dispatch(editObservation({ id: item.id, ...patch }))} />)}
      </ScrollView>
    </View>

    <View className="card">
      <View className="card-title">站点复核记录<Text className="count hot-text">{pendingReview} 条待复核</Text></View>
      <ScrollView scrollY className="list">
        {world.station.map((item) => <StationRow key={item.id} item={item} onReview={(comment) => dispatch(reviewStation({ id: item.id, comment }))} />)}
      </ScrollView>
    </View>

    <View className="card">
      <View className="card-title">轨迹点与样本</View>
      {world.points.map((point) => <NutCell key={point.id}
        title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}
        description={`挂于 ${point.observationId} · ${point.at} · ${point.source} · ${point.sync === 'synced' ? '已进站' : '待同步'}`} />)}
      {world.samples.map((sample) => <View className="sample" key={sample.id}>
        <Text>{sample.code} · {sample.species} × {sample.count}</Text>
        <Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>
          {sample.status === 'verified' ? '已核验' : '核验'}
        </Button>
      </View>)}
    </View>
  </View>;
}

function ReconcileRow({ item, onResolve }: { item: ReconcileItem; onResolve: (choice: 'local' | 'remote') => void }) {
  const resolved = item.status !== 'pending';
  return <View className={`reconcile ${resolved ? 'resolved' : ''}`}>
    <View className="reconcile-versions">
      <View className="version local-ver">
        <Text className="ver-tag">巡护员版</Text>
        <Text>{item.local.note}</Text>
        <Text className="muted">{item.local.time} · 风险{riskLabel[item.local.risk]} · 轨迹点 {item.local.pointIds.join('、') || '无'}</Text>
      </View>
      <View className="version remote-ver">
        <Text className="ver-tag">站里版</Text>
        <Text>{item.remote.note}</Text>
        <Text className="muted">{item.remote.time} · 风险{riskLabel[item.remote.risk]}{item.remote.comment ? ` · 复核：${item.remote.comment}` : ''} · 轨迹点 {item.remote.pointIds.join('、') || '无'}</Text>
      </View>
    </View>
    {resolved
      ? <Text className="hint">已按{item.status === 'resolved-local' ? '巡护员版' : '站里版'}合并入库
          {item.reattachedPointIds && item.reattachedPointIds.length > 0 ? `；重新归属的轨迹点：${item.reattachedPointIds.join('、')}` : ''}
          {item.reattachedPointIds && item.reattachedPointIds.length === 0 && item.status === 'resolved-remote' ? '；该观察下没有需要重新归属的轨迹点' : ''}
        </Text>
      : <View className="alert-actions">
          <Button size="mini" onClick={() => onResolve('local')}>保留巡护员版（站里点仍挂该观察）</Button>
          <Button size="mini" onClick={() => onResolve('remote')}>以站里版为准（轨迹点重新归属并列出）</Button>
        </View>}
  </View>;
}

function ObservationRow({ item, points, onSave }: {
  item: LocalObservation;
  points: { id: string; sync: 'queued' | 'synced' | 'conflict' }[];
  onSave: (patch: { note: string; risk: Risk }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.note);
  const [risk, setRisk] = useState<Risk>(item.risk);
  return <View className="observation">
    <View className="obs-body">
      <Text className="obs-title">{item.note}</Text>
      <Text className="muted">{item.id} · {item.time} · 风险{riskLabel[item.risk]} · 版本 r{item.localRev}/站 r{item.stationRev} · {syncLabel[item.sync]}</Text>
      <Text className="muted">轨迹点 {points.length} 个：{points.map((p) => `${p.id}(${p.sync === 'synced' ? '已进站' : '待传'})`).join('、') || '无'}</Text>
      {editing && <View className="inline-edit">
        <Textarea className="textarea" value={note} onInput={(event) => setNote(event.detail.value)} />
        <View className="risk">
          <Text>风险等级</Text>
          <select value={risk} onChange={(event) => setRisk(event.target.value as Risk)}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </View>
        <Button size="mini" className="primary" onClick={() => { onSave({ note, risk }); setEditing(false); }}>保存离线修改</Button>
      </View>}
    </View>
    <Button size="mini" disabled={editing} onClick={() => { setNote(item.note); setRisk(item.risk); setEditing(true); }}>离线修改</Button>
  </View>;
}

function StationRow({ item, onReview }: { item: StationObservation; onReview: (comment: string) => void }) {
  const [comment, setComment] = useState('');
  const review = item.review;
  return <View className="observation">
    <View className="obs-body">
      <Text className="obs-title">{item.note}</Text>
      <Text className="muted">{item.id} · {item.time} · 风险{riskLabel[item.risk]} · 版本 r{item.rev} · 轨迹点 {item.points.length} 个</Text>
      {review?.status === 'active' && <Text className="badge ok">已复核：{review.comment}（{review.reviewedAt}）</Text>}
      {review?.status === 'invalidated' && <Text className="badge bad">复核已失效（正文/风险被改动）· {review.comment} · 退回待复核</Text>}
      {!review && <Text className="badge">待复核</Text>}
      <View className="review-row">
        <Input className="input" placeholder="复核结论，如：证据充分，维持中风险" value={comment} onInput={(event) => setComment(event.detail.value)} />
        <Button size="mini" disabled={!comment} onClick={() => { onReview(comment); setComment(''); }}>提交复核</Button>
      </View>
    </View>
  </View>;
}
