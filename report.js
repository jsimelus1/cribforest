/* =========================================================
   CribForest · Top Matches PDF report
   Uses jsPDF (loaded via CDN) to generate a buyer-facing
   one-page-per-property report with the user's filters,
   priorities, and top scoring homes.
   ========================================================= */

// Pull jsPDF off the global the UMD bundle creates
const { jsPDF } = window.jspdf || {};

// Brand palette (mirrors styles.css)
const COLOR = {
  ink:        [22, 25, 28],
  slate:      [74, 85, 96],
  parchment:  [244, 238, 226],
  paper:      [251, 248, 241],
  ember:      [200, 80, 26],
  ember_deep: [155, 60, 13],
  moss:       [77, 104, 67],
  rule:       [217, 207, 184],
  gold:       [180, 138, 60],
};

// Page geometry (US Letter, in mm: 215.9 x 279.4)
const PAGE = { w: 215.9, h: 279.4, margin: 15 };
const CONTENT_W = PAGE.w - PAGE.margin * 2;

// ---------- helpers ----------
const fmtMoney = n => {
  const x = num(n);
  return x == null ? '—' : '$' + Math.round(x).toLocaleString();
};
const fmtMoneyShort = n => {
  const x = num(n);
  if (x == null) return '—';
  if (x >= 1e6) return '$' + (x/1e6).toFixed(1) + 'M';
  if (x >= 1e3) return '$' + Math.round(x/1e3) + 'K';
  return '$' + Math.round(x);
};
const fmtNum = n => {
  const x = num(n);
  return x == null ? '—' : Math.round(x).toLocaleString();
};
const fmtTime = n => {
  const x = num(n);
  return x == null ? '—' : x.toFixed(1) + ' min';
};
const fmtDist = n => {
  const x = num(n);
  return x == null ? '—' : x.toFixed(2) + ' mi';
};

// Coerce anything number-ish to a real number; null otherwise
function num(v) {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}
const fmtDate = () => {
  const d = new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

// ---------- main entry ----------
async function generateMatchReport({ email = null, maxMatches = 10 } = {}) {
  if (!jsPDF) throw new Error('jsPDF not loaded');
  if (!window.state || !window.state.filtered) throw new Error('No matches available');

  const matches = window.state.filtered.slice(0, maxMatches);
  if (matches.length === 0) throw new Error('No properties match your filters');

  const doc = new jsPDF({ unit: 'mm', format: 'letter' });

  // ---- Cover / summary page ----
  drawCoverPage(doc, matches);

  // ---- One page per property ----
  for (let i = 0; i < matches.length; i++) {
    doc.addPage();
    drawPropertyPage(doc, matches[i], i + 1, matches.length);
  }

  // ---- Closing page ----
  doc.addPage();
  drawClosingPage(doc, matches.length);

  // ---- Footer on every page ----
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, i, pageCount);
  }

  // ---- Filename ----
  const loc = (window.state.locationLabel || 'matches').replace(/[^\w]+/g, '-').toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  const filename = `cribforest-${loc}-${date}.pdf`;

  // ---- Log lead capture if email provided ----
  if (email) {
    fetch('/api/save-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        location_label: window.state.locationLabel,
        match_count: matches.length,
        filters: serializeFilters(),
      }),
    }).catch(err => console.warn('Lead log failed (non-fatal):', err));
  }

  doc.save(filename);
  return { filename, count: matches.length };
}

