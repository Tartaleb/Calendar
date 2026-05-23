"use strict";

/* ------------------------------------------------------------------ *
 *  Mon Agenda — agenda Google jour par jour, sans heure
 * ------------------------------------------------------------------ */

// Périmètre minimal : lecture/écriture des ÉVÉNEMENTS uniquement
// (pas la gestion des agendas, partages ou paramètres du compte).
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_ID = "primary";

// ID client OAuth web (public par conception : la sécurité vient des
// « Origines JavaScript autorisées » dans Google Cloud, pas du secret).
// Surchargeable via ⚙️ (stocké alors dans localStorage).
const DEFAULT_CLIENT_ID =
  "155543654881-mia8eo9t9ahko51ikph3eoqih9sio7ht.apps.googleusercontent.com";

// Palette officielle des couleurs d'événements Google Agenda (colorId 1..11).
// La clé "0" représente la couleur par défaut de l'agenda.
const COLORS = {
  "0":  { name: "Défaut",      hex: "#1a73e8" },
  "1":  { name: "Lavande",     hex: "#7986cb" },
  "2":  { name: "Sauge",       hex: "#33b679" },
  "3":  { name: "Raisin",      hex: "#8e24aa" },
  "4":  { name: "Flamant",     hex: "#e67c73" },
  "5":  { name: "Banane",      hex: "#f6bf26" },
  "6":  { name: "Mandarine",   hex: "#f4511e" },
  "7":  { name: "Paon",        hex: "#039be5" },
  "8":  { name: "Graphite",    hex: "#616161" },
  "9":  { name: "Myrtille",    hex: "#3f51b5" },
  "10": { name: "Basilic",     hex: "#0b8043" },
  "11": { name: "Tomate",      hex: "#d50000" },
};
const COLOR_IDS = Object.keys(COLORS);
const COLOR_ORDER = Object.fromEntries(COLOR_IDS.map((id, i) => [id, i]));

/* ------------------------------ État ------------------------------ */

const state = {
  clientId: localStorage.getItem("cal.clientId") || DEFAULT_CLIENT_ID,
  accessToken: null,
  tokenExpiry: 0,
  currentDate: new Date(),
  viewMode: localStorage.getItem("cal.view") === "week" ? "week" : "day",
  events: [],
  // Couleurs actuellement visibles (Set d'ids). Par défaut : toutes.
  activeColors: new Set(
    JSON.parse(localStorage.getItem("cal.activeColors") || "null") || COLOR_IDS
  ),
  editingEvent: null, // événement en cours d'édition (null = création)
};

let tokenClient = null;

/* --------------------------- Raccourcis DOM ----------------------- */

const $ = (id) => document.getElementById(id);
const els = {
  authBtn: $("authBtn"),
  configBtn: $("configBtn"),
  app: $("app"),
  welcome: $("welcome"),
  addBtn: $("addBtn"),
  prevDay: $("prevDay"),
  nextDay: $("nextDay"),
  todayBtn: $("todayBtn"),
  viewDay: $("viewDay"),
  viewWeek: $("viewWeek"),
  dateLabel: $("dateLabel"),
  datePicker: $("datePicker"),
  filters: $("filters"),
  colorFilters: $("colorFilters"),
  weather: $("weather"),
  wxIcon: $("wxIcon"),
  wxTemps: $("wxTemps"),
  wxAir: $("wxAir"),
  controls: document.querySelector(".controls"),
  eventList: $("eventList"),
  eventModal: $("eventModal"),
  eventModalTitle: $("eventModalTitle"),
  evTitle: $("evTitle"),
  evDate: $("evDate"),
  evColors: $("evColors"),
  colorField: $("colorField"),
  evDelete: $("evDelete"),
  evCancel: $("evCancel"),
  evSave: $("evSave"),
  configModal: $("configModal"),
  cfgClientId: $("cfgClientId"),
  cfgCancel: $("cfgCancel"),
  cfgSave: $("cfgSave"),
  toast: $("toast"),
};

/* ---------------------------- Utilitaires ------------------------- */

// Date locale -> "YYYY-MM-DD" (les événements « journée entière » sont
// des dates sans fuseau horaire).
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function frenchDate(d) {
  return capitalize(
    d.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    })
  );
}

// Lundi de la semaine contenant d (semaine lundi → dimanche).
function startOfWeek(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay(); // 0 = dimanche … 6 = samedi
  r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day));
  return r;
}

