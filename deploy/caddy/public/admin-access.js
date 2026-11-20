const signIn = document.getElementById("signin");
const check = document.getElementById("check-access");
const message = document.getElementById("access-message");
const loginUrl = new URL("/login", location.origin);
loginUrl.port = "8443";
signIn.href = loginUrl.href;

async function checkAccess() {
  if (check.disabled) return;
  check.disabled = true;
  try {
    const response = await fetch("/api/netplay/bridge/admin/context", {
      cache: "no-store",
    });
    if (response.ok) {
      location.reload();
      return;
    }
    if (response.status === 401) {
      message.textContent = "Sign in to RomM as an administrator in the new tab, then return here.";
    } else if (response.status === 403) {
      message.textContent = "Your RomM account needs administrator access to view settings and logs.";
    } else {
      message.textContent = "RomM is unavailable. Check access again when the server is ready.";
    }
  } catch {
    message.textContent = "Could not reach RomM. Check access to try again.";
  } finally {
    check.disabled = false;
  }
}

check.addEventListener("click", checkAccess);
window.addEventListener("focus", checkAccess);
void checkAccess();
