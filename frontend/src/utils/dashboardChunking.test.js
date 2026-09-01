import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = readFileSync(join(srcDir, 'components', 'Dashboard.jsx'), 'utf8');
const charts = readFileSync(join(srcDir, 'components', 'DashboardCharts.jsx'), 'utf8');

assert.doesNotMatch(dashboard, /from ['"]recharts['"]/, 'Dashboard must not statically import Recharts');
assert.doesNotMatch(
  dashboard,
  /import\s+CardInspectorModal\s+from/,
  'Dashboard must not statically import CardInspectorModal',
);
assert.match(
  dashboard,
  /lazy\(\(\)\s*=>\s*import\(['"]\.\/DashboardCharts['"]\)\)/,
  'DashboardCharts must be lazy-loaded',
);
assert.match(
  dashboard,
  /lazy\(\(\)\s*=>\s*import\(['"]\.\/CardInspectorModal['"]\)\)/,
  'CardInspectorModal must be lazy-loaded',
);
assert.match(
  dashboard,
  /inspectorCard\s*&&[\s\S]*?<Suspense[\s\S]*?<CardInspectorModal/,
  'the inspector chunk must only render after a card is opened',
);

assert.match(charts, /from ['"]recharts['"]/, 'DashboardCharts must own the Recharts dependency');
for (const visualization of ['AreaChart', 'BarChart', 'PieChart']) {
  assert.match(charts, new RegExp(`<${visualization}\\b`), `${visualization} must remain in DashboardCharts`);
}
for (const chartLabel of [
  "t('dash.timelineTitle')",
  "t('dash.valueBySet')",
  "t('dash.colorDistribution')",
  "t('dash.rarityDistribution')",
]) {
  assert.ok(charts.includes(chartLabel), `${chartLabel} must remain in DashboardCharts`);
}

for (const usefulContent of ['topValuable', 'recentAdditions', 'setProgress']) {
  assert.ok(dashboard.includes(usefulContent), `${usefulContent} must remain on Dashboard's eager summary path`);
  assert.ok(!charts.includes(usefulContent), `${usefulContent} must not wait for the Recharts chunk`);
}

console.log('PASS: dashboardChunking.test.js');
