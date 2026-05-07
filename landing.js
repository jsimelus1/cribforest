/* =========================================================
   CribForest landing — location autocomplete + waitlist
   ========================================================= */

const $ = sel => document.querySelector(sel);

const input    = $('#loc-input');
const clearBtn = $('#loc-clear');
const results  = $('#loc-results');
const hint     = $('#loc-hint');
const modal    = $('#waitlist-modal');
const wlForm   = $('#wl-form');
const wlEmail  = $('#wl-email');
const wlMsg    = $('#wl-msg');

// State of the currently-being-shown waitlist context
let waitlistContext = null;
let activeIndex = -1;
let currentResults = [];
let lastQuery = '';
let debounceTimer = null;

// Map result types to icon labels
const TYPE_LABEL = {
  city:  { icon: 'C', label: 'City' },
  zip:   { icon: '#', label: 'ZIP code' },
  state: { icon: 'S', label: 'State' },
};

// ------------ Autocomplete fetch ------------
async function searchLocations(q) {
  if (!q || q.length < 2) {
    currentResults = [];
    renderResults();
    return;
  }
  try {
    const r = await fetch(`/api/locations/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (q !== lastQuery) return;   // a newer query has been issued
    currentResults = data.results || [];
    activeIndex = currentResults.length ? 0 : -1;
    renderResults();
  } catch (e) {
    console.error('Search failed', e);
    hint.textContent = "Couldn't reach search. Try again in a moment.";
  }
}

function renderResults() {
  if (!currentResults.length) {
    results.innerHTML = '';
    if (lastQuery && lastQuery.length >= 2) {
      hint.textContent = `No matches for "${lastQuery}".`;
    } else {
      hint.textContent = 'Start typing — we match on city names, ZIPs, and states.';
    }
    return;
  }

  hint.textContent = `${currentResults.length} match${currentResults.length === 1 ? '' : 'es'}. Click one to continue.`;

  results.innerHTML = currentResults.map((r, idx) => {
    const meta = TYPE_LABEL[r.type] || { icon: '·', label: r.type };
    const live = r.coverage > 0;
    const cov = live
      ? `<span class="result-coverage live">${r.coverage.toLocaleString()} listed</span>`
      : `<span class="result-coverage empty">Coming soon</span>`;
    return `
      <li class="search-result ${idx === activeIndex ? 'active' : ''}"
          role="option"
          data-idx="${idx}"
          data-type="${r.type}"
          data-id="${r.id}"
          data-label="${escapeAttr(r.label)}"
          data-coverage="${r.coverage}">
        <span class="result-icon ${r.type}">${meta.icon}</span>
        <span class="result-text">
          <span class="result-label">${escapeHtml(r.label)}</span>
          <span class="result-sublabel">${meta.label}</span>
        </span>
        ${cov}
      </li>
    `;
  }).join('');

  results.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => pickResult(+el.dataset.idx));
    el.addEventListener('mouseenter', () => {
      activeIndex = +el.dataset.idx;
      updateActiveClass();
    });
  });
}

function updateActiveClass() {
  results.querySelectorAll('.search-result').forEach((el, i) => {
    el.classList.toggle('active', i === activeIndex);
  });
}

// ------------ Picking a result ------------
function pickResult(idx) {
  const r = currentResults[idx];
  if (!r) return;

  if (r.coverage > 0) {
    // Covered → go to explore page with the location scoped
    const params = new URLSearchParams();
    params.set(r.type, r.id);
    params.set('label', r.label);
    if (r.lat) params.set('lat', r.lat);
    if (r.lon) params.set('lon', r.lon);
    window.location.href = `explore.html?${params.toString()}`;
  } else {
    // Uncovered → waitlist
    showWaitlist(r);
  }
}

// ------------ Waitlist ------------
function showWaitlist(loc) {
  waitlistContext = loc;
  $('#wl-location').textContent = loc.label;
  $('#wl-title').textContent = `${loc.label} isn't covered yet`;
  $('#wl-eyebrow').textContent = 'Coming soon';
  wlMsg.textContent = '';
  wlMsg.className = 'wl-msg';
  wlForm.style.display = '';
  modal.hidden = false;
  setTimeout(() => wlEmail.focus(), 50);
}

wlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!waitlistContext) return;

  const email = wlEmail.value.trim();
  const role  = wlForm.querySelector('input[name=role]:checked')?.value || 'other';

  wlMsg.textContent = 'Submitting…';
  wlMsg.className = 'wl-msg';

  try {
    const r = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        locationType: waitlistContext.type,
        locationId: waitlistContext.id,
        locationLabel: waitlistContext.label,
        userRole: role,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    wlMsg.textContent = `You're on the list. We'll email ${email} when ${waitlistContext.label} goes live.`;
    wlMsg.className = 'wl-msg success';
    wlForm.querySelector('button[type=submit]').disabled = true;
    setTimeout(() => {
      modal.hidden = true;
      wlForm.querySelector('button[type=submit]').disabled = false;
      wlForm.reset();
    }, 3500);
  } catch (err) {
    wlMsg.textContent = `Couldn't add you to the list: ${err.message}. Try again?`;
    wlMsg.className = 'wl-msg error';
  }
});

// ------------ Input wiring ------------
input.addEventListener('input', e => {
  const q = e.target.value.trim();
  clearBtn.hidden = q.length === 0;
  lastQuery = q;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => searchLocations(q), 180);
});

input.addEventListener('keydown', e => {
  if (!currentResults.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % currentResults.length;
    updateActiveClass();
    scrollActiveIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = activeIndex <= 0 ? currentResults.length - 1 : activeIndex - 1;
    updateActiveClass();
    scrollActiveIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIndex >= 0) pickResult(activeIndex);
  } else if (e.key === 'Escape') {
    input.value = '';
    lastQuery = '';
    currentResults = [];
    renderResults();
    clearBtn.hidden = true;
  }
});

function scrollActiveIntoView() {
  const el = results.querySelector('.search-result.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

clearBtn.addEventListener('click', () => {
  input.value = '';
  lastQuery = '';
  currentResults = [];
  renderResults();
  clearBtn.hidden = true;
  input.focus();
});

// Close modal handlers
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => {
    modal.hidden = true;
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
});

// ------------ Helpers ------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Auto-focus search on load
window.addEventListener('load', () => {
  setTimeout(() => input.focus(), 100);
});
