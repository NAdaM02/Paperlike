// Runs on TUMonline while Paperlike is setting up automatic two-factor codes.
// Finds the new TOTP key (otpauth link, key text, or QR code) and fills the
// confirmation code field when Paperlike sends one. Never submits anything.
(function () {
  if (window.__paperlikeTotpSetup) return;
  window.__paperlikeTotpSetup = true;
  var sent = false;
  function post(secret) {
    if (sent || typeof window.paperlikePost !== "function") return;
    sent = true;
    window.paperlikePost({ type: "totp-secret", secret: secret });
  }
  function shown(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function fromMarkup() {
    var html = (document.documentElement && document.documentElement.innerHTML) || "";
    var m = html.match(/otpauth:\/\/totp\/[^"'<>\s]+/i);
    if (m) return m[0].replace(/&amp;/g, "&");
    var inputs = document.querySelectorAll("input[readonly], input[disabled], textarea[readonly]");
    for (var i = 0; i < inputs.length; i++) {
      var v = (inputs[i].value || "").replace(/[\s-]/g, "");
      if (/^[A-Z2-7]{16,}=*$/.test(v)) return v;
    }
    var lines = ((document.body && document.body.innerText) || "").split(/\n/).filter(function (l) { return l.trim(); });
    for (var j = 0; j < lines.length; j++) {
      var near = (lines[j] + " " + (lines[j - 1] || "") + " " + (lines[j - 2] || "")).toLowerCase();
      if (!/secret|schl(\u00fc|ue)ssel|geheim|key|code/.test(near)) continue;
      var tokens = lines[j].match(/[A-Z2-7]{4}(?:[ -]?[A-Z2-7]{2,})+/g) || [];
      for (var k = 0; k < tokens.length; k++) {
        var t = tokens[k].replace(/[\s-]/g, "");
        if (t.length >= 16 && /[2-7]/.test(t)) return t;
      }
    }
    return null;
  }
  function fromQr() {
    var decode = window.__paperlikeJsQR;
    if (typeof decode !== "function") return null;
    var nodes = document.querySelectorAll("img, canvas, svg");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!shown(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 80 || Math.abs(r.width - r.height) > r.width * 0.2) continue;
      try {
        var w, h, cv = document.createElement("canvas"), ctx;
        if (el.tagName === "CANVAS") {
          w = el.width; h = el.height; cv.width = w; cv.height = h;
          ctx = cv.getContext("2d"); ctx.drawImage(el, 0, 0);
        } else if (el.tagName === "IMG") {
          if (!el.complete || !el.naturalWidth) continue;
          w = el.naturalWidth; h = el.naturalHeight;
          var s = Math.max(1, Math.ceil(300 / Math.min(w, h)));
          w *= s; h *= s; cv.width = w; cv.height = h;
          ctx = cv.getContext("2d"); ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(el, 0, 0, w, h);
        } else {
          continue; // SVG QR codes are handled through their markup below.
        }
        var data = ctx.getImageData(0, 0, w, h);
        var res = decode(data.data, w, h, { inversionAttempts: "attemptBoth" });
        if (res && /^otpauth:\/\/totp\//i.test(res.data)) return res.data;
      } catch (e) {}
    }
    return null;
  }
  function svgQr() {
    // Inline SVG: rasterize it through an image, then decode.
    var svgs = document.querySelectorAll("svg");
    for (var i = 0; i < svgs.length; i++) {
      var el = svgs[i];
      if (!shown(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 80 || Math.abs(r.width - r.height) > r.width * 0.2) continue;
      (function (svg, size) {
        var img = new Image();
        img.onload = function () {
          try {
            var w = Math.max(300, Math.round(size)), cv = document.createElement("canvas");
            cv.width = w; cv.height = w;
            var ctx = cv.getContext("2d");
            ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, w); ctx.drawImage(img, 0, 0, w, w);
            var res = window.__paperlikeJsQR(ctx.getImageData(0, 0, w, w).data, w, w);
            if (res && /^otpauth:\/\/totp\//i.test(res.data)) post(res.data);
          } catch (e) {}
        };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      })(el, r.width);
    }
  }
  var tries = 0;
  function scan() {
    if (sent) return;
    tries++;
    var hit = fromMarkup() || fromQr();
    if (hit) post(hit);
    else if (tries % 3 === 1) svgQr();
  }
  var pending = 0;
  try {
    new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(scan, 400);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  } catch (e) {}
  var timer = setInterval(function () {
    if (sent || tries > 600) clearInterval(timer);
    else scan();
  }, 1500);
  scan();

  function setNative(el, value) {
    var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  window.__paperlikeTotpConfirm = function (code) {
    try {
      var all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])');
      var best = null, fallback = null;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!shown(el) || el.readOnly || el.disabled) continue;
        var key = ((el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
        if (/otp|totp|code|pin|one-time|verif|pr\u00fcf|best\u00e4tig/.test(key)) { best = el; break; }
        var max = parseInt(el.getAttribute("maxlength") || "0", 10);
        if (!fallback && (max === 6 || el.inputMode === "numeric" || el.type === "number" || el.type === "tel")) fallback = el;
      }
      var target = best || fallback;
      if (!target) return false;
      setNative(target, code);
      target.focus();
      return true;
    } catch (e) {
      return false;
    }
  };
})();
