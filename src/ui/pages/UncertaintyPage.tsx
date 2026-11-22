import type { AppActions, AppState } from '../useAppState';
import { fmtDateTime, fmtNum } from '../format';
import { BALANCE_METRIC_LABELS, PROCESS_KIND_LABELS } from '../../domain/balance/types';

interface Props {
  state: AppState;
  actions: AppActions;
}

/** 不确定度库：仪表精度、共用校准来源（相关）、可接受调整范围（证书边界）与去除参数台账 */
export function UncertaintyPage({ state }: Props) {
  const { balance } = state;
  const groups = [...new Set(balance.meters.map((m) => m.calGroup))];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>计量仪表不确定度库（{balance.meters.length} 台）</h2>
          <span className="sub">1σ 精度 · 共用校准组（误差相关）· 证书允许调整范围</span>
        </div>
        <div className="card-pad table-wrap">
          {balance.meters.length === 0 ? (
            <div className="empty">尚未装载不确定度库。请在「概览」页装载样例资料。</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>仪表</th>
                  <th>指标</th>
                  <th className="num">1σ 相对</th>
                  <th className="num">1σ 绝对</th>
                  <th>校准组</th>
                  <th className="num">组内相关 ρ</th>
                  <th className="num">允许调整 ±%</th>
                  <th>证书</th>
                  <th>有效期</th>
                </tr>
              </thead>
              <tbody>
                {balance.meters.map((m) => (
                  <tr key={m.meterId}>
                    <td>
                      <strong className="mono">{m.meterId}</strong>
                      <div className="tiny muted">{m.label}；{m.note}</div>
                    </td>
                    <td className="tiny">{BALANCE_METRIC_LABELS[m.metric]}</td>
                    <td className="num">{(m.relSigma * 100).toFixed(2)}%</td>
                    <td className="num">{fmtNum(m.absSigma, 2)}</td>
                    <td className="mono tiny">{m.calGroup}</td>
                    <td className="num">{m.groupCorrelation.toFixed(2)}</td>
                    <td className="num">±{(m.adjustLimitRel * 100).toFixed(1)}%</td>
                    <td className="mono tiny">{m.certificate}</td>
                    <td className="tiny mono">
                      {fmtDateTime(m.validFrom).slice(0, 10)} → {m.validTo ? fmtDateTime(m.validTo).slice(0, 10) : '在役'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card-pad" style={{ paddingTop: 0 }}>
          <div className="note">
            路径 A（误差传播）按 k=2 膨胀 1σ 形成保证不越界的区间；路径 B（受约束测量协调）以 1σ 为权重、
            按校准组构造协方差。任何调整都不得超出「允许调整」证书边界，超出部分保留为不可协调残差。
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
            {groups.map((g) => (
              <span key={g} className="badge neutral">
                {g}：{balance.meters.filter((m) => m.calGroup === g).map((m) => m.meterId).join('、')}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>去除参数台账（{balance.removalParams.length} 项）</h2>
          <span className="sub">COD/氨氮的去除范围只能依据这些登记参数与工艺记录形成</span>
        </div>
        <div className="card-pad table-wrap">
          <table>
            <thead>
              <tr>
                <th>参数</th>
                <th>污染物</th>
                <th>单元</th>
                <th className="num">范围</th>
                <th>单位</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {balance.removalParams.map((p) => (
                <tr key={p.paramId}>
                  <td>
                    <strong>{p.param}</strong>
                    <div className="tiny muted mono">{p.paramId}</div>
                  </td>
                  <td className="tiny">{p.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                  <td className="tiny">{p.unitId ?? '全厂'}</td>
                  <td className="num">
                    {fmtNum(p.low, 3)} – {fmtNum(p.high, 3)}
                  </td>
                  <td className="tiny">{p.unit}</td>
                  <td className="tiny muted">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>工艺记录（{balance.processRecords.length} 条）</h2>
          <span className="sub">曝气 / 污泥排放 / 投药 / 溶解氧 —— 去除范围的唯一依据</span>
        </div>
        <div className="card-pad table-wrap" style={{ maxHeight: 320 }}>
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>单元</th>
                <th>时段</th>
                <th className="num">数值</th>
                <th>单位</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {[...balance.processRecords]
                .sort((a, b) => a.from - b.from || a.kind.localeCompare(b.kind))
                .map((r) => (
                  <tr key={r.recordId}>
                    <td>
                      <span className="badge neutral">{PROCESS_KIND_LABELS[r.kind]}</span>
                    </td>
                    <td className="tiny">{r.unitId}</td>
                    <td className="tiny mono">
                      {fmtDateTime(r.from).slice(11, 16)} → {fmtDateTime(r.to).slice(11, 16)}
                    </td>
                    <td className="num">{fmtNum(r.value, 2)}</td>
                    <td className="tiny">{r.unit}</td>
                    <td className="tiny muted">{r.note}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
