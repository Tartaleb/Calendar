"use strict";

/* ------------------------------------------------------------------ *
 *  Mon Agenda — agenda Google jour par jour, sans heure
 * ------------------------------------------------------------------ */

const SCOPE = "https://www.googleapis.com/auth/calendar";
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

/* ------------------------------ État ------------------------------ */

const state = {
  clientId: localStorage.getItem("cal.clientId") || DEFAULT_CLIENT_ID,
  accessToken: null,
  tokenExpiry: 0,
  currentDate: new Date(),
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
  dateLabel: $("dateLabel"),
  datePicker: $("datePicker"),
  colorFilters: $("colorFilters"),
  eventList: $("eventList"),
  eventModal: $("eventModal"),
  eventModalTitle: $("eventModalTitle"),
  evTitle: $("evTitle"),
  evDate: $("evDate"),
  evColors: $("evColors"),
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

function frenchDate(d) {
  const s = d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  els.authBtn.textContent = "Se connecter avec Google";
  els.authBtn.onclick = signIn;
}

function onSignedIn() {
  localStorage.setItem("cal.auto", "1");
  els.welcome.hidden = true;
  els.app.hidden = false;
  els.addBtn.hidden = false;
  els.authBtn.disabled = false;
  els.authBtn.textContent = "Se déconnecter";
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
  const dayStart = new Date(state.currentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = addDays(dayStart, 1);
  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
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
    renderEvents();
  } catch (err) {
    els.eventList.innerHTML = `<p class="empty-state">Erreur de chargement.<br><small>${err.message}</small></p>`;
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

/* ------------------------------ Rendu ----------------------------- */

function render() {
  els.dateLabel.textContent = frenchDate(state.currentDate);
  els.datePicker.value = ymd(state.currentDate);
  renderColorFilters();
  renderEvents();
}

function renderColorFilters() {
  els.colorFilters.innerHTML = "";
  for (const id of COLOR_IDS) {
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
      renderColorFilters();
      renderEvents();
    };
    els.colorFilters.appendChild(chip);
  }
}

function renderEvents() {
  const visible = state.events.filter((e) =>
    state.activeColors.has(colorOf(e))
  );
  if (visible.length === 0) {
    const total = state.events.length;
    els.eventList.innerHTML = `<div class="empty-state">
      <div class="big">🗓️</div>
      ${
        total === 0
          ? "Aucun événement ce jour-là."
          : "Aucun événement pour les couleurs sélectionnées."
      }
    </div>`;
    return;
  }
  els.eventList.innerHTML = "";
  for (const ev of visible) {
    const card = document.createElement("div");
    card.className = "event-card";
    const color = COLORS[colorOf(ev)].hex;
    const bar = document.createElement("div");
    bar.className = "event-color";
    bar.style.background = color;
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = ev.summary || "(sans titre)";
    card.append(bar, title);
    card.onclick = () => openEventModal(ev);
    els.eventList.appendChild(card);
  }
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
    els.eventModalTitle.textContent = "Modifier l'événement";
    els.evTitle.value = ev.summary || "";
    els.evDate.value = ev.start.date || ymd(new Date(ev.start.dateTime));
    pickedColor = colorOf(ev);
    els.evDelete.hidden = false;
  } else {
    els.eventModalTitle.textContent = "Nouvel événement";
    els.evTitle.value = "";
    els.evDate.value = ymd(state.currentDate);
    pickedColor = "0";
    els.evDelete.hidden = true;
  }
  buildColorPicker();
  els.eventModal.hidden = false;
  els.evTitle.focus();
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

els.prevDay.onclick = () => goTo(addDays(state.currentDate, -1));
els.nextDay.onclick = () => goTo(addDays(state.currentDate, 1));
els.todayBtn.onclick = () => goTo(new Date());
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

/* ----------------------------- Démarrage -------------------------- */

els.authBtn.onclick = signIn;
render();
showSignedOutUI();
if (restoreToken()) onSignedIn();
else trySilentSignIn();
