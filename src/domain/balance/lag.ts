/**
 * 滞后匹配器：为进出水片段建立可达时间关系。
 *
 * 规则：
 * - 进水事件 e 的可达时间带 = [e.at + lagMin, e.at + lagMax]（全厂滞后为各单元滞后带求和）；
 * - 出水事件落在带内且同向才允许配对（MATCHED）；
 * - 进水升高尚未到达可达时间带（带起点晚于分析窗口末端）→ PENDING，保持“在途”，
 *   绝不强行配对；
 * - 带内无出水事件 → UNMATCHED；无进水前驱的出水事件 → ORPHAN（内部扰动候选）。
 *
 * 在途量：把窗口切成等长时槽，槽内负荷的出厂时间均匀分布在一个滞后带内；
 * 窗口末端仍未出厂的份额即“在途”，用最早/最晚出厂两个模型夹出区间。
 */

import type { BalanceMetric, InTransit, LagEvent } from './types';
import type { LoadBounds } from '../types';

export interface Knot {
  at: number;
  value: number;
}

export interface LagInput {
  metric: BalanceMetric;
  inSeries: Knot[];
  outSeries: Knot[];
  windowFrom: number;
  windowTo: number;
  lagMinMs: number;
  lagMaxMs: number;
}

const BLOCK_MS = 30 * 60_000;

interface Block {
  from: number;
  mean: number;
}

