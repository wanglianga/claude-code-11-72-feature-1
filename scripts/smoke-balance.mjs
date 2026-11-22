/* eslint-disable no-console */
/**
 * 浏览器端到端冒烟：装载样例 → 计算 → 平衡分析全流程 → 归因复核 → 补传流量新版本。
 * 按需手动执行（不作为 npm script）：需先 `npm i -D playwright && npx playwright install chromium`，
 * 再 `node scripts/smoke-balance.mjs`（脚本会自行启动 vite preview）。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const server = spawn('/opt/node-22/bin/npm', ['run', 'serve'], { cwd: process.cwd(), stdio: 'pipe' });
  await wait(2500);
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    console.log('1. 打开应用…');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.brand-text', { timeout: 15000 });

    console.log('2. 装载样例资料…');
    await page.click('text=装载样例资料');
    await page.waitForSelector('.stat-value', { timeout: 120000 });
    await page.waitForTimeout(1500);

    console.log('3. 概览出现工艺段平衡摘要卡…');
    await page.waitForSelector('text=工艺段平衡', { timeout: 30000 });

    console.log('4. 平衡分析页…');
    await page.click('.nav-item:has-text("平衡分析")');
    await page.waitForSelector('text=水量闭合', { timeout: 30000 });
    await page.waitForSelector('text=受约束测量协调', { timeout: 30000 });
    await page.waitForSelector('text=观测去除与去除范围', { timeout: 30000 });
    await page.waitForSelector('text=滞后匹配', { timeout: 30000 });
    const residualText = await page.textContent('.content');
    if (!residualText?.includes('不可解释残差')) throw new Error('平衡分析页缺少不可解释残差');
    if (!residualText?.includes('在途')) throw new Error('平衡分析页缺少在途量');

    console.log('5. 生成分析版本 v1…');
    await page.click('button:has-text("生成分析版本")');
    await page.waitForSelector('.toast.success', { timeout: 30000 });

    console.log('6. 边界配置页…');
    await page.click('.nav-item:has-text("边界配置")');
    await page.waitForSelector('text=边界流登记', { timeout: 15000 });
    await page.waitForSelector('text=S-BYP', { timeout: 15000 });
    await page.waitForSelector('text=回流泵切换事件', { timeout: 15000 });

    console.log('7. 不确定度库页…');
    await page.click('.nav-item:has-text("不确定度库")');
    await page.waitForSelector('text=计量仪表不确定度库', { timeout: 15000 });
    await page.waitForSelector('text=去除参数台账', { timeout: 15000 });
    await page.waitForSelector('text=CG-FLOW-2026Q4', { timeout: 15000 });

    console.log('8. 归因复核页：复核 v1…');
    await page.click('.nav-item:has-text("归因复核")');
    await page.waitForSelector('text=分析版本', { timeout: 15000 });
    await page.click('label:has-text("反冲洗水混入主线")');
    await page.click('label:has-text("流量计与浓度仪误差叠加")');
    await page.fill('input[placeholder*="确认反冲洗"]', '确认反冲洗水混入主线为主因，仪表误差叠加次之；COD 不可解释残差保留待工艺排查。');
    await page.click('button:has-text("标记复核完成")');
    await page.waitForSelector('.toast.success', { timeout: 15000 });
    await page.waitForSelector('text=已复核', { timeout: 15000 });

    console.log('9. 导入补传流量 → 应生成新版本 v2…');
    await page.click('button:has-text("导入补传流量")');
    await page.waitForSelector('.toast:has-text("补传流量")', { timeout: 60000 });
    const toastText = await page.textContent('.toast:has-text("补传流量")');
    if (!toastText?.includes('缩窄')) throw new Error(`补传后未提示缩窄：${toastText}`);
    await page.waitForSelector('option[value*="-v2-"]', { state: 'attached', timeout: 15000 });
    const page2 = await page.textContent('.content');
    if (!page2?.includes('LATE_DATA') && !page2?.includes('补传流量触发')) throw new Error('新版本未标记补传触发');

    console.log('10. 刷新后状态恢复…');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.brand-text', { timeout: 15000 });
    await page.click('.nav-item:has-text("归因复核")');
    await page.waitForSelector('option[value*="-v2-"]', { state: 'attached', timeout: 20000 });

    console.log('11. 既有页面回归（概览/复算候选/样例核验）…');
    await page.click('.nav-item:has-text("概览")');
    await page.waitForSelector('.stat-value', { timeout: 30000 });
    await page.click('.nav-item:has-text("样例核验")');
    await page.waitForSelector('text=双路线', { timeout: 60000 });

    if (errors.length > 0) {
      console.error('\n控制台错误：');
      for (const e of errors) console.error('  ', e);
      process.exit(1);
    }
    console.log('\n端到端冒烟通过：装载 → 平衡分析 → 版本 → 复核 → 补传缩窄 → 刷新恢复，0 控制台错误。');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e);
  process.exit(1);
});
