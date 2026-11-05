// ---------------------------------------------------------------------------
// XAI frontend <-> FastAPI backend wiring
// ---------------------------------------------------------------------------
// Empty string = same origin (recommended: open http://127.0.0.1:8000 after starting uvicorn).
// Override only if the UI is hosted on a different origin than the API.
const API_BASE = (() => {
  if (window.XAI_API_BASE != null) return window.XAI_API_BASE;

  // Local development
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    return "http://127.0.0.1:8000";
  }

  // Production backend URL
  return "https://xai-chat-8.vercel.app";
})();


// In-memory client-side store of real conversations created in this session.
// Shape: { [chatId]: { id, title, time, messages: [{role, content}] } }
const chats = {};
let currentChatId = null;
let pendingFile = null; // { file, kind: 'device' | 'image' | 'camera' }

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const heroIntro = document.getElementById('heroIntro');
const chatThread = document.getElementById('chatThread');
const messageList = document.getElementById('messageList');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');

const composerInput = document.getElementById('composerInput');
const sendBtn = document.querySelector('.send-btn');
const newChatBtn = document.querySelector('.new-chat-btn');

const attachToggle = document.getElementById('attachToggle');
const attachMenu = document.getElementById('attachMenu');
const attachOptions = document.querySelectorAll('.attach-option');

const fileInputDevice = document.getElementById('fileInputDevice');
const fileInputImage = document.getElementById('fileInputImage');
const fileInputCamera = document.getElementById('fileInputCamera');
const imageBtn = document.querySelector('.image-btn');

const fileChip = document.getElementById('fileChip');
const fileChipName = document.getElementById('fileChipName');
const fileChipRemove = document.getElementById('fileChipRemove');

const connectionToast = document.getElementById('connectionToast');

const cardAsk = document.getElementById('cardAsk');
const cardUpload = document.getElementById('cardUpload');
const cardCombine = document.getElementById('cardCombine');
const cardInsights = document.getElementById('cardInsights');

const combineOverlay = document.getElementById('combineOverlay');
const combineList = document.getElementById('combineList');
const combineCancel = document.getElementById('combineCancel');
const combineRun = document.getElementById('combineRun');
const combineClose = document.getElementById('combineClose');
const combineBtn = document.querySelector('.combine-btn');

// ---------------------------------------------------------------------------
// Backend availability check
// ---------------------------------------------------------------------------
async function checkBackend() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error('unhealthy');
    console.log('[XAI] Backend reachable at', API_BASE);
  } catch (err) {
    console.error('[XAI] Health check failed:', err);
    showToast(
      `Can't reach the backend at ${API_BASE}. Start it with "uvicorn main:app --reload" and make sure GEMINI_API_KEY is set in .env.`
    );
  }

  if (location.protocol === 'file:') {
    console.warn(
      '[XAI] This page was opened directly from disk (file://). Some browsers block or mishandle ' +
      'cross-origin POST requests (like /chat) from file:// pages even though simple GET requests work. ' +
      'If sending a message does nothing and no POST shows up in your uvicorn log, serve this folder with ' +
      'a local server instead, e.g.: run "python3 -m http.server 5500" in this folder, then open ' +
      'http://127.0.0.1:5500 in your browser.'
    );
  }
}

let toastTimer = null;
function showToast(message, ms = 8000) {
  connectionToast.textContent = message;
  connectionToast.hidden = false;
  connectionToast.style.cursor = "pointer";
  connectionToast.title = "Click to dismiss";
  if (toastTimer) clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  connectionToast.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
}

connectionToast.addEventListener("click", hideToast);

checkBackend();

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------
function showChatView() {
  heroIntro.hidden = true;
  chatThread.hidden = false;
}

function showHeroView() {
  heroIntro.hidden = false;
  chatThread.hidden = true;
  messageList.innerHTML = '';
}

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.textContent;
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
    a.textContent = s.title || s.url || 'Link';
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
// History sidebar
// ---------------------------------------------------------------------------
function chatIcon() {
  return `<svg class="chat-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12C21 16.4183 16.9706 20 12 20C10.5257 20 9.13385 19.6905 7.90621 19.1379L3 20L4.39638 16.3187C3.51554 15.0301 3 13.5722 3 12C3 7.58172 7.02944 4 12 4C16.9706 4 21 7.58172 21 12Z" stroke="currentColor" stroke-width="1.8"/>
  </svg>`;
}

