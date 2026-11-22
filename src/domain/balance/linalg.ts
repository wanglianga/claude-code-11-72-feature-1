/**
 * 小型稠密线性代数：高斯消元（部分主元）与矩阵求逆。
 * 仅用于受约束测量协调的 KKT 系统（规模 ≤ 数十阶），不引入外部依赖。
 */

export function solveLinear(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) throw new Error('线性系统奇异，无法求解（约束或协方差构造有误）');
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / m[i][i]);
}

export function invertMatrix(a: number[][]): number[][] {
  const n = a.length;
  const inv: number[][] = [];
  for (let col = 0; col < n; col += 1) {
    const e = new Array<number>(n).fill(0);
    e[col] = 1;
    inv.push(solveLinear(a, e));
  }
  // inv[col] 是第 col 列 → 转置为行形式
  return a.map((_, r) => inv.map((column) => column[r]));
}

export function matVecMul(a: number[][], x: number[]): number[] {
  return a.map((row) => row.reduce((acc, v, j) => acc + v * x[j], 0));
}

export function quadraticForm(a: number[][], x: number[]): number {
  const ax = matVecMul(a, x);
  return x.reduce((acc, v, i) => acc + v * ax[i], 0);
}
