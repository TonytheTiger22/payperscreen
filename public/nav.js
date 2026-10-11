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
    '<circle cx="9" cy="10" r="8" fill="#CDBBFF" style="mix-blend-mode:multiply"/>' +
    '<circle cx="17" cy="10" r="8" fill="#FFC8A6" style="mix-blend-mode:multiply"/></svg>';

  var css = document.createElement("style");
  css.textContent =
    "#site-nav{font:700 15px/1.2 'Atkinson Hyperlegible',system-ui,sans-serif;background:rgba(251,248,255,.92);" +
    "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:2px solid #2B1A3F;position:sticky;top:0;z-index:1000}" +
    "#site-nav .in{max-width:1120px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:4px;" +
    "overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}" +
    "#site-nav .in::-webkit-scrollbar{display:none}" +
    "#site-nav .brand{display:flex;align-items:center;gap:9px;font:800 21px 'Bricolage Grotesque',system-ui,sans-serif;" +
    "font-variation-settings:'wdth' 80;letter-spacing:-.02em;color:#2B1A3F;text-decoration:none;padding:12px 16px 12px 0;margin-right:auto}" +
    "#site-nav a.l{color:#6B5A80;text-decoration:none;padding:7px 13px;border-radius:999px}" +
    "#site-nav a.l:hover{color:#2B1A3F;background:#F3EEFB}" +
    "#site-nav a.l.on{color:#2B1A3F;background:#CDBBFF}" +
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
})();
