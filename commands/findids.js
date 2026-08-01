const { AttachmentBuilder } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const { createCommandBuilder } = require('../utils/builders');

function splitInputs(input) {
  return String(input || '')
    .split(/[\r\n,]+|\s{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseNameEntry(entry) {
  const idx = entry.lastIndexOf('#');
  if (idx > 0) {
    const name = entry.slice(0, idx).trim();
    const discrim = entry.slice(idx + 1).trim();
    return { raw: entry, name, discrim };
  }
  return { raw: entry, name: entry.trim(), discrim: null };
}

function discrimMatches(inputDiscrim, userDiscrim) {
  if (!inputDiscrim) return true;
  if (inputDiscrim === userDiscrim) return true;
  const a = parseInt(inputDiscrim, 10);
  const b = parseInt(userDiscrim, 10);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a === b) return true;
  return false;
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

async function fetchMembersWithTimeout(guild, query, limit = 1000, ms = 5000) {
  try {
    const p = guild.members.fetch({ query, limit }).catch(() => null);
    const res = await Promise.race([p, timeout(ms)]);
    return res;
  } catch {
    return null;
  }
}

module.exports = {
  data: createCommandBuilder({
    name: 'findids',
    description: 'Find user IDs for a list of usernames (username or username#discriminator)',
    configure: builder => builder.addStringOption(o => o.setName('users').setDescription('Usernames (newline/comma separated)').setRequired(true)),
  }),
  cooldown: 10,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const rawInput = interaction.options.getString('users', true);
    const inputs = splitInputs(rawInput);
    if (inputs.length === 0) {
      return interaction.editReply({ content: 'No valid usernames provided.' });
    }

    const MAX_INPUTS = 200;
    if (inputs.length > MAX_INPUTS) {
      return interaction.editReply({ content: `Too many inputs (${inputs.length}). Provide up to ${MAX_INPUTS}.` });
    }

    const entries = inputs.map(parseNameEntry);
    const client = interaction.client;

    const byName = new Map();
    for (const e of entries) {
      if (!byName.has(e.name)) byName.set(e.name, new Set());
    }
    for (const u of client.users.cache.values()) {
      if (!u || !u.username) continue;
      const set = byName.get(u.username);
      if (set) set.add(u);
    }

    const resultsMap = new Map();
    for (const e of entries) {
      resultsMap.set(e.raw, { entry: e, matches: new Map(), queriedGuilds: [] });
      const cacheMatches = byName.get(e.name);
      if (cacheMatches && cacheMatches.size > 0) {
        for (const u of cacheMatches) {
          if (discrimMatches(e.discrim, u.discriminator)) {
            resultsMap.get(e.raw).matches.set(String(u.id), { tag: u.tag, guildNames: new Set() });
          }
        }
      }
    }

    const needSearchNames = new Set();
    for (const [raw, info] of resultsMap.entries()) {
      if (info.matches.size === 0) needSearchNames.add(info.entry.name);
    }

    const guilds = Array.from(client.guilds.cache.values());
    if (guilds.length === 0) {
      const results = [];
      for (const [raw, info] of resultsMap.entries()) {
        const entry = info.entry;
        const matchesArr = Array.from(info.matches.entries());
        const foundCount = matchesArr.length;
        const userIdsPlain = matchesArr.map(([id]) => String(id)).join(' ');
        const userIdsExcel = userIdsPlain ? `="${userIdsPlain.replace(/"/g, '""')}"` : '';
        const tags = matchesArr.map(([, v]) => v.tag).join(' | ');
        results.push({
          input: raw,
          username: entry.name,
          discriminator: entry.discrim || '',
          foundCount,
          userIds: userIdsExcel,
          tags,
          foundGuilds: '',
          guildsQueried: '',
          notes: foundCount === 0 ? 'not_found;no_guilds_cached' : 'found_in_cache'
        });
      }
      const csv = stringify(results, { header: true });
      const buffer = Buffer.from(csv, 'utf8');
      const filename = `findids-cacheonly-${Date.now()}.csv`;
      const attachment = new AttachmentBuilder(buffer, { name: filename });
      return interaction.editReply({ content: `Bot guild cache empty — returned cache-only results.`, files: [attachment] });
    }

    for (const guild of guilds) {
      await interaction.editReply({ content: `Searching guilds... remaining names: ${needSearchNames.size}` }).catch(() => null);
      const guildNameSafe = guild.name || '<unknown>';
      for (const name of Array.from(needSearchNames)) {
        await new Promise(r => setTimeout(r, 60));
        let members;
        try {
          members = await fetchMembersWithTimeout(guild, name, 1000, 5000);
        } catch {
          members = null;
        }
        const membersFound = members ? members.size : 0;
        for (const [raw, info] of resultsMap.entries()) {
          if (info.entry.name === name) info.queriedGuilds.push({ guildName: guildNameSafe, membersFound });
        }
        if (!members || members.size === 0) continue;
        for (const m of members.values()) {
          const user = m.user;
          if (!user) continue;
          for (const [raw, info] of resultsMap.entries()) {
            if (info.entry.name !== name) continue;
            if (discrimMatches(info.entry.discrim, user.discriminator)) {
              const id = String(user.id);
              const existing = info.matches.get(id);
              if (!existing) info.matches.set(id, { tag: user.tag, guildNames: new Set([guildNameSafe]) });
              else existing.guildNames.add(guildNameSafe);
            }
          }
        }
      }
      for (const [raw, info] of resultsMap.entries()) {
        if (info.matches.size > 0 && needSearchNames.has(info.entry.name)) {
          needSearchNames.delete(info.entry.name);
        }
      }
      if (needSearchNames.size === 0) break;
    }

    const results = [];
    for (const [raw, info] of resultsMap.entries()) {
      const entry = info.entry;
      const matchesArr = Array.from(info.matches.entries());
      const foundCount = matchesArr.length;
      const userIdsPlain = matchesArr.map(([id]) => String(id)).join(' ');
      const userIdsExcel = userIdsPlain ? `="${userIdsPlain.replace(/"/g, '""')}"` : '';
      const tags = matchesArr.map(([, v]) => v.tag).join(' | ');
      const foundGuilds = matchesArr
        .map(([, v]) => Array.from(v.guildNames).join(';'))
        .filter(Boolean)
        .join(' | ');
      const guildsQueriedStr = info.queriedGuilds.map(g => `${g.guildName}(${g.membersFound})`).join(' ');
      const notes = foundCount === 0 ? `not_found;queried=${guildsQueriedStr}` : `found`;

      results.push({
        input: raw,
        username: entry.name,
        discriminator: entry.discrim || '',
        foundCount,
        userIds: userIdsExcel,
        tags,
        foundGuilds,
        guildsQueried: guildsQueriedStr,
        notes
      });
    }

    const columns = ['input', 'username', 'discriminator', 'foundCount', 'userIds', 'tags', 'foundGuilds', 'guildsQueried', 'notes'];
    const csv = stringify(results, { header: true, columns });
    const buffer = Buffer.from(csv, 'utf8');
    const filename = `findids-${Date.now()}.csv`;
    const attachment = new AttachmentBuilder(buffer, { name: filename });

    const summary = `Processed ${results.length} inputs. Results CSV attached.`;

    // Try to send via DM first
    try {
      await interaction.user.send({
        content: summary,
        files: [attachment]
      });
      await interaction.editReply(`✅ ${summary}\n\nSent to your DMs!`);
    } catch (dmErr) {
      // DM failed, attach to reply in channel
      await interaction.editReply({
        content: `✅ ${summary}\n\n⚠️ Couldn't send DM (disabled?). File attached below:`,
        files: [attachment]
      });
    }
  }
};
