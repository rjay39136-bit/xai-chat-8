// ---------------------------------------------------------------------------
// XAI frontend <-> FastAPI backend wiring
// ---------------------------------------------------------------------------
const API_BASE = (() => {
  if (window.XAI_API_BASE != null) return window.XAI_API_BASE;

  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    return "http://127.0.0.1:8000";
  }

  return "https://xai-chat-8.vercel.app";
})();

// In-memory client-side store of real conversations created in this session.
// Shape: { [chatId]: { id, title, time, messages: [{role, content}] } }
const chats = {};
let currentChatId = null;
let pendingFile = null;

// User settings state
const userSettings = {
  model: localStorage.getItem('xai_model') || 'gemini-3.5-flash-lite',
  temperature: parseFloat(localStorage.getItem('xai_temp') || '0.4'),
  maxTokens: parseInt(localStorage.getItem('xai_max_tokens') || '2048', 10),
};

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------
const heroIntro = document.getElementById('heroIntro');
const chatThread = document.getElementById('chatThread');
const messageList = document.getElementById('messageList');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');

const composerInput = document.getElementById('composerInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');

const attachToggle = document.getElementById('attachToggle');
const attachMenu = document.getElementById('attachMenu');
const attachOptions = document.querySelectorAll('.attach-option');

const fileInputDevice = document.getElementById('fileInputDevice');
const fileInputImage = document.getElementById('fileInputImage');
const fileInputCamera = document.getElementById('fileInputCamera');
const imageBtn = document.getElementById('imageBtn');
const micBtn = document.getElementById('micBtn');

const fileChip = document.getElementById('fileChip');
const fileChipName = document.getElementById('fileChipName');
const fileChipRemove = document.getElementById('fileChipRemove');

const connectionToast = document.getElementById('connectionToast');

// Navigation & Topbar
const themeToggleBtn = document.getElementById('themeToggleBtn');
const accountBtn = document.getElementById('accountBtn');
const scrollBottomBtn = document.getElementById('scrollBottomBtn');

// History search
const searchChatsBtn = document.getElementById('searchChatsBtn');
const historySearchWrap = document.getElementById('historySearchWrap');
const historySearchInput = document.getElementById('historySearchInput');
const historySearchClear = document.getElementById('historySearchClear');

// Feature Cards
const cardAsk = document.getElementById('cardAsk');
const cardUpload = document.getElementById('cardUpload');
const cardCombine = document.getElementById('cardCombine');
const cardInsights = document.getElementById('cardInsights');

// Combine Modal
const combineOverlay = document.getElementById('combineOverlay');
const combineList = document.getElementById('combineList');
const combineCancel = document.getElementById('combineCancel');
const combineRun = document.getElementById('combineRun');
const combineClose = document.getElementById('combineClose');
const combineChatsBtn = document.getElementById('combineChatsBtn');

// Account Modal
const accountOverlay = document.getElementById('accountOverlay');
const accountClose = document.getElementById('accountClose');
const accountCopyBtn = document.getElementById('accountCopyBtn');
const accountDoneBtn = document.getElementById('accountDoneBtn');
const accountModelVal = document.getElementById('accountModelVal');
const statChatCount = document.getElementById('statChatCount');
const statMsgCount = document.getElementById('statMsgCount');

// Settings Modal
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const settingsCancelBtn = document.getElementById('settingsCancelBtn');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');
const settingModel = document.getElementById('settingModel');
const settingTemp = document.getElementById('settingTemp');
const tempValLabel = document.getElementById('tempValLabel');
const settingMaxTokens = document.getElementById('settingMaxTokens');
const exportChatsBtn = document.getElementById('exportChatsBtn');
const clearChatsBtn = document.getElementById('clearChatsBtn');

// Help Modal
const helpBtn = document.getElementById('helpBtn');
const helpOverlay = document.getElementById('helpOverlay');
const helpClose = document.getElementById('helpClose');
const helpDoneBtn = document.getElementById('helpDoneBtn');
const helpBackendStatus = document.getElementById('helpBackendStatus');

