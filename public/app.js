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
  // Show last sync date in footer
  const footerSync = document.getElementById('footerSync');
  if (footerSync && data.lastSync) {
    const d = new Date(data.lastSync);
    const thaiDate = d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
    footerSync.innerHTML = `<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;">sync</span> ข้อมูล ณ วันที่ ${thaiDate}`;
  }
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
        <div class="ac-item ac-dept" data-index="${i}" data-type="dept" data-code="${escapeAttr(d.code)}" data-name="${escapeAttr(d.name)}">
          <div class="ac-item-code">${escapeHtml(d.code)}</div>
          <div class="ac-item-info">
            <div class="ac-item-name">${highlightText(d.name, query)}</div>
            <div class="ac-item-meta">${escapeHtml(d.category)} / ${escapeHtml(d.group)}</div>
          </div>
          <span class="ac-item-badge ${badgeClass}">${escapeHtml(d.level)}</span>
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
        <div class="ac-item ac-subject" data-index="${departments.length + i}" data-type="subject" data-code="${escapeAttr(s.code)}" data-name="${escapeAttr(s.nameTh)}">
          <div class="ac-item-code">${escapeHtml(s.code)}</div>
          <div class="ac-item-info">
            <div class="ac-item-name">${highlightText(s.nameTh, query)}</div>
            <div class="ac-item-meta">${escapeHtml(s.deptName)} ${s.credit ? '• ' + escapeHtml(s.credit) : ''}</div>
          </div>
          <span class="ac-item-badge ${badgeClass}">${escapeHtml(s.level)}</span>
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
  params.set('type', 'subjects');

  const res = await fetch('/api/search?' + params.toString());
  const data = await res.json();

  renderResults(data, q);
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const safe = escapeHtml(text);
  const safeQuery = escapeHtml(query);
  const regex = new RegExp(`(${safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(regex, '<mark>$1</mark>');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderResults(data, query) {
  const { totalSubjects, subjects: subjs } = data;

  // Result stats line
  let statsHtml = '';
  if (totalSubjects > 0) {
    statsHtml = `พบ <strong>${totalSubjects}</strong> รายวิชา`;
  }
  resultStats.innerHTML = statsHtml;

  let html = '';

  // Empty state
  if (subjs.length === 0) {
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
    return;
  }

  // Subjects section
  if (subjs.length > 0) {
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
            <span class="material-symbols-rounded">${escapeHtml(icon)}</span>
          </div>
          <div>
            <div class="dept-title">${escapeHtml(group.deptName)} <span class="ac-item-badge ${badgeClass}">${escapeHtml(group.level)}</span></div>
            <div class="dept-subtitle">${escapeHtml(group.category)} • ${escapeHtml(deptCode)}</div>
          </div>
          <span class="dept-count">${group.items.length} วิชา</span>
        </div>
      `;

      group.items.forEach(s => {
        const cardId = `detail-${s.code}-${s.deptCode}`.replace(/[^a-zA-Z0-9-]/g, '_');
        const hasPage = s.pdfPage > 0;
        const pdfLink = hasPage ? `${escapeAttr(s.pdfUrl)}#page=${s.pdfPage}` : escapeAttr(s.pdfUrl);
        const pdfBtnClass = hasPage ? 'btn-page-found' : 'btn-pdf';
        const pdfBtnText = hasPage
          ? `<span class="material-symbols-rounded">menu_book</span> PDF หน้า ${s.pdfPage}`
          : `<span class="material-symbols-rounded">description</span> PDF`;
        html += `
          <div class="subject-card" data-code="${escapeAttr(s.code)}" data-dept="${escapeAttr(s.deptCode)}" data-pdf="${escapeAttr(s.pdfUrl)}" onclick="toggleDetail(this, '${escapeAttr(cardId)}')">
            <div class="subject-code">${highlightText(s.code, query)}</div>
            <div class="subject-info">
              <div class="subject-name-th">${highlightText(s.nameTh, query)}</div>
              ${s.nameEn ? `<div class="subject-name-en">${highlightText(s.nameEn, query)}</div>` : ''}
              <div class="subject-meta">
                ${s.credit ? `<span class="subject-credit">${escapeHtml(s.credit)}</span>` : ''}
              </div>
            </div>
            <div class="subject-actions" onclick="event.stopPropagation()">
              <a class="${pdfBtnClass}" href="${pdfLink}" target="_blank" rel="noopener" title="ดูหลักสูตร ${escapeAttr(group.deptName)}">
                ${pdfBtnText}
              </a>
            </div>
          </div>
          <div class="subject-detail" id="${cardId}" style="display:none;"></div>
        `;
      });
    }
  }

  resultsContainer.innerHTML = html;
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
      detailDiv.innerHTML = `<div class="detail-error"><span class="material-symbols-rounded">error</span> ${escapeHtml(data.error || 'ไม่สามารถดึงข้อมูลได้')}</div>`;
      return;
    }

    const pageInfo = data.pdfPage > 0
      ? `<a class="detail-page-badge" href="${data.pdfUrl}" target="_blank" rel="noopener"><span class="material-symbols-rounded">menu_book</span> แผ่นที่ ${data.pdfPage}</a>`
      : '';

    detailDiv.innerHTML = `
      <div class="detail-content">
        <div class="detail-header">
          <div class="detail-title">
            <span class="detail-code">${escapeHtml(data.courseCode)}</span>
            <span class="detail-name">${escapeHtml(data.courseName)}</span>
            ${data.courseNameEn ? `<span class="detail-name-en">${escapeHtml(data.courseNameEn)}</span>` : ''}
          </div>
          <div class="detail-badges">
            <span class="detail-credit"><span class="material-symbols-rounded">school</span> ${escapeHtml(data.credit)}</span>
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
    detailDiv.innerHTML = `<div class="detail-error"><span class="material-symbols-rounded">error</span> เกิดข้อผิดพลาด: ${escapeHtml(e.message)}</div>`;
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

// ===== PDF Splitter =====
const pdfSplitModal = document.getElementById('pdfSplitModal');
const pdfSplitClose = document.getElementById('pdfSplitClose');
const btnPdfSplit = document.getElementById('btnPdfSplit');
const pdfFileInput = document.getElementById('pdfFileInput');
const pdfUploadLabel = document.getElementById('pdfUploadLabel');
const pdfInfo = document.getElementById('pdfInfo');
const pdfPageCount = document.getElementById('pdfPageCount');
const pdfPageRange = document.getElementById('pdfPageRange');
const btnDoSplit = document.getElementById('btnDoSplit');
const pdfSplitLoading = document.getElementById('pdfSplitLoading');
const pdfSplitContent = document.getElementById('pdfSplitContent');

let pdfSplitFile = null;
let pdfSplitTotalPages = 0;
let pdfLibLoaded = false;

function openPdfSplitModal() {
  pdfSplitModal.style.display = 'flex';
  if (!pdfLibLoaded && !window.PDFLib) {
    pdfSplitLoading.style.display = 'flex';
    pdfSplitContent.style.display = 'none';
    const script = document.createElement('script');
    script.src = '/lib/pdf-lib.min.js';
    script.onload = () => {
      pdfLibLoaded = true;
      pdfSplitLoading.style.display = 'none';
      pdfSplitContent.style.display = 'block';
    };
    document.body.appendChild(script);
  } else {
    pdfLibLoaded = true;
    pdfSplitLoading.style.display = 'none';
    pdfSplitContent.style.display = 'block';
  }
}

function closePdfSplitModal() {
  pdfSplitModal.style.display = 'none';
  // Reset state
  pdfSplitFile = null;
  pdfSplitTotalPages = 0;
  pdfFileInput.value = '';
  pdfPageRange.value = '';
  pdfInfo.style.display = 'none';
  btnDoSplit.disabled = true;
  pdfUploadLabel.className = 'upload-label';
  pdfUploadLabel.innerHTML = `
    <span class="material-symbols-rounded">upload_file</span>
    <span>คลิกเพื่อเลือกไฟล์ PDF</span>
  `;
}

btnPdfSplit.addEventListener('click', openPdfSplitModal);
pdfSplitClose.addEventListener('click', closePdfSplitModal);
pdfSplitModal.addEventListener('click', (e) => {
  if (e.target === pdfSplitModal) closePdfSplitModal();
});

pdfFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf') {
    alert('กรุณาเลือกไฟล์ PDF เท่านั้น');
    return;
  }
  pdfSplitFile = file;
  pdfUploadLabel.className = 'upload-label has-file';
  pdfUploadLabel.innerHTML = `
    <span class="material-symbols-rounded">description</span>
    <span>${escapeHtml(file.name)}</span>
  `;

  if (pdfLibLoaded) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await window.PDFLib.PDFDocument.load(arrayBuffer);
      pdfSplitTotalPages = pdfDoc.getPageCount();
      pdfPageCount.textContent = pdfSplitTotalPages + ' หน้า';
      pdfInfo.style.display = 'flex';
    } catch (err) {
      alert('ไม่สามารถอ่านไฟล์ PDF ได้');
      return;
    }
  }
  updateSplitButton();
});

pdfPageRange.addEventListener('input', updateSplitButton);

function updateSplitButton() {
  btnDoSplit.disabled = !pdfSplitFile || !pdfPageRange.value.trim();
}

function parsePageRanges(rangeStr, total) {
  const pages = new Set();
  rangeStr.split(',').map(p => p.trim()).forEach(part => {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          if (i >= 1 && i <= total) pages.add(i - 1);
        }
      }
    } else {
      const page = parseInt(part);
      if (!isNaN(page) && page >= 1 && page <= total) pages.add(page - 1);
    }
  });
  return Array.from(pages).sort((a, b) => a - b);
}

btnDoSplit.addEventListener('click', async () => {
  if (!pdfSplitFile || !pdfPageRange.value.trim() || !pdfLibLoaded) return;

  btnDoSplit.disabled = true;
  const origHTML = btnDoSplit.innerHTML;
  btnDoSplit.innerHTML = `<span class="material-symbols-rounded spinning">progress_activity</span> กำลังตัดไฟล์...`;

  try {
    const { PDFDocument } = window.PDFLib;
    const arrayBuffer = await pdfSplitFile.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const newDoc = await PDFDocument.create();
    const pageIndices = parsePageRanges(pdfPageRange.value, pdfSplitTotalPages);

    if (pageIndices.length === 0) {
      alert('ระบุเลขหน้าไม่ถูกต้อง');
      btnDoSplit.innerHTML = origHTML;
      btnDoSplit.disabled = false;
      return;
    }

    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(page => newDoc.addPage(page));
    const pdfBytes = await newDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Split_${pdfSplitFile.name}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    closePdfSplitModal();
  } catch (err) {
    console.error(err);
    alert('เกิดข้อผิดพลาดในการตัดไฟล์');
  } finally {
    btnDoSplit.innerHTML = origHTML;
    btnDoSplit.disabled = false;
  }
});

// Init
loadStats();
loadCategories();
doSearch();
