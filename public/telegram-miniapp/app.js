const els = {
  subline: document.getElementById("subline"),
  statusBadge: document.getElementById("statusBadge"),
  runtime: document.getElementById("runtime"),
  answerView: document.getElementById("answerView"),
  screen: document.getElementById("screen"),
  systemGrid: document.getElementById("systemGrid"),
  events: document.getElementById("events"),
  inputForm: document.getElementById("inputForm"),
  promptInput: document.getElementById("promptInput"),
  sendBtn: document.getElementById("sendBtn"),
  escBtn: document.getElementById("escBtn"),
  startBtn: document.getElementById("startBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  restartBtn: document.getElementById("restartBtn"),
  replyControls: document.getElementById("replyControls"),
  replyPrompt: document.getElementById("replyPrompt"),
  replyReasonForm: document.getElementById("replyReasonForm"),
  replyReasonInput: document.getElementById("replyReasonInput"),
  replyReasonSendBtn: document.getElementById("replyReasonSendBtn"),
  replyReasonCancelBtn: document.getElementById("replyReasonCancelBtn"),
  replyActionButtons: Array.from(document.querySelectorAll("[data-reply-action]")),
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
};

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}

const query = new URLSearchParams(window.location.search);
const initDataFromQuery = query.get("initData") || "";
const initData = (tg && tg.initData) || initDataFromQuery;
if (initDataFromQuery) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("initData");
  window.history.replaceState({}, "", cleanUrl.toString());
}

let pollMs = 1200;
let lastDigest = "";
let inFlight = false;
let inputInFlight = false;
let inputMaxChars = 4000;
let restartEnabled = false;
let latestSnapshot = null;
let latestEvents = [];
let activeTab = "answer";
const AUTO_SCROLL_THRESHOLD_PX = 28;
const autoScrollFollow = {
  answer: true,
  raw: true,
  events: true,
};
const autoScrollLock = {
  answer: false,
  raw: false,
  events: false,
};

const answerRenderer =
  window.MiniAppRender && typeof window.MiniAppRender.renderAnswerHtml === "function"
    ? window.MiniAppRender
    : null;
if (els.restartBtn) {
  els.restartBtn.hidden = true;
  els.restartBtn.disabled = true;
}

