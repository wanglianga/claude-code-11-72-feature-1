/**
 * 受约束测量协调（路径 B）：仅对守恒项（水量、无反应示踪量）在已知误差
 * 与相关关系下求最可能调整值。
 *
 * 模型：min (x−m)ᵀ W (x−m)，s.t. A x = b
 * - W = Σ⁻¹，Σ 由仪表 1σ 误差与共用校准组相关构造（同一校准来源 → 误差相关）；
 * - 调整量受证书边界约束：|xᵢ−mᵢ| ≤ adjustLimitᵢ，触及边界即钳制并固定，
 *   仍无法闭合的部分保留为不可协调残差，绝不放大到证书边界之外；
 * - COD / 氨氮永不进入变量集（守恒约束只对水量与示踪量成立）。
 */

import type { LoadBounds } from '../types';
import type { BalanceMetric, ReconcileAdjustment, ReconcileResult } from './types';
import { invertMatrix, matVecMul, quadraticForm, solveLinear } from './linalg';

export interface ReconcileVariable {
  meterId: string;
  metric: BalanceMetric;
  label: string;
  measured: number;
  sigma: number;
  adjustLimit: number;
  calGroup: string;
  groupCorrelation: number;
}

export interface ReconcileConstraintInput {
  /** 与 variables 对齐的系数 */
  a: number[];
  b: number;
  label: string;
  unit: string;
}

export interface ReconcileComputation {
  result: ReconcileResult;
  adjustedValues: number[];
  constraintResiduals: number[];
}

