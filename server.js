const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const app = express();

// ---------------------------------------------------------------------------
// Crash protection: log uncaught errors instead of dying.
// Without these, ANY unhandled async error anywhere in the process
// kills the Node server — which on Render means a 30-60s cold restart
// and "the site is down" from the user's perspective.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});

// Graceful shutdown — let in-flight requests finish before exiting.
let httpServer = null;
function shutdown(signal) {
  console.log(`[${signal}] Graceful shutdown starting...`);
  if (!httpServer) return process.exit(0);
  const t = setTimeout(() => {
    console.warn('[shutdown] Forcing exit after 10s');
    process.exit(1);
  }, 10000);
  httpServer.close(() => {
    clearTimeout(t);
    console.log('[shutdown] Closed cleanly');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Render terminates TLS on its proxy and forwards the real client IP via
// X-Forwarded-For. Without `trust proxy` express-rate-limit groups every
// request under the proxy's single IP and one chatty user (or a popular
// page that opens this tab in many browsers) blocks everyone else.
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
const PORT = process.env.PORT || 3000;

// --- Data loading (can be re-called after sync) ---
let departments, pdfBaseUrl, subjectsData, pagesData, flatSubjects, lastSync;

const subjectsPath = path.join(__dirname, 'data', 'subjects.json');
const pagesPath = path.join(__dirname, 'data', 'pages.json');
const deptFilePath = path.join(__dirname, 'data', 'departments.json');

function loadData() {
  const data = JSON.parse(fs.readFileSync(deptFilePath, 'utf8'));
  departments = data.departments;
  pdfBaseUrl = data.pdfBaseUrl;
  lastSync = data.lastSync || null;

  subjectsData = { subjects: {} };
  if (fs.existsSync(subjectsPath)) {
    subjectsData = JSON.parse(fs.readFileSync(subjectsPath, 'utf8'));
    console.log(`Loaded subjects: ${subjectsData.totalSubjects} subjects from ${subjectsData.departmentsWithSubjects} departments`);
  }

  pagesData = {};
  if (fs.existsSync(pagesPath)) {
    pagesData = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
    console.log(`Loaded page numbers for ${Object.keys(pagesData).length} subjects`);
  }

  const uniqueSubjects = new Map();
  for (const dept of departments) {
    const deptSubjects = subjectsData.subjects[dept.code] || [];
    for (const subj of deptSubjects) {
      const subjOwnDept = subj.code.substring(0, 5);
      const isOwnDept = (dept.code === subjOwnDept);
      if (!uniqueSubjects.has(subj.code) || isOwnDept) {
        uniqueSubjects.set(subj.code, {
          ...subj,
          deptCode: dept.code,
          deptName: dept.name,
          level: dept.level,
          category: dept.category,
          group: dept.group,
          pdf: dept.pdf
        });
      }
    }
  }
  flatSubjects = Array.from(uniqueSubjects.values());
  console.log(`Loaded ${departments.length} departments, ${flatSubjects.length} unique subjects`);
}

loadData();

// Input validation helpers
const VALID_SUBJECT_CODE = /^\d{5}-\d{4}$/;
const VALID_DEPT_CODE = /^\d{5}$/;

// Resolve correct PDF + page for a subject.
// Falls back to the owning dept's PDF (e.g. core 20000 / 30000, or another dept
// whose code prefix matches the subject) when the subject is not found in its
// own dept's PDF.
// Index: subject code -> [deptCode, page] for first dept that has the page,
// built once after pages.json loads. Used as a last-resort fallback when the
// subject is not found in its own dept's PDF nor its owner-prefix dept's PDF.
let codeToDeptPage = {};
function buildCodeIndex() {
  codeToDeptPage = {};
  for (const [dCode, pages] of Object.entries(pagesData)) {
    for (const [sCode, page] of Object.entries(pages)) {
      if (page && !codeToDeptPage[sCode]) {
        codeToDeptPage[sCode] = [dCode, page];
      }
    }
  }
}
buildCodeIndex();

function resolvePdf(subj) {
  const ownDept = subj.deptCode;
  const ownerDept = subj.code.substring(0, 5);
  let page = (pagesData[ownDept] && pagesData[ownDept][subj.code]) || 0;
  let pdfFile = subj.pdf;
  if (!page && ownerDept !== ownDept) {
    const ownerPage = pagesData[ownerDept] && pagesData[ownerDept][subj.code];
    if (ownerPage) {
      page = ownerPage;
      const ownerDeptObj = departments.find(d => d.code === ownerDept);
      if (ownerDeptObj) pdfFile = ownerDeptObj.pdf;
    }
  }
  if (!page && codeToDeptPage[subj.code]) {
    const [fbDept, fbPage] = codeToDeptPage[subj.code];
    const fbDeptObj = departments.find(d => d.code === fbDept);
    if (fbDeptObj) {
      page = fbPage;
      pdfFile = fbDeptObj.pdf;
    }
  }
  return { pdfUrl: pdfBaseUrl + pdfFile, pdfPage: page };
}

// ---------------------------------------------------------------------------
// Python subprocess concurrency limiter.
// Each Python invocation imports pdfplumber + PyMuPDF + pypdfium2 +
// pythainlp -- roughly 100MB RAM. On Render free tier (512MB) we can
// only safely run 2-3 in parallel before the OS OOM-kills the Node
// process. Without this gate, a burst of cache-miss requests crashes
// the entire server.
// ---------------------------------------------------------------------------
const MAX_PY_CONCURRENCY = parseInt(process.env.MAX_PY_CONCURRENCY || '2', 10);
const PY_QUEUE_TIMEOUT_MS = 30000;
let pyActive = 0;
const pyWaiters = [];

function acquirePySlot() {
  return new Promise((resolve, reject) => {
    if (pyActive < MAX_PY_CONCURRENCY) {
      pyActive++;
      return resolve();
    }
    const timer = setTimeout(() => {
      const idx = pyWaiters.indexOf(entry);
      if (idx !== -1) pyWaiters.splice(idx, 1);
      reject(new Error('Server busy — please retry'));
    }, PY_QUEUE_TIMEOUT_MS);
    const entry = { resolve, timer };
    pyWaiters.push(entry);
  });
}
function releasePySlot() {
  pyActive = Math.max(0, pyActive - 1);
  const next = pyWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    pyActive++;
    next.resolve();
  }
}

// runPython: wraps execFile with the concurrency gate. Always releases
// its slot, even on error/timeout.
function runPython(scriptPath, args, opts) {
  const { execFile } = require('child_process');
  return new Promise(async (resolve, reject) => {
    try {
      await acquirePySlot();
    } catch (e) {
      return reject(e);
    }
    execFile('python3', [scriptPath, ...args], opts, (error, stdout, stderr) => {
      releasePySlot();
      if (error) return reject(Object.assign(error, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

// Rate limiting
// Cheap read-only endpoints (search/autocomplete/categories/stats) get
// fired several times per page load — keep them generous so bouncing
// between modals doesn't trip the limiter.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
// Endpoints that hit the filesystem / parse PDFs are still capped, but
// loose enough that a normal "browse 4-5 subjects" flow doesn't 429.
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);
app.use('/api/subject-detail', heavyLimiter);
app.use('/api/generate-doc', heavyLimiter);
app.use('/api/find-page', heavyLimiter);

// Serve static files with cache (7 days)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// API: Autocomplete suggestions
app.get('/api/autocomplete', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) {
    return res.json({ departments: [], subjects: [] });
  }

  // Search departments (max 5)
  const deptResults = departments
    .filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.code.includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.group.toLowerCase().includes(q)
    )
    .slice(0, 5)
    .map(d => ({
      ...d,
      pdfUrl: pdfBaseUrl + d.pdf
    }));

  // Search subjects (max 8)
  const subjResults = flatSubjects
    .filter(s =>
      s.nameTh.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      (s.nameEn && s.nameEn.toLowerCase().includes(q))
    )
    .slice(0, 8)
    .map(s => {
      const r = resolvePdf(s);
      return {
        code: s.code,
        nameTh: s.nameTh,
        nameEn: s.nameEn,
        credit: s.credit,
        deptCode: s.deptCode,
        deptName: s.deptName,
        level: s.level,
        pdfUrl: r.pdfUrl,
        pdfPage: r.pdfPage
      };
    });

  res.json({
    departments: deptResults,
    subjects: subjResults
  });
});

// API: Full search (departments + subjects)
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const level = req.query.level || '';
  const category = req.query.category || '';
  const type = req.query.type || 'all'; // 'all', 'departments', 'subjects'

  let deptResults = departments;
  let subjResults = flatSubjects;

  // Apply filters
  if (level) {
    deptResults = deptResults.filter(d => d.level === level);
    subjResults = subjResults.filter(s => s.level === level);
  }

  if (category) {
    deptResults = deptResults.filter(d => d.category === category);
    subjResults = subjResults.filter(s => s.category === category);
  }

  if (q) {
    deptResults = deptResults.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.code.includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.group.toLowerCase().includes(q)
    );

    subjResults = subjResults.filter(s =>
      s.nameTh.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      (s.nameEn && s.nameEn.toLowerCase().includes(q)) ||
      s.deptName.toLowerCase().includes(q)
    );
  }

  // Map with PDF URLs
  const mappedDepts = deptResults.map(d => ({
    ...d,
    pdfUrl: pdfBaseUrl + d.pdf
  }));

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const totalFiltered = subjResults.length;

  const mappedSubjects = subjResults.slice(offset, offset + limit).map(s => {
    const r = resolvePdf(s);
    return {
      code: s.code,
      nameTh: s.nameTh,
      nameEn: s.nameEn,
      credit: s.credit,
      deptCode: s.deptCode,
      deptName: s.deptName,
      level: s.level,
      category: s.category,
      group: s.group,
      pdfUrl: r.pdfUrl,
      pdfPage: r.pdfPage
    };
  });

  res.json({
    totalDepartments: mappedDepts.length,
    totalSubjects: totalFiltered,
    hasMore: offset + limit < totalFiltered,
    departments: type === 'subjects' ? [] : mappedDepts,
    subjects: type === 'departments' ? [] : mappedSubjects
  });
});

// API: Get categories
app.get('/api/categories', (req, res) => {
  const categories = [...new Set(departments.map(d => d.category))];
  res.json(categories);
});

// API: Get stats
app.get('/api/stats', (req, res) => {
  const pvchCount = departments.filter(d => d.level === 'ปวช.').length;
  const pvsCount = departments.filter(d => d.level === 'ปวส.').length;
  res.json({
    total: departments.length,
    pvch: pvchCount,
    pvs: pvsCount,
    subjects: flatSubjects.length,
    lastSync: lastSync
  });
});

// API: Generate document (DOCX)
app.get('/api/generate-doc', async (req, res) => {
  const subjectCode = req.query.code;
  const deptCode = req.query.dept;
  const format = req.query.format || 'docx'; // 'docx' or 'pdf'

  if (!subjectCode || !deptCode) {
    return res.status(400).json({ error: 'Missing code or dept parameter' });
  }
  if (!VALID_SUBJECT_CODE.test(subjectCode) || !VALID_DEPT_CODE.test(deptCode)) {
    return res.status(400).json({ error: 'Invalid code or dept format' });
  }

  const outputDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = Date.now();
  const outputFile = path.join(outputDir, `${subjectCode}_${timestamp}.docx`);
  const scriptPath = path.join(__dirname, 'scripts', 'generate_doc.py');

  try {
    const { stdout } = await runPython(scriptPath, [subjectCode, deptCode, outputFile], {
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch (e) {
      console.error('Parse error:', e, stdout);
      return res.status(500).json({ error: 'Invalid response from generator' });
    }
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Generation failed' });
    }
    // Send file with pdfPage info in header
    const filename = `${subjectCode}_${result.subject.name}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (result.pdfPage) res.setHeader('X-Pdf-Page', result.pdfPage);
    const fileStream = fs.createReadStream(outputFile);
    fileStream.pipe(res);
    fileStream.on('close', () => fs.unlink(outputFile, () => {}));
    fileStream.on('error', () => fs.unlink(outputFile, () => {}));
  } catch (error) {
    console.error('Generate doc error:', error.message);
    if (error.stderr) console.error('stderr:', String(error.stderr).slice(0, 500));
    if (/Server busy/.test(error.message)) {
      return res.status(503).json({ error: 'Server busy — please retry in a moment' });
    }
    res.status(500).json({ error: 'Document generation failed' });
  }
});

// API: Find PDF page number for a subject
app.get('/api/find-page', async (req, res) => {
  const subjectCode = req.query.code;
  const deptCode = req.query.dept;

  if (!subjectCode || !deptCode) {
    return res.status(400).json({ error: 'Missing code or dept parameter' });
  }
  if (!VALID_SUBJECT_CODE.test(subjectCode) || !VALID_DEPT_CODE.test(deptCode)) {
    return res.status(400).json({ error: 'Invalid code or dept format' });
  }

  const scriptPath = path.join(__dirname, 'scripts', 'find_page.py');

  try {
    const { stdout } = await runPython(scriptPath, [subjectCode, deptCode], {
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });
    try {
      res.json(JSON.parse(stdout.trim()));
    } catch (e) {
      res.status(500).json({ error: 'Invalid response' });
    }
  } catch (error) {
    console.error('Find page error:', error.message);
    if (/Server busy/.test(error.message)) {
      return res.status(503).json({ error: 'Server busy — please retry in a moment' });
    }
    res.status(500).json({ error: 'Page lookup failed' });
  }
});

// API: Get subject detail (JSON) - full curriculum info (with file cache)
const detailCacheDir = path.join(__dirname, 'data', 'detail-cache');
if (!fs.existsSync(detailCacheDir)) fs.mkdirSync(detailCacheDir, { recursive: true });

app.get('/api/subject-detail', async (req, res) => {
  const subjectCode = req.query.code;
  const deptCode = req.query.dept;
  const pageHint = parseInt(req.query.page, 10);

  if (!subjectCode || !deptCode) {
    return res.status(400).json({ error: 'Missing code or dept parameter' });
  }
  if (!VALID_SUBJECT_CODE.test(subjectCode) || !VALID_DEPT_CODE.test(deptCode)) {
    return res.status(400).json({ error: 'Invalid code or dept format' });
  }

  // Check file-based cache first
  const cacheKey = `${subjectCode}_${deptCode}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cachePath = path.join(detailCacheDir, `${cacheKey}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      console.log(`Cache hit: ${subjectCode} (${deptCode})`);
      return res.json(cached);
    } catch (e) {
      // Cache corrupt, re-extract
      try { fs.unlinkSync(cachePath); } catch (_) { /* ignore */ }
    }
  }

  console.log(`Cache miss: ${subjectCode} (${deptCode}) page=${pageHint || '-'} — extracting from PDF...`);
  const scriptPath = path.join(__dirname, 'scripts', 'subject_detail.py');

  const args = [subjectCode, deptCode];
  if (Number.isFinite(pageHint) && pageHint > 0) args.push(String(pageHint));

  try {
    const { stdout } = await runPython(scriptPath, args, {
      timeout: 180000,
      maxBuffer: 1024 * 1024
    });
    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch (e) {
      return res.status(500).json({ error: 'Invalid response' });
    }
    // Save to file cache
    try {
      fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8');
      console.log(`Cached: ${subjectCode} (${deptCode})`);
    } catch (cacheErr) {
      console.warn('Cache write error:', cacheErr.message);
    }
    res.json(result);
  } catch (error) {
    console.error('Subject detail error:', error.message);
    if (error.stderr) console.error('stderr:', String(error.stderr).slice(0, 500));
    if (/Server busy/.test(error.message)) {
      return res.status(503).json({ error: 'Server busy — please retry in a moment' });
    }
    res.status(500).json({ error: 'Detail extraction failed', details: error.message });
  }
});

// API: Extract page numbers for all subjects (run once to populate pages.json)
app.get('/api/extract-pages', (req, res) => {
  const scriptPath = path.join(__dirname, 'scripts', 'extract_pages.py');
  const { execFile } = require('child_process');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write('Starting page extraction...\n');

  const child = execFile('python3', [scriptPath], {
    timeout: 600000, // 10 minutes
    maxBuffer: 10 * 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error) {
      res.end(`\nError: ${error.message}\n${stderr}`);
      return;
    }
    // Reload pages data
    try {
      const newPages = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
      Object.assign(pagesData, newPages);
      res.end(`\n${stdout}\nReloaded ${Object.keys(pagesData).length} page numbers into memory.`);
    } catch (e) {
      res.end(`\n${stdout}\nWarning: Could not reload pages.json: ${e.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Health check endpoint. Render uses this for liveness probes; returns
// 503 when memory pressure is dangerous so Render can restart the
// instance before it OOM-crashes.
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  const mem = process.memoryUsage();
  const rssMB = mem.rss / 1024 / 1024;
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  // Render free tier = 512MB. Trigger 503 above 460MB so the instance
  // gets recycled before the kernel OOM-killer takes the whole process.
  const memCritical = rssMB > 460;
  const status = memCritical ? 503 : 200;
  res.status(status).json({
    ok: !memCritical,
    uptime: process.uptime(),
    rssMB: Math.round(rssMB),
    heapUsedMB: Math.round(heapUsedMB),
    pyActive,
    pyQueued: pyWaiters.length,
    subjectsLoaded: flatSubjects ? flatSubjects.length : 0,
  });
});

httpServer = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (max py concurrency=${MAX_PY_CONCURRENCY})`);
});
