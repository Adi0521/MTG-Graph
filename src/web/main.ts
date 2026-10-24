import cytoscape from 'cytoscape';
import { toCard } from './card.ts';
import { parseDecklist } from './decklist.ts';
import { EDGE_KIND_META, buildGraph, insights, type EdgeKind, type SynergyEdge, type SynergyGraph, type SynergyReason } from './graph.ts';
import { THEME_BY_ID } from './rules.ts';
import { SAMPLE_DECK } from './sample-deck.ts';
import { fetchCards } from './scryfall.ts';
import type { Card } from './types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deckInput = $<HTMLTextAreaElement>('decklist');
const analyzeBtn = $<HTMLButtonElement>('analyze');
const sampleBtn = $<HTMLButtonElement>('load-sample');
const statusEl = $('status');
const filtersEl = $('filters');
const graphEl = $('graph');
const tooltipEl = $('tooltip');
const emptyEl = $('empty');
const detailsEl = $('details');
detailsEl.classList.add('details');

const COLOR_IDENTITY: Record<string, string> = {
  W: '#e9e2b8',
  U: '#3b82c4',
  B: '#6b5b73',
  R: '#d9442b',
  G: '#3c9a5f',
};
const MULTICOLOR = '#d4af37';
const COLORLESS = '#9ca3af';

const ALL_KINDS = Object.keys(EDGE_KIND_META) as EdgeKind[];
const enabledKinds = new Set<EdgeKind>(ALL_KINDS);

let cy: cytoscape.Core | null = null;
let graph: SynergyGraph | null = null;
let selected: string | null = null;

/** Tiny element builder: h('div', { class: 'x' }, 'text', child). Text is never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** replaceChildren that skips conditional (falsy) children, like h(). */
function fill(el: HTMLElement, ...children: (Node | string | null | undefined | false)[]) {
  el.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
}

function swatch(color: string) {
  const s = h('span', { class: 'swatch' });
  s.style.background = color;
  return s;
}

function identityColor(card: Card): string {
  const ci = card.colorIdentity;
  if (ci.length === 0) return COLORLESS;
  if (ci.length > 1) return MULTICOLOR;
  return COLOR_IDENTITY[ci[0]!] ?? COLORLESS;
}

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

const visibleReasons = (edge: SynergyEdge) => edge.reasons.filter((r) => enabledKinds.has(r.kind));

// ---------------------------------------------------------------------------
// Analysis

async function analyze() {
  const entries = parseDecklist(deckInput.value).filter((e) => e.section !== 'sideboard');
  if (entries.length === 0) {
    setStatus('No cards found in the decklist.', true);
    return;
  }
  analyzeBtn.disabled = true;
  setStatus(`Looking up ${entries.length} cards on Scryfall…`);
  try {
    const { cards: found, notFound } = await fetchCards(entries.map((e) => e.name));
    const byName = new Map<string, Card>();
    for (const entry of entries) {
      const raw = found.get(entry.name.toLowerCase());
      if (!raw) continue;
      const existing = byName.get(raw.name);
      if (existing) existing.quantity += entry.quantity;
      else byName.set(raw.name, toCard(raw, entry.quantity));
    }
    graph = buildGraph([...byName.values()]);
    selected = null;
    renderFilters();
    renderGraph();
    renderInsights();
    const total = [...byName.values()].reduce((n, c) => n + c.quantity, 0);
    const missing = notFound.length ? ` Not found: ${notFound.join(', ')}.` : '';
    setStatus(`${total} cards, ${graph.nodes.length} unique in graph, ${graph.edges.length} synergy links.${missing}`, notFound.length > 0);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Graph rendering

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function primaryKind(edge: SynergyEdge): EdgeKind {
  return (visibleReasons(edge)[0] ?? edge.reasons[0]!).kind;
}

function renderGraph() {
  if (!graph) return;
  cy?.destroy();
  emptyEl.hidden = graph.nodes.length > 0;

  const maxWeighted = Math.max(1, ...graph.nodes.map((n) => n.weightedDegree));
  const count = graph.nodes.length;
  // Deterministic starting positions: a circle in name order, grouped by component.
  const ordered = [...graph.nodes].sort((a, b) => a.component - b.component || a.card.name.localeCompare(b.card.name));
  const radius = Math.max(200, count * 14);

  const elements: cytoscape.ElementDefinition[] = [
    ...ordered.map((n, i) => ({
      group: 'nodes' as const,
      data: {
        id: n.card.name,
        label: n.card.quantity > 1 ? `${n.card.name} ×${n.card.quantity}` : n.card.name,
        art: n.card.artUrl ?? '',
        color: identityColor(n.card),
        size: 34 + 46 * Math.sqrt(n.weightedDegree / maxWeighted),
      },
      position: {
        x: radius * Math.cos((2 * Math.PI * i) / count),
        y: radius * Math.sin((2 * Math.PI * i) / count),
      },
    })),
    ...graph.edges.map((e) => ({
      group: 'edges' as const,
      data: { id: e.id, source: e.source, target: e.target, weight: e.weight, color: EDGE_KIND_META[primaryKind(e)].color },
    })),
  ];

  cy = cytoscape({
    container: graphEl,
    elements,
    minZoom: 0.15,
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
          'text-max-width': '110px',
          'text-background-color': cssVar('--graph-label-bg'),
          'text-background-opacity': 0.8,
          'text-background-padding': '1px',
        },
      },
      { selector: 'node[art != ""]', style: { 'background-image': 'data(art)' } },
      {
        selector: 'edge',
        style: {
          width: 'mapData(weight, 1, 12, 1, 7)',
          'line-color': 'data(color)',
          opacity: 0.65,
          'curve-style': 'haystack',
        },
      },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.faded', style: { opacity: 0.12 } },
      { selector: 'node.focus', style: { 'border-width': 5, 'border-color': cssVar('--accent') } },
      { selector: 'edge.focus', style: { opacity: 1 } },
    ],
    layout: {
      name: 'cose',
      randomize: false,
      animate: false,
      fit: true,
      padding: 40,
      nodeRepulsion: () => 9000,
      idealEdgeLength: (edge: cytoscape.EdgeSingular) => 160 - 8 * Math.min(10, edge.data('weight')),
      edgeElasticity: () => 100,
      gravity: 0.6,
      numIter: 1500,
    } as cytoscape.CoseLayoutOptions,
  });

  cy.on('tap', 'node', (evt) => selectCard(evt.target.id()));
  cy.on('tap', (evt) => {
    if (evt.target === cy) selectCard(null);
  });
  cy.on('mouseover', 'edge', (evt) => showEdgeTooltip(evt.target.id(), evt.renderedPosition));
  cy.on('mousemove', 'edge', (evt) => positionTooltip(evt.renderedPosition));
  cy.on('mouseout', 'edge', () => (tooltipEl.hidden = true));
  cy.on('mouseover', 'node', () => (graphEl.style.cursor = 'pointer'));
  cy.on('mouseout', 'node', () => (graphEl.style.cursor = ''));

  applyFilters();
}

