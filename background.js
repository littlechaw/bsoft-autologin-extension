importScripts("config.js");

const LOGIN_TIMEOUT_MS = 25_000;
const STATE_KEY = "bsoftLoginState";
const TIMEOUT_ALARM = "bsoft-login-timeout";

const emptyState = () => ({ busy: false });

const setState = async (state) => {
  await chrome.storage.session.set({ [STATE_KEY]: state });
};

const getState = async () =>
  (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || emptyState();

const resetState = async () => {
  await chrome.alarms.clear(TIMEOUT_ALARM);
  await setState(emptyState());
};

const detachDebugger = async (tabId) => {
  if (!tabId) return;
  try {
    // 证书错误忽略设置由调试会话控制，关闭前先恢复默认校验。
    await chrome.debugger.sendCommand({ tabId }, "Security.setIgnoreCertificateErrors", {
      ignore: false
    });
  } catch {
    // 目标页可能已经关闭，或调试会话已经断开。
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // 无活动调试会话时无需处理。
  }
};

const closeTab = async (tabId) => {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 标签页已关闭时无需处理。
  }
};

const finish = async ({ tabId }) => {
  const state = await getState();
  if (!state.busy) return;

  await chrome.alarms.clear(TIMEOUT_ALARM);
  const loginTabId = tabId || state.tabId;
  if (state.debuggerAttached) await detachDebugger(loginTabId);
  await closeTab(loginTabId);
  await setState(emptyState());
};

const startLogin = async () => {
  const previous = await getState();
  if (previous.busy) return previous;

  const jobId = crypto.randomUUID();
  await setState({ busy: true, jobId });
  await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + LOGIN_TIMEOUT_MS });

  let tab;
  try {
    // 隐私错误页（chrome-error://）不允许注入内容脚本。先在空白临时页上
    // 建立调试会话并忽略该页的证书错误，等效于手动点击“高级/继续前往”。
    tab = await chrome.tabs.create({ active: false, url: "about:blank" });
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Security.setIgnoreCertificateErrors", {
      ignore: true
    });

    const current = await getState();
    if (!current.busy || current.jobId !== jobId) {
      await detachDebugger(tab.id);
      await closeTab(tab.id);
      return getState();
    }

    await setState({ ...current, tabId: tab.id, debuggerAttached: true });
    const authUrl = `${BSOFT_LOGIN.authUrl}#bsoft-autologin=${encodeURIComponent(jobId)}`;
    await chrome.tabs.update(tab.id, { url: authUrl });
  } catch {
    if (tab?.id) {
      await detachDebugger(tab.id);
      await closeTab(tab.id);
    }
    const current = await getState();
    if (current.busy && current.jobId === jobId) await resetState();
  }

  return getState();
};

chrome.runtime.onInstalled.addListener(() => {
  resetState();
});

chrome.runtime.onStartup.addListener(() => {
  resetState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TIMEOUT_ALARM) {
    getState().then((state) => {
      finish({ tabId: state.tabId });
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bsoft-start-login") {
    startLogin().then(sendResponse).catch(() => {
      sendResponse(emptyState());
    });
    return true;
  }

  if (message?.type === "bsoft-login-submitted") {
    getState().then(async (state) => {
      if (!state.busy || state.jobId !== message.jobId) return;
      await setState({ ...state, tabId: sender.tab?.id });
    });
    return;
  }

  if (message?.type === "bsoft-login-error") {
    getState().then((state) => {
      if (state.busy && state.jobId === message.jobId) {
        finish({ tabId: sender.tab?.id });
      }
    });
    return;
  }

  if (message?.type === "bsoft-login-success") {
    getState().then((state) => {
      if (state.busy && state.tabId === sender.tab?.id) {
        finish({ tabId: sender.tab?.id });
      }
    });
  }
});
