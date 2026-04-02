const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const levelFilter = document.getElementById('levelFilter');
const categoryFilter = document.getElementById('categoryFilter');
const resultsContainer = document.getElementById('results');
const resultStats = document.getElementById('resultStats');
const statTotal = document.getElementById('statTotal');
const statPvch = document.getElementById('statPvch');
const statPvs = document.getElementById('statPvs');
const statSubjects = document.getElementById('statSubjects');
const acDropdown = document.getElementById('autocompleteDropdown');
const acList = document.getElementById('autocompleteList');

let debounceTimer;
let acDebounceTimer;
let currentTab = 'all'; // 'all', 'departments', 'subjects'
let acActiveIndex = -1;
let acSuppressed = false; // suppress autocomplete when full search fires

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

// ===== Stats =====
async function loadStats() {
  const res = await fetch('/api/stats');
  const data = await res.json();
  animateNumber(statTotal, data.total);
  animateNumber(statPvch, data.pvch);
  animateNumber(statPvs, data.pvs);
  if (statSubjects) animateNumber(statSubjects, data.subjects);
}

function animateNumber(el, target) {
  if (!el) return;
  const duration = 600;
  const start = performance.now();
  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ===== Categories =====
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

// ===== Autocomplete =====
async function doAutocomplete() {
  const q = searchInput.value.trim();

  if (!q || q.length < 1 || acSuppressed) {
    hideAutocomplete();
    return;
  }

  try {
    const res = await fetch('/api/autocomplete?q=' + encodeURIComponent(q));
    if (acSuppressed) return; // Full search already fired, don't show autocomplete
    const data = await res.json();
    if (acSuppressed) return;
    renderAutocomplete(data, q);
  } catch (e) {
    hideAutocomplete();
  }
}

function renderAutocomplete(data, query) {
  const { departments, subjects } = data;

  if (departments.length === 0 && subjects.length === 0) {
    acList.innerHTML = `
      <div class="ac-no-result">
        <span class="material-symbols-rounded">search_off</span>
        ไม่พบข้อมูลที่ตรงกัน
      </div>
    `;
    acDropdown.hidden = false;
    acActiveIndex = -1;
    return;
  }

  let html = '';

  // Department suggestions
  if (departments.length > 0) {
    html += `<div class="ac-section-label">
      <span class="material-symbols-rounded">school</span> สาขาวิชา
    </div>`;

    departments.forEach((d, i) => {
      const isPvs = d.level === 'ปวส.';
      const badgeClass = isPvs ? 'pvs' : 'pvch';
      html += `
        <div class="ac-item ac-dept" data-index="${i}" data-type="dept" data-code="${d.code}" data-name="${d.name}">
          <div class="ac-item-code">${d.code}</div>
          <div class="ac-item-info">
            <div class="ac-item-name">${highlightText(d.name, query)}</div>
            <div class="ac-item-meta">${d.category} / ${d.group}</div>
          </div>
          <span class="ac-item-badge ${badgeClass}">${d.level}</span>
        </div>
      `;
    });
  }

  // Subject suggestions
  if (subjects.length > 0) {
    html += `<div class="ac-section-label">
      <span class="material-symbols-rounded">library_books</span> รายวิชา
    </div>`;

    subjects.forEach((s, i) => {
      const isPvs = s.level === 'ปวส.';
      const badgeClass = isPvs ? 'pvs' : 'pvch';
      html += `
        <div class="ac-item ac-subject" data-index="${departments.length + i}" data-type="subject" data-code="${s.code}" data-name="${s.nameTh}">
          <div class="ac-item-code">${s.code}</div>
          <div class="ac-item-info">
            <div class="ac-item-name">${highlightText(s.nameTh, query)}</div>
            <div class="ac-item-meta">${s.deptName} ${s.credit ? '• ' + s.credit : ''}</div>
          </div>
          <span class="ac-item-badge ${badgeClass}">${s.level}</span>
        </div>
      `;
    });
  }

  // Footer hint
  html += `<div class="ac-footer">
    กด <kbd>Enter</kbd> เพื่อค้นหา &nbsp; <kbd>↑</kbd><kbd>↓</kbd> เลือก &nbsp; <kbd>Esc</kbd> ปิด
  </div>`;

  acList.innerHTML = html;
  acDropdown.hidden = false;
  acActiveIndex = -1;

  // Add click handlers
  acList.querySelectorAll('.ac-item').forEach(item => {
    item.addEventListener('click', () => {
      const name = item.dataset.name;
      const code = item.dataset.code;
      searchInput.value = item.dataset.type === 'subject' ? code : name;
      hideAutocomplete();
      doSearch();
    });
  });
}

function hideAutocomplete() {
  acDropdown.hidden = true;
  acActiveIndex = -1;
}

function navigateAutocomplete(direction) {
  const items = acList.querySelectorAll('.ac-item');
  if (items.length === 0) return;

  // Remove old active
  if (acActiveIndex >= 0 && acActiveIndex < items.length) {
    items[acActiveIndex].classList.remove('active');
  }

  acActiveIndex += direction;
  if (acActiveIndex < 0) acActiveIndex = items.length - 1;
  if (acActiveIndex >= items.length) acActiveIndex = 0;

  items[acActiveIndex].classList.add('active');
  items[acActiveIndex].scrollIntoView({ block: 'nearest' });
}

function selectAutocompleteItem() {
  const items = acList.querySelectorAll('.ac-item');
  if (acActiveIndex >= 0 && acActiveIndex < items.length) {
    const item = items[acActiveIndex];
    const code = item.dataset.code;
    const name = item.dataset.name;
    searchInput.value = item.dataset.type === 'subject' ? code : name;
    hideAutocomplete();
    doSearch();
    return true;
  }
  return false;
}

// ===== Search =====
async function doSearch() {
  const q = searchInput.value.trim();
  const level = levelFilter.value;
  const category = categoryFilter.value;

  searchClear.hidden = !q;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (level) params.set('level', level);
  if (category) params.set('category', category);
  if (currentTab !== 'all') params.set('type', currentTab);

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
  const { totalDepartments, totalSubjects, departments: depts, subjects: subjs } = data;

  // Result stats line
  let statsHtml = '';
  if (totalDepartments > 0 || totalSubjects > 0) {
    const parts = [];
    if (totalDepartments > 0) parts.push(`<strong>${totalDepartments}</strong> สาขาวิชา`);
    if (totalSubjects > 0) parts.push(`<strong>${totalSubjects}</strong> รายวิชา`);
    statsHtml = 'พบ ' + parts.join(' และ ');
  }
  resultStats.innerHTML = statsHtml;

  // Tabs
  let html = '';
  if (query && (totalDepartments > 0 || totalSubjects > 0)) {
    html += `
      <div class="result-tabs">
        <button class="result-tab ${currentTab === 'all' ? 'active' : ''}" data-tab="all">
          <span class="material-symbols-rounded">apps</span>
          ทั้งหมด
          <span class="tab-count">${totalDepartments + totalSubjects}</span>
        </button>
        <button class="result-tab ${currentTab === 'departments' ? 'active' : ''}" data-tab="departments">
          <span class="material-symbols-rounded">school</span>
          สาขาวิชา
          <span class="tab-count">${totalDepartments}</span>
        </button>
        <button class="result-tab ${currentTab === 'subjects' ? 'active' : ''}" data-tab="subjects">
          <span class="material-symbols-rounded">library_books</span>
          รายวิชา
          <span class="tab-count">${totalSubjects}</span>
        </button>
      </div>
    `;
  }

  // Empty state
  if (depts.length === 0 && subjs.length === 0) {
    if (query) {
      html += `
        <div class="empty-state">
          <div class="empty-icon">
            <span class="material-symbols-rounded">search_off</span>
          </div>
          <h3>ไม่พบข้อมูลที่ค้นหา</h3>
          <p>ลองเปลี่ยนคำค้นหา หรือปรับตัวกรอง</p>
        </div>
      `;
    }
    resultsContainer.innerHTML = html;
    attachTabListeners();
    return;
  }

  // Departments section
  if (depts.length > 0 && currentTab !== 'subjects') {
    // Group by category
    const grouped = {};
    depts.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    });

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
  }

  // Subjects section
  if (subjs.length > 0 && currentTab !== 'departments') {
    // Group subjects by department
    const grouped = {};
    subjs.forEach(s => {
      const key = s.deptCode;
      if (!grouped[key]) {
        grouped[key] = {
          deptCode: s.deptCode,
          deptName: s.deptName,
          level: s.level,
          category: s.category,
          pdfUrl: s.pdfUrl,
          items: []
        };
      }
      grouped[key].items.push(s);
    });

    for (const [deptCode, group] of Object.entries(grouped)) {
      const icon = categoryIcons[group.category] || 'folder';
      const isPvs = group.level === 'ปวส.';
      const badgeClass = isPvs ? 'pvs' : 'pvch';

      html += `
        <div class="dept-header">
          <div class="dept-icon">
            <span class="material-symbols-rounded">${icon}</span>
          </div>
          <div>
            <div class="dept-title">${group.deptName} <span class="ac-item-badge ${badgeClass}">${group.level}</span></div>
            <div class="dept-subtitle">${group.category} • ${deptCode}</div>
          </div>
          <span class="dept-count">${group.items.length} วิชา</span>
        </div>
      `;

      group.items.forEach(s => {
        const cardId = `detail-${s.code}-${s.deptCode}`.replace(/[^a-zA-Z0-9-]/g, '_');
        html += `
          <div class="subject-card" data-code="${s.code}" data-dept="${s.deptCode}" data-pdf="${s.pdfUrl}" onclick="toggleDetail(this, '${cardId}')">
            <div class="subject-code">${highlightText(s.code, query)}</div>
            <div class="subject-info">
              <div class="subject-name-th">${highlightText(s.nameTh, query)}</div>
              ${s.nameEn ? `<div class="subject-name-en">${highlightText(s.nameEn, query)}</div>` : ''}
              <div class="subject-meta">
                ${s.credit ? `<span class="subject-credit">${s.credit}</span>` : ''}
              </div>
            </div>
            <div class="subject-actions" onclick="event.stopPropagation()">
              <a class="btn-download-doc" href="/api/generate-doc?code=${encodeURIComponent(s.code)}&dept=${encodeURIComponent(s.deptCode)}" title="ดาวน์โหลด Word">
                <span class="material-symbols-rounded">download</span>
                Word
              </a>
              <a class="btn-pdf" href="${s.pdfUrl}" target="_blank" rel="noopener" title="ดูหลักสูตร ${group.deptName}">
                <span class="material-symbols-rounded">description</span>
                PDF
              </a>
            </div>
          </div>
          <div class="subject-detail" id="${cardId}" style="display:none;"></div>
        `;
      });
    }
  }

  resultsContainer.innerHTML = html;
  attachTabListeners();
}