// ---------- cover page ----------
function drawCoverPage(doc, matches) {
  // Top brand bar
  doc.setFillColor(...COLOR.ink);
  doc.rect(0, 0, PAGE.w, 28, 'F');

  // Logo mark (a tree)
  doc.setFillColor(...COLOR.moss);
  drawTreeIcon(doc, PAGE.margin, 10, 8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...COLOR.parchment);
  doc.text('CribForest', PAGE.margin + 12, 15);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(180, 188, 199);
  doc.text('REAL-ESTATE SCORED ON YOUR EVERYDAY LIFE', PAGE.margin + 12, 19.5);

  // Date right-aligned in bar
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.parchment);
  doc.text(fmtDate(), PAGE.w - PAGE.margin, 15, { align: 'right' });

  // Body content
  let y = 50;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('YOUR TOP MATCHES', PAGE.margin, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(...COLOR.ink);
  doc.text('Your search', PAGE.margin, y);
  y += 9;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(28);
  doc.setTextColor(...COLOR.ember_deep);
  const loc = window.state.locationLabel || 'this market';
  doc.text(`in ${loc}.`, PAGE.margin, y);
  y += 14;

  // Intro paragraph
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.slate);
  const intro = `These ${matches.length} homes scored highest against the priorities you set. Each is rated on drive time to the amenities you marked as important, on real road-network routing — not straight-line distance. Following pages have full reports for each home.`;
  const introLines = doc.splitTextToSize(intro, CONTENT_W - 5);
  doc.text(introLines, PAGE.margin, y);
  y += introLines.length * 5.5 + 8;

  // Stats panel
  drawStatsPanel(doc, matches, y);
  y += 38;

  // Search summary
  y = drawSearchSummary(doc, y);

  // Top matches list
  y += 8;
  drawTopMatchesList(doc, matches, y);
}

function drawStatsPanel(doc, matches, y) {
  const x = PAGE.margin;
  const panelW = CONTENT_W;
  const panelH = 32;
  doc.setFillColor(...COLOR.parchment);
  doc.rect(x, y, panelW, panelH, 'F');
  doc.setDrawColor(...COLOR.rule);
  doc.setLineWidth(0.2);
  doc.rect(x, y, panelW, panelH, 'S');

  // 4 stat cells
  const stats = [
    { label: 'Top matches', value: String(matches.length) },
    { label: 'Avg price', value: avgPrice(matches) },
    { label: 'Avg sqft',  value: avgSqft(matches) },
    { label: 'Perfect scores', value: countPerfect(matches) },
  ];
  const cellW = panelW / stats.length;
  stats.forEach((s, i) => {
    const cx = x + i * cellW + cellW / 2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...COLOR.ink);
    doc.text(s.value, cx, y + 16, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate);
    doc.text(s.label.toUpperCase(), cx, y + 24, { align: 'center', charSpace: 0.4 });
    if (i < stats.length - 1) {
      doc.setDrawColor(...COLOR.rule);
      doc.line(x + (i + 1) * cellW, y + 5, x + (i + 1) * cellW, y + panelH - 5);
    }
  });
}

function drawSearchSummary(doc, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('YOUR SEARCH', PAGE.margin, y);
  y += 6;

  const f = window.state.filters;
  const rows = [
    ['Price',  `${fmtMoneyShort(f.price[0])} – ${fmtMoneyShort(f.price[1])}`],
    ['Beds',   f.bedrooms > 0 ? `${f.bedrooms}+` : 'Any'],
    ['Baths',  f.bathrooms > 0 ? `${f.bathrooms}+` : 'Any'],
    ['Sqft',   `${fmtNum(f.sqft[0])} – ${fmtNum(f.sqft[1])}`],
    ['Year',   `${f.year[0]} – ${f.year[1]}`],
  ];
  rows.forEach(([label, val]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.slate);
    doc.text(label, PAGE.margin, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOR.ink);
    doc.text(val, PAGE.margin + 22, y);
    y += 5;
  });

  // Active priorities
  const active = Object.entries(f.poi).filter(([_, v]) => v.active);
  if (active.length > 0) {
    y += 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.slate);
    doc.text('Priorities', PAGE.margin, y);

    const POI_LABELS = window.POI_META || {};
    const items = active.map(([cat, cfg]) => {
      const label = (POI_LABELS[cat] && POI_LABELS[cat].label) || prettyCategory(cat);
      return `${label} <= ${cfg.max} min`;
    });
    const text = items.join('  ·  ');
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOR.ember_deep);
    const lines = doc.splitTextToSize(text, CONTENT_W - 22);
    doc.text(lines, PAGE.margin + 22, y);
    y += lines.length * 5;
  }

  return y;
}