function applyFilters() {
  if (!cy || !graph) return;
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  cy.batch(() => {
    cy!.edges().forEach((el) => {
      const edge = edgeById.get(el.id())!;
      const visible = visibleReasons(edge).length > 0;
      el.toggleClass('hidden', !visible);
      if (visible) el.data('color', EDGE_KIND_META[primaryKind(edge)].color);
    });
  });
  highlight();
}

/** Fade everything outside the selected card's neighborhood. */
function highlight() {
  if (!cy) return;
  cy.batch(() => {
    cy!.elements().removeClass('faded focus');
    if (!selected) return;
    const node = cy!.getElementById(selected);
    if (node.empty()) return;
    const edges = node.connectedEdges(':visible');
    const hood = edges.connectedNodes().union(node).union(edges);
    cy!.elements().not(hood).addClass('faded');
    node.addClass('focus');
    edges.addClass('focus');
  });
}

function reasonItem(r: SynergyReason) {
  return h('li', { class: 'reason' }, swatch(EDGE_KIND_META[r.kind].color), h('span', {}, r.description));
}

function showEdgeTooltip(edgeId: string, pos: cytoscape.Position) {
  const edge = graph?.edges.find((e) => e.id === edgeId);
  if (!edge) return;
  tooltipEl.replaceChildren(
    h('strong', {}, `${edge.source} ↔ ${edge.target}`),
    h('ul', {}, ...visibleReasons(edge).map(reasonItem)),
  );
  tooltipEl.hidden = false;
  positionTooltip(pos);
}

function positionTooltip(pos: cytoscape.Position) {
  const pad = 14;
  const { clientWidth: w, clientHeight: hgt } = graphEl;
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  tooltipEl.style.left = `${Math.min(pos.x + pad, w - tw - 4)}px`;
  tooltipEl.style.top = `${Math.min(pos.y + pad, hgt - th - 4)}px`;
}

// ---------------------------------------------------------------------------
// Side panels

function renderFilters() {
  if (!graph) return;
  const counts = new Map<EdgeKind, number>();
  for (const e of graph.edges) for (const k of e.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const kinds = ALL_KINDS.filter((k) => counts.has(k));
  filtersEl.replaceChildren(
    ...(kinds.length ? kinds : []).map((kind) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = enabledKinds.has(kind);
      box.addEventListener('change', () => {
        if (box.checked) enabledKinds.add(kind);
        else enabledKinds.delete(kind);
        applyFilters();
        if (selected) renderCardDetails(selected);
      });
      return h('label', {}, box, swatch(EDGE_KIND_META[kind].color), EDGE_KIND_META[kind].label, h('span', { class: 'count' }, String(counts.get(kind))));
    }),
  );
  if (!kinds.length) filtersEl.append(h('p', { class: 'status' }, 'No synergies detected.'));
}