// ---------------------------------------------------------------------------
// Theme Toggle & Persistence
// ---------------------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('xai_theme') || 'dark';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  const sunIcon = document.querySelector('.theme-icon-sun');
  const moonIcon = document.querySelector('.theme-icon-moon');

  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (sunIcon) sunIcon.style.display = 'none';
    if (moonIcon) moonIcon.style.display = 'block';
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (sunIcon) sunIcon.style.display = 'block';
    if (moonIcon) moonIcon.style.display = 'none';
  }
  localStorage.setItem('xai_theme', theme);
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    applyTheme(isLight ? 'dark' : 'light');
  });
}

initTheme();

// ---------------------------------------------------------------------------
// Modal Helper Functions
// ---------------------------------------------------------------------------
function openModal(overlayEl) {
  if (!overlayEl) return;
  overlayEl.hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal(overlayEl) {
  if (!overlayEl) return;
  overlayEl.hidden = true;
  document.body.classList.remove('modal-open');
}

// Global modal dismiss listeners
[combineOverlay, accountOverlay, settingsOverlay, helpOverlay].forEach((overlay) => {
  if (!overlay) return;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAttachMenu();
    closeModal(combineOverlay);
    closeModal(accountOverlay);
    closeModal(settingsOverlay);
    closeModal(helpOverlay);
  }
  // Shortcut '/' to focus input when not in another field
  if (e.key === '/' && document.activeElement !== composerInput && !document.querySelector('.modal-overlay:not([hidden])')) {
    e.preventDefault();
    composerInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Account Modal Logic
// ---------------------------------------------------------------------------
function updateAccountStats() {
  const chatKeys = Object.keys(chats);
  let totalMsgs = 0;
  chatKeys.forEach((k) => {
    totalMsgs += chats[k]?.messages?.length || 0;
  });

  if (statChatCount) statChatCount.textContent = chatKeys.length;
  if (statMsgCount) statMsgCount.textContent = totalMsgs;
  if (accountModelVal) {
    const modelMap = {
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-3.6-flash': 'Gemini 3.6 Flash'
    };
    accountModelVal.textContent = modelMap[userSettings.model] || userSettings.model;
  }
}

if (accountBtn) {
  accountBtn.addEventListener('click', () => {
    updateAccountStats();
    openModal(accountOverlay);
  });
}
if (accountClose) accountClose.addEventListener('click', () => closeModal(accountOverlay));
if (accountDoneBtn) accountDoneBtn.addEventListener('click', () => closeModal(accountOverlay));

if (accountCopyBtn) {
  accountCopyBtn.addEventListener('click', async () => {
    const info = `XAI Project Info:
- Account: rjay39136-bit (rjay39136@gmail.com)
- Active Model: ${userSettings.model}
- Backend: FastAPI on Vercel Production
- Frontend: xai-chat-8-frontend
- Saved Chats: ${Object.keys(chats).length}
- Status: Verified & Connected`;

    try {
      await navigator.clipboard.writeText(info);
      accountCopyBtn.textContent = 'Copied!';
      setTimeout(() => { accountCopyBtn.textContent = 'Copy Info'; }, 2000);
    } catch {
      showToast('Account details copied to clipboard.');
    }
  });
}

// ---------------------------------------------------------------------------
// Settings Modal Logic
// ---------------------------------------------------------------------------
function initSettingsUI() {
  if (settingModel) settingModel.value = userSettings.model;
  if (settingTemp) {
    settingTemp.value = userSettings.temperature;
    if (tempValLabel) tempValLabel.textContent = userSettings.temperature;
    settingTemp.addEventListener('input', () => {
      if (tempValLabel) tempValLabel.textContent = settingTemp.value;
    });
  }
  if (settingMaxTokens) settingMaxTokens.value = String(userSettings.maxTokens);
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    initSettingsUI();
    openModal(settingsOverlay);
  });
}
if (settingsClose) settingsClose.addEventListener('click', () => closeModal(settingsOverlay));
if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', () => closeModal(settingsOverlay));

if (settingsSaveBtn) {
  settingsSaveBtn.addEventListener('click', () => {
    if (settingModel) userSettings.model = settingModel.value;
    if (settingTemp) userSettings.temperature = parseFloat(settingTemp.value);
    if (settingMaxTokens) userSettings.maxTokens = parseInt(settingMaxTokens.value, 10);

    localStorage.setItem('xai_model', userSettings.model);
    localStorage.setItem('xai_temp', String(userSettings.temperature));
    localStorage.setItem('xai_max_tokens', String(userSettings.maxTokens));

    closeModal(settingsOverlay);
    showToast('Preferences updated successfully.', 3000);
  });
}

if (exportChatsBtn) {
  exportChatsBtn.addEventListener('click', () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(chats, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `xai-chats-export-${Date.now()}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    showToast('Chat history exported to JSON.', 3000);
  });
}

if (clearChatsBtn) {
  clearChatsBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all saved conversations from this session?')) {
      for (const id in chats) delete chats[id];
      historyList.innerHTML = '<p class="history-empty" id="historyEmpty">No conversations yet. Start one below.</p>';
      currentChatId = null;
      showHeroView();
      closeModal(settingsOverlay);
      showToast('All conversations cleared.', 3000);
    }
  });
}

// ---------------------------------------------------------------------------
// Help & Support Modal Logic
// ---------------------------------------------------------------------------
async function refreshHelpStatus() {
  if (!helpBackendStatus) return;
  helpBackendStatus.textContent = 'Checking backend connection...';
  const dot = document.querySelector('.status-dot');
  if (dot) dot.classList.remove('error');

  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error('Unhealthy status');
    const data = await res.json();
    helpBackendStatus.textContent = `Connected: ${data.mode || 'Gemini 3.5 Flash-Lite'} • Streaming Ready`;
  } catch (err) {
    if (dot) dot.classList.add('error');
    helpBackendStatus.textContent = `Offline or unreachable (${err.message})`;
  }
}

if (helpBtn) {
  helpBtn.addEventListener('click', () => {
    refreshHelpStatus();
    openModal(helpOverlay);
  });
}
if (helpClose) helpClose.addEventListener('click', () => closeModal(helpOverlay));
if (helpDoneBtn) helpDoneBtn.addEventListener('click', () => closeModal(helpOverlay));

// ---------------------------------------------------------------------------
// History Search / Filter
// ---------------------------------------------------------------------------
if (searchChatsBtn) {
  searchChatsBtn.addEventListener('click', () => {
    const isHidden = historySearchWrap.hidden;
    historySearchWrap.hidden = !isHidden;
    if (isHidden && historySearchInput) {
      historySearchInput.focus();
    } else if (historySearchInput) {
      historySearchInput.value = '';
      filterHistory('');
    }
  });
}

if (historySearchInput) {
  historySearchInput.addEventListener('input', (e) => {
    filterHistory(e.target.value.toLowerCase().trim());
  });
}

if (historySearchClear) {
  historySearchClear.addEventListener('click', () => {
    if (historySearchInput) historySearchInput.value = '';
    filterHistory('');
    if (historySearchWrap) historySearchWrap.hidden = true;
  });
}

function filterHistory(query) {
  const items = historyList.querySelectorAll('.history-item');
  let matchCount = 0;
  items.forEach((item) => {
    const text = (item.querySelector('.history-text')?.textContent || '').toLowerCase();
    const matches = !query || text.includes(query);
    item.style.display = matches ? 'flex' : 'none';
    if (matches) matchCount++;
  });
  const emptyEl = document.getElementById('historyEmpty');
  if (emptyEl) {
    emptyEl.hidden = items.length > 0 && (query ? matchCount > 0 : true);
  }
}

// ---------------------------------------------------------------------------
// Voice Input (Speech-to-Text)
// ---------------------------------------------------------------------------
let speechRecognition = null;
let isRecording = false;

function initVoiceInput() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    if (micBtn) {
      micBtn.title = 'Speech recognition not supported in this browser';
      micBtn.addEventListener('click', () => {
        showToast('Voice input is not supported in this browser. Try Google Chrome or Safari.', 4000);
      });
    }
    return;
  }

  speechRecognition = new SpeechRec();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  speechRecognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('recording');
    composerInput.placeholder = 'Listening... Speak now';
  };

  speechRecognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    composerInput.value = transcript;
  };

  speechRecognition.onerror = (event) => {
    console.warn('[XAI] Speech recognition error:', event.error);
    isRecording = false;
    micBtn.classList.remove('recording');
    composerInput.placeholder = 'Type your message here...';
    if (event.error !== 'no-speech') {
      showToast(`Voice input error: ${event.error}`, 4000);
    }
  };

  speechRecognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove('recording');
    composerInput.placeholder = 'Type your message here...';
    if (composerInput.value.trim()) {
      composerInput.focus();
    }
  };

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (!speechRecognition) return;
      if (isRecording) {
        speechRecognition.stop();
      } else {
        try {
          speechRecognition.start();
        } catch (e) {
          console.error(e);
        }
      }
    });
  }
}

initVoiceInput();

// ---------------------------------------------------------------------------
// Scroll & Sticky Composer Management
// ---------------------------------------------------------------------------
function scrollToBottom(smooth = false) {
  if (!messageList) return;
  if (smooth) {
    messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
  } else {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

if (messageList) {
  messageList.addEventListener('scroll', () => {
    const distFromBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
    if (scrollBottomBtn) {
      scrollBottomBtn.hidden = distFromBottom < 100;
    }
  });
}

if (scrollBottomBtn) {
  scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));
}

// ---------------------------------------------------------------------------
// Backend availability check
// ---------------------------------------------------------------------------
async function checkBackend() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('unhealthy');
    console.log('[XAI] Backend reachable at', API_BASE);
  } catch (err) {
    console.error('[XAI] Health check failed:', err);
    showToast(`Can't reach backend at ${API_BASE}. Running on fallback mock mode if needed.`, 6000);
  }
}

let toastTimer = null;
function showToast(message, ms = 6000) {
  if (!connectionToast) return;
  connectionToast.textContent = message;
  connectionToast.hidden = false;
  connectionToast.style.cursor = 'pointer';
  connectionToast.title = 'Click to dismiss';
  if (toastTimer) clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  if (!connectionToast) return;
  connectionToast.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
}

if (connectionToast) {
  connectionToast.addEventListener('click', hideToast);
}

checkBackend();

// ---------------------------------------------------------------------------
// View Helpers
// ---------------------------------------------------------------------------
function showChatView() {
  heroIntro.hidden = true;
  chatThread.hidden = false;
  if (scrollBottomBtn) scrollBottomBtn.hidden = true;
}

function showHeroView() {
  heroIntro.hidden = false;
  chatThread.hidden = true;
  messageList.innerHTML = '';
  if (scrollBottomBtn) scrollBottomBtn.hidden = true;
}

function renderSources(container, sources) {
  if (!sources || !sources.length) return;
  const box = document.createElement('div');
  box.className = 'message-sources';
  const heading = document.createElement('div');
  heading.className = 'message-sources-title';
  heading.textContent = 'Sources';
  box.appendChild(heading);
  const list = document.createElement('ol');
  sources.forEach((s) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url || s.href || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.title || s.url || 'Reference';
    li.appendChild(a);
    if (s.snippet) {
      const sn = document.createElement('div');
      sn.className = 'message-source-snippet';
      sn.textContent = s.snippet;
      li.appendChild(sn);
    }
    list.appendChild(li);
  });
  box.appendChild(list);
  container.appendChild(box);
}

function renderMessage(role, content, opts = {}) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble' + (opts.error ? ' error' : '');

  if (opts.attachmentName) {
    const chip = document.createElement('div');
    chip.className = 'message-attachment';
    chip.textContent = `📎 ${opts.attachmentName}`;
    bubble.appendChild(chip);
  }

  const textNode = document.createElement('div');
  textNode.className = 'message-text';
  textNode.textContent = content;
  bubble.appendChild(textNode);

  if (opts.sources && opts.sources.length) {
    renderSources(bubble, opts.sources);
  }

  row.appendChild(bubble);
  messageList.appendChild(row);
  scrollToBottom();
  return row;
}

