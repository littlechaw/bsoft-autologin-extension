(() => {
  const setInputValue = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const getCredentials = async () => {
    const stored = await chrome.storage.local.get(["username", "password"]);
    if (typeof stored.username !== "string" || stored.username.length === 0 ||
        typeof stored.password !== "string" || stored.password.length === 0) {
      return null;
    }
    return {
      username: stored.username,
      password: stored.password
    };
  };

  const acceptTerms = () => {
    const agreeCheck = document.querySelector("#agreeCheck");
    if (!(agreeCheck instanceof HTMLImageElement)) return;

    if (agreeCheck.src.endsWith("/uncheck.png")) agreeCheck.click();
  };

  const waitForLoginControls = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const username = document.querySelector("#username");
      const password = document.querySelector("#password");
      const loginButton = document.querySelector("#loginBtn");
      if (username instanceof HTMLInputElement &&
          password instanceof HTMLInputElement &&
          loginButton instanceof HTMLElement) {
        return { username, password, loginButton };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return null;
  };

  const login = async () => {
    const controls = await waitForLoginControls();

    if (!controls) {
      return { ok: false, message: "未识别到网关登录控件" };
    }

    const { username, password, loginButton } = controls;

    const credentials = await getCredentials();
    if (!credentials) return { ok: false, message: "请先在扩展弹窗输入工号和密码" };
    acceptTerms();
    setInputValue(username, credentials.username);
    setInputValue(password, credentials.password);
    loginButton.click();
    return { ok: true, message: "认证请求已提交" };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "bsoft-login") return;
    login().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, message: error.message || "登录脚本执行失败" });
    });
    return true;
  });

  const jobId = new URLSearchParams(location.hash.slice(1)).get("bsoft-autologin");
  if (location.pathname.endsWith("/authSuccess.html")) {
    chrome.runtime.sendMessage({ type: "bsoft-login-success" });
  } else if (jobId) {
    window.setTimeout(async () => {
      try {
        const result = await login();
        if (result.ok) {
          chrome.runtime.sendMessage({ type: "bsoft-login-submitted", jobId });
        } else {
          chrome.runtime.sendMessage({ type: "bsoft-login-error", jobId, message: result.message });
        }
      } catch {
        chrome.runtime.sendMessage({ type: "bsoft-login-error", jobId, message: "登录脚本执行失败" });
      }
    }, 0);
  }
})();
