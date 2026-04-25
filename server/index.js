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
const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const db = require('./db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3024;
const BASE_PATH = process.env.BASE_PATH || '/novadraft';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
const AI_API_KEY = process.env.AI_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || '';
const APP_URL = process.env.APP_URL || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
const LOGOS_PATH = path.join(DATA_PATH, 'logos');

fs.mkdirSync(LOGOS_PATH, { recursive: true });

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
let mailTransporter = null;
if (SMTP_HOST && SMTP_USER) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  mailTransporter.verify().then(() => console.log('[Novadraft] SMTP connected')).catch(e => console.error('[Novadraft] SMTP error:', e.message));
}

async function sendVotingEmail(to, voterName, meetingTitle, orgName, proposals, voteUrl) {
  const transporter = mailTransporter || createMailTransporter();
  if (!transporter) return false;
  const smtp = getEffectiveSmtp();
  const proposalRows = proposals.map(p => {
    const d = p.proposed_date || '';
    const t = p.proposed_time || '';
    const loc = p.location ? ` - ${p.location}` : '';
    return `<tr><td style="padding:10px 16px;border-bottom:1px solid #eee;font-size:15px">${d}${t ? ' kl ' + t : ''}${loc}</td></tr>`;
  }).join('');

  const html = `
    <div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:#1e293b;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">Novadraft</h1>
        <p style="color:#94a3b8;margin:4px 0 0;font-size:13px">Protokollhantering</p>
      </div>
      <div style="padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <h2 style="margin:0 0 8px;font-size:18px;color:#1e293b">Rosta pa motestid</h2>
        <p style="color:#64748b;margin:0 0 16px;font-size:14px">Hej ${voterName},</p>
        <p style="color:#334155;font-size:14px;line-height:1.6">
          Du ar inbjuden att rosta pa motestid for <strong>${meetingTitle}</strong> (${orgName}).
          Valj de datum och tider som passar dig:
        </p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f8fafc;border-radius:8px;overflow:hidden">
          <thead><tr><th style="padding:10px 16px;text-align:left;background:#e2e8f0;font-size:13px;color:#475569">Forslag</th></tr></thead>
          <tbody>${proposalRows}</tbody>
        </table>
        <div style="text-align:center;margin:24px 0">
          <a href="${voteUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:16px;font-weight:600">Rosta nu</a>
        </div>
        <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:24px">
          Denna lank ar personlig och giltig i 14 dagar.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject: `Rosta pa motestid: ${meetingTitle} - ${orgName}`,
      html
    });
    return true;
  } catch (e) {
    console.error('[email send]', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
const router = express.Router();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: ['https://skylarkmedia.se'], credentials: true }));
app.use(compression());

// Stripe webhook needs raw body before json parser
app.post(BASE_PATH + '/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripe = getStripe();
    const whSecret = STRIPE_WEBHOOK_SECRET || getSetting('stripe_webhook_secret', '');
    if (!stripe || !whSecret) return res.status(400).send('Stripe not configured');

    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, whSecret); }
    catch (err) { console.error('[stripe webhook sig]', err.message); return res.status(400).send('Invalid signature'); }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId && session.subscription) {
        db.prepare("UPDATE users SET plan = 'premium', subscription_id = ?, subscription_status = 'active' WHERE id = ?")
          .run(session.subscription, userId);
        const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
        // Notify admin
        try {
          const transporter = createMailTransporter();
          if (transporter) {
            const smtp = getEffectiveSmtp();
            const admins = db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
            for (const admin of admins) {
              await transporter.sendMail({
                from: smtp.from || smtp.user,
                to: admin.email,
                subject: 'Ny prenumeration - Novadraft',
                html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
                  <h2 style="color:#1e293b">Ny prenumeration!</h2>
                  <p><strong>${user.name}</strong> (${user.email}) har startat en Premium-prenumeration.</p>
                  <p style="background:#dcfce7;padding:12px;border-radius:8px;color:#166534;font-size:15px">100 kr/manad</p>
                </div>`
              });
            }
          }
        } catch (me) { console.error('[stripe webhook notify]', me.message); }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      db.prepare("UPDATE users SET plan = 'free', subscription_status = 'canceled', subscription_id = NULL WHERE subscription_id = ?")
        .run(sub.id);
    } else if (event.type === 'invoice.paid') {
      const inv = event.data.object;
      if (inv.subscription) {
        db.prepare("UPDATE users SET subscription_status = 'active' WHERE subscription_id = ?").run(inv.subscription);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook]', err);
    res.status(500).send('Webhook error');
  }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});
app.use(limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many login attempts, please try again later' },
});

const chatbotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many requests, please try again later' },
});

const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many subscription attempts, please try again later' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many registration attempts, please try again later' },
});

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
    const allowedExts = /\.(jpg|jpeg|png|gif|webp)$/i;
    const allowedMimes = /^image\/(jpeg|png|gif|webp)$/;
    const extOk = allowedExts.test(path.extname(file.originalname));
    const mimeOk = allowedMimes.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('Only .jpg, .jpeg, .png, .gif, .webp files are allowed'), false);
    }
  },
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(req, res, next) {
  const header = req.headers.authorization;
  let token = null;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
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
// Helper: get platform setting
// ---------------------------------------------------------------------------
function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch { return fallback; }
}

function getEffectiveSmtp() {
  return {
    host: SMTP_HOST || getSetting('smtp_host', ''),
    port: parseInt(SMTP_PORT || getSetting('smtp_port', '587'), 10),
    user: SMTP_USER || getSetting('smtp_user', ''),
    pass: SMTP_PASS || getSetting('smtp_pass', ''),
    from: SMTP_FROM || getSetting('smtp_from', '')
  };
}

function getEffectiveAiKey() {
  return AI_API_KEY || getSetting('ai_api_key', '');
}

