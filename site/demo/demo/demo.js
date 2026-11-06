/* OpenGTM static demo: pages are saved copies of a real dashboard filled with made-up data.
   Nothing here talks to a server. Forms and buttons only show a notice. */
(function () {
  var me = document.currentScript && document.currentScript.src;
  var root = me ? new URL("..", me).href : "./";
  var REPO = "https://github.com/deanayoung3-droid/opengtm";
  var html = document.documentElement;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };

  function applyTheme(t) {
    if (t === "light" || t === "dark") html.dataset.theme = t; else delete html.dataset.theme;
  }
  applyTheme(store.get("gtm-demo-theme"));

  var toastEl, toastTimer;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "demo-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("on"); }, 2600);
  }

  function ready() {
    // Status card in the sidebar
    document.querySelectorAll(".status-card").forEach(function (c) {
      var line = c.querySelector(".line");
      if (line) line.innerHTML = '<span class="dot idle"></span>Demo';
      var hint = c.querySelector(".hint");
      if (hint) hint.textContent = "Made-up data. Nothing is sent.";
    });

    // Any other "Dry run" label (the dashboard header pill) becomes "Demo".
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() === "Dry run") n.nodeValue = n.nodeValue.replace("Dry run", "Demo");

    // Animated counters: the digit wheels render at 0 until React runs, so set them from the label.
    document.querySelectorAll(".countup").forEach(function (el) {
      var digits = (el.getAttribute("aria-label") || "").replace(/\D/g, "");
      var wheels = el.querySelectorAll(".roll-d > span");
      if (digits.length !== wheels.length) return;
      wheels.forEach(function (w, i) { w.style.transform = "translateY(-" + Number(digits[i]) * 10 + "%)"; });
    });

    // Sidebar groups that fold
    var FOLD = "gtm-demo-nav";
    var saved = {};
    try { saved = JSON.parse(store.get(FOLD) || "{}"); } catch (e) {}
    function setFold(group, open) {
      group.classList.toggle("open", open);
      var btn = group.querySelector(".nav-toggle");
      var fold = group.querySelector(".nav-fold");
      if (btn) btn.setAttribute("aria-expanded", String(open));
      if (fold) fold.setAttribute("aria-hidden", String(!open));
      group.querySelectorAll(".nav-fold a").forEach(function (a) { open ? a.removeAttribute("tabindex") : a.setAttribute("tabindex", "-1"); });
    }
    document.querySelectorAll(".nav-group.fold").forEach(function (g) {
      var label = (g.querySelector(".nav-toggle span") || {}).textContent;
      var hasCurrent = !!g.querySelector(".nav-fold a.on, .nav-fold a[aria-current]");
      setFold(g, label in saved ? saved[label] : hasCurrent || g.classList.contains("open"));
      var btn = g.querySelector(".nav-toggle");
      if (btn) btn.addEventListener("click", function () {
        var open = !g.classList.contains("open");
        setFold(g, open);
        saved[label] = open;
        store.set(FOLD, JSON.stringify(saved));
      });
    });

    // Phone menu
    function setNav(open) { open ? (html.dataset.navOpen = "") : delete html.dataset.navOpen; }
    document.querySelectorAll(".mobile-menu").forEach(function (b) {
      b.addEventListener("click", function () {
        var open = !("navOpen" in html.dataset);
        setNav(open);
        b.setAttribute("aria-expanded", String(open));
      });
    });
    document.querySelectorAll(".nav-backdrop").forEach(function (b) { b.addEventListener("click", function () { setNav(false); }); });

    // Profile menu: theme and a few links
    document.querySelectorAll(".profile-menu").forEach(function (menu) {
      var chip = menu.querySelector(".me-chip");
      if (!chip) return;
      var pop;
      function close() { if (pop) { pop.remove(); pop = null; chip.setAttribute("aria-expanded", "false"); } }
      function open() {
        var cur = store.get("gtm-demo-theme") || "system";
        pop = document.createElement("div");
        pop.className = "profile-pop";
        pop.setAttribute("role", "menu");
        var themes = [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(function (t) {
          return '<button type="button" role="radio" data-theme-pick="' + t[0] + '" aria-checked="' + (cur === t[0]) + '" class="' + (cur === t[0] ? "on" : "") + '">' + t[1] + "</button>";
        }).join("");
        pop.innerHTML =
          '<div class="profile-pop-head"><b>admin</b><span>Dashboard login</span></div>' +
          '<div class="profile-pop-label">Theme</div>' +
          '<div class="segmented theme-switch" role="radiogroup" aria-label="Theme">' + themes + "</div>" +
          '<div class="profile-pop-links">' +
          '<a role="menuitem" href="' + root + 'team/index.html">Team</a>' +
          '<a role="menuitem" href="' + root + 'settings/index.html">Workspace settings</a>' +
          '<a role="menuitem" href="' + REPO + '">OpenGTM on GitHub</a>' +
          "</div>";
        menu.insertBefore(pop, chip);
        chip.setAttribute("aria-expanded", "true");
        pop.querySelectorAll("[data-theme-pick]").forEach(function (b) {
          b.addEventListener("click", function (e) {
            e.stopPropagation();
            var t = b.getAttribute("data-theme-pick");
            store.set("gtm-demo-theme", t === "system" ? null : t);
            applyTheme(t);
            pop.querySelectorAll("[data-theme-pick]").forEach(function (x) {
              var on = x === b;
              x.classList.toggle("on", on);
              x.setAttribute("aria-checked", String(on));
            });
          });
        });
      }
      chip.addEventListener("click", function (e) { e.stopPropagation(); pop ? close() : open(); });
      document.addEventListener("click", function (e) { if (pop && !pop.contains(e.target)) close(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    });

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setNav(false); });
  }

  // Forms never submit; buttons that would change something only show a notice.
  function approvalsLeft(delta) {
    // Sidebar count and the "Approve all N ready" button follow what is left on the page.
    document.querySelectorAll(".sidebar a, .nav a").forEach(function (a) { if (!/^\s*Approvals/.test(a.textContent)) return; a.querySelectorAll("span").forEach(function (s) {
      if (/^\d+$/.test(s.textContent.trim())) {
        var n = Math.max(0, Number(s.textContent) + delta);
        n ? (s.textContent = String(n)) : s.remove();
      }
    }); });
    document.querySelectorAll(".page-head .actions button").forEach(function (b) {
      var m = b.textContent.match(/Approve all\s*(\d+)/);
      if (m) {
        var n = Math.max(0, Number(m[1]) + delta);
        if (!n) b.closest("form").remove();
        b.childNodes.forEach(function (c) { if (c.nodeType === 3 && /^\d+$/.test(c.nodeValue.trim())) c.nodeValue = String(n); });
      }
    });
  }
  function dismiss(card) {
    card.style.transition = "opacity .2s, transform .2s";
    card.style.opacity = "0";
    card.style.transform = "translateY(-4px)";
    setTimeout(function () {
      var stack = card.parentElement;
      card.remove();
      if (stack && !stack.querySelector("article.card")) {
        var done = document.createElement("div");
        done.className = "card";
        done.style.padding = "28px";
        done.style.textAlign = "center";
        done.innerHTML = "<b>All caught up.</b><div class=\"sub\" style=\"margin-top:4px\">In the real app these would now send in the recipients' business hours.</div>";
        stack.appendChild(done);
      }
    }, 210);
  }

  document.addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var label = ((e.submitter && e.submitter.textContent) || "").trim();
    var card = f.closest("article.card");
    if (/^Approve all/i.test(label)) {
      var cards = document.querySelectorAll("main article.card");
      var emails = document.querySelectorAll("main article.card .step").length || cards.length;
      cards.forEach(dismiss);
      approvalsLeft(-emails);
      toast("Approved " + emails + " emails. Demo: nothing is sent.");
      return;
    }
    if (card && /approve|^reject/i.test(label)) {
      var step = f.closest(".step");
      var steps = card.querySelectorAll(".step");
      if (step && steps.length > 1) {
        step.style.transition = "opacity .2s";
        step.style.opacity = "0";
        setTimeout(function () { step.remove(); }, 210);
        approvalsLeft(-1);
      } else {
        dismiss(card);
        approvalsLeft(-Math.max(1, steps.length));
      }
      toast((/^reject/i.test(label) ? "Rejected." : "Approved.") + " Demo: nothing is sent.");
      return;
    }
    var get = (f.getAttribute("method") || "get").toLowerCase() === "get";
    toast(get ? "Search and filters work in the full app. This demo is a fixed snapshot." : "Demo: nothing is sent or saved.");
  }, true);

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var a = t.closest("a");
    if (a) {
      if (a.hasAttribute("data-demo-missing")) { e.preventDefault(); toast("That page isn't part of the demo."); return; }
      var href = a.getAttribute("href") || "";
      if (/^mailto:|^tel:/i.test(href)) { e.preventDefault(); toast("Demo: nothing is sent."); return; }
      if (/^https?:/i.test(href) && !/github\.com|deanyoung\.me/i.test(href) && new URL(href).origin !== location.origin) {
        e.preventDefault(); toast("Links to the sample companies are made up."); return;
      }
      return;
    }
    var b = t.closest("button");
    if (!b || b.type === "submit") return;
    if (b.closest(".nav-toggle, .mobile-menu, .me-chip, .profile-pop, .demo-badge, summary")) return;
    if (b.matches(".nav-toggle, .mobile-menu, .me-chip")) return;
    e.preventDefault();
    toast("Demo: nothing is sent or saved.");
  }, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
