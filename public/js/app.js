const BASE = (document.querySelector('base')?.href || '').replace(/\/$/, '') || '/conferra';
const API = BASE + '/api';

let currentUser = null;
let currentOrg = null;
let currentMeeting = null;
let editingOrgId = null;
let editingMemberId = null;
let templates = [];
let signCanvas = null;
let signCtx = null;
let isDrawing = false;

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname.replace(BASE, '');
  if (path.startsWith('/sign/')) {
    loadSignPage(path.split('/sign/')[1]);
    return;
  }
  const token = localStorage.getItem('conferra_token');
  if (token) {
    fetchMe();
  } else {
    showLanding();
  }
});

// ─── API helpers ───
async function api(url, opts = {}) {
  const token = localStorage.getItem('conferra_token');
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + url, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('conferra_token');
    showLanding();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function openModal(id) {
  document.getElementById(id).classList.add('show');
}

function confirmAction(title, text, onConfirm) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text;
  const btn = document.getElementById('confirmBtn');
  btn.onclick = () => { closeModal('confirmModal'); onConfirm(); };
  openModal('confirmModal');
}

// ─── Auth ───
async function fetchMe() {
  try {
    const data = await api('/auth/me');
    currentUser = data.user;
    showApp();
  } catch {
    localStorage.removeItem('conferra_token');
    showLanding();
  }
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return toast('Fyll i alla falt', 'error');
  try {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    localStorage.setItem('conferra_token', data.token);
    currentUser = data.user;
    showApp();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const company = document.getElementById('regCompany').value.trim();
  if (!name || !email || !password) return toast('Fyll i alla obligatoriska falt', 'error');
  try {
    const data = await api('/auth/register', { method: 'POST', body: { name, email, password, company } });
    localStorage.setItem('conferra_token', data.token);
    currentUser = data.user;
    showApp();
    toast('Konto skapat!', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function logout() {
  localStorage.removeItem('conferra_token');
  currentUser = null;
  currentOrg = null;
  currentMeeting = null;
  showLanding();
}

// ─── Landing Page ───
function showLanding() {
  document.getElementById('app').innerHTML = `
    <div class="landing-page">
      <div class="landing-hero">
        <h1>Novadraft</h1>
        <p>Professionella styrelseprotokoll pa nagra minuter. AI-assisterad skrivhjalp, digital signering och PDF-export enligt svensk standard.</p>
        <button class="btn btn-primary btn-lg" onclick="showAuth()">Kom igang gratis</button>
        <button class="btn btn-outline btn-lg" style="color:#fff;border-color:rgba(255,255,255,.3);margin-left:8px" onclick="showAuth('login')">Logga in</button>
      </div>
      <div class="landing-features">
        <h2>Allt du behover for professionella protokoll</h2>
        <div class="features-grid">
          <div class="feature-card">
            <div class="feature-icon">&#128221;</div>
            <h3>Smarta mallar</h3>
            <p>Fardiga mallar for styrelsemoten, arsmoten och konstituerande moten enligt svensk praxis.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">&#129302;</div>
            <h3>AI-assistent</h3>
            <p>Lat AI hjalpa dig formulera beslut och formatera text till korrekt protokollsprak.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">&#9997;</div>
            <h3>Digital signering</h3>
            <p>Sekreterare och justerare signerar digitalt. Delningslank for enkel signering.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">&#128196;</div>
            <h3>PDF-export</h3>
            <p>Generera snygga PDF-protokoll med logotyp, signaturer och allt pa ratt plats.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">&#127970;</div>
            <h3>Organisationshantering</h3>
            <p>Hantera flera organisationer, styrelsemedlemmar och deras roller pa ett stalle.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">&#128274;</div>
            <h3>Sakert och privat</h3>
            <p>All data krypterad. Uppfyller GDPR-krav for svensk foreningsverksamhet.</p>
          </div>
        </div>
      </div>
      <div class="landing-pricing" id="pricing">
        <h2>Valj plan</h2>
        <div class="pricing-grid">
          <div class="pricing-card">
            <h3>Gratis</h3>
            <div class="pricing-price">0 kr</div>
            <div class="pricing-period">for alltid</div>
            <ul class="pricing-features">
              <li>1 organisation</li>
              <li>5 protokoll/manad</li>
              <li>Grundmallar</li>
              <li>PDF-export</li>
              <li>Digital signering</li>
            </ul>
            <button class="btn btn-outline btn-block" onclick="showAuth()">Borja gratis</button>
          </div>
          <div class="pricing-card featured">
            <h3>Premium</h3>
            <div class="pricing-price">149 kr</div>
            <div class="pricing-period">per manad</div>
            <ul class="pricing-features">
              <li>Obegransat antal organisationer</li>
              <li>Obegransat antal protokoll</li>
              <li>AI-textassistent</li>
              <li>Anpassade mallar</li>
              <li>Logotyp pa protokoll</li>
              <li>Prioriterad support</li>
            </ul>
            <button class="btn btn-primary btn-block" onclick="showAuth()">Starta premium</button>
          </div>
        </div>
      </div>
      <div class="landing-newsletter">
        <h2>Halla dig uppdaterad</h2>
        <p>Prenumerera pa vart nyhetsbrev for tips och uppdateringar.</p>
        <div class="newsletter-form">
          <input type="email" id="newsletterEmail" placeholder="Din e-postadress">
          <button class="btn btn-primary" onclick="subscribeNewsletter()">Prenumerera</button>
        </div>
      </div>
      <div class="landing-footer">
        &copy; 2026 Novadraft. Protokoll for moderna styrelser.
      </div>
    </div>
  `;
}

async function subscribeNewsletter() {
  const email = document.getElementById('newsletterEmail').value.trim();
  if (!email) return toast('Ange din e-postadress', 'error');
  try {
    await api('/newsletter/subscribe', { method: 'POST', body: { email } });
    toast('Tack for din prenumeration!', 'success');
    document.getElementById('newsletterEmail').value = '';
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Auth Page ───
function showAuth(tab = 'register') {
  document.getElementById('app').innerHTML = `
    <div class="auth-page">
      <div class="auth-container">
        <div class="auth-logo">
          <h1>Novadraft</h1>
          <p>Styrelseprotokoll pa ett smartare satt</p>
        </div>
        <div class="auth-tabs">
          <div class="auth-tab ${tab === 'login' ? 'active' : ''}" onclick="switchAuthTab('login')">Logga in</div>
          <div class="auth-tab ${tab === 'register' ? 'active' : ''}" onclick="switchAuthTab('register')">Registrera</div>
        </div>
        <div id="loginForm" style="display:${tab === 'login' ? 'block' : 'none'}">
          <div class="form-group">
            <label>E-post</label>
            <input type="email" id="loginEmail" placeholder="namn@example.com">
          </div>
          <div class="form-group">
            <label>Losenord</label>
            <input type="password" id="loginPassword" placeholder="Ditt losenord" onkeydown="if(event.key==='Enter')doLogin()">
          </div>
          <button class="btn btn-primary btn-block btn-lg" onclick="doLogin()">Logga in</button>
        </div>
        <div id="registerForm" style="display:${tab === 'register' ? 'block' : 'none'}">
          <div class="form-group">
            <label>Namn *</label>
            <input type="text" id="regName" placeholder="Ditt fullstandiga namn">
          </div>
          <div class="form-group">
            <label>E-post *</label>
            <input type="email" id="regEmail" placeholder="namn@example.com">
          </div>
          <div class="form-group">
            <label>Losenord *</label>
            <input type="password" id="regPassword" placeholder="Minst 6 tecken">
          </div>
          <div class="form-group">
            <label>Foretag/Forening</label>
            <input type="text" id="regCompany" placeholder="Valfritt">
          </div>
          <button class="btn btn-primary btn-block btn-lg" onclick="doRegister()">Skapa konto</button>
        </div>
        <p style="text-align:center;margin-top:16px;font-size:13px;color:var(--text-light)">
          <a href="javascript:showLanding()">&larr; Tillbaka</a>
        </p>
      </div>
    </div>
  `;
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
}

// ─── App Shell ───
function showApp() {
  const isAdmin = currentUser.role === 'admin';
  document.getElementById('app').innerHTML = `
    <button class="mobile-menu-btn" onclick="toggleSidebar()">&#9776;</button>
    <div class="app-layout">
      <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <h1>Novadraft</h1>
          <p>Protokollhantering</p>
        </div>
        <div class="sidebar-nav">
          <div class="sidebar-section">
            <div class="sidebar-section-title">Meny</div>
            <div class="nav-item active" data-page="dashboard" onclick="navigateTo('dashboard')">
              <span class="nav-icon">&#127968;</span> Oversikt
            </div>
            <div class="nav-item" data-page="organizations" onclick="navigateTo('organizations')">
              <span class="nav-icon">&#127970;</span> Organisationer
            </div>
            <div class="nav-item" data-page="meetings" onclick="navigateTo('meetings')">
              <span class="nav-icon">&#128221;</span> Moten
            </div>
            <div class="nav-item" data-page="templates" onclick="navigateTo('templates')">
              <span class="nav-icon">&#128203;</span> Mallar
            </div>
          </div>
          ${isAdmin ? `
          <div class="sidebar-section">
            <div class="sidebar-section-title">Admin</div>
            <div class="nav-item" data-page="admin-users" onclick="navigateTo('admin-users')">
              <span class="nav-icon">&#128101;</span> Anvandare
            </div>
            <div class="nav-item" data-page="admin-stats" onclick="navigateTo('admin-stats')">
              <span class="nav-icon">&#128202;</span> Statistik
            </div>
          </div>
          ` : ''}
          <div class="sidebar-section">
            <div class="sidebar-section-title">Konto</div>
            <div class="nav-item" data-page="profile" onclick="navigateTo('profile')">
              <span class="nav-icon">&#128100;</span> Profil
            </div>
            <div class="nav-item" onclick="logout()">
              <span class="nav-icon">&#128682;</span> Logga ut
            </div>
          </div>
        </div>
        <div class="sidebar-footer">
          <div class="sidebar-user">
            <div class="sidebar-user-avatar">${currentUser.name.charAt(0).toUpperCase()}</div>
            <div class="sidebar-user-info">
              <div class="sidebar-user-name">${esc(currentUser.name)}</div>
              <div class="sidebar-user-plan">${currentUser.plan} plan</div>
            </div>
          </div>
        </div>
      </div>
      <div class="main-content">
        <div class="content-header" id="contentHeader"></div>
        <div class="content-body" id="contentBody"></div>
      </div>
    </div>
  `;
  navigateTo('dashboard');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const active = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (active) active.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');

  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'organizations': loadOrganizations(); break;
    case 'meetings': loadAllMeetings(); break;
    case 'templates': loadTemplates(); break;
    case 'profile': loadProfile(); break;
    case 'admin-users': loadAdminUsers(); break;
    case 'admin-stats': loadAdminStats(); break;
    default: loadDashboard();
  }
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

function statusBadge(s) {
  const labels = { draft: 'Utkast', active: 'Pagaende', completed: 'Klart', signed: 'Signerat' };
  return `<span class="badge badge-${s}">${labels[s] || s}</span>`;
}

function typeLabel(t) {
  const labels = { board: 'Styrelsemote', annual: 'Arsmote', inaugural: 'Konstituerande', extra: 'Extra mote' };
  return labels[t] || t;
}

function orgTypeLabel(t) {
  const labels = { company: 'Foretag', association: 'Forening', nonprofit: 'Ideell forening', hoa: 'Brf', other: 'Ovrigt' };
  return labels[t] || t;
}

function roleLabel(r) {
  const labels = { member: 'Medlem', chairman: 'Ordforande', vice_chairman: 'Vice ordforande', secretary: 'Sekreterare', treasurer: 'Kassor', auditor: 'Revisor', alternate: 'Suppleant' };
  return labels[r] || r;
}

// ─── Dashboard ───
async function loadDashboard() {
  document.getElementById('contentHeader').innerHTML = '<h2>Oversikt</h2>';
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const [orgsData, meetings] = await Promise.all([
      api('/organizations'),
      api('/meetings/recent')
    ]);
    const orgs = orgsData.organizations || orgsData;
    const orgCount = orgs.length || 0;
    const meetingCount = meetings.length || 0;
    const signed = meetings.filter(m => m.status === 'signed').length;

    document.getElementById('contentBody').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">&#127970;</div>
          <div class="stat-label">Organisationer</div>
          <div class="stat-value">${orgCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">&#128221;</div>
          <div class="stat-label">Moten totalt</div>
          <div class="stat-value">${meetingCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">&#9997;</div>
          <div class="stat-label">Signerade</div>
          <div class="stat-value">${signed}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>Senaste moten</h3>
          <button class="btn btn-sm btn-primary" onclick="navigateTo('organizations')">Nytt mote</button>
        </div>
        <div class="card-body">
          ${meetings.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">&#128221;</div>
              <h3>Inga moten annu</h3>
              <p>Skapa en organisation och borja skriva protokoll.</p>
              <button class="btn btn-primary" onclick="navigateTo('organizations')">Skapa organisation</button>
            </div>
          ` : `
            <div class="meeting-list">
              ${meetings.map(m => `
                <div class="meeting-row" onclick="openMeeting('${m.id}')">
                  <div class="meeting-row-number">#${m.meeting_number || '-'}</div>
                  <div class="meeting-row-info">
                    <div class="meeting-row-title">${esc(m.title)}</div>
                    <div class="meeting-row-date">${esc(m.org_name || '')} &middot; ${formatDate(m.meeting_date)} &middot; ${typeLabel(m.meeting_type)}</div>
                  </div>
                  <div class="meeting-row-status">${statusBadge(m.status)}</div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Kunde inte ladda: ${esc(e.message)}</p>`;
  }
}

// ─── Organizations ───
async function loadOrganizations() {
  document.getElementById('contentHeader').innerHTML = `
    <h2>Organisationer</h2>
    <div class="content-header-actions">
      <button class="btn btn-primary" onclick="showOrgModal()">+ Ny organisation</button>
    </div>
  `;
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const data = await api('/organizations');
    const orgs = data.organizations || data;
    if (orgs.length === 0) {
      document.getElementById('contentBody').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#127970;</div>
          <h3>Inga organisationer</h3>
          <p>Skapa din forsta organisation for att borja skriva protokoll.</p>
          <button class="btn btn-primary" onclick="showOrgModal()">Skapa organisation</button>
        </div>
      `;
    } else {
      document.getElementById('contentBody').innerHTML = `
        <div class="org-grid">
          ${orgs.map(o => `
            <div class="org-card" onclick="openOrg('${o.id}')">
              <div class="org-card-header">
                <div class="org-logo">
                  ${o.logo_filename ? `<img src="${API}/organizations/${o.id}/logo" alt="">` : esc(o.name.charAt(0))}
                </div>
                <div class="org-card-info">
                  <h3>${esc(o.name)}</h3>
                  <p>${orgTypeLabel(o.type)}${o.org_number ? ' &middot; ' + esc(o.org_number) : ''}</p>
                </div>
              </div>
              <div class="org-card-meta">
                <span>${o.member_count || 0} medlemmar</span>
                <span>${o.meeting_count || 0} moten</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

function showOrgModal(org = null) {
  editingOrgId = org ? org.id : null;
  document.getElementById('orgModalTitle').textContent = org ? 'Redigera organisation' : 'Ny organisation';
  document.getElementById('orgName').value = org ? org.name : '';
  document.getElementById('orgNumber').value = org ? (org.org_number || '') : '';
  document.getElementById('orgType').value = org ? org.type : 'company';
  document.getElementById('orgAddress').value = org ? (org.address || '') : '';
  document.getElementById('orgCity').value = org ? (org.city || '') : '';
  document.getElementById('orgPostalCode').value = org ? (org.postal_code || '') : '';
  openModal('orgModal');
}

async function saveOrg() {
  const body = {
    name: document.getElementById('orgName').value.trim(),
    org_number: document.getElementById('orgNumber').value.trim(),
    type: document.getElementById('orgType').value,
    address: document.getElementById('orgAddress').value.trim(),
    city: document.getElementById('orgCity').value.trim(),
    postal_code: document.getElementById('orgPostalCode').value.trim()
  };
  if (!body.name) return toast('Ange organisationens namn', 'error');
  try {
    if (editingOrgId) {
      await api('/organizations/' + editingOrgId, { method: 'PUT', body });
      toast('Organisation uppdaterad', 'success');
    } else {
      await api('/organizations', { method: 'POST', body });
      toast('Organisation skapad!', 'success');
    }
    closeModal('orgModal');
    loadOrganizations();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Org Detail ───
async function openOrg(id) {
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const [orgData, membersData, meetingsData] = await Promise.all([
      api('/organizations/' + id),
      api('/organizations/' + id + '/members'),
      api('/organizations/' + id + '/meetings')
    ]);
    const org = orgData.organization || orgData;
    const members = membersData.members || membersData;
    const meetings = meetingsData.meetings || meetingsData;
    currentOrg = org;

    document.getElementById('contentHeader').innerHTML = `
      <h2>${esc(org.name)}</h2>
      <div class="content-header-actions">
        <button class="btn btn-sm btn-outline" onclick="navigateTo('organizations')">&larr; Tillbaka</button>
        <button class="btn btn-sm btn-outline" onclick="showOrgModal(currentOrg)">Redigera</button>
        <button class="btn btn-sm btn-danger" onclick="deleteOrg('${org.id}')">Ta bort</button>
      </div>
    `;

    document.getElementById('contentBody').innerHTML = `
      <div class="tabs">
        <div class="tab active" onclick="switchOrgTab('info', this)">Information</div>
        <div class="tab" onclick="switchOrgTab('members', this)">Medlemmar (${members.length})</div>
        <div class="tab" onclick="switchOrgTab('meetings', this)">Moten (${meetings.length})</div>
      </div>
      <div id="orgTabContent"></div>
    `;

    window._orgMembers = members;
    window._orgMeetings = meetings;
    switchOrgTab('info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function switchOrgTab(tab, el) {
  document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  else document.querySelectorAll('.tabs .tab')[tab === 'info' ? 0 : tab === 'members' ? 1 : 2].classList.add('active');

  const cont = document.getElementById('orgTabContent');
  if (tab === 'info') {
    cont.innerHTML = `
      <div class="card" style="max-width:600px">
        <div class="card-body">
          <p><strong>Typ:</strong> ${orgTypeLabel(currentOrg.type)}</p>
          <p><strong>Org.nummer:</strong> ${esc(currentOrg.org_number) || '-'}</p>
          <p><strong>Adress:</strong> ${esc(currentOrg.address) || '-'}</p>
          <p><strong>Stad:</strong> ${esc(currentOrg.city) || '-'} ${esc(currentOrg.postal_code) || ''}</p>
          <div style="margin-top:16px">
            <label style="font-size:13px;font-weight:500;display:block;margin-bottom:6px">Logotyp</label>
            ${currentOrg.logo_filename ? `<img src="${API}/organizations/${currentOrg.id}/logo" style="max-width:200px;max-height:100px;border-radius:var(--radius);margin-bottom:8px;display:block" alt="">` : '<p style="color:var(--text-light);font-size:14px">Ingen logotyp uppladdad</p>'}
            <input type="file" accept="image/*" onchange="uploadOrgLogo(this.files[0])" style="margin-top:8px">
          </div>
        </div>
      </div>
    `;
  } else if (tab === 'members') {
    const members = window._orgMembers || [];
    cont.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Styrelsemedlemmar</h3>
          <button class="btn btn-sm btn-primary" onclick="showMemberModal()">+ Lagg till</button>
        </div>
        <div class="card-body">
          ${members.length === 0 ? '<p style="color:var(--text-light)">Inga medlemmar annu. Lagg till styrelseledamoter.</p>' : `
            <div class="table-container">
              <table>
                <thead><tr><th>Namn</th><th>E-post</th><th>Titel</th><th>Roll</th><th></th></tr></thead>
                <tbody>
                  ${members.map(m => `
                    <tr>
                      <td>${esc(m.name)}</td>
                      <td>${esc(m.email) || '-'}</td>
                      <td>${esc(m.title) || '-'}</td>
                      <td>${roleLabel(m.role)}</td>
                      <td style="text-align:right">
                        <button class="btn btn-ghost btn-sm" onclick="showMemberModal(${JSON.stringify(m).replace(/"/g, '&quot;')})">Redigera</button>
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteMember('${m.id}')">Ta bort</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    `;
  } else if (tab === 'meetings') {
    const meetings = window._orgMeetings || [];
    cont.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Moten</h3>
          <button class="btn btn-sm btn-primary" onclick="showMeetingModal()">+ Nytt mote</button>
        </div>
        <div class="card-body">
          ${meetings.length === 0 ? '<p style="color:var(--text-light)">Inga moten annu.</p>' : `
            <div class="meeting-list">
              ${meetings.map(m => `
                <div class="meeting-row" onclick="openMeeting('${m.id}')">
                  <div class="meeting-row-number">#${m.meeting_number || '-'}</div>
                  <div class="meeting-row-info">
                    <div class="meeting-row-title">${esc(m.title)}</div>
                    <div class="meeting-row-date">${formatDate(m.meeting_date)} ${m.meeting_time || ''} &middot; ${typeLabel(m.meeting_type)}</div>
                  </div>
                  <div class="meeting-row-status">${statusBadge(m.status)}</div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;
  }
}

async function uploadOrgLogo(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('logo', file);
  try {
    await api('/organizations/' + currentOrg.id + '/logo', { method: 'POST', body: fd });
    toast('Logotyp uppladdad', 'success');
    openOrg(currentOrg.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function deleteOrg(id) {
  confirmAction('Ta bort organisation', 'Ar du saker? Alla moten och data tas bort permanent.', async () => {
    try {
      await api('/organizations/' + id, { method: 'DELETE' });
      toast('Organisation borttagen', 'success');
      loadOrganizations();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ─── Members ───
function showMemberModal(member = null) {
  editingMemberId = member ? member.id : null;
  document.getElementById('memberModalTitle').textContent = member ? 'Redigera medlem' : 'Lagg till medlem';
  document.getElementById('memberName').value = member ? member.name : '';
  document.getElementById('memberEmail').value = member ? (member.email || '') : '';
  document.getElementById('memberTitle').value = member ? (member.title || '') : '';
  document.getElementById('memberRole').value = member ? member.role : 'member';
  openModal('memberModal');
}

async function saveMember() {
  const body = {
    name: document.getElementById('memberName').value.trim(),
    email: document.getElementById('memberEmail').value.trim(),
    title: document.getElementById('memberTitle').value.trim(),
    role: document.getElementById('memberRole').value
  };
  if (!body.name) return toast('Ange namn', 'error');
  try {
    if (editingMemberId) {
      await api('/organizations/' + currentOrg.id + '/members/' + editingMemberId, { method: 'PUT', body });
    } else {
      await api('/organizations/' + currentOrg.id + '/members', { method: 'POST', body });
    }
    closeModal('memberModal');
    toast('Medlem sparad', 'success');
    openOrg(currentOrg.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function deleteMember(id) {
  confirmAction('Ta bort medlem', 'Vill du ta bort den har medlemmen?', async () => {
    try {
      await api('/organizations/' + currentOrg.id + '/members/' + id, { method: 'DELETE' });
      toast('Medlem borttagen', 'success');
      openOrg(currentOrg.id);
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ─── Meetings ───
async function loadAllMeetings() {
  document.getElementById('contentHeader').innerHTML = '<h2>Alla moten</h2>';
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const meetings = await api('/meetings/recent');
    if (meetings.length === 0) {
      document.getElementById('contentBody').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#128221;</div>
          <h3>Inga moten</h3>
          <p>Skapa ett mote i en av dina organisationer.</p>
        </div>
      `;
    } else {
      document.getElementById('contentBody').innerHTML = `
        <div class="meeting-list">
          ${meetings.map(m => `
            <div class="meeting-row" onclick="openMeeting('${m.id}')">
              <div class="meeting-row-number">#${m.meeting_number || '-'}</div>
              <div class="meeting-row-info">
                <div class="meeting-row-title">${esc(m.title)}</div>
                <div class="meeting-row-date">${esc(m.org_name || '')} &middot; ${formatDate(m.meeting_date)} &middot; ${typeLabel(m.meeting_type)}</div>
              </div>
              <div class="meeting-row-status">${statusBadge(m.status)}</div>
            </div>
          `).join('')}
        </div>
      `;
    }
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

async function showMeetingModal() {
  try {
    const td = await api('/templates');
    templates = td.templates || td;
  } catch { templates = []; }
  const sel = document.getElementById('meetingTemplate');
  sel.innerHTML = templates.map(t => `<option value="${t.id}" ${t.is_default ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  document.getElementById('meetingTitle').value = '';
  document.getElementById('meetingType').value = 'board';
  document.getElementById('meetingDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('meetingTime').value = '';
  document.getElementById('meetingLocation').value = '';
  openModal('meetingModal');
}

async function saveMeeting() {
  const body = {
    title: document.getElementById('meetingTitle').value.trim(),
    meeting_type: document.getElementById('meetingType').value,
    template: document.getElementById('meetingTemplate').value,
    meeting_date: document.getElementById('meetingDate').value,
    meeting_time: document.getElementById('meetingTime').value,
    location: document.getElementById('meetingLocation').value.trim()
  };
  if (!body.title || !body.meeting_date) return toast('Fyll i titel och datum', 'error');
  try {
    const resp = await api('/organizations/' + currentOrg.id + '/meetings', { method: 'POST', body });
    const m = resp.meeting || resp;
    closeModal('meetingModal');
    toast('Mote skapat!', 'success');
    openMeeting(m.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Meeting Editor ───
async function openMeeting(id) {
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const data = await api('/meetings/' + id);
    const m = data.meeting || data;
    if (data.attendees) m.attendees = data.attendees;
    if (data.agendaItems) m.agenda_items = data.agendaItems;
    if (data.signatures) m.signatures = data.signatures;
    if (data.organization) currentOrg = data.organization;
    currentMeeting = m;
    currentOrg = currentOrg || { id: m.org_id };

    document.getElementById('contentHeader').innerHTML = `
      <h2>${esc(m.title)}</h2>
      <div class="content-header-actions">
        <button class="btn btn-sm btn-outline" onclick="openOrg('${m.org_id}')">&larr; Organisation</button>
        ${m.status === 'draft' ? `<button class="btn btn-sm btn-success" onclick="updateMeetingStatus('${m.id}','active')">Starta mote</button>` : ''}
        ${m.status === 'active' ? `<button class="btn btn-sm btn-success" onclick="updateMeetingStatus('${m.id}','completed')">Avsluta mote</button>` : ''}
        ${m.status === 'completed' ? `<button class="btn btn-sm btn-primary" onclick="prepareSignatures('${m.id}')">Forbered signering</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="downloadPdf('${m.id}')">PDF</button>
        <button class="ai-btn" onclick="openAiModal()">AI-assistent</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMeeting('${m.id}')">Ta bort</button>
      </div>
    `;

    renderMeetingEditor(m);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderMeetingEditor(m) {
  const attendees = m.attendees || [];
  const agenda = m.agenda_items || [];
  const signatures = m.signatures || [];
  const members = window._orgMembers || [];

  document.getElementById('contentBody').innerHTML = `
    <div class="meeting-layout">
      <div class="meeting-editor">
        <!-- Meeting details -->
        <div class="card">
          <div class="card-header"><h3>Motesinformation</h3></div>
          <div class="card-body">
            <div class="form-row">
              <div class="form-group">
                <label>Datum</label>
                <input type="date" value="${m.meeting_date || ''}" onchange="updateMeetingField('meeting_date', this.value)">
              </div>
              <div class="form-group">
                <label>Tid</label>
                <input type="time" value="${m.meeting_time || ''}" onchange="updateMeetingField('meeting_time', this.value)">
              </div>
            </div>
            <div class="form-group">
              <label>Plats</label>
              <input type="text" value="${esc(m.location || '')}" onchange="updateMeetingField('location', this.value)" placeholder="Kontoret, digitalt, etc.">
            </div>
            <div class="form-group">
              <label>Anteckningar</label>
              <textarea rows="2" onchange="updateMeetingField('notes', this.value)" placeholder="Frivilliga anteckningar...">${esc(m.notes || '')}</textarea>
            </div>
          </div>
        </div>

        <!-- Agenda items -->
        <div class="card">
          <div class="card-header">
            <h3>Dagordning</h3>
            <button class="btn btn-sm btn-primary" onclick="addAgendaItem()">+ Ny punkt</button>
          </div>
          <div class="card-body" id="agendaList">
            ${agenda.length === 0 ? '<p style="color:var(--text-light)">Inga dagordningspunkter annu. Klicka "+ Ny punkt" for att borja.</p>' : ''}
            ${agenda.map((item, i) => renderAgendaItem(item, i)).join('')}
          </div>
        </div>

        <!-- Signatures -->
        ${signatures.length > 0 ? `
        <div class="card">
          <div class="card-header"><h3>Signaturer</h3></div>
          <div class="card-body">
            ${signatures.map(s => `
              <div class="signature-slot ${s.status === 'signed' ? 'signed' : ''}">
                <div class="sig-role">${esc(s.role)}</div>
                <div class="sig-name">${esc(s.name)}</div>
                ${s.status === 'signed' ? `
                  ${s.signature_data ? `<img src="${s.signature_data}" alt="Signatur">` : ''}
                  <div class="sig-status present">Signerat ${s.signed_at || ''}</div>
                ` : `
                  <div class="sig-status">Vantar pa signering</div>
                  ${s.token ? `<p style="font-size:12px;margin-top:8px"><a href="${window.location.origin}${BASE}/sign/${s.token}" target="_blank">Signeringslank</a></p>` : ''}
                `}
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}
      </div>

      <!-- Sidebar -->
      <div class="meeting-sidebar-panel">
        <div class="card">
          <div class="card-header">
            <h3>Status</h3>
          </div>
          <div class="card-body">
            <p>${statusBadge(m.status)}</p>
            <p style="font-size:13px;color:var(--text-light);margin-top:8px">
              ${typeLabel(m.meeting_type)} #${m.meeting_number || '-'}
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>Roller</h3>
          </div>
          <div class="card-body">
            <div class="form-group">
              <label>Ordforande</label>
              <select onchange="updateMeetingField('chairman_id', this.value)">
                <option value="">Valj...</option>
                ${attendees.map(a => `<option value="${a.member_id || a.id}" ${(m.chairman_id === a.member_id || m.chairman_id === a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Sekreterare</label>
              <select onchange="updateMeetingField('secretary_id', this.value)">
                <option value="">Valj...</option>
                ${attendees.map(a => `<option value="${a.member_id || a.id}" ${(m.secretary_id === a.member_id || m.secretary_id === a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Justerare 1</label>
              <select onchange="updateMeetingField('adjuster1_id', this.value)">
                <option value="">Valj...</option>
                ${attendees.map(a => `<option value="${a.member_id || a.id}" ${(m.adjuster1_id === a.member_id || m.adjuster1_id === a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Justerare 2</label>
              <select onchange="updateMeetingField('adjuster2_id', this.value)">
                <option value="">Valj...</option>
                ${attendees.map(a => `<option value="${a.member_id || a.id}" ${(m.adjuster2_id === a.member_id || m.adjuster2_id === a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>Narvarande (${attendees.length})</h3>
            <button class="btn btn-sm btn-outline" onclick="showAddAttendeeDropdown('${m.id}')">+</button>
          </div>
          <div class="card-body">
            <div id="addAttendeeArea"></div>
            <ul class="attendee-list">
              ${attendees.map(a => `
                <li class="attendee-item">
                  <div class="attendee-avatar">${esc(a.name.charAt(0))}</div>
                  <div class="attendee-info">
                    <div class="attendee-name">${esc(a.name)}</div>
                    <div class="attendee-title">${esc(a.title) || ''}</div>
                  </div>
                  <span class="attendee-status ${a.present ? 'present' : 'absent'}" style="cursor:pointer" onclick="toggleAttendance('${m.id}','${a.id}',${a.present ? 0 : 1})">
                    ${a.present ? 'Narvarande' : 'Franvarande'}
                  </span>
                  <button class="btn btn-ghost btn-sm" style="color:var(--danger);padding:4px" onclick="removeAttendee('${m.id}','${a.id}')">x</button>
                </li>
              `).join('')}
            </ul>
            ${attendees.length === 0 ? '<p style="color:var(--text-light);font-size:13px">Lagg till narvarande fran organisationens medlemmar.</p>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAgendaItem(item, i) {
  return `
    <div class="agenda-item" data-id="${item.id}">
      <div class="agenda-item-header">
        <div class="agenda-item-number">${item.item_number || i + 1}</div>
        <div class="agenda-item-title">${esc(item.title)}</div>
        <div class="agenda-item-actions">
          <button class="ai-btn" style="font-size:11px;padding:3px 8px" onclick="aiForAgenda('${item.id}','${esc(item.title)}')">AI</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteAgendaItem('${item.id}')">x</button>
        </div>
      </div>
      <div class="agenda-item-body">
        <div class="form-group">
          <label>Titel</label>
          <input type="text" value="${esc(item.title)}" onchange="updateAgendaField('${item.id}','title',this.value)">
        </div>
        <div class="form-group">
          <label>Innehall/Diskussion</label>
          <textarea rows="3" onchange="updateAgendaField('${item.id}','content',this.value)" placeholder="Beskriv vad som diskuterades...">${esc(item.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Beslut</label>
          <textarea rows="2" onchange="updateAgendaField('${item.id}','decision',this.value)" placeholder="Eventuellt beslut...">${esc(item.decision || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Ansvarig</label>
            <input type="text" value="${esc(item.responsible || '')}" onchange="updateAgendaField('${item.id}','responsible',this.value)">
          </div>
          <div class="form-group">
            <label>Deadline</label>
            <input type="date" value="${item.deadline || ''}" onchange="updateAgendaField('${item.id}','deadline',this.value)">
          </div>
        </div>
        ${item.ai_draft ? `<div style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);border-radius:var(--radius);padding:10px;margin-top:8px;font-size:13px"><span class="ai-badge" style="margin-bottom:4px">AI-forslag</span><p style="margin-top:6px;white-space:pre-wrap">${esc(item.ai_draft)}</p><button class="btn btn-sm btn-outline" style="margin-top:8px" onclick="useAiDraft('${item.id}')">Anvand forslaget</button></div>` : ''}
      </div>
    </div>
  `;
}

async function updateMeetingField(field, value) {
  if (!currentMeeting) return;
  try {
    await api('/meetings/' + currentMeeting.id, { method: 'PUT', body: { [field]: value } });
    currentMeeting[field] = value;
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function updateMeetingStatus(id, status) {
  try {
    await api('/meetings/' + id + '/status', { method: 'PUT', body: { status } });
    toast('Status uppdaterad', 'success');
    openMeeting(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteMeeting(id) {
  confirmAction('Ta bort mote', 'Ar du saker? Motet och alla dess data tas bort permanent.', async () => {
    try {
      await api('/meetings/' + id, { method: 'DELETE' });
      toast('Mote borttaget', 'success');
      if (currentOrg) openOrg(currentOrg.id);
      else navigateTo('meetings');
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ─── Attendees ───
async function showAddAttendeeDropdown(meetingId) {
  const area = document.getElementById('addAttendeeArea');
  if (area.innerHTML) { area.innerHTML = ''; return; }
  let members = [];
  try {
    const md = await api('/organizations/' + currentMeeting.org_id + '/members');
    members = md.members || md;
  } catch { members = []; }
  area.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:8px;margin-bottom:12px">
      ${members.length === 0 ? '<p style="font-size:13px;color:var(--text-light)">Inga medlemmar i organisationen. Lagg till medlemmar forst.</p>' : ''}
      ${members.map(m => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0">
          <span style="font-size:13px">${esc(m.name)} <span style="color:var(--text-light)">(${roleLabel(m.role)})</span></span>
          <button class="btn btn-sm btn-outline" onclick="addAttendee('${meetingId}','${m.id}','${esc(m.name)}','${esc(m.title || '')}')">Lagg till</button>
        </div>
      `).join('')}
      <div style="border-top:1px solid var(--border-light);margin-top:8px;padding-top:8px">
        <input type="text" id="customAttendeeName" placeholder="Eller skriv namn manuellt" style="font-size:13px;padding:6px 8px">
        <button class="btn btn-sm btn-primary" style="margin-top:4px" onclick="addCustomAttendee('${meetingId}')">Lagg till</button>
      </div>
    </div>
  `;
}

async function addAttendee(meetingId, memberId, name, title) {
  try {
    await api('/meetings/' + meetingId + '/attendees', { method: 'POST', body: { member_id: memberId, name, title } });
    openMeeting(meetingId);
  } catch (e) { toast(e.message, 'error'); }
}

async function addCustomAttendee(meetingId) {
  const name = document.getElementById('customAttendeeName').value.trim();
  if (!name) return;
  try {
    await api('/meetings/' + meetingId + '/attendees', { method: 'POST', body: { name } });
    openMeeting(meetingId);
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleAttendance(meetingId, attendeeId, present) {
  try {
    await api('/meetings/' + meetingId + '/attendees/' + attendeeId, { method: 'PUT', body: { present } });
    openMeeting(meetingId);
  } catch (e) { toast(e.message, 'error'); }
}

async function removeAttendee(meetingId, attendeeId) {
  try {
    await api('/meetings/' + meetingId + '/attendees/' + attendeeId, { method: 'DELETE' });
    openMeeting(meetingId);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Agenda Items ───
async function addAgendaItem() {
  if (!currentMeeting) return;
  const items = currentMeeting.agenda_items || [];
  const nextNum = items.length + 1;
  try {
    await api('/meetings/' + currentMeeting.id + '/agenda', {
      method: 'POST',
      body: { title: 'Dagordningspunkt ' + nextNum, item_number: nextNum, sort_order: nextNum }
    });
    openMeeting(currentMeeting.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function updateAgendaField(itemId, field, value) {
  if (!currentMeeting) return;
  try {
    await api('/meetings/' + currentMeeting.id + '/agenda/' + itemId, { method: 'PUT', body: { [field]: value } });
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteAgendaItem(itemId) {
  if (!currentMeeting) return;
  try {
    await api('/meetings/' + currentMeeting.id + '/agenda/' + itemId, { method: 'DELETE' });
    openMeeting(currentMeeting.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function useAiDraft(itemId) {
  if (!currentMeeting) return;
  const item = (currentMeeting.agenda_items || []).find(a => a.id === itemId);
  if (!item || !item.ai_draft) return;
  try {
    await api('/meetings/' + currentMeeting.id + '/agenda/' + itemId, { method: 'PUT', body: { content: item.ai_draft } });
    toast('AI-forslag applicerat', 'success');
    openMeeting(currentMeeting.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── AI ───
function openAiModal() {
  document.getElementById('aiInput').value = '';
  document.getElementById('aiResult').style.display = 'none';
  document.getElementById('aiCopyBtn').style.display = 'none';
  openModal('aiModal');
}

async function generateAiText() {
  const text = document.getElementById('aiInput').value.trim();
  const type = document.getElementById('aiType').value;
  if (!text) return toast('Ange text forst', 'error');

  const btn = document.getElementById('aiGenerateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Genererar...';

  try {
    let endpoint, body;
    if (type === 'format') {
      endpoint = '/ai/format-text';
      body = { text };
    } else if (type === 'decision') {
      endpoint = '/ai/suggest-decision';
      body = { context: text };
    } else {
      endpoint = '/ai/summarize';
      body = { text };
    }
    const data = await api(endpoint, { method: 'POST', body });
    document.getElementById('aiResultText').textContent = data.result || data.text || '';
    document.getElementById('aiResult').style.display = 'block';
    document.getElementById('aiCopyBtn').style.display = 'inline-flex';
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generera';
  }
}

function copyAiResult() {
  const text = document.getElementById('aiResultText').textContent;
  navigator.clipboard.writeText(text).then(() => toast('Kopierat!', 'success'));
}

async function aiForAgenda(itemId, title) {
  if (!currentMeeting) return;
  const item = (currentMeeting.agenda_items || []).find(a => a.id === itemId);
  const context = (item?.content || '') + '\n\nTitel: ' + title;
  try {
    toast('AI genererar forslag...', 'info');
    const data = await api('/ai/suggest-decision', { method: 'POST', body: { context } });
    await api('/meetings/' + currentMeeting.id + '/agenda/' + itemId, { method: 'PUT', body: { ai_draft: data.result || data.text } });
    openMeeting(currentMeeting.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Signatures ───
async function prepareSignatures(meetingId) {
  try {
    await api('/meetings/' + meetingId + '/signatures/prepare', { method: 'POST' });
    toast('Signaturer forberedda - lankar skapade', 'success');
    openMeeting(meetingId);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── PDF ───
function downloadPdf(meetingId) {
  const token = localStorage.getItem('conferra_token');
  window.open(API + '/meetings/' + meetingId + '/pdf?token=' + token, '_blank');
}

// ─── Templates ───
async function loadTemplates() {
  document.getElementById('contentHeader').innerHTML = '<h2>Mallar</h2>';
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const tmplData = await api('/templates');
    templates = tmplData.templates || tmplData;
    document.getElementById('contentBody').innerHTML = `
      <div class="org-grid">
        ${templates.map(t => {
          let sections = [];
          try { sections = (typeof t.content === 'string' ? JSON.parse(t.content) : t.content).sections || []; } catch {}
          const typeLabel = { board: 'Styrelsemote', annual: 'Arsmote', inaugural: 'Konstituerande', extra: 'Extra', protokoll: 'Protokoll' }[t.type] || t.type;
          return `
            <div class="org-card" onclick="viewTemplate('${t.id}')" style="cursor:pointer">
              <div class="org-card-header">
                <div class="org-logo">${t.name.charAt(0).toUpperCase()}</div>
                <div class="org-card-info">
                  <h3>${esc(t.name)}</h3>
                  <p>${esc(t.description || '')}</p>
                </div>
              </div>
              <div class="org-card-meta">
                <span>${sections.length} sektioner</span>
                <span class="badge">${esc(typeLabel)}</span>
                ${t.is_default ? '<span class="badge badge-active">Standard</span>' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

async function viewTemplate(templateId) {
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const data = await api('/templates/' + templateId);
    const t = data.template;
    const content = typeof t.content === 'string' ? JSON.parse(t.content) : t.content;
    const sections = content.sections || [];
    document.getElementById('contentHeader').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-outline" onclick="loadTemplates()" style="padding:6px 10px">&larr;</button>
        <h2>${esc(t.name)}</h2>
        ${t.is_default ? '<span class="badge badge-active">Standard</span>' : ''}
      </div>
    `;
    document.getElementById('contentBody').innerHTML = `
      <div class="card" style="margin-bottom:20px">
        <div class="card-body">
          <p style="color:var(--text-light);margin-bottom:8px">${esc(t.description || '')}</p>
          <div style="display:flex;gap:16px;font-size:13px;color:var(--text-light)">
            <span>Typ: <strong>${esc(t.type || 'protokoll')}</strong></span>
            <span>Sektioner: <strong>${sections.length}</strong></span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Sektioner i mallen</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:40px">#</th>
                <th>Rubrik</th>
                <th>Nyckel</th>
                <th>Standardtext</th>
              </tr>
            </thead>
            <tbody>
              ${sections.map((s, i) => `
                <tr>
                  <td style="color:var(--text-light)">${i + 1}</td>
                  <td><strong>${esc(s.title)}</strong></td>
                  <td><code style="background:var(--border-light);padding:2px 6px;border-radius:4px;font-size:12px">${esc(s.key)}</code></td>
                  <td style="color:var(--text-light);font-size:13px">${s.default_text ? esc(s.default_text) : '<em style="opacity:0.5">Ingen standardtext</em>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div style="margin-top:16px;padding:16px;background:var(--bg-light);border-radius:var(--radius);font-size:13px;color:var(--text-light)">
        Denna mall anvands nar du skapar ett nytt mote och valjer den i malllistan. Sektionerna laggs automatiskt till som dagordningspunkter.
      </div>
    `;
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

// ─── Profile ───
async function loadProfile() {
  document.getElementById('contentHeader').innerHTML = '<h2>Profil</h2>';
  document.getElementById('contentBody').innerHTML = `
    <div class="profile-section">
      <div class="card">
        <div class="card-header"><h3>Kontoinformation</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label>Namn</label>
            <input type="text" id="profileName" value="${esc(currentUser.name)}">
          </div>
          <div class="form-group">
            <label>E-post</label>
            <input type="email" id="profileEmail" value="${esc(currentUser.email)}">
          </div>
          <div class="form-group">
            <label>Foretag</label>
            <input type="text" id="profileCompany" value="${esc(currentUser.company || '')}">
          </div>
          <button class="btn btn-primary" onclick="saveProfile()">Spara</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Byt losenord</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label>Nuvarande losenord</label>
            <input type="password" id="currentPw">
          </div>
          <div class="form-group">
            <label>Nytt losenord</label>
            <input type="password" id="newPw">
          </div>
          <button class="btn btn-primary" onclick="changePassword()">Byt losenord</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Plan</h3></div>
        <div class="card-body">
          <p>Nuvarande plan: <span class="badge badge-${currentUser.plan}">${currentUser.plan}</span></p>
          ${currentUser.plan === 'free' ? '<p style="margin-top:8px"><a href="#pricing" onclick="showLanding()">Uppgradera till Premium</a> for obegransade protokoll och AI-assistent.</p>' : '<p style="margin-top:8px;color:var(--success)">Du har full tillgang till alla funktioner.</p>'}
        </div>
      </div>
    </div>
  `;
}

async function saveProfile() {
  try {
    const body = {
      name: document.getElementById('profileName').value.trim(),
      email: document.getElementById('profileEmail').value.trim(),
      company: document.getElementById('profileCompany').value.trim()
    };
    const data = await api('/auth/profile', { method: 'PUT', body });
    currentUser = data.user;
    toast('Profil uppdaterad', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function changePassword() {
  try {
    await api('/auth/password', { method: 'PUT', body: {
      current_password: document.getElementById('currentPw').value,
      new_password: document.getElementById('newPw').value
    }});
    toast('Losenord andrat', 'success');
    document.getElementById('currentPw').value = '';
    document.getElementById('newPw').value = '';
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Admin ───
async function loadAdminUsers() {
  document.getElementById('contentHeader').innerHTML = '<h2>Anvandare</h2>';
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const usersData = await api('/admin/users');
    const users = usersData.users || usersData;
    document.getElementById('contentBody').innerHTML = `
      <div class="card">
        <div class="card-body">
          <div class="table-container">
            <table>
              <thead><tr><th>Namn</th><th>E-post</th><th>Roll</th><th>Plan</th><th>Skapad</th><th></th></tr></thead>
              <tbody>
                ${users.map(u => `
                  <tr>
                    <td>${esc(u.name)}</td>
                    <td>${esc(u.email)}</td>
                    <td><span class="badge badge-${u.role === 'admin' ? 'admin' : 'active'}">${u.role}</span></td>
                    <td><span class="badge badge-${u.plan}">${u.plan}</span></td>
                    <td style="font-size:13px">${u.created_at ? u.created_at.split('T')[0] : ''}</td>
                    <td style="text-align:right">
                      <select style="font-size:12px;padding:4px" onchange="updateUserAdmin('${u.id}',this.value)">
                        <option value="">Andring...</option>
                        <option value="plan:free">Plan: Free</option>
                        <option value="plan:premium">Plan: Premium</option>
                        <option value="role:user">Roll: User</option>
                        <option value="role:admin">Roll: Admin</option>
                        <option value="active:0">Inaktivera</option>
                        <option value="active:1">Aktivera</option>
                      </select>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

async function updateUserAdmin(userId, action) {
  if (!action) return;
  const [field, value] = action.split(':');
  const body = {};
  if (field === 'plan') body.plan = value;
  else if (field === 'role') body.role = value;
  else if (field === 'active') body.is_active = parseInt(value);
  try {
    await api('/admin/users/' + userId, { method: 'PUT', body });
    toast('Anvandare uppdaterad', 'success');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadAdminStats() {
  document.getElementById('contentHeader').innerHTML = '<h2>Statistik</h2>';
  document.getElementById('contentBody').innerHTML = '<div class="spinner spinner-dark"></div>';
  try {
    const stats = await api('/admin/stats');
    document.getElementById('contentBody').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">&#128101;</div>
          <div class="stat-label">Anvandare</div>
          <div class="stat-value">${stats.users || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">&#127970;</div>
          <div class="stat-label">Organisationer</div>
          <div class="stat-value">${stats.organizations || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">&#128221;</div>
          <div class="stat-label">Moten</div>
          <div class="stat-value">${stats.meetings || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">&#9997;</div>
          <div class="stat-label">Signaturer</div>
          <div class="stat-value">${stats.signatures || 0}</div>
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('contentBody').innerHTML = `<p>Fel: ${esc(e.message)}</p>`;
  }
}

// ─── Public Sign Page ───
async function loadSignPage(token) {
  document.getElementById('app').innerHTML = `
    <div class="sign-page">
      <div class="sign-container">
        <div class="spinner spinner-dark"></div>
        <p style="text-align:center;margin-top:16px">Laddar signeringsforfragan...</p>
      </div>
    </div>
  `;
  try {
    const res = await fetch(API + '/sign/' + token);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ogiltigt signeringslank');

    if (data.status === 'signed') {
      document.getElementById('app').innerHTML = `
        <div class="sign-page">
          <div class="sign-container" style="text-align:center">
            <h2>Redan signerat</h2>
            <p style="color:var(--success);margin-top:12px">Detta protokoll har redan signerats.</p>
          </div>
        </div>
      `;
      return;
    }

    document.getElementById('app').innerHTML = `
      <div class="sign-page">
        <div class="sign-container">
          <h2>Signera protokoll</h2>
          <div class="sign-info">
            <p><strong>Mote:</strong> ${esc(data.meeting_title)}</p>
            <p><strong>Roll:</strong> ${esc(data.role)}</p>
            <p><strong>Namn:</strong> ${esc(data.name)}</p>
          </div>
          <p style="font-size:14px;margin-bottom:12px">Rita din signatur nedan:</p>
          <div class="sign-canvas-area">
            <canvas id="signatureCanvas" width="480" height="200"></canvas>
            <button class="btn btn-sm btn-ghost clear-btn" onclick="clearSignCanvas()">Rensa</button>
          </div>
          <button class="btn btn-primary btn-block btn-lg" id="submitSignBtn" onclick="submitSignature('${token}')">Signera</button>
          <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-light)">
            Genom att signera godkanner du innehallet i protokollet.
          </p>
        </div>
      </div>
    `;
    initSignCanvas();
  } catch (e) {
    document.getElementById('app').innerHTML = `
      <div class="sign-page">
        <div class="sign-container" style="text-align:center">
          <h2>Fel</h2>
          <p style="color:var(--danger);margin-top:12px">${esc(e.message)}</p>
        </div>
      </div>
    `;
  }
}

function initSignCanvas() {
  signCanvas = document.getElementById('signatureCanvas');
  signCtx = signCanvas.getContext('2d');
  signCtx.lineWidth = 2;
  signCtx.lineCap = 'round';
  signCtx.strokeStyle = '#1e293b';

  signCanvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    signCtx.beginPath();
    signCtx.moveTo(e.offsetX, e.offsetY);
  });
  signCanvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    signCtx.lineTo(e.offsetX, e.offsetY);
    signCtx.stroke();
  });
  signCanvas.addEventListener('mouseup', () => isDrawing = false);
  signCanvas.addEventListener('mouseleave', () => isDrawing = false);

  signCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    isDrawing = true;
    const r = signCanvas.getBoundingClientRect();
    const t = e.touches[0];
    signCtx.beginPath();
    signCtx.moveTo(t.clientX - r.left, t.clientY - r.top);
  });
  signCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!isDrawing) return;
    const r = signCanvas.getBoundingClientRect();
    const t = e.touches[0];
    signCtx.lineTo(t.clientX - r.left, t.clientY - r.top);
    signCtx.stroke();
  });
  signCanvas.addEventListener('touchend', () => isDrawing = false);
}

function clearSignCanvas() {
  if (signCtx) signCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
}

async function submitSignature(token) {
  if (!signCanvas) return;
  const blank = document.createElement('canvas');
  blank.width = signCanvas.width;
  blank.height = signCanvas.height;
  if (signCanvas.toDataURL() === blank.toDataURL()) {
    return toast('Rita din signatur forst', 'error');
  }

  const signature_data = signCanvas.toDataURL('image/png');
  const btn = document.getElementById('submitSignBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signerar...';

  try {
    const res = await fetch(API + '/sign/' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_data })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signering misslyckades');

    document.getElementById('app').innerHTML = `
      <div class="sign-page">
        <div class="sign-container" style="text-align:center">
          <h2 style="color:var(--success)">Signerat!</h2>
          <p style="margin-top:12px">Tack! Protokollet har signerats.</p>
        </div>
      </div>
    `;
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Signera';
  }
}
