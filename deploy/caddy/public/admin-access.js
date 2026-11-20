const korean = /^ko(?:[-_]|$)/i.test(navigator.language);
const text = (english, ko) => (korean ? ko : english);
const signIn = document.getElementById("signin");
const check = document.getElementById("check-access");
const message = document.getElementById("access-message");
const loginUrl = new URL("/login", location.origin);
loginUrl.port = "8443";
signIn.href = loginUrl.href;
if (korean) {
  document.documentElement.lang = "ko";
  document.title = document.querySelector("h1").textContent =
    "넷플레이 브리지 관리";
  message.textContent = "RomM 관리자 권한 확인 중…";
  signIn.textContent = "RomM 로그인 열기";
  check.textContent = "권한 확인";
}

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
      message.textContent = text(
        "Sign in to RomM as an administrator in the new tab, then return here.",
        "새 탭에서 RomM 관리자 계정으로 로그인한 뒤 이 화면으로 돌아오세요.",
      );
    } else if (response.status === 403) {
      message.textContent = text(
        "Your RomM account needs administrator access to view settings and logs.",
        "설정과 로그를 보려면 RomM 관리자 권한이 필요합니다.",
      );
    } else {
      message.textContent = text(
        "RomM is unavailable. Check access again when the server is ready.",
        "RomM에 연결할 수 없습니다. 서버가 준비되면 권한을 다시 확인하세요.",
      );
    }
  } catch {
    message.textContent = text(
      "Could not reach RomM. Check access to try again.",
      "RomM에 연결할 수 없습니다. 권한 확인을 눌러 다시 시도하세요.",
    );
  } finally {
    check.disabled = false;
  }
}

check.addEventListener("click", checkAccess);
window.addEventListener("focus", checkAccess);
void checkAccess();
