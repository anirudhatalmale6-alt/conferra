require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const db = require('./db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3024;
const BASE_PATH = process.env.BASE_PATH || '/conferra';
const JWT_SECRET = process.env.JWT_SECRET || 'conferra_default_secret';
const AI_API_KEY = process.env.AI_API_KEY || '';
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
const LOGOS_PATH = path.join(DATA_PATH, 'logos');

fs.mkdirSync(LOGOS_PATH, { recursive: true });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const router = express.Router();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Static files
router.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Multer setup for logo uploads
// ---------------------------------------------------------------------------
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LOGOS_PATH),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuid()}${ext}`);
  },
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|svg|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  },
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, name, company, role, plan, is_active FROM users WHERE id = ?').get(payload.userId);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helper: verify org ownership
// ---------------------------------------------------------------------------
function getOrgIfOwner(orgId, userId) {
  return db.prepare('SELECT * FROM organizations WHERE id = ? AND owner_id = ?').get(orgId, userId);
}

// ===========================================================================
// AUTH ROUTES
// ===========================================================================

// POST /api/auth/login
router.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }
    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company,
        role: user.role,
        plan: user.plan,
      },
    });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register
router.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const id = uuid();
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (id, email, password, name, company, role, plan) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, email.toLowerCase().trim(), hash, name, company || null, 'user', 'free'
    );
    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      token,
      user: { id, email: email.toLowerCase().trim(), name, company: company || null, role: 'user', plan: 'free' },
    });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/api/auth/me', auth, (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (err) {
    console.error('[me]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/profile
router.put('/api/auth/profile', auth, (req, res) => {
  try {
    const { name, company, email } = req.body;
    if (email && email.toLowerCase().trim() !== req.user.email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase().trim(), req.user.id);
      if (existing) {
        return res.status(409).json({ error: 'Email already in use' });
      }
    }
    db.prepare('UPDATE users SET name = ?, company = ?, email = ? WHERE id = ?').run(
      name || req.user.name,
      company !== undefined ? company : req.user.company,
      email ? email.toLowerCase().trim() : req.user.email,
      req.user.id
    );
    const updated = db.prepare('SELECT id, email, name, company, role, plan, is_active FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: updated });
  } catch (err) {
    console.error('[profile]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/password
router.put('/api/auth/password', auth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[password]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// ORGANIZATION ROUTES
// ===========================================================================

// GET /api/organizations
router.get('/api/organizations', auth, (req, res) => {
  try {
    const orgs = db.prepare('SELECT * FROM organizations WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ organizations: orgs });
  } catch (err) {
    console.error('[orgs list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations
router.post('/api/organizations', auth, (req, res) => {
  try {
    const { name, org_number, address, city, postal_code, type } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Organization name is required' });
    }
    const id = uuid();
    db.prepare(
      'INSERT INTO organizations (id, name, org_number, address, city, postal_code, type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, org_number || null, address || null, city || null, postal_code || null, type || 'company', req.user.id);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    res.status(201).json({ organization: org });
  } catch (err) {
    console.error('[org create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organizations/:id
router.get('/api/organizations/:id', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.id, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY name').all(org.id);
    res.json({ organization: org, members });
  } catch (err) {
    console.error('[org get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/organizations/:id
router.put('/api/organizations/:id', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.id, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const { name, org_number, address, city, postal_code, type } = req.body;
    db.prepare(
      'UPDATE organizations SET name = ?, org_number = ?, address = ?, city = ?, postal_code = ?, type = ? WHERE id = ?'
    ).run(
      name || org.name,
      org_number !== undefined ? org_number : org.org_number,
      address !== undefined ? address : org.address,
      city !== undefined ? city : org.city,
      postal_code !== undefined ? postal_code : org.postal_code,
      type || org.type,
      org.id
    );
    const updated = db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id);
    res.json({ organization: updated });
  } catch (err) {
    console.error('[org update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/organizations/:id
router.delete('/api/organizations/:id', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.id, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    // Remove logo file if exists
    if (org.logo_filename) {
      const logoPath = path.join(LOGOS_PATH, org.logo_filename);
      if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
    }
    db.prepare('DELETE FROM organizations WHERE id = ?').run(org.id);
    res.json({ message: 'Organization deleted' });
  } catch (err) {
    console.error('[org delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations/:id/logo
router.post('/api/organizations/:id/logo', auth, uploadLogo.single('logo'), (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.id, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No logo file uploaded' });
    }
    // Delete old logo if exists
    if (org.logo_filename) {
      const oldPath = path.join(LOGOS_PATH, org.logo_filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare('UPDATE organizations SET logo_filename = ? WHERE id = ?').run(req.file.filename, org.id);
    res.json({ message: 'Logo uploaded', filename: req.file.filename });
  } catch (err) {
    console.error('[logo upload]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organizations/:id/logo
router.get('/api/organizations/:id/logo', (req, res) => {
  try {
    const org = db.prepare('SELECT logo_filename FROM organizations WHERE id = ?').get(req.params.id);
    if (!org || !org.logo_filename) {
      return res.status(404).json({ error: 'Logo not found' });
    }
    const logoPath = path.join(LOGOS_PATH, org.logo_filename);
    if (!fs.existsSync(logoPath)) {
      return res.status(404).json({ error: 'Logo file not found' });
    }
    res.sendFile(logoPath);
  } catch (err) {
    console.error('[logo get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// ORGANIZATION MEMBERS
// ===========================================================================

// GET /api/organizations/:orgId/members
router.get('/api/organizations/:orgId/members', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY name').all(org.id);
    res.json({ members });
  } catch (err) {
    console.error('[members list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations/:orgId/members
router.post('/api/organizations/:orgId/members', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const { name, email, title, role } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Member name is required' });
    }
    const id = uuid();
    db.prepare(
      'INSERT INTO org_members (id, org_id, name, email, title, role) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, org.id, name, email || null, title || null, role || 'member');
    const member = db.prepare('SELECT * FROM org_members WHERE id = ?').get(id);
    res.status(201).json({ member });
  } catch (err) {
    console.error('[member add]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/organizations/:orgId/members/:id
router.put('/api/organizations/:orgId/members/:id', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const member = db.prepare('SELECT * FROM org_members WHERE id = ? AND org_id = ?').get(req.params.id, org.id);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const { name, email, title, role } = req.body;
    db.prepare('UPDATE org_members SET name = ?, email = ?, title = ?, role = ? WHERE id = ?').run(
      name || member.name,
      email !== undefined ? email : member.email,
      title !== undefined ? title : member.title,
      role || member.role,
      member.id
    );
    const updated = db.prepare('SELECT * FROM org_members WHERE id = ?').get(member.id);
    res.json({ member: updated });
  } catch (err) {
    console.error('[member update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/organizations/:orgId/members/:id
router.delete('/api/organizations/:orgId/members/:id', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const member = db.prepare('SELECT * FROM org_members WHERE id = ? AND org_id = ?').get(req.params.id, org.id);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    db.prepare('DELETE FROM org_members WHERE id = ?').run(member.id);
    res.json({ message: 'Member deleted' });
  } catch (err) {
    console.error('[member delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// MEETING ROUTES
// ===========================================================================

// GET /api/organizations/:orgId/meetings
router.get('/api/organizations/:orgId/meetings', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const meetings = db.prepare('SELECT * FROM meetings WHERE org_id = ? ORDER BY meeting_date DESC, created_at DESC').all(org.id);
    res.json({ meetings });
  } catch (err) {
    console.error('[meetings list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations/:orgId/meetings
router.post('/api/organizations/:orgId/meetings', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const { title, meeting_type, meeting_date, meeting_time, location, template } = req.body;
    if (!title || !meeting_date) {
      return res.status(400).json({ error: 'Title and meeting date are required' });
    }

    // Auto-increment meeting number per organization
    const lastMeeting = db.prepare('SELECT MAX(meeting_number) as max_num FROM meetings WHERE org_id = ?').get(org.id);
    const meetingNumber = (lastMeeting.max_num || 0) + 1;

    const id = uuid();
    db.prepare(
      `INSERT INTO meetings (id, org_id, title, meeting_type, meeting_number, meeting_date, meeting_time, location, template, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, title, meeting_type || 'board', meetingNumber, meeting_date, meeting_time || null, location || null, template || 'standard', req.user.id);
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
    res.status(201).json({ meeting });
  } catch (err) {
    console.error('[meeting create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/meetings/recent
router.get('/api/meetings/recent', auth, (req, res) => {
  try {
    const meetings = db.prepare(`
      SELECT m.*, o.name as org_name
      FROM meetings m
      JOIN organizations o ON o.id = m.org_id
      WHERE o.owner_id = ?
      ORDER BY m.created_at DESC
      LIMIT 20
    `).all(req.user.id);
    res.json(meetings);
  } catch (err) {
    console.error('[meetings recent]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/meetings/:id
router.get('/api/meetings/:id', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    // Verify ownership
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const attendees = db.prepare('SELECT * FROM meeting_attendees WHERE meeting_id = ? ORDER BY name').all(meeting.id);
    const agendaItems = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, item_number').all(meeting.id);
    const signatures = db.prepare('SELECT * FROM meeting_signatures WHERE meeting_id = ? ORDER BY created_at').all(meeting.id);
    res.json({ meeting, organization: org, attendees, agendaItems, signatures });
  } catch (err) {
    console.error('[meeting get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id
router.put('/api/meetings/:id', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const {
      title, meeting_type, meeting_date, meeting_time, location,
      chairman_id, secretary_id, adjuster1_id, adjuster2_id,
      opened_by, closed_by, notes, ai_summary, template,
    } = req.body;

    db.prepare(
      `UPDATE meetings SET
        title = ?, meeting_type = ?, meeting_date = ?, meeting_time = ?,
        location = ?, chairman_id = ?, secretary_id = ?,
        adjuster1_id = ?, adjuster2_id = ?,
        opened_by = ?, closed_by = ?, notes = ?, ai_summary = ?,
        template = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      title || meeting.title,
      meeting_type || meeting.meeting_type,
      meeting_date || meeting.meeting_date,
      meeting_time !== undefined ? meeting_time : meeting.meeting_time,
      location !== undefined ? location : meeting.location,
      chairman_id !== undefined ? chairman_id : meeting.chairman_id,
      secretary_id !== undefined ? secretary_id : meeting.secretary_id,
      adjuster1_id !== undefined ? adjuster1_id : meeting.adjuster1_id,
      adjuster2_id !== undefined ? adjuster2_id : meeting.adjuster2_id,
      opened_by !== undefined ? opened_by : meeting.opened_by,
      closed_by !== undefined ? closed_by : meeting.closed_by,
      notes !== undefined ? notes : meeting.notes,
      ai_summary !== undefined ? ai_summary : meeting.ai_summary,
      template || meeting.template,
      meeting.id
    );
    const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
    res.json({ meeting: updated });
  } catch (err) {
    console.error('[meeting update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:id
router.delete('/api/meetings/:id', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
    res.json({ message: 'Meeting deleted' });
  } catch (err) {
    console.error('[meeting delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id/status
router.put('/api/meetings/:id/status', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { status } = req.body;
    const validStatuses = ['draft', 'active', 'completed', 'signed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }
    db.prepare('UPDATE meetings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, meeting.id);
    const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
    res.json({ meeting: updated });
  } catch (err) {
    console.error('[meeting status]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings/:id/attendees
router.post('/api/meetings/:id/attendees', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { member_id, name, title } = req.body;
    let attendeeName = name;
    let attendeeTitle = title;
    let memberId = member_id || null;

    // If member_id provided, look up the member
    if (member_id) {
      const member = db.prepare('SELECT * FROM org_members WHERE id = ? AND org_id = ?').get(member_id, org.id);
      if (!member) {
        return res.status(404).json({ error: 'Member not found in this organization' });
      }
      attendeeName = attendeeName || member.name;
      attendeeTitle = attendeeTitle || member.title;
    }

    if (!attendeeName) {
      return res.status(400).json({ error: 'Attendee name is required' });
    }

    const id = uuid();
    db.prepare(
      'INSERT INTO meeting_attendees (id, meeting_id, member_id, name, title) VALUES (?, ?, ?, ?, ?)'
    ).run(id, meeting.id, memberId, attendeeName, attendeeTitle || null);
    const attendee = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(id);
    res.status(201).json({ attendee });
  } catch (err) {
    console.error('[attendee add]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:id/attendees/:attendeeId
router.delete('/api/meetings/:id/attendees/:attendeeId', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const attendee = db.prepare('SELECT * FROM meeting_attendees WHERE id = ? AND meeting_id = ?').get(req.params.attendeeId, meeting.id);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found' });
    }
    db.prepare('DELETE FROM meeting_attendees WHERE id = ?').run(attendee.id);
    res.json({ message: 'Attendee removed' });
  } catch (err) {
    console.error('[attendee delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id/attendees/:attendeeId
router.put('/api/meetings/:id/attendees/:attendeeId', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const attendee = db.prepare('SELECT * FROM meeting_attendees WHERE id = ? AND meeting_id = ?').get(req.params.attendeeId, meeting.id);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found' });
    }
    const { present, name, title } = req.body;
    db.prepare('UPDATE meeting_attendees SET present = ?, name = ?, title = ? WHERE id = ?').run(
      present !== undefined ? (present ? 1 : 0) : attendee.present,
      name || attendee.name,
      title !== undefined ? title : attendee.title,
      attendee.id
    );
    const updated = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(attendee.id);
    res.json({ attendee: updated });
  } catch (err) {
    console.error('[attendee update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// AGENDA ITEMS
// ===========================================================================

// GET /api/meetings/:meetingId/agenda
router.get('/api/meetings/:meetingId/agenda', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const items = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, item_number').all(meeting.id);
    res.json({ agendaItems: items });
  } catch (err) {
    console.error('[agenda list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings/:meetingId/agenda
router.post('/api/meetings/:meetingId/agenda', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { title, content, decision, responsible, deadline } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Agenda item title is required' });
    }

    // Auto-increment item number
    const lastItem = db.prepare('SELECT MAX(item_number) as max_num FROM agenda_items WHERE meeting_id = ?').get(meeting.id);
    const itemNumber = (lastItem.max_num || 0) + 1;

    // Sort order defaults to item number
    const lastSort = db.prepare('SELECT MAX(sort_order) as max_sort FROM agenda_items WHERE meeting_id = ?').get(meeting.id);
    const sortOrder = (lastSort.max_sort || 0) + 1;

    const id = uuid();
    db.prepare(
      'INSERT INTO agenda_items (id, meeting_id, item_number, title, content, decision, responsible, deadline, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, meeting.id, itemNumber, title, content || null, decision || null, responsible || null, deadline || null, sortOrder);
    const item = db.prepare('SELECT * FROM agenda_items WHERE id = ?').get(id);
    res.status(201).json({ agendaItem: item });
  } catch (err) {
    console.error('[agenda add]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:meetingId/agenda/:id
router.put('/api/meetings/:meetingId/agenda/:id', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const item = db.prepare('SELECT * FROM agenda_items WHERE id = ? AND meeting_id = ?').get(req.params.id, meeting.id);
    if (!item) {
      return res.status(404).json({ error: 'Agenda item not found' });
    }
    const { title, content, decision, responsible, deadline, ai_draft } = req.body;
    db.prepare(
      'UPDATE agenda_items SET title = ?, content = ?, decision = ?, responsible = ?, deadline = ?, ai_draft = ? WHERE id = ?'
    ).run(
      title || item.title,
      content !== undefined ? content : item.content,
      decision !== undefined ? decision : item.decision,
      responsible !== undefined ? responsible : item.responsible,
      deadline !== undefined ? deadline : item.deadline,
      ai_draft !== undefined ? ai_draft : item.ai_draft,
      item.id
    );
    const updated = db.prepare('SELECT * FROM agenda_items WHERE id = ?').get(item.id);
    res.json({ agendaItem: updated });
  } catch (err) {
    console.error('[agenda update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:meetingId/agenda/:id
router.delete('/api/meetings/:meetingId/agenda/:id', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const item = db.prepare('SELECT * FROM agenda_items WHERE id = ? AND meeting_id = ?').get(req.params.id, meeting.id);
    if (!item) {
      return res.status(404).json({ error: 'Agenda item not found' });
    }
    db.prepare('DELETE FROM agenda_items WHERE id = ?').run(item.id);
    res.json({ message: 'Agenda item deleted' });
  } catch (err) {
    console.error('[agenda delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:meetingId/agenda/reorder
router.put('/api/meetings/:meetingId/agenda/reorder', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }
    const updateStmt = db.prepare('UPDATE agenda_items SET sort_order = ? WHERE id = ? AND meeting_id = ?');
    const txn = db.transaction((itemsList) => {
      for (const entry of itemsList) {
        updateStmt.run(entry.sort_order, entry.id, meeting.id);
      }
    });
    txn(items);
    const updatedItems = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, item_number').all(meeting.id);
    res.json({ agendaItems: updatedItems });
  } catch (err) {
    console.error('[agenda reorder]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// AI ROUTES
// ===========================================================================

async function callClaude(systemPrompt, userMessage) {
  if (!AI_API_KEY) {
    throw new Error('AI_API_KEY is not configured. Please set the Anthropic API key in your environment.');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

// POST /api/ai/format-text
router.post('/api/ai/format-text', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const result = await callClaude(
      'Du ar en expert pa svenska styrelseprotokoll. Formatera texten till korrekt protokollsprak enligt svensk standard. Anvand formellt sprak, tredje person, och korrekt juridisk terminologi. Returnera bara den formaterade texten utan forklaringar.',
      text
    );
    res.json({ formatted: result });
  } catch (err) {
    console.error('[ai format]', err);
    if (err.message.includes('AI_API_KEY')) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: 'AI formatting failed: ' + err.message });
  }
});

// POST /api/ai/suggest-decision
router.post('/api/ai/suggest-decision', auth, async (req, res) => {
  try {
    const { title, content, context } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Agenda item title is required' });
    }
    const prompt = `Arende: ${title}\n${content ? `Beskrivning: ${content}\n` : ''}${context ? `Kontext: ${context}\n` : ''}`;
    const result = await callClaude(
      'Du ar en expert pa svenska styrelseprotokoll. Foreslå ett formellt beslut for det givna arendet. Beslutet ska vara koncist, juridiskt korrekt, och folja svensk konvention for protokollbeslut. Borja med "Styrelsen beslutade att..." eller liknande formulering. Returnera bara beslutstexten utan forklaringar.',
      prompt
    );
    res.json({ decision: result });
  } catch (err) {
    console.error('[ai suggest]', err);
    if (err.message.includes('AI_API_KEY')) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: 'AI suggestion failed: ' + err.message });
  }
});

// POST /api/ai/summarize
router.post('/api/ai/summarize', auth, async (req, res) => {
  try {
    const { meetingId } = req.body;
    if (!meetingId) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(meeting.org_id);
    const attendees = db.prepare('SELECT * FROM meeting_attendees WHERE meeting_id = ?').all(meeting.id);
    const agendaItems = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order').all(meeting.id);

    const meetingData = `
Organisation: ${org.name}
Mote: ${meeting.title}
Typ: ${meeting.meeting_type}
Datum: ${meeting.meeting_date}
Plats: ${meeting.location || 'Ej angivet'}
Narvarande: ${attendees.filter(a => a.present).map(a => a.name).join(', ')}
Franvarande: ${attendees.filter(a => !a.present).map(a => a.name).join(', ') || 'Inga'}

Arenden:
${agendaItems.map(item => `${item.item_number}. ${item.title}\n${item.content || ''}\nBeslut: ${item.decision || 'Inget beslut'}`).join('\n\n')}
`;

    const result = await callClaude(
      'Du ar en expert pa svenska styrelseprotokoll. Skapa en kortfattad sammanfattning av motet. Inkludera de viktigaste besluten och diskussionspunkterna. Skriv pa svenska med formellt sprak. Returnera bara sammanfattningen.',
      meetingData
    );

    // Save summary to meeting
    db.prepare('UPDATE meetings SET ai_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(result, meeting.id);

    res.json({ summary: result });
  } catch (err) {
    console.error('[ai summarize]', err);
    if (err.message.includes('AI_API_KEY')) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: 'AI summarization failed: ' + err.message });
  }
});

// ===========================================================================
// SIGNATURE ROUTES
// ===========================================================================

// POST /api/meetings/:id/signatures/prepare
router.post('/api/meetings/:id/signatures/prepare', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Remove existing pending signatures
    db.prepare("DELETE FROM meeting_signatures WHERE meeting_id = ? AND status = 'pending'").run(meeting.id);

    const signers = [];

    // Chairman
    if (meeting.chairman_id) {
      const member = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(meeting.chairman_id);
      if (member) signers.push({ member_id: member.member_id, name: member.name, role: 'Ordforande' });
    }

    // Secretary
    if (meeting.secretary_id) {
      const member = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(meeting.secretary_id);
      if (member) signers.push({ member_id: member.member_id, name: member.name, role: 'Sekreterare' });
    }

    // Adjuster 1
    if (meeting.adjuster1_id) {
      const member = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(meeting.adjuster1_id);
      if (member) signers.push({ member_id: member.member_id, name: member.name, role: 'Justerare' });
    }

    // Adjuster 2
    if (meeting.adjuster2_id) {
      const member = db.prepare('SELECT * FROM meeting_attendees WHERE id = ?').get(meeting.adjuster2_id);
      if (member) signers.push({ member_id: member.member_id, name: member.name, role: 'Justerare' });
    }

    if (signers.length === 0) {
      return res.status(400).json({ error: 'No roles assigned. Please assign chairman, secretary, and adjusters first.' });
    }

    const insertStmt = db.prepare(
      'INSERT INTO meeting_signatures (id, meeting_id, member_id, name, role, token, token_expires) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const created = [];
    const txn = db.transaction((signersList) => {
      for (const signer of signersList) {
        const id = uuid();
        const token = uuid();
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        insertStmt.run(id, meeting.id, signer.member_id, signer.name, signer.role, token, expires);
        created.push({ id, name: signer.name, role: signer.role, token, expires });
      }
    });
    txn(signers);

    res.status(201).json({ signatures: created });
  } catch (err) {
    console.error('[sig prepare]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/sign/:token (public)
router.get('/api/sign/:token', (req, res) => {
  try {
    const sig = db.prepare('SELECT * FROM meeting_signatures WHERE token = ?').get(req.params.token);
    if (!sig) {
      return res.status(404).json({ error: 'Signature request not found' });
    }
    if (new Date(sig.token_expires) < new Date()) {
      return res.status(410).json({ error: 'Signature link has expired' });
    }
    if (sig.status === 'signed') {
      return res.status(409).json({ error: 'Already signed' });
    }
    const meeting = db.prepare('SELECT title, meeting_date, meeting_type FROM meetings WHERE id = ?').get(sig.meeting_id);
    res.json({
      signerName: sig.name,
      signerRole: sig.role,
      meetingTitle: meeting ? meeting.title : 'Unknown',
      meetingDate: meeting ? meeting.meeting_date : null,
      meetingType: meeting ? meeting.meeting_type : null,
      status: sig.status,
    });
  } catch (err) {
    console.error('[sign get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sign/:token (public)
router.post('/api/sign/:token', (req, res) => {
  try {
    const sig = db.prepare('SELECT * FROM meeting_signatures WHERE token = ?').get(req.params.token);
    if (!sig) {
      return res.status(404).json({ error: 'Signature request not found' });
    }
    if (new Date(sig.token_expires) < new Date()) {
      return res.status(410).json({ error: 'Signature link has expired' });
    }
    if (sig.status === 'signed') {
      return res.status(409).json({ error: 'Already signed' });
    }
    const { signature_data } = req.body;
    if (!signature_data) {
      return res.status(400).json({ error: 'Signature data is required' });
    }
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    db.prepare(
      "UPDATE meeting_signatures SET signature_data = ?, signed_at = CURRENT_TIMESTAMP, ip_address = ?, status = 'signed' WHERE id = ?"
    ).run(signature_data, ip, sig.id);

    // Check if all signatures for meeting are done
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM meeting_signatures WHERE meeting_id = ? AND status = 'pending'").get(sig.meeting_id);
    if (pending.cnt === 0) {
      db.prepare("UPDATE meetings SET status = 'signed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sig.meeting_id);
    }

    res.json({ message: 'Signature recorded successfully' });
  } catch (err) {
    console.error('[sign post]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/meetings/:id/signatures
router.get('/api/meetings/:id/signatures', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const signatures = db.prepare(
      'SELECT id, meeting_id, member_id, name, role, signed_at, ip_address, token, status, created_at FROM meeting_signatures WHERE meeting_id = ? ORDER BY created_at'
    ).all(meeting.id);
    res.json({ signatures });
  } catch (err) {
    console.error('[sig list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// PDF GENERATION
// ===========================================================================

// GET /api/meetings/:id/pdf
router.get('/api/meetings/:id/pdf', auth, async (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const attendees = db.prepare('SELECT * FROM meeting_attendees WHERE meeting_id = ? ORDER BY name').all(meeting.id);
    const agendaItems = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, item_number').all(meeting.id);
    const signatures = db.prepare('SELECT * FROM meeting_signatures WHERE meeting_id = ? ORDER BY created_at').all(meeting.id);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const PAGE_WIDTH = 595.28;
    const PAGE_HEIGHT = 841.89;
    const MARGIN_LEFT = 60;
    const MARGIN_RIGHT = 60;
    const MARGIN_TOP = 60;
    const MARGIN_BOTTOM = 70;
    const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
    const LINE_HEIGHT = 16;
    const SMALL_LINE = 13;

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN_TOP;
    let pageNum = 1;

    function newPage() {
      // Footer on current page
      drawFooter(page, pageNum);
      pageNum++;
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN_TOP;
    }

    function checkSpace(needed) {
      if (y - needed < MARGIN_BOTTOM) {
        newPage();
      }
    }

    function drawFooter(pg, num) {
      pg.drawText(`Sida ${num}`, {
        x: PAGE_WIDTH / 2 - 15,
        y: 30,
        size: 9,
        font: font,
        color: rgb(0.5, 0.5, 0.5),
      });
      pg.drawText(org.name, {
        x: MARGIN_LEFT,
        y: 30,
        size: 8,
        font: font,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    function wrapText(text, maxWidth, textFont, textSize) {
      const lines = [];
      const paragraphs = (text || '').split('\n');
      for (const para of paragraphs) {
        if (!para.trim()) {
          lines.push('');
          continue;
        }
        const words = para.split(' ');
        let currentLine = '';
        for (const word of words) {
          const testLine = currentLine ? currentLine + ' ' + word : word;
          const width = textFont.widthOfTextAtSize(testLine, textSize);
          if (width > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        if (currentLine) lines.push(currentLine);
      }
      return lines;
    }

    function drawWrapped(text, x, textFont, textSize, lineH, color) {
      const lines = wrapText(text, CONTENT_WIDTH - (x - MARGIN_LEFT), textFont, textSize);
      for (const line of lines) {
        checkSpace(lineH);
        page.drawText(line, { x, y, size: textSize, font: textFont, color: color || rgb(0, 0, 0) });
        y -= lineH;
      }
    }

    // ----- Logo -----
    if (org.logo_filename) {
      try {
        const logoPath = path.join(LOGOS_PATH, org.logo_filename);
        if (fs.existsSync(logoPath)) {
          const logoBytes = fs.readFileSync(logoPath);
          const ext = path.extname(org.logo_filename).toLowerCase();
          let logoImage;
          if (ext === '.png') {
            logoImage = await pdfDoc.embedPng(logoBytes);
          } else if (ext === '.jpg' || ext === '.jpeg') {
            logoImage = await pdfDoc.embedJpg(logoBytes);
          }
          if (logoImage) {
            const logoDims = logoImage.scale(Math.min(80 / logoImage.width, 50 / logoImage.height));
            page.drawImage(logoImage, {
              x: MARGIN_LEFT,
              y: y - logoDims.height,
              width: logoDims.width,
              height: logoDims.height,
            });
            y -= logoDims.height + 15;
          }
        }
      } catch (logoErr) {
        console.error('[pdf logo]', logoErr);
        // Continue without logo
      }
    }

    // ----- Title -----
    const meetingTypeLabels = {
      board: 'Styrelsemote',
      annual: 'Arsmote',
      extra: 'Extra bolagsstamma',
      inaugural: 'Konstituerande mote',
      other: 'Mote',
    };
    const typeLabel = meetingTypeLabels[meeting.meeting_type] || meeting.meeting_type || 'Styrelsemote';

    page.drawText('PROTOKOLL', {
      x: MARGIN_LEFT,
      y,
      size: 22,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.3),
    });
    y -= 28;

    page.drawText(typeLabel, {
      x: MARGIN_LEFT,
      y,
      size: 14,
      font: fontBold,
      color: rgb(0.2, 0.2, 0.4),
    });
    y -= 24;

    // ----- Meeting info -----
    const infoLines = [
      { label: 'Datum:', value: meeting.meeting_date || '' },
      { label: 'Tid:', value: meeting.meeting_time || 'Ej angivet' },
      { label: 'Plats:', value: meeting.location || 'Ej angivet' },
      { label: 'Motenummer:', value: String(meeting.meeting_number || '') },
    ];

    for (const info of infoLines) {
      checkSpace(LINE_HEIGHT);
      page.drawText(info.label, { x: MARGIN_LEFT, y, size: 10, font: fontBold, color: rgb(0, 0, 0) });
      page.drawText(info.value, { x: MARGIN_LEFT + 90, y, size: 10, font: font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
    y -= 5;

    // ----- Organization info -----
    checkSpace(LINE_HEIGHT * 2);
    page.drawText('Organisation:', { x: MARGIN_LEFT, y, size: 10, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(org.name, { x: MARGIN_LEFT + 90, y, size: 10, font: font, color: rgb(0, 0, 0) });
    y -= LINE_HEIGHT;
    if (org.org_number) {
      page.drawText('Org.nr:', { x: MARGIN_LEFT, y, size: 10, font: fontBold, color: rgb(0, 0, 0) });
      page.drawText(org.org_number, { x: MARGIN_LEFT + 90, y, size: 10, font: font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
    y -= 10;

    // ----- Separator line -----
    checkSpace(5);
    page.drawLine({
      start: { x: MARGIN_LEFT, y },
      end: { x: PAGE_WIDTH - MARGIN_RIGHT, y },
      thickness: 1,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 20;

    // ----- Attendees -----
    checkSpace(LINE_HEIGHT * 3);
    page.drawText('Narvarande', { x: MARGIN_LEFT, y, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    y -= LINE_HEIGHT + 4;

    const presentAttendees = attendees.filter(a => a.present);
    const absentAttendees = attendees.filter(a => !a.present);

    for (const att of presentAttendees) {
      checkSpace(SMALL_LINE);
      const titlePart = att.title ? ` (${att.title})` : '';
      page.drawText(`  ✓  ${att.name}${titlePart}`, { x: MARGIN_LEFT, y, size: 10, font: font, color: rgb(0, 0.4, 0) });
      y -= SMALL_LINE;
    }
    if (absentAttendees.length > 0) {
      y -= 4;
      checkSpace(SMALL_LINE);
      page.drawText('Franvarande:', { x: MARGIN_LEFT, y, size: 10, font: fontBold, color: rgb(0.4, 0, 0) });
      y -= SMALL_LINE;
      for (const att of absentAttendees) {
        checkSpace(SMALL_LINE);
        const titlePart = att.title ? ` (${att.title})` : '';
        page.drawText(`  ✗  ${att.name}${titlePart}`, { x: MARGIN_LEFT, y, size: 10, font: font, color: rgb(0.5, 0, 0) });
        y -= SMALL_LINE;
      }
    }
    y -= 10;

    // ----- Roles -----
    const roleEntries = [];
    if (meeting.chairman_id) {
      const ch = attendees.find(a => a.id === meeting.chairman_id);
      if (ch) roleEntries.push({ label: 'Ordforande:', name: ch.name });
    }
    if (meeting.secretary_id) {
      const sec = attendees.find(a => a.id === meeting.secretary_id);
      if (sec) roleEntries.push({ label: 'Sekreterare:', name: sec.name });
    }
    if (meeting.adjuster1_id) {
      const adj = attendees.find(a => a.id === meeting.adjuster1_id);
      if (adj) roleEntries.push({ label: 'Justerare:', name: adj.name });
    }
    if (meeting.adjuster2_id) {
      const adj = attendees.find(a => a.id === meeting.adjuster2_id);
      if (adj) roleEntries.push({ label: 'Justerare:', name: adj.name });
    }

    if (roleEntries.length > 0) {
      checkSpace(LINE_HEIGHT * (roleEntries.length + 1));
      page.drawText('Roller', { x: MARGIN_LEFT, y, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
      y -= LINE_HEIGHT + 4;
      for (const role of roleEntries) {
        checkSpace(SMALL_LINE);
        page.drawText(role.label, { x: MARGIN_LEFT, y, size: 10, font: fontBold, color: rgb(0, 0, 0) });
        page.drawText(role.name, { x: MARGIN_LEFT + 90, y, size: 10, font: font, color: rgb(0, 0, 0) });
        y -= SMALL_LINE;
      }
      y -= 10;
    }

    // ----- Separator -----
    checkSpace(5);
    page.drawLine({
      start: { x: MARGIN_LEFT, y },
      end: { x: PAGE_WIDTH - MARGIN_RIGHT, y },
      thickness: 1,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 20;

    // ----- Agenda Items -----
    if (agendaItems.length > 0) {
      checkSpace(LINE_HEIGHT + 10);
      page.drawText('Dagordning', { x: MARGIN_LEFT, y, size: 14, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
      y -= LINE_HEIGHT + 8;

      for (const item of agendaItems) {
        checkSpace(LINE_HEIGHT * 3);

        // Item number and title
        page.drawText(`§ ${item.item_number}`, { x: MARGIN_LEFT, y, size: 11, font: fontBold, color: rgb(0.2, 0.2, 0.4) });
        page.drawText(item.title, { x: MARGIN_LEFT + 35, y, size: 11, font: fontBold, color: rgb(0, 0, 0) });
        y -= LINE_HEIGHT + 2;

        // Content
        if (item.content) {
          drawWrapped(item.content, MARGIN_LEFT + 10, font, 10, SMALL_LINE, rgb(0.15, 0.15, 0.15));
          y -= 4;
        }

        // Decision
        if (item.decision) {
          checkSpace(LINE_HEIGHT + SMALL_LINE);
          page.drawText('Beslut:', { x: MARGIN_LEFT + 10, y, size: 10, font: fontBold, color: rgb(0, 0.3, 0) });
          y -= SMALL_LINE;
          drawWrapped(item.decision, MARGIN_LEFT + 20, font, 10, SMALL_LINE, rgb(0, 0.2, 0));
          y -= 4;
        }

        // Responsible
        if (item.responsible) {
          checkSpace(SMALL_LINE);
          page.drawText(`Ansvarig: ${item.responsible}`, { x: MARGIN_LEFT + 10, y, size: 9, font: font, color: rgb(0.3, 0.3, 0.3) });
          y -= SMALL_LINE;
        }

        // Deadline
        if (item.deadline) {
          checkSpace(SMALL_LINE);
          page.drawText(`Deadline: ${item.deadline}`, { x: MARGIN_LEFT + 10, y, size: 9, font: font, color: rgb(0.3, 0.3, 0.3) });
          y -= SMALL_LINE;
        }

        y -= 10;
      }
    }

    // ----- Notes -----
    if (meeting.notes) {
      checkSpace(LINE_HEIGHT * 3);
      page.drawText('Anteckningar', { x: MARGIN_LEFT, y, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
      y -= LINE_HEIGHT + 4;
      drawWrapped(meeting.notes, MARGIN_LEFT, font, 10, SMALL_LINE, rgb(0.2, 0.2, 0.2));
      y -= 15;
    }

    // ----- Signature section -----
    const signers = signatures.length > 0 ? signatures : roleEntries.map(r => ({ name: r.name, role: r.label.replace(':', ''), status: 'pending', signature_data: null }));
    if (signers.length > 0) {
      checkSpace(30 + signers.length * 60);
      page.drawLine({
        start: { x: MARGIN_LEFT, y },
        end: { x: PAGE_WIDTH - MARGIN_RIGHT, y },
        thickness: 1,
        color: rgb(0.7, 0.7, 0.7),
      });
      y -= 20;

      page.drawText('Underskrifter', { x: MARGIN_LEFT, y, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
      y -= LINE_HEIGHT + 10;

      for (const signer of signers) {
        checkSpace(55);

        // Signature image if exists
        if (signer.signature_data && signer.status === 'signed') {
          try {
            let sigData = signer.signature_data;
            // Remove data URI prefix if present
            if (sigData.startsWith('data:')) {
              sigData = sigData.split(',')[1];
            }
            const sigBytes = Buffer.from(sigData, 'base64');
            const sigImage = await pdfDoc.embedPng(sigBytes);
            const sigDims = sigImage.scale(Math.min(150 / sigImage.width, 40 / sigImage.height));
            page.drawImage(sigImage, {
              x: MARGIN_LEFT,
              y: y - sigDims.height,
              width: sigDims.width,
              height: sigDims.height,
            });
            y -= sigDims.height + 5;
          } catch (sigErr) {
            console.error('[pdf sig embed]', sigErr);
          }
        }

        // Signature line
        page.drawLine({
          start: { x: MARGIN_LEFT, y },
          end: { x: MARGIN_LEFT + 200, y },
          thickness: 0.5,
          color: rgb(0, 0, 0),
        });
        y -= 12;
        page.drawText(signer.name, { x: MARGIN_LEFT, y, size: 10, font: font, color: rgb(0, 0, 0) });
        page.drawText(signer.role, { x: MARGIN_LEFT + 210, y, size: 9, font: font, color: rgb(0.4, 0.4, 0.4) });
        if (signer.signed_at) {
          page.drawText(signer.signed_at, { x: MARGIN_LEFT + 310, y, size: 8, font: font, color: rgb(0.5, 0.5, 0.5) });
        }
        y -= 25;
      }
    }

    // Final footer
    drawFooter(page, pageNum);

    const pdfBytes = await pdfDoc.save();
    const filename = `protokoll_${org.name.replace(/[^a-zA-Z0-9]/g, '_')}_${meeting.meeting_date}_nr${meeting.meeting_number}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[pdf generate]', err);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// ===========================================================================
// TEMPLATE ROUTES
// ===========================================================================

// GET /api/templates
router.get('/api/templates', auth, (req, res) => {
  try {
    const templates = db.prepare('SELECT * FROM templates ORDER BY is_default DESC, name').all();
    res.json({ templates });
  } catch (err) {
    console.error('[templates list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/templates/:id
router.get('/api/templates/:id', auth, (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    // Parse content JSON
    let content;
    try {
      content = JSON.parse(template.content);
    } catch {
      content = template.content;
    }
    res.json({ template: { ...template, content } });
  } catch (err) {
    console.error('[template get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// NEWSLETTER
// ===========================================================================

// POST /api/newsletter/subscribe
router.post('/api/newsletter/subscribe', (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const existing = db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      // Re-subscribe if previously unsubscribed
      db.prepare('UPDATE newsletter_subscribers SET subscribed = 1 WHERE id = ?').run(existing.id);
      return res.json({ message: 'Already subscribed' });
    }
    const id = uuid();
    db.prepare('INSERT INTO newsletter_subscribers (id, email, name) VALUES (?, ?, ?)').run(id, email.toLowerCase().trim(), name || null);
    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (err) {
    console.error('[newsletter]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// ADMIN ROUTES
// ===========================================================================

// GET /api/admin/users
router.get('/api/admin/users', auth, adminOnly, (req, res) => {
  try {
    const users = db.prepare('SELECT id, email, name, company, role, plan, is_active, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ users });
  } catch (err) {
    console.error('[admin users]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/users/:id
router.put('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { role, plan, is_active } = req.body;
    db.prepare('UPDATE users SET role = ?, plan = ?, is_active = ? WHERE id = ?').run(
      role || user.role,
      plan || user.plan,
      is_active !== undefined ? (is_active ? 1 : 0) : user.is_active,
      user.id
    );
    const updated = db.prepare('SELECT id, email, name, company, role, plan, is_active, created_at FROM users WHERE id = ?').get(user.id);
    res.json({ user: updated });
  } catch (err) {
    console.error('[admin user update]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/stats
router.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const orgCount = db.prepare('SELECT COUNT(*) as count FROM organizations').get().count;
    const meetingCount = db.prepare('SELECT COUNT(*) as count FROM meetings').get().count;
    const activeUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get().count;
    const signedMeetings = db.prepare("SELECT COUNT(*) as count FROM meetings WHERE status = 'signed'").get().count;
    const subscribers = db.prepare('SELECT COUNT(*) as count FROM newsletter_subscribers WHERE subscribed = 1').get().count;

    const recentMeetings = db.prepare(
      `SELECT m.id, m.title, m.meeting_date, m.status, o.name as org_name
       FROM meetings m JOIN organizations o ON m.org_id = o.id
       ORDER BY m.created_at DESC LIMIT 10`
    ).all();

    const planDistribution = db.prepare(
      'SELECT plan, COUNT(*) as count FROM users GROUP BY plan'
    ).all();

    res.json({
      stats: {
        userCount,
        orgCount,
        meetingCount,
        activeUsers,
        signedMeetings,
        subscribers,
        planDistribution,
        recentMeetings,
      },
    });
  } catch (err) {
    console.error('[admin stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/settings
router.get('/api/admin/settings', auth, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM platform_settings').all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    res.json({ settings });
  } catch (err) {
    console.error('[admin settings get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/admin/settings
router.put('/api/admin/settings', auth, adminOnly, (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object is required' });
    }
    const upsert = db.prepare(
      'INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const txn = db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    });
    txn(Object.entries(settings));

    // Return updated settings
    const rows = db.prepare('SELECT key, value FROM platform_settings').all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }
    res.json({ settings: result });
  } catch (err) {
    console.error('[admin settings put]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===========================================================================
// Mount router and SPA fallback
// ===========================================================================
app.use(BASE_PATH, router);

// SPA fallback - serve index.html for all unmatched routes under BASE_PATH
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ===========================================================================
// Start server
// ===========================================================================
app.listen(PORT, () => {
  console.log(`[Conferra] Server running on port ${PORT}`);
  console.log(`[Conferra] Base path: ${BASE_PATH}`);
  console.log(`[Conferra] Data path: ${DATA_PATH}`);
  console.log(`[Conferra] AI: ${AI_API_KEY ? 'Configured' : 'Not configured (AI features disabled)'}`);
});

module.exports = app;
