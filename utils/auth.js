/**
 * Shared authorization helper for commands restricted to the bot owner
 * (optionally also allowing server admins / a configured role).
 *
 * Centralizing this means commands can't silently drift out of sync with
 * each other the way dms.js (owner-only) and status.js (owner-or-admin-or-role)
 * previously did, despite both hand-rolling nearly identical checks.
 */

const { PermissionFlagsBits } = require('discord.js');

/**
 * @param {import('discord.js').CommandInteraction} interaction
 * @param {object} [options]
 * @param {boolean} [options.ownerOnly=false] - If true, ONLY the bot owner
 *   (BOT_OWNER_ID) passes, regardless of admin permission or configured role.
 * @returns {boolean}
 */
function isAuthorized(interaction, { ownerOnly = false } = {}) {
  const ownerId = process.env.BOT_OWNER_ID || '';
  const isOwner = Boolean(ownerId) && interaction.user.id === ownerId;

  if (ownerOnly) return isOwner;

  const requiredRole = interaction.client.config?.commandRoleId || process.env.COMMAND_ROLE_ID || '';
  const isAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) || false;
  const hasRole = requiredRole ? Boolean(interaction.member?.roles?.cache?.has(requiredRole)) : false;

  return isOwner || isAdmin || hasRole;
}

module.exports = {
  isAuthorized,
};