function addHistoryEntry(chatId, title) {
  historyEmpty.hidden = true;

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
}

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------
newChatBtn.addEventListener('click', () => {
  currentChatId = null;
  pendingFile = null;
  hideFileChip();
  document.querySelectorAll('.history-item').forEach((item) => item.classList.remove('active'));
  showHeroView();
  composerInput.focus();
});

// ---------------------------------------------------------------------------
// Feature cards
// ---------------------------------------------------------------------------
cardAsk.addEventListener('click', () => composerInput.focus());

cardUpload.addEventListener('click', () => {
  attachMenu.classList.add('open');
  attachToggle.setAttribute('aria-expanded', 'true');
});

cardCombine.addEventListener('click', openCombineModal);
if (combineBtn) combineBtn.addEventListener('click', openCombineModal);

cardInsights.addEventListener('click', () => {
  composerInput.focus();
  if (!composerInput.value) {
    composerInput.placeholder = 'Ask for a deeper explanation, e.g. "Explain the trade-offs behind..."';
  }
});

// ---------------------------------------------------------------------------
// Attach menu + file selection
// ---------------------------------------------------------------------------
function closeAttachMenu() {
  attachMenu.classList.remove('open');
  attachToggle.setAttribute('aria-expanded', 'false');
}

attachToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = attachMenu.classList.toggle('open');
  attachToggle.setAttribute('aria-expanded', String(isOpen));
});

document.addEventListener('click', (e) => {
  if (!attachMenu.contains(e.target) && e.target !== attachToggle) {
    closeAttachMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAttachMenu();
    closeCombineModal();
  }
});

attachOptions[0].addEventListener('click', () => { fileInputDevice.click(); closeAttachMenu(); });
attachOptions[1].addEventListener('click', () => { fileInputImage.click(); closeAttachMenu(); });
attachOptions[2].addEventListener('click', () => { fileInputCamera.click(); closeAttachMenu(); });
imageBtn.addEventListener('click', () => fileInputImage.click());

[fileInputDevice, fileInputImage, fileInputCamera].forEach((input) => {
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

fileChipRemove.addEventListener('click', () => {
  pendingFile = null;
  hideFileChip();
});

// ---------------------------------------------------------------------------
// Sending messages
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
  // Replace typing dots with an empty assistant bubble we fill token-by-token
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
      // Streaming path — first tokens appear immediately (feels much faster)
      answer = await sendChatStream(text, chatId);
      finishStreamingBubble();
    }
    chats[chatId].messages.push({ role: 'assistant', content: answer });
  } catch (err) {
    removeTyping();
    finishStreamingBubble();
    renderMessage('assistant', `Something went wrong talking to the backend: ${err.message}`, { error: true });
  } finally {
    sendBtn.disabled = false;
  }
}

/**
 * Stream tokens from POST /chat/stream (SSE).
 * Updates the assistant bubble live as each token arrives.
 */
async function sendChatStream(message, chatId) {
  const history = chats[chatId].messages.slice(0, -1);
  const url = `${API_BASE}/chat/stream`;
  const controller = new AbortController();
  // Overall client limit; backend should answer or mock much sooner
  const timer = setTimeout(() => controller.abort(), 45000);

  console.log('[XAI] Streaming', url);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ chat_id: chatId, message, history }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(
        `Chat timed out. Is uvicorn running? In Terminal you should see [XAI] /chat/stream lines. ` +
        `If the model is slow, set MAX_OUTPUT_TOKENS=512 in backend/.env and restart.`
      );
    }
    throw new Error(
      `Could not reach ${url}. Open http://127.0.0.1:8000 (not file://). ${err.message}`
    );
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
          // remove previous sources block if any, then render
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
    console.warn('[XAI] Empty stream — trying non-streaming /chat once');
    try {
      return await sendChat(message, chatId);
    } catch (e) {
      throw new Error(
        `No response from the model. Check the uvicorn window for errors. (${e.message})`
      );
    }
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
    }),
  });

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(detail);
  }

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

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(detail);
  }

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

