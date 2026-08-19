const loginButton = document.querySelector("#login");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");

const initialize = async () => {
  const stored = await chrome.storage.local.get(["username", "password"]);
  usernameInput.value = typeof stored.username === "string" ? stored.username : "";
  passwordInput.value = typeof stored.password === "string" && stored.password.length > 0
    ? stored.password
    : "";
};

const saveCredentials = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (username.length === 0 || password.length === 0) return false;
  await chrome.storage.local.set({ username, password });
  return true;
};

loginButton.addEventListener("click", async () => {
  loginButton.disabled = true;

  try {
    const credentialsSaved = await saveCredentials();
    if (!credentialsSaved) {
      (usernameInput.value.trim().length === 0 ? usernameInput : passwordInput).focus();
      return;
    }
    await chrome.runtime.sendMessage({ type: "bsoft-start-login" });
  } finally {
    loginButton.disabled = false;
  }
});

initialize().catch(() => {});