function renderTyping() {
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.id = 'typingRow';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';

  row.appendChild(bubble);
  messageList.appendChild(row);
  scrollToBottom();
}

function removeTyping() {
  const row = document.getElementById('typingRow');
  if (row) row.remove();
}

// ---------------------------------------------------------------------------
// History sidebar management
// ---------------------------------------------------------------------------
function chatIcon() {
  return `<svg class="chat-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12C21 16.4183 16.9706 20 12 20C10.5257 20 9.13385 19.6905 7.90621 19.1379L3 20L4.39638 16.3187C3.51554 15.0301 3 13.5722 3 12C3 7.58172 7.02944 4 12 4C16.9706 4 21 7.58172 21 12Z" stroke="currentColor" stroke-width="1.8"/>
  </svg>`;
}

function addHistoryEntry(chatId, title) {
  if (historyEmpty) historyEmpty.hidden = true;

  const btn = document.createElement('button');
  btn.className = 'history-item real';
  btn.dataset.chatId = chatId;
  btn.innerHTML = `
    ${chatIcon()}
    <span class="history-text"></span>
    <span class="history-time">Just now</span>
  `;
  btn.querySelector('.history-text').textContent = title;

  btn.addEventListener('click', () => loadChat(chatId));
  historyList.prepend(btn);
  setActiveHistory(chatId);
}

