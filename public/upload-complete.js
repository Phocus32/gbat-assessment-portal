"use strict";

(() => {
  const path = new URLSearchParams(window.location.search).get("path");
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      { type: "material-upload-complete", path },
      window.location.origin
    );
  }
})();
