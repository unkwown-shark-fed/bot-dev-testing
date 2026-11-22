'use strict';

/**
 * Mongo models for the /artcontest command.
 *
 *  ArtContest – one document per "/artcontest post" run (so results can be
 *               listed / closed per contest).
 *  ArtEntry   – one document per forwarded submission, holding the voter
 *               lists for each button. Votes live in MongoDB so they survive
 *               bot restarts (the buttons keep working forever).
 */

const mongoose = require('mongoose');
const db = require('../db');

const contestSchema = new mongoose.Schema({
  contestId:      { type: String, required: true, unique: true },
  guildId:        { type: String, required: true, index: true },
  sourceChannelId:{ type: String, required: true },
  targetChannelId:{ type: String, required: true },
  createdBy:      { type: String, required: true },
  closed:         { type: Boolean, default: false },
  // Roles allowed to vote. Empty = everyone (legacy contests created before this field existed).
  voterRoleIds:   { type: [String], default: [] },
  createdAt:      { type: Date, default: Date.now },
});

const entrySchema = new mongoose.Schema({
  contestId:        { type: String, required: true, index: true },
  guildId:          { type: String, required: true },
  entryNo:          { type: Number, required: true },
  targetChannelId:  { type: String, required: true },
  targetMessageId:  { type: String, default: null },
  sourceMessageId:  { type: String, required: true },
  sourceLink:       { type: String, default: '' },
  authorId:         { type: String, required: true },
  content:          { type: String, default: '' },
  // ref = "attachment://name.png" (re-uploaded) or the original URL (fallback)
  files:            { type: [{ ref: String, description: String }], default: [] },
  upvotes:          { type: [String], default: [] },
  downvotes:        { type: [String], default: [] },
  ai:               { type: [String], default: [] },
  copyright:        { type: [String], default: [] },
  createdAt:        { type: Date, default: Date.now },
});

const ArtContest = mongoose.models.ArtContest || mongoose.model('ArtContest', contestSchema);
const ArtEntry   = mongoose.models.ArtEntry   || mongoose.model('ArtEntry', entrySchema);

async function ready() { await db.connect(); }

module.exports = { ArtContest, ArtEntry, ready };