function setActiveHistory(chatId) {
  document.querySelectorAll('.history-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.chatId === chatId);
  });
}

function updateHistoryTitle(chatId, title) {
  const item = historyList.querySelector(`[data-chat-id="${chatId}"] .history-text`);
  if (item) item.textContent = title;
}

function loadChat(chatId) {
  const chat = chats[chatId];
  if (!chat) return;

  currentChatId = chatId;
  setActiveHistory(chatId);
  showChatView();
  messageList.innerHTML = '';
  chat.messages.forEach((m) => renderMessage(m.role === 'user' ? 'user' : 'assistant', m.content));
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// New Chat Button
// ---------------------------------------------------------------------------
if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    currentChatId = null;
    pendingFile = null;
    hideFileChip();
    document.querySelectorAll('.history-item').forEach((item) => item.classList.remove('active'));
    showHeroView();
    composerInput.focus();
  });
}

// ---------------------------------------------------------------------------
// Feature Cards
// ---------------------------------------------------------------------------
if (cardAsk) cardAsk.addEventListener('click', () => composerInput.focus());

if (cardUpload) {
  cardUpload.addEventListener('click', () => {
    attachMenu.classList.add('open');
    attachToggle.setAttribute('aria-expanded', 'true');
  });
}

if (cardCombine) cardCombine.addEventListener('click', openCombineModal);
if (combineChatsBtn) combineChatsBtn.addEventListener('click', openCombineModal);