function blockMeans(series: Knot[], windowFrom: number, windowTo: number): Block[] {
  const blocks: Block[] = [];
  for (let from = windowFrom; from < windowTo; from += BLOCK_MS) {
    const to = Math.min(from + BLOCK_MS, windowTo);
    const vals = series.filter((k) => k.at >= from && k.at < to).map((k) => k.value);
    if (vals.length === 0) continue;
    blocks.push({ from, mean: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
  return blocks;
}

interface RawEvent {
  side: 'IN' | 'OUT';
  at: number;
  direction: 'RISE' | 'FALL';
  magnitude: number;
}

/** 阶跃事件检测：块均值相对基线持续偏离超过阈值即记为一个事件 */
function detectEvents(series: Knot[], side: 'IN' | 'OUT', windowFrom: number, windowTo: number): RawEvent[] {
  const blocks = blockMeans(series, windowFrom, windowTo);
  if (blocks.length < 3) return [];
  const events: RawEvent[] = [];
  const baseline = blocks[0].mean;
  const threshold = Math.max(Math.abs(baseline) * 0.1, 1e-6);
  let active: { start: number; direction: 'RISE' | 'FALL'; peak: number; peakAbs: number } | null = null;
  for (let i = 1; i < blocks.length; i += 1) {
    const diff = blocks[i].mean - baseline;
    const dir: 'RISE' | 'FALL' = diff >= 0 ? 'RISE' : 'FALL';
    const exceed = Math.abs(diff) > threshold;
    if (!active) {
      if (exceed) active = { start: blocks[i].from, direction: dir, peak: diff, peakAbs: Math.abs(diff) };
      continue;
    }
    if (dir === active.direction && Math.abs(diff) >= Math.abs(active.peak) * 0.6 && exceed) {
      if (Math.abs(diff) > Math.abs(active.peak)) active.peak = diff;
      continue;
    }
    // 事件结束：方向反转或回落到阈值内
    if (Math.abs(active.peak) > threshold * 1.2) {
      events.push({
        side,
        at: active.start,
        direction: active.direction,
        magnitude: active.peak / (Math.abs(baseline) > 1e-9 ? baseline : 1),
      });
    }
    active = exceed && dir !== active.direction ? { start: blocks[i].from, direction: dir, peak: diff, peakAbs: Math.abs(diff) } : null;
  }
  if (active && Math.abs(active.peak) > threshold * 1.2) {
    events.push({
      side,
      at: active.start,
      direction: active.direction,
      magnitude: active.peak / (Math.abs(baseline) > 1e-9 ? baseline : 1),
    });
  }
  return events;
}

export interface LagMatchResult {
  events: LagEvent[];
  inTransit: InTransit | null;
  lagMinMs: number;
  lagMaxMs: number;
}

export function matchLag(input: LagInput, inTransitLoad: LoadBounds | null, pendingEventIds: string[]): LagMatchResult {
  const { metric, inSeries, outSeries, windowFrom, windowTo, lagMinMs, lagMaxMs } = input;
  const raw = [
    ...detectEvents(inSeries, 'IN', windowFrom, windowTo),
    ...detectEvents(outSeries, 'OUT', windowFrom, windowTo),
  ].sort((a, b) => a.at - b.at);
  const events: LagEvent[] = raw.map((e, i) => ({
    eventId: `EV-${metric}-${i}`,
    side: e.side,
    metric,
    at: e.at,
    magnitude: e.magnitude,
    direction: e.direction,
    reachableFrom: e.side === 'IN' ? e.at + lagMinMs : null,
    reachableTo: e.side === 'IN' ? e.at + lagMaxMs : null,
    status: 'UNMATCHED',
    matchedEventId: null,
    note: '',
  }));
  const outEvents = events.filter((e) => e.side === 'OUT');
  for (const ev of events) {
    if (ev.side !== 'IN') continue;
    // 进水升高尚未到达可达时间带：不强行配对
    if (ev.reachableFrom !== null && ev.reachableFrom >= windowTo) {
      ev.status = 'PENDING';
      ev.note = `可达时间带起点晚于窗口末端，进水升高仍在途中，不强行配对`;
      pendingEventIds.push(ev.eventId);
      continue;
    }
    const candidates = outEvents.filter(
      (o) =>
        o.status !== 'MATCHED' &&
        o.direction === ev.direction &&
        ev.reachableFrom !== null &&
        ev.reachableTo !== null &&
        o.at >= ev.reachableFrom &&
        o.at <= ev.reachableTo,
    );
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) =>
        Math.abs(a.magnitude - ev.magnitude) <= Math.abs(b.magnitude - ev.magnitude) ? a : b,
      );
      ev.status = 'MATCHED';
      ev.matchedEventId = best.eventId;
      best.status = 'MATCHED';
      best.matchedEventId = ev.eventId;
      ev.note = `出水事件 ${best.eventId} 落在可达时间带内，允许配对`;
      best.note = `与进水事件 ${ev.eventId} 配对（滞后 ${(best.at - ev.at) / 60000 >= 0 ? ((best.at - ev.at) / 60000).toFixed(0) : '?'} min）`;
    } else {
      ev.status = 'UNMATCHED';
      ev.note = '可达时间带内未找到同向出水事件（候选：存量蓄积 / 未登记支路）';
    }
  }
  for (const ev of events) {
    if (ev.side === 'OUT' && ev.status !== 'MATCHED') {
      ev.status = 'ORPHAN';
      ev.note = '出水事件无进水前驱（候选：反冲洗混入 / 回流切换等内部扰动）';
    }
  }
  return { events, inTransit: inTransitLoad ? { metric, load: inTransitLoad, events: pendingEventIds, note: '' } : null, lagMinMs, lagMaxMs };
}

/**
 * 在途负荷区间：时槽模型。
 * 每个时槽的负荷在 [lagMin, lagMax] 内均匀出厂；窗口末端未出厂份额的
 * 最早/均匀/最晚三个模型给出 {min, best, max}。
 */
export function inTransitLoad(
  slots: { from: number; load: number }[],
  windowTo: number,
  lagMinMs: number,
  lagMaxMs: number,
): LoadBounds {
  let min = 0;
  let best = 0;
  let max = 0;
  for (const slot of slots) {
    // 出厂时刻模型：最早 lagMin、均匀、最晚 lagMax
    const exitEarliest = slot.from + lagMinMs;
    const exitLatest = slot.from + lagMaxMs;
    if (exitEarliest >= windowTo) min += slot.load;
    if (exitLatest >= windowTo) max += slot.load;
    // 均匀模型：出厂窗口 [exitEarliest, exitLatest] 中落在窗口末端之后的份额
    const span = Math.max(1, lagMaxMs - lagMinMs);
    const pending = Math.min(Math.max((exitLatest - windowTo) / span, 0), 1);
    best += slot.load * pending;
  }
  return { min, best, max };
}