function textOrDash(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function setSubline(text) {
  els.subline.textContent = text;
}

function isNearBottom(element, thresholdPx = AUTO_SCROLL_THRESHOLD_PX) {
  if (!element) return true;
  const distance = element.scrollHeight - (element.scrollTop + element.clientHeight);
  return distance <= thresholdPx;
}

function scrollElementToBottom(element) {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

function maybeAutoScrollPanel(key, force = false) {
  let element = null;
  if (key === "answer") element = els.answerView;
  if (key === "raw") element = els.screen;
  if (key === "events") element = els.events;
  if (!element) return;
  if (!force && !autoScrollFollow[key]) return;

  autoScrollLock[key] = true;
  scrollElementToBottom(element);
  window.requestAnimationFrame(() => {
    autoScrollLock[key] = false;
  });
}

function bindAutoScrollTracking(element, key) {
  if (!element) return;
  element.addEventListener("scroll", () => {
    if (autoScrollLock[key]) return;
    autoScrollFollow[key] = isNearBottom(element);
  });
}

function hexToRgb(hex) {
  const value = String(hex || "").trim();
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

function luminanceFromRgb(rgb) {
  if (!rgb) return null;
  const norm = [rgb.r, rgb.g, rgb.b].map((v) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
}

function applyTelegramTheme() {
  if (!tg || !tg.themeParams) return;
  const p = tg.themeParams;
  const root = document.documentElement;

  if (p.bg_color) root.style.setProperty("--bg", p.bg_color);
  if (p.secondary_bg_color) root.style.setProperty("--bg-soft", p.secondary_bg_color);
  if (p.section_bg_color) root.style.setProperty("--surface", p.section_bg_color);
  if (p.secondary_bg_color) root.style.setProperty("--surface-2", p.secondary_bg_color);
  if (p.text_color) root.style.setProperty("--text", p.text_color);
  if (p.hint_color) root.style.setProperty("--muted", p.hint_color);
  if (p.button_color) root.style.setProperty("--accent", p.button_color);
  if (p.accent_text_color) root.style.setProperty("--accent-contrast", p.accent_text_color);
  if (p.destructive_text_color) root.style.setProperty("--danger", p.destructive_text_color);

  const lum = luminanceFromRgb(hexToRgb(p.bg_color || ""));
  if (Number.isFinite(lum) && lum > 0.6) {
    root.style.setProperty("--input-bg", "rgba(255, 255, 255, 0.95)");
    root.style.setProperty("--input-stroke", "rgba(42, 63, 102, 0.35)");
    return;
  }
  root.style.setProperty("--input-bg", "rgba(255, 255, 255, 0.16)");
  root.style.setProperty("--input-stroke", "rgba(167, 196, 255, 0.7)");
}

function setBadge(state) {
  els.statusBadge.classList.remove("thinking", "done", "error");
  if (state === "thinking ...") {
    els.statusBadge.classList.add("thinking");
    els.statusBadge.textContent = "thinking ...";
    return;
  }
  if (state === "done") {
    els.statusBadge.classList.add("done");
    els.statusBadge.textContent = "done";
    return;
  }
  els.statusBadge.classList.add("error");
  els.statusBadge.textContent = state;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSystem(snapshot) {
  const rows = [
    ["mode", snapshot.mode],
    ["status", snapshot.status],
    ["runtime", snapshot.runtime],
    ["turn", snapshot.turn],
    ["input", snapshot.input],
    ["session", snapshot.session],
    ["cwd", snapshot.cwd],
    ["last_input", snapshot.lastInput],
    ["updated", snapshot.updatedAt],
  ];

  els.systemGrid.innerHTML = rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(textOrDash(value))}</dd>`)
    .join("");
}

function renderEvents(eventRows) {
  latestEvents = Array.isArray(eventRows) ? eventRows.slice(-40) : [];
  if (!latestEvents.length) {
    els.events.innerHTML = '<p class="events-empty">-</p>';
    return;
  }

  els.events.innerHTML = latestEvents
    .map(
      (line, idx) =>
        `<button type="button" class="event-item" data-event-idx="${idx}" title="In Prompt uebernehmen">${escapeHtml(line)}</button>`
    )
    .join("");
}

function renderAnswer(screen) {
  const rawText = textOrDash(screen);
  if (!answerRenderer) {
    els.answerView.textContent = rawText;
    return;
  }
  els.answerView.innerHTML = answerRenderer.renderAnswerHtml(rawText);
}

function setActiveTab(tabName) {
  activeTab = tabName;
  for (const button of els.tabButtons) {
    const isActive = button.dataset.tabTarget === tabName;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const panel of els.tabPanels) {
    const isActive = panel.dataset.tabPanel === tabName;
    panel.classList.toggle("is-active", isActive);
  }
  if (tabName === "answer") maybeAutoScrollPanel("answer", true);
  if (tabName === "raw") maybeAutoScrollPanel("raw", true);
  if (tabName === "events") maybeAutoScrollPanel("events", true);
}

function hideReplyReasonForm() {
  els.replyReasonForm.hidden = true;
  els.replyReasonInput.value = "";
}

function showReplyReasonForm() {
  els.replyReasonForm.hidden = false;
  els.replyReasonInput.focus();
}

function updateReplyControls(snapshot) {
  const needsReply = Boolean(snapshot && snapshot.needsReply);
  if (!needsReply) {
    els.replyControls.hidden = true;
    els.replyPrompt.textContent = "Rueckfrage erkannt.";
    hideReplyReasonForm();
    return;
  }

  const prompt = String(snapshot.replyPrompt || "").trim();
  els.replyPrompt.textContent = prompt ? `Rueckfrage: ${prompt}` : "Rueckfrage erkannt.";
  els.replyControls.hidden = false;
}

function renderSnapshot(snapshot) {
  const answerWasNearBottom = isNearBottom(els.answerView);
  const rawWasNearBottom = isNearBottom(els.screen);
  const eventsWasNearBottom = isNearBottom(els.events);

  latestSnapshot = snapshot;
  setBadge(snapshot.status || "error");
  els.runtime.textContent = textOrDash(snapshot.runtime);

  renderAnswer(snapshot.screen);
  els.screen.textContent = textOrDash(snapshot.screen);
  renderEvents(snapshot.events);
  renderSystem(snapshot);
  updateReplyControls(snapshot);

  if (answerWasNearBottom) autoScrollFollow.answer = true;
  if (rawWasNearBottom) autoScrollFollow.raw = true;
  if (eventsWasNearBottom) autoScrollFollow.events = true;

  maybeAutoScrollPanel("answer");
  maybeAutoScrollPanel("raw");
  maybeAutoScrollPanel("events");

  if (snapshot.active) {
    setSubline(
      `Aktiv: ${textOrDash(snapshot.command)} | Codex Status: ${textOrDash(snapshot.status)} | Turn ${textOrDash(snapshot.turn)} | Input ${textOrDash(snapshot.input)}`
    );
    return;
  }
  setSubline(`Idle | letzter Modus: ${textOrDash(snapshot.mode)}`);
}

function setInputDisabled(disabled) {
  inputInFlight = disabled;
  els.sendBtn.disabled = disabled;
  els.escBtn.disabled = disabled;
  els.startBtn.disabled = disabled;
  els.cancelBtn.disabled = disabled;
  if (els.restartBtn) {
    els.restartBtn.disabled = disabled || !restartEnabled;
  }
  els.promptInput.disabled = disabled;
  els.replyReasonInput.disabled = disabled;
  els.replyReasonSendBtn.disabled = disabled;
  els.replyReasonCancelBtn.disabled = disabled;
  for (const replyButton of els.replyActionButtons) {
    replyButton.disabled = disabled;
  }
}

async function postInput(text) {
  if (inputInFlight) return;
  const payloadText = String(text || "");
  if (!payloadText.length) return;
  if (payloadText.length > inputMaxChars) {
    setSubline(`Input zu lang (max ${inputMaxChars} Zeichen).`);
    return;
  }

  setInputDisabled(true);
  try {
    const headers = { "Content-Type": "application/json" };
    if (initData) {
      headers["X-Telegram-Init-Data"] = initData;
    }

    const url = new URL("/api/miniapp/input", window.location.origin);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ text: payloadText }),
      cache: "no-store",
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      const reason = body.error || `HTTP ${response.status}`;
      setSubline(`Input fehlgeschlagen: ${reason}`);
      return;
    }

    if (body.snapshot) {
      renderSnapshot(body.snapshot);
    }

    if (payloadText !== "/stopcodex" && payloadText !== "/cancel" && payloadText !== "/startcodex") {
      els.promptInput.value = "";
    }
  } catch (_err) {
    setSubline("Input fehlgeschlagen: Verbindung unterbrochen.");
  } finally {
    setInputDisabled(false);
  }
}

async function pollOnce() {
  if (inFlight) return;
  inFlight = true;

  try {
    const headers = {};
    if (initData) {
      headers["X-Telegram-Init-Data"] = initData;
    }

    const url = new URL("/api/miniapp/live", window.location.origin);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const reason = body.error || `HTTP ${response.status}`;
      setBadge("auth/error");
      setSubline(`Panel nicht verfuegbar: ${reason}`);
      return;
    }

    const payload = await response.json();
    if (payload && payload.config && Number.isFinite(payload.config.refreshMs)) {
      pollMs = Math.max(700, Math.min(5000, payload.config.refreshMs));
    }
    if (payload && payload.config && Number.isFinite(payload.config.inputMaxChars)) {
      inputMaxChars = Math.max(100, Math.min(20000, payload.config.inputMaxChars));
      els.promptInput.maxLength = inputMaxChars;
    }
    if (payload && payload.config && typeof payload.config.restartEnabled === "boolean") {
      restartEnabled = payload.config.restartEnabled;
      if (els.restartBtn) {
        els.restartBtn.hidden = !restartEnabled;
        els.restartBtn.disabled = !restartEnabled || inputInFlight;
      }
    }

    const snapshot = payload && payload.snapshot ? payload.snapshot : null;
    if (!snapshot) return;

    const digest = JSON.stringify([
      snapshot.mode,
      snapshot.status,
      snapshot.rev,
      snapshot.needsReply,
      snapshot.replyPrompt,
      snapshot.updatedAt,
    ]);
    if (digest !== lastDigest) {
      lastDigest = digest;
      renderSnapshot(snapshot);
    }
  } catch (_err) {
    setBadge("disconnected");
    setSubline("Verbindung unterbrochen. Reconnect laeuft...");
  } finally {
    inFlight = false;
    window.setTimeout(pollOnce, pollMs);
  }
}

if (!initData) {
  setBadge("auth/error");
  setSubline("Bitte ueber Telegram oeffnen (initData fehlt).");
} else {
  applyTelegramTheme();
  if (tg && typeof tg.onEvent === "function") {
    tg.onEvent("themeChanged", applyTelegramTheme);
  }
  pollOnce();
}

bindAutoScrollTracking(els.answerView, "answer");
bindAutoScrollTracking(els.screen, "raw");
bindAutoScrollTracking(els.events, "events");

for (const button of els.tabButtons) {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tabTarget || "system");
  });
}
setActiveTab(activeTab);

els.events.addEventListener("click", (event) => {
  const target = event.target.closest("[data-event-idx]");
  if (!target) return;
  const index = Number(target.dataset.eventIdx);
  if (!Number.isFinite(index)) return;
  const line = latestEvents[index];
  if (!line) return;

  if (els.promptInput.value.trim()) {
    els.promptInput.value = `${els.promptInput.value.trim()}\n${line}`;
  } else {
    els.promptInput.value = line;
  }
  els.promptInput.focus();
  setSubline("Event in Prompt uebernommen.");
});

els.inputForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await postInput(els.promptInput.value);
});

els.promptInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  event.preventDefault();
  await postInput(els.promptInput.value);
});

els.startBtn.addEventListener("click", async () => {
  await postInput("/startcodex");
});

els.escBtn.addEventListener("click", async () => {
  hideReplyReasonForm();
  await postInput("/stopcodex");
});

els.cancelBtn.addEventListener("click", async () => {
  await postInput("/stopcodex");
});

if (els.restartBtn) {
  els.restartBtn.addEventListener("click", async () => {
    await postInput("/restartbot");
  });
}

for (const button of els.replyActionButtons) {
  button.addEventListener("click", async () => {
    const action = button.dataset.replyAction;
    if (action === "no_but") {
      showReplyReasonForm();
      setSubline('Reason required for "no but...".');
      return;
    }

    const map = {
      yes: "yes",
      yes_always: "yes always",
    };
    const payload = map[action];
    if (!payload) return;
    hideReplyReasonForm();
    await postInput(payload);
  });
}

els.replyReasonForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = String(els.replyReasonInput.value || "").trim();
  if (!reason) {
    setSubline('Please provide a reason before sending "no but...".');
    els.replyReasonInput.focus();
    return;
  }
  hideReplyReasonForm();
  await postInput(`no but: ${reason}`);
});

els.replyReasonCancelBtn.addEventListener("click", () => {
  hideReplyReasonForm();
  setSubline("Reason input cancelled.");
});
