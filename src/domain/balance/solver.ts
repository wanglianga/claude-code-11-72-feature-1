/**
 * 平衡求解器（路径 A：误差传播 + 路径 B：受约束测量协调的装配）
 *
 * 装配顺序：
 * 1. 边界登记快照：支路按有效期取舍（停用支路只影响生效日之后）；
 * 2. 支路总量：流量体积与浓度×流量负荷，缺测段用登记估计并单独标注；
 * 3. 滞后匹配：进出水事件的可达配对与在途量；
 * 4. 闭合：水量闭合、示踪闭合（守恒项），COD/氨氮观测去除（可去除项）；
 * 5. 去除范围：仅依据工艺记录；不可解释残差保留；
 * 6. 协调：仅水量与示踪量进入受约束测量协调。
 */

import type { LoadBounds } from '../types';
import { dayEndMs, dayStartMs } from '../time';
import type {
  AttributionCause,
  BalanceData,
  BalanceMetric,
  BalanceResult,
  BoundaryStream,
  ClosureResult,
  ClosureTerm,
  LagEvent,
  MeterSpec,
  PlantBalance,
  ReconcileResult,
  StreamReading,
  StreamTotal,
  UnitClosure,
} from './types';
import { BALANCE_METRIC_LABELS, REMOVABLE_METRICS, STREAM_KIND_LABELS } from './types';
import { inTransitLoad, matchLag, type Knot } from './lag';
import { supportedRemoval, unexplainedResidual } from './removal';
import { reconcile, type ReconcileConstraintInput, type ReconcileVariable } from './reconcile';

export interface BalanceOptions {
  /** 区间膨胀系数（默认 2） */
  k?: number;
}

interface MeterSeries {
  meter: MeterSpec;
  knots: Knot[];
  readings: StreamReading[];
  nominalMs: number;
  gapMs: number;
  gaps: { from: number; to: number }[];
}

const NOMINAL_DEFAULT_MS = 300_000;

function add(a: LoadBounds, b: LoadBounds): LoadBounds {
  return { min: a.min + b.min, best: a.best + b.best, max: a.max + b.max };
}

function sub(a: LoadBounds, b: LoadBounds): LoadBounds {
  return { min: a.min - b.max, best: a.best - b.best, max: a.max - b.min };
}

function scale(b: LoadBounds, f: number): LoadBounds {
  return f >= 0 ? { min: b.min * f, best: b.best * f, max: b.max * f } : { min: b.max * f, best: b.best * f, max: b.min * f };
}

function mulPositive(a: LoadBounds, b: LoadBounds): LoadBounds {
  const lo = Math.min(a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max);
  const hi = Math.max(a.min * b.min, a.max * b.max, a.max * b.min, a.min * b.max);
  return { min: lo, best: a.best * b.best, max: hi };
}

function around(best: number, halfWidth: number): LoadBounds {
  const hw = Math.max(0, halfWidth);
  return { min: best - hw, best, max: best + hw };
}

/** 由某支路某仪表的读数构造序列（窗口内），并识别缺测段 */
function buildSeries(
  meter: MeterSpec,
  readings: StreamReading[],
  windowFrom: number,
  windowTo: number,
): MeterSeries {
  const sorted = readings
    .filter((r) => r.qualityFlag !== 'INVALID' && r.sampledAt >= windowFrom && r.sampledAt < windowTo)
    .sort((a, b) => a.sampledAt - b.sampledAt || a.readingId.localeCompare(b.readingId));
  let nominalMs = NOMINAL_DEFAULT_MS;
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i].sampledAt - sorted[i - 1].sampledAt;
    if (dt > 0) {
      nominalMs = dt;
      break;
    }
  }
  const gapMs = nominalMs * 2.5;
  const knots: Knot[] = sorted.map((r) => ({ at: r.sampledAt, value: r.rawValue }));
  const gaps: { from: number; to: number }[] = [];
  if (knots.length === 0) {
    gaps.push({ from: windowFrom, to: windowTo });
  } else {
    for (let i = 1; i < knots.length; i += 1) {
      if (knots[i].at - knots[i - 1].at > gapMs) gaps.push({ from: knots[i - 1].at, to: knots[i].at });
    }
    if (knots[0].at - windowFrom > gapMs) gaps.unshift({ from: windowFrom, to: knots[0].at });
    if (windowTo - knots[knots.length - 1].at > gapMs) gaps.push({ from: knots[knots.length - 1].at, to: windowTo });
  }
  return { meter, knots, readings: sorted, nominalMs, gapMs, gaps };
}