function drawTopMatchesList(doc, matches, y) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('TOP MATCHES', PAGE.margin, y);
  y += 6;

  doc.setDrawColor(...COLOR.rule);
  doc.setLineWidth(0.2);

  matches.forEach((p, i) => {
    if (y > PAGE.h - 30) return;
    const rowY = y;
    const rank = String(i + 1).padStart(2, '0');

    // rank circle
    doc.setFillColor(...COLOR.ink);
    doc.circle(PAGE.margin + 3, rowY + 2, 3, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.parchment);
    doc.text(rank, PAGE.margin + 3, rowY + 3.2, { align: 'center' });

    // address
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.ink);
    doc.text(truncate(p.address, 50), PAGE.margin + 9, rowY + 2.5);

    // sub line
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate);
    const sub = `${p.bedrooms ?? '—'} bd · ${p.bathrooms ?? '—'} ba · ${fmtNum(p.sqft)} sqft · built ${p.year_built ?? '—'}`;
    doc.text(sub, PAGE.margin + 9, rowY + 6.5);

    // score badge
    const scoreLabel = p._total > 0 ? `${p._hits}/${p._total}` : '—';
    const scoreColor = p._total > 0 && p._score === 1 ? COLOR.moss
                      : p._total > 0 && p._score >= 0.5 ? COLOR.gold
                      : COLOR.slate;
    doc.setFillColor(...scoreColor);
    doc.roundedRect(PAGE.w - PAGE.margin - 28, rowY - 1, 12, 5, 1, 1, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text(scoreLabel, PAGE.w - PAGE.margin - 22, rowY + 2.4, { align: 'center' });

    // price
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ember_deep);
    doc.text(fmtMoneyShort(p.price), PAGE.w - PAGE.margin, rowY + 3, { align: 'right' });

    y += 11;
    if (i < matches.length - 1) {
      doc.line(PAGE.margin, y - 2, PAGE.w - PAGE.margin, y - 2);
    }
  });
}

