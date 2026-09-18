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

const detachDebugger = async (tabId) => {
  if (!tabId) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // 无活动调试会话时无需处理。
  }
};

const clickPrivacyWarning = async (tabId) => {
  // chrome-error:// 页面不允许内容脚本注入，只能通过调试协议访问页面元素。
  const clickElement = async (selector) => {
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`,
        returnByValue: true
      });
      return result?.result?.value === true;
    } catch {
      return false;
    }
  };

  if (!await clickElement("#details-button")) return false;

  // 展开高级信息后，“继续前往”链接会异步插入。绝不回退到坐标点击，
  // 以免误点同一行右侧的“返回安全连接”。
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await clickElement("#proceed-link")) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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
  // 先清空状态，避免 detach/close 触发 onDetach/onRemoved 时重复进入 finish。
  await setState(emptyState());
  if (state.debuggerAttached) await detachDebugger(loginTabId);
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
    // 先建立调试会话，等检测到 chrome-error:// 隐私页后模拟两次鼠标点击。
    tab = await chrome.tabs.create({ active: true, url: "about:blank" });
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");

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

chrome.debugger.onEvent.addListener((source, method) => {
  if (method !== "Page.loadEventFired" || !source.tabId) return;
  getState().then(async (state) => {
    const tabId = source.tabId;
    if (!state.busy || state.tabId !== tabId || state.privacyWarningHandled) return;
    try {
      if (await clickPrivacyWarning(tabId)) {
        await setState({ ...state, privacyWarningHandled: true });
      }
    } catch {
      // 不是隐私页或调试上下文已切换时不终止正常登录流程。
    }
  });
});

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

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source?.tabId;
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