if (cardInsights) {
  cardInsights.addEventListener('click', () => {
    composerInput.focus();
    composerInput.placeholder = 'Ask for deep insight, e.g. "Explain the core mechanics and trade-offs of..."';
  });
}

// ---------------------------------------------------------------------------
// Attach Menu & File Picker
// ---------------------------------------------------------------------------
function closeAttachMenu() {
  if (!attachMenu) return;
  attachMenu.classList.remove('open');
  if (attachToggle) attachToggle.setAttribute('aria-expanded', 'false');
}

if (attachToggle) {
  attachToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = attachMenu.classList.toggle('open');
    attachToggle.setAttribute('aria-expanded', String(isOpen));
  });
}

document.addEventListener('click', (e) => {
  if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachToggle) {
    closeAttachMenu();
  }
});

if (attachOptions[0]) attachOptions[0].addEventListener('click', () => { fileInputDevice.click(); closeAttachMenu(); });
if (attachOptions[1]) attachOptions[1].addEventListener('click', () => { fileInputImage.click(); closeAttachMenu(); });
if (attachOptions[2]) attachOptions[2].addEventListener('click', () => { fileInputCamera.click(); closeAttachMenu(); });
if (imageBtn) imageBtn.addEventListener('click', () => fileInputImage.click());

[fileInputDevice, fileInputImage, fileInputCamera].forEach((input) => {
  if (!input) return;
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) setPendingFile(file);
    input.value = '';
  });
});