function cardLink(name: string) {
  const b = h('button', { class: 'link', type: 'button' }, name);
  b.addEventListener('click', () => selectCard(name));
  return b;
}

function selectCard(name: string | null) {
  selected = name;
  highlight();
  if (name) renderCardDetails(name);
  else renderInsights();
}

function renderInsights() {
  if (!graph) {
    detailsEl.replaceChildren(h('p', { class: 'meta' }, 'Deck insights will appear here.'));
    return;
  }
  const ins = insights(graph);
  const stat = (value: string, label: string) => h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));

  const themeRows = graph.themes
    .filter((t) => t.providers.length || t.wanters.length)
    .map((t) =>
      h(
        'tr',
        {},
        h('td', {}, h('span', { class: 'reason' }, swatch(EDGE_KIND_META[t.kind].color), EDGE_KIND_META[t.kind].label)),
        h('td', { class: 'num' }, String(t.providers.length)),
        h('td', { class: 'num' }, String(t.wanters.length)),
        h('td', { class: 'num' }, String(t.edgeCount)),
      ),
    );

  fill(
    detailsEl,
    h('h2', {}, 'Deck insights'),
    h('p', { class: 'meta' }, 'Click a card to see its connections. Hover a line to see why two cards connect.'),
    h(
      'div',
      { class: 'stat-row' },
      stat(`${Math.round(ins.connectivity * 100)}%`, 'spells connected'),
      stat(String(graph.edges.length), 'links'),
      stat(String(graph.components.filter((c) => c.length > 1).length), 'clusters'),
    ),
    h('h3', {}, 'Key cards'),
    h('ol', {}, ...ins.keyCards.map((n) => h('li', {}, cardLink(n.card.name), h('span', { class: 'meta' }, ` · ${n.degree} links, weight ${n.weightedDegree}`)))),
    ins.isolated.length > 0 && h('h3', {}, 'No detected synergy'),
    ins.isolated.length > 0 &&
      h(
        'div',
        {},
        h('p', { class: 'meta' }, 'Cut candidates, or interactions the rules do not cover yet.'),
        h('ul', {}, ...ins.isolated.map((n) => h('li', {}, cardLink(n.card.name)))),
      ),
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
    graph.excluded.length > 0 && h('p', { class: 'meta' }, `Basic lands hidden: ${graph.excluded.map((c) => c.name).join(', ')}.`),
  );
}

function tagList(title: string, tags: Map<string, string[]>) {
  if (tags.size === 0) return null;
  return h(
    'div',
    {},
    h('h3', {}, title),
    h(
      'ul',
      { class: 'tag-list' },
      ...[...tags].map(([id, why]) =>
        h('li', { class: 'reason' }, swatch(EDGE_KIND_META[id as EdgeKind].color), `${THEME_BY_ID.get(id as never)?.label}: ${why.join(', ')}`),
      ),
    ),
  );
}

function renderCardDetails(name: string) {
  const node = graph?.nodes.find((n) => n.card.name === name);
  if (!graph || !node) return;
  const { card } = node;

  const connections = graph.edges
    .filter((e) => (e.source === name || e.target === name) && visibleReasons(e).length > 0)
    .map((e) => ({ other: e.source === name ? e.target : e.source, edge: e, weight: visibleReasons(e).reduce((s, r) => s + r.weight, 0) }))
    .sort((a, b) => b.weight - a.weight || a.other.localeCompare(b.other));

  const back = h('button', { class: 'link', type: 'button' }, '← Deck insights');
  back.addEventListener('click', () => selectCard(null));

  fill(
    detailsEl,
    back,
    h('h2', {}, card.name),
    h('div', { class: 'meta' }, `${card.manaCost} · ${card.typeLine}`),
    card.imageUrl ? h('img', { class: 'card-image', src: card.imageUrl, alt: card.name, loading: 'lazy' }) : h('div', { class: 'oracle' }, card.oracleText),
    tagList('Enables', node.tags.provides),
    tagList('Wants', node.tags.wants),
    h('h3', {}, `Connections (${connections.length})`),
    connections.length === 0 && h('p', { class: 'meta' }, 'No synergies detected for this card.'),
    ...connections.map(({ other, edge }) =>
      h(
        'div',
        { class: 'connection' },
        cardLink(other),
        h('ul', { class: 'reasons' }, ...visibleReasons(edge).map(reasonItem)),
      ),
    ),
    card.scryfallUri && h('p', {}, h('a', { href: card.scryfallUri, target: '_blank', rel: 'noopener' }, 'View on Scryfall')),
  );
}

// ---------------------------------------------------------------------------

deckInput.value = SAMPLE_DECK;
analyzeBtn.addEventListener('click', analyze);
sampleBtn.addEventListener('click', () => {
  deckInput.value = SAMPLE_DECK;
  analyze();
});
deckInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyze();
});
renderInsights();
analyze();
