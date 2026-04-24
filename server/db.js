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
const seedTemplate = (name, desc, type, content, isDefault) => {
  const exists = db.prepare('SELECT id FROM templates WHERE name = ?').get(name);
  if (!exists) {
    db.prepare('INSERT INTO templates (id, name, description, type, content, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(
      uuid(), name, desc, type, JSON.stringify(content), isDefault
    );
  }
};
if (true) {
  seedTemplate('Styrelsemote Standard', 'Standard template for board meetings following Swedish conventions', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: 'Ordforanden oppnade motet.' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'election', title: 'Val av justerare och protokollfdrare', default_text: '' },
      { key: 'previous', title: 'Godkannande av forestaende protokoll', default_text: 'Forestaende protokoll godkanns och lades till handlingarna.' },
      { key: 'agenda', title: 'Dagordning', default_text: 'Dagordningen godkanns.' },
      { key: 'items', title: 'Arenden', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: 'Ordforanden forklarade motet avslutat.' }
    ]
  }, 1);
  seedTemplate('Arsmote', 'Annual general meeting template', 'protokoll', {
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
  }, 0);
  seedTemplate('Konstituerande Mote', 'Inaugural board meeting template', 'protokoll', {
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
  }, 0);
  seedTemplate('Styrelsemote BRF', 'Styrelsemotesprotokoll for bostadsrattsforeningar', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: 'Ordforanden oppnade motet.' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'election', title: 'Val av justerare', default_text: '' },
      { key: 'previous', title: 'Forestaende protokoll', default_text: 'Forestaende protokoll godkanns och lades till handlingarna.' },
      { key: 'agenda', title: 'Dagordning', default_text: 'Dagordningen godkanns.' },
      { key: 'economy', title: 'Ekonomi och likviditet', default_text: '' },
      { key: 'maintenance', title: 'Fastighetsskotsel och underhall', default_text: '' },
      { key: 'members', title: 'Medlems- och lagenhetsarenden', default_text: '' },
      { key: 'subletting', title: 'Andrahandsuthyrning', default_text: '' },
      { key: 'items', title: 'Ovriga arenden', default_text: '' },
      { key: 'next', title: 'Nasta mote', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: 'Ordforanden forklarade motet avslutat.' }
    ]
  }, 0);
  seedTemplate('Styrelsemote AB', 'Styrelsemotesprotokoll for aktiebolag', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: 'Styrelseordforanden oppnade motet.' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'election', title: 'Val av protokolljusterare', default_text: '' },
      { key: 'previous', title: 'Forestaende protokoll', default_text: 'Forestaende protokoll godkanns.' },
      { key: 'ceo_report', title: 'VD-rapport', default_text: '' },
      { key: 'finances', title: 'Ekonomisk rapport', default_text: '' },
      { key: 'items', title: 'Beslutsarenden', default_text: '' },
      { key: 'other', title: 'Ovriga fragor', default_text: '' },
      { key: 'next', title: 'Nasta mote', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: 'Ordforanden forklarade motet avslutat.' }
    ]
  }, 0);
  seedTemplate('Bolagsstammoprotokoll', 'Protokoll for ordinarie bolagsstamma', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Stammans oppnande', default_text: '' },
      { key: 'chairman', title: 'Val av ordforande vid stamman', default_text: '' },
      { key: 'adjusters', title: 'Val av justerare', default_text: '' },
      { key: 'attendance', title: 'Upprattat och godkant rostlangd', default_text: '' },
      { key: 'notice', title: 'Godkannande av dagordning', default_text: '' },
      { key: 'convened', title: 'Stamman behorigen sammankallad', default_text: '' },
      { key: 'annual_report', title: 'Framlaggerande av arsredovisning och revisionsberattelse', default_text: '' },
      { key: 'income', title: 'Faststellande av resultat- och balansrakning', default_text: '' },
      { key: 'profit', title: 'Beslut om dispositioner av vinst eller forlust', default_text: '' },
      { key: 'discharge', title: 'Ansvarsfrihet for styrelse och VD', default_text: '' },
      { key: 'board_election', title: 'Val av styrelseledamoter och revisorer', default_text: '' },
      { key: 'fees', title: 'Faststellande av arvoden', default_text: '' },
      { key: 'other', title: 'Ovriga arenden', default_text: '' },
      { key: 'closing', title: 'Stammans avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('Per Capsulam Beslut', 'Styrelsebeslut utan fysiskt mote', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Beslut per capsulam', default_text: 'Styrelsen i [organisationsnamn] har fattat foljande beslut per capsulam (utan fysiskt mote).' },
      { key: 'date', title: 'Datum for beslutet', default_text: '' },
      { key: 'participants', title: 'Deltagande ledamoter', default_text: '' },
      { key: 'matter', title: 'Arende', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'signatures', title: 'Underskrifter', default_text: 'Samtliga styrelseledamoter har godkant beslutet.' }
    ]
  }, 0);
  seedTemplate('Extra Foreningsstamma', 'Protokoll for extra foreningsstamma', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Stammans oppnande', default_text: '' },
      { key: 'chairman', title: 'Val av ordforande', default_text: '' },
      { key: 'secretary', title: 'Val av sekreterare', default_text: '' },
      { key: 'adjusters', title: 'Val av justerare', default_text: '' },
      { key: 'attendance', title: 'Rostlangd', default_text: '' },
      { key: 'notice', title: 'Godkannande av kallelse', default_text: '' },
      { key: 'agenda', title: 'Dagordning', default_text: '' },
      { key: 'matter', title: 'Arende att behandla', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'closing', title: 'Stammans avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('Andrahandsuthyrning BRF', 'Styrelsebeslut om andrahandsuthyrning', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Arende', default_text: 'Styrelsen behandlade inkommet arende om andrahandsuthyrning.' },
      { key: 'applicant', title: 'Sokande', default_text: '' },
      { key: 'apartment', title: 'Lagenhet', default_text: '' },
      { key: 'period', title: 'Period', default_text: '' },
      { key: 'reason', title: 'Skal', default_text: '' },
      { key: 'tenant', title: 'Forelagen andrahandshyresgast', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'conditions', title: 'Villkor', default_text: '' }
    ]
  }, 0);
  seedTemplate('Ekonomibeslut', 'Styrelsebeslut i ekonomiska fragor', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: '' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'background', title: 'Bakgrund', default_text: '' },
      { key: 'financial_report', title: 'Ekonomisk sammanstallning', default_text: '' },
      { key: 'proposal', title: 'Forslag', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'implementation', title: 'Genomforande', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('Firmateckningsbeslut', 'Beslut om firmatecknare', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Arende', default_text: 'Styrelsen behandlade fragan om firmateckning.' },
      { key: 'current', title: 'Nuvarande firmatecknare', default_text: '' },
      { key: 'proposed', title: 'Forslag till ny firmateckning', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: 'Styrelsen beslutade att firman tecknas av [namn] och [namn] var for sig / i forening.' },
      { key: 'registration', title: 'Registrering', default_text: 'Beslutet ska registreras hos Bolagsverket.' }
    ]
  }, 0);
  seedTemplate('Upphandlingsbeslut', 'Styrelsebeslut om upphandling', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: '' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'background', title: 'Bakgrund och behov', default_text: '' },
      { key: 'offers', title: 'Inkomna offerter', default_text: '' },
      { key: 'evaluation', title: 'Utvardering', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'budget', title: 'Budgetpaverkan', default_text: '' },
      { key: 'responsible', title: 'Ansvarig for genomforande', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('VD-instruktion', 'Mall for faststellande av VD-instruktion', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Arende', default_text: 'Styrelsen behandlade fragan om VD-instruktion.' },
      { key: 'authority', title: 'Befogenheter', default_text: '' },
      { key: 'reporting', title: 'Rapportering till styrelsen', default_text: '' },
      { key: 'limits', title: 'Beslutsgrander och beloppsgrander', default_text: '' },
      { key: 'responsibility', title: 'Ansvarsomraden', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: 'Styrelsen beslutade att faststalla VD-instruktion enligt bilaga.' }
    ]
  }, 0);
  seedTemplate('Investeringsbeslut', 'Styrelsebeslut om investering', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: '' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'proposal', title: 'Investeringsforslag', default_text: '' },
      { key: 'analysis', title: 'Analys och kalkyl', default_text: '' },
      { key: 'risk', title: 'Riskbedomning', default_text: '' },
      { key: 'financing', title: 'Finansiering', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'timeline', title: 'Tidsplan', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('Overlatelse Bostadsratt', 'Styrelsebeslut om overlatelse av bostadsratt', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Arende', default_text: 'Styrelsen behandlade inkommet arende om overlatelse av bostadsratt.' },
      { key: 'seller', title: 'Saljare', default_text: '' },
      { key: 'buyer', title: 'Kopare', default_text: '' },
      { key: 'apartment', title: 'Lagenhet', default_text: '' },
      { key: 'price', title: 'Overlatelsesumma', default_text: '' },
      { key: 'membership', title: 'Medlemsprovning', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' }
    ]
  }, 0);
  seedTemplate('Protokoll Arbetsgrupp', 'Protokoll for arbetsgruppsmote', 'protokoll', {
    sections: [
      { key: 'opening', title: 'Motets oppnande', default_text: '' },
      { key: 'attendees', title: 'Narvarande', default_text: '' },
      { key: 'purpose', title: 'Arbetsgruppens uppdrag', default_text: '' },
      { key: 'status', title: 'Lagesrapport', default_text: '' },
      { key: 'discussion', title: 'Diskussion', default_text: '' },
      { key: 'actions', title: 'Atgardspunkter', default_text: '' },
      { key: 'next', title: 'Nasta mote', default_text: '' },
      { key: 'closing', title: 'Motets avslutande', default_text: '' }
    ]
  }, 0);
  seedTemplate('Renovering / Andringsbeslut', 'Styrelsebeslut om renovering eller andring', 'protokoll', {
    sections: [
      { key: 'intro', title: 'Arende', default_text: '' },
      { key: 'description', title: 'Beskrivning av atgard', default_text: '' },
      { key: 'cost', title: 'Kostnadsbedoomning', default_text: '' },
      { key: 'offers', title: 'Offerter', default_text: '' },
      { key: 'timeline', title: 'Tidsplan', default_text: '' },
      { key: 'decision', title: 'Beslut', default_text: '' },
      { key: 'responsible', title: 'Ansvarig', default_text: '' }
    ]
  }, 0);
}

module.exports = db;
