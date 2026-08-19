/**
 * Shared helpers for building Discord Components V2 payloads.
 *
 * discord.js doesn't yet ship builders for every Components V2 type, so
 * these commands construct the raw component objects by hand. This was
 * previously copy-pasted across generate.js, generate_v2.js, and status.js —
 * centralizing it here means new commands don't have to redefine the same
 * type IDs, and any future discord.js builder support can be swapped in in
 * one place.
 *
 * Usage:
 *   const { Container, textDisplay, separator } = require('../utils/componentsV2');
 *   const container = { type: Container, components: [ textDisplay('# Hi'), separator() ] };
 */

// Components V2 type IDs (see Discord's message components documentation).
const ComponentType = {
  Container: 17,
  TextDisplay: 10,
  Separator: 14,
};

/**
 * Build a Text Display component.
 * @param {string} content - Markdown-supporting text content.
 */
function textDisplay(content) {
  return { type: ComponentType.TextDisplay, content };
}

/**
 * Build a Separator component.
 * @param {number} spacing - 1 (small) or 2 (large).
 */
function separator(spacing = 1) {
  return { type: ComponentType.Separator, divider: true, spacing };
}

/**
 * Build a Container component wrapping a list of child components.
 * @param {Array<object>} components
 */
function container(components) {
  return { type: ComponentType.Container, components };
}

module.exports = {
  ComponentType,
  textDisplay,
  separator,
  container,
};
