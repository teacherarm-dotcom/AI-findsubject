const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const levelFilter = document.getElementById('levelFilter');
const categoryFilter = document.getElementById('categoryFilter');
const resultsContainer = document.getElementById('results');
const resultStats = document.getElementById('resultStats');
const statTotal = document.getElementById('statTotal');
const statPvch = document.getElementById('statPvch');
const statPvs = document.getElementById('statPvs');

let debounceTimer;

// Category icon mapping
const categoryIcons = {
  'อุตสาหกรรม': 'precision_manufacturing',
  'บริหารธุรกิจ': 'business_center',
  'คหกรรม': 'cottage',
  'อุตสาหกรรมท่องเที่ยว': 'flight_takeoff',
  'อุตสาหกรรมสุขภาพและความงาม': 'spa',
  'อุตสาหกรรมโลจิสติกส์': 'local_shipping',
  'อุตสาหกรรมอาหาร': 'restaurant',
  'ศิลปกรรมและเศรษฐกิจสร้างสรรค์': 'palette',
  'เกษตรกรรมและประมง': 'eco',
  'อุตสาหกรรมแฟชั่นและสิ่งทอ': 'checkroom',
  'อุตสาหกรรมดิจิทัลและเทคโนโลยีสารสนเทศ': 'computer',
  'อุตสาหกรรมบันเทิง': 'music_note'
};

// Load initial stats
async function loadStats() {
  const res = await fetch('/api/stats');
  const data = await res.json();
  animateNumber(statTotal, data.total);
  animateNumber(statPvch, data.pvch);
  animateNumber(statPvs, data.pvs);
}

// Animate number counting
function animateNumber(el, target) {
  const duration = 600;
  const start = performance.now();
  const from = 0;

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// Load categories
async function loadCategories() {
  const res = await fetch('/api/categories');
  const categories = await res.json();
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    categoryFilter.appendChild(opt);
  });
}

// Search
async function doSearch() {
  const q = searchInput.value.trim();
  const level = levelFilter.value;
  const category = categoryFilter.value;

  // Toggle clear button
  searchClear.hidden = !q;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (level) params.set('level', level);
  if (category) params.set('category', category);

  const res = await fetch('/api/search?' + params.toString());
  const data = await res.json();

  renderResults(data, q);
}

function highlightText(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

function renderResults(data, query) {
  const { total, results } = data;

  // Result stats
  const pvchCount = results.filter(r => r.level === 'ปวช.').length;
  const pvsCount = results.filter(r => r.level === 'ปวส.').length;

  let statsHtml = `พบ <strong>${total}</strong> สาขาวิชา`;
  if (pvchCount && pvsCount) {
    statsHtml += ` (ปวช. <strong>${pvchCount}</strong> | ปวส. <strong>${pvsCount}</strong>)`;
  }
  resultStats.innerHTML = statsHtml;

  if (results.length === 0) {
    resultsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <span class="material-symbols-rounded">search_off</span>
        </div>
        <h3>ไม่พบสาขาวิชาที่ค้นหา</h3>
        <p>ลองเปลี่ยนคำค้นหา หรือปรับตัวกรอง</p>
      </div>
    `;
    return;
  }

  // Group by category
  const grouped = {};
  results.forEach(r => {
    const key = r.category;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  let html = '';
  for (const [category, items] of Object.entries(grouped)) {
    const icon = categoryIcons[category] || 'folder';

    html += `<div class="category-group">`;
    html += `
      <div class="category-header">
        <div class="category-icon">
          <span class="material-symbols-rounded">${icon}</span>
        </div>
        <span class="category-title">${category}</span>
        <span class="category-count">${items.length}</span>
      </div>
    `;

    items.forEach(r => {
      const isPvs = r.level === 'ปวส.';
      const badgeClass = isPvs ? 'badge-pvs' : 'badge-pvch';
      const codeClass = isPvs ? 'result-code pvs' : 'result-code';
      const displayName = highlightText(r.name, query);

      html += `
        <div class="result-card">
          <div class="${codeClass}">${r.code}</div>
          <div class="result-info">
            <div class="result-name">${displayName}</div>
            <div class="result-meta">
              <span class="badge ${badgeClass}">${r.level}</span>
              <span class="result-group">${r.group}</span>
            </div>
          </div>
          <a class="btn-pdf" href="${r.pdfUrl}" target="_blank" rel="noopener">
            <span class="material-symbols-rounded">description</span>
            ดู PDF
          </a>
        </div>
      `;
    });

    html += `</div>`;
  }

  resultsContainer.innerHTML = html;
}

// Event listeners
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 250);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  searchInput.focus();
  doSearch();
});

levelFilter.addEventListener('change', doSearch);
categoryFilter.addEventListener('change', doSearch);

// Keyboard shortcut: Escape to clear search
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    searchClear.hidden = true;
    doSearch();
  }
  // Focus search with /
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

// Init
loadStats();
loadCategories();
doSearch();
