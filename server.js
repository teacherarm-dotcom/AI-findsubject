const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Load department data
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'departments.json'), 'utf8'));
const departments = data.departments;
const pdfBaseUrl = data.pdfBaseUrl;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API: Search departments
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const level = req.query.level || '';
  const category = req.query.category || '';

  let results = departments;

  if (level) {
    results = results.filter(d => d.level === level);
  }

  if (category) {
    results = results.filter(d => d.category === category);
  }

  if (q) {
    results = results.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.code.includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.group.toLowerCase().includes(q)
    );
  }

  // Add full PDF URL
  const mapped = results.map(d => ({
    ...d,
    pdfUrl: pdfBaseUrl + d.pdf
  }));

  res.json({
    total: mapped.length,
    results: mapped
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
  res.json({ total: departments.length, pvch: pvchCount, pvs: pvsCount });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Loaded ${departments.length} departments`);
});
