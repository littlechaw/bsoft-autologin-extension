importScripts("config.js");

const LOGIN_TIMEOUT_MS = 60_000;
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
  await setState(emptyState());
  await closeTab(loginTabId);
};

const startLogin = async () => {
  const previous = await getState();
  if (previous.busy) {
    // Service worker 重启后 session 状态可能残留；标签页不存在时解除锁定，
    // 否则后续点击会一直被误判为“已有登录任务”。
    if (!previous.tabId) {
      await resetState();
    } else {
      try {
        await chrome.tabs.get(previous.tabId);
        return previous;
      } catch {
        await resetState();
      }
    }
  }

  const jobId = crypto.randomUUID();
  await setState({ busy: true, jobId });
  await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + LOGIN_TIMEOUT_MS });

  let tab;
  try {
    tab = await chrome.tabs.create({ active: false, url: "about:blank" });

    const current = await getState();
    if (!current.busy || current.jobId !== jobId) {
      await closeTab(tab.id);
      return getState();
    }

    await setState({ ...current, tabId: tab.id });
    const authUrl = `${BSOFT_LOGIN.authUrl}#bsoft-autologin=${encodeURIComponent(jobId)}`;
    await chrome.tabs.update(tab.id, { url: authUrl });
  } catch {
    if (tab?.id) {
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

chrome.tabs.onRemoved.addListener((tabId) => {
  getState().then((state) => {
    if (state.busy && state.tabId === tabId) finish({ tabId });
  });
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
