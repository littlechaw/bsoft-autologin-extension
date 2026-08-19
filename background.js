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
  await closeTab(tabId || state.tabId);
  await setState(emptyState());
};

const startLogin = async () => {
  const previous = await getState();
  if (previous.busy) return previous;

  const jobId = crypto.randomUUID();
  await setState({ busy: true, jobId });
  await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + LOGIN_TIMEOUT_MS });

  const authUrl = `${BSOFT_LOGIN.authUrl}#bsoft-autologin=${encodeURIComponent(jobId)}`;
  const tab = await chrome.tabs.create({ active: false, url: authUrl });
  const current = await getState();
  if (current.busy && current.jobId === jobId) {
    await setState({ ...current, tabId: tab.id });
  } else {
    await closeTab(tab.id);
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