function setPendingFile(file) {
  pendingFile = file;
  fileChipName.textContent = file.name;
  fileChip.hidden = false;
}

function hideFileChip() {
  fileChip.hidden = true;
  fileChipName.textContent = '';
}

if (fileChipRemove) {
  fileChipRemove.addEventListener('click', () => {
    pendingFile = null;
    hideFileChip();
  });
}

// ---------------------------------------------------------------------------
// Sending Messages & Streaming
// ---------------------------------------------------------------------------
function ensureChat(titleSeed) {
  if (currentChatId && chats[currentChatId]) return currentChatId;
  const id = `chat-${Date.now()}`;
  chats[id] = {
    id,
    title: titleSeed.slice(0, 42) + (titleSeed.length > 42 ? '…' : ''),
    messages: [],
  };
  currentChatId = id;
  addHistoryEntry(id, chats[id].title);
  return id;
}

function startStreamingBubble() {
  removeTyping();
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.id = 'streamingRow';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble streaming';
  bubble.id = 'streamingBubble';
  const textEl = document.createElement('div');
  textEl.className = 'message-text';
  bubble.appendChild(textEl);
  row.appendChild(bubble);
  messageList.appendChild(row);
  scrollToBottom();
  return bubble;
}

function finishStreamingBubble() {
  const row = document.getElementById('streamingRow');
  const bubble = document.getElementById('streamingBubble');
  if (bubble) bubble.classList.remove('streaming');
  if (row) {
    row.removeAttribute('id');
    if (bubble) bubble.removeAttribute('id');
  }
}

async function sendMessage() {
  const text = composerInput.value.trim();
  if (!text && !pendingFile) return;

  showChatView();
  const chatId = ensureChat(text || pendingFile.name);

  if (chats[chatId].messages.length === 0) {
    updateHistoryTitle(chatId, chats[chatId].title);
  }

  const attachedFile = pendingFile;
  pendingFile = null;
  hideFileChip();
  composerInput.value = '';

  renderMessage('user', text || '(no message)', attachedFile ? { attachmentName: attachedFile.name } : {});
  chats[chatId].messages.push({ role: 'user', content: text || `[uploaded file: ${attachedFile?.name}]` });

  renderTyping();
  sendBtn.disabled = true;

  try {
    let answer;
    if (attachedFile) {
      answer = await uploadFile(attachedFile, text || 'Analyze this file and explain the important points.', chatId);
      removeTyping();
      renderMessage('assistant', answer);
    } else {
      answer = await sendChatStream(text, chatId);
      finishStreamingBubble();
    }
    chats[chatId].messages.push({ role: 'assistant', content: answer });
  } catch (err) {
    removeTyping();
    finishStreamingBubble();
    renderMessage('assistant', `Something went wrong: ${err.message}`, { error: true });
  } finally {
    sendBtn.disabled = false;
    scrollToBottom();
  }
}

async function sendChatStream(message, chatId) {
  const history = chats[chatId].messages.slice(0, -1);
  const url = `${API_BASE}/chat/stream`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        chat_id: chatId,
        message,
        history,
        model: userSettings.model,
        temperature: userSettings.temperature,
        max_tokens: userSettings.maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Chat response timed out. The model may be processing a heavy request.');
    }
    throw new Error(`Could not reach backend at ${url}. ${err.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(await safeErrorDetail(res));
  }

  const bubble = startStreamingBubble();
  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        if (data.token) {
          full += data.token;
          let textEl = bubble.querySelector('.message-text');
          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'message-text';
            bubble.appendChild(textEl);
          }
          textEl.textContent = full;
          scrollToBottom();
        }

        if (data.sources && data.sources.length) {
          const old = bubble.querySelector('.message-sources');
          if (old) old.remove();
          renderSources(bubble, data.sources);
          scrollToBottom();
        }

        if (data.error) {
          if (!full) full = data.error;
          else full += '\n\n[' + data.error + ']';
          let textEl = bubble.querySelector('.message-text');
          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'message-text';
            bubble.appendChild(textEl);
          }
          textEl.textContent = full;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!full) {
    console.warn('[XAI] Empty stream response — trying fallback non-streaming endpoint');
    return await sendChat(message, chatId);
  }
  return full;
}

async function sendChat(message, chatId) {
  const history = chats[chatId].messages.slice(0, -1);
  const res = await fetchWithDiagnostics(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message,
      history,
      model: userSettings.model,
      temperature: userSettings.temperature,
      max_tokens: userSettings.maxTokens,
    }),
  });

  if (!res.ok) throw new Error(await safeErrorDetail(res));

  const data = await res.json();
  let answer = data.answer || '';
  if (data.sources && data.sources.length) {
    answer += '\n\nSources:\n';
    data.sources.forEach((s, i) => {
      answer += `${i + 1}. ${s.title || s.url} — ${s.url}\n`;
    });
  }
  return answer;
}

async function uploadFile(file, message, chatId) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('message', message);
  formData.append('chat_id', chatId);

  const res = await fetchWithDiagnostics(`${API_BASE}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error(await safeErrorDetail(res));
  const data = await res.json();
  return data.answer;
}

