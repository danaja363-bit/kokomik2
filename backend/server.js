require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Pastikan folder uploads ada
['uploads/covers', 'uploads/chapters'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ===================== MULTER =====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.uploadType || 'covers';
    cb(null, path.join(__dirname, 'uploads', type));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ===================== AUTH MIDDLEWARE =====================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ===================== AUTH ROUTES =====================
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'user' }, JWT_SECRET);
    res.json({ token, user: { id: result.lastInsertRowid, username, role: 'user' } });
  } catch (e) {
    res.status(400).json({ error: 'Username sudah dipakai' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Username/password salah' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ===================== MANGA ROUTES =====================
// Get all manga (with search, genre filter, sort)
app.get('/api/manga', (req, res) => {
  const { q, genre, status, sort = 'latest', limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM manga WHERE 1=1';
  const params = [];

  if (q) {
    sql += ' AND (title LIKE ? OR alternative_title LIKE ? OR author LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (genre) {
    sql += ' AND genres LIKE ?';
    params.push(`%${genre}%`);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  const sortMap = {
    latest: 'created_at DESC',
    popular: 'views DESC',
    rating: 'rating DESC',
    title: 'title ASC'
  };
  sql += ` ORDER BY ${sortMap[sort] || 'created_at DESC'} LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  const manga = db.prepare(sql).all(...params);
  res.json(manga);
});

// Get genres
app.get('/api/genres', (req, res) => {
  const rows = db.prepare('SELECT genres FROM manga WHERE genres IS NOT NULL').all();
  const set = new Set();
  rows.forEach(r => r.genres.split(',').forEach(g => set.add(g.trim())));
  res.json([...set].filter(Boolean));
});

// Get manga detail
app.get('/api/manga/:id', (req, res) => {
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga tidak ditemukan' });
  db.prepare('UPDATE manga SET views = views + 1 WHERE id = ?').run(req.params.id);
  const chapters = db.prepare('SELECT id, chapter_number, title, views, created_at FROM chapters WHERE manga_id = ? ORDER BY chapter_number DESC').all(req.params.id);
  res.json({ ...manga, chapters });
});

// Create manga (admin)
app.post('/api/manga', auth, adminOnly, upload.single('cover'), (req, res) => {
  req.uploadType = 'covers';
  const { title, alternative_title, author, artist, description, status, year, genres } = req.body;
  if (!title) return res.status(400).json({ error: 'Title wajib diisi' });
  const cover = req.file ? `/uploads/covers/${req.file.filename}` : null;
  const result = db.prepare(`
    INSERT INTO manga (title, alternative_title, author, artist, description, cover, status, year, genres)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, alternative_title || '', author || '', artist || '', description || '', cover, status || 'ongoing', year || null, genres || '');
  res.json({ id: result.lastInsertRowid, message: 'Manga berhasil ditambahkan' });
});

// Update manga (admin)
app.put('/api/manga/:id', auth, adminOnly, (req, res) => {
  const { title, alternative_title, author, artist, description, status, year, genres } = req.body;
  db.prepare(`
    UPDATE manga SET title=?, alternative_title=?, author=?, artist=?, description=?, status=?, year=?, genres=? WHERE id=?
  `).run(title, alternative_title, author, artist, description, status, year, genres, req.params.id);
  res.json({ message: 'Updated' });
});

// Delete manga (admin)
app.delete('/api/manga/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM manga WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Upload cover terpisah
app.post('/api/manga/:id/cover', auth, adminOnly, (req, res, next) => {
  req.uploadType = 'covers';
  next();
}, upload.single('cover'), (req, res) => {
  const cover = `/uploads/covers/${req.file.filename}`;
  db.prepare('UPDATE manga SET cover = ? WHERE id = ?').run(cover, req.params.id);
  res.json({ cover });
});

// ===================== CHAPTER ROUTES =====================
app.post('/api/manga/:id/chapters', auth, adminOnly, (req, res, next) => {
  req.uploadType = 'chapters';
  next();
}, upload.array('pages', 100), (req, res) => {
  const { chapter_number, title } = req.body;
  if (!chapter_number) return res.status(400).json({ error: 'Chapter number wajib' });
  const pages = req.files.map(f => `/uploads/chapters/${f.filename}`);
  const result = db.prepare(`
    INSERT INTO chapters (manga_id, chapter_number, title, pages) VALUES (?, ?, ?, ?)
  `).run(req.params.id, parseFloat(chapter_number), title || '', JSON.stringify(pages));
  res.json({ id: result.lastInsertRowid, pages });
});

app.get('/api/chapters/:id', (req, res) => {
  const chapter = db.prepare(`
    SELECT c.*, m.title as manga_title, m.id as manga_id FROM chapters c
    JOIN manga m ON m.id = c.manga_id WHERE c.id = ?
  `).get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter tidak ditemukan' });
  db.prepare('UPDATE chapters SET views = views + 1 WHERE id = ?').run(req.params.id);
  chapter.pages = JSON.parse(chapter.pages || '[]');
  res.json(chapter);
});

app.delete('/api/chapters/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM chapters WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ===================== BOOKMARKS =====================
app.get('/api/bookmarks', auth, (req, res) => {
  const list = db.prepare(`
    SELECT m.* FROM bookmarks b JOIN manga m ON m.id = b.manga_id WHERE b.user_id = ?
  `).all(req.user.id);
  res.json(list);
});

app.post('/api/bookmarks/:mangaId', auth, (req, res) => {
  try {
    db.prepare('INSERT INTO bookmarks (user_id, manga_id) VALUES (?, ?)').run(req.user.id, req.params.mangaId);
    res.json({ bookmarked: true });
  } catch {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND manga_id = ?').run(req.user.id, req.params.mangaId);
    res.json({ bookmarked: false });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