function frenchWeekLabel(a, b) {
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  if (sameMonth) {
    const m = a.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    return `${a.getDate()} – ${b.getDate()} ${m}`;
  }
  const fmt = { day: "numeric", month: "long", year: "numeric" };
  const left = sameYear
    ? a.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })
    : a.toLocaleDateString("fr-FR", fmt);
  return `${left} – ${b.toLocaleDateString("fr-FR", fmt)}`;
}

// Intervalle [start, end[ chargé selon le mode d'affichage.
function currentRange() {
  if (state.viewMode === "week") {
    const start = startOfWeek(state.currentDate);
    return { start, end: addDays(start, 7) };
  }
  const start = new Date(state.currentDate);
  start.setHours(0, 0, 0, 0);
  return { start, end: addDays(start, 1) };
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

/* --------------------- Authentification Google -------------------- */

function waitForGsi() {
  return new Promise((resolve) => {
    if (window.google && google.accounts) return resolve();
    const t = setInterval(() => {
      if (window.google && google.accounts) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
}

let autoAttempt = false;

// Le modèle « token » de GIS ne fournit pas de refresh token : le jeton
// vit ~1 h. On le garde en sessionStorage (effacé à la fermeture de
// l'onglet) pour survivre à un rafraîchissement sans appel réseau, et on
// retente une connexion silencieuse si besoin.
function persistToken() {
  try {
    sessionStorage.setItem(
      "cal.tok",
      JSON.stringify({ t: state.accessToken, e: state.tokenExpiry })
    );
  } catch (_) {}
}

function restoreToken() {
  try {
    const j = JSON.parse(sessionStorage.getItem("cal.tok") || "null");
    if (j && j.t && Date.now() < j.e) {
      state.accessToken = j.t;
      state.tokenExpiry = j.e;
      return true;
    }
  } catch (_) {}
  return false;
}

function setToken(resp) {
  state.accessToken = resp.access_token;
  state.tokenExpiry = Date.now() + (Number(resp.expires_in) - 60) * 1000;
  persistToken();
}

async function ensureTokenClient() {
  await waitForGsi();
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: SCOPE,
    callback: (resp) => {
      const silent = autoAttempt;
      autoAttempt = false;
      if (resp.error) {
        if (!silent) toast("Connexion refusée : " + resp.error);
        showSignedOutUI();
        return;
      }
      setToken(resp);
      onSignedIn();
    },
  });
}

async function signIn() {
  if (!state.clientId) {
    toast("Configure d'abord ton Client ID Google (⚙️).");
    openConfig();
    return;
  }
  await ensureTokenClient();
  tokenClient.requestAccessToken({ prompt: "" });
}

// Reconnexion silencieuse au chargement : aucun clic ni popup si la
// session Google est active et le consentement déjà accordé.
async function trySilentSignIn() {
  if (!state.clientId || localStorage.getItem("cal.auto") !== "1") return;
  autoAttempt = true;
  els.authBtn.disabled = true;
  els.authBtn.textContent = "Reconnexion…";
  await ensureTokenClient();
  tokenClient.requestAccessToken({ prompt: "" });
}

function signOut() {
  if (state.accessToken && window.google) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }
  state.accessToken = null;
  state.tokenExpiry = 0;
  localStorage.removeItem("cal.auto");
  try { sessionStorage.removeItem("cal.tok"); } catch (_) {}
  showSignedOutUI();
}

function showSignedOutUI() {
  els.app.hidden = true;
  els.addBtn.hidden = true;
  els.welcome.hidden = false;
  els.authBtn.disabled = false;
  els.authBtn.textContent = "Connexion Google";
  els.authBtn.onclick = signIn;
}

function onSignedIn() {
  localStorage.setItem("cal.auto", "1");
  els.welcome.hidden = true;
  els.app.hidden = false;
  els.addBtn.hidden = false;
  els.authBtn.disabled = false;
  els.authBtn.textContent = "Déconnexion";
  els.authBtn.onclick = signOut;
  render();
  loadEvents();
}

// Renouvelle silencieusement le jeton s'il est expiré.
async function freshToken() {
  if (state.accessToken && Date.now() < state.tokenExpiry) return;
  await ensureTokenClient();
  await new Promise((resolve, reject) => {
    const prev = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = prev;
      if (resp.error) return reject(new Error(resp.error));
      setToken(resp);
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

/* ---------------------- Appels API Google Agenda ------------------ */

async function api(path, opts = {}) {
  await freshToken();
  const res = await fetch(CAL_API + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + state.accessToken,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    state.tokenExpiry = 0;
    await freshToken();
    return api(path, opts);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status} : ${txt}`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadEvents() {
  const { start, end } = currentRange();
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  els.eventList.innerHTML = `<p class="empty-state">Chargement…</p>`;
  try {
    const data = await api(
      `/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`
    );
    state.events = (data.items || []).filter((e) => e.status !== "cancelled");
    refreshUI();
  } catch (err) {
    els.eventList.innerHTML =
      '<p class="empty-state">Erreur de chargement.<br><small></small></p>';
    els.eventList.querySelector("small").textContent = err.message;
  }
}

function colorOf(ev) {
  return ev.colorId && COLORS[ev.colorId] ? ev.colorId : "0";
}

async function saveEvent({ id, title, date, colorId }) {
  const body = {
    summary: title,
    start: { date },
    end: { date: ymd(addDays(parseYmd(date), 1)) },
  };
  if (colorId !== "0") body.colorId = colorId;
  const base = `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
  if (id) {
    await api(`${base}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(colorId === "0" ? { ...body, colorId: null } : body),
    });
  } else {
    await api(base, { method: "POST", body: JSON.stringify(body) });
  }
}

async function deleteEvent(id) {
  await api(
    `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

/* ------------------------------ Météo ---------------------------- */

// Coordonnées du 11 rue du 4e Zouave, 93110 Rosny-sous-Bois
// (géocodage officiel Base Adresse Nationale).
// Météo et qualité de l'air via Open-Meteo (sans clé API).
const WX_LAT = 48.873626;
const WX_LON = 2.481755;

// Codes WMO -> icône emoji.
const WX_ICONS = {
  0: "☀️",
  1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  56: "🌧️", 57: "🌧️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  66: "🌧️", 67: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "🌨️", 77: "🌨️",
  80: "🌦️", 81: "🌦️", 82: "🌧️",
  85: "🌨️", 86: "🌨️",
  95: "⛈️", 96: "⛈️", 99: "⛈️",
};

function aqiLabel(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v < 20) return { label: "Bon", cls: "good" };
  if (v < 40) return { label: "Correct", cls: "fair" };
  if (v < 60) return { label: "Moyen", cls: "moderate" };
  if (v < 80) return { label: "Mauvais", cls: "poor" };
  return { label: "Très mauvais", cls: "bad" };
}

const wxCache = {}; // clé: "YYYY-MM-DD"

async function fetchWeather(date) {
  if (wxCache[date]) return wxCache[date];
  const today = ymd(new Date());
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: WX_LAT,
    longitude: WX_LON,
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    timezone: "auto",
    start_date: date,
    end_date: date,
  }).toString();
  const res = await fetch(u);
  if (!res.ok) throw new Error("wx-http");
  const data = await res.json();
  const d = data.daily || {};
  if (!d.time || !d.time.length) throw new Error("wx-empty");
  const out = {
    code: d.weather_code[0],
    tmax: Math.round(d.temperature_2m_max[0]),
    tmin: Math.round(d.temperature_2m_min[0]),
  };
  if (date === today) {
    try {
      const au = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      au.search = new URLSearchParams({
        latitude: WX_LAT,
        longitude: WX_LON,
        current: "european_aqi",
        timezone: "auto",
      }).toString();
      const ar = await fetch(au);
      if (ar.ok) {
        const aj = await ar.json();
        const v = aj.current && aj.current.european_aqi;
        if (typeof v === "number") out.aqi = v;
      }
    } catch (_) {}
  }
  wxCache[date] = out;
  return out;
}

let wxRequest = 0;
async function refreshWeather() {
  if (state.viewMode !== "day") {
    els.weather.hidden = true;
    return;
  }
  const date = ymd(state.currentDate);
  // Plage couverte par l'API Open-Meteo : on cache si trop loin.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((state.currentDate - today) / 86400000);
  if (diffDays < -90 || diffDays > 14) {
    els.weather.hidden = true;
    return;
  }
  const reqId = ++wxRequest;
  els.weather.hidden = false;
  els.wxIcon.textContent = "·";
  els.wxTemps.textContent = "…";
  els.wxAir.hidden = true;
  try {
    const w = await fetchWeather(date);
    // Une navigation a pu intervenir entre-temps.
    if (reqId !== wxRequest) return;
    els.wxIcon.textContent = WX_ICONS[w.code] || "🌡️";
    els.wxTemps.textContent = `${w.tmax}° / ${w.tmin}°`;
    const a = aqiLabel(w.aqi);
    if (a) {
      els.wxAir.textContent = `Air : ${a.label}`;
      els.wxAir.className = "wx-air " + a.cls;
      els.wxAir.hidden = false;
    } else {
      els.wxAir.hidden = true;
    }
  } catch (_) {
    if (reqId !== wxRequest) return;
    els.weather.hidden = true;
  }
}

/* ------------------------------ Rendu ----------------------------- */

function render() {
  const week = state.viewMode === "week";
  els.viewDay.setAttribute("aria-pressed", String(!week));
  els.viewWeek.setAttribute("aria-pressed", String(week));
  els.prevDay.setAttribute("aria-label", week ? "Semaine précédente" : "Jour précédent");
  els.nextDay.setAttribute("aria-label", week ? "Semaine suivante" : "Jour suivant");
  if (week) {
    const mon = startOfWeek(state.currentDate);
    els.dateLabel.textContent = frenchWeekLabel(mon, addDays(mon, 6));
  } else {
    els.dateLabel.textContent = frenchDate(state.currentDate);
  }
  els.datePicker.value = ymd(state.currentDate);
  refreshUI();
  refreshWeather();
}

function refreshUI() {
  renderColorFilters();
  renderEvents();
}

// Filtres : uniquement les couleurs réellement présentes dans
// l'intervalle chargé (sur les événements bruts, avant filtrage, pour
// pouvoir réactiver une couleur qu'on vient de masquer).
function renderColorFilters() {
  const present = new Set(state.events.map(colorOf));
  els.filters.style.display = present.size ? "" : "none";
  els.colorFilters.innerHTML = "";
  for (const id of COLOR_IDS) {
    if (!present.has(id)) continue;
    const c = COLORS[id];
    const chip = document.createElement("button");
    chip.className = "color-chip";
    chip.style.background = c.hex;
    chip.title = c.name;
    chip.setAttribute("aria-pressed", state.activeColors.has(id));
    chip.onclick = () => {
      if (state.activeColors.has(id)) state.activeColors.delete(id);
      else state.activeColors.add(id);
      localStorage.setItem(
        "cal.activeColors",
        JSON.stringify([...state.activeColors])
      );
      refreshUI();
    };
    els.colorFilters.appendChild(chip);
  }
}

function eventCard(ev) {
  const card = document.createElement("div");
  card.className = "event-card";
  const bar = document.createElement("div");
  bar.className = "event-color";
  bar.style.background = COLORS[colorOf(ev)].hex;
  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = ev.summary || "(sans titre)";
  card.append(bar, title);
  card.onclick = () => openEventModal(ev);
  return card;
}

function emptyState(msg) {
  els.eventList.innerHTML = `<div class="empty-state"><div class="big">🗓️</div>${msg}</div>`;
}

function renderEvents() {
  const visible = state.events.filter((e) =>
    state.activeColors.has(colorOf(e))
  );
  if (visible.length === 0) {
    const filtered = state.events.length > 0;
    const week = state.viewMode === "week";
    return emptyState(
      filtered
        ? "Aucun événement pour les couleurs sélectionnées."
        : week
        ? "Aucun événement cette semaine."
        : "Aucun événement ce jour-là."
    );
  }
  // Classé par couleur ; à couleur égale, l'ordre par date est conservé
  // (tri stable, événements déjà triés par date depuis l'API).
  visible.sort((a, b) => COLOR_ORDER[colorOf(a)] - COLOR_ORDER[colorOf(b)]);
  els.eventList.innerHTML = "";
  for (const ev of visible) els.eventList.appendChild(eventCard(ev));
}

/* ------------------------- Modale événement ----------------------- */

let pickedColor = "0";

function buildColorPicker() {
  els.evColors.innerHTML = "";
  for (const id of COLOR_IDS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (id === pickedColor ? " selected" : "");
    sw.style.background = COLORS[id].hex;
    sw.title = COLORS[id].name;
    sw.onclick = () => {
      pickedColor = id;
      buildColorPicker();
    };
    els.evColors.appendChild(sw);
  }
}

function openEventModal(ev) {
  state.editingEvent = ev || null;
  if (ev) {
    // Événement existant : consultation + suppression uniquement.
    els.eventModalTitle.textContent = "Événement";
    els.evTitle.value = ev.summary || "";
    els.evDate.value = ev.start.date || ymd(new Date(ev.start.dateTime));
    els.evTitle.disabled = true;
    els.evDate.disabled = true;
    els.colorField.hidden = true;
    els.evSave.hidden = true;
    els.evDelete.hidden = false;
    els.eventModal.hidden = false;
  } else {
    // Nouvel événement : tous les champs éditables.
    els.eventModalTitle.textContent = "Nouvel événement";
    els.evTitle.value = "";
    els.evDate.value = ymd(state.currentDate);
    els.evTitle.disabled = false;
    els.evDate.disabled = false;
    pickedColor = "0";
    buildColorPicker();
    els.colorField.hidden = false;
    els.evSave.hidden = false;
    els.evDelete.hidden = true;
    els.eventModal.hidden = false;
    els.evTitle.focus();
  }
}

function closeEventModal() {
  els.eventModal.hidden = true;
  state.editingEvent = null;
}

els.evSave.onclick = async () => {
  const title = els.evTitle.value.trim();
  const date = els.evDate.value;
  if (!title) return toast("Donne un titre à l'événement.");
  if (!date) return toast("Choisis une date.");
  els.evSave.disabled = true;
  try {
    await saveEvent({
      id: state.editingEvent ? state.editingEvent.id : null,
      title,
      date,
      colorId: pickedColor,
    });
    closeEventModal();
    toast(state.editingEvent ? "Événement modifié." : "Événement ajouté.");
    state.currentDate = parseYmd(date);
    render();
    loadEvents();
  } catch (err) {
    toast("Échec : " + err.message);
  } finally {
    els.evSave.disabled = false;
  }
};

els.evDelete.onclick = async () => {
  if (!state.editingEvent) return;
  if (!confirm("Supprimer cet événement ?")) return;
  els.evDelete.disabled = true;
  try {
    await deleteEvent(state.editingEvent.id);
    closeEventModal();
    toast("Événement supprimé.");
    loadEvents();
  } catch (err) {
    toast("Échec : " + err.message);
  } finally {
    els.evDelete.disabled = false;
  }
};

els.evCancel.onclick = closeEventModal;
els.eventModal.onclick = (e) => {
  if (e.target === els.eventModal) closeEventModal();
};

/* ------------------------ Modale configuration -------------------- */

function openConfig() {
  els.cfgClientId.value = state.clientId;
  els.configModal.hidden = false;
  els.cfgClientId.focus();
}
function closeConfig() {
  els.configModal.hidden = true;
}
els.configBtn.onclick = openConfig;
els.cfgCancel.onclick = closeConfig;
els.configModal.onclick = (e) => {
  if (e.target === els.configModal) closeConfig();
};
els.cfgSave.onclick = () => {
  const id = els.cfgClientId.value.trim();
  state.clientId = id;
  localStorage.setItem("cal.clientId", id);
  tokenClient = null; // forcer la ré-initialisation avec le nouvel ID
  closeConfig();
  toast(id ? "Client ID enregistré. Connecte-toi !" : "Client ID effacé.");
};

/* --------------------------- Navigation --------------------------- */

function goTo(date) {
  state.currentDate = date;
  render();
  loadEvents();
}

const navStep = () => (state.viewMode === "week" ? 7 : 1);
els.prevDay.onclick = () => goTo(addDays(state.currentDate, -navStep()));
els.nextDay.onclick = () => goTo(addDays(state.currentDate, navStep()));
els.todayBtn.onclick = () => goTo(new Date());

function setView(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  localStorage.setItem("cal.view", mode);
  render();
  loadEvents();
}
els.viewDay.onclick = () => setView("day");
els.viewWeek.onclick = () => setView("week");
els.dateLabel.onclick = () => {
  if (typeof els.datePicker.showPicker === "function") {
    els.datePicker.showPicker();
  } else {
    els.datePicker.click();
  }
};
els.datePicker.onchange = () => {
  if (els.datePicker.value) goTo(parseYmd(els.datePicker.value));
};
els.addBtn.onclick = () => openEventModal(null);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!els.eventModal.hidden) closeEventModal();
    else if (!els.configModal.hidden) closeConfig();
  }
});

// Replie la météo dès que la page commence à défiler.
window.addEventListener(
  "scroll",
  () => {
    els.controls.classList.toggle("is-scrolled", window.scrollY > 6);
  },
  { passive: true }
);

/* ----------------------------- Démarrage -------------------------- */

els.authBtn.onclick = signIn;
render();
showSignedOutUI();
if (restoreToken()) onSignedIn();
else trySilentSignIn();