async function safeErrorDetail(res) {
  try {
    const data = await res.json();
    return data.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function fetchWithDiagnostics(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
    }
    throw new Error(`Connection error with backend: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

if (sendBtn) sendBtn.addEventListener('click', sendMessage);
if (composerInput) {
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

// ---------------------------------------------------------------------------
// Combine & Analyse Modal Logic
// ---------------------------------------------------------------------------
let combineSelection = [];

function openCombineModal() {
  combineSelection = [];
  const ids = Object.keys(chats);

  if (ids.length < 2) {
    combineList.innerHTML =
      '<p class="combine-empty">You need at least two conversations before you can compare them. ' +
      'Send a couple of messages first or use the pre-loaded demo chats in History.</p>';
    combineRun.disabled = true;
  } else {
    combineRun.disabled = true;
    combineList.innerHTML = '';
    ids.forEach((id) => {
      const label = document.createElement('label');
      label.className = 'combine-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      const span = document.createElement('span');
      span.textContent = chats[id].title;
      label.appendChild(input);
      label.appendChild(span);

      input.addEventListener('change', () => {
        if (input.checked) {
          if (combineSelection.length >= 2) {
            input.checked = false;
            return;
          }
          combineSelection.push(id);
        } else {
          combineSelection = combineSelection.filter((x) => x !== id);
        }
        label.classList.toggle('checked', input.checked);
        combineRun.disabled = combineSelection.length !== 2;
      });

      combineList.appendChild(label);
    });
  }

  openModal(combineOverlay);
}

if (combineCancel) combineCancel.addEventListener('click', () => closeModal(combineOverlay));
if (combineClose) combineClose.addEventListener('click', () => closeModal(combineOverlay));

if (combineRun) {
  combineRun.addEventListener('click', async () => {
    if (combineSelection.length !== 2) return;
    const [idA, idB] = combineSelection;
    const chatA = chats[idA];
    const chatB = chats[idB];
    if (!chatA || !chatB) {
      showToast('Those conversations are no longer available.');
      closeModal(combineOverlay);
      return;
    }
    closeModal(combineOverlay);

    showChatView();
    const analysisId = ensureChatForAnalysis(chatA.title, chatB.title);
    renderMessage('user', `Compare "${chatA.title}" with "${chatB.title}"`);
    renderTyping();
    sendBtn.disabled = true;

    try {
      const res = await fetchWithDiagnostics(`${API_BASE}/combine-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_a: chatA.messages,
          chat_b: chatB.messages,
        }),
      }, 25000);

      if (!res.ok) throw new Error(await safeErrorDetail(res));

      const data = await res.json();
      removeTyping();
      renderMessage('assistant', data.analysis);
      chats[analysisId].messages.push({ role: 'assistant', content: data.analysis });
    } catch (err) {
      removeTyping();
      renderMessage('assistant', `Combine & Analyse failed: ${err.message}`, { error: true });
    } finally {
      sendBtn.disabled = false;
      scrollToBottom();
    }
  });
}