function createMailTransporter() {
  const smtp = getEffectiveSmtp();
  if (!smtp.host || !smtp.user) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass }
  });
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
router.post('/api/auth/login', loginLimiter, (req, res) => {
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
router.post('/api/auth/register', registerLimiter, (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    const orgs = db.prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) as member_count,
        (SELECT COUNT(*) FROM meetings WHERE org_id = o.id) as meeting_count
      FROM organizations o WHERE o.owner_id = ? ORDER BY o.created_at DESC
    `).all(req.user.id);
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

// GET /api/organizations/:id/export
router.get('/api/organizations/:id/export', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ?').all(org.id);
    const meetings = db.prepare('SELECT * FROM meetings WHERE org_id = ?').all(org.id);
    const meetingIds = meetings.map(m => m.id);

    let agendaItems = [], attendees = [], signatures = [], proposals = [], votes = [], votingTokens = [];
    if (meetingIds.length > 0) {
      const placeholders = meetingIds.map(() => '?').join(',');
      agendaItems = db.prepare(`SELECT * FROM agenda_items WHERE meeting_id IN (${placeholders})`).all(...meetingIds);
      attendees = db.prepare(`SELECT * FROM meeting_attendees WHERE meeting_id IN (${placeholders})`).all(...meetingIds);
      signatures = db.prepare(`SELECT * FROM meeting_signatures WHERE meeting_id IN (${placeholders})`).all(...meetingIds);
      proposals = db.prepare(`SELECT * FROM date_proposals WHERE meeting_id IN (${placeholders})`).all(...meetingIds);
      const proposalIds = proposals.map(p => p.id);
      if (proposalIds.length > 0) {
        const pp = proposalIds.map(() => '?').join(',');
        votes = db.prepare(`SELECT * FROM proposal_votes WHERE proposal_id IN (${pp})`).all(...proposalIds);
      }
      votingTokens = db.prepare(`SELECT * FROM voting_tokens WHERE meeting_id IN (${placeholders})`).all(...meetingIds);
    }

    let logoBase64 = null;
    if (org.logo_filename) {
      const logoPath = path.join(LOGOS_PATH, org.logo_filename);
      if (fs.existsSync(logoPath)) {
        logoBase64 = fs.readFileSync(logoPath).toString('base64');
      }
    }

    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      organization: org,
      logo: logoBase64,
      members,
      meetings,
      agenda_items: agendaItems,
      attendees,
      signatures,
      date_proposals: proposals,
      proposal_votes: votes,
      voting_tokens: votingTokens
    };

    res.setHeader('Content-Disposition', `attachment; filename="${org.name.replace(/[^a-zA-Z0-9]/g, '_')}_export.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (err) {
    console.error('[org export]', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// POST /api/organizations/import
router.post('/api/organizations/import', auth, (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.organization) return res.status(400).json({ error: 'Invalid import data' });

    const oldOrg = data.organization;
    const newOrgId = uuid();
    const idMap = {};

    db.prepare(`INSERT INTO organizations (id, owner_id, name, type, org_number, address, city, postal_code, logo_filename, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newOrgId, req.user.id,
      oldOrg.name + ' (importerad)',
      oldOrg.type || 'forening',
      oldOrg.org_number || null,
      oldOrg.address || null,
      oldOrg.city || null,
      oldOrg.postal_code || null,
      null,
      new Date().toISOString()
    );

    if (data.logo) {
      const ext = oldOrg.logo_filename ? path.extname(oldOrg.logo_filename) : '.png';
      const newFilename = `${uuid()}${ext}`;
      fs.writeFileSync(path.join(LOGOS_PATH, newFilename), Buffer.from(data.logo, 'base64'));
      db.prepare('UPDATE organizations SET logo_filename = ? WHERE id = ?').run(newFilename, newOrgId);
    }

    if (data.members) {
      for (const m of data.members) {
        const newId = uuid();
        idMap[m.id] = newId;
        db.prepare(`INSERT INTO org_members (id, org_id, user_id, name, email, title, role, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, newOrgId, m.user_id || null, m.name, m.email || null, m.title || null, m.role || 'member', m.created_at || new Date().toISOString());
      }
    }

    if (data.meetings) {
      for (const mt of data.meetings) {
        const newId = uuid();
        idMap[mt.id] = newId;
        db.prepare(`INSERT INTO meetings (id, org_id, title, meeting_type, meeting_number, meeting_date, meeting_time, location, zoom_link, status, created_by, chairman_id, secretary_id, adjuster1_id, adjuster2_id, opened_by, closed_by, template, notes, ai_summary, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newId, newOrgId, mt.title, mt.meeting_type || 'board', mt.meeting_number || null,
          mt.meeting_date || null, mt.meeting_time || null, mt.location || null, mt.zoom_link || null,
          mt.status || 'draft', req.user.id,
          mt.chairman_id ? (idMap[mt.chairman_id] || null) : null,
          mt.secretary_id ? (idMap[mt.secretary_id] || null) : null,
          mt.adjuster1_id ? (idMap[mt.adjuster1_id] || null) : null,
          mt.adjuster2_id ? (idMap[mt.adjuster2_id] || null) : null,
          mt.opened_by || null, mt.closed_by || null,
          mt.template || 'standard', mt.notes || null, mt.ai_summary || null,
          mt.created_at || new Date().toISOString()
        );
      }
    }

    if (data.agenda_items) {
      for (const ai of data.agenda_items) {
        const meetingId = idMap[ai.meeting_id] || ai.meeting_id;
        const newId = uuid();
        idMap[ai.id] = newId;
        db.prepare(`INSERT INTO agenda_items (id, meeting_id, item_number, title, content, decision, responsible, deadline, ai_draft, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newId, meetingId, ai.item_number, ai.title, ai.content || null,
          ai.decision || null, ai.responsible || null, ai.deadline || null,
          ai.ai_draft || null, ai.sort_order || 0,
          ai.created_at || new Date().toISOString()
        );
      }
    }

    if (data.attendees) {
      for (const at of data.attendees) {
        const meetingId = idMap[at.meeting_id] || at.meeting_id;
        const memberId = idMap[at.member_id] || at.member_id;
        db.prepare(`INSERT INTO meeting_attendees (id, meeting_id, member_id, name, title, present, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          uuid(), meetingId, memberId, at.name, at.title || null,
          at.present || 0, at.created_at || new Date().toISOString()
        );
      }
    }

    if (data.date_proposals) {
      for (const dp of data.date_proposals) {
        const meetingId = idMap[dp.meeting_id] || dp.meeting_id;
        const newId = uuid();
        idMap[dp.id] = newId;
        db.prepare(`INSERT INTO date_proposals (id, meeting_id, proposed_date, proposed_time, location, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          newId, meetingId, dp.proposed_date || '', dp.proposed_time || null,
          dp.location || null, dp.created_at || new Date().toISOString()
        );
      }
    }

    res.status(201).json({ organization_id: newOrgId, message: 'Organisation importerad!' });
  } catch (err) {
    console.error('[org import]', err);
    res.status(500).json({ error: 'Import failed' });
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
    const { title, meeting_type, meeting_date, meeting_time, location, template, zoom_link } = req.body;
    if (!title || !meeting_date) {
      return res.status(400).json({ error: 'Title and meeting date are required' });
    }

    // Auto-increment meeting number per organization
    const lastMeeting = db.prepare('SELECT MAX(meeting_number) as max_num FROM meetings WHERE org_id = ?').get(org.id);
    const meetingNumber = (lastMeeting.max_num || 0) + 1;

    const id = uuid();
    db.prepare(
      `INSERT INTO meetings (id, org_id, title, meeting_type, meeting_number, meeting_date, meeting_time, location, template, zoom_link, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, title, meeting_type || 'board', meetingNumber, meeting_date, meeting_time || null, location || null, template || 'standard', zoom_link || null, req.user.id);
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
    const proposals = db.prepare('SELECT * FROM date_proposals WHERE meeting_id = ? ORDER BY proposed_date, proposed_time').all(meeting.id);
    const proposalsWithVotes = proposals.map(p => {
      const votes = db.prepare('SELECT * FROM proposal_votes WHERE proposal_id = ?').all(p.id);
      return { ...p, votes, yes_count: votes.filter(v => v.available).length, total_votes: votes.length };
    });
    const votingTokens = db.prepare('SELECT id, meeting_id, member_id, name, email, token, voted, created_at FROM voting_tokens WHERE meeting_id = ?').all(meeting.id);
    res.json({ meeting, organization: org, attendees, agendaItems, signatures, proposals: proposalsWithVotes, votingTokens });
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
      title, meeting_type, meeting_date, meeting_time, location, zoom_link,
      chairman_id, secretary_id, adjuster1_id, adjuster2_id,
      opened_by, closed_by, notes, ai_summary, template,
    } = req.body;

    db.prepare(
      `UPDATE meetings SET
        title = ?, meeting_type = ?, meeting_date = ?, meeting_time = ?,
        location = ?, zoom_link = ?, chairman_id = ?, secretary_id = ?,
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
      zoom_link !== undefined ? zoom_link : meeting.zoom_link,
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
    const validStatuses = ['draft', 'planning', 'active', 'completed', 'signed'];
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
// DATE PROPOSALS & VOTING
// ===========================================================================

// GET /api/organizations/:orgId/proposals - all proposals for all meetings in this org
router.get('/api/organizations/:orgId/proposals', auth, (req, res) => {
  try {
    const org = getOrgIfOwner(req.params.orgId, req.user.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const meetings = db.prepare("SELECT * FROM meetings WHERE org_id = ? ORDER BY created_at DESC").all(org.id);
    const result = meetings.map(m => {
      const proposals = db.prepare('SELECT * FROM date_proposals WHERE meeting_id = ? ORDER BY proposed_date, proposed_time').all(m.id);
      const proposalsWithVotes = proposals.map(p => {
        const votes = db.prepare('SELECT * FROM proposal_votes WHERE proposal_id = ?').all(p.id);
        return { ...p, votes, yes_count: votes.filter(v => v.available).length, total_votes: votes.length };
      });
      const votingTokens = db.prepare('SELECT id, meeting_id, member_id, name, email, token, voted, created_at FROM voting_tokens WHERE meeting_id = ?').all(m.id);
      return { meeting: m, proposals: proposalsWithVotes, votingTokens };
    }).filter(item => item.proposals.length > 0 || item.meeting.status === 'planning');
    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY name').all(org.id);
    res.json({ meetingProposals: result, members });
  } catch (err) {
    console.error('[org proposals]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/meetings/:id/proposals
router.get('/api/meetings/:id/proposals', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const proposals = db.prepare('SELECT * FROM date_proposals WHERE meeting_id = ? ORDER BY proposed_date, proposed_time').all(meeting.id);
    const result = proposals.map(p => {
      const votes = db.prepare('SELECT * FROM proposal_votes WHERE proposal_id = ?').all(p.id);
      const yesCount = votes.filter(v => v.available).length;
      return { ...p, votes, yes_count: yesCount, total_votes: votes.length };
    });
    const votingTokens = db.prepare('SELECT id, meeting_id, member_id, name, email, token, voted, created_at FROM voting_tokens WHERE meeting_id = ?').all(meeting.id);
    res.json({ proposals: result, votingTokens });
  } catch (err) {
    console.error('[proposals get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings/:id/proposals
router.post('/api/meetings/:id/proposals', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const { proposed_date, proposed_time, location } = req.body;
    if (!proposed_date) return res.status(400).json({ error: 'Date is required' });
    const id = uuid();
    db.prepare('INSERT INTO date_proposals (id, meeting_id, proposed_date, proposed_time, location) VALUES (?, ?, ?, ?, ?)').run(
      id, meeting.id, proposed_date, proposed_time || null, location || null
    );
    const proposal = db.prepare('SELECT * FROM date_proposals WHERE id = ?').get(id);
    res.status(201).json({ proposal });
  } catch (err) {
    console.error('[proposal add]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/meetings/:id/proposals/:proposalId
router.delete('/api/meetings/:id/proposals/:proposalId', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const proposal = db.prepare('SELECT * FROM date_proposals WHERE id = ? AND meeting_id = ?').get(req.params.proposalId, meeting.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    db.prepare('DELETE FROM date_proposals WHERE id = ?').run(proposal.id);
    res.json({ message: 'Proposal deleted' });
  } catch (err) {
    console.error('[proposal delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/meetings/:id/send-voting - create voting tokens for members
router.post('/api/meetings/:id/send-voting', auth, async (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const proposals = db.prepare('SELECT * FROM date_proposals WHERE meeting_id = ?').all(meeting.id);
    if (proposals.length === 0) return res.status(400).json({ error: 'Add date proposals first' });
    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ?').all(org.id);
    if (members.length === 0) return res.status(400).json({ error: 'No members in organization' });
    db.prepare('DELETE FROM voting_tokens WHERE meeting_id = ?').run(meeting.id);
    const insertStmt = db.prepare('INSERT INTO voting_tokens (id, meeting_id, member_id, name, email, token, token_expires) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const created = [];
    const txn = db.transaction((membersList) => {
      for (const m of membersList) {
        const id = uuid();
        const token = uuid();
        const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        insertStmt.run(id, meeting.id, m.id, m.name, m.email || null, token, expires);
        created.push({ id, name: m.name, email: m.email, token, expires });
      }
    });
    txn(members);
    if (meeting.status === 'draft') {
      db.prepare("UPDATE meetings SET status = 'planning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(meeting.id);
    }

    let emailsSent = 0;
    let emailsFailed = 0;
    const hasEmail = !!(mailTransporter || createMailTransporter());
    if (hasEmail) {
      const baseUrl = APP_URL || getSetting('app_url', '') || `${req.protocol}://${req.get('host')}${BASE_PATH}`;
      for (const c of created) {
        if (c.email) {
          const voteUrl = `${baseUrl}/vote/${c.token}`;
          const sent = await sendVotingEmail(c.email, c.name, meeting.title, org.name, proposals, voteUrl);
          if (sent) emailsSent++; else emailsFailed++;
        }
      }
    }

    res.status(201).json({ votingTokens: created, emailsSent, emailsFailed, emailConfigured: hasEmail });
  } catch (err) {
    console.error('[send voting]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vote/:token (public)
router.get('/api/vote/:token', (req, res) => {
  try {
    const vt = db.prepare('SELECT * FROM voting_tokens WHERE token = ?').get(req.params.token);
    if (!vt) return res.status(404).json({ error: 'Voting link not found' });
    if (new Date(vt.token_expires) < new Date()) return res.status(410).json({ error: 'Voting link has expired' });
    const meeting = db.prepare('SELECT id, title, meeting_type, meeting_date FROM meetings WHERE id = ?').get(vt.meeting_id);
    const proposals = db.prepare('SELECT * FROM date_proposals WHERE meeting_id = ? ORDER BY proposed_date, proposed_time').all(vt.meeting_id);
    const existingVotes = db.prepare('SELECT pv.* FROM proposal_votes pv WHERE pv.voter_token = ?').all(vt.token);
    const org = db.prepare('SELECT name FROM organizations WHERE id = (SELECT org_id FROM meetings WHERE id = ?)').get(vt.meeting_id);
    res.json({
      voter_name: vt.name,
      meeting_title: meeting ? meeting.title : 'Unknown',
      meeting_type: meeting ? meeting.meeting_type : null,
      org_name: org ? org.name : '',
      proposals: proposals.map(p => ({
        ...p,
        voted_yes: existingVotes.some(v => v.proposal_id === p.id && v.available)
      })),
      already_voted: vt.voted === 1
    });
  } catch (err) {
    console.error('[vote get]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/vote/:token (public)
router.post('/api/vote/:token', (req, res) => {
  try {
    const vt = db.prepare('SELECT * FROM voting_tokens WHERE token = ?').get(req.params.token);
    if (!vt) return res.status(404).json({ error: 'Voting link not found' });
    if (new Date(vt.token_expires) < new Date()) return res.status(410).json({ error: 'Voting link has expired' });
    const { votes } = req.body;
    if (!Array.isArray(votes)) return res.status(400).json({ error: 'Votes array is required' });
    db.prepare('DELETE FROM proposal_votes WHERE voter_token = ?').run(vt.token);
    const insertVote = db.prepare('INSERT INTO proposal_votes (id, proposal_id, voter_token, voter_name, available) VALUES (?, ?, ?, ?, ?)');
    const txn = db.transaction((votesList) => {
      for (const v of votesList) {
        insertVote.run(uuid(), v.proposal_id, vt.token, vt.name, v.available ? 1 : 0);
      }
    });
    txn(votes);
    db.prepare('UPDATE voting_tokens SET voted = 1 WHERE id = ?').run(vt.id);
    res.json({ message: 'Votes recorded successfully' });
  } catch (err) {
    console.error('[vote post]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/meetings/:id/confirm-date
router.put('/api/meetings/:id/confirm-date', auth, (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const { proposal_id } = req.body;
    if (!proposal_id) return res.status(400).json({ error: 'Proposal ID is required' });
    const proposal = db.prepare('SELECT * FROM date_proposals WHERE id = ? AND meeting_id = ?').get(proposal_id, meeting.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    db.prepare("UPDATE meetings SET meeting_date = ?, meeting_time = ?, location = COALESCE(?, location), status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      proposal.proposed_date, proposal.proposed_time || null, proposal.location, meeting.id
    );
    const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
    res.json({ meeting: updated });
  } catch (err) {
    console.error('[confirm date]', err);
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
  const apiKey = getEffectiveAiKey();
  if (!apiKey) {
    throw new Error('AI API-nyckel ar inte konfigurerad. Ga till Admin > Installningar for att lagga till den.');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
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

// POST /api/ai/generate-dagordning - generate dagordning points from simple text
router.post('/api/ai/generate-dagordning', auth, async (req, res) => {
  try {
    const { text, meeting_type } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const typeLabel = { board: 'styrelsemote', annual: 'arsmote', inaugural: 'konstituerande mote', extra: 'extra mote' }[meeting_type] || 'styrelsemote';
    const result = await callClaude(
      `Du ar en expert pa svenska styrelseprotokoll och dagordningar. Skapa formella dagordningspunkter for ett ${typeLabel} baserat pa den angivna texten. Varje punkt ska ha ett kort formellt titel (UTAN paragrafsymbol eller nummer - det laggs till automatiskt) och en kort beskrivning. Returnera som JSON-array med objekt: [{"title": "Motets oppnande", "content": "Kort beskrivning"}, ...]. Inkludera alltid standardpunkter som Motets oppnande, Val av justerare, Godkannande av dagordning, etc. om de saknas. Avsluta alltid med Nasta mote och Motets avslutande. Returnera BARA JSON-arrayen, ingen annan text.`,
      text
    );
    let items;
    try {
      const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      items = JSON.parse(cleaned);
    } catch {
      items = [{ title: 'Dagordningspunkt', content: result }];
    }
    res.json({ items });
  } catch (err) {
    console.error('[ai dagordning]', err);
    if (err.message.includes('AI_API_KEY')) {
      return res.status(503).json({ error: 'AI service not configured' });
    }
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// GET /api/meetings/:id/dagordning-pdf - generate dagordning PDF with org branding
router.get('/api/meetings/:id/dagordning-pdf', auth, async (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const org = getOrgIfOwner(meeting.org_id, req.user.id);
    if (!org) return res.status(403).json({ error: 'Access denied' });
    const agendaItems = db.prepare('SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, item_number').all(meeting.id);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const PAGE_WIDTH = 595.28;
    const PAGE_HEIGHT = 841.89;
    const MARGIN = 60;
    const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    // Logo
    if (org.logo_filename) {
      try {
        const logoPath = path.join(LOGOS_PATH, org.logo_filename);
        if (fs.existsSync(logoPath)) {
          const logoBytes = fs.readFileSync(logoPath);
          const ext = path.extname(org.logo_filename).toLowerCase();
          let logoImage;
          if (ext === '.png') logoImage = await pdfDoc.embedPng(logoBytes);
          else if (ext === '.jpg' || ext === '.jpeg') logoImage = await pdfDoc.embedJpg(logoBytes);
          if (logoImage) {
            const logoDims = logoImage.scale(Math.min(100 / logoImage.width, 60 / logoImage.height));
            page.drawImage(logoImage, { x: MARGIN, y: y - logoDims.height, width: logoDims.width, height: logoDims.height });
            y -= logoDims.height + 10;
          }
        }
      } catch (e) { console.error('[dag pdf logo]', e); }
    }

    // Org name & address
    page.drawText(org.name, { x: MARGIN, y, size: 14, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    y -= 18;
    if (org.org_number) {
      page.drawText('Org.nr: ' + org.org_number, { x: MARGIN, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
      y -= 13;
    }
    if (org.address || org.city) {
      const addr = [org.address, org.postal_code, org.city].filter(Boolean).join(', ');
      page.drawText(addr, { x: MARGIN, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
      y -= 13;
    }
    y -= 15;

    // Separator
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1.5, color: rgb(0.15, 0.15, 0.4) });
    y -= 25;

    // Title
    page.drawText('DAGORDNING', { x: MARGIN, y, size: 22, font: fontBold, color: rgb(0.1, 0.1, 0.3) });
    y -= 30;

    const meetingTypeLabels = { board: 'Styrelsemote', annual: 'Arsmote', inaugural: 'Konstituerande mote', extra: 'Extra mote' };
    page.drawText(meetingTypeLabels[meeting.meeting_type] || 'Mote', { x: MARGIN, y, size: 13, font: fontBold, color: rgb(0.2, 0.2, 0.4) });
    y -= 22;

    // Meeting details
    const details = [
      { label: 'Datum:', value: meeting.meeting_date || '' },
      { label: 'Tid:', value: meeting.meeting_time || 'Ej angivet' },
      { label: 'Plats:', value: meeting.location || 'Ej angivet' },
    ];
    if (meeting.zoom_link) details.push({ label: 'Zoom:', value: meeting.zoom_link });

    for (const d of details) {
      page.drawText(d.label, { x: MARGIN, y, size: 10, font: fontBold, color: rgb(0, 0, 0) });
      page.drawText(d.value, { x: MARGIN + 80, y, size: 10, font, color: rgb(0, 0, 0) });
      y -= 16;
    }
    y -= 15;

    // Separator
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    y -= 20;

    // Agenda items
    if (agendaItems.length > 0) {
      for (const item of agendaItems) {
        if (y < 100) {
          page.drawText(`Sida 1`, { x: PAGE_WIDTH / 2 - 15, y: 30, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
          page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
          y = PAGE_HEIGHT - MARGIN;
        }
        page.drawText(`§${item.item_number}.`, { x: MARGIN, y, size: 12, font: fontBold, color: rgb(0.15, 0.15, 0.4) });
        page.drawText(item.title, { x: MARGIN + 30, y, size: 12, font: fontBold, color: rgb(0, 0, 0) });
        y -= 18;
        if (item.content) {
          const words = item.content.split(' ');
          let line = '';
          for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (font.widthOfTextAtSize(test, 10) > CONTENT_WIDTH - 30) {
              page.drawText(line, { x: MARGIN + 30, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
              y -= 14;
              line = w;
            } else { line = test; }
          }
          if (line) {
            page.drawText(line, { x: MARGIN + 30, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
            y -= 14;
          }
        }
        y -= 10;
      }
    } else {
      page.drawText('Inga dagordningspunkter har lagts till annu.', { x: MARGIN, y, size: 11, font, color: rgb(0.4, 0.4, 0.4) });
      y -= 16;
    }

    // Footer
    page.drawText(org.name, { x: MARGIN, y: 30, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
    page.drawText('Dagordning - ' + (meeting.meeting_date || ''), { x: PAGE_WIDTH - MARGIN - 120, y: 30, size: 8, font, color: rgb(0.5, 0.5, 0.5) });

    const pdfBytes = await pdfDoc.save();
    const filename = `dagordning_${org.name.replace(/[^a-zA-Z0-9]/g, '_')}_${meeting.meeting_date}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[dagordning pdf]', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

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
      return res.status(503).json({ error: 'AI service not configured' });
    }
    res.status(500).json({ error: 'AI formatting failed' });
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
      return res.status(503).json({ error: 'AI service not configured' });
    }
    res.status(500).json({ error: 'AI suggestion failed' });
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
${agendaItems.map(item => `§${item.item_number}. ${item.title}\n${item.content || ''}\nBeslut: ${item.decision || 'Inget beslut'}`).join('\n\n')}
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
      return res.status(503).json({ error: 'AI service not configured' });
    }
    res.status(500).json({ error: 'AI summarization failed' });
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
      const member = db.prepare('SELECT * FROM org_members WHERE id = ?').get(meeting.chairman_id);
      if (member) signers.push({ member_id: member.id, name: member.name, role: 'Ordforande' });
    }

    // Secretary
    if (meeting.secretary_id) {
      const member = db.prepare('SELECT * FROM org_members WHERE id = ?').get(meeting.secretary_id);
      if (member) signers.push({ member_id: member.id, name: member.name, role: 'Sekreterare' });
    }

    // Adjuster 1
    if (meeting.adjuster1_id) {
      const member = db.prepare('SELECT * FROM org_members WHERE id = ?').get(meeting.adjuster1_id);
      if (member) signers.push({ member_id: member.id, name: member.name, role: 'Justerare' });
    }

    // Adjuster 2
    if (meeting.adjuster2_id) {
      const member = db.prepare('SELECT * FROM org_members WHERE id = ?').get(meeting.adjuster2_id);
      if (member) signers.push({ member_id: member.id, name: member.name, role: 'Justerare' });
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
    if (signature_data.length > 500000) {
      return res.status(400).json({ error: 'Signature data too large' });
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
      page.drawText(`  [x]  ${att.name}${titlePart}`, { x: MARGIN_LEFT, y, size: 10, font: font, color: rgb(0, 0.4, 0) });
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
        page.drawText(`  [ ]  ${att.name}${titlePart}`, { x: MARGIN_LEFT, y, size: 10, font: font, color: rgb(0.5, 0, 0) });
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
    res.status(500).json({ error: 'PDF generation failed' });
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
// CHATBOT
// ===========================================================================

router.post('/api/chatbot', chatbotLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const aiKey = getEffectiveAiKey();
    if (!aiKey) {
      return res.json({ reply: 'Tack for din fraga! Kontakta oss pa vart kontaktformular for mer information om Novadraft.' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': aiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: getSetting('ai_model', 'claude-sonnet-4-20250514'),
        max_tokens: 300,
        system: `Du ar en hjalpsam assistent for Novadraft, en svensk tjanst for att skapa styrelseprotokoll och dagordningar.
Svara kort och vanligt pa svenska. Novadraft kostar 100 kr/manad och inkluderar:
- AI-genererade dagordningar och protokolltexter
- PDF-export med organisationens logotyp
- Digital signering (via MitSign-integration)
- Tidsforslag och e-prostning till styrelseledamoter
- Obegransat antal organisationer och protokoll
- Mallar for styrelsemoten, stammor, konstituerande och per capsulam
Tjansten foljer svensk lag (ABL, Bostadsrattslagen). Finns pa Svenska, Norsk, Dansk, Finska och Engelska.
Om du inte vet svaret, foreslå att besokaren skapar ett konto och testar sjalv.`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Tack for din fraga! Kontakta oss for mer information.';
    res.json({ reply });
  } catch (err) {
    console.error('[chatbot]', err.message);
    res.json({ reply: 'Jag kan tyvart inte svara just nu. Prova igen senare.' });
  }
});

// ===========================================================================
// MITSIGN INTEGRATION
// ===========================================================================

router.post('/api/meetings/:id/send-to-mitsign', auth, async (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const mitsignUrl = getSetting('mitsign_url', 'https://skylarkmedia.se/mitsign');
    const mitsignEmail = getSetting('mitsign_email', '');
    const mitsignPassword = getSetting('mitsign_password', '');
    if (!mitsignEmail || !mitsignPassword) {
      return res.status(400).json({ error: 'MitSign ar inte konfigurerat. Ange MitSign-uppgifter under Installningar.' });
    }

    // Login to MitSign
    const loginResp = await fetch(mitsignUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mitsignEmail, password: mitsignPassword })
    });
    const loginData = await loginResp.json();
    if (!loginResp.ok || !loginData.token) {
      return res.status(400).json({ error: 'MitSign-inloggning misslyckades: ' + (loginData.error || 'Okant fel') });
    }
    const mitsignToken = loginData.token;

    // Generate the protocol PDF internally
    const pdfUrl = `http://localhost:${PORT}${BASE_PATH}/api/meetings/${meeting.id}/pdf`;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const pdfResp = await fetch(pdfUrl, { headers: { 'Authorization': 'Bearer ' + jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1m' }) } });
    if (!pdfResp.ok) return res.status(500).json({ error: 'Kunde inte generera PDF' });
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

    // Upload PDF to MitSign
    const fd = new FormData();
    const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
    fd.append('file', pdfBlob, `protokoll_${meeting.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
    fd.append('title', `Protokoll: ${meeting.title}`);
    fd.append('description', `Styrelsemotesprotokoll - ${meeting.meeting_date || ''}`);

    const uploadResp = await fetch(mitsignUrl + '/api/documents', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + mitsignToken },
      body: fd
    });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) return res.status(500).json({ error: 'Uppladdning till MitSign misslyckades: ' + (uploadData.error || 'Okant fel') });

    const docId = uploadData.document?.id || uploadData.id;

    // Add signers from the meeting attendees/roles
    const signers = [];
    const attendees = db.prepare('SELECT * FROM meeting_attendees WHERE meeting_id = ?').all(meeting.id);
    const members = db.prepare('SELECT * FROM org_members WHERE org_id = ?').all(meeting.org_id);

    // Add chairman, secretary, adjusters as signers
    const roleIds = [meeting.chairman_id, meeting.secretary_id, meeting.adjuster1_id, meeting.adjuster2_id].filter(Boolean);
    for (const rid of roleIds) {
      const member = members.find(m => m.id === rid);
      if (member && member.email) {
        signers.push({ name: member.name, email: member.email });
      }
    }

    if (signers.length === 0) {
      return res.json({ document_id: docId, signers_added: 0, message: 'PDF uppladdad till MitSign men inga ledamoter med e-post hittades for signering.' });
    }

    const uniqueSigners = [...new Map(signers.map(s => [s.email, s])).values()];
    const signResp = await fetch(mitsignUrl + '/api/documents/' + docId + '/signers', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + mitsignToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signers: uniqueSigners })
    });
    const signData = await signResp.json();

    res.json({
      document_id: docId,
      signers_added: uniqueSigners.length,
      message: `Protokollet har skickats till MitSign for signering av ${uniqueSigners.length} ledamoter.`
    });
  } catch (err) {
    console.error('[mitsign]', err);
    res.status(500).json({ error: 'MitSign-integration misslyckades' });
  }
});

// ===========================================================================
// NEWSLETTER
// ===========================================================================

// POST /api/newsletter/subscribe
router.post('/api/newsletter/subscribe', newsletterLimiter, async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ?').get(cleanEmail);
    if (existing) {
      db.prepare('UPDATE newsletter_subscribers SET subscribed = 1 WHERE id = ?').run(existing.id);
      return res.json({ message: 'Already subscribed' });
    }
    const id = uuid();
    db.prepare('INSERT INTO newsletter_subscribers (id, email, name) VALUES (?, ?, ?)').run(id, cleanEmail, name || null);

    // Notify admin about new subscriber
    try {
      const transporter = createMailTransporter();
      if (transporter) {
        const smtp = getEffectiveSmtp();
        const admins = db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
        for (const admin of admins) {
          await transporter.sendMail({
            from: smtp.from || smtp.user,
            to: admin.email,
            subject: 'Ny nyhetsbrevsprenumerant - Novadraft',
            html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
              <h2 style="color:#1e293b">Ny prenumerant</h2>
              <p>En ny person har prenumererat pa nyhetsbrevet:</p>
              <p style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:15px"><strong>${cleanEmail}</strong>${name ? ' (' + name + ')' : ''}</p>
              <p style="color:#64748b;font-size:13px">Totalt antal aktiva prenumeranter: ${db.prepare("SELECT COUNT(*) as c FROM newsletter_subscribers WHERE subscribed = 1").get().c + 1}</p>
            </div>`
          });
        }
      }
    } catch (mailErr) {
      console.error('[newsletter notify admin]', mailErr.message);
    }

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
    const users = db.prepare('SELECT id, email, name, company, role, plan, category, is_active, created_at FROM users ORDER BY created_at DESC').all();
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
    const { role, plan, is_active, category } = req.body;
    db.prepare('UPDATE users SET role = ?, plan = ?, is_active = ?, category = ? WHERE id = ?').run(
      role || user.role,
      plan || user.plan,
      is_active !== undefined ? (is_active ? 1 : 0) : user.is_active,
      category || user.category || 'user',
      user.id
    );
    const updated = db.prepare('SELECT id, email, name, company, role, plan, is_active, category, created_at FROM users WHERE id = ?').get(user.id);
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
    const sensitiveKeys = /password|secret|api_key|smtp_pass/i;
    const rows = db.prepare('SELECT key, value FROM platform_settings').all();
    const settings = {};
    for (const row of rows) {
      let val;
      try { val = JSON.parse(row.value); } catch { val = row.value; }
      if (sensitiveKeys.test(row.key) && typeof val === 'string' && val.length > 4) {
        val = '*'.repeat(val.length - 4) + val.slice(-4);
      } else if (sensitiveKeys.test(row.key) && typeof val === 'string' && val.length > 0) {
        val = '****';
      }
      settings[row.key] = val;
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
    const sensitiveKeys = /password|secret|api_key|smtp_pass/i;
    const upsert = db.prepare(
      'INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const txn = db.transaction((entries) => {
      for (const [key, value] of entries) {
        // Skip masked values (asterisks + last 4 chars) to preserve existing value
        if (sensitiveKeys.test(key) && typeof value === 'string' && /^\*+.{0,4}$/.test(value)) {
          continue;
        }
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

// POST /api/admin/test-smtp
router.post('/api/admin/test-smtp', auth, adminOnly, async (req, res) => {
  try {
    const transporter = createMailTransporter();
    if (!transporter) {
      return res.status(400).json({ error: 'SMTP ar inte konfigurerat. Fyll i SMTP-installningarna forst.' });
    }
    await transporter.verify();
    res.json({ message: 'SMTP-anslutning lyckades!' });
  } catch (err) {
    console.error('[smtp test]', err);
    res.status(400).json({ error: 'SMTP-test misslyckades' });
  }
});

// ===========================================================================
// Stripe / Subscriptions
// ===========================================================================
function getStripe() {
  const key = STRIPE_SECRET_KEY || getSetting('stripe_secret_key', '');
  if (!key) return null;
  return new Stripe(key);
}

router.post('/api/subscription/create-checkout', auth, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe ar inte konfigurerat. Kontakta administratoren.' });
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId is required' });

    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
    }

    const appUrl = APP_URL || getSetting('app_url', '') || `${req.protocol}://${req.get('host')}${BASE_PATH}`;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: appUrl + '?subscription=success',
      cancel_url: appUrl + '?subscription=cancel',
      metadata: { userId: req.user.id }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe checkout]', err);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

router.get('/api/subscription/status', auth, (req, res) => {
  const user = db.prepare('SELECT plan, subscription_status, subscription_end, stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
  res.json({
    plan: user.plan || 'free',
    status: user.subscription_status || null,
    end_date: user.subscription_end || null,
    has_stripe: !!user.stripe_customer_id
  });
});

router.post('/api/subscription/cancel', auth, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const user = db.prepare('SELECT subscription_id FROM users WHERE id = ?').get(req.user.id);
    if (!user.subscription_id) return res.status(400).json({ error: 'No active subscription' });
    await stripe.subscriptions.update(user.subscription_id, { cancel_at_period_end: true });
    db.prepare("UPDATE users SET subscription_status = 'canceling' WHERE id = ?").run(req.user.id);
    res.json({ message: 'Prenumerationen avbryts vid periodens slut.' });
  } catch (err) {
    console.error('[stripe cancel]', err);
    res.status(500).json({ error: 'Subscription cancellation failed' });
  }
});

router.post('/api/subscription/portal', auth, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer' });
    const appUrl = APP_URL || getSetting('app_url', '') || `${req.protocol}://${req.get('host')}${BASE_PATH}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: appUrl
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe portal]', err);
    res.status(500).json({ error: 'Billing portal access failed' });
  }
});

// Admin: Subscription settings
router.get('/api/admin/subscription-plans', auth, adminOnly, (req, res) => {
  res.json({
    stripe_configured: !!getStripe(),
    plans: getSetting('subscription_plans', [
      { id: 'premium', name: 'Premium', price: 100, stripe_price_id: '', features: ['Obegransat', 'AI-assistent', 'E-prostning', 'Anpassade mallar', 'PDF-export', 'Digital signering'] },
      { id: 'enterprise', name: 'Foretag', price: 399, stripe_price_id: '', features: ['Allt i Premium', 'Flera admins', 'API', 'Dedikerad support'] }
    ])
  });
});

// Admin: Get user categories
router.get('/api/admin/categories', auth, adminOnly, (req, res) => {
  const categories = getSetting('user_categories', [
    { id: 'user', name: 'Anvandare' },
    { id: 'editor', name: 'Redaktor' },
    { id: 'manager', name: 'Chef' },
    { id: 'admin', name: 'Administrator' }
  ]);
  res.json({ categories });
});

// Admin: Save user categories
router.put('/api/admin/categories', auth, adminOnly, (req, res) => {
  try {
    const { categories } = req.body;
    db.prepare("INSERT INTO platform_settings (key, value) VALUES ('user_categories', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(categories));
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Newsletter management
router.get('/api/admin/newsletter', auth, adminOnly, (req, res) => {
  try {
    const subscribers = db.prepare('SELECT * FROM newsletter_subscribers ORDER BY created_at DESC').all();
    res.json({ subscribers });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/api/admin/newsletter/:id', auth, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM newsletter_subscribers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/admin/newsletter/send', auth, adminOnly, async (req, res) => {
  try {
    const { subject, body: rawBody } = req.body;
    if (!subject || !rawBody) return res.status(400).json({ error: 'Amne och meddelande kravs' });
    // Sanitize HTML: strip script tags and event handlers
    const body = rawBody
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
    const transporter = createMailTransporter();
    if (!transporter) return res.status(400).json({ error: 'SMTP ar inte konfigurerat' });
    const smtp = getEffectiveSmtp();
    const subs = db.prepare("SELECT email FROM newsletter_subscribers WHERE subscribed = 1").all();
    if (subs.length === 0) return res.status(400).json({ error: 'Inga aktiva prenumeranter' });

    let sent = 0, failed = 0;
    for (const sub of subs) {
      try {
        await transporter.sendMail({
          from: smtp.from || smtp.user,
          to: sub.email,
          subject,
          html: `<div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1e293b;padding:20px 28px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:20px">Novadraft</h1>
            </div>
            <div style="padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
              ${body}
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
              <p style="font-size:11px;color:#94a3b8;text-align:center">Du far detta mail for att du prenumererar pa Novadrafts nyhetsbrev.</p>
            </div>
          </div>`
        });
        sent++;
      } catch { failed++; }
    }
    res.json({ message: `Nyhetsbrev skickat till ${sent} prenumeranter${failed > 0 ? ' (' + failed + ' misslyckades)' : ''}` });
  } catch (err) {
    console.error('[newsletter send]', err);
    res.status(500).json({ error: 'Newsletter sending failed' });
  }
});

router.post('/api/admin/newsletter/send-test', auth, adminOnly, async (req, res) => {
  try {
    const { subject, body: rawBody } = req.body;
    const transporter = createMailTransporter();
    if (!transporter) return res.status(400).json({ error: 'SMTP ar inte konfigurerat' });
    const smtp = getEffectiveSmtp();
    const adminUser = db.prepare("SELECT email FROM users WHERE id = ?").get(req.user.id);
    // Sanitize HTML: strip script tags and event handlers
    const body = rawBody
      ? rawBody.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
      : null;

    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: adminUser.email,
      subject: '[TEST] ' + (subject || 'Novadraft nyhetsbrev'),
      html: `<div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1e293b;padding:20px 28px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px">Novadraft</h1>
        </div>
        <div style="padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
          <div style="background:#fef3c7;padding:10px;border-radius:6px;margin-bottom:16px;font-size:13px;color:#92400e"><strong>TEST:</strong> Detta ar ett testutskick.</div>
          ${body || 'Testmeddelande fran Novadraft.'}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
          <p style="font-size:11px;color:#94a3b8;text-align:center">Du far detta mail for att du prenumererar pa Novadrafts nyhetsbrev.</p>
        </div>
      </div>`
    });
    res.json({ message: 'Testmail skickat till ' + adminUser.email });
  } catch (err) {
    console.error('[newsletter test]', err);
    res.status(500).json({ error: 'Test email sending failed' });
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
  console.log(`[Novadraft] Server running on port ${PORT}`);
  console.log(`[Novadraft] Base path: ${BASE_PATH}`);
  console.log(`[Novadraft] Data path: ${DATA_PATH}`);
  console.log(`[Novadraft] AI: ${getEffectiveAiKey() ? 'Configured' : 'Not configured (AI features disabled)'}`);
});

module.exports = app;