export function reconcile(
  variables: ReconcileVariable[],
  constraints: ReconcileConstraintInput[],
): ReconcileComputation {
  for (const v of variables) {
    if (v.metric !== 'FLOW' && v.metric !== 'TRACER') {
      throw new Error(`受约束测量协调只允许水量与无反应示踪量，收到 ${v.metric}（${v.meterId}）`);
    }
  }
  const n = variables.length;
  if (n === 0 || constraints.length === 0) {
    return {
      result: {
        metrics: ['FLOW', 'TRACER'],
        adjustments: [],
        chi2: 0,
        degreesOfFreedom: 0,
        residualAfter: { min: 0, best: 0, max: 0 },
        irreconcilable: { min: 0, best: 0, max: 0 },
        covarianceBasis: [],
        notes: ['没有可协调的变量或约束'],
      },
      adjustedValues: [],
      constraintResiduals: [],
    };
  }

  // 协方差：组内相关（共用校准来源），组间独立
  const cov: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) cov[i][j] = variables[i].sigma ** 2;
      else if (variables[i].calGroup && variables[i].calGroup === variables[j].calGroup) {
        const rho = Math.min(Math.abs(variables[i].groupCorrelation), 0.95);
        cov[i][j] = rho * variables[i].sigma * variables[j].sigma;
      }
    }
  }
  const W = invertMatrix(cov);
  const m = variables.map((v) => v.measured);

  // 迭代钳制：解 KKT → 超界变量固定在证书边界 → 重解
  const fixed = new Map<number, number>();
  let x = [...m];
  const maxIterations = 5;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const freeIdx = variables.map((_, i) => i).filter((i) => !fixed.has(i));
    const nf = freeIdx.length;
    if (nf === 0) break;
    const Wf = freeIdx.map((i) => freeIdx.map((j) => W[i][j]));
    const mf = freeIdx.map((i) => m[i]);
    // 约束右端扣除已固定变量；若某约束的自由变量全部固定，则该约束已由固定值决定，不再进入系统
    const cons = constraints
      .map((c) => ({
        a: freeIdx.map((i) => c.a[i]),
        b: c.b - c.a.reduce((acc, coef, i) => (fixed.has(i) ? acc + coef * fixed.get(i)! : acc), 0),
      }))
      .filter((c) => c.a.some((coef) => Math.abs(coef) > 1e-12));
    const nc = cons.length;
    // KKT 系统 [Wf Aᵀ; A 0][x;λ] = [Wf mf; b]
    const size = nf + nc;
    const K: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (let i = 0; i < nf; i += 1) {
      for (let j = 0; j < nf; j += 1) K[i][j] = Wf[i][j];
      for (let c = 0; c < nc; c += 1) K[i][nf + c] = cons[c].a[i];
    }
    for (let c = 0; c < nc; c += 1) {
      for (let j = 0; j < nf; j += 1) K[nf + c][j] = cons[c].a[j];
    }
    const rhs = [...matVecMul(Wf, mf), ...cons.map((c) => c.b)];
    const sol = solveLinear(K, rhs);
    x = [...m];
    freeIdx.forEach((idx, k) => {
      x[idx] = sol[k];
    });
    for (const [idx, v] of fixed) x[idx] = v;

    // 证书边界检查
    let violated = false;
    for (let i = 0; i < n; i += 1) {
      if (fixed.has(i)) continue;
      const limit = variables[i].adjustLimit;
      const delta = x[i] - m[i];
      if (Math.abs(delta) > limit + 1e-9) {
        fixed.set(i, m[i] + Math.sign(delta) * limit);
        violated = true;
      }
    }
    if (!violated) break;
  }
  for (const [idx, v] of fixed) x[idx] = v;

  const delta = x.map((v, i) => v - m[i]);
  const chi2 = quadraticForm(W, delta);
  const constraintResiduals = constraints.map((c) => c.b - c.a.reduce((acc, coef, i) => acc + coef * x[i], 0));

  const groups = [...new Set(variables.map((v) => v.calGroup).filter(Boolean))];
  const adjustments: ReconcileAdjustment[] = variables.map((v, i) => ({
    meterId: v.meterId,
    metric: v.metric,
    label: v.label,
    measured: v.measured,
    adjusted: x[i],
    adjustment: delta[i],
    adjustmentRel: v.measured !== 0 ? delta[i] / v.measured : 0,
    sigma: v.sigma,
    withinCertificate: Math.abs(delta[i]) <= v.adjustLimit + 1e-9,
    clamped: fixed.has(i),
    calGroup: v.calGroup,
    note: fixed.has(i)
      ? '调整触及证书边界已钳制；超出部分保留为不可协调残差'
      : `调整量 ${(Math.abs(delta[i]) / Math.max(v.sigma, 1e-9)).toFixed(2)}σ，在证书边界内`,
  }));

  const irreconcilableBest = constraintResiduals.reduce((acc, r) => acc + Math.abs(r), 0);
  const residualAfter: LoadBounds = {
    min: Math.min(...constraintResiduals, 0),
    best: constraintResiduals[0] ?? 0,
    max: Math.max(...constraintResiduals, 0),
  };
  const notes: string[] = [
    `目标函数 min Σ(Δx/σ)²，协方差由仪表 1σ 与共用校准组相关（${groups.length} 个组）构造；约束 ${constraints.length} 个（水量闭合、示踪闭合）。`,
    `χ² = ${chi2.toFixed(3)}，自由度 ${constraints.length}；COD/氨氮不在变量集内，去除量不参与协调。`,
  ];
  if (fixed.size > 0) {
    notes.push(`${fixed.size} 台仪表的调整触及证书边界被钳制，剩余 ${irreconcilableBest.toFixed(3)} 的闭合缺口保留为不可协调残差。`);
  }
  return {
    result: {
      metrics: ['FLOW', 'TRACER'],
      adjustments,
      chi2,
      degreesOfFreedom: constraints.length,
      residualAfter,
      irreconcilable: { min: 0, best: irreconcilableBest, max: irreconcilableBest },
      covarianceBasis: groups.map(
        (g) =>
          `校准组 ${g}：${variables.filter((v) => v.calGroup === g).map((v) => v.meterId).join('、')} 共用校准来源，组内相关 ρ=${variables.find((v) => v.calGroup === g)!.groupCorrelation}`,
      ),
      notes,
    },
    adjustedValues: x,
    constraintResiduals,
  };
}