function attachTabListeners() {
  document.querySelectorAll('.result-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentTab = tab.dataset.tab;
      doSearch();
    });
  });
}

// ===== Event listeners =====
searchInput.addEventListener('input', () => {
  // Reset suppression on new input
  acSuppressed = false;

  // Autocomplete (fast, shows suggestions)
  clearTimeout(acDebounceTimer);
  acDebounceTimer = setTimeout(doAutocomplete, 150);

  // Full search (slower, shows full results)
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    acSuppressed = true; // Prevent autocomplete from showing after this
    clearTimeout(acDebounceTimer);
    hideAutocomplete();
    doSearch();
  }, 500);
});

searchInput.addEventListener('keydown', (e) => {
  if (!acDropdown.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateAutocomplete(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateAutocomplete(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!selectAutocompleteItem()) {
        hideAutocomplete();
        doSearch();
      }
    } else if (e.key === 'Escape') {
      hideAutocomplete();
      acJustClosed = true;
      setTimeout(() => { acJustClosed = false; }, 50);
    }
  } else if (e.key === 'Enter') {
    clearTimeout(debounceTimer);
    doSearch();
  }
});

// Close autocomplete on click outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrapper')) {
    hideAutocomplete();
  }
});

searchInput.addEventListener('focus', () => {
  const q = searchInput.value.trim();
  if (q.length >= 1 && !acSuppressed) {
    doAutocomplete();
  }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  searchInput.focus();
  hideAutocomplete();
  currentTab = 'all';
  doSearch();
});