// ---------- per-property page ----------
function drawPropertyPage(doc, p, idx, total) {
  // Header bar — slimmer than cover
  doc.setFillColor(...COLOR.ink);
  doc.rect(0, 0, PAGE.w, 18, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.parchment);
  doc.text('CribForest', PAGE.margin, 9);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(180, 188, 199);
  doc.text(`Match ${idx} of ${total}`, PAGE.w - PAGE.margin, 9, { align: 'right' });
  doc.text(window.state.locationLabel || '', PAGE.w - PAGE.margin, 13, { align: 'right' });

  let y = 28;

  // Eyebrow
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.slate);
  const eyebrow = [p.zip, p.nsa, p.zoning].filter(Boolean).join('  ·  ');
  doc.text(eyebrow, PAGE.margin, y);
  y += 5;

  // Address (large, serif-y)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...COLOR.ink);
  const addrLines = doc.splitTextToSize(p.address, CONTENT_W - 60);
  doc.text(addrLines, PAGE.margin, y + 6);
  y += addrLines.length * 7 + 3;

  // Price (right side, top)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text(fmtMoney(p.price), PAGE.w - PAGE.margin, 35, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.slate);
  const scoreLabel = p._total > 0 ? `${p._hits} OF ${p._total} PRIORITIES MET` : 'NO PRIORITIES SET';
  doc.text(scoreLabel, PAGE.w - PAGE.margin, 39, { align: 'right' });

  // Divider
  y += 4;
  doc.setDrawColor(...COLOR.rule);
  doc.setLineWidth(0.3);
  doc.line(PAGE.margin, y, PAGE.w - PAGE.margin, y);
  y += 6;

  // ---- The home ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('THE HOME', PAGE.margin, y);
  y += 5;

  const facts = [
    { num: String(p.bedrooms ?? '—'),  label: 'Bedrooms' },
    { num: String(p.bathrooms ?? '—'), label: 'Bathrooms' },
    { num: fmtNum(p.sqft),             label: 'Square feet' },
    { num: fmtNum(p.lot_size),         label: 'Lot (sqft)' },
    { num: String(p.year_built ?? '—'),label: 'Year built' },
    { num: pctChange(p.pct_value_chg), label: 'Value chg \'20–\'22' },
  ];
  drawFactsGrid(doc, facts, PAGE.margin, y, CONTENT_W);
  y += 30;

  // ---- Block-group context ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('BLOCK-GROUP CONTEXT', PAGE.margin, y);
  y += 5;

  const ctxRows = [
    ['Median household income', fmtMoney(p.median_income)],
    ['Median home value',       fmtMoney(p.median_value)],
    ['Owner-occupied',          num(p.pct_owner_occupied) != null ? Math.round(num(p.pct_owner_occupied)) + '%' : '—'],
    ['Vacant',                  num(p.pct_vacant) != null ? Math.round(num(p.pct_vacant)) + '%' : '—'],
    ['Diversity',               capitalize(p.diversity || '—')],
    ['Education score',         p.education_score || '—'],
  ];
  drawTwoColTable(doc, ctxRows, PAGE.margin, y, CONTENT_W);
  y += ctxRows.length * 5.5 + 4;

  // ---- Drive-time accessibility ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('DRIVE-TIME ACCESSIBILITY', PAGE.margin, y);
  y += 5;

  const cats = (window.state.meta && window.state.meta.poi_categories) || [];
  const accRows = cats.map(cat => {
    const a = (p.accessibility && p.accessibility[cat]) || {};
    const meta = (window.POI_META && window.POI_META[cat]) || {};
    return {
      label: meta.label || prettyCategory(cat),
      feature: a.name || a.address || '—',
      time: fmtTime(a.drive_time),
      dist: fmtDist(a.drive_distance),
      priority: window.state.filters.poi[cat] && window.state.filters.poi[cat].active,
      withinMax: a.drive_time != null && window.state.filters.poi[cat] && a.drive_time <= window.state.filters.poi[cat].max,
    };
  });
  drawAccessibilityTable(doc, accRows, PAGE.margin, y, CONTENT_W);
}

function drawFactsGrid(doc, facts, x, y, w) {
  const cols = 3;
  const rowH = 13;
  const colW = w / cols;
  facts.forEach((f, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx = x + c * colW;
    const cy = y + r * rowH;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...COLOR.ink);
    doc.text(f.num, cx, cy + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate);
    doc.text(f.label, cx, cy + 9);
  });
}

function drawTwoColTable(doc, rows, x, y, w) {
  const labelW = 70;
  doc.setDrawColor(...COLOR.rule);
  doc.setLineWidth(0.1);
  rows.forEach((r, i) => {
    const ry = y + i * 5.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.slate);
    doc.text(r[0], x, ry);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOR.ink);
    doc.text(r[1], x + labelW, ry);
    if (i < rows.length - 1) {
      doc.line(x, ry + 2, x + w, ry + 2);
    }
  });
}

