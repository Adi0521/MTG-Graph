import cytoscape from 'cytoscape';
import type { AnalysisResult, AnalyzedCard } from '../core/analyze.ts';
import type { DetectedCombo } from '../core/combos.ts';
import type { SpellbookNearMiss } from '../core/spellbook.ts';
import { EDGE_KIND_META, type EdgeKind, type SynergyEdge, type SynergyReason } from '../core/graph.ts';
import { THEME_BY_ID, type ThemeId } from '../core/rules.ts';
import { SAMPLE_COMMANDER_DECK } from '../core/sample-commander.ts';
import { SAMPLE_DECK } from '../core/sample-deck.ts';
import type { Loop } from '../core/structures.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deckInput = $<HTMLTextAreaElement>('decklist');
const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('file');
const fileNameEl = $('file-name');
const clearFileBtn = $<HTMLButtonElement>('clear-file');
const analyzeBtn = $<HTMLButtonElement>('analyze');
const statusEl = $('status');
const filtersEl = $('filters');
const graphEl = $('graph');
const tooltipEl = $('tooltip');
const emptyEl = $('empty');
const tabsEl = $('tabs');
const detailsEl = $('details');
const highlightBar = $('highlight-bar');
const highlightLabel = $('highlight-label');
const optMin = $<HTMLInputElement>('opt-min');
const optMax = $<HTMLInputElement>('opt-max');
const optCount = $<HTMLInputElement>('opt-count');
const optWeight = $<HTMLInputElement>('opt-weight');

const COLOR_IDENTITY: Record<string, string> = { W: '#e9e2b8', U: '#3b82c4', B: '#6b5b73', R: '#d9442b', G: '#3c9a5f' };
const MULTICOLOR = '#d4af37';
const COLORLESS = '#9ca3af';

const ALL_KINDS = Object.keys(EDGE_KIND_META) as EdgeKind[];
const enabledKinds = new Set<EdgeKind>(ALL_KINDS);

type Tab = 'overview' | 'combos' | 'loops' | 'systems' | 'chains' | 'trees' | 'critical' | 'card';

interface Highlight {
  label: string;
  nodes: Set<string>;
  edges: Set<string>;
  /** Optional step numbers shown on nodes (for loops). */
  order?: Map<string, number>;
  /** Identifies the list item that produced it, so it can be marked active. */
  key: string;
}

let result: AnalysisResult | null = null;
let uploadedFile: File | null = null;
let cy: cytoscape.Core | null = null;
let activeTab: Tab = 'overview';
let highlight: Highlight | null = null;
let selectedCard: string | null = null;
let treeRoot: string | null = null;
let treeDirection: 'downstream' | 'upstream' = 'downstream';

const edgeById = new Map<string, SynergyEdge>();
const cardByName = new Map<string, AnalyzedCard>();

// ---------------------------------------------------------------------------
// Small DOM helpers

type Child = Node | string | null | undefined | false;