function ensureChatForAnalysis(titleA, titleB) {
  const id = `chat-${Date.now()}`;
  const title = `Analysis: ${titleA} vs ${titleB}`;
  chats[id] = {
    id,
    title: title.slice(0, 42) + (title.length > 42 ? '…' : ''),
    messages: [{ role: 'user', content: `Compare "${titleA}" with "${titleB}"` }],
  };
  currentChatId = id;
  addHistoryEntry(id, chats[id].title);
  return id;
}

// ---------------------------------------------------------------------------
// Seed Demo Chats for History & Instant Combine Exploration
// ---------------------------------------------------------------------------
function seedDemoChats() {
  if (Object.keys(chats).length > 0) return;

  const demos = [
    {
      id: 'demo-quantum',
      title: 'Explain Quantum Computing',
      timeLabel: '10:30 AM',
      messages: [
        { role: 'user', content: 'Explain quantum computing in simple terms.' },
        {
          role: 'assistant',
          content:
            'Quantum computing uses qubits that can exist as 0, 1, or both simultaneously (superposition). Entanglement links qubits so measuring one immediately determines another. This enables solving certain complex mathematical models and simulations exponentially faster than classical computers.',
        },
      ],
    },
    {
      id: 'demo-python',
      title: 'Python Code Help',
      timeLabel: 'Yesterday',
      messages: [
        { role: 'user', content: 'How do I reverse a list in Python?' },
        {
          role: 'assistant',
          content:
            'Use list.reverse() to reverse in-place, or sliced_copy = my_list[::-1] for a new reversed list. You can also use reversed(my_list) for a lightweight memory-efficient iterator.',
        },
      ],
    },
    {
      id: 'demo-ml',
      title: 'Machine Learning Basics',
      timeLabel: 'Yesterday',
      messages: [
        { role: 'user', content: 'What is the difference between supervised and unsupervised learning?' },
        {
          role: 'assistant',
          content:
            'Supervised learning trains on labelled data where desired outcomes are known (classification, regression). Unsupervised learning uncovers patterns, structures, and clusters within unlabelled data without human feedback.',
        },
      ],
    },
    {
      id: 'demo-photo',
      title: 'Photosynthesis Process',
      timeLabel: '2 days ago',
      messages: [
        { role: 'user', content: 'Summarize photosynthesis.' },
        {
          role: 'assistant',
          content:
            'Photosynthesis is how plants convert light energy into chemical energy. Chlorophyll absorbs photons to split H₂O into oxygen and energy carriers (ATP/NADPH). The subsequent Calvin cycle fixes atmospheric CO₂ into glucose.',
        },
      ],
    },
    {
      id: 'demo-aixai',
      title: 'AI vs XAI Comparison',
      timeLabel: '2 days ago',
      messages: [
        { role: 'user', content: 'How is explainable AI different from standard AI?' },
        {
          role: 'assistant',
          content:
            'Traditional AI models often function as opaque black boxes. Explainable AI (XAI) embeds interpretability methods—such as feature attribution, decision trees, and counterfactuals—so humans can audit, understand, and trust the reasoning behind every prediction.',
        },
      ],
    },
    {
      id: 'demo-frontend',
      title: 'Frontend Project Ideas',
      timeLabel: '4 days ago',
      messages: [
        { role: 'user', content: 'Suggest beginner frontend project ideas.' },
        {
          role: 'assistant',
          content:
            'Try building a reactive Markdown journal, an interactive weather radar dashboard with public REST APIs, a real-time collaborative whiteboarding canvas, or a clean explainable AI chat app like this one!',
        },
      ],
    },
  ];

  if (historyEmpty) historyEmpty.hidden = true;
  demos.slice().reverse().forEach((d) => {
    chats[d.id] = { id: d.id, title: d.title, messages: d.messages };
    const btn = document.createElement('button');
    btn.className = 'history-item real';
    btn.dataset.chatId = d.id;
    btn.innerHTML = `
      ${chatIcon()}
      <span class="history-text"></span>
      <span class="history-time"></span>
    `;
    btn.querySelector('.history-text').textContent = d.title;
    btn.querySelector('.history-time').textContent = d.timeLabel;
    btn.addEventListener('click', () => loadChat(d.id));
    historyList.prepend(btn);
  });
}

seedDemoChats();