// Wraps fetch with a timeout and turns opaque network/CORS failures into a
// clear, actionable message instead of a silent hang or a cryptic
// "Failed to fetch" with no context.
async function fetchWithDiagnostics(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  console.log('[XAI] Requesting', options.method || 'GET', url);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    console.log('[XAI] Response', res.status, url);
    return res;
  } catch (err) {
    console.error('[XAI] Fetch failed for', url, err);

    if (err.name === 'AbortError') {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs / 1000}s. Server may still be starting or the model is slow ` +
        `(e.g. waiting on the Gemini API) — check the uvicorn terminal for errors.`
      );
    }

    // A generic "Failed to fetch" / TypeError here almost always means the request
    // never reached the server at all: the backend isn't running, API_BASE points to
    // the wrong address, or the browser blocked it (commonly because this page was
    // opened as file:// instead of being served over http://).
    throw new Error(
      `Could not reach ${url}. Check that: (1) uvicorn is running, (2) API_BASE in script.js ` +
      `matches its address, and (3) you opened this page via a local server (http://) rather ` +
      `than double-clicking index.html. Raw error: ${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }
}

sendBtn.addEventListener('click', sendMessage);
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ---------------------------------------------------------------------------
// Combine & Analyse
// ---------------------------------------------------------------------------
let combineSelection = [];

function openCombineModal() {
  combineSelection = [];
  const ids = Object.keys(chats);

  if (ids.length < 2) {
    combineList.innerHTML =
      '<p class="combine-empty">You need at least two conversations before you can compare them. ' +
      'Send a couple of messages first (or use the demo chats already in History), then open this again.</p>';
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

  combineOverlay.hidden = false;
  combineOverlay.classList.add('is-open');
  document.body.classList.add('modal-open');
}

function closeCombineModal() {
  combineOverlay.hidden = true;
  combineOverlay.classList.remove('is-open');
  document.body.classList.remove('modal-open');
  combineSelection = [];
}

combineCancel.addEventListener('click', closeCombineModal);
if (combineClose) combineClose.addEventListener('click', closeCombineModal);
combineOverlay.addEventListener('click', (e) => {
  if (e.target === combineOverlay) closeCombineModal();
});

combineRun.addEventListener('click', async () => {
  if (combineSelection.length !== 2) return;
  const [idA, idB] = combineSelection;
  const chatA = chats[idA];
  const chatB = chats[idB];
  if (!chatA || !chatB) {
    showToast('Those conversations are no longer available. Open Combine again.');
    closeCombineModal();
    return;
  }
  closeCombineModal();

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
    }, 20000);

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
  }
});

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
// Demo history so Combine works immediately (matches typical UI screenshots)
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
            'Quantum computing uses qubits that can be 0, 1, or both (superposition). Entanglement links qubits so measuring one affects another. This lets certain problems (factoring, simulation) be solved much faster than on classical computers, but qubits are fragile and error-prone today.',
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
            'Use list.reverse() in place, or sliced_copy = my_list[::-1] for a new list. For iterators, reversed(my_list) returns a reverse iterator without copying.',
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
            'Supervised learning trains on labeled examples (input → known output). Unsupervised learning finds structure in unlabeled data (clustering, dimensionality reduction). Semi-supervised mixes both.',
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
            'Plants convert light energy into chemical energy. In the light reactions, chlorophyll captures photons and splits water, releasing O₂ and storing energy in ATP/NADPH. The Calvin cycle then uses CO₂ to build sugars.',
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
            'Standard models often act as black boxes. Explainable AI (XAI) adds techniques—feature importance, counterfactuals, attention maps—so humans can understand why a prediction was made, which matters for trust, debugging, and regulation.',
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
            'Try a todo app with localStorage, a weather dashboard using a public API, a markdown previewer, or a small chat UI like this one. Focus on layout, state, and accessibility.',
        },
      ],
    },
  ];

  historyEmpty.hidden = true;
  // Insert oldest first so prepend order matches screenshot (newest on top)
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