/** Element builder. Text is never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function fill(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
}

function frag(...children: Child[]) {
  const f = document.createDocumentFragment();
  for (const c of children) if (c) f.append(c);
  return f;
}

function swatch(color: string) {
  const s = h('span', { class: 'swatch' });
  s.style.background = color;
  return s;
}

function button(label: Child, onClick: () => void, cls = 'link') {
  const b = h('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', onClick);
  return b;
}

function cardLink(name: string) {
  return button(name, () => selectCard(name));
}

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kindLabel = (k: EdgeKind) => EDGE_KIND_META[k].label;
const kindColor = (k: EdgeKind) => EDGE_KIND_META[k].color;
const visibleReasons = (edge: SynergyEdge) => edge.reasons.filter((r) => enabledKinds.has(r.kind));
const edgeKey = (from: string, to: string) => `${from} -> ${to}`;

function identityColor(card: AnalyzedCard): string {
  const ci = card.colorIdentity;
  if (ci.length === 0) return COLORLESS;
  if (ci.length > 1) return MULTICOLOR;
  return COLOR_IDENTITY[ci[0]!] ?? COLORLESS;
}

// ---------------------------------------------------------------------------
// Input: typed text or uploaded file

function setFile(file: File | null) {
  uploadedFile = file;
  fileNameEl.textContent = file ? file.name : '';
  clearFileBtn.hidden = !file;
  deckInput.disabled = Boolean(file);
  if (file) deckInput.value = '';
  if (!file) fileInput.value = '';
}

fileInput.addEventListener('change', () => setFile(fileInput.files?.[0] ?? null));
clearFileBtn.addEventListener('click', () => setFile(null));
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (file) setFile(file);
});

function structureOptions() {
  return {
    minLoopLength: Number(optMin.value),
    maxLoopLength: Number(optMax.value),
    maxLoops: Number(optCount.value),
    minEdgeWeight: Number(optWeight.value),
  };
}

// ---------------------------------------------------------------------------
// API call

async function analyze() {
  if (!uploadedFile && !deckInput.value.trim()) {
    setStatus('Paste a decklist or upload a deck file.', true);
    return;
  }
  let init: RequestInit;
  if (uploadedFile) {
    const form = new FormData();
    form.set('deck', uploadedFile);
    form.set('options', JSON.stringify(structureOptions()));
    init = { method: 'POST', body: form };
  } else {
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decklist: deckInput.value, options: structureOptions() }),
    };
  }

  analyzeBtn.disabled = true;
  setStatus('Analyzing…');
  try {
    const res = await fetch('/api/analyze', init);
    const body = (await res.json().catch(() => ({ error: `Server returned ${res.status}` }))) as AnalysisResult | { error: string };
    if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `Server returned ${res.status}`);
    loadResult(body);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

function loadResult(r: AnalysisResult) {
  result = r;
  edgeById.clear();
  cardByName.clear();
  for (const e of r.edges) edgeById.set(e.id, e);
  for (const c of r.cards) cardByName.set(c.name, c);
  highlight = null;
  selectedCard = null;
  treeRoot = null;
  activeTab = 'overview';

  const { deck, structures } = r;
  const comboCount = r.combos.combos.length;
  const missing = deck.notFound.length ? ` Not found: ${deck.notFound.join(', ')}.` : '';
  setStatus(
    `${deck.totalCards} cards · ${plural(comboCount, 'combo')} · ${r.edges.length} links · ${structures.loopSystems.length} loop systems · ${structures.loopSearch.found}${structures.loopSearch.exhaustive ? '' : '+'} loops.${missing}`,
    deck.notFound.length > 0,
  );
  renderFilters();
  renderGraph();
  renderPanel();
}

// ---------------------------------------------------------------------------
// Graph

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function primaryKind(edge: SynergyEdge): EdgeKind {
  return (visibleReasons(edge)[0] ?? edge.reasons[0]!).kind;
}

function nodeLabel(card: AnalyzedCard) {
  return card.quantity > 1 ? `${card.name} ×${card.quantity}` : card.name;
}

function renderGraph() {
  if (!result) return;
  cy?.destroy();
  emptyEl.hidden = result.cards.length > 0;

  const maxWeighted = Math.max(1, ...result.cards.map((c) => c.weightedDegree));
  // Deterministic starting positions: a circle, grouped by synergy cluster.
  const clusterOf = new Map<string, number>();
  result.structures.clusters.forEach((members, i) => members.forEach((m) => clusterOf.set(m, i)));
  const ordered = [...result.cards].sort(
    (a, b) => (clusterOf.get(a.name) ?? 1e9) - (clusterOf.get(b.name) ?? 1e9) || a.name.localeCompare(b.name),
  );
  const count = ordered.length;
  const radius = Math.max(200, count * 14);

  cy = cytoscape({
    container: graphEl,
    elements: [
      ...ordered.map((c, i) => ({
        group: 'nodes' as const,
        data: {
          id: c.name,
          label: nodeLabel(c),
          art: c.artUrl ?? '',
          color: identityColor(c),
          size: 34 + 46 * Math.sqrt(c.weightedDegree / maxWeighted),
        },
        position: { x: radius * Math.cos((2 * Math.PI * i) / count), y: radius * Math.sin((2 * Math.PI * i) / count) },
      })),
      ...result.edges.map((e) => ({
        group: 'edges' as const,
        data: { id: e.id, source: e.source, target: e.target, weight: e.weight, color: kindColor(primaryKind(e)) },
      })),
    ],
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.3,
    style: [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          width: 'data(size)',
          height: 'data(size)',
          'background-color': 'data(color)',
          'background-fit': 'cover',
          'border-width': 3,
          'border-color': 'data(color)',
          label: 'data(label)',
          'font-size': 10,
          color: cssVar('--graph-label'),
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'text-wrap': 'ellipsis',
          'text-max-width': '120px',
          'text-background-color': cssVar('--graph-label-bg'),
          'text-background-opacity': 0.85,
          'text-background-padding': '1px',
        },
      },
      { selector: 'node[art != ""]', style: { 'background-image': 'data(art)' } },
      {
        selector: 'edge',
        style: {
          width: 'mapData(weight, 1, 12, 1, 6)',
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'curve-style': 'bezier',
          opacity: 0.55,
        },
      },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.faded', style: { opacity: 0.08 } },
      { selector: 'node.focus', style: { 'border-width': 5, 'border-color': cssVar('--accent'), 'font-weight': 'bold' } },
      { selector: 'edge.focus', style: { opacity: 1, 'z-index': 10 } },
    ],
    layout: {
      name: 'cose',
      randomize: false,
      animate: false,
      fit: true,
      padding: 40,
      nodeRepulsion: () => 12000,
      idealEdgeLength: (edge: cytoscape.EdgeSingular) => 170 - 8 * Math.min(10, edge.data('weight')),
      edgeElasticity: () => 100,
      gravity: 0.5,
      numIter: 1500,
    } as cytoscape.CoseLayoutOptions,
  });

  cy.on('tap', 'node', (evt) => selectCard(evt.target.id()));
  cy.on('tap', (evt) => {
    if (evt.target === cy) clearHighlight();
  });
  cy.on('mouseover', 'edge', (evt) => showEdgeTooltip(evt.target.id(), evt.renderedPosition));
  cy.on('mousemove', 'edge', (evt) => positionTooltip(evt.renderedPosition));
  cy.on('mouseout', 'edge', () => (tooltipEl.hidden = true));
  cy.on('mouseover', 'node', () => (graphEl.style.cursor = 'pointer'));
  cy.on('mouseout', 'node', () => (graphEl.style.cursor = ''));

  applyFilters();
}

function applyFilters() {
  if (!cy) return;
  cy.batch(() => {
    cy!.edges().forEach((el) => {
      const edge = edgeById.get(el.id())!;
      const visible = visibleReasons(edge).length > 0;
      el.toggleClass('hidden', !visible);
      if (visible) el.data('color', kindColor(primaryKind(edge)));
    });
  });
  applyHighlight();
}

function setHighlight(next: Highlight | null) {
  highlight = next;
  applyHighlight();
  renderPanel();
}

function clearHighlight() {
  selectedCard = null;
  if (activeTab === 'card') activeTab = 'overview';
  setHighlight(null);
}

function applyHighlight() {
  highlightBar.hidden = !highlight;
  highlightLabel.textContent = highlight?.label ?? '';
  if (!cy || !result) return;
  cy.batch(() => {
    cy!.elements().removeClass('faded focus');
    cy!.nodes().forEach((n) => {
      n.data('label', nodeLabel(cardByName.get(n.id())!));
    });
    if (!highlight) return;
    cy!.elements().forEach((el) => {
      const inSet = (el.group() === 'nodes' ? highlight!.nodes : highlight!.edges).has(el.id());
      el.addClass(inSet ? 'focus' : 'faded');
    });
    for (const [name, step] of highlight.order ?? []) {
      const n = cy!.getElementById(name);
      n.data('label', `${step}. ${n.data('label')}`);
    }
  });
}

function reasonItem(r: SynergyReason) {
  return h('li', { class: 'reason' }, swatch(kindColor(r.kind)), h('span', {}, r.description));
}

function showEdgeTooltip(id: string, pos: cytoscape.Position) {
  const edge = edgeById.get(id);
  if (!edge) return;
  fill(tooltipEl, h('strong', {}, `${edge.source} → ${edge.target}`), h('ul', {}, ...visibleReasons(edge).map(reasonItem)));
  tooltipEl.hidden = false;
  positionTooltip(pos);
}

function positionTooltip(pos: cytoscape.Position) {
  const pad = 14;
  tooltipEl.style.left = `${Math.min(pos.x + pad, graphEl.clientWidth - tooltipEl.offsetWidth - 4)}px`;
  tooltipEl.style.top = `${Math.min(pos.y + pad, graphEl.clientHeight - tooltipEl.offsetHeight - 4)}px`;
}

// ---------------------------------------------------------------------------
// Highlights for each structure type

function loopHighlight(loop: Loop, key: string): Highlight {
  return {
    key,
    label: `Loop of ${loop.length}: ${loop.cards.join(' → ')} → ${loop.cards[0]}`,
    nodes: new Set(loop.cards),
    edges: new Set(loop.steps.map((s) => edgeKey(s.from, s.to))),
    order: new Map(loop.cards.map((c, i) => [c, i + 1])),
  };
}

function setHighlightFromCards(key: string, label: string, cards: string[], edgeFilter: (e: SynergyEdge) => boolean) {
  const nodes = new Set(cards);
  const edges = new Set(result!.edges.filter((e) => edgeFilter(e)).map((e) => e.id));
  setHighlight({ key, label, nodes, edges });
}

function treeHighlight(root: string, direction: 'downstream' | 'upstream'): Highlight {
  const tree = result!.structures.trees[root]!;
  const pairs = direction === 'downstream' ? tree.downstream : tree.upstream;
  const nodes = new Set([root, ...pairs.map(([, child]) => child)]);
  // Upstream pairs are [card, its feeder], so the real edge points feeder → card.
  const edges = new Set(pairs.map(([a, b]) => (direction === 'downstream' ? edgeKey(a, b) : edgeKey(b, a))));
  const verb = direction === 'downstream' ? 'powers' : 'is powered by';
  return { key: `tree:${direction}:${root}`, label: `${root} ${verb} ${plural(nodes.size - 1, 'card')}`, nodes, edges };
}

// ---------------------------------------------------------------------------
// Side panels

function renderFilters() {
  if (!result) return;
  const counts = new Map<EdgeKind, number>();
  for (const e of result.edges) for (const k of e.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const kinds = ALL_KINDS.filter((k) => counts.has(k));
  fill(
    filtersEl,
    ...kinds.map((kind) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = enabledKinds.has(kind);
      box.addEventListener('change', () => {
        if (box.checked) enabledKinds.add(kind);
        else enabledKinds.delete(kind);
        applyFilters();
        renderPanel();
      });
      return h('label', {}, box, swatch(kindColor(kind)), kindLabel(kind), h('span', { class: 'count' }, String(counts.get(kind))));
    }),
    kinds.length === 0 && h('p', { class: 'status' }, 'No synergies detected.'),
  );
}

function renderTabs() {
  if (!result) {
    fill(tabsEl);
    return;
  }
  const s = result.structures;
  const tabs: [Tab, string, number | null][] = [
    ['overview', 'Overview', null],
    ['combos', 'Combos', result.combos.combos.length],
    ['loops', 'Loops', s.loops.length],
    ['systems', 'Systems', s.loopSystems.length],
    ['chains', 'Chains', s.chains.length],
    ['trees', 'Trees', null],
    ['critical', 'Critical', s.loadBearing.length + s.criticalLinks.length],
  ];
  if (selectedCard) tabs.push(['card', 'Card', null]);
  fill(
    tabsEl,
    ...tabs.map(([id, label, badge]) => {
      const b = button([label, badge !== null ? ` ${badge}` : ''].join(''), () => {
        activeTab = id;
        renderPanel();
      }, '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(activeTab === id));
      return b;
    }),
  );
}

function renderPanel() {
  renderTabs();
  if (!result) {
    fill(detailsEl, h('p', { class: 'meta' }, 'Deck analysis will appear here.'));
    return;
  }
  const renderers: Record<Tab, () => Child[]> = {
    overview: renderOverview,
    combos: renderCombos,
    loops: renderLoops,
    systems: renderSystems,
    chains: renderChains,
    trees: renderTrees,
    critical: renderCritical,
    card: renderCard,
  };
  fill(detailsEl, ...renderers[activeTab]());
}

function stat(value: string, label: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
}

function renderOverview(): Child[] {
  const r = result!;
  const { insights: ins, structures: s } = r;
  const themeRows = r.themes
    .filter((t) => t.providers.length || t.wanters.length)
    .map((t) =>
      h(
        'tr',
        {},
        h('td', {}, h('span', { class: 'reason' }, swatch(kindColor(t.kind)), kindLabel(t.kind))),
        h('td', { class: 'num' }, String(t.providers.length)),
        h('td', { class: 'num' }, String(t.wanters.length)),
        h('td', { class: 'num' }, String(t.edgeCount)),
      ),
    );
  return [
    h('h2', {}, 'Deck overview'),
    h('p', { class: 'meta' }, 'Click a card for its connections. Hover an arrow to see why one card feeds another.'),
    h(
      'div',
      { class: 'stat-row' },
      stat(`${Math.round(ins.connectivity * 100)}%`, 'spells connected'),
      stat(String(r.combos.combos.length), 'combos'),
      stat(String(r.edges.length), 'links'),
      stat(String(s.loopSystems.length), 'loop systems'),
    ),
    r.deck.notFound.length > 0 && h('div', { class: 'notice' }, `Not found on Scryfall: ${r.deck.notFound.join(', ')}`),
    h('h3', {}, 'Key cards'),
    h('ol', {}, ...ins.keyCards.map((k) => h('li', {}, cardLink(k.name), h('span', { class: 'meta' }, ` · ${k.degree} links, weight ${k.weightedDegree}`)))),
    ins.isolated.length > 0 && h('h3', {}, 'No detected synergy'),
    ins.isolated.length > 0 && h('p', { class: 'meta' }, 'Cut candidates, or interactions the rules do not cover yet.'),
    ins.isolated.length > 0 && h('ul', {}, ...ins.isolated.map((n) => h('li', {}, cardLink(n)))),
    ins.unsupported.length > 0 && h('h3', {}, 'Unsupported payoffs'),
    ins.unsupported.length > 0 &&
      h('ul', {}, ...ins.unsupported.map((u) => h('li', { class: 'warn' }, `${u.label}: ${u.wanters.join(', ')} with nothing feeding them`))),
    h('h3', {}, 'Themes'),
    h(
      'table',
      { class: 'themes' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Theme'), h('th', { class: 'num' }, 'Enablers'), h('th', { class: 'num' }, 'Payoffs'), h('th', { class: 'num' }, 'Links'))),
      h('tbody', {}, ...themeRows),
    ),
    r.deck.basicLands.length > 0 && h('p', { class: 'meta' }, `Basic lands hidden: ${r.deck.basicLands.join(', ')}.`),
    h('p', { class: 'meta' }, `Engine ${r.engineVersion}. Same deck and options always give the same result.`),
  ];
}

function histogram(byLength: Record<string, number>, min: number, max: number) {
  const lengths = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const peak = Math.max(1, ...lengths.map((l) => byLength[l] ?? 0));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'histogram' },
      ...lengths.map((l) => {
        const bar = h('div', { title: `${byLength[l] ?? 0} loops of ${l} cards` });
        bar.style.height = `${((byLength[l] ?? 0) / peak) * 100}%`;
        return bar;
      }),
    ),
    h('div', { class: 'histogram-axis' }, h('span', {}, `${min} cards`), h('span', {}, `${max} cards`)),
  );
}

const SOURCE_LABEL: Record<string, string> = { spellbook: 'Commander Spellbook', engine: 'Rules engine' };

function sourceBadges(sources: string[]) {
  return h('span', { class: 'badges' }, ...sources.map((src) => h('span', { class: `badge-source ${src}` }, SOURCE_LABEL[src] ?? src)));
}

function comboHighlight(c: DetectedCombo): Highlight {
  const set = new Set(c.cards);
  const engineOrder = c.engine?.loop;
  return {
    key: `combo:${c.id}`,
    label: `Combo: ${c.cards.join(' + ')} → ${c.produces.slice(0, 2).join(', ')}`,
    nodes: set,
    edges: new Set(result!.edges.filter((e) => set.has(e.source) && set.has(e.target)).map((e) => e.id)),
    order: engineOrder ? new Map(engineOrder.map((card, i) => [card, i + 1])) : undefined,
  };
}

function comboItem(c: DetectedCombo): HTMLElement {
  const highlightKey = `combo:${c.id}`;
  const active = highlight?.key === highlightKey;
  const e = c.engine;
  const details: Child[] = active
    ? [
        c.prerequisites.length > 0 && h('div', { class: 'combo-section' }, h('strong', {}, 'Needs: '), c.prerequisites.join(' · ')),
        h('ol', { class: 'steps' }, ...c.steps.map((st) => h('li', {}, st))),
        e && e.helpers.length > 0 &&
          h(
            'div',
            { class: 'combo-section' },
            h('strong', {}, 'Extra pieces: '),
            e.helpers.map((hp) => (e.helperAlternatives[hp]?.length ? `${hp} (or ${e.helperAlternatives[hp]!.join(', ')})` : hp)).join('; '),
          ),
        e && h('div', { class: 'combo-section' }, h('strong', {}, 'Mana left over per loop: '), e.netMana),
        e && e.payoffs.length > 0 &&
          h('div', { class: 'combo-section' }, h('strong', {}, 'Payoffs in deck: '), e.payoffs.map((p) => p.card).join(', ')),
        e && e.warnings.length > 0 && h('div', { class: 'combo-section warn' }, ...e.warnings.map((w) => h('div', {}, `⚠ ${w}`))),
        c.spellbookUrl && h('a', { href: c.spellbookUrl, target: '_blank', rel: 'noopener' }, 'Open on Commander Spellbook'),
      ]
    : [];
  return button(
    frag(
      h('div', { class: 'item-title' }, c.cards.join(' + ')),
      sourceBadges(c.sources),
      h('div', { class: 'chips' }, ...c.produces.slice(0, active ? 20 : 3).map((p) => h('span', { class: 'chip' }, p))),
      ...details,
    ),
    () => setHighlight(active ? null : comboHighlight(c)),
    `item${active ? ' active' : ''}`,
  );
}

function nearMissItem(n: SpellbookNearMiss): HTMLElement {
  const inDeck = n.cards.filter((c) => !n.missing.includes(c));
  const key = `near:${n.id}`;
  return button(
    frag(
      h('div', { class: 'item-title' }, `Add ${n.missing.join(' + ')}`),
      h('div', { class: 'meta' }, `With ${inDeck.join(' + ')}`),
      h('div', { class: 'chips' }, ...n.produces.slice(0, 3).map((p) => h('span', { class: 'chip' }, p))),
      highlight?.key === key && h('a', { href: n.url, target: '_blank', rel: 'noopener' }, 'Open on Commander Spellbook'),
    ),
    () =>
      highlight?.key === key
        ? setHighlight(null)
        : setHighlight({ key, label: `${inDeck.join(' + ')} need ${n.missing.join(' + ')}`, nodes: new Set(inDeck), edges: new Set() }),
    `item${highlight?.key === key ? ' active' : ''}`,
  );
}

function renderCombos(): Child[] {
  const { combos, nearMisses, spellbook, engine } = result!.combos;
  const both = combos.filter((c) => c.sources.length === 2).length;
  const sbOnly = combos.filter((c) => c.sources.length === 1 && c.sources[0] === 'spellbook').length;
  const engineOnly = combos.filter((c) => c.sources.length === 1 && c.sources[0] === 'engine').length;
  const sbStatus =
    spellbook.status === 'ok'
      ? `Commander Spellbook data from ${new Date(spellbook.fetchedAt!).toLocaleString()}.`
      : spellbook.status === 'unavailable'
        ? `Commander Spellbook unavailable (${spellbook.error}); showing rules-engine combos only.`
        : 'Commander Spellbook lookup disabled; showing rules-engine combos only.';
  return [
    h('h2', {}, 'Combos'),
    h(
      'p',
      { class: 'meta' },
      'Infinite combos found by Commander Spellbook (a community database) and by our rules engine, which simulates each loop and checks that mana, untaps and life break even.',
    ),
    h('div', { class: spellbook.status === 'ok' ? 'meta' : 'notice' }, sbStatus),
    combos.length > 0 &&
      h('p', {}, `${plural(combos.length, 'combo')}: ${both} confirmed by both, ${sbOnly} from Spellbook only, ${engineOnly} found only by the engine.`),
    combos.length === 0 && h('p', {}, 'No complete combos in this deck.'),
    !engine.exhaustive && h('div', { class: 'notice' }, 'The engine hit its search budget; some combos may be missing.'),
    ...combos.map(comboItem),
    nearMisses.length > 0 && h('h3', {}, `One card away (${nearMisses.length})`),
    nearMisses.length > 0 && h('p', { class: 'meta' }, 'Combos from Commander Spellbook that need cards not in the deck, most popular first.'),
    ...nearMisses.map(nearMissItem),
  ];
}

function renderLoops(): Child[] {
  const { loops, loopSearch, options } = result!.structures;
  const items = loops.map((loop, i) => {
    const key = `loop:${i}`;
    const active = highlight?.key === key;
    const item = button(
      frag(
        h('div', { class: 'item-title' }, `${loop.knownCombo ? '★ Known combo · ' : ''}${loop.length} cards · avg weight ${loop.meanWeight}`),
        h('div', {}, `${loop.cards.join(' → ')} → ${loop.cards[0]}`),
        active && h('ol', { class: 'steps' }, ...loop.steps.map((s) => h('li', { class: 'reason' }, swatch(kindColor(s.kind)), s.description))),
      ),
      () => setHighlight(active ? null : loopHighlight(loop, key)),
      `item${active ? ' active' : ''}`,
    );
    return item;
  });
  return [
    h('h2', {}, 'Synergy loops'),
    h(
      'p',
      { class: 'meta' },
      `Closed cycles where each card feeds the next and the last feeds the first. Lengths ${options.minLoopLength}–${options.maxLoopLength}, ranked by average link weight.`,
    ),
    loopSearch.exhaustive
      ? h('p', {}, `Found all ${loopSearch.found} loops in this range.`)
      : h(
          'div',
          { class: 'notice' },
          `At least ${loopSearch.found.toLocaleString()} loops exist in this range; the search stopped at its step budget. Narrow the length range or raise the minimum link weight to search more of the space. Loop systems list every card that takes part in any loop.`,
        ),
    loopSearch.found > 0 && histogram(loopSearch.byLength, options.minLoopLength, options.maxLoopLength),
    loops.length > 0 && h('h3', {}, `Top ${loops.length} loops`),
    loops.length === 0 && h('p', { class: 'meta' }, 'No loops in this length range. Loop systems show how large a loop can be.'),
    ...items,
  ];
}

function renderSystems(): Child[] {
  const { loopSystems } = result!.structures;
  return [
    h('h2', {}, 'Loop systems'),
    h(
      'p',
      { class: 'meta' },
      'Groups where every card can reach every other card through synergy links (strongly connected components). Every loop lives inside one, so this is the complete map of looping structure.',
    ),
    loopSystems.length === 0 && h('p', {}, 'No loops in this deck: synergy only flows one way.'),
    ...loopSystems.map((sys) => {
      const key = `system:${sys.id}`;
      const set = new Set(sys.cards);
      return button(
        frag(
          h('div', { class: 'item-title' }, `System ${sys.id + 1} · ${sys.cards.length} cards · ${Math.round(sys.density * 100)}% dense`),
          h('div', {}, sys.cards.join(', ')),
          h('div', { class: 'meta' }, `Driven by: ${sys.kinds.slice(0, 4).map((k) => `${kindLabel(k.kind)} (${k.count})`).join(', ')}`),
          sys.feeders.length > 0 && h('div', { class: 'meta' }, `Fed by: ${sys.feeders.join(', ')}`),
          sys.outputs.length > 0 && h('div', { class: 'meta' }, `Feeds: ${sys.outputs.join(', ')}`),
        ),
        () =>
          highlight?.key === key
            ? setHighlight(null)
            : setHighlightFromCards(key, `Loop system ${sys.id + 1}: ${sys.cards.length} cards`, sys.cards, (e) => set.has(e.source) && set.has(e.target)),
        `item${highlight?.key === key ? ' active' : ''}`,
      );
    }),
  ];
}

function renderChains(): Child[] {
  const { chains } = result!.structures;
  return [
    h('h2', {}, 'Chains'),
    h('p', { class: 'meta' }, 'The longest one-way paths from pure enablers through loop systems to final payoffs.'),
    chains.length === 0 && h('p', {}, 'No multi-step chains found.'),
    ...chains.map((chain, i) => {
      const key = `chain:${i}`;
      const stageSets = chain.stages.map((s) => new Set(s.cards));
      const all = chain.stages.flatMap((s) => s.cards);
      const parts: Child[] = [h('div', { class: 'item-title' }, `${chain.stages.length} stages · ${chain.cardCount} cards`)];
      chain.stages.forEach((stage, si) => {
        if (si > 0) parts.push(h('div', { class: 'chain-arrow' }, '↓'));
        parts.push(h('div', { class: 'chain-stage' }, stage.loopSystem !== null ? `Loop system ${stage.loopSystem + 1} (${stage.cards.length} cards)` : stage.cards[0]!));
      });
      return button(
        frag(...parts),
        () =>
          highlight?.key === key
            ? setHighlight(null)
            : setHighlightFromCards(key, `Chain: ${chain.stages.map((s) => (s.loopSystem !== null ? `[system ${s.loopSystem + 1}]` : s.cards[0])).join(' → ')}`, all, (e) =>
                stageSets.some((set, si) => set.has(e.source) && (set.has(e.target) || stageSets[si + 1]?.has(e.target))),
              ),
        `item${highlight?.key === key ? ' active' : ''}`,
      );
    }),
  ];
}

function treeList(root: string, pairs: [string, string][]): HTMLElement {
  const children = new Map<string, string[]>();
  for (const [parent, child] of pairs) {
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const render = (name: string): HTMLElement => {
    const kids = children.get(name) ?? [];
    return h('li', {}, cardLink(name), kids.length > 0 && h('ul', { class: 'tree' }, ...kids.map(render)));
  };
  return h('ul', { class: 'tree root' }, render(root));
}

function renderTrees(): Child[] {
  const r = result!;
  const ranked = [...r.cards].sort(
    (a, b) => r.structures.trees[b.name]!.downstream.length - r.structures.trees[a.name]!.downstream.length || a.name.localeCompare(b.name),
  );
  const root = treeRoot ?? ranked[0]?.name;
  if (!root) return [h('p', {}, 'No cards.')];
  const tree = r.structures.trees[root]!;
  const pairs = treeDirection === 'downstream' ? tree.downstream : tree.upstream;

  const select = h('select', { 'aria-label': 'Tree root' });
  for (const c of ranked) {
    const opt = h('option', { value: c.name }, `${c.name} (${r.structures.trees[c.name]!.downstream.length} downstream)`);
    if (c.name === root) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => showTree(select.value, treeDirection));

  const dirButton = (dir: 'downstream' | 'upstream', label: string) => button(label, () => showTree(root, dir), dir === treeDirection ? '' : 'secondary');

  return [
    h('h2', {}, 'Synergy trees'),
    h(
      'p',
      { class: 'meta' },
      'Downstream: everything a card powers, directly or through other cards. Upstream: everything that powers it. Each card appears once, under its shortest (then strongest) path.',
    ),
    select,
    h('div', { class: 'tree-toggle' }, dirButton('downstream', 'Powers ↓'), dirButton('upstream', 'Powered by ↑')),
    h('p', { class: 'meta' }, `${plural(pairs.length, 'card')}, depth ${treeDirection === 'downstream' ? tree.downstreamDepth : tree.upstreamDepth}.`),
    button('Highlight in graph', () => showTree(root, treeDirection), 'secondary'),
    treeList(root, pairs),
  ];
}

function showTree(root: string, direction: 'downstream' | 'upstream') {
  treeRoot = root;
  treeDirection = direction;
  activeTab = 'trees';
  setHighlight(treeHighlight(root, direction));
}

function renderCritical(): Child[] {
  const { loadBearing, criticalLinks } = result!.structures;
  return [
    h('h2', {}, 'Load-bearing cards'),
    h('p', { class: 'meta' }, 'Removing one of these cards splits its synergy cluster into disconnected pieces.'),
    loadBearing.length === 0 && h('p', {}, 'None: the synergy web has no single point of failure.'),
    ...loadBearing.map((lb) => {
      const key = `card:${lb.card}`;
      return button(
        frag(h('div', { class: 'item-title' }, lb.card), h('div', { class: 'meta' }, `Without it the cluster splits into pieces of ${lb.splitsInto.join(', ')} cards`)),
        () => selectCard(lb.card),
        `item${highlight?.key === key ? ' active' : ''}`,
      );
    }),
    h('h3', {}, 'Critical links'),
    h('p', { class: 'meta' }, 'Single links that hold two groups of cards together.'),
    criticalLinks.length === 0 && h('p', {}, 'None.'),
    ...criticalLinks.map((cl) => {
      const [a, b] = cl.between;
      const key = `bridge:${a}|${b}`;
      return button(
        frag(h('div', { class: 'item-title' }, `${a} ↔ ${b}`), h('div', { class: 'meta' }, `Splits into ${cl.splitsInto.join(' + ')} cards`)),
        () =>
          highlight?.key === key
            ? setHighlight(null)
            : setHighlight({ key, label: `Critical link: ${a} ↔ ${b}`, nodes: new Set([a, b]), edges: new Set([edgeKey(a, b), edgeKey(b, a)]) }),
        `item${highlight?.key === key ? ' active' : ''}`,
      );
    }),
  ];
}

function tagList(title: string, tags: Record<string, string[]>) {
  const entries = Object.entries(tags);
  if (entries.length === 0) return null;
  return h(
    'div',
    {},
    h('h3', {}, title),
    h(
      'ul',
      { class: 'tag-list' },
      ...entries.map(([id, why]) => h('li', { class: 'reason' }, swatch(kindColor(id as EdgeKind)), `${THEME_BY_ID.get(id as ThemeId)?.label}: ${why.join(', ')}`)),
    ),
  );
}

function selectCard(name: string) {
  selectedCard = name;
  activeTab = 'card';
  const edges = result!.edges.filter((e) => (e.source === name || e.target === name) && visibleReasons(e).length > 0);
  const nodes = new Set([name, ...edges.flatMap((e) => [e.source, e.target])]);
  setHighlight({ key: `card:${name}`, label: `${name}: ${plural(nodes.size - 1, 'direct connection')}`, nodes, edges: new Set(edges.map((e) => e.id)) });
}

function renderCard(): Child[] {
  const card = selectedCard ? cardByName.get(selectedCard) : undefined;
  if (!card) return [h('p', {}, 'Click a card in the graph.')];
  const r = result!;
  const name = card.name;
  const connections = (dir: 'out' | 'in') =>
    r.edges
      .filter((e) => (dir === 'out' ? e.source === name : e.target === name) && visibleReasons(e).length > 0)
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const outgoing = connections('out');
  const incoming = connections('in');
  const loops = r.structures.loops.map((l, i) => [l, i] as const).filter(([l]) => l.cards.includes(name));
  const cardCombos = r.combos.combos.filter((c) => c.cards.includes(name));
  const system = r.structures.loopSystems.find((s) => s.cards.includes(name));
  const lb = r.structures.loadBearing.find((l) => l.card === name);

  const connectionList = (edges: SynergyEdge[], other: (e: SynergyEdge) => string) =>
    edges.map((e) => h('div', { class: 'connection' }, cardLink(other(e)), h('ul', { class: 'reasons' }, ...visibleReasons(e).map(reasonItem))));

  return [
    h('h2', {}, name),
    h('div', { class: 'meta' }, `${card.manaCost} · ${card.typeLine}${card.section === 'commander' ? ' · Commander' : ''}`),
    card.imageUrl ? h('img', { class: 'card-image', src: card.imageUrl, alt: name, loading: 'lazy' }) : h('div', { class: 'oracle' }, card.oracleText),
    h(
      'div',
      { class: 'tree-toggle' },
      button('Show what it powers', () => showTree(name, 'downstream'), 'secondary'),
      button('Show what powers it', () => showTree(name, 'upstream'), 'secondary'),
    ),
    system && h('p', { class: 'meta' }, `Part of loop system ${system.id + 1} (${system.cards.length} cards).`),
    lb && h('p', { class: 'warn' }, `Load-bearing: removing it splits its cluster into ${lb.splitsInto.join(', ')} cards.`),
    cardCombos.length > 0 && h('h3', {}, `In ${plural(cardCombos.length, 'combo')}`),
    ...cardCombos.map((c) =>
      button(`${c.cards.join(' + ')} · ${c.produces[0] ?? ''}`, () => {
        activeTab = 'combos';
        setHighlight(comboHighlight(c));
      }, 'item'),
    ),
    tagList('Enables', card.provides),
    tagList('Wants', card.wants),
    loops.length > 0 && h('h3', {}, `In ${loops.length} of the listed loops`),
    ...loops.slice(0, 5).map(([l, i]) =>
      button(`${l.length} cards: ${l.cards.join(' → ')}`, () => {
        activeTab = 'loops';
        setHighlight(loopHighlight(l, `loop:${i}`));
      }, 'item'),
    ),
    h('h3', {}, `Feeds (${outgoing.length})`),
    outgoing.length === 0 && h('p', { class: 'meta' }, 'Nothing.'),
    ...connectionList(outgoing, (e) => e.target),
    h('h3', {}, `Fed by (${incoming.length})`),
    incoming.length === 0 && h('p', { class: 'meta' }, 'Nothing.'),
    ...connectionList(incoming, (e) => e.source),
    card.scryfallUri && h('p', {}, h('a', { href: card.scryfallUri, target: '_blank', rel: 'noopener' }, 'View on Scryfall')),
  ];
}

// ---------------------------------------------------------------------------

$('highlight-clear').addEventListener('click', clearHighlight);
analyzeBtn.addEventListener('click', analyze);
const loadSample = (deck: string) => {
  setFile(null);
  deckInput.value = deck;
  analyze();
};
$('sample-60').addEventListener('click', () => loadSample(SAMPLE_DECK));
$('sample-edh').addEventListener('click', () => loadSample(SAMPLE_COMMANDER_DECK));
deckInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyze();
});

deckInput.value = SAMPLE_COMMANDER_DECK;
renderPanel();
analyze();
