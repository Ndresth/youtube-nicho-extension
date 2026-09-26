// Constructor de DOM sin innerHTML (YouTube exige Trusted Types y así los
// títulos de los videos nunca se interpretan como HTML).
(function (root) {
  'use strict';
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, val] of Object.entries(attrs || {})) {
      if (val == null || val === false) continue;
      if (k === 'class') e.className = val;
      else if (k === 'text') e.textContent = val;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), val);
      else if (k in e && typeof val !== 'string') e[k] = val;
      else e.setAttribute(k, val === true ? '' : val);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  root.YTN_DOM = { h };
})(globalThis);
