/**
 * 去除范围：COD / 氨氮的去除只能依据工艺记录（曝气、污泥排放、投药、溶解氧）
 * 与去除参数台账形成范围；缺少记录支持的部分必须保留为不可解释残差，
 * 任何路径都不得把正常去除强行调成测量误差。
 */

import type { LoadBounds, Pollutant } from '../types';
import type { BalanceData, RemovalContribution, RemovalParam } from './types';

function paramRange(params: RemovalParam[], id: string): { low: number; high: number; param: RemovalParam } {
  const found = params.find((p) => p.paramId === id);
  if (!found) throw new Error(`去除参数台账缺少 ${id}，无法形成去除范围`);
  return { low: found.low, high: found.high, param: found };
}

function bounds(low: number, high: number): LoadBounds {
  return { min: low, best: (low + high) / 2, max: high };
}

function sumBounds(list: LoadBounds[]): LoadBounds {
  return list.reduce<LoadBounds>(
    (acc, b) => ({ min: acc.min + b.min, best: acc.best + b.best, max: acc.max + b.max }),
    { min: 0, best: 0, max: 0 },
  );
}

export interface SupportedRemoval {
  pollutant: Pollutant;
  supported: LoadBounds;
  contributions: RemovalContribution[];
  notes: string[];
}

/**
 * 计算某污染物在窗口内的可支持去除范围。
 * 曝气：空气量 × 理论氧含量 × 氧转移效率 → 供氧区间；
 *   氨氮按硝化需氧分配，COD 按剩余供氧 × 碳氧化系数；
 *   溶解氧记录低于登记下限时好氧去除减半（依据 DO 记录，不得凭空放宽）。
 * 排泥：排放体积 × 含固浓度区间 × 污泥 COD 比 → 随泥移除的 COD。
 * 投药：药剂量 × 单位药剂去除区间 → 化学去除。
 */
