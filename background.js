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

const clickPrivacyWarning = async (tabId) => {
  // chrome-error:// 页面不允许内容脚本注入，只能通过调试协议模拟用户点击。
  // 使用视口比例定位，兼容不同窗口尺寸和缩放比例。
  let width = 1920;
  let height = 1080;
  try {
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    width = metrics?.cssVisualViewport?.clientWidth || width;
    height = metrics?.cssVisualViewport?.clientHeight || height;
  } catch {
    // 使用默认尺寸继续尝试点击。
  }

  const click = async (xRatio, yRatio) => {
    const x = Math.round(width * xRatio);
    const y = Math.round(height * yRatio);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1
    });
  };

  // Chrome 中文隐私页中“高级”位于左侧，“继续前往”展开后位于右侧。
  await click(0.2, 0.765);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await click(0.735, 0.765);
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  Promise.all([getState(), chrome.tabs.get(tabId).catch(() => null)]).then(async ([state, tab]) => {
    if (!tab?.url?.startsWith("chrome-error://")) return;
    if (!state.busy || state.tabId !== tabId || state.privacyWarningHandled) return;
    await setState({ ...state, privacyWarningHandled: true });
    try {
      await clickPrivacyWarning(tabId);
    } catch {
      await finish({ tabId });
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
