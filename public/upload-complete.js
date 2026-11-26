"use strict";

(() => {
  const params = new URLSearchParams(window.location.search);
  const path = params.get("path");
  const uploadId = params.get("uploadId");
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      { type: "material-upload-complete", path, uploadId },
      window.location.origin
    );
  }
})();