function valueAt(knots: Knot[], t: number, holdMs: number): number | null {
  if (knots.length === 0) return null;
  if (t <= knots[0].at) return knots[0].at - t <= holdMs ? knots[0].value : null;
  const last = knots[knots.length - 1];
  if (t >= last.at) return t - last.at <= holdMs ? last.value : null;
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].at <= t) lo = mid;
    else hi = mid;
  }
  const span = knots[hi].at - knots[lo].at;
  if (span <= 0) return knots[hi].value;
  return knots[lo].value + ((knots[hi].value - knots[lo].value) * (t - knots[lo].at)) / span;
}

/** 流量体积积分：梯形；缺测段用登记估计（m³/h），单独标注 */
function integrateFlow(
  series: MeterSeries,
  stream: BoundaryStream,
  windowFrom: number,
  windowTo: number,
  k: number,
): { volume: LoadBounds; gapSeconds: number; measuredSeconds: number; note: string } {
  const { knots, nominalMs } = series;
  let measured = 0;
  let measuredMs = 0;
  const hold = nominalMs;
  const cuts = new Set<number>([windowFrom, windowTo]);
  for (const kk of knots) if (kk.at > windowFrom && kk.at < windowTo) cuts.add(kk.at);
  for (const g of series.gaps) {
    cuts.add(Math.max(g.from, windowFrom));
    cuts.add(Math.min(g.to, windowTo));
  }
  const sortedCuts = [...cuts].filter((t) => t >= windowFrom && t <= windowTo).sort((a, b) => a - b);
  for (let i = 1; i < sortedCuts.length; i += 1) {
    const a = sortedCuts[i - 1];
    const b = sortedCuts[i];
    const inGap = series.gaps.some((g) => a >= g.from - 1 && b <= g.to + 1);
    if (inGap) continue;
    const v0 = valueAt(knots, a, hold);
    const v1 = valueAt(knots, b, hold);
    if (v0 === null || v1 === null) continue;
    measured += ((v0 + v1) / 2) * ((b - a) / 3_600_000);
    measuredMs += b - a;
  }
  const sigma = series.meter.relSigma * Math.abs(measured) + series.meter.absSigma;
  const measuredBounds = around(measured, k * sigma);
  let gapSeconds = 0;
  let gapLow = 0;
  let gapHigh = 0;
  for (const g of series.gaps) {
    const a = Math.max(g.from, windowFrom);
    const b = Math.min(g.to, windowTo);
    if (b <= a) continue;
    const hours = (b - a) / 3_600_000;
    gapSeconds += (b - a) / 1000;
    gapLow += stream.gapFlowLowM3h * hours;
    gapHigh += stream.gapFlowHighM3h * hours;
  }
  const volume = add(measuredBounds, { min: gapLow, best: (gapLow + gapHigh) / 2, max: gapHigh });
  const note =
    gapSeconds > 0
      ? `缺测 ${(gapSeconds / 60).toFixed(0)} min，按登记估计 ${stream.gapFlowLowM3h}–${stream.gapFlowHighM3h} m³/h 补入区间`
      : '全程有计量';
  return { volume, gapSeconds, measuredSeconds: measuredMs / 1000, note };
}

