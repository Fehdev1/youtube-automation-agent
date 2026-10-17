'use strict';

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
};

// Escape a value before placing it inside an HTML text node or a quoted attribute.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character]);
}

module.exports = { escapeHtml };
