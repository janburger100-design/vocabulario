
/* ===================== Anmeldung & Status ===================== */
function renderLogin(){
  app.innerHTML =
  '<section class="screen login">'+
    '<header class="top"><div class="brand"><span class="mark">ñ</span><b>Vocabulario</b></div></header>'+
    '<div class="login-card">'+
      '<h1 class="page">Anmelden</h1>'+
      '<p class="muted">Mit einem Konto wird dein Lernstand zwischen iPhone und MacBook abgeglichen. Lernen geht auch offline, abgeglichen wird, sobald du wieder Internet hast.</p>'+
      '<form class="form" id="loginForm">'+
        '<div class="field"><label for="l-mail">E-Mail</label><input id="l-mail" type="email" autocomplete="username" required value="'+h(S.loginMail||"")+'"></div>'+
        '<div class="field"><label for="l-pass">Passwort</label><input id="l-pass" type="password" autocomplete="current-password" minlength="6" required></div>'+
        (S.authError ? '<div class="banner err">'+h(S.authError)+'</div>' : '')+
        '<button class="cta" type="submit" '+(S.authBusy?"disabled":"")+'>'+(S.authBusy?"Einen Moment …":"Anmelden")+'</button>'+
        '<button class="tool wide" type="button" data-act="signup" '+(S.authBusy?"disabled":"")+'>Neues Konto erstellen</button>'+
      '</form>'+
      '<div class="login-links"><button class="textbtn" data-act="reset">Passwort vergessen</button><button class="textbtn" data-act="local">Ohne Konto nur auf diesem Gerät nutzen</button></div>'+
    '</div>'+
  '</section>';
  const f=document.getElementById("loginForm");
  f.addEventListener("submit",function(e){ e.preventDefault(); S.loginMail=document.getElementById("l-mail").value.trim(); doLogin("login", S.loginMail, document.getElementById("l-pass").value); });
}
function loginFields(){ const m=document.getElementById("l-mail"), p=document.getElementById("l-pass"); S.loginMail=m?m.value.trim():""; return {mail:S.loginMail, pass:p?p.value:""}; }

function statusBanner(){
  if (S.mode==="local") return '<div class="banner">Nur auf diesem Gerät gespeichert, kein Abgleich. '+(CONFIG?'<button class="textbtn inline" data-act="to-login">Mit Konto anmelden</button>':'Der Abgleich wird aktiv, sobald das Firebase-Projekt eingerichtet ist.')+'</div>';
  if (S.mode==="cloud" && !S.online) return '<div class="banner">Offline. Du kannst normal lernen, abgeglichen wird automatisch, sobald du wieder online bist.</div>';
  return "";
}
function accountLine(){
  if (S.mode==="cloud") return '<p class="foot account">'+h(S.email)+' · '+(S.online ? (S.pending?"wird abgeglichen …":"abgeglichen") : "offline")+' · <button class="textbtn inline" data-act="logout">Abmelden</button></p>';
  return "";
}