/** 浓度×流量负荷积分（kg）：∫c·q dt，c、q 分段线性；缺测段用登记估计区间 */
function integrateLoad(
  conc: MeterSeries,
  flow: MeterSeries | null,
  stream: BoundaryStream,
  windowFrom: number,
  windowTo: number,
  k: number,
  flowVolume: LoadBounds,
): { load: LoadBounds; meanConc: LoadBounds | null; gapSeconds: number; note: string } {
  if (!flow) {
    return { load: { min: 0, best: 0, max: 0 }, meanConc: null, gapSeconds: 0, note: '无流量计，未形成负荷' };
  }
  const hold = Math.max(conc.nominalMs, flow.nominalMs);
  const cuts = new Set<number>([windowFrom, windowTo]);
  for (const kk of conc.knots) cuts.add(kk.at);
  for (const kk of flow.knots) cuts.add(kk.at);
  const allGaps = [...conc.gaps, ...flow.gaps];
  for (const g of allGaps) {
    cuts.add(Math.max(g.from, windowFrom));
    cuts.add(Math.min(g.to, windowTo));
  }
  const sortedCuts = [...cuts].filter((t) => t >= windowFrom && t <= windowTo).sort((a, b) => a - b);
  let measured = 0;
  let gapSeconds = 0;
  let gapLoadLow = 0;
  let gapLoadHigh = 0;
  for (let i = 1; i < sortedCuts.length; i += 1) {
    const a = sortedCuts[i - 1];
    const b = sortedCuts[i];
    if (b - a <= 0) continue;
    const inGap = allGaps.some((g) => a >= g.from - 1 && b <= g.to + 1);
    if (inGap) {
      const hours = (b - a) / 3_600_000;
      gapSeconds += (b - a) / 1000;
      gapLoadLow += (stream.gapFlowLowM3h * hours * stream.gapConcLowMgL[conc.meter.metric as 'TRACER' | 'COD' | 'NH3N']) / 1000;
      gapLoadHigh += (stream.gapFlowHighM3h * hours * stream.gapConcHighMgL[conc.meter.metric as 'TRACER' | 'COD' | 'NH3N']) / 1000;
      continue;
    }
    const c0 = valueAt(conc.knots, a, hold);
    const c1 = valueAt(conc.knots, b, hold);
    const q0 = valueAt(flow.knots, a, hold);
    const q1 = valueAt(flow.knots, b, hold);
    if (c0 === null || c1 === null || q0 === null || q1 === null) continue;
    // ∫c·q dt（分段线性）＝ (c̄q̄ + ΔcΔq/12)·Δt；mg/L × m³/h × h ÷ 1000 = kg
    const cMean = (c0 + c1) / 2;
    const qMean = (q0 + q1) / 2;
    measured += (cMean * qMean + ((c1 - c0) * (q1 - q0)) / 12) * ((b - a) / 3_600_000) / 1000;
  }
  const rel = Math.sqrt(conc.meter.relSigma ** 2 + flow.meter.relSigma ** 2);
  const meanC = flowVolume.best > 1e-9 ? (measured / flowVolume.best) * 1000 : 0;
  const sigma =
    rel * Math.abs(measured) +
    (conc.meter.absSigma * Math.abs(flowVolume.best)) / 1000 +
    (flow.meter.absSigma * meanC) / 1000;
  const measuredBounds = around(measured, k * sigma);
  const load = add(measuredBounds, { min: gapLoadLow, best: (gapLoadLow + gapLoadHigh) / 2, max: gapLoadHigh });
  const meanConc =
    flowVolume.best > 1e-9
      ? {
          min: (load.min / Math.max(flowVolume.max, 1e-9)) * 1000,
          best: (load.best / flowVolume.best) * 1000,
          max: (load.max / Math.max(flowVolume.min, 1e-9)) * 1000,
        }
      : null;
  const note =
    gapSeconds > 0
      ? `缺测 ${(gapSeconds / 60).toFixed(0)} min，负荷按登记估计浓度 ${stream.gapConcLowMgL[conc.meter.metric as 'TRACER' | 'COD' | 'NH3N']}–${stream.gapConcHighMgL[conc.meter.metric as 'TRACER' | 'COD' | 'NH3N']} mg/L 补入区间`
      : '全程有计量';
  return { load, meanConc, gapSeconds, note };
}

function closureOf(terms: ClosureTerm[], note: string): ClosureResult {
  let residual: LoadBounds = { min: 0, best: 0, max: 0 };
  for (const t of terms) residual = t.sign === 1 ? add(residual, t.amount) : sub(residual, t.amount);
  return { residual, closes: residual.min <= 0 && residual.max >= 0, terms, note };
}