function drawAccessibilityTable(doc, rows, x, y, w) {
  const cols = { label: 0, feature: 50, time: w - 30, dist: w - 12 };
  const rowH = 5.5;
  doc.setDrawColor(...COLOR.rule);
  doc.setLineWidth(0.1);
  rows.forEach((r, i) => {
    const ry = y + i * rowH;
    if (r.priority) {
      doc.setFillColor(...COLOR.parchment);
      doc.rect(x - 2, ry - 4, w + 4, rowH, 'F');
    }
    doc.setFont('helvetica', r.priority ? 'bold' : 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.ink);
    doc.text(r.label, x + cols.label, ry);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate);
    doc.text(truncate(r.feature, 32), x + cols.feature, ry);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    if (r.priority && r.withinMax) {
      doc.setTextColor(...COLOR.moss);
    } else if (r.priority && !r.withinMax) {
      doc.setTextColor(...COLOR.ember_deep);
    } else {
      doc.setTextColor(...COLOR.ink);
    }
    doc.text(r.time, x + cols.time, ry, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate);
    doc.text(r.dist, x + cols.dist, ry, { align: 'right' });

    doc.setDrawColor(...COLOR.rule);
    doc.line(x, ry + 1.5, x + w, ry + 1.5);
  });
}

// ---------- closing page ----------
function drawClosingPage(doc, count) {
  doc.setFillColor(...COLOR.ink);
  doc.rect(0, 0, PAGE.w, 18, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.parchment);
  doc.text('CribForest', PAGE.margin, 9);

  let y = 50;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...COLOR.ink);
  doc.text('Next steps', PAGE.margin, y);
  y += 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.slate);
  const closing = [
    `You looked at ${count} home${count === 1 ? '' : 's'} that scored highest against the priorities you set. The next moves are yours:`,
    '',
    '• Visit cribforest.com to refine your search or browse the full catalog.',
    '• Reach out to a local realtor with this report — it tells them exactly what you care about.',
    '• Re-run your search in a few weeks. Inventory and pricing change.',
    '',
    'Questions about how match scoring works? Each home was rated on real road-network drive times to amenities you marked important — not straight-line distance. The "5/5" scores mean every priority you set was met. Lower scores show how many were met out of how many you marked.',
  ];
  closing.forEach(line => {
    if (line === '') { y += 4; return; }
    const wrapped = doc.splitTextToSize(line, CONTENT_W);
    doc.text(wrapped, PAGE.margin, y);
    y += wrapped.length * 5.5;
  });

  // Bottom CTA card
  y = PAGE.h - 80;
  doc.setFillColor(...COLOR.parchment);
  doc.rect(PAGE.margin, y, CONTENT_W, 40, 'F');
  doc.setDrawColor(...COLOR.ember);
  doc.setLineWidth(0.6);
  doc.line(PAGE.margin, y, PAGE.w - PAGE.margin, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...COLOR.ink);
  doc.text('Find a different spot?', PAGE.margin + 6, y + 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.slate);
  doc.text('Refine filters, change priorities, or pick a new location anytime.', PAGE.margin + 6, y + 19);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.ember_deep);
  doc.text('cribforest.com', PAGE.margin + 6, y + 31);
}

// ---------- footer on every page ----------
function drawFooter(doc, page, total) {
  const y = PAGE.h - 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLOR.slate);
  doc.text('CribForest · Real-estate scored on your everyday life', PAGE.margin, y);
  doc.text(`${page} / ${total}`, PAGE.w - PAGE.margin, y, { align: 'right' });
}

// ---------- decorative tree icon ----------
function drawTreeIcon(doc, x, y, size) {
  // Simple stylized canopy: three triangles
  doc.setFillColor(...COLOR.moss);
  // tallest (centered, back)
  doc.triangle(x + size/2, y, x + size, y + size, x, y + size, 'F');
  // shorter on left
  doc.setFillColor(126, 146, 101);
  doc.triangle(x - 1, y + size*0.35, x + size*0.55, y + size*0.35, x + size*0.27, y + size, 'F');
  doc.triangle(x + size*0.45, y + size*0.35, x + size + 1, y + size*0.35, x + size*0.73, y + size, 'F');
}

