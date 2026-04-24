const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const fs = require('fs');

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
const dbPath = path.join(DATA_PATH, 'conferra.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    company TEXT,
    role TEXT DEFAULT 'user',
    plan TEXT DEFAULT 'free',
    logo_url TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    org_number TEXT,
    address TEXT,
    city TEXT,
    postal_code TEXT,
    type TEXT DEFAULT 'company',
    logo_filename TEXT,
    owner_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT,
    name TEXT NOT NULL,
    email TEXT,
    title TEXT,
    role TEXT DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    meeting_type TEXT DEFAULT 'board',
    meeting_number INTEGER,
    meeting_date TEXT NOT NULL,
    meeting_time TEXT,
    location TEXT,
    status TEXT DEFAULT 'draft',
    created_by TEXT NOT NULL,
    chairman_id TEXT,
    secretary_id TEXT,
    adjuster1_id TEXT,
    adjuster2_id TEXT,
    opened_by TEXT,
    closed_by TEXT,
    template TEXT DEFAULT 'standard',
    notes TEXT,
    ai_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS meeting_attendees (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    member_id TEXT,
    name TEXT NOT NULL,
    title TEXT,
    present INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agenda_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    item_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    decision TEXT,
    responsible TEXT,
    deadline TEXT,
    ai_draft TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS meeting_signatures (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    member_id TEXT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    signature_data TEXT,
    signed_at DATETIME,
    ip_address TEXT,
    token TEXT UNIQUE,
    token_expires DATETIME,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'protokoll',
    content TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    subscribed INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed admin
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount === 0) {
  const id = uuid();
  const hash = bcrypt.hashSync('Admin2026!', 10);
  db.prepare('INSERT INTO users (id, email, password, name, role, plan) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'admin@conferra.se', hash, 'Admin', 'admin', 'premium');
  console.log('[DB] Default admin created: admin@conferra.se / Admin2026!');
}

// Seed default templates
const tmplCount = db.prepare('SELECT COUNT(*) as cnt FROM templates').get().cnt;
if (tmplCount === 0) {
  db.prepare('INSERT INTO templates (id, name, description, type, content, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuid(), 'Styrelsemote Standard', 'Standard template for board meetings following Swedish conventions', 'protokoll',
    JSON.stringify({
      sections: [
        { key: 'opening', title: 'Motets oppnande', default_text: 'Ordforanden oppnade motet.' },
        { key: 'attendees', title: 'Narvarande', default_text: '' },
        { key: 'election', title: 'Val av justerare och protokollfdrare', default_text: '' },
        { key: 'previous', title: 'Godkannande av forestaende protokoll', default_text: 'Forestaende protokoll godkanns och lades till handlingarna.' },
        { key: 'agenda', title: 'Dagordning', default_text: 'Dagordningen godkanns.' },
        { key: 'items', title: 'Arenden', default_text: '' },
        { key: 'closing', title: 'Motets avslutande', default_text: 'Ordforanden forklarade motet avslutat.' }
      ]
    }), 1
  );
  db.prepare('INSERT INTO templates (id, name, description, type, content, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuid(), 'Arsmote', 'Annual general meeting template', 'protokoll',
    JSON.stringify({
      sections: [
        { key: 'opening', title: 'Motets oppnande', default_text: '' },
        { key: 'attendees', title: 'Narvarande och rostlangd', default_text: '' },
        { key: 'election', title: 'Val av motesordforande och sekreterare', default_text: '' },
        { key: 'adjusters', title: 'Val av justerare', default_text: '' },
        { key: 'notice', title: 'Kallelse och behorighetsprövning', default_text: '' },
        { key: 'agenda', title: 'Dagordning', default_text: '' },
        { key: 'report', title: 'Verksamhetsberattelse', default_text: '' },
        { key: 'finances', title: 'Ekonomisk redovisning', default_text: '' },
        { key: 'audit', title: 'Revisionsberattelse', default_text: '' },
        { key: 'discharge', title: 'Ansvarsfrihet', default_text: '' },
        { key: 'elections', title: 'Val', default_text: '' },
        { key: 'motions', title: 'Motioner och propositioner', default_text: '' },
        { key: 'other', title: 'Övriga fragor', default_text: '' },
        { key: 'closing', title: 'Motets avslutande', default_text: '' }
      ]
    }), 0
  );
  db.prepare('INSERT INTO templates (id, name, description, type, content, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuid(), 'Konstituerande Mote', 'Inaugural board meeting template', 'protokoll',
    JSON.stringify({
      sections: [
        { key: 'opening', title: 'Motets oppnande', default_text: '' },
        { key: 'attendees', title: 'Narvarande', default_text: '' },
        { key: 'chairman', title: 'Val av ordforande', default_text: '' },
        { key: 'vice', title: 'Val av vice ordforande', default_text: '' },
        { key: 'secretary', title: 'Val av sekreterare', default_text: '' },
        { key: 'treasurer', title: 'Val av kassor', default_text: '' },
        { key: 'signing', title: 'Firmatecknare', default_text: '' },
        { key: 'other', title: 'Ovriga fragor', default_text: '' },
        { key: 'closing', title: 'Motets avslutande', default_text: '' }
      ]
    }), 0
  );
}

module.exports = db;
