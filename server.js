const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(cors());
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

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
    .map(s => ({
      code: s.code,
      nameTh: s.nameTh,
      nameEn: s.nameEn,
      credit: s.credit,
      deptCode: s.deptCode,
      deptName: s.deptName,
      level: s.level,
      pdfUrl: pdfBaseUrl + s.pdf,
      pdfPage: (pagesData[s.deptCode] && pagesData[s.deptCode][s.code]) || 0
    }));

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

  const mappedSubjects = subjResults.slice(0, 200).map(s => ({
    code: s.code,
    nameTh: s.nameTh,
    nameEn: s.nameEn,
    credit: s.credit,
    deptCode: s.deptCode,
    deptName: s.deptName,
    level: s.level,
    category: s.category,
    group: s.group,
    pdfUrl: pdfBaseUrl + s.pdf,
    pdfPage: (pagesData[s.deptCode] && pagesData[s.deptCode][s.code]) || 0
  }));

  res.json({
    totalDepartments: mappedDepts.length,
    totalSubjects: mappedSubjects.length,
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

  const outputDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = Date.now();
  const outputFile = path.join(outputDir, `${subjectCode}_${timestamp}.docx`);
  const scriptPath = path.join(__dirname, 'scripts', 'generate_doc.py');

  const { execFile } = require('child_process');

  execFile('python3', [scriptPath, subjectCode, deptCode, outputFile], {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error) {
      console.error('Generate doc error:', error.message);
      console.error('stderr:', stderr);
      return res.status(500).json({ error: 'Document generation failed' });
    }

    try {
      const result = JSON.parse(stdout.trim());

      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Generation failed' });
      }

      // Send file with pdfPage info in header
      const filename = `${subjectCode}_${result.subject.name}.docx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      if (result.pdfPage) {
        res.setHeader('X-Pdf-Page', result.pdfPage);
      }

      const fileStream = fs.createReadStream(outputFile);
      fileStream.pipe(res);
      fileStream.on('end', () => {
        // Clean up temp file
        fs.unlink(outputFile, () => {});
      });
    } catch (e) {
      console.error('Parse error:', e, stdout);
      res.status(500).json({ error: 'Invalid response from generator' });
    }
  });
});

// API: Find PDF page number for a subject
app.get('/api/find-page', (req, res) => {
  const subjectCode = req.query.code;
  const deptCode = req.query.dept;

  if (!subjectCode || !deptCode) {
    return res.status(400).json({ error: 'Missing code or dept parameter' });
  }

  const scriptPath = path.join(__dirname, 'scripts', 'find_page.py');
  const { execFile } = require('child_process');

  execFile('python3', [scriptPath, subjectCode, deptCode], {
    timeout: 60000,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error) {
      console.error('Find page error:', error.message);
      return res.status(500).json({ error: 'Page lookup failed' });
    }
    try {
      const result = JSON.parse(stdout.trim());
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Invalid response' });
    }
  });
});

// API: Get subject detail (JSON) - full curriculum info
app.get('/api/subject-detail', (req, res) => {
  const subjectCode = req.query.code;
  const deptCode = req.query.dept;

  if (!subjectCode || !deptCode) {
    return res.status(400).json({ error: 'Missing code or dept parameter' });
  }

  const scriptPath = path.join(__dirname, 'scripts', 'subject_detail.py');
  const { execFile } = require('child_process');

  execFile('python3', [scriptPath, subjectCode, deptCode], {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error) {
      console.error('Subject detail error:', error.message);
      return res.status(500).json({ error: 'Detail extraction failed' });
    }
    try {
      const result = JSON.parse(stdout.trim());
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Invalid response' });
    }
  });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
