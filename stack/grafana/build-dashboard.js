// Generates dashboards/log-analyzer.json. Run: node stack/grafana/build-dashboard.js
// Kept as code because every panel shares one LogQL selector + filter chain.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ds = { type: 'loki', uid: 'loki' };

// Include/Exclude are multi-value custom variables: pick several or type your
// own regex, they are OR-ed with `|`. Their defaults are regexes that match
// everything / nothing, because an empty `!~ ""` would hide every line.
// Backtick strings keep regex backslashes literal.
const selector = '{server=~"$server", file=~"$file", level=~"$level"}';
const lineFilters = ' |~ `(?i)${include:pipe}` !~ `(?i)${exclude:pipe}`';
const logs = selector + lineFilters;
const countBy = (by, range = '$__auto') => `sum by (${by}) (count_over_time(${logs} [${range}]))`;
const countAll = (extra = '') => `sum(count_over_time(${selector}${extra}${lineFilters} [$__auto]))`;

const queryVar = (name, label, definition, extra = {}) => ({
  name,
  label,
  type: 'query',
  datasource: ds,
  query: { label: name, type: 1, stream: extra.stream ?? '', refId: name },
  definition,
  multi: true,
  includeAll: true,
  allValue: '.+',
  current: { text: ['All'], value: ['$__all'] },
  refresh: 2,
  sort: 1,
});

const customVar = (name, label, defaultText, defaultValue, description) => ({
  name,
  label,
  description,
  type: 'custom',
  query: `${defaultText} : ${defaultValue}`,
  multi: true,
  includeAll: false,
  allowCustomValue: true,
  current: { text: [defaultText], value: [defaultValue] },
  options: [{ text: defaultText, value: defaultValue, selected: true }],
});

const timeseries = (id, title, expr, gridPos, legend, colorOverrides = []) => ({
  id,
  type: 'timeseries',
  title,
  gridPos,
  datasource: ds,
  fieldConfig: {
    defaults: { custom: { drawStyle: 'bars', fillOpacity: 70, lineWidth: 0, stacking: { mode: 'normal' } } },
    overrides: colorOverrides,
  },
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  targets: [{ refId: 'A', expr, legendFormat: legend }],
});

const levelColors = [
  ['fatal', 'purple'], ['error', 'red'], ['warn', 'orange'], ['info', 'green'], ['debug', 'blue'], ['trace', 'text'], ['unknown', 'gray'],
].map(([level, color]) => ({
  matcher: { id: 'byName', options: level },
  properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }],
}));

const stat = (id, title, expr, gridPos, thresholds) => ({
  id,
  type: 'stat',
  title,
  gridPos,
  datasource: ds,
  options: { reduceOptions: { calcs: ['sum'] }, graphMode: 'none', colorMode: thresholds ? 'background' : 'value' },
  fieldConfig: {
    defaults: thresholds
      ? { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] } }
      : { color: { mode: 'fixed', fixedColor: 'text' } },
    overrides: [],
  },
  targets: [{ refId: 'A', expr, queryType: 'range' }],
});

const dashboard = {
  uid: 'log-analyzer',
  title: 'Log Analyzer',
  description: 'Logs pulled by the Log Analyzer app. Filter with the bar above, or open a log line and use the + / − magnifiers next to a label.',
  tags: ['logs'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 2,
  refresh: '30s',
  time: { from: 'now-1h', to: 'now' },
  links: [
    {
      title: 'Logs Drilldown',
      tooltip: 'Point-and-click filtering, field breakdowns and log patterns',
      type: 'link',
      url: '/a/grafana-lokiexplore-app/explore',
      icon: 'external link',
      targetBlank: false,
    },
  ],
  templating: {
    list: [
      queryVar('server', 'Server', 'label_values(server)'),
      queryVar('file', 'File', 'label_values({server=~"$server"}, file)', { stream: '{server=~"$server"}' }),
      queryVar('level', 'Level', 'label_values({server=~"$server"}, level)', { stream: '{server=~"$server"}' }),
      customVar('include', 'Contains (regex)', 'anything', '(?:)', 'Type a word or regex and press Enter; several values are OR-ed. Case-insensitive.'),
      customVar('exclude', 'Excludes (regex)', 'nothing', '[^\\s\\S]', 'Type a word or regex and press Enter to hide matching lines; several values are OR-ed.'),
      { name: 'Filters', label: 'Label filters', type: 'adhoc', datasource: ds, filters: [] },
    ],
  },
  panels: [
    timeseries(1, 'Lines by level', countBy('level'), { x: 0, y: 0, w: 12, h: 8 }, '{{level}}', levelColors),
    timeseries(2, 'Lines by server', countBy('server'), { x: 12, y: 0, w: 12, h: 8 }, '{{server}}'),
    stat(3, 'Lines', countAll(), { x: 0, y: 8, w: 6, h: 4 }),
    stat(4, 'Errors', countAll(' | level=~"error|fatal"'), { x: 6, y: 8, w: 6, h: 4 }, true),
    {
      id: 5,
      type: 'bargauge',
      title: 'Busiest files',
      gridPos: { x: 12, y: 8, w: 12, h: 4 },
      datasource: ds,
      options: { orientation: 'horizontal', displayMode: 'basic', reduceOptions: { calcs: ['sum'] }, showUnfilled: true },
      fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: 'blue' } }, overrides: [] },
      targets: [{ refId: 'A', expr: `topk(5, ${countBy('server, file')})`, legendFormat: '{{server}} · {{file}}', queryType: 'range' }],
    },
    {
      id: 6,
      type: 'logs',
      title: 'Logs',
      description: 'Click a line to see its labels; the + / − magnifiers add a filter for or against that value.',
      gridPos: { x: 0, y: 12, w: 24, h: 18 },
      datasource: ds,
      options: { showTime: true, showLabels: false, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, prettifyLogMessage: false, dedupStrategy: 'none' },
      targets: [{ refId: 'A', expr: logs }],
    },
  ],
};

const out = path.join(__dirname, 'dashboards', 'log-analyzer.json');
fs.writeFileSync(out, `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(`wrote ${out}`);
