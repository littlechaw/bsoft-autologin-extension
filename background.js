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

const clickElement = async (tabId, selector) => {
  // chrome-error:// 页面不允许内容脚本注入。通过 CDP 读取元素实际边界后点击，
  // 不依赖窗口尺寸、缩放比例或页面布局。
  try {
    const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", {
      depth: 1,
      pierce: true
    });
    const { nodeId } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector
    });
    if (!nodeId) return false;

    const { model } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", {
      nodeId
    });
    const quad = model.border;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1
    });
    return true;
  } catch {
    return false;
  }
};

const startPrivacyWarningPolling = (tabId) => {
  const deadline = Date.now() + 15_000;

  const poll = async () => {
    const state = await getState();
    if (!state.busy || state.tabId !== tabId || state.privacyWarningHandled ||
        Date.now() >= deadline) return;

    if (!state.privacyWarningOpened) {
      if (await clickElement(tabId, "#details-button")) {
        await setState({ ...state, privacyWarningOpened: true });
      }
    } else if (await clickElement(tabId, "#proceed-link")) {
      await setState({ ...state, privacyWarningHandled: true });
      return;
    }

    setTimeout(poll, 150);
  };

  poll();
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
    // 先建立调试会话，导航后主动轮询隐私页中的两个按钮。
    tab = await chrome.tabs.create({ active: true, url: "about:blank" });
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.enable");

    const current = await getState();
    if (!current.busy || current.jobId !== jobId) {
      await detachDebugger(tab.id);
      await closeTab(tab.id);
      return getState();
    }

    await setState({ ...current, tabId: tab.id, debuggerAttached: true });
    const authUrl = `${BSOFT_LOGIN.authUrl}#bsoft-autologin=${encodeURIComponent(jobId)}`;
    await chrome.tabs.update(tab.id, { url: authUrl });
    startPrivacyWarningPolling(tab.id);
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
