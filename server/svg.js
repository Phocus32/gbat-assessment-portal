"use strict";

const ALLOWED_TAGS = new Set([
  "svg", "g", "polygon", "polyline", "line", "rect", "circle", "ellipse",
  "path", "text", "tspan", "title", "desc"
]);

const ALLOWED_ATTRS = new Set([
  "xmlns", "width", "height", "viewBox", "points", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "fill", "stroke", "stroke-width",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-size",
  "font-family", "font-weight", "text-anchor", "transform", "opacity",
  "fill-rule", "clip-rule", "aria-hidden", "role"
]);

const MAX_SVG_LENGTH = 12000;

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function isUnsafeValue(value) {
  const lower = value.toLowerCase();
  return (
    lower.includes("javascript:") ||
    lower.includes("data:") ||
    lower.includes("url(") ||
    lower.includes("expression(") ||
    lower.includes("&#") ||
    lower.includes("<") ||
    lower.includes(">")
  );
}

function sanitizeSvg(input) {
  if (typeof input !== "string") return null;
  const source = input.trim();
  if (!source || source.length > MAX_SVG_LENGTH) return null;

  if (/<script|<style|<!|<\?|foreignObject|xlink:href|href\s*=|on[a-z]+\s*=/i.test(source)) {
    return null;
  }

  let output = "";
  let index = 0;
  let sawRoot = false;
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
  let match;

  while ((match = tagPattern.exec(source)) !== null) {
    const [full, closing, rawTag, rawAttrs] = match;

    if (match.index > index) {
      const text = source.slice(index, match.index);
      if (text.trim()) output += escapeText(text);
    }
    index = match.index + full.length;

    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return null;
    if (tag === "svg") sawRoot = true;

    if (closing) {
      output += `</${tag}>`;
      continue;
    }

    let attrs = "";
    const attrPattern = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attrMatch;
    let consumed = 0;

    while ((attrMatch = attrPattern.exec(rawAttrs)) !== null) {
      const name = attrMatch[1];
      const value = attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4];
      consumed += attrMatch[0].length;

      if (!ALLOWED_ATTRS.has(name)) return null;
      if (isUnsafeValue(value)) return null;
      attrs += ` ${name}="${escapeAttr(value)}"`;
    }

    const leftover = rawAttrs.replace(attrPattern, "").trim();
    if (leftover && leftover !== "/") return null;
    if (consumed === 0 && rawAttrs.trim() && rawAttrs.trim() !== "/") return null;

    const selfClosing = rawAttrs.trim().endsWith("/");
    output += selfClosing ? `<${tag}${attrs}/>` : `<${tag}${attrs}>`;
  }

  if (!sawRoot) return null;
  if (index < source.length) {
    const text = source.slice(index);
    if (text.trim()) output += escapeText(text);
  }

  return output;
}

module.exports = { sanitizeSvg };