levelFilter.addEventListener('change', doSearch);
categoryFilter.addEventListener('change', doSearch);

// Keyboard shortcut: Escape to clear search, / to focus
let acJustClosed = false;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (acJustClosed) {
      acJustClosed = false;
      return; // Don't clear search if we just closed autocomplete
    }
    if (searchInput.value && acDropdown.hidden) {
      searchInput.value = '';
      searchClear.hidden = true;
      currentTab = 'all';
      doSearch();
    }
  }
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ===== Toggle Subject Detail =====
async function toggleDetail(card, detailId) {
  const detailDiv = document.getElementById(detailId);
  if (!detailDiv) return;

  // If already open, close it
  if (detailDiv.style.display !== 'none') {
    detailDiv.style.display = 'none';
    card.classList.remove('subject-card-active');
    return;
  }

  // If already loaded, just show
  if (detailDiv.dataset.loaded) {
    detailDiv.style.display = 'block';
    card.classList.add('subject-card-active');
    return;
  }

  const code = card.dataset.code;
  const dept = card.dataset.dept;
  const pdfUrl = card.dataset.pdf;

  // Show loading
  detailDiv.style.display = 'block';
  card.classList.add('subject-card-active');
  detailDiv.innerHTML = `
    <div class="detail-loading">
      <span class="material-symbols-rounded spinning">progress_activity</span>
      กำลังดึงข้อมูลหลักสูตรรายวิชา...
    </div>
  `;

  try {
    const res = await fetch(`/api/subject-detail?code=${encodeURIComponent(code)}&dept=${encodeURIComponent(dept)}`);
    const data = await res.json();

    if (!data.success) {
      detailDiv.innerHTML = `<div class="detail-error"><span class="material-symbols-rounded">error</span> ${data.error || 'ไม่สามารถดึงข้อมูลได้'}</div>`;
      return;
    }

    const pageInfo = data.pdfPage > 0
      ? `<a class="detail-page-badge" href="${data.pdfUrl}" target="_blank" rel="noopener"><span class="material-symbols-rounded">menu_book</span> แผ่นที่ ${data.pdfPage}</a>`
      : '';

    detailDiv.innerHTML = `
      <div class="detail-content">
        <div class="detail-header">
          <div class="detail-title">
            <span class="detail-code">${data.courseCode}</span>
            <span class="detail-name">${data.courseName}</span>
            ${data.courseNameEn ? `<span class="detail-name-en">${data.courseNameEn}</span>` : ''}
          </div>
          <div class="detail-badges">
            <span class="detail-credit"><span class="material-symbols-rounded">school</span> ${data.credit}</span>
            ${pageInfo}
          </div>
        </div>
        <div class="detail-sections">
          ${dept !== '20000' && dept !== '30000' ? `<div class="detail-section">
            <div class="detail-section-title"><span class="material-symbols-rounded">verified</span> อ้างอิงมาตรฐานอาชีพ</div>
            <div class="detail-section-body">${escapeHtml(data.standardRef || '-')}</div>
          </div>` : ''}
          <div class="detail-section">
            <div class="detail-section-title"><span class="material-symbols-rounded">emoji_objects</span> ผลลัพธ์การเรียนรู้ระดับรายวิชา</div>
            <div class="detail-section-body">${formatDetailText(data.learningOutcomes)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title"><span class="material-symbols-rounded">target</span> จุดประสงค์รายวิชา</div>
            <div class="detail-section-body">${formatDetailText(data.objectives)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title"><span class="material-symbols-rounded">psychology</span> สมรรถนะรายวิชา</div>
            <div class="detail-section-body">${formatDetailText(data.competencies)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title"><span class="material-symbols-rounded">description</span> คำอธิบายรายวิชา</div>
            <div class="detail-section-body">${formatDetailText(data.description)}</div>
          </div>
        </div>
      </div>
    `;
    detailDiv.dataset.loaded = 'true';

  } catch (e) {
    detailDiv.innerHTML = `<div class="detail-error"><span class="material-symbols-rounded">error</span> เกิดข้อผิดพลาด: ${e.message}</div>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDetailText(text) {
  if (!text) return '<span class="text-muted">-</span>';
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// ===== Find PDF Page =====
async function findPage(btn) {
  const code = btn.dataset.code;
  const dept = btn.dataset.dept;
  const pdfUrl = btn.dataset.pdf;

  // Show loading
  btn.disabled = true;
  const origHTML = btn.innerHTML;
  btn.innerHTML = `<span class="material-symbols-rounded spinning">progress_activity</span> กำลังค้นหา...`;

  try {
    const res = await fetch(`/api/find-page?code=${encodeURIComponent(code)}&dept=${encodeURIComponent(dept)}`);
    const data = await res.json();

    if (data.pdfPage && data.pdfPage > 0) {
      // Replace button with page badge + link to open PDF at that page
      const pageUrl = `${pdfUrl}#page=${data.pdfPage}`;
      btn.outerHTML = `
        <a class="btn-page-found" href="${pageUrl}" target="_blank" rel="noopener" title="เปิด PDF ที่แผ่นนี้">
          <span class="material-symbols-rounded">menu_book</span>
          แผ่นที่ ${data.pdfPage}
        </a>
      `;
    } else {
      btn.innerHTML = `<span class="material-symbols-rounded">help</span> ไม่พบ`;
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = origHTML;
        btn.disabled = false;
      }, 3000);
    }
  } catch (e) {
    btn.innerHTML = origHTML;
    btn.disabled = false;
    alert('เกิดข้อผิดพลาด: ' + e.message);
  }
}

// ===== Download Document =====
async function downloadDoc(subjectCode, deptCode) {
  // Find the button and show loading
  const btns = document.querySelectorAll('.btn-download-doc');
  let targetBtn = null;
  btns.forEach(btn => {
    if (btn.getAttribute('onclick').includes(subjectCode)) {
      targetBtn = btn;
    }
  });

  if (targetBtn) {
    targetBtn.disabled = true;
    targetBtn.innerHTML = `<span class="material-symbols-rounded spinning">progress_activity</span> กำลังสร้าง...`;
  }

  try {
    const response = await fetch(`/api/generate-doc?code=${encodeURIComponent(subjectCode)}&dept=${encodeURIComponent(deptCode)}`);

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || 'Download failed');
    }

    // Get filename from Content-Disposition header
    const disposition = response.headers.get('Content-Disposition');
    let filename = `${subjectCode}.docx`;
    if (disposition) {
      const match = disposition.match(/filename\*=UTF-8''(.+)/);
      if (match) filename = decodeURIComponent(match[1]);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    if (targetBtn) {
      targetBtn.disabled = false;
      targetBtn.innerHTML = `<span class="material-symbols-rounded">download</span> Word`;
    }
  }
}

// Init
loadStats();
loadCategories();
doSearch();