export function supportedRemoval(
  data: BalanceData,
  pollutant: Pollutant,
  windowFrom: number,
  windowTo: number,
): SupportedRemoval {
  const params = data.removalParams;
  const records = data.processRecords.filter(
    (r) => r.from < windowTo && r.to > windowFrom,
  );
  const contributions: RemovalContribution[] = [];
  const notes: string[] = [];

  const aeration = records.filter((r) => r.kind === 'AERATION');
  const doRecords = records.filter((r) => r.kind === 'DO');
  const sludge = records.filter((r) => r.kind === 'SLUDGE_WASTE');
  const dosing = records.filter((r) => r.kind === 'DOSING');

  // 溶解氧门槛：好氧去除有效性的登记判据
  let doFactor: LoadBounds = { min: 1, best: 1, max: 1 };
  if (doRecords.length > 0) {
    const doMin = paramRange(params, 'RP-DO-MIN');
    const avgDo = doRecords.reduce((a, r) => a + r.value, 0) / doRecords.length;
    if (avgDo < doMin.low) {
      doFactor = { min: 0.4, best: 0.5, max: 0.6 };
      notes.push(
        `溶解氧均值 ${avgDo.toFixed(2)} mg/L 低于登记下限 ${doMin.low} mg/L，好氧去除按 0.4–0.6 折减（依据 ${doRecords.length} 条 DO 记录）。`,
      );
    }
  } else {
    notes.push('窗口内无溶解氧记录，好氧去除有效性缺少佐证，区间保持但不作收紧。');
  }

  if (aeration.length > 0) {
    const o2PerM3 = paramRange(params, 'RP-O2-KG-M3AIR');
    const eta = paramRange(params, 'RP-ETA-O2');
    const totalAirM3 = aeration.reduce((acc, r) => acc + (r.value * (r.to - r.from)) / 3_600_000, 0);
    const o2Low = totalAirM3 * o2PerM3.low * eta.low;
    const o2High = totalAirM3 * o2PerM3.high * eta.high;
    const recordIds = aeration.map((r) => r.recordId).join('，');
    if (pollutant === 'NH3N') {
      const frac = paramRange(params, 'RP-NIT-FRAC');
      const o2PerN = paramRange(params, 'RP-NIT-O2');
      const low = (o2Low * frac.low * doFactor.min) / o2PerN.high;
      const high = (o2High * frac.high * doFactor.max) / o2PerN.low;
      contributions.push({
        recordId: recordIds,
        kind: 'AERATION',
        pollutant,
        range: bounds(low, high),
        basis: `曝气 ${totalAirM3.toFixed(0)} m³ × 理论氧 ${o2PerM3.low.toFixed(3)} kg/m³ × 转移效率 ${eta.low}–${eta.high} × 硝化分配 ${frac.low}–${frac.high} ÷ 硝化需氧 ${o2PerN.low} kgO₂/kgN`,
        paramIds: ['RP-O2-KG-M3AIR', 'RP-ETA-O2', 'RP-NIT-FRAC', 'RP-NIT-O2'],
      });
    } else {
      const frac = paramRange(params, 'RP-NIT-FRAC');
      const codPerO2 = paramRange(params, 'RP-COD-PER-O2');
      const low = o2Low * (1 - frac.high) * codPerO2.low * doFactor.min;
      const high = o2High * (1 - frac.low) * codPerO2.high * doFactor.max;
      contributions.push({
        recordId: recordIds,
        kind: 'AERATION',
        pollutant,
        range: bounds(low, high),
        basis: `曝气 ${totalAirM3.toFixed(0)} m³ 供氧 × 碳氧化分配 ${(1 - frac.high).toFixed(2)}–${(1 - frac.low).toFixed(2)} × ${codPerO2.low}–${codPerO2.high} kgCOD/kgO₂`,
        paramIds: ['RP-O2-KG-M3AIR', 'RP-ETA-O2', 'RP-NIT-FRAC', 'RP-COD-PER-O2'],
      });
    }
  } else {
    notes.push('窗口内无曝气记录，好氧去除贡献为 0（缺少支持即不放宽范围）。');
  }

  if (pollutant === 'COD') {
    if (sludge.length > 0) {
      const tss = paramRange(params, 'RP-SLUDGE-TSS');
      const ratio = paramRange(params, 'RP-SLUDGE-CODRATIO');
      const totalM3 = sludge.reduce((acc, r) => acc + r.value, 0);
      const low = totalM3 * tss.low * ratio.low;
      const high = totalM3 * tss.high * ratio.high;
      contributions.push({
        recordId: sludge.map((r) => r.recordId).join('，'),
        kind: 'SLUDGE_WASTE',
        pollutant,
        range: bounds(low, high),
        basis: `排泥 ${totalM3.toFixed(1)} m³ × 含固 ${tss.low}–${tss.high} kgTSS/m³ × 污泥 COD 比 ${ratio.low}–${ratio.high}`,
        paramIds: ['RP-SLUDGE-TSS', 'RP-SLUDGE-CODRATIO'],
      });
    }
    if (dosing.length > 0) {
      const pac = paramRange(params, 'RP-PAC-COD');
      const totalKg = dosing.reduce((acc, r) => acc + r.value, 0);
      contributions.push({
        recordId: dosing.map((r) => r.recordId).join('，'),
        kind: 'DOSING',
        pollutant,
        range: bounds(totalKg * pac.low, totalKg * pac.high),
        basis: `投药 ${totalKg.toFixed(0)} kg × 单位去除 ${pac.low}–${pac.high} kgCOD/kg`,
        paramIds: ['RP-PAC-COD'],
      });
    }
  }

  const supported = sumBounds(contributions.map((c) => c.range));
  if (contributions.length === 0) {
    notes.push(`${pollutant} 没有任何工艺记录支持，去除范围只能为 0；观测到的去除全部进入不可解释残差。`);
  }
  return { pollutant, supported, contributions, notes };
}

/**
 * 不可解释残差：观测去除超出支持范围的部分。
 * 区间语义：min = 观测下限超出支持上限的部分（必然后果），
 * best = 观测最佳估计超出支持最佳估计的部分，max = 观测上限超出支持下限的部分；
 * 两侧区间完全重叠时 min 为 0，但 best/max 仍保留“可能超出”的部分——
 * 该残差必须保留展示，不得调成测量误差。
 */
export function unexplainedResidual(observed: LoadBounds, supported: LoadBounds): LoadBounds {
  const posMin = Math.max(0, observed.min - supported.max);
  const posMax = Math.max(0, observed.max - supported.min);
  const posBest = Math.min(Math.max(0, observed.best - supported.best), posMax);
  const negMin = Math.min(0, observed.min - supported.max);
  const negMax = Math.min(0, observed.max - supported.min);
  const negBest = Math.max(Math.min(0, observed.best - supported.best), negMin);
  if (observed.best >= supported.best) {
    return { min: posMin, best: posBest, max: posMax };
  }
  return { min: negMin, best: negBest, max: negMax };
}
