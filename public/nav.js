// Site-wide menu, injected at the top of every public page so there is one
// list of pages to maintain. Self-contained styles (matching theme.css) so
// it also looks right on pages that haven't moved to the shared theme yet.
(function () {
  var LINKS = [
    ["/", "Home"],
    ["/try", "Try a check"],
    ["/lists", "Lists we check"],
    ["/methodology", "Methodology"],
    ["/docs", "API docs"],
  ];
  var path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/landing") path = "/try";

  // Two overlapping pastel discs, printed slightly off-register: the mark.
  var MARK = '<svg width="26" height="20" viewBox="0 0 26 20" aria-hidden="true">' +
    '<circle cx="9" cy="10" r="8" fill="#E6DDFF" style="mix-blend-mode:multiply"/>' +
    '<circle cx="17" cy="10" r="8" fill="#FFE4D2" style="mix-blend-mode:multiply"/></svg>';

  var css = document.createElement("style");
  css.textContent =
    "#site-nav{font:500 15px/1.2 'Instrument Sans',system-ui,sans-serif;background:rgba(251,248,255,.92);" +
    "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid #DCD2EA;position:sticky;top:0;z-index:1000}" +
    "#site-nav .in{max-width:1120px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:4px;" +
    "overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}" +
    "#site-nav .in::-webkit-scrollbar{display:none}" +
    "#site-nav .brand{display:flex;align-items:center;gap:9px;font:600 20px 'Instrument Sans',system-ui,sans-serif;" +
    "letter-spacing:-.02em;color:#2B1A3F;text-decoration:none;padding:12px 16px 12px 0;margin-right:auto}" +
    "#site-nav a.l{color:#6B5A80;text-decoration:none;padding:7px 13px;border-radius:999px}" +
    "#site-nav a.l:hover{color:#2B1A3F;background:#F3EEFB}" +
    "#site-nav a.l.on{color:#2B1A3F;background:#E6DDFF}" +
    "#site-nav a:focus-visible{outline:3px solid #5A3DC8;outline-offset:2px}";
  document.head.appendChild(css);

  var nav = document.createElement("nav");
  nav.id = "site-nav";
  nav.setAttribute("aria-label", "Site");
  nav.innerHTML =
    '<div class="in"><a class="brand" href="/">' + MARK + 'PayPerScreen</a>' +
    LINKS.map(function (l) {
      return '<a class="l' + (l[0] === path ? " on" : "") + '" href="' + l[0] + '"' +
        (l[0] === path ? ' aria-current="page"' : "") + ">" + l[1] + "</a>";
    }).join("") + "</div>";
  document.body.insertBefore(nav, document.body.firstChild);

  // Site-wide footer: page links, privacy, and how to reach us. Contact
  // details come from /api/site-info (CONTACT_EMAIL / CONTACT_X /
  // CONTACT_FACEBOOK on Railway), with the current values as a fallback.
  if (!document.querySelector(".site-foot")) {
    var fcss = document.createElement("style");
    fcss.textContent =
      ".site-foot{border-top:1px solid #DCD2EA;margin-top:48px;font:400 15px/1.5 'Instrument Sans',system-ui,sans-serif;color:#6B5A80}" +
      ".site-foot .fin{max-width:1120px;margin:0 auto;padding:26px 20px 40px;display:flex;flex-wrap:wrap;gap:10px 26px;align-items:center}" +
      ".site-foot .mark{display:flex;align-items:center;gap:9px;font:600 18px 'Instrument Sans',system-ui,sans-serif;color:#2B1A3F;margin-right:auto}" +
      ".site-foot a{color:#2B1A3F}" +
      ".site-foot .reach{flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px 20px}";
    document.head.appendChild(fcss);
    var foot = document.createElement("footer");
    foot.className = "site-foot";
    var render = function (i) {
      var reach = [];
      if (i.contactEmail) reach.push('<a href="mailto:' + i.contactEmail + '">' + i.contactEmail + "</a>");
      if (i.x) reach.push('<a href="https://x.com/' + i.x + '" rel="noopener">X @' + i.x + "</a>");
      if (i.facebook) reach.push('<a href="https://www.facebook.com/' + i.facebook + '" rel="noopener">Facebook</a>');
      foot.innerHTML = '<div class="fin"><span class="mark">' + MARK + "PayPerScreen</span>" +
        LINKS.slice(1).map(function (l) { return '<a href="' + l[0] + '">' + l[1] + "</a>"; }).join("") +
        '<a href="/privacy">Privacy</a>' +
        (reach.length ? '<span class="reach">Questions or need help integrating? ' + reach.join("") + "</span>" : "") +
        "</div>";
    };
    render({ contactEmail: "hello@albatrossletter.com", x: "AlbatrossLetter", facebook: "AlbatrossLetter" });
    document.body.appendChild(foot);
    fetch("/api/site-info").then(function (r) { return r.json(); }).then(render).catch(function () {});
  }
})();