export function computeBalance(data: BalanceData, plantId: string, day: string, options: BalanceOptions = {}): BalanceResult {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const k = options.k ?? 2;
  const dayFrom = dayStartMs(day);
  const dayTo = dayEndMs(day);
  const caveats: string[] = [];

  const units = data.units.filter((u) => u.plantId === plantId);
  if (units.length === 0) throw new Error(`厂站 ${plantId} 没有工艺单元登记`);
  const lagMinMs = units.reduce((a, u) => a + u.lagMinMinutes, 0) * 60_000;
  const lagMaxMs = units.reduce((a, u) => a + u.lagMaxMinutes, 0) * 60_000;

  // 支路按有效期取舍：停用支路只影响生效日之后，不改写本窗口
  const activeStreams = data.streams.filter(
    (s) => s.plantId === plantId && s.effectiveFrom < dayTo && (s.effectiveTo === null || s.effectiveTo > dayFrom),
  );
  for (const s of data.streams) {
    if (s.plantId === plantId && s.effectiveTo !== null && s.effectiveTo > dayTo) {
      const toDay = new Date(s.effectiveTo + 8 * 3_600_000).toISOString().slice(0, 10);
      const regDay = new Date(s.registeredAt + 8 * 3_600_000).toISOString().slice(0, 10);
      caveats.push(`支路 ${s.streamId} 将于 ${toDay} 停用（${regDay} 登记确认）；本日平衡仍按其有效登记计算，历史分析不被改写。`);
    }
  }

  const meterById = new Map(data.meters.map((m) => [m.meterId, m]));
  const readingsByStreamMeter = new Map<string, StreamReading[]>();
  for (const r of data.readings) {
    const key = `${r.streamId}|${r.meterId}`;
    const arr = readingsByStreamMeter.get(key) ?? [];
    arr.push(r);
    readingsByStreamMeter.set(key, arr);
  }
  const seriesFor = (streamId: string, meterId: string, from: number, to: number): MeterSeries => {
    const meter = meterById.get(meterId);
    if (!meter) throw new Error(`计量仪表 ${meterId} 未在不确定度库登记`);
    return buildSeries(meter, readingsByStreamMeter.get(`${streamId}|${meterId}`) ?? [], from, to);
  };

  // ---- 支路总量（按支路有效期裁剪窗口）----
  const streamTotals: StreamTotal[] = [];
  const volumeByStream = new Map<string, LoadBounds>();
  const flowSeriesByStream = new Map<string, MeterSeries>();
  for (const stream of activeStreams) {
    const sFrom = Math.max(dayFrom, stream.effectiveFrom);
    const sTo = Math.min(dayTo, stream.effectiveTo ?? dayTo);
    let volume: LoadBounds = { min: 0, best: 0, max: 0 };
    let flowSeries: MeterSeries | null = null;
    if (stream.flowMeterId) {
      flowSeries = seriesFor(stream.streamId, stream.flowMeterId, sFrom, sTo);
      const v = integrateFlow(flowSeries, stream, sFrom, sTo, k);
      volume = v.volume;
      flowSeriesByStream.set(stream.streamId, flowSeries);
      streamTotals.push({
        streamId: stream.streamId,
        metric: 'FLOW',
        total: volume,
        meanConcentration: null,
        seconds: v.measuredSeconds,
        readingCount: flowSeries.readings.length,
        gapSeconds: v.gapSeconds,
        sourceReadingIds: flowSeries.readings.map((r) => r.readingId),
        sourceFileIds: [...new Set(flowSeries.readings.map((r) => r.sourceFileId))],
        note: v.note,
      });
    }
    volumeByStream.set(stream.streamId, volume);
    for (const meter of data.meters.filter((m) => m.metric !== 'FLOW')) {
      const key = `${stream.streamId}|${meter.meterId}`;
      if (!readingsByStreamMeter.has(key)) continue;
      const concSeries = seriesFor(stream.streamId, meter.meterId, sFrom, sTo);
      const { load, meanConc, gapSeconds, note } = integrateLoad(concSeries, flowSeries, stream, sFrom, sTo, k, volume);
      streamTotals.push({
        streamId: stream.streamId,
        metric: meter.metric,
        total: load,
        meanConcentration: meanConc,
        seconds: concSeries.readings.length * (concSeries.nominalMs / 1000),
        readingCount: concSeries.readings.length,
        gapSeconds,
        sourceReadingIds: concSeries.readings.map((r) => r.readingId),
        sourceFileIds: [...new Set(concSeries.readings.map((r) => r.sourceFileId))],
        note,
      });
    }
  }

  // ---- 存量变化 ΔV ----
  const unitClosures: UnitClosure[] = [];
  const storageByUnit = new Map<string, LoadBounds>();
  for (const unit of units) {
    const levelMeter = data.meters.find((m) => m.meterId === `L-${unit.unitId}`);
    const records = data.levels
      .filter((l) => l.unitId === unit.unitId && l.at >= dayFrom && l.at <= dayTo)
      .sort((a, b) => a.at - b.at);
    if (!levelMeter || records.length < 2) {
      storageByUnit.set(unit.unitId, { min: 0, best: 0, max: 0 });
      unitClosures.push({
        unitId: unit.unitId,
        name: unit.name,
        storageDeltaV: null,
        levelEvidence: records.length > 0 ? '液位记录不足' : '无液位计，存量变化按 0 处理并披露',
        derivedOutflow: null,
        notes: ['缺少液位记录，单元存量变化未量化（已计入注意事项）'],
      });
      if (!levelMeter) caveats.push(`单元 ${unit.name} 无液位计，其存量变化按 0 处理（可能拉宽闭合区间）。`);
      continue;
    }
    const dLevel = records[records.length - 1].levelM - records[0].levelM;
    const dV = dLevel * unit.surfaceAreaM2;
    const sigma = levelMeter.absSigma;
    const bounds = around(dV, k * sigma);
    storageByUnit.set(unit.unitId, bounds);
    const peak = Math.max(...records.map((r) => r.levelM));
    const trough = Math.min(...records.map((r) => r.levelM));
    unitClosures.push({
      unitId: unit.unitId,
      name: unit.name,
      storageDeltaV: bounds,
      levelEvidence: `液位 ${records[0].levelM.toFixed(2)} → ${records[records.length - 1].levelM.toFixed(2)} m（日内 ${trough.toFixed(2)}–${peak.toFixed(2)}），面积 ${unit.surfaceAreaM2} m²`,
      derivedOutflow: null,
      notes: [`ΔV = ${dV >= 0 ? '+' : ''}${dV.toFixed(1)} m³（±${(k * sigma).toFixed(1)}）`],
    });
  }
  const storageTotal = [...storageByUnit.values()].reduce(add, { min: 0, best: 0, max: 0 });

  // ---- 水量闭合 ----
  const inStreams = activeStreams.filter((s) => s.kind === 'IN' && !s.internal);
  const outStreams = activeStreams.filter((s) => s.kind === 'OUT' && !s.internal);
  const sludgeStreams = activeStreams.filter((s) => s.kind === 'SLUDGE');
  const backwashStreams = activeStreams.filter((s) => s.kind === 'BACKWASH');
  const returnStreams = activeStreams.filter((s) => s.kind === 'RETURN');
  const waterTerms: ClosureTerm[] = [];
  for (const s of inStreams)
    waterTerms.push({ label: `${STREAM_KIND_LABELS[s.kind]} ${s.streamId}`, streamId: s.streamId, sign: 1, amount: volumeByStream.get(s.streamId)!, basis: '实测+缺测登记估计' });
  for (const s of [...outStreams, ...sludgeStreams, ...backwashStreams])
    waterTerms.push({ label: `${STREAM_KIND_LABELS[s.kind]} ${s.streamId}`, streamId: s.streamId, sign: -1, amount: volumeByStream.get(s.streamId)!, basis: '实测+缺测登记估计' });
  waterTerms.push({ label: '池内存量变化 ΔV', streamId: null, sign: -1, amount: storageTotal, basis: '液位×面积' });
  const water = closureOf(
    waterTerms,
    returnStreams.length > 0
      ? `回流 ${returnStreams.map((s) => s.streamId).join('、')} 为内部循环，已从主线闭合拆出（切换事件拆腿）。`
      : '回流支路未登记。',
  );

  // ---- 滞后匹配与在途量 ----
  const lagEvents: LagEvent[] = [];
  const inTransit: PlantBalance['inTransit'] = [];
  const inStream = inStreams[0];
  const outStream = outStreams[0];
  if (inStream && outStream) {
    const pairs: { metric: BalanceMetric; inMeter: string | null; outMeter: string | null }[] = [
      { metric: 'FLOW', inMeter: inStream.flowMeterId, outMeter: outStream.flowMeterId },
      { metric: 'TRACER', inMeter: findConcMeter(data, inStream, 'TRACER'), outMeter: findConcMeter(data, outStream, 'TRACER') },
      { metric: 'COD', inMeter: findConcMeter(data, inStream, 'COD'), outMeter: findConcMeter(data, outStream, 'COD') },
    ];
    for (const pair of pairs) {
      if (!pair.inMeter || !pair.outMeter) continue;
      const inS = seriesFor(inStream.streamId, pair.inMeter, dayFrom, dayTo);
      const outS = seriesFor(outStream.streamId, pair.outMeter, dayFrom, dayTo);
      const pending: string[] = [];
      let transit: LoadBounds | null = null;
      if (pair.metric !== 'FLOW') {
        const flowS = flowSeriesByStream.get(inStream.streamId);
        if (flowS) {
          const slots: { from: number; load: number }[] = [];
          const slotMs = 30 * 60_000;
          for (let from = dayFrom; from < dayTo; from += slotMs) {
            const to = Math.min(from + slotMs, dayTo);
            const mid = (from + to) / 2;
            const c = valueAt(inS.knots, mid, inS.nominalMs);
            const q = valueAt(flowS.knots, mid, flowS.nominalMs);
            if (c === null || q === null) continue;
            slots.push({ from, load: (c * q * ((to - from) / 3_600_000)) / 1000 });
          }
          transit = inTransitLoad(slots, dayTo, lagMinMs, lagMaxMs);
        }
      }
      const matched = matchLag(
        { metric: pair.metric, inSeries: inS.knots, outSeries: outS.knots, windowFrom: dayFrom, windowTo: dayTo, lagMinMs, lagMaxMs },
        transit,
        pending,
      );
      lagEvents.push(...matched.events);
      if (matched.inTransit) {
        matched.inTransit.note = `窗口末端仍有负荷在途（可达时间带 ${(lagMinMs / 60000).toFixed(0)}–${(lagMaxMs / 60000).toFixed(0)} min）；前一日在途未知，已披露。`;
        inTransit.push(matched.inTransit);
      }
    }
  }
  caveats.push('前一日在途量无数据，按 0 处理并披露；若前一日同时段有冲击，本日闭合区间会偏窄。');

  // ---- 示踪闭合 ----
  const concOf = (stream: BoundaryStream | undefined, metric: BalanceMetric): StreamTotal | undefined =>
    stream ? streamTotals.find((t) => t.streamId === stream.streamId && t.metric === metric) : undefined;
  const tankConc = (metric: BalanceMetric): LoadBounds => {
    const inT = concOf(inStream, metric)?.meanConcentration;
    const outT = concOf(outStream, metric)?.meanConcentration;
    if (!inT || !outT) return { min: 0, best: 0, max: 0 };
    return { min: Math.min(outT.min, inT.min), best: (inT.best + outT.best) / 2, max: Math.max(outT.max, inT.max) };
  };
  const tracerStored = scale(mulPositive(storageTotal, tankConc('TRACER')), 1 / 1000);
  const tracerTerms: ClosureTerm[] = [];
  if (inStream && concOf(inStream, 'TRACER'))
    tracerTerms.push({ label: `进水示踪 ${inStream.streamId}`, streamId: inStream.streamId, sign: 1, amount: concOf(inStream, 'TRACER')!.total, basis: '浓度×流量积分' });
  if (outStream && concOf(outStream, 'TRACER'))
    tracerTerms.push({ label: `出水示踪 ${outStream.streamId}`, streamId: outStream.streamId, sign: -1, amount: concOf(outStream, 'TRACER')!.total, basis: '浓度×流量积分' });
  for (const s of backwashStreams) {
    const t = concOf(s, 'TRACER');
    if (t) tracerTerms.push({ label: `反冲洗示踪 ${s.streamId}`, streamId: s.streamId, sign: -1, amount: t.total, basis: '浓度×流量积分（缺测段登记估计）' });
  }
  // 排泥带走的示踪量（派生项：排泥体积 × 池浓度区间）
  let sludgeTracer: LoadBounds = { min: 0, best: 0, max: 0 };
  for (const s of sludgeStreams) {
    const v = volumeByStream.get(s.streamId);
    if (v && v.best > 0) {
      const derived = scale(mulPositive(v, tankConc('TRACER')), 1 / 1000);
      sludgeTracer = add(sludgeTracer, derived);
      tracerTerms.push({ label: `排泥示踪 ${s.streamId}（派生）`, streamId: s.streamId, sign: -1, amount: derived, basis: '排泥体积 × 池浓度区间（派生项）' });
    }
  }
  tracerTerms.push({ label: '存量示踪变化', streamId: null, sign: -1, amount: tracerStored, basis: 'ΔV × 池浓度区间' });
  const tracer = closureOf(tracerTerms, '无反应示踪量守恒：残差不为 0 即存在未登记水量或测量偏差。');

  // ---- COD / 氨氮：观测去除与去除范围 ----
  const removal: PlantBalance['removal'] = [];
  for (const pollutant of REMOVABLE_METRICS) {
    const inT = concOf(inStream, pollutant)?.total ?? { min: 0, best: 0, max: 0 };
    const outT = concOf(outStream, pollutant)?.total ?? { min: 0, best: 0, max: 0 };
    const bwT = backwashStreams.reduce<LoadBounds>(
      (acc, s) => add(acc, concOf(s, pollutant)?.total ?? { min: 0, best: 0, max: 0 }),
      { min: 0, best: 0, max: 0 },
    );
    const stored = scale(mulPositive(storageTotal, tankConc(pollutant)), 1 / 1000);
    const observed = sub(sub(sub(inT, outT), bwT), stored);
    const sup = supportedRemoval(data, pollutant, dayFrom, dayTo);
    const unexplained = unexplainedResidual(observed, sup.supported);
    removal.push({
      pollutant,
      observed,
      supported: sup.supported,
      contributions: sup.contributions,
      unexplained,
      note:
        unexplained.min !== 0 || unexplained.max !== 0
          ? `观测去除超出工艺记录支持范围，${BALANCE_METRIC_LABELS[pollutant]} 保留不可解释残差（不得调成测量误差）。`
          : '观测去除落在工艺记录支持范围内。',
    });
    caveats.push(...sup.notes);
  }

  // ---- 路径 B：受约束测量协调（仅水量与示踪量）----
  const reconcileResult = buildReconciliation(
    data,
    inStream,
    outStream,
    sludgeStreams,
    backwashStreams,
    streamTotals,
    volumeByStream,
    storageByUnit,
    add(tracerStored, sludgeTracer),
  );

  // ---- 归因候选 ----
  const suggestedCauses: { cause: AttributionCause; evidence: string }[] = [];
  const qIn = inStream ? volumeByStream.get(inStream.streamId)! : { min: 0, best: 0, max: 0 };
  if (Math.abs(storageTotal.best) > 0.005 * Math.max(1, qIn.best)) {
    suggestedCauses.push({
      cause: 'STORAGE',
      evidence: `池内存量变化 ${storageTotal.best.toFixed(1)} m³（区间 ${storageTotal.min.toFixed(1)}–${storageTotal.max.toFixed(1)}），占进水 ${((Math.abs(storageTotal.best) / Math.max(1, qIn.best)) * 100).toFixed(2)}%。`,
    });
  }
  const pendingEvents = lagEvents.filter((e) => e.status === 'PENDING');
  if (pendingEvents.length > 0) {
    suggestedCauses.push({
      cause: 'LAG',
      evidence: `${pendingEvents.length} 个进水事件尚未到达可达时间带（${pendingEvents
        .map((e) => `${BALANCE_METRIC_LABELS[e.metric]}@${new Date(e.at + 8 * 3_600_000).toISOString().slice(11, 16)}`)
        .join('、')}），保持在水力滞后在途，不强行配对。`,
    });
  }
  const bwGap = backwashStreams.reduce(
    (acc, s) => acc + (streamTotals.find((t) => t.streamId === s.streamId && t.metric === 'FLOW')?.gapSeconds ?? 0),
    0,
  );
  const bwVolume = backwashStreams.reduce((acc, s) => acc + (volumeByStream.get(s.streamId)?.best ?? 0), 0);
  if (backwashStreams.length > 0 && (bwGap > 0 || bwVolume > 1)) {
    suggestedCauses.push({
      cause: 'BACKWASH',
      evidence: `反冲洗支路 ${backwashStreams.map((s) => s.streamId).join('、')} 回流量 ${bwVolume.toFixed(0)} m³${
        bwGap > 0 ? `，计量缺测 ${(bwGap / 60).toFixed(0)} min（登记估计补入，区间偏宽）` : '，计量完整'
      }。`,
    });
  }
  if (reconcileResult && reconcileResult.adjustments.some((a) => Math.abs(a.adjustment) > a.sigma)) {
    suggestedCauses.push({
      cause: 'METER_ERROR',
      evidence: `协调后 ${reconcileResult.adjustments
        .filter((a) => Math.abs(a.adjustment) > a.sigma)
        .map((a) => `${a.meterId} 调整 ${(a.adjustmentRel * 100).toFixed(2)}%`)
        .join('、')}（均在证书边界内）。`,
    });
  }
  for (const r of removal) {
    if (r.unexplained.max > 0.5 || r.unexplained.min < -0.5) {
      suggestedCauses.push({
        cause: 'REMOVAL_SUPPORT',
        evidence: `${BALANCE_METRIC_LABELS[r.pollutant]} 观测去除超出工艺记录支持 ${r.unexplained.best.toFixed(2)} kg（区间 ${r.unexplained.min.toFixed(2)}–${r.unexplained.max.toFixed(2)}），该残差必须保留，不得调成测量误差。`,
      });
    }
  }

  const computeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  return {
    plantId,
    day,
    windowFrom: dayFrom,
    windowTo: dayTo,
    streamTotals,
    plant: { water, tracer, removal, inTransit },
    units: unitClosures,
    lagEvents,
    reconcile: reconcileResult,
    suggestedCauses,
    caveats: [...new Set(caveats)],
    computeMs,
  };
}

