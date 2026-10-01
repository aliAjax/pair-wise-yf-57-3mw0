import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import { addObservation, addPoint, addSample, resolveConflict, reviewObservation, syncQueue, verifySample, type RootState } from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;
export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };
  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后统一同步；负责人只复核有风险的记录。</Text></View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>
    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>
    {state.conflict && <View className="alert conflict"><Text>{state.conflict}</Text><View className="alert-actions"><Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button><Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button></View></View>}
    <View className="card"><View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View><Button className="secondary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button><Text className="hint">同步遇到同一记录修改时，将进入冲突列表，不会覆盖整批数据。</Text></View>
    <View className="card"><View className="card-title">观察记录</View><ScrollView scrollY className="list">{state.observations.map((item) => <View className="observation" key={item.id}><View><Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text><Text className="muted">{item.time} · {item.sync}</Text></View><Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button></View>)}</ScrollView></View>
    <View className="card"><View className="card-title">轨迹与样本</View>{state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />)}{state.samples.map((sample) => <View className="sample" key={sample.id}><Text>{sample.code} · {sample.species} × {sample.count}</Text><Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}</View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
  </View>;
}