// ---------- aggregate stats ----------
function avgPrice(matches) {
  const ps = matches.map(m => num(m.price)).filter(x => x != null);
  if (ps.length === 0) return '—';
  return fmtMoneyShort(ps.reduce((a, b) => a + b, 0) / ps.length);
}
function avgSqft(matches) {
  const ss = matches.map(m => num(m.sqft)).filter(x => x != null);
  if (ss.length === 0) return '—';
  return fmtNum(ss.reduce((a, b) => a + b, 0) / ss.length);
}
function countPerfect(matches) {
  return String(matches.filter(m => m._total > 0 && m._score === 1).length);
}

function pctChange(v) {
  const x = num(v);
  if (x == null) return '—';
  return (x > 0 ? '+' : '') + x.toFixed(1) + '%';
}


function capitalize(s) {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettyCategory(cat) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function serializeFilters() {
  if (!window.state || !window.state.filters) return null;
  const f = window.state.filters;
  return {
    price: f.price,
    bedrooms: f.bedrooms,
    bathrooms: f.bathrooms,
    sqft: f.sqft,
    year: f.year,
    poi: Object.fromEntries(
      Object.entries(f.poi).filter(([_, v]) => v.active).map(([k, v]) => [k, v.max])
    ),
  };
}

// ---------- UI wiring ----------
window.addEventListener('load', () => {
  const btn = document.getElementById('btn-save-matches');
  const modal = document.getElementById('save-matches-modal');
  const form = document.getElementById('save-form');
  const submitBtn = document.getElementById('save-submit');
  const msg = document.getElementById('save-msg');
  const emailInput = document.getElementById('save-email');

  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!window.state || !window.state.filtered || window.state.filtered.length === 0) {
      alert("No matches to save yet — try adjusting your filters.");
      return;
    }
    populateSummary();
    msg.textContent = '';
    msg.className = 'save-msg';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate & download PDF';
    modal.hidden = false;
    setTimeout(() => emailInput.focus(), 50);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Generating…';
    msg.textContent = 'Building your report (a few seconds)…';
    msg.className = 'save-msg progress';

    try {
      const email = emailInput.value.trim() || null;
      const result = await generateMatchReport({ email });
      msg.textContent = `✓ Downloaded ${result.filename} (${result.count} matches).`;
      msg.className = 'save-msg success';
      submitBtn.textContent = 'Download again';
      submitBtn.disabled = false;
      // Auto-close after 2.5s on success
      setTimeout(() => { modal.hidden = true; }, 2500);
    } catch (err) {
      console.error(err);
      msg.textContent = `Couldn't generate the report: ${err.message}.`;
      msg.className = 'save-msg error';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Try again';
    }
  });

  function populateSummary() {
    const f = window.state.filters;
    document.getElementById('save-summary-location').textContent =
      window.state.locationLabel || 'Current view';
    document.getElementById('save-summary-filters').textContent =
      `${fmtMoneyShort(f.price[0])}–${fmtMoneyShort(f.price[1])}` +
      (f.bedrooms > 0 ? ` · ${f.bedrooms}+ bed` : '') +
      (f.bathrooms > 0 ? ` · ${f.bathrooms}+ bath` : '') +
      ` · ${fmtNum(f.sqft[0])}–${fmtNum(f.sqft[1])} sqft`;

    const active = Object.entries(f.poi).filter(([_, v]) => v.active);
    document.getElementById('save-summary-priorities').textContent =
      active.length === 0
        ? 'None set — all homes will score equally'
        : active.map(([cat, cfg]) => {
            const label = (window.POI_META && window.POI_META[cat] && window.POI_META[cat].label)
                          || prettyCategory(cat);
            return `${label} ≤ ${cfg.max}m`;
          }).join(', ');

    const total = (window.state.filtered || []).length;
    const top = Math.min(10, total);
    document.getElementById('save-summary-count').textContent =
      `Top ${top} of ${total.toLocaleString()} homes that match your filters`;
  }
});

// Expose state for testing
window.generateMatchReport = generateMatchReport;