function findConcMeter(data: BalanceData, stream: BoundaryStream, metric: BalanceMetric): string | null {
  const reading = data.readings.find((r) => r.streamId === stream.streamId && r.metric === metric);
  return reading ? reading.meterId : null;
}

function buildReconciliation(
  data: BalanceData,
  inStream: BoundaryStream | undefined,
  outStream: BoundaryStream | undefined,
  sludgeStreams: BoundaryStream[],
  backwashStreams: BoundaryStream[],
  streamTotals: StreamTotal[],
  volumeByStream: Map<string, LoadBounds>,
  storageByUnit: Map<string, LoadBounds>,
  tracerStored: LoadBounds,
): ReconcileResult | null {
  if (!inStream || !outStream) return null;
  const meterById = new Map(data.meters.map((m) => [m.meterId, m]));
  const variables: ReconcileVariable[] = [];
  const flowStreams = [inStream, outStream, ...sludgeStreams, ...backwashStreams];
  for (const s of flowStreams) {
    if (!s.flowMeterId) continue;
    const meter = meterById.get(s.flowMeterId);
    const v = volumeByStream.get(s.streamId);
    if (!meter || !v || v.best <= 0) continue;
    variables.push({
      meterId: meter.meterId,
      metric: 'FLOW',
      label: `${STREAM_KIND_LABELS[s.kind]} ${s.streamId} 水量`,
      measured: v.best,
      sigma: meter.relSigma * v.best + meter.absSigma,
      adjustLimit: meter.adjustLimitRel * v.best,
      calGroup: meter.calGroup,
      groupCorrelation: meter.groupCorrelation,
    });
  }
  for (const [unitId, b] of storageByUnit.entries()) {
    const meter = meterById.get(`L-${unitId}`);
    if (!meter || (Math.abs(b.best) < 1e-9 && Math.abs(b.max) < 1e-9)) continue;
    variables.push({
      meterId: meter.meterId,
      metric: 'FLOW',
      label: `单元 ${unitId} 存量变化 ΔV`,
      measured: b.best,
      sigma: Math.max(meter.absSigma, 1e-6),
      adjustLimit: Math.max(meter.adjustLimitRel * Math.abs(b.best), 2 * meter.absSigma),
      calGroup: meter.calGroup,
      groupCorrelation: meter.groupCorrelation,
    });
  }
  const tracerOf = (s: BoundaryStream) => streamTotals.find((t) => t.streamId === s.streamId && t.metric === 'TRACER');
  for (const s of [inStream, outStream, ...backwashStreams]) {
    const t = tracerOf(s);
    if (!t || t.total.best <= 0) continue;
    const meterId = findConcMeter(data, s, 'TRACER');
    const meter = meterId ? meterById.get(meterId) : undefined;
    if (!meter) continue;
    variables.push({
      meterId: meter.meterId,
      metric: 'TRACER',
      label: `${STREAM_KIND_LABELS[s.kind]} ${s.streamId} 示踪负荷`,
      measured: t.total.best,
      sigma: meter.relSigma * t.total.best + meter.absSigma,
      adjustLimit: meter.adjustLimitRel * t.total.best,
      calGroup: meter.calGroup,
      groupCorrelation: meter.groupCorrelation,
    });
  }
  if (variables.length < 3) return null;
  const constraints: ReconcileConstraintInput[] = [
    {
      a: variables.map((v) => {
        if (v.metric !== 'FLOW') return 0;
        return v.label.includes(inStream.streamId) ? 1 : -1;
      }),
      b: 0,
      label: '水量闭合',
      unit: 'm³',
    },
    {
      a: variables.map((v) => {
        if (v.metric !== 'TRACER') return 0;
        return v.label.includes(inStream.streamId) ? 1 : -1;
      }),
      b: tracerStored.best,
      label: '示踪闭合',
      unit: 'kg',
    },
  ];
  const { result } = reconcile(variables, constraints);
  return result;
}